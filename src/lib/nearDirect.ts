/**
 * Direct NEAR RPC submission using session keys via near-kit.
 *
 * Architecture:
 * - Session key is a non-extractable ed25519 CryptoKey stored in IndexedDB
 * - near-kit handles: transaction building, borsh serialization, nonce management, RPC calls
 * - Custom Signer function bridges IndexedDB CryptoKey → near-kit's signing interface
 * - Custom KeyPair in InMemoryKeyStore provides the public key for nonce lookup
 */

import { Near, InMemoryKeyStore } from 'near-kit';
import type { KeyPair, PublicKey, Signature } from 'near-kit';

import { CHAIN_ID } from './constants.js';
import { borshRequestMessageWithSessionActions } from './borsh.js';
import { loadSessionKey } from './session.js';
import { base58Encode, base58Decode } from './utils.js';

// ─── Constants ──────────────────────────────────────

const KEY_TYPE_ED25519 = 0;

// ─── Custom KeyPair for nonce lookup ────────────────

/**
 * Create a fake KeyPair that provides the public key for nonce management.
 * The actual signing is handled by the custom Signer function passed to near-kit.
 */
function createSessionKeyPair(publicKeyBytes: Uint8Array): KeyPair {
  const pubKeyStr = 'ed25519:' + base58Encode(publicKeyBytes);

  const pubKey: PublicKey = {
    keyType: KEY_TYPE_ED25519,
    data: publicKeyBytes,
    toString: () => pubKeyStr,
  };

  return {
    publicKey: pubKey,
    secretKey: '', // non-extractable — signing handled by Signer function
    sign: (_message: Uint8Array): Signature => {
      // This should never be called — the Signer function takes priority
      throw new Error('Signing handled by Signer function, not KeyPair');
    },
  };
}

// ─── CryptoKey signer ───────────────────────────────

async function signWithCryptoKey(
  privateKey: CryptoKey,
  messageHash: Uint8Array,
): Promise<Signature> {
  const sigBuf = await crypto.subtle.sign(
    'Ed25519',
    privateKey,
    new Uint8Array(messageHash) as any,
  );
  return {
    keyType: KEY_TYPE_ED25519,
    data: new Uint8Array(sigBuf),
  };
}

// ─── Helper: create Near client with session key ────

async function createSessionNear(
  accountId: string,
  publicKeyBytes: Uint8Array,
  privateKey: CryptoKey,
): Promise<Near> {
  const keyPair = createSessionKeyPair(publicKeyBytes);

  const keyStore = new InMemoryKeyStore();
  await keyStore.add(accountId, keyPair);

  const signerFn = async (message: Uint8Array): Promise<Signature> => {
    return signWithCryptoKey(privateKey, message);
  };

  return new Near({
    network: 'testnet' as any,
    keyStore,
    signer: signerFn as any,
    defaultSignerId: accountId,
  });
}

// ─── Execute via session key (w_execute_session) ─────

export interface ExecuteSessionParams {
  walletId: string;
  sessionKeyId: string;
  actions: Array<{
    action: string;
    function_name?: string;
    args?: string;
    deposit?: string;
    amount?: string;
    min_gas?: string;
    gas_weight?: string;
    receiver_id?: string;
  }>;
}

export async function directExecuteSession(
  params: ExecuteSessionParams,
): Promise<{ tx_hash: string }> {
  const { walletId, sessionKeyId, actions } = params;

  // Load session key from IndexedDB
  const stored = await loadSessionKey(sessionKeyId, walletId);
  if (!stored || !stored.privateKey || stored.needsMigration) {
    throw new Error(`Session key "${sessionKeyId}" not found or needs migration`);
  }

  const pubKeyBytes = base58Decode(stored.publicKey.replace('ed25519:', ''));
  const near = await createSessionNear(walletId, pubKeyBytes, stored.privateKey);

  // 1. Build inner RequestMessage (contract borsh format) and sign with session key
  const nonce = Math.floor(Math.random() * 0xFFFFFFFF);
  const createdAtTs = Math.floor(Date.now() / 1000);
  const createdAtRfc3339 = new Date().toISOString();

  // Build the "then" promises from actions — each action needs a receiver_id
  // For w_execute_session, actions go inside the inner msg's PromiseDAG
  const thenPromises = actions.map(act => ({
    receiver_id: act.receiver_id || walletId,
    actions: [act],
  }));

  const borshMsg = borshRequestMessageWithSessionActions({
    chain_id: CHAIN_ID,
    signer_id: walletId,
    nonce,
    created_at: createdAtTs,
    timeout: 600,
    then: thenPromises,
  });

  // SHA256(borsh(msg)) → sign with session key → inner signature
  const msgHash = await crypto.subtle.digest('SHA-256', borshMsg as any);
  const innerSig = await crypto.subtle.sign('Ed25519', stored.privateKey, new Uint8Array(msgHash) as any);
  const innerSigB58 = base58Encode(new Uint8Array(innerSig));

  // 2. Build JSON args for w_execute_session
  const argsJson = JSON.stringify({
    msg: {
      signer_id: walletId,
      nonce,
      created_at: createdAtRfc3339,
      timeout_secs: 600,
      actions,
    },
    session_key_id: sessionKeyId,
    signature: innerSigB58,
  });

  // 3. Build and send outer NEAR tx via near-kit
  // args are already JSON-serialized — encode to bytes since near-kit's functionCall
  // expects object (auto-serializes) or Uint8Array (raw)
  const argsBytes = new TextEncoder().encode(argsJson);
  const result = await near.transaction(walletId)
    .functionCall(
      walletId,
      'w_execute_session',
      argsBytes,
      { gas: '300 Tgas' as any, attachedDeposit: '0 yocto' as any },
    )
    .send();

  const txHash = (result as any).transaction?.hash || 'unknown';
  return { tx_hash: txHash };
}

// ─── Simple function call via session key ─────────────

export interface FunctionCallParams {
  walletId: string;
  sessionKeyId: string;
  contractId: string;
  methodName: string;
  args: Record<string, unknown>;
  gas?: bigint;
  deposit?: bigint;
}

export async function directFunctionCall(
  params: FunctionCallParams,
): Promise<{ tx_hash: string }> {
  const { walletId, sessionKeyId, contractId, methodName, args } = params;

  const stored = await loadSessionKey(sessionKeyId, walletId);
  if (!stored || !stored.privateKey || stored.needsMigration) {
    throw new Error(`Session key "${sessionKeyId}" not found or needs migration`);
  }

  const pubKeyBytes = base58Decode(stored.publicKey.replace('ed25519:', ''));
  const near = await createSessionNear(walletId, pubKeyBytes, stored.privateKey);

  const result = await near.transaction(walletId)
    .functionCall(
      contractId,
      methodName,
      args,
      { gas: '30 Tgas' as any, attachedDeposit: '0 yocto' as any },
    )
    .send();

  const txHash = (result as any).transaction?.hash || 'unknown';
  return { tx_hash: txHash };
}

// ─── Access key lookup ────────────────────────────────

export async function getAccessKey(
  accountId: string,
  publicKey: string,
): Promise<{ nonce: number } | null> {
  const keyStore = new InMemoryKeyStore();
  const near = new Near({
    network: 'testnet' as any,
    keyStore,
  });

  try {
    const key = await near.getAccessKey(accountId, publicKey);
    if (!key) return null;
    return { nonce: key.nonce };
  } catch {
    return null;
  }
}
