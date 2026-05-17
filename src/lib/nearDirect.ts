/**
 * Direct NEAR RPC submission using session keys.
 *
 * Builds and signs NEAR transactions locally (borsh-serialized TransactionV0)
 * and submits them directly to the NEAR RPC endpoint — no relay required.
 *
 * The session key is an ed25519 CryptoKey (non-extractable) stored in IndexedDB.
 */

import { NEAR_RPC } from './constants.js';
import type { StoredSessionKey } from './types.js';
import { borshString, borshU32, borshU64, borshU128 } from './borsh.js';
import { base58Decode, concat, uint8ToBase64 } from './utils.js';

// ─── NEAR RPC helpers ───────────────────────────────────

async function nearRpcCall(body: object): Promise<any> {
  const res = await fetch(NEAR_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (data.error) throw new Error(`NEAR RPC error: ${JSON.stringify(data.error)}`);
  return data.result;
}

/** Get the current final block hash (32 bytes) */
async function getBlockHash(): Promise<Uint8Array> {
  const result = await nearRpcCall({
    jsonrpc: '2.0',
    id: 'blockhash',
    method: 'block',
    params: { finality: 'final' },
  });
  const hashB58 = result.header.hash;
  return base58Decode(hashB58);
}

/** Get access key info (nonce + permissions) for a public key on an account */
export async function getAccessKey(
  walletId: string,
  publicKeyB58: string,
): Promise<{ nonce: number; permission: any }> {
  const result = await nearRpcCall({
    jsonrpc: '2.0',
    id: 'accesskey',
    method: 'query',
    params: {
      request_type: 'view_access_key',
      finality: 'final',
      account_id: walletId,
      public_key: publicKeyB58.startsWith('ed25519:') ? publicKeyB58 : `ed25519:${publicKeyB58}`,
    },
  });
  return {
    nonce: result.nonce,
    permission: result.permission,
  };
}

// ─── Borsh serialization for NEAR Transaction V0 ────────

/**
 * Borsh-serialize an ed25519 public key.
 * Format: enum tag 0 (ed25519) + 32 bytes
 */
function borshPublicKeyEd25519(pubKeyBytes: Uint8Array): Uint8Array {
  return concat(new Uint8Array([0]), pubKeyBytes); // tag 0 = ed25519
}

/**
 * Borsh-serialize a FunctionCall action.
 * Action enum tag: 2
 */
function borshFunctionCallAction(
  methodName: string,
  args: Uint8Array,
  gas: bigint,
  deposit: bigint,
): Uint8Array {
  return concat(
    new Uint8Array([2]), // Action::FunctionCall tag
    borshString(methodName),
    borshU32(args.length), // args len as u32 (borsh vec prefix)
    args,
    borshU64(gas),
    borshU128(deposit),
  );
}

// borshTransferAction is available for future use but not currently called
// Keeping it documented for reference:
// Action enum tag: 3, format: tag(1) + deposit(u128)

/** Exported for potential future use — borsh-serialize a Transfer action (tag 3) */
export function borshTransferAction(deposit: bigint): Uint8Array {
  return concat(
    new Uint8Array([3]), // Action::Transfer tag
    borshU128(deposit),
  );
}

/**
 * Build a borsh-serialized NEAR TransactionV0.
 * No prefix byte — just the raw transaction struct.
 */
function borshTransaction(params: {
  signerId: string;
  signerPublicKeyBytes: Uint8Array;
  nonce: bigint;
  receiverId: string;
  blockHash: Uint8Array;
  actions: Uint8Array[];
}): Uint8Array {
  return concat(
    borshString(params.signerId),
    borshPublicKeyEd25519(params.signerPublicKeyBytes),
    borshU64(params.nonce),
    borshString(params.receiverId),
    params.blockHash, // 32 bytes raw
    borshU32(params.actions.length), // vec length
    ...params.actions,
  );
}

// ─── Direct submission ──────────────────────────────────

/**
 * Submit a function call to a NEAR contract using a session key.
 *
 * Builds a borsh-serialized TransactionV0, signs with ed25519 session key,
 * and broadcasts directly to NEAR RPC via `broadcast_tx_commit`.
 */
export async function directFunctionCall(params: {
  walletId: string;
  sessionKey: StoredSessionKey;
  contractId: string;
  methodName: string;
  args: Record<string, any>;
  gas?: bigint;
  deposit?: bigint;
}): Promise<{ tx_hash: string; status: string; return_value?: any }> {
  const {
    walletId,
    sessionKey,
    contractId,
    methodName,
    args,
    gas = 300_000_000_000_000n,
    deposit = 0n,
  } = params;

  // 1. Get public key in base58 form for RPC query
  const pubKeyB58 = sessionKey.publicKey; // already "ed25519:..." format
  const pubKeyBytes = base58Decode(pubKeyB58.replace('ed25519:', ''));

  // 2. Query access key nonce + block hash in parallel
  const [accessKey, blockHash] = await Promise.all([
    getAccessKey(walletId, pubKeyB58),
    getBlockHash(),
  ]);

  // Nonce must be incremented by 1 from current
  const nonce = BigInt(accessKey.nonce) + 1n;

  // 3. Serialize function call args to bytes
  const argsBytes = new TextEncoder().encode(JSON.stringify(args));

  // 4. Build the action
  const actionBytes = borshFunctionCallAction(methodName, argsBytes, gas, deposit);

  // 5. Build borsh-serialized transaction
  const txBytes = borshTransaction({
    signerId: walletId,
    signerPublicKeyBytes: pubKeyBytes,
    nonce,
    receiverId: contractId,
    blockHash,
    actions: [actionBytes],
  });

  // 6. SHA256 hash the tx bytes
  const txHash = await crypto.subtle.digest('SHA-256', txBytes.buffer as ArrayBuffer);
  const txHashBytes = new Uint8Array(txHash);

  // 7. Sign with session key (ed25519)
  const signatureBuffer = await crypto.subtle.sign(
    { name: 'Ed25519' },
    sessionKey.privateKey,
    txHashBytes.buffer as ArrayBuffer,
  );
  const signature = new Uint8Array(signatureBuffer);

  // 8. Build signed transaction: txBytes + [0] (V0) + signature (64 bytes)
  const signedTx = concat(txBytes, new Uint8Array([0]), signature);

  // 9. Base64 encode
  const signedTxB64 = uint8ToBase64(signedTx);

  // 10. Broadcast via broadcast_tx_commit
  const result = await nearRpcCall({
    jsonrpc: '2.0',
    id: 'broadcast',
    method: 'broadcast_tx_commit',
    params: [signedTxB64],
  });

  // Extract return value if present
  let returnValue: any = undefined;
  try {
    const status = result.status;
    if (status?.SuccessValue) {
      const decoded = atob(status.SuccessValue);
      try {
        returnValue = JSON.parse(decoded);
      } catch {
        returnValue = decoded;
      }
    }
  } catch {}

  return {
    tx_hash: result.transaction?.hash || 'unknown',
    status: result.status?.SuccessValue !== undefined ? 'Success' : (result.status ? 'Failure' : 'unknown'),
    return_value: returnValue,
  };
}

/**
 * Convenience: submit a w_execute_session call directly.
 * This is the main entry point for session-key-based operations.
 */
export async function directExecuteSession(params: {
  walletId: string;
  sessionKey: StoredSessionKey;
  requestMsg: Record<string, any>;
  gas?: bigint;
}): Promise<{ tx_hash: string; status: string; return_value?: any }> {
  return directFunctionCall({
    walletId: params.walletId,
    sessionKey: params.sessionKey,
    contractId: params.walletId, // wallet contract call on self
    methodName: 'w_execute_session',
    args: params.requestMsg,
    gas: params.gas || 300_000_000_000_000n,
    deposit: 0n,
  });
}
