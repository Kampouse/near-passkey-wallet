/**
 * WASM Borsh Serialization - Shared code between frontend and contract
 * 
 * This module loads the wallet-wasm WASM module that implements the exact
 * borsh serialization format the contract expects. Using the same code on
 * both sides guarantees byte-identical encoding.
 * 
 * Use this instead of wallet.js borshRequestMessage() for session key signing.
 */

let wasmModule = null

/**
 * Initialize the WASM module. Must be called before other functions.
 * @returns {Promise<void>}
 */
export async function initWasm() {
  if (wasmModule) return
  const init = await import('./wallet-wasm/wallet_wasm.js')
  wasmModule = await init.default()
}

/**
 * Ensure WASM is loaded, throw if not.
 */
function ensureWasm() {
  if (!wasmModule) {
    throw new Error('WASM not initialized. Call initWasm() first.')
  }
}

/**
 * Convert hex string to Uint8Array.
 * @param {string} hex 
 * @returns {Uint8Array}
 */
function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16)
  }
  return bytes
}

/**
 * Borsh-serialize a RequestMessage using the WASM module.
 * This guarantees byte-identical encoding with the contract.
 * 
 * @param {object} msg - Request message
 * @param {string} msg.chain_id - Chain ID (e.g., "mainnet")
 * @param {string} msg.signer_id - Signer account ID
 * @param {number} msg.nonce - Nonce (u32)
 * @param {number} msg.created_at - Created at timestamp (u32 seconds)
 * @param {number} msg.timeout - Timeout duration (u32 seconds)
 * @returns {Uint8Array} - Borsh-serialized bytes
 */
export function borshSerializeRequest(msg) {
  ensureWasm()
  const hex = wasmModule.borsh_serialize_request(
    msg.chain_id,
    msg.signer_id,
    msg.nonce,
    msg.created_at,
    msg.timeout,
  )
  return hexToBytes(hex)
}

/**
 * Compute SHA-256 hash of borsh-serialized RequestMessage using WASM.
 * @param {object} msg - Same parameters as borshSerializeRequest
 * @returns {Uint8Array} - 32-byte SHA-256 hash
 */
export function hashRequest(msg) {
  ensureWasm()
  const hex = wasmModule.hash_request(
    msg.chain_id,
    msg.signer_id,
    msg.nonce,
    msg.created_at,
    msg.timeout,
  )
  return hexToBytes(hex)
}

/**
 * Verify an ed25519 signature against a message hash using WASM.
 * 
 * @param {string} pkB58 - Public key in base58 (ed25519:...)
 * @param {string} sigB58 - Signature in base58
 * @param {string} msgHashHex - Message hash as hex string
 * @returns {boolean} - True if signature is valid
 */
export function verifySignature(pkB58, sigB58, msgHashHex) {
  ensureWasm()
  return wasmModule.verify_signature(pkB58, sigB58, msgHashHex)
}

/**
 * Check if WASM is loaded and ready.
 * @returns {boolean}
 */
export function isWasmReady() {
  return wasmModule !== null
}