#!/usr/bin/env node
/**
 * Test session key signature verification.
 * Usage: node test-session-sig.js <tx_args_json>
 */

import crypto from 'crypto'

// Base58 decode
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

function base58Decode(str) {
  const bytes = []
  for (const c of str) {
    let val = BASE58_ALPHABET.indexOf(c)
    if (val === -1) throw new Error(`Invalid base58 char: ${c}`)
    for (let i = 0; i < bytes.length; i++) {
      val += bytes[i] * 58
      bytes[i] = val & 0xff
      val >>= 8
    }
    while (val > 0) {
      bytes.push(val & 0xff)
      val >>= 8
    }
  }
  for (const c of str) {
    if (c === '1') bytes.unshift(0)
    else break
  }
  return new Uint8Array(bytes.reverse())
}

// Borsh serialization
function borshString(s) {
  const buf = Buffer.from(s, 'utf8')
  const len = Buffer.alloc(4)
  len.writeUInt32LE(buf.length, 0)
  return Buffer.concat([len, buf])
}

function borshU64(n) {
  const buf = Buffer.alloc(8)
  buf.writeBigUInt64LE(BigInt(n), 0)
  return buf
}

function borshU32(n) {
  const buf = Buffer.alloc(4)
  buf.writeUInt32LE(n, 0)
  return buf
}

/**
 * Borsh serialize RequestMessage.
 * 
 * RequestMessage {
 *   chain_id: String,
 *   signer_id: AccountId,
 *   nonce: u32,
 *   created_at: TimestampSeconds<u32>,  // u32 seconds, NOT nanoseconds!
 *   timeout: BorshDurationSeconds<u32>,  // u32 seconds
 *   request: Request { ops: Vec<Op>, out: PromiseDAG }
 * }
 */
function borshRequestMessage({ chain_id, signer_id, nonce, created_at_seconds, timeout_seconds }) {
  // created_at: TimestampSeconds<u32> — serialized as u32
  // timeout: BorshDurationSeconds<u32> — serialized as u32
  
  const parts = [
    borshString(chain_id),
    borshString(signer_id),
    borshU32(nonce),
    borshU32(created_at_seconds),  // u32, NOT u64 nanoseconds!
    borshU32(timeout_seconds),     // u32, NOT u64 nanoseconds!
    borshU32(0), // ops.len = 0
    borshU32(0), // out.after.len = 0
    borshU32(0), // out.then.len = 0
  ]
  return Buffer.concat(parts)
}

async function main() {
  const args = process.argv[2]
  if (!args) {
    console.error('Usage: node test-session-sig.js <tx_args_json>')
    process.exit(1)
  }
  
  const tx = JSON.parse(args)
  console.log('=== Session Key Signature Test ===\n')
  
  const { msg, session_key_id, signature } = tx
  const { chain_id, signer_id, nonce, created_at, timeout_secs } = msg
  const createdAtTs = Math.floor(new Date(created_at).getTime() / 1000)
  
  console.log('Message:')
  console.log(`  chain_id: ${chain_id}`)
  console.log(`  signer_id: ${signer_id}`)
  console.log(`  nonce: ${nonce}`)
  console.log(`  created_at: ${created_at} (${createdAtTs}s)`)
  console.log(`  timeout_secs: ${timeout_secs}`)
  
  // Compute borsh
  const borshBytes = borshRequestMessage({
    chain_id,
    signer_id,
    nonce,
    created_at_seconds: createdAtTs,
    timeout_seconds: timeout_secs,
  })
  console.log(`\nBorsh (${borshBytes.length} bytes):`)
  console.log(`  ${borshBytes.toString('hex')}`)
  
  // SHA-256 hash
  const hash = crypto.createHash('sha256').update(borshBytes).digest()
  console.log(`\nSHA-256 hash:`)
  console.log(`  ${hash.toString('hex')}`)
  
  // Decode signature
  const sigBytes = base58Decode(signature)
  console.log(`\nSignature (${sigBytes.length} bytes):`)
  console.log(`  ${sigBytes.toString('hex')}`)
  
  // Fetch on-chain session key
  console.log('\nFetching on-chain session key...')
  const rpcUrl = 'https://rpc.testnet.near.org'
  const viewCall = {
    jsonrpc: '2.0',
    id: 1,
    method: 'query',
    params: {
      request_type: 'call_function',
      finality: 'final',
      account_id: signer_id,
      method_name: 'w_session_key',
      args_base64: Buffer.from(JSON.stringify({ session_key_id })).toString('base64'),
    },
  }
  
  const resp = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(viewCall),
  })
  const rpcResult = await resp.json()
  
  if (rpcResult.error) {
    console.error('RPC error:', rpcResult.error)
    process.exit(1)
  }
  
  const sessionKeyData = JSON.parse(Buffer.from(rpcResult.result.result).toString())
  const pubKeyB58 = sessionKeyData.public_key
  const pubKeyBytes = base58Decode(pubKeyB58.replace('ed25519:', ''))
  
  console.log(`\nOn-chain public key:`)
  console.log(`  ${pubKeyB58}`)
  console.log(`  ${pubKeyBytes.toString('hex')} (${pubKeyBytes.length} bytes)`)
  
  // Build SPKI public key
  const spkiHeader = Buffer.from('302a300506032b6570032100', 'hex')
  const spkiPubKey = Buffer.concat([spkiHeader, pubKeyBytes])
  
  const edPubKey = crypto.createPublicKey({
    key: spkiPubKey,
    format: 'der',
    type: 'spki',
  })
  
  console.log('\nVerifying Ed25519 signature...')
  
  // Ed25519-Pure: verify signature over the hash (what frontend signs)
  try {
    const valid = crypto.verify(null, hash, edPubKey, sigBytes)
    console.log(`  Ed25519-Pure(sig, pk, hash): ${valid ? '✓ VALID' : '✗ INVALID'}`)
  } catch (e) {
    console.log(`  Pure Ed25519 failed: ${e.message}`)
  }
}

main().catch(console.error)