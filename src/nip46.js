/**
 * NIP-46 Bunker Implementation for Passkey Wallet
 * 
 * The wallet acts as a bunker that:
 * 1. Derives Nostr pubkey from NEAR MPC (path: 'nostr,1')
 * 2. Subscribes to kind 24133 events on relays
 * 3. Shows approval UI when sign requests arrive
 * 4. Signs with FaceID via MPC
 * 5. Returns signature via kind 24133 response
 */

import * as nip44 from 'nostr-tools/nip44'
import { bytesToHex, hexToBytes } from 'nostr-tools/utils'
import { finalizeEvent } from 'nostr-tools/pure'
import { SimplePool } from 'nostr-tools/pool'

// ─── Constants ──────────────────────────────────────────────────────

const KIND_BUNKER_REQUEST = 24133
const DEFAULT_RELAYS = [
  'wss://relay.primal.net',
  'wss://nos.lol',
  'wss://relay.damus.io',
]

// ─── NIP-46 Bunker Class ─────────────────────────────────────────────

// Helper: convert Uint8Array to hex string
function uint8ArrayToHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')
}

export class Nip46Bunker {
  constructor(options = {}) {
    this.relays = options.relays || DEFAULT_RELAYS
    this.npub = options.npub
    this.pubkey = options.pubkey // hex
    this.accountId = options.accountId
    this.signFn = options.signFn // async (messageHash) => signature
    this.onRequest = options.onRequest // (request) => void - show approval UI
    
    // Convert Uint8Array to hex string if needed (nostr-tools expects hex)
    const sk = options.sessionSecretKey
    
    // Validate input is Uint8Array
    if (sk && !(sk instanceof Uint8Array)) {
      console.error('[NIP-46] sessionSecretKey is NOT Uint8Array, got:', typeof sk, sk?.constructor?.name)
      throw new Error('sessionSecretKey must be Uint8Array')
    }
    
    this.sessionSecretKey = sk // Keep original for finalizeEvent (must be Uint8Array)
    this.sessionSecretKeyHex = sk ? uint8ArrayToHex(sk) : null
    
    console.log('[NIP-46] Bunker constructed with session key len:', sk?.length, 'hexLen:', this.sessionSecretKeyHex?.length)
    
    this.pool = null
    this.subscription = null
    this.sessionKeys = new Map() // clientPubkey -> sharedKey
    this.pendingRequests = new Map() // requestId -> { resolve, reject }
  }

  /**
   * Connect to relays and listen for NIP-46 requests
   */
  async start() {
    this.pool = new SimplePool()
    
    // Subscribe to kind 24133 events tagged with our pubkey
    // Filter: requests TO us (p-tag = our pubkey, from = someone else)
    // Skip responses FROM us (pubkey = our pubkey but p-tag = client)
    // Use moderate lookback (15s) to catch requests that arrive during startup
    const filter = {
      kinds: [KIND_BUNKER_REQUEST],
      '#p': [this.pubkey],
      since: Math.floor(Date.now() / 1000) - 15, // 15s lookback
    }
    
    this.subscription = this.pool.subscribeMany(
      this.relays,
      filter,
      {
        onevent: (event) => {
          // Only process incoming requests, skip our own responses
          if (event.pubkey === this.pubkey) {
            console.log('[NIP-46] Skipping our own event:', event.id.slice(0, 8))
            return
          }
          this.handleEvent(event)
        },
        oneose: () => console.log('[NIP-46] Subscription ready'),
      }
    )
    
    console.log('[NIP-46] Bunker started, listening for requests on:', this.relays)
    return this.npub // Return our npub for pairing
  }

  /**
   * Stop listening and disconnect
   */
  stop() {
    if (this.subscription) {
      this.subscription.close()
      this.subscription = null
    }
    if (this.pool) {
      this.pool.close(this.relays)
      this.pool = null
    }
  }

  /**
   * Create bunker:// URI for pairing
   */
  createBunkerUri(secret = '') {
    const relayParams = this.relays.map(r => `relay=${encodeURIComponent(r)}`).join('&')
    let uri = `bunker://${this.npub}?${relayParams}`
    if (secret) {
      uri += `&secret=${encodeURIComponent(secret)}`
    }
    return uri
  }

  /**
   * Handle incoming NIP-46 request event
   */
  async handleEvent(event) {
    console.log('[NIP-46] Received event:', event.id.slice(0, 8), 'from:', event.pubkey.slice(0, 16))
    
    let requestId = 'unknown' // Hoisted for error handling
    
    try {
      // Decrypt the request content (NIP-44)
      console.log('[NIP-46] Decrypting request...')
      let decrypted
      try {
        decrypted = await this.decryptRequest(event)
      } catch (decryptErr) {
        console.error('[NIP-46] decryptRequest threw:', decryptErr.message, decryptErr.stack)
        throw decryptErr
      }
      if (!decrypted) {
        console.log('[NIP-46] Failed to decrypt request')
        return
      }
      
      console.log('[NIP-46] Decrypted:', decrypted.slice(0, 100))
      
      let parsed
      try {
        parsed = this.parseRequest(decrypted)
      } catch (parseErr) {
        console.error('[NIP-46] parseRequest threw:', parseErr.message, parseErr.stack)
        throw parseErr
      }
      
      const { method, params, id } = parsed
      requestId = id // Save for error handling
      console.log('[NIP-46] Method:', method, 'id:', id, 'params:', params)
      
      // Get client pubkey from event
      const clientPubkey = event.pubkey
      
      // Auto-approve safe read-only methods
      const autoApprove = ['get_public_key', 'ping'].includes(method)
      
      if (autoApprove) {
        console.log('[NIP-46] Auto-approving:', method)
        // Handle immediately without user confirmation
        try {
          let result
          switch (method) {
            case 'get_public_key':
              result = this.pubkey
              break
            case 'ping':
              result = 'pong'
              break
          }
          await this.sendResponse(event, id, result)
          console.log('[NIP-46] Auto-approved response sent for:', method)
          return
        } catch (err) {
          console.error('[NIP-46] Auto-approve error:', err)
          await this.sendErrorResponse(event, id, err.message)
          return
        }
      }
      
      // Create pending request and wait for approval
      const requestId = `${event.id}-${Date.now()}`
      const requestPromise = new Promise((resolve, reject) => {
        this.pendingRequests.set(requestId, { resolve, reject })
      })
      
      // Show approval UI
      if (this.onRequest) {
        this.onRequest({
          id: requestId,
          method,
          params,
          clientPubkey,
          event,
        })
      }
      
      // Wait for user approval
      const approved = await requestPromise
      
      if (!approved) {
        await this.sendErrorResponse(event, id, 'Request denied by user')
        return
      }
      
      // Handle different methods
      let result
      switch (method) {
        case 'connect':
          result = await this.handleConnect(clientPubkey, params)
          break
        case 'get_public_key':
          result = this.pubkey
          break
        case 'sign_event':
          result = await this.handleSignEvent(clientPubkey, params)
          break
        case 'nip44_encrypt':
          result = await this.handleNip44Encrypt(clientPubkey, params)
          break
        case 'nip44_decrypt':
          result = await this.handleNip44Decrypt(clientPubkey, params)
          break
        case 'ping':
          result = 'pong'
          break
        default:
          throw new Error(`Unknown method: ${method}`)
      }
      
      // Send response
      await this.sendResponse(event, id, result)
      
    } catch (err) {
      console.error('[NIP-46] Error handling event:', err)
      // Send error response
      await this.sendErrorResponse(event, requestId, err.message)
    }
  }
  
  /**
   * Approve a pending request (called from UI)
   */
  approveRequest(requestId) {
    const pending = this.pendingRequests.get(requestId)
    if (pending) {
      pending.resolve(true)
      this.pendingRequests.delete(requestId)
    }
  }
  
  /**
   * Deny a pending request (called from UI)
   */
  denyRequest(requestId) {
    const pending = this.pendingRequests.get(requestId)
    if (pending) {
      pending.resolve(false)
      this.pendingRequests.delete(requestId)
    }
  }

  /**
   * Parse decrypted request内容
   */
  parseRequest(content) {
    const parsed = JSON.parse(content)
    
    // Handle object format: {"id": "...", "method": "...", "params": [...]}
    if (parsed.id && parsed.method) {
      return {
        id: parsed.id,
        method: parsed.method,
        params: Array.isArray(parsed.params) ? parsed.params : [parsed.params],
        pubkey: parsed[1] || null,
      }
    }
    
    // Handle array format: ["method", "pubkey", ...params]
    return {
      method: parsed[0],
      pubkey: parsed[1],
      params: parsed.slice(2) || [],
      id: parsed[1], // Fallback for legacy format
    }
  }

  /**
   * Handle connect request
   */
  async handleConnect(clientPubkey, params) {
    // Store session
    const secret = params[1] // optional secret
    this.sessionKeys.set(clientPubkey, { secret })
    return 'ack'
  }

  /**
   * Handle sign_event request
   */
  async handleSignEvent(clientPubkey, params) {
    const eventJson = JSON.parse(params[0])
    
    if (!this.sessionSecretKey) {
      throw new Error('No session key available for signing')
    }
    
    // Build event template for finalizeEvent
    const eventTemplate = {
      kind: eventJson.kind,
      content: eventJson.content || '',
      created_at: eventJson.created_at || Math.floor(Date.now() / 1000),
      tags: eventJson.tags || [],
    }
    
    // Sign with session key
    const signedEvent = finalizeEvent(eventTemplate, this.sessionSecretKey)
    
    return JSON.stringify(signedEvent)
  }

  /**
   * Handle nip44_encrypt request
   */
  async handleNip44Encrypt(clientPubkey, params) {
    const targetPubkey = params[0]
    const plaintext = params[1]
    
    if (!this.sessionSecretKey) {
      throw new Error('No session key available for encryption')
    }
    
    // Get conversation key using our session secret key hex (getConversationKey expects hex string)
    const conversationKey = nip44.getConversationKey(this.sessionSecretKeyHex, targetPubkey)
    
    // Encrypt
    const ciphertext = nip44.encrypt(plaintext, conversationKey)
    return ciphertext
  }

  /**
   * Handle nip44_decrypt request
   */
  async handleNip44Decrypt(clientPubkey, params) {
    const senderPubkey = params[0]
    const ciphertext = params[1]
    
    if (!this.sessionSecretKey) {
      throw new Error('No session key available for decryption')
    }
    
    // Get conversation key using our session secret key hex (getConversationKey expects hex string)
    const conversationKey = nip44.getConversationKey(this.sessionSecretKeyHex, senderPubkey)
    
    // Decrypt
    const plaintext = nip44.decrypt(ciphertext, conversationKey)
    return plaintext
  }

  /**
   * Send response event
   */
  async sendResponse(requestEvent, id, result) {
    const response = {
      id,
      result,
    }
    
    // Encrypt response with NIP-44
    const ciphertext = await this.encryptResponse(requestEvent.pubkey, JSON.stringify(response))
    
    // Build response event
    const event = {
      kind: KIND_BUNKER_REQUEST,
      pubkey: this.pubkey,
      created_at: Math.floor(Date.now() / 1000),
      content: ciphertext,
      tags: [
        ['p', requestEvent.pubkey],
        ['e', requestEvent.id],
      ],
    }
    
    // Sign and publish
    const signedEvent = await this.signEvent(event)
    await this.pool.publish(this.relays, signedEvent)
    
    console.log('[NIP-46] Response sent:', id)
  }

  /**
   * Send error response
   */
  async sendErrorResponse(requestEvent, id, error) {
    const response = {
      id,
      error,
    }
    
    const ciphertext = await this.encryptResponse(requestEvent.pubkey, JSON.stringify(response))
    
    const event = {
      kind: KIND_BUNKER_REQUEST,
      pubkey: this.pubkey,
      created_at: Math.floor(Date.now() / 1000),
      content: ciphertext,
      tags: [
        ['p', requestEvent.pubkey],
        ['e', requestEvent.id],
      ],
    }
    
    const signedEvent = await this.signEvent(event)
    await this.pool.publish(this.relays, signedEvent)
  }

  /**
   * Compute Nostr event ID (SHA-256 of serialized event)
   */
  async computeEventId(event) {
    const serialized = JSON.stringify([
      0,
      event.pubkey,
      event.created_at,
      event.kind,
      event.tags || [],
      event.content || '',
    ])
    
    const encoder = new TextEncoder()
    const data = encoder.encode(serialized)
    const hashBuffer = await crypto.subtle.digest('SHA-256', data)
    const hashArray = new Uint8Array(hashBuffer)
    return bytesToHex(hashArray)
  }

  /**
   * Sign a Nostr event using session key
   */
  async signEvent(event) {
    if (!this.sessionSecretKey) {
      throw new Error('No session key available for signing')
    }
    
    // Build event template for finalizeEvent
    const eventTemplate = {
      kind: event.kind,
      content: event.content,
      created_at: event.created_at,
      tags: event.tags,
    }
    
    // finalizeEvent adds id, pubkey, and sig
    const signedEvent = finalizeEvent(eventTemplate, this.sessionSecretKey)
    
    return signedEvent
  }

  /**
   * Get event type name for user approval
   */
  getEventTypeName(kind) {
    const names = {
      0: 'Profile',
      1: 'Note',
      3: 'Follow',
      4: 'DM',
      5: 'Delete',
      6: 'Repost',
      7: 'Reaction',
      16: 'Generic Repost',
      42: 'Channel Message',
      30023: 'Long Form Content',
    }
    return names[kind] || `Kind ${kind}`
  }

  /**
   * Decrypt incoming request (NIP-44)
   */
  async decryptRequest(event) {
    if (!this.sessionSecretKeyHex) {
      console.error('[NIP-46] No session key hex - cannot decrypt')
      return null
    }
    
    try {
      console.log('[NIP-46] decryptRequest: starting...')
      const clientPubkey = event.pubkey
      console.log('[NIP-46] decryptRequest: clientPubkey:', clientPubkey.slice(0, 16))
      console.log('[NIP-46] decryptRequest: sessionSecretKeyHex len:', this.sessionSecretKeyHex?.length)
      
      // Step 1: Get conversation key
      console.log('[NIP-46] decryptRequest: calling getConversationKey...')
      console.log('[NIP-46] sessionSecretKeyHex type:', typeof this.sessionSecretKeyHex, 'len:', this.sessionSecretKeyHex?.length)
      console.log('[NIP-46] clientPubkey type:', typeof clientPubkey, 'len:', clientPubkey?.length)
      
      let conversationKey
      try {
        conversationKey = nip44.getConversationKey(this.sessionSecretKeyHex, clientPubkey)
        console.log('[NIP-46] decryptRequest: got conversation key type:', conversationKey?.constructor?.name, 'len:', conversationKey?.length)
      } catch (e) {
        console.error('[NIP-46] getConversationKey FAILED:', e.message, e.stack)
        throw e
      }
      
      // Step 2: Decrypt content
      console.log('[NIP-46] decryptRequest: calling nip44.decrypt...')
      console.log('[NIP-46] decryptRequest: event.content length:', event.content?.length)
      let decrypted
      try {
        decrypted = nip44.decrypt(event.content, conversationKey)
        console.log('[NIP-46] Decrypted request:', decrypted.slice(0, 100))
      } catch (e) {
        console.error('[NIP-46] nip44.decrypt FAILED:', e.message, e.stack)
        throw e
      }
      
      return decrypted
    } catch (err) {
      console.error('[NIP-46] Decrypt error:', err.message, err.stack)
      return null
    }
  }

  /**
   * Encrypt outgoing response (NIP-44)
   */
  async encryptResponse(targetPubkey, content) {
    if (!this.sessionSecretKeyHex) {
      console.error('[NIP-46] No session key hex - cannot encrypt')
      return content
    }
    
    try {
      const conversationKey = nip44.getConversationKey(this.sessionSecretKeyHex, targetPubkey)
      const encrypted = nip44.encrypt(content, conversationKey)
      console.log('[NIP-46] Encrypted response for:', targetPubkey.slice(0, 16))
      return encrypted
    } catch (err) {
      console.error('[NIP-46] Encrypt error:', err)
      return content
    }
  }

  /**
   * Get shared secret for NIP-44
   */
  async getSharedSecret(targetPubkey) {
    // Ed25519 X25519 key exchange
    // Requires MPC to compute shared secret
    return null
  }
}

/**
 * Convert npub to hex pubkey
 */
export function npubToHex(npub) {
  if (!npub.startsWith('npub1')) return npub
  
  const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'
  const data = npub.slice(5) // remove 'npub1'
  
  // Skip checksum (last 6 chars)
  const dataPart = data.slice(0, -6)
  
  let acc = 0n
  let bits = 0
  const bytes = []
  
  for (const char of dataPart) {
    const idx = CHARSET.indexOf(char)
    if (idx === -1) continue
    
    acc = (acc << 5n) | BigInt(idx)
    bits += 5
    
    while (bits >= 8) {
      bits -= 8
      bytes.push(Number((acc >> BigInt(bits)) & 0xffn))
    }
  }
  
  return bytes.map(b => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Convert hex pubkey to npub (bech32)
 */
export function hexToNpub(hex) {
  if (hex.startsWith('npub')) return hex
  
  const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'
  const bytes = hexToBytes(hex)
  
  // Convert 8-bit to 5-bit
  const fiveBit = []
  let acc = 0, bits = 0
  for (let i = 0; i < bytes.length; i++) {
    acc = (acc << 8) | bytes[i]
    bits += 8
    while (bits >= 5) {
      bits -= 5
      fiveBit.push((acc >> bits) & 31)
    }
  }
  if (bits > 0) {
    fiveBit.push((acc << (5 - bits)) & 31)
  }
  
  // Checksum
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]
  let chk = 1
  const values = [
    ...'npub'.split('').map(c => c.charCodeAt(0) >> 5),
    0,
    ...'npub'.split('').map(c => c.charCodeAt(0) & 31),
    ...fiveBit,
    0, 0, 0, 0, 0, 0,
  ]
  for (const v of values) {
    const b = chk >> 25
    chk = ((chk & 0x1ffffff) << 5) ^ v
    for (let i = 0; i < 5; i++) {
      if ((b >> i) & 1) chk ^= GEN[i]
    }
  }
  
  const checksum = []
  for (let i = 0; i < 6; i++) {
    checksum.push((chk >> (5 * (5 - i))) & 31)
  }
  
  const combined = [...fiveBit, ...checksum]
  return 'npub1' + combined.map(v => CHARSET[v]).join('')
}