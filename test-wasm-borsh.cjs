/**
 * Node.js sync test for WASM borsh encoding
 */
const fs = require('fs')
const path = require('path')

// Load WASM module synchronously
const wasmPath = path.join(__dirname, 'src/wallet-wasm/wallet_wasm_bg.wasm')
const wasmBuffer = fs.readFileSync(wasmPath)

// Import initSync
const { initSync, borsh_serialize_request, hash_request } = require('./src/wallet-wasm/wallet_wasm.js')

// JS borsh implementation from wallet.js
function borshU32(n) {
  const buf = Buffer.alloc(4)
  buf.writeUInt32LE(n, 0)
  return buf
}

function borshString(s) {
  const buf = Buffer.from(s, 'utf8')
  const len = Buffer.alloc(4)
  len.writeUInt32LE(buf.length, 0)
  return Buffer.concat([len, buf])
}

function borshRequestMessage(msg) {
  return Buffer.concat([
    borshString(msg.chain_id),
    borshString(msg.signer_id),
    borshU32(msg.nonce),
    borshU32(msg.created_at),
    borshU32(msg.timeout),
    borshU32(0), // ops.len = 0
    borshU32(0), // out.after.len = 0
    borshU32(0), // out.then.len = 0
  ])
}

// Test message
const msg = {
  chain_id: 'mainnet',
  signer_id: 'f3if43kong43jong3io4ng34ui.testnet',
  nonce: 1021610160,
  created_at: 1778796438,
  timeout: 300,
}

console.log('=== Borsh Encoding Comparison ===\n')

// JS borsh
const jsBytes = borshRequestMessage(msg)
console.log('JS borsh bytes:', jsBytes.length)
console.log('JS hex:', jsBytes.toString('hex'))

// Initialize WASM
initSync({ module: wasmBuffer })

// WASM borsh
const wasmHex = borsh_serialize_request(
  msg.chain_id,
  msg.signer_id,
  msg.nonce,
  msg.created_at,
  msg.timeout,
)
console.log('\nWASM borsh bytes:', wasmHex.length / 2)
console.log('WASM hex:', wasmHex)

// Compare
const jsHex = jsBytes.toString('hex')
if (jsHex === wasmHex) {
  console.log('\n✓ MATCH! JS and WASM produce identical borsh encoding')
} else {
  console.log('\n✗ MISMATCH!')
  console.log('JS length:', jsHex.length / 2)
  console.log('WASM length:', wasmHex.length / 2)
  
  // Find first difference
  const jsArr = Buffer.from(jsHex, 'hex')
  const wasmArr = Buffer.from(wasmHex, 'hex')
  for (let i = 0; i < Math.max(jsArr.length, wasmArr.length); i++) {
    if (jsArr[i] !== wasmArr[i]) {
      console.log(`First diff at byte ${i}: JS=${jsArr[i]?.toString(16).padStart(2,'0')} WASM=${wasmArr[i]?.toString(16).padStart(2,'0')}`)
      console.log(`JS context: ...${jsArr.slice(Math.max(0,i-5),i+5).toString('hex')}...`)
      console.log(`WASM context: ...${wasmArr.slice(Math.max(0,i-5),i+5).toString('hex')}...`)
      break
    }
  }
}

// Hash comparison
const wasmHash = hash_request(msg.chain_id, msg.signer_id, msg.nonce, msg.created_at, msg.timeout)
console.log('\nWASM SHA-256 hash:', wasmHash)
