
import { etc, getPublicKey, sign } from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';
etc.sha512Sync = (...m) => sha512(etc.concatBytes(...m));

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58Decode(str) {
  const bytes = [];
  for (let i = 0; i < str.length; i++) {
    let carry = B58.indexOf(str[i]);
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) { bytes.push(carry & 0xff); carry >>= 8; }
  }
  for (let i = 0; i < str.length && str[i] === '1'; i++) bytes.push(0);
  return new Uint8Array(bytes.reverse());
}

function cat(...arrs) {
  const out = new Uint8Array(arrs.reduce((s, a) => s + a.length, 0));
  let off = 0;
  for (const a of arrs) { out.set(a, off); off += a.length; }
  return out;
}
function u32(v) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v, true); return b; }
function u64(v) { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(v), true); return b; }
function u128(v) {
  const b = new Uint8Array(16);
  new DataView(b.buffer).setBigUint64(0, BigInt(v) & ((1n << 64n) - 1n), true);
  new DataView(b.buffer).setBigUint64(8, BigInt(v) >> 64n, true);
  return b;
}
function string(s) { const e = new TextEncoder().encode(s); return cat(u32(e.length), e); }
function bytes(a) { return cat(u32(a.length), a); }
function b64encode(a) { let s = ''; for (let i = 0; i < a.length; i++) s += String.fromCharCode(a[i]); return btoa(s); }
function b64decode(b) { const s = atob(b); const a = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i); return a; }

const SK = process.argv[2];
const rawKey = base58Decode(SK);
const seed = rawKey.length === 32 ? rawKey : rawKey.slice(0, 32);
const pubKey = await getPublicKey(seed);

const rpc = async (method, params) => {
  const r = await fetch('https://rpc.testnet.near.org', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'r', method, params }),
  });
  const j = await r.json();
  if (j.error) throw new Error(JSON.stringify(j.error));
  return j.result;
};

// Base58 encode pubkey
let num = 0n;
for (const b of pubKey) num = num * 256n + BigInt(b);
let pubB58 = '';
while (num > 0n) { pubB58 = B58[Number(num % 58n)] + pubB58; num /= 58n; }
for (const b of pubKey) { if (b === 0) pubB58 = '1' + pubB58; else break; }

console.log('pubB58:', pubB58);

const [accessKey, block] = await Promise.all([
  rpc('query', { request_type: 'view_access_key', finality: 'final', account_id: 'gork-agent.testnet', public_key: 'ed25519:' + pubB58 }),
  rpc('block', { finality: 'final' }),
]);

const nonce = BigInt(accessKey.nonce) + 1n;
const blockHash = b64decode(block.header.hash);

const argsBytes = new TextEncoder().encode(JSON.stringify({test:true}));

const txBytes = cat(
  string('gork-agent.testnet'),
  new Uint8Array([0]),
  pubKey,
  u64(nonce),
  string('pwallet1.testnet'),
  blockHash,
  u32(1),
  new Uint8Array([2]),
  string('w_execute_signed'),
  bytes(argsBytes),
  u64(300000000000000n),
  u128(0n),
);

const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', txBytes));
const sig = await sign(hash, seed);

const signedBytes = cat(txBytes, new Uint8Array([0]), sig);
const b64 = b64encode(signedBytes);

const result = await rpc('broadcast_tx_commit', [b64]);
console.log('Status:', Object.keys(result.status || {})[0]);
console.log('TX:', result.transaction?.hash);
