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

// ─── Constants ──────────────────────────────────────────────────────

const KIND_BUNKER_REQUEST = 24133
const DEFAULT_RELAYS = [
  'wss://relay.primal.net',
  'wss://nos.lol',
  'wss://relay.damus.io',
]

// ─── NIP-46 Bunker Class ─────────────────────────────────────────────

export class Nip46Bunker {
  constructor(options = {}) {
    this.relays = options.relays || DEFAULT_RELAYS
    this.npub = options.npub
    this.pubkey = options.pubkey // hex
    this.accountId = options.accountId
    this.signFn = options.signFn // async (messageHash) => signature
    this.onRequest = options.onRequest // (request) => void - show approval UI
    
    this.pool = null
    this.subscription = null
    this.sessionKeys = new Map() // clientPubkey -> sharedKey
  }

  /**
   * Connect to relays and listen for NIP-46 requests
   */
  async start() {
    // Import SimplePool dynamically (browser-compatible)
    const { SimplePool } = await import('nostr-tools/pool')
    this.pool = new SimplePool()
    
    // Subscribe to kind 24133 events tagged with our pubkey
    const filter = {
      kinds: [KIND_BUNKER_REQUEST],
      '#p': [this.pubkey],
      since: Math.floor(Date.now() / 1000) - 60, // 60s lookback
    }
    
    this.subscription = this.pool.subscribeMany(
      this.relays,
      filter,
      {
        onevent: (event) => this.handleEvent(event),
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
    console.log('[NIP-46] Received event:', event.id.slice(0, 8))
    
    try {
      // Decrypt the request content (NIP-44)
      const decrypted = await this.decryptRequest(event)
      if (!decrypted) {
        console.log('[NIP-46] Failed to decrypt request')
        return
      }
      
      const { method, params, id } = this.parseRequest(decrypted)
      console.log('[NIP-46] Method:', method, 'params:', params)
      
      // Handle different methods
      let result
      switch (method) {
        case 'connect':
          result = await this.handleConnect(event.pubkey, params)
          break
        case 'get_public_key':
          result = this.pubkey
          break
        case 'sign_event':
          result = await this.handleSignEvent(event.pubkey, params)
          break
        case 'nip44_encrypt':
          result = await this.handleNip44Encrypt(event.pubkey, params)
          break
        case 'nip44_decrypt':
          result = await this.handleNip44Decrypt(event.pubkey, params)
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
      await this.sendErrorResponse(event, err.message)
    }
  }

  /**
   * Parse decrypted request内容
   */
  parseRequest(content) {
    // Format: ["method", "pubkey", ...params]
    const parsed = JSON.parse(content)
    return {
      method: parsed[0],
      pubkey: parsed[1],
      params: parsed.slice(2) || [],
      id: parsed[1], // Use pubkey as request ID for simplicity
    }
  }

  /**
   * Handle connect request
   */
  async handleConnect(clientPubkey, params) {
    // Store session
    const secret = params[1] // optional secret
    this.sessionKeys.set(clientPubkey, { secret })
    
    // Request approval from user
    if (this.onRequest) {
      const approved = await this.onRequest({
        method: 'connect',
        client: clientPubkey,
        message: 'App wants to connect to your wallet',
      })
      if (!approved) {
        throw new Error('Connection denied')
      }
    }
    
    return 'ack'
  }

  /**
   * Handle sign_event request
   */
  async handleSignEvent(clientPubkey, params) {
    const eventJson = JSON.parse(params[0])
    
    // Request approval from user
    if (this.onRequest) {
      const approved = await this.onRequest({
        method: 'sign_event',
        client: clientPubkey,
        kind: eventJson.kind,
        content: eventJson.content?.slice(0, 100),
        message: `Sign ${this.getEventTypeName(eventJson.kind)}?`,
      })
      if (!approved) {
        throw new Error('Signing denied')
      }
    }
    
    // Compute event ID
    const eventId = await this.computeEventId(eventJson)
    
    // Sign with MPC via passkey
    const signature = await this.signFn(eventId)
    
    // Return signed event
    eventJson.id = eventId
    eventJson.sig = signature
    eventJson.pubkey = this.pubkey
    
    return JSON.stringify(eventJson)
  }

  /**
   * Handle nip44_encrypt request
   */
  async handleNip44Encrypt(clientPubkey, params) {
    const targetPubkey = params[0]
    const plaintext = params[1]
    
    // Get conversation key
    const sharedKey = await this.getSharedSecret(targetPubkey)
    const conversationKey = nip44.v2.utils.getConversationKey(this.privKey, targetPubkey)
    
    // Encrypt
    const ciphertext = nip44.v2.encrypt(plaintext, conversationKey)
    return ciphertext
  }

  /**
   * Handle nip44_decrypt request
   */
  async handleNip44Decrypt(clientPubkey, params) {
    const senderPubkey = params[0]
    const ciphertext = params[1]
    
    // Get conversation key
    const conversationKey = nip44.v2.utils.getConversationKey(this.privKey, senderPubkey)
    
    // Decrypt
    const plaintext = nip44.v2.decrypt(ciphertext, conversationKey)
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
  async sendErrorResponse(requestEvent, error) {
    const response = {
      id: requestEvent.pubkey,
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
   * Sign a Nostr event using MPC
   */
  async signEvent(event) {
    const eventId = await this.computeEventId(event)
    const signature = await this.signFn(eventId)
    
    event.id = eventId
    event.sig = signature
    event.pubkey = this.pubkey
    
    return event
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
   * Override this to use MPC for decryption
   */
  async decryptRequest(event) {
    // For MVP, we'll need Ed25519 private key from MPC
    // This is a placeholder - implement Ed25519 decryption with MPC
    try {
      // Note: This requires Ed25519 private key from MPC path 'nostr,1'
      // For now, return the content as-is for testing
      console.log('[NIP-46] Would decrypt:', event.content.slice(0, 50))
      return event.content // Placeholder
    } catch (err) {
      console.error('[NIP-46] Decrypt error:', err)
      return null
    }
  }

  /**
   * Encrypt outgoing response (NIP-44)
   */
  async encryptResponse(targetPubkey, content) {
    // For MVP, return content as-is
    // Implement Ed25519 encryption with MPC
    console.log('[NIP-46] Would encrypt to:', targetPubkey.slice(0, 16))
    return content
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