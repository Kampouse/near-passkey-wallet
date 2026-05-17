import { sha256 } from '@noble/hashes/sha2.js';
import { WALLET_DOMAIN, CHAIN_ID, MPC_CONTRACT } from './constants.js';
import type { WalletOp } from './types.js';
import { base58Encode, uint8ToBase64url, concat } from './utils.js';

// ─── Borsh primitives ───────────────────────────────────

export function borshU32(n: number): Uint8Array {
  const buf = new Uint8Array(4);
  new DataView(buf.buffer).setUint32(0, n, true);
  return buf;
}

export function borshString(s: string): Uint8Array {
  const encoded = new TextEncoder().encode(s);
  return new Uint8Array([...borshU32(encoded.length), ...encoded]);
}

export function borshU64(n: bigint | number): Uint8Array {
  const buf = new Uint8Array(8);
  new DataView(buf.buffer).setBigUint64(0, BigInt(n), true);
  return buf;
}

export function borshU128(n: bigint | number): Uint8Array {
  const lo = BigInt(n) & ((1n << 64n) - 1n);
  const hi = BigInt(n) >> 64n;
  const buf = new Uint8Array(16);
  new DataView(buf.buffer).setBigUint64(0, lo, true);
  new DataView(buf.buffer).setBigUint64(8, BigInt(hi), true);
  return buf;
}

/**
 * Borsh-serialize a RequestMessage for the wallet contract.
 *
 * struct RequestMessage {
 *   chain_id: String,        // "mainnet"
 *   signer_id: AccountId,    // "pwallet1.testnet"
 *   nonce: u32,
 *   created_at: u32,         // TimestampSeconds<u32>
 *   timeout: u32,            // DurationSeconds<u32>
 *   request: Request {
 *     ops: Vec<WalletOp>,    // empty for simple operations
 *     out: PromiseDAG,       // Vec<PromiseSingle> — empty
 *   }
 * }
 */
export function borshRequestMessage(msg: {
  chain_id: string;
  signer_id: string;
  nonce: number;
  created_at: number;
  timeout: number;
}): Uint8Array {
  return concat(
    borshString(msg.chain_id),
    borshString(msg.signer_id),
    borshU32(msg.nonce),
    borshU32(msg.created_at),
    borshU32(msg.timeout),
    borshU32(0), // 0 ops
    // PromiseDAG.after (empty vec)
    borshU32(0),
    // PromiseDAG.then (empty vec)
    borshU32(0),
  );
}

/**
 * Borsh-serialize a RequestMessage with DAG actions for session key signing.
 * Matches contract's borsh schema: chain_id, signer_id, nonce, created_at, timeout,
 * ops (empty vec), PromiseDAG { after: [], then: [PromiseSingle...] }
 */
export function borshRequestMessageWithSessionActions(msg: {
  chain_id: string;
  signer_id: string;
  nonce: number;
  created_at: number;
  timeout: number;
  then: Array<{
    receiver_id: string;
    actions: Array<{
      action: string;
      function_name?: string;
      args?: string;
      deposit?: string;
      min_gas?: string;
      gas_weight?: string;
    }>;
  }>;
}): Uint8Array {
  const thenParts: Uint8Array[] = [];
  for (const promise of msg.then) {
    // PromiseSingle.receiver_id
    thenParts.push(borshString(promise.receiver_id));
    // PromiseSingle.refund_to: None
    thenParts.push(new Uint8Array([0]));
    // PromiseSingle.actions (vec)
    thenParts.push(borshU32(promise.actions.length));
    for (const act of promise.actions) {
      if (act.action === 'function_call') {
        // PromiseAction::FunctionCall = discriminant 2
        thenParts.push(new Uint8Array([2]));
        thenParts.push(borshString(act.function_name || ''));
        const argsBytes = act.args ? Uint8Array.from(atob(act.args), c => c.charCodeAt(0)) : new Uint8Array(0);
        thenParts.push(borshU32(argsBytes.length));
        thenParts.push(argsBytes);
        thenParts.push(borshU128(BigInt(act.deposit || '0')));
        thenParts.push(borshU64(BigInt(act.min_gas || '30000000000000')));
        thenParts.push(borshU64(BigInt(act.gas_weight || '0')));
      } else if (act.action === 'transfer') {
        // PromiseAction::Transfer = discriminant 0
        thenParts.push(new Uint8Array([0]));
        thenParts.push(borshU128(BigInt(act.deposit || '0')));
      }
    }
  }

  return concat(
    borshString(msg.chain_id),
    borshString(msg.signer_id),
    borshU32(msg.nonce),
    borshU32(msg.created_at),
    borshU32(msg.timeout),
    borshU32(0), // 0 ops
    // PromiseDAG.after: empty vec
    borshU32(0),
    // PromiseDAG.then
    borshU32(msg.then.length),
    ...thenParts,
  );
}

/**
 * Build the borsh-serialized RequestMessage with PromiseDAG.
 * This is needed for the challenge hash computation.
 */
export function borshRequestMessageWithDAG(msg: {
  signer_id: string;
  nonce: number;
  created_at_ts: number;
  signArgsJson: string;
}): Uint8Array {
  const signArgsBytes = new TextEncoder().encode(msg.signArgsJson);
  return concat(
    borshString(CHAIN_ID),
    borshString(msg.signer_id),
    borshU32(msg.nonce),
    borshU32(msg.created_at_ts),
    borshU32(600), // timeout
    borshU32(0), // 0 ops
    // PromiseDAG.after
    borshU32(0),
    // PromiseDAG.then
    borshU32(1),
    // PromiseSingle.receiver_id
    borshString(MPC_CONTRACT),
    // PromiseSingle.refund_to: None
    new Uint8Array([0]),
    // PromiseSingle.actions
    borshU32(1),
    // PromiseAction::FunctionCall = variant 2
    new Uint8Array([2]),
    borshString('sign'),
    borshU32(signArgsBytes.length),
    signArgsBytes,
    // deposit: NearToken (u128)
    borshU128(1n),
    // gas: Gas (u64)
    borshU64(200_000_000_000_000n),
    // gas_weight: u64
    borshU64(0n),
  );
}

/**
 * Borsh-serialize a RequestMessage with ops (for CreateSession/RevokeSession/RevokeAllSessions/SetBackupKey/RemoveBackupKey).
 * The ops are serialized as borsh WalletOp variants.
 *
 * WalletOp::CreateSession { session_key_id, public_key, ttl_secs } = discriminant 3
 * WalletOp::RevokeSession { session_key_id } = discriminant 4
 * WalletOp::RevokeAllSessions = discriminant 5
 * WalletOp::SetBackupKey { public_key } = discriminant 6
 * WalletOp::RemoveBackupKey = discriminant 7
 */
export function borshRequestMessageWithOps(msg: {
  chain_id: string;
  signer_id: string;
  nonce: number;
  created_at: number;
  timeout: number;
  ops: WalletOp[];
}): Uint8Array {
  const opsParts: Uint8Array[] = [];

  for (const op of msg.ops) {
    if (op.type === 'CreateSession') {
      // Discriminant 3
      opsParts.push(new Uint8Array([3]));
      opsParts.push(borshString(op.session_key_id));
      opsParts.push(borshString(op.public_key));
      opsParts.push(borshU32(op.ttl_secs));
    } else if (op.type === 'RevokeSession') {
      // Discriminant 4
      opsParts.push(new Uint8Array([4]));
      opsParts.push(borshString(op.session_key_id));
    } else if (op.type === 'RevokeAllSessions') {
      // Discriminant 5
      opsParts.push(new Uint8Array([5]));
    } else if (op.type === 'SetBackupKey') {
      // Discriminant 6
      opsParts.push(new Uint8Array([6]));
      opsParts.push(borshString(op.public_key));
    } else if (op.type === 'RemoveBackupKey') {
      // Discriminant 7
      opsParts.push(new Uint8Array([7]));
    }
  }

  return concat(
    borshString(msg.chain_id),
    borshString(msg.signer_id),
    borshU32(msg.nonce),
    borshU32(msg.created_at),
    borshU32(msg.timeout),
    borshU32(msg.ops.length),
    ...opsParts,
    // PromiseDAG: empty after + empty then
    borshU32(0),
    borshU32(0),
  );
}

/**
 * Compute the challenge hash that the passkey must sign.
 * Pipeline: borsh(msg) → prepend WALLET_DOMAIN → SHA256
 */
export function computeChallenge(borshBytes: Uint8Array): Uint8Array {
  const domainBytes = new TextEncoder().encode(WALLET_DOMAIN);
  const prefixed = new Uint8Array([...domainBytes, ...borshBytes]);
  return sha256(prefixed);
}

/**
 * Convert a DER-encoded P-256 signature to raw r||s (64 bytes).
 * WebAuthn produces DER: 30 <len> 02 <rlen> <r> 02 <slen> <s>
 * Contract expects raw: r (32 bytes) || s (32 bytes)
 */
export function derToRawP256(der: Uint8Array): Uint8Array {
  // Skip SEQUENCE tag (0x30) and length
  let offset = 2;

  // Parse r: skip INTEGER tag (0x02), read length, read value
  if (der[offset] !== 0x02) throw new Error('Expected INTEGER tag for r');
  offset++;
  const rLen = der[offset++];
  const r = der.slice(offset, offset + rLen);
  offset += rLen;

  // Parse s: skip INTEGER tag (0x02), read length, read value
  if (der[offset] !== 0x02) throw new Error('Expected INTEGER tag for s');
  offset++;
  const sLen = der[offset++];
  const s = der.slice(offset, offset + sLen);

  // Strip leading 0x00 padding (added when high bit is set)
  const rStrip = (r[0] === 0x00 && r.length === 33) ? r.slice(1) : r;
  let sStrip = (s[0] === 0x00 && s.length === 33) ? s.slice(1) : s;

  if (rStrip.length !== 32 || sStrip.length !== 32) {
    throw new Error(`Unexpected r/s lengths: ${rStrip.length}, ${sStrip.length}`);
  }

  // Normalize s to low-S form (contract rejects high-s for malleability protection)
  // P-256 (secp256r1) curve order: FFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551
  const P256_ORDER = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551n;
  const sInt = BigInt('0x' + Array.from(sStrip).map(b => b.toString(16).padStart(2, '0')).join(''));
  if (sInt > P256_ORDER / 2n) {
    // Replace s with n - s (low-S normalization)
    const sNorm = P256_ORDER - sInt;
    const sNormHex = sNorm.toString(16).padStart(64, '0');
    sStrip = new Uint8Array(sNormHex.match(/.{2}/g)!.map((hex: string) => parseInt(hex, 16)));
  }

  const raw = new Uint8Array(64);
  raw.set(rStrip, 0);
  raw.set(sStrip, 32);
  return raw;
}

/**
 * Build the proof JSON string for w_execute_signed (WebAuthn P-256 variant).
 * The contract expects:
 *   authenticator_data: base64url-unpadded
 *   client_data_json: raw JSON string from WebAuthn
 *   signature: base58-encoded raw r||s (64 bytes) P-256 signature
 */
export function buildProof(
  authenticatorData: Uint8Array,
  clientDataJSON: string,
  signatureBytes: Uint8Array,
): string {
  const authenticatorDataB64 = uint8ToBase64url(authenticatorData);
  const rawSig = derToRawP256(signatureBytes);
  const signatureB58 = base58Encode(rawSig);
  return JSON.stringify({
    authenticator_data: authenticatorDataB64,
    client_data_json: clientDataJSON,
    signature: signatureB58,
  });
}
