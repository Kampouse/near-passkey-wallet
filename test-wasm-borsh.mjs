#!/usr/bin/env node
/**
 * Compare WASM borsh output with JS borsh output to verify byte-identical encoding.
 */

import { borshRequestMessage } from './src/wallet.js'
import initWasm, { borsh_serialize_request, hash_request } from './src/wallet-wasm/wallet_wasm.js'

// Test message matching the contract
const msg = {
  chain_id: 'mainnet',
  signer_id: 'f3if43kong43jong3io4ng34ui.testnet',
  nonce: 1021610160, // sample from trace
  created_at: 1778796438, // May 14, 2026 timestamp
  timeout: 300,
}

async function main() {
  console.log('=== Borsh Encoding Comparison ===\n')
  
  // JS borsh
  const jsBytes = borshRequestMessage(msg)
  console.log('JS borsh bytes:', jsBytes.length)
  console.log('JS hex:', Array.from(jsBytes).map(b => b.toString(16).padStart(2, '0')).join(''))
  
  // WASM borsh  
  await initWasm()
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
  const jsHex = Array.from(jsBytes).map(b => b.toString(16).padStart(2, '0')).join('')
  if (jsHex === wasmHex) {
    console.log('\n✓ MATCH! JS and WASM produce identical borsh encoding')
  } else {
    console.log('\n✗ MISMATCH!')
    console.log('JS length:', jsHex.length / 2)
    console.log('WASM length:', wasmHex.length / 2)
    
    // Find first difference
    for (let i = 0; i < Math.max(jsHex.length, wasmHex.length); i += 2) {
      const jsByte = jsHex.slice(i, i+2)
      const wasmByte = wasmHex.slice(i, i+2)
      if (jsByte !== wasmByte) {
        console.log(`First diff at byte ${i/2}: JS=${jsByte} WASM=${wasmByte}`)
        console.log(`JS context: ...${jsHex.slice(Math.max(0, i-10), i+20)}...`)
        console.log(`WASM context: ...${wasmHex.slice(Math.max(0, i-10), i+20)}...`)
        break
      }
    }
  }
  
  // Hash comparison
  const wasmHash = hash_request(msg.chain_id, msg.signer_id, msg.nonce, msg.created_at, msg.timeout)
  console.log('\nWASM SHA-256 hash:', wasmHash)
}

main().catch(console.error)
