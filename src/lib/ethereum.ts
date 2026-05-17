import bs58 from 'bs58';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { ETH_RPC, BASE_RPC } from './constants.js';
import type { MpcSignature, GasData, EthTx } from './types.js';
import { uint8ToHex, hexToUint8 } from './utils.js';

// ─── Ethereum RPC ───────────────────────────────────────

function getRpcUrl(chain: string): string {
  if (chain === 'base') return BASE_RPC;
  return ETH_RPC; // default to ethereum
}

async function ethRpc(method: string, params: unknown[] = [], chain: string = 'ethereum'): Promise<any> {
  const rpcUrl = getRpcUrl(chain);
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method, params, id: 1 }),
  });
  const data = await res.json();
  if (data.error) throw new Error(`ETH RPC: ${JSON.stringify(data.error)}`);
  return data.result;
}

export async function getEthBalance(address: string): Promise<bigint> {
  const balance = await ethRpc('eth_getBalance', [address, 'latest']);
  return BigInt(balance);
}

export async function getEthNonce(address: string, chain: string = 'ethereum'): Promise<number> {
  const nonce = await ethRpc('eth_getTransactionCount', [address, 'latest'], chain);
  return parseInt(nonce, 16);
}

export async function getEthGasPrice(chain: string = 'ethereum'): Promise<GasData> {
  const res = await ethRpc('eth_feeHistory', [1, 'latest', [25]], chain);
  if (res?.baseFeePerGas?.[1]) {
    const baseFee = BigInt(res.baseFeePerGas[1]);
    return {
      maxFeePerGas: baseFee * 3n,
      maxPriorityFeePerGas: BigInt('2000000000'),
    };
  }
  return {
    maxFeePerGas: BigInt('30000000000'),
    maxPriorityFeePerGas: BigInt('2000000000'),
  };
}

export async function getEthBlockNumber(): Promise<number> {
  const hex = await ethRpc('eth_blockNumber');
  return parseInt(hex, 16);
}

// ─── Key Derivation ─────────────────────────────────────

/**
 * Convert NEAR secp256k1 pubkey string to ETH address.
 * "secp256k1:base58..." → 0x... (20 bytes)
 * NEAR stores secp256k1 keys as 64 bytes raw (x + y, no 0x04 prefix).
 */
export function nearPubkeyToEthAddress(nearKey: string): string {
  const parts = nearKey.split(':');
  if (parts.length !== 2 || parts[0] !== 'secp256k1') {
    throw new Error(`Invalid NEAR pubkey: ${nearKey}`);
  }
  const decoded = bs58.decode(parts[1]);
  let pubKeyBytes: Uint8Array;
  if (decoded.length === 65 && decoded[0] === 0x04) {
    pubKeyBytes = decoded.slice(1);
  } else {
    // NEAR: 64 bytes raw x+y
    pubKeyBytes = decoded;
  }
  const hash = keccak_256(pubKeyBytes);
  return '0x' + uint8ToHex(hash.slice(-20));
}

/**
 * Derive Ethereum address from NEAR account via MPC.
 * Returns { derivedKey, ethAddress }
 */
export async function deriveEthAddress(
  nearAccountId: string,
  path: string = 'ethereum,1',
): Promise<{ derivedKey: string; ethAddress: string }> {
  // Import nearView dynamically to avoid circular dep
  const { nearView } = await import('./near.js');
  const { MPC_CONTRACT } = await import('./constants.js');

  const derivedKey = await nearView(MPC_CONTRACT, 'derived_public_key', {
    path,
    predecessor: nearAccountId,
  });

  const ethAddress = nearPubkeyToEthAddress(derivedKey);
  return { derivedKey, ethAddress };
}

// ─── RLP Encoding (minimal for EIP-1559 tx) ────────────

function intToRlp(n: bigint | number): Uint8Array {
  if (n === 0n || n === 0) return bytesToRlp(new Uint8Array(0));
  const big = BigInt(n);
  const bytes: number[] = [];
  let tmp = big;
  while (tmp > 0n) { bytes.unshift(Number(tmp & 0xffn)); tmp >>= 8n; }
  return bytesToRlp(new Uint8Array(bytes));
}

function bytesToRlp(bytes: Uint8Array): Uint8Array {
  if (bytes.length === 1 && bytes[0] < 0x80) return new Uint8Array([bytes[0]]);
  if (bytes.length < 56) {
    return new Uint8Array([0x80 + bytes.length, ...bytes]);
  }
  const lenBytes = encodeLength(bytes.length);
  return new Uint8Array([0x80 + 55 + lenBytes.length, ...lenBytes, ...bytes]);
}

function encodeLength(len: number): Uint8Array {
  const bytes: number[] = [];
  let tmp = len;
  while (tmp > 0) { bytes.unshift(tmp & 0xff); tmp >>= 8; }
  return new Uint8Array(bytes);
}

function rlpEncodeList(items: Uint8Array[]): Uint8Array {
  // Concatenate all RLP-encoded items
  const parts = items.map(i => {
    if (i instanceof Uint8Array) return i;
    return new Uint8Array(0);
  });
  const totalLen = parts.reduce((s, p) => s + p.length, 0);
  const payload = new Uint8Array(totalLen);
  let off = 0;
  for (const p of parts) { payload.set(p, off); off += p.length; }

  if (totalLen < 56) {
    return new Uint8Array([0xc0 + totalLen, ...payload]);
  }
  const lenBytes = encodeLength(totalLen);
  return new Uint8Array([0xc0 + 55 + lenBytes.length, ...lenBytes, ...payload]);
}

function rlpDecode(data: Uint8Array): (Uint8Array | (Uint8Array | Uint8Array[])[])[] {
  const [result] = rlpDecodeAt(data, 0);
  return result as (Uint8Array | (Uint8Array | Uint8Array[])[])[];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rlpDecodeAt(data: Uint8Array, offset: number): [any, number] {
  const b = data[offset];
  if (b < 0x80) {
    // Single byte
    return [new Uint8Array([b]), offset + 1];
  } else if (b <= 0xb7) {
    // Short string
    const len = b - 0x80;
    return [data.slice(offset + 1, offset + 1 + len), offset + 1 + len];
  } else if (b <= 0xbf) {
    // Long string
    const lenLen = b - 0xb7;
    const len = readBeInt(data, offset + 1, lenLen);
    return [data.slice(offset + 1 + lenLen, offset + 1 + lenLen + len), offset + 1 + lenLen + len];
  } else if (b <= 0xf7) {
    // Short list
    const len = b - 0xc0;
    const items: (Uint8Array | Uint8Array[])[] = [];
    let pos = offset + 1;
    const end = pos + len;
    while (pos < end) {
      const [item, newPos] = rlpDecodeAt(data, pos);
      items.push(item as Uint8Array | Uint8Array[]);
      pos = newPos;
    }
    return [items, end];
  } else {
    // Long list
    const lenLen = b - 0xf7;
    const len = readBeInt(data, offset + 1, lenLen);
    const items: (Uint8Array | Uint8Array[])[] = [];
    let pos = offset + 1 + lenLen;
    const end = pos + len;
    while (pos < end) {
      const [item, newPos] = rlpDecodeAt(data, pos);
      items.push(item as Uint8Array | Uint8Array[]);
      pos = newPos;
    }
    return [items, end];
  }
}

function readBeInt(data: Uint8Array, offset: number, len: number): number {
  let n = 0;
  for (let i = 0; i < len; i++) n = n * 256 + data[offset + i];
  return n;
}

// ─── ETH Transaction Building ──────────────────────────

/**
 * Build an unsigned EIP-1559 ETH transfer transaction.
 * Returns { unsignedTxHex, txPayloadHash } where txPayloadHash is the 32-byte hash
 * that needs to be signed by MPC.
 */
export function buildEthTx(params: {
  nonce: number;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  to: string | Uint8Array;
  valueWei: bigint;
  from: string;
}): EthTx {
  const { nonce, maxFeePerGas, maxPriorityFeePerGas, valueWei } = params;
  const to = typeof params.to === 'string' ? params.to : '';
  // EIP-1559 tx fields:
  // [chainId, nonce, maxPriorityFeePerGas, maxFeePerGas, gasLimit, to, value, data, accessList]
  const gasLimit = 21000n; // simple ETH transfer
  const chainId = 1; // mainnet

  const fields: Uint8Array[] = [
    intToRlp(chainId),
    intToRlp(nonce),
    intToRlp(maxPriorityFeePerGas),
    intToRlp(maxFeePerGas),
    intToRlp(gasLimit),
    to.length === 20 ? bytesToRlp(hexToUint8(to)) : bytesToRlp(typeof params.to === 'string' ? hexToUint8(to) : params.to),
    intToRlp(valueWei),
    bytesToRlp(new Uint8Array(0)), // empty data
    bytesToRlp(new Uint8Array(0)), // empty access list
  ];

  // Encode as RLP list (unsigned: type 0x02 + RLP([fields]))
  const rlpFields = rlpEncodeList(fields);
  const unsignedTx = new Uint8Array([0x02, ...rlpFields]);

  // Hash for signing: keccak256(0x02 || RLP([fields]))
  const txHash = keccak_256(unsignedTx);

  return {
    unsignedTxHex: '0x' + uint8ToHex(unsignedTx),
    txPayloadHash: txHash,
  };
}

/**
 * Assemble a signed EIP-1559 tx from the unsigned tx + MPC signature.
 */
export function assembleSignedEthTx(
  unsignedTxHex: string,
  mpcSignature: MpcSignature,
  _ethAddress: string,
): string {
  // mpcSignature: { big_r: { affine_point: "0x..." }, s: { scalar: "0x..." }, recovery_id: number }
  const rHex = mpcSignature.big_r.affine_point.replace(/^0x/, '');
  const sHex = mpcSignature.s.scalar.replace(/^0x/, '');
  const v = 27 + mpcSignature.recovery_id;

  const unsignedBytes = hexToUint8(unsignedTxHex.replace(/^0x/, ''));
  // Strip the 0x02 type byte for re-encoding
  const rlpData = unsignedBytes.slice(1);

  // Decode the RLP list to get the fields
  const decoded = rlpDecode(rlpData);
  // Add signature fields: [v, r, s]
  const signedFields = [...decoded, intToRlp(v), bytesToRlp(hexToUint8(rHex)), bytesToRlp(hexToUint8(sHex))];

  const signedRlp = rlpEncodeList(signedFields as Uint8Array[]);
  const signedTx = new Uint8Array([0x02, ...signedRlp]);

  return '0x' + uint8ToHex(signedTx);
}

/**
 * Broadcast a signed ETH tx to the network.
 */
export async function broadcastEthTx(signedTxHex: string): Promise<string> {
  return ethRpc('eth_sendRawTransaction', [signedTxHex]);
}

/**
 * Build the MPC sign args JSON for an ETH tx payload hash.
 * Uses ECDSA (domain 0).
 */
export function buildMpcSignArgs(payloadHash: Uint8Array, path: string = 'ethereum,1'): string {
  return JSON.stringify({
    request: {
      payload: Array.from(payloadHash),
      path,
      key_version: 0,
    },
  });
}

/**
 * Build the MPC sign args JSON for EdDSA (Ed25519/Solana).
 * EdDSA signs the FULL MESSAGE, not a hash.
 * Uses domain_id 1 for Ed25519.
 */
export function buildMpcSignArgsEdDSA(messageBytes: Uint8Array, path: string = 'solana'): string {
  // EdDSA payload is hex-encoded full message (32-1232 bytes)
  const hexMsg = Array.from(messageBytes).map(b => b.toString(16).padStart(2, '0')).join('');
  return JSON.stringify({
    path,
    payload_v2: { Eddsa: '0x' + hexMsg },
    domain_id: 1,
  });
}
