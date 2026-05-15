/**
 * Nostr protocol helpers
 * NIP-01: Basic protocol, NIP-04: Encryption, NIP-46: Bunker
 */

// ─── Nostr Event Serialization (NIP-01) ─────────────────────────────

/**
 * Serialize a Nostr event for signing (NIP-01)
 * Returns the SHA-256 hash of the serialized event
 */
export function serializeNostrEvent(event) {
  // NIP-01 serialization: [0, pubkey, created_at, kind, tags, content]
  const serialized = JSON.stringify([
    0,
    event.pubkey,
    event.created_at,
    event.kind,
    event.tags || [],
    event.content || '',
  ])
  return serialized
}

/**
 * Compute the event ID (SHA-256 hash of serialized event)
 */
export async function computeEventId(event) {
  const serialized = serializeNostrEvent(event)
  const encoder = new TextEncoder()
  const data = encoder.encode(serialized)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  const hashArray = new Uint8Array(hashBuffer)
  return bytesToHex(hashArray)
}

/**
 * Create a Nostr event template (unsigned)
 */
export function createEventTemplate(pubkey, kind, content = '', tags = []) {
  return {
    pubkey,
    created_at: Math.floor(Date.now() / 1000),
    kind,
    tags,
    content,
  }
}

// ─── Bech32 Encoding ───────────────────────────────────────────────

const BECH32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'

function bech32Polymod(values) {
  let GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]
  let chk = 1
  for (let v of values) {
    let b = chk >> 25
    chk = ((chk & 0x1ffffff) << 5) ^ v
    for (let i = 0; i < 5; i++) {
      if ((b >> i) & 1) {
        chk ^= GEN[i]
      }
    }
  }
  return chk
}

function bech32HrpExpand(hrp) {
  let ret = []
  for (let i = 0; i < hrp.length; i++) {
    ret.push(hrp.charCodeAt(i) >> 5)
  }
  ret.push(0)
  for (let i = 0; i < hrp.length; i++) {
    ret.push(hrp.charCodeAt(i) & 31)
  }
  return ret
}

function bech32CreateChecksum(hrp, data) {
  let values = bech32HrpExpand(hrp).concat(data).concat([0, 0, 0, 0, 0, 0])
  let mod = bech32Polymod(values) ^ 1
  let ret = []
  for (let i = 0; i < 6; i++) {
    ret.push((mod >> (5 * (5 - i))) & 31)
  }
  return ret
}

function convertbits(data, frombits, tobits, pad = true) {
  let acc = 0
  let bits = 0
  let ret = []
  let maxv = (1 << tobits) - 1
  for (let i = 0; i < data.length; i++) {
    let value = data[i]
    if (value < 0 || (value >> frombits) !== 0) {
      return null
    }
    acc = (acc << frombits) | value
    bits += frombits
    while (bits >= tobits) {
      bits -= tobits
      ret.push((acc >> bits) & maxv)
    }
  }
  if (pad) {
    if (bits) {
      ret.push((acc << (tobits - bits)) & maxv)
    }
  } else if (bits >= frombits || ((acc << (tobits - bits)) & maxv)) {
    return null
  }
  return ret
}

/**
 * Encode bytes to bech32 (npub, nsec, etc.)
 */
export function encodeBech32(hrp, data) {
  let fiveBitData = convertbits(Array.from(data), 8, 5)
  if (!fiveBitData) throw new Error('Failed to convert to 5-bit')
  let checksum = bech32CreateChecksum(hrp, fiveBitData)
  let combined = fiveBitData.concat(checksum)
  return hrp + '1' + combined.map(v => BECH32_CHARSET[v]).join('')
}

/**
 * Convert hex pubkey to npub (bech32)
 */
export function pubkeyToNpub(hexPubkey) {
  // Remove 0x prefix if present
  const hex = hexPubkey.startsWith('0x') ? hexPubkey.slice(2) : hexPubkey
  // Convert hex to bytes
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substr(i, 2), 16)
  }
  return encodeBech32('npub', bytes)
}

/**
 * Decode bech32 to bytes
 */
export function decodeBech32(str) {
  let lower = str.toLowerCase()
  let sep = lower.lastIndexOf('1')
  if (sep < 1) throw new Error('Invalid bech32: no separator')
  let hrp = lower.slice(0, sep)
  let data = []
  for (let i = sep + 1; i < lower.length; i++) {
    let v = BECH32_CHARSET.indexOf(lower[i])
    if (v === -1) throw new Error('Invalid bech32 character')
    data.push(v)
  }
  let eightBitData = convertbits(data.slice(0, -6), 5, 8, false)
  if (!eightBitData) throw new Error('Failed to convert from 5-bit')
  return { hrp, data: new Uint8Array(eightBitData) }
}

// ─── Utility Functions ──────────────────────────────────────────────

export function bytesToHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')
}

export function hexToBytes(hex) {
  if (hex.length % 2 !== 0) throw new Error('Invalid hex string')
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16)
  }
  return bytes
}

// ─── NIP-04 Encryption (Deprecated but widely used) ─────────────────
// Uses AES-256-CBC with shared secret from ECDH

/**
 * Derive shared secret using X25519 (for ECDH)
 * Note: This requires converting Ed25519 key to X25519
 */
export async function deriveSharedSecret(privateKey, publicKey) {
  // libsodium-style: crypto_scalarmult_ed25519
  // We'll use WebCrypto with X25519 if available, or fallback to libsodium
  // For MVP, we'll delegate to a simpler approach
  
  // Ed25519 -> X25519 conversion: clamp and clear bits
  // This is a simplified implementation
  const edPriv = privateKey.slice(0, 32)
  const edPub = publicKey
  
  // Use WebCrypto for X25519
  // Note: WebCrypto X25519 support is limited, may need polyfill
  // For now, return raw keys for external crypto library
  return { privateKey: edPriv, publicKey: edPub }
}

/**
 * NIP-04 encrypt content
 */
export async function nip04Encrypt(content, senderPrivKey, recipientPubKey) {
  // Generate random IV
  const iv = crypto.getRandomValues(new Uint8Array(16))
  const ivHex = bytesToHex(iv)
  
  // Derive shared secret using ECDH
  // For MVP, we'll use a simple approach with WebCrypto
  // Full implementation needs @noble/curves for Ed25519->X25519 conversion
  
  // TODO: Implement proper X25519 ECDH
  // For now, return placeholder
  return {
    ciphertext: 'placeholder',
    iv: ivHex,
  }
}

/**
 * NIP-04 decrypt content
 */
export async function nip04Decrypt(encrypted, iv, senderPubKey, recipientPrivKey) {
  // TODO: Implement proper X25519 ECDH decryption
  return 'decrypted placeholder'
}

// ─── NIP-46 Bunker Protocol ─────────────────────────────────────────

/**
 * NIP-46 request types
 */
export const NIP46_METHODS = {
  GET_PUBLIC_KEY: 'get_public_key',
  SIGN_EVENT: 'sign_event',
  NIP04_ENCRYPT: 'nip04_encrypt',
  NIP04_DECRYPT: 'nip04_decrypt',
  NIP44_ENCRYPT: 'nip44_encrypt',
  NIP44_DECRYPT: 'nip44_decrypt',
  GET_RELAYS: 'get_relays',
  PING: 'ping',
}

/**
 * Create a NIP-46 bunker URI for pairing
 * Format: bunker://<pubkey>?relay=<relay_url>&secret=<optional_secret>
 */
export function createBunkerUri(pubkeyHex, relayUrl, secret = '') {
  const npub = encodeBech32('npub', hexToBytes(pubkeyHex))
  let uri = `bunker://${npub}?relay=${encodeURIComponent(relayUrl)}`
  if (secret) {
    uri += `&secret=${encodeURIComponent(secret)}`
  }
  return uri
}

/**
 * Parse a NIP-46 bunker URI
 */
export function parseBunkerUri(uri) {
  // bunker://npub...?relay=wss://...&secret=...
  // or bunker://<hex-pubkey>?relay=...
  const url = new URL(uri)
  if (url.protocol !== 'bunker:') throw new Error('Not a bunker URI')
  
  let pubkey = url.host
  // If it's npub, decode it
  if (pubkey.startsWith('npub')) {
    const decoded = decodeBech32(pubkey)
    pubkey = bytesToHex(decoded.data)
  }
  
  const params = url.searchParams
  return {
    pubkey,
    relay: params.get('relay'),
    secret: params.get('secret') || undefined,
  }
}

/**
 * Create a NIP-46 signature event (kind 24133)
 */
export function createNip46Event(pubkey, content, tags = []) {
  return createEventTemplate(pubkey, 24133, content, tags)
}

/**
 * Parse NIP-46 request content
 * Format: ["method", "pubkey", "<args...>"] (JSON array)
 */
export function parseNip46Request(content) {
  try {
    const parsed = JSON.parse(content)
    if (!Array.isArray(parsed)) return null
    const [method, pubkey, ...args] = parsed
    return { method, pubkey, args }
  } catch {
    return null
  }
}

/**
 * Create NIP-46 response content
 * Format: ["ACK", "<result>"] or ["NOTICE", "<error>"]
 */
export function createNip46Response(result, isError = false) {
  if (isError) {
    return JSON.stringify(['NOTICE', result])
  }
  return JSON.stringify(['ACK', result])
}