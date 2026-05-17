
import { etc, getPublicKey, sign } from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';
etc.sha512Sync = (...m) => sha512(etc.concatBytes(...m));

import nearAPI from 'near-api-js';
import BN from 'bn.js';
import path from 'path';

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

const SK = process.argv[2];
const rawKey = base58Decode(SK);
const seed = rawKey.length === 32 ? rawKey : rawKey.slice(0, 32);
const pubKeyNoble = await getPublicKey(seed);

// Get nonce and block hash via near-api-js
const keyStore = new nearAPI.keyStores.UnencryptedFileSystemKeyStore(
  path.join(process.env.HOME, '.near-credentials')
);
const near = await nearAPI.connect({ networkId: 'testnet', nodeUrl: 'https://rpc.testnet.near.org', keyStore });
const account = await near.account('gork-agent.testnet');
const keyPair = await keyStore.getKey('testnet', 'gork-agent.testnet');
const pubKeyJS = keyPair.getPublicKey();

const accessKey = await account.findAccessKey();
const block = await account.connection.provider.block({ finality: 'final' });
const nonce = BigInt(accessKey.accessKey.nonce) + 1n;
const blockHashBytes = nearAPI.utils.serialize.base_decode(block.header.hash);

const args = Buffer.from(JSON.stringify({test:true}));

// === MY borsh ===
const myTx = cat(
  string('gork-agent.testnet'),
  new Uint8Array([0]),
  pubKeyNoble,
  u64(nonce),
  string('pwallet1.testnet'),
  blockHashBytes,
  u32(1),
  new Uint8Array([2]),
  string('w_execute_signed'),
  bytes(args),
  u64(300000000000000n),
  u128(0n),
);

// === near-api-js borsh ===
const actions = [nearAPI.transactions.functionCall('w_execute_signed', args, new BN('300000000000000'), new BN('0'))];
const jsTx = nearAPI.transactions.createTransaction('gork-agent.testnet', pubKeyJS, 'pwallet1.testnet', parseInt(nonce), actions, blockHashBytes);
const jsTxBytes = nearAPI.utils.serialize.serialize(nearAPI.transactions.SCHEMA, jsTx);

console.log('MY tx length:', myTx.length);
console.log('JS tx length:', jsTxBytes.length);

// Compare byte by byte
let firstDiff = -1;
for (let i = 0; i < Math.max(myTx.length, jsTxBytes.length); i++) {
  const a = myTx[i];
  const b = jsTxBytes[i];
  if (a !== b) {
    firstDiff = i;
    console.log('First diff at byte', i, ': my=', a?.toString(16), 'js=', b?.toString(16));
    console.log('Context my:', Array.from(myTx.slice(Math.max(0,i-4), i+8)).map(x=>x.toString(16).padStart(2,'0')).join(' '));
    console.log('Context js:', Array.from(jsTxBytes.slice(Math.max(0,i-4), i+8)).map(x=>x.toString(16).padStart(2,'0')).join(' '));
    break;
  }
}
if (firstDiff === -1) console.log('MATCH!');
