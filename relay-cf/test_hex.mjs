
import { etc, getPublicKey } from '@noble/ed25519';
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

const rawKey = base58Decode('3DbaQ1phbGcMsana4geJWkKAepe8bLx5g4FfngYcquLEK1QdpoHNjRGsdmLZfNnoGkzMwDmk2ct6g5ypvHzj2jsk');
const seed = rawKey.length === 32 ? rawKey : rawKey.slice(0, 32);
const pubKey = await getPublicKey(seed);

// Use fixed nonce and block hash for deterministic comparison
const dummyHash = new Uint8Array(32).fill(0xab);
const argsBytes = new TextEncoder().encode(JSON.stringify({test:true}));

const txBytes = cat(
  string('gork-agent.testnet'),
  new Uint8Array([0]),
  pubKey,
  u64(12345n),
  string('pwallet1.testnet'),
  dummyHash,
  u32(1),
  new Uint8Array([2]),
  string('w_execute_signed'),
  bytes(argsBytes),
  u64(300000000000000n),
  u128(0n),
);

// Dump full hex
const hex = Array.from(txBytes).map(b => b.toString(16).padStart(2, '0')).join('');
console.log('TOTAL LENGTH:', txBytes.length);
console.log('HEX:', hex);

// Also dump field by field
let off = 0;
const read = (n, label) => {
  const slice = txBytes.slice(off, off+n);
  console.log(label + ' (' + n + ' bytes):', Array.from(slice).map(b=>b.toString(16).padStart(2,'0')).join(''));
  off += n;
};
const readU32 = (label) => {
  const v = new DataView(txBytes.buffer, off, 4).getUint32(0, true);
  console.log(label + ':', v, '(0x' + v.toString(16) + ')');
  off += 4;
  return v;
};
const readStr = (label) => {
  const len = readU32(label + ' len');
  const s = new TextDecoder().decode(txBytes.slice(off, off+len));
  console.log(label + ':', s);
  off += len;
};
const readBytes = (label) => {
  const len = readU32(label + ' len');
  console.log(label + ' (' + len + ' bytes)');
  off += len;
};

console.log('\n--- Field breakdown ---');
readStr('signer_id');
read(1, 'pk_type');
read(32, 'pubkey');
read(8, 'nonce');
readStr('receiver_id');
read(32, 'block_hash');
readU32('actions_count');
read(1, 'action_type');
readStr('method_name');
readBytes('args');
read(8, 'gas');
read(16, 'deposit');
console.log('Remaining:', txBytes.length - off);
