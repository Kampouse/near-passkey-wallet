/**
 * NIP-44 Cryptographic Utilities
 * 
 * Thin wrapper around nostr-tools/nip44 with type safety.
 */

import * as nip44 from 'nostr-tools/nip44'
import type { HexPubkey, SecretKey } from './types'

/**
 * Derive conversation key for NIP-44 encryption
 */
export function getConversationKey(secretKey: SecretKey, theirPubkey: HexPubkey): Uint8Array {
  if (!(secretKey instanceof Uint8Array)) {
    throw new TypeError('[NIP-44] secretKey must be Uint8Array')
  }
  if (secretKey.length !== 32) {
    throw new TypeError('[NIP-44] secretKey must be 32 bytes')
  }
  return nip44.getConversationKey(secretKey, theirPubkey)
}

/**
 * Encrypt plaintext with NIP-44
 */
export function encrypt(plaintext: string, conversationKey: Uint8Array): string {
  return nip44.encrypt(plaintext, conversationKey)
}

/**
 * Decrypt ciphertext with NIP-44
 */
export function decrypt(ciphertext: string, conversationKey: Uint8Array): string {
  return nip44.decrypt(ciphertext, conversationKey)
}

/**
 * Convert Uint8Array to hex string
 */
export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}

/**
 * Convert hex string to Uint8Array
 */
export function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new TypeError('[crypto] hex string must have even length')
  }
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16)
  }
  return bytes
}

/**
 * Generate random alphanumeric ID
 */
export function generateId(length = 16): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
  const arr = new Uint8Array(length)
  crypto.getRandomValues(arr)
  let id = ''
  for (let i = 0; i < length; i++) {
    id += chars[arr[i] % chars.length]
  }
  return id
}