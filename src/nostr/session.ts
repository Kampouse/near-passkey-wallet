/**
 * Session Key Management
 * 
 * Manages Nostr session keypairs stored in localStorage.
 * Each session is a random Ed25519 keypair used for NIP-44 encryption.
 */

import { getPublicKey } from 'nostr-tools/pure'
import type { SessionKeypair, HexPubkey, ApprovedApp } from './types'

const STORAGE_KEY = 'nostr_session_key'
const APPROVED_APPS_KEY = 'nostr_approved_apps'

/**
 * Get or create a session keypair for Nostr signing.
 *
 * With `seed` (passkey PRF output): the key is HKDF-derived from the passkey
 * material — deterministic, same npub on every device holding the passkey.
 * The derived key is cached in localStorage so the bunker can start without
 * a fresh FaceID ceremony; the cache is re-derivable and NOT the root of trust.
 * Without seed: falls back to a random keypair (per-browser identity).
 */
export function getOrCreateSessionKeypair(seed?: Uint8Array): SessionKeypair {
  if (!seed) {
    try {
      const stored = localStorage.getItem(STORAGE_KEY)
      if (stored) {
        const data = JSON.parse(stored)
        const secretKey = new Uint8Array(data.secretKey)
        console.log('[Session] Loaded existing session key:', data.pubkey.slice(0, 16) + '...')
        return { secretKey, pubkey: data.pubkey }
      }
    } catch (err) {
      console.warn('[Session] Failed to load session key:', err)
    }

    // Generate new random keypair
    const secretKey = new Uint8Array(32)
    crypto.getRandomValues(secretKey)
    const pubkey = getPublicKey(secretKey)

    // Store in localStorage
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      secretKey: Array.from(secretKey),
      pubkey,
    }))

    console.log('[Session] Created new session key:', pubkey.slice(0, 16) + '...')
    return { secretKey, pubkey }
  }

  // PRF path: HKDF(seed) → 32-byte nostr secret. Synchronous wrapper over
  // deriveBits is impossible, so callers use getOrCreateSessionKeypairAsync.
  throw new Error('use getOrCreateSessionKeypairAsync for PRF-derived keys')
}

/**
 * PRF-aware variant. Seed → HKDF-SHA256 → nostr secret (cached in localStorage).
 */
export async function getOrCreateSessionKeypairAsync(seed?: Uint8Array): Promise<SessionKeypair> {
  if (!seed) return getOrCreateSessionKeypair()

  const key = await crypto.subtle.importKey('raw', seed as BufferSource, 'HKDF', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new TextEncoder().encode('near-bunker-nostr-v1'),
      info: new TextEncoder().encode('bunker-session-key'),
    },
    key,
    256,
  )
  const secretKey = new Uint8Array(bits)
  const pubkey = getPublicKey(secretKey)
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ secretKey: Array.from(secretKey), pubkey }))
  console.log('[Session] PRF-derived session key:', pubkey.slice(0, 16) + '...')
  return { secretKey, pubkey }
}

/**
 * Clear the session keypair from localStorage
 */
export function clearSessionKeypair(): void {
  localStorage.removeItem(STORAGE_KEY)
  console.log('[Session] Cleared session key')
}

/**
 * Check if a session keypair exists
 */
export function hasSessionKeypair(): boolean {
  return localStorage.getItem(STORAGE_KEY) !== null
}

/**
 * Store approved app metadata
 */
export function storeApprovedApp(
  clientPubkey: HexPubkey,
  metadata: { name?: string; url?: string },
  perms: string[]
): void {
  try {
    const stored = JSON.parse(localStorage.getItem(APPROVED_APPS_KEY) || '{}') as Record<string, ApprovedApp>
    stored[clientPubkey] = {
      ...metadata,
      perms,
      approvedAt: Date.now(),
    }
    localStorage.setItem(APPROVED_APPS_KEY, JSON.stringify(stored))
  } catch (err) {
    console.error('[Session] Failed to store approved app:', err)
  }
}

/**
 * Get all approved apps
 */
export function getApprovedApps(): Record<string, ApprovedApp> {
  try {
    return JSON.parse(localStorage.getItem(APPROVED_APPS_KEY) || '{}')
  } catch {
    return {}
  }
}