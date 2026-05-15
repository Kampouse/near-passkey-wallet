/**
 * NostrConnect Handler
 * 
 * Handles nostrconnect:// URIs where:
 * 1. Another app generates a nostrconnect:// QR
 * 2. User scans with wallet
 * 3. Wallet sends encrypted response to relay
 * 4. Session established
 */

import * as nip44 from 'nostr-tools/nip44'
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure'
import { SimplePool } from 'nostr-tools/pool'

const KIND_BUNKER = 24133
const NOSTR_SESSION_KEY = 'nostr_session_key'

/**
 * Parse nostrconnect:// URI
 * Returns { clientPubkey, relays, secret, perms, metadata }
 */
export function parseNostrConnectUri(uri) {
  try {
    if (!uri.startsWith('nostrconnect://')) return null
    
    // nostrconnect://<client-pubkey>?relay=<relay1>&relay=<relay2>&secret=<secret>
    const url = new URL(uri)
    const clientPubkey = url.host // hostname is the client pubkey
    
    const relays = url.searchParams.getAll('relay')
    const secret = url.searchParams.get('secret')
    const perms = url.searchParams.get('perms')
    const name = url.searchParams.get('name')
    const url_param = url.searchParams.get('url')
    
    return {
      clientPubkey,
      relays: relays.length > 0 ? relays : ['wss://relay.primal.net'],
      secret,
      perms: perms ? perms.split(',') : [],
      metadata: { name, url: url_param }
    }
  } catch (e) {
    console.error('[NostrConnect] Failed to parse URI:', e)
    return null
  }
}

/**
 * Get or create a session keypair for Nostr signing
 * 
 * NOTE: This is a RANDOM keypair stored in localStorage, NOT derived from MPC.
 * MPC-derived Ed25519 keys cannot directly encrypt (need X25519 conversion with secret key).
 * For full security, would need MPC-to-X25519 key derivation.
 * 
 * @returns {{ secretKey: Uint8Array, pubkey: string }}
 */
export function getOrCreateSessionKeypair() {
  try {
    // Try to load existing session key
    const stored = localStorage.getItem(NOSTR_SESSION_KEY)
    if (stored) {
      const parsed = JSON.parse(stored)
      const sk = new Uint8Array(parsed.secretKey)
      const pubkey = parsed.pubkey
      return { secretKey: sk, pubkey }
    }
  } catch (e) {
    console.warn('[NostrConnect] Failed to load session key:', e)
  }
  
  // Generate new random keypair
  const sk = new Uint8Array(32)
  crypto.getRandomValues(sk)
  
  // Use nostr-tools getPublicKey
  const pubkey = getPublicKey(sk)
  
  // Store in localStorage
  localStorage.setItem(NOSTR_SESSION_KEY, JSON.stringify({
    secretKey: Array.from(sk),
    pubkey
  }))
  
  console.log('[NostrConnect] Generated new session key:', pubkey.slice(0, 16) + '...')
  return { secretKey: sk, pubkey }
}

// Helper: convert Uint8Array to hex string
function uint8ArrayToHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Handle nostrconnect pairing request
 * Sends an encrypted ACK response to relay
 * 
 * @param {object} params
 * @returns {Promise<{ success: boolean }>}
 */
export async function handleNostrConnectRequest(params) {
  const { clientPubkey, relays, secret, ourSecretKey, ourPubkey } = params
  
  // Log all inputs IMMEDIATELY
  console.log('[NostrConnect] ========== ENTRY ==========')
  console.log('[NostrConnect] params keys:', Object.keys(params || {}))
  console.log('[NostrConnect] ourSecretKey:', typeof ourSecretKey, ourSecretKey?.constructor?.name, 'len:', ourSecretKey?.length)
  console.log('[NostrConnect] ourPubkey:', typeof ourPubkey, 'len:', ourPubkey?.length, 'value:', ourPubkey?.slice(0, 16))
  console.log('[NostrConnect] clientPubkey:', typeof clientPubkey, 'len:', clientPubkey?.length, 'value:', clientPubkey?.slice(0, 16))
  
  // Validate ourSecretKey
  if (!(ourSecretKey instanceof Uint8Array)) {
    const err = new Error(`ourSecretKey must be Uint8Array, got ${typeof ourSecretKey} (${ourSecretKey?.constructor?.name})`)
    console.error('[NostrConnect] VALIDATION FAILED:', err.message)
    throw err
  }
  
  // Convert to hex string for getConversationKey (accepts hex)
  const secretKeyHex = uint8ArrayToHex(ourSecretKey)
  console.log('[NostrConnect] secretKeyHex:', typeof secretKeyHex, 'len:', secretKeyHex?.length, 'value:', secretKeyHex?.slice(0, 16))
  
  console.log('[NostrConnect] Handling pairing request from:', clientPubkey.slice(0, 16))
  console.log('[NostrConnect] Our pubkey:', ourPubkey.slice(0, 16))
  console.log('[NostrConnect] Relays:', relays)
  console.log('[NostrConnect] Passed ourSecretKey type:', ourSecretKey?.constructor?.name, 'len:', ourSecretKey?.length)
  console.log('[NostrConnect] Converted secretKeyHex type:', typeof secretKeyHex, 'len:', secretKeyHex?.length)
  
  // Validate clientPubkey is hex string
  if (typeof clientPubkey !== 'string' || clientPubkey.length !== 64) {
    throw new Error(`clientPubkey must be 64-char hex string, got: ${typeof clientPubkey} len=${clientPubkey?.length}`)
  }
  
  // Build response content (NIP-46 connect response)
  const response = {
    id: generateRequestId(),
    result: secret || 'ack',
    error: null
  }
  
  const pool = new SimplePool()
  
  try {
    // Encrypt response with NIP-44
    console.log('[NostrConnect] Encrypting response...')
    
    // TRACE: Type check immediately before nostr-tools calls
    console.log('[NostrConnect] TRACE: About to call nip44.getConversationKey')
    console.log('[NostrConnect] TRACE: secretKeyHex is string?', typeof secretKeyHex === 'string', 'value:', secretKeyHex?.slice(0, 16))
    console.log('[NostrConnect] TRACE: clientPubkey is string?', typeof clientPubkey === 'string', 'value:', clientPubkey?.slice(0, 16))
    
    let conversationKey
    try {
      conversationKey = nip44.getConversationKey(secretKeyHex, clientPubkey)
      console.log('[NostrConnect] conversationKey type:', conversationKey?.constructor?.name, 'len:', conversationKey?.length)
    } catch (e) {
      console.error('[NostrConnect] getConversationKey error:', e.message, e.stack)
      throw e
    }
    
    // TRACE: Type check before encrypt
    console.log('[NostrConnect] TRACE: About to call nip44.encrypt')
    console.log('[NostrConnect] TRACE: conversationKey is Uint8Array?', conversationKey instanceof Uint8Array, 'len:', conversationKey?.length)
    
    let encryptedContent
    try {
      encryptedContent = nip44.encrypt(JSON.stringify(response), conversationKey)
      console.log('[NostrConnect] encrypted content len:', encryptedContent?.length)
    } catch (e) {
      console.error('[NostrConnect] encrypt error:', e.message, e.stack)
      throw e
    }
    
    // TRACE: Type check before finalizeEvent
    console.log('[NostrConnect] TRACE: About to call finalizeEvent')
    console.log('[NostrConnect] TRACE: ourSecretKey is Uint8Array?', ourSecretKey instanceof Uint8Array, 'len:', ourSecretKey?.length)
    
    // Build kind 24133 event
    const eventTemplate = {
      kind: KIND_BUNKER,
      content: encryptedContent,
      tags: [['p', clientPubkey]],
      created_at: Math.floor(Date.now() / 1000),
      pubkey: ourPubkey,
    }
    
    // Sign event - finalizeEvent requires Uint8Array for private key
    console.log('[NostrConnect] Signing event...')
    console.log('[NostrConnect] ourSecretKey type:', typeof ourSecretKey, 'isArray:', Array.isArray(ourSecretKey), 'isUint8Array:', ourSecretKey instanceof Uint8Array)
    
    let signedEvent
    try {
      signedEvent = finalizeEvent(eventTemplate, ourSecretKey)
    } catch (e) {
      console.error('[NostrConnect] finalizeEvent error:', e.message, e.stack)
      throw e
    }  // Needs Uint8Array, not hex string
    
    console.log('[NostrConnect] Event ID:', signedEvent.id)
    console.log('[NostrConnect] Publishing to', relays.length, 'relays...')
    
    // Publish to all relays
    const results = await Promise.allSettled(
      relays.map(relay => pool.publish([relay], signedEvent))
    )
    
    const successCount = results.filter(r => r.status === 'fulfilled').length
    console.log('[NostrConnect] Published to', successCount, '/', relays.length, 'relays')
    
    return { success: successCount > 0, eventId: signedEvent.id }
    
  } catch (e) {
    console.error('[NostrConnect] Error:', e)
    throw e
  } finally {
    pool.close(relays)
  }
}

/**
 * Store approved app session
 */
export function storeApprovedApp(clientPubkey, metadata, perms) {
  try {
    const stored = JSON.parse(localStorage.getItem('nostr_approved_apps') || '{}')
    stored[clientPubkey] = {
      ...metadata,
      perms,
      approvedAt: Date.now()
    }
    localStorage.setItem('nostr_approved_apps', JSON.stringify(stored))
  } catch (e) {
    console.error('[NostrConnect] Failed to store approved app:', e)
  }
}

/**
 * Get approved apps
 */
export function getApprovedApps() {
  try {
    return JSON.parse(localStorage.getItem('nostr_approved_apps') || '{}')
  } catch (e) {
    return {}
  }
}

// Helper
function generateRequestId(len = 16) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
  let id = ''
  const arr = new Uint8Array(len)
  crypto.getRandomValues(arr)
  for (let i = 0; i < len; i++) id += chars[arr[i] % chars.length]
  return id
}