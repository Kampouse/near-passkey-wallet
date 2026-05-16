/**
 * Session Key Management
 * 
 * Manages Nostr session keypairs stored in localStorage.
 * Each session is a random Ed25519 keypair used for NIP-44 encryption.
 */

import { getPublicKey } from 'nostr-tools/pure'
import { toHex } from './crypto'
import type { SessionKeypair, HexPubkey, ApprovedApp } from './types'

const STORAGE_KEY = 'nostr_session_key'
const APPROVED_APPS_KEY = 'nostr_approved_apps'

/**
 * Get or create a session keypair for Nostr signing
 */
export function getOrCreateSessionKeypair(): SessionKeypair {
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