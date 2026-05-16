/**
 * NIP-46 Bunker Implementation
 * 
 * The wallet acts as a bunker that responds to NIP-46 requests.
 */

// @ts-ignore - nostr-tools subpath imports work at runtime
import * as nip44 from 'nostr-tools/nip44'
// @ts-ignore
import { finalizeEvent } from 'nostr-tools/pure'
// @ts-ignore
import { SimplePool } from 'nostr-tools/pool'
import { KIND_BUNKER, DEFAULT_RELAYS, AUTO_APPROVE_METHODS, type BunkerOptions, type Nip46Event, type PendingRequest, type HexPubkey, type SecretKey } from './types'
import { generateId, toHex } from './crypto'

type PendingCallback = {
  resolve: (approved: boolean) => void
  reject: (err: Error) => void
}

/**
 * NIP-46 Bunker
 * 
 * Listens for NIP-46 requests and responds to them.
 */
export class Nip46Bunker {
  relays: string[]
  pubkey: HexPubkey
  npub: string
  sessionSecretKey: SecretKey | null
  accountId?: string
  signFn?: (messageHash: Uint8Array) => Promise<Uint8Array>
  onRequest?: (request: PendingRequest) => void
  
  // @ts-ignore - nostr-tools subpath imports work at runtime
  private _pool: InstanceType<typeof SimplePool> | null = null
  // @ts-ignore
  private _subscription: any = null
  private _pendingRequests: Map<string, PendingCallback> = new Map()

  constructor(options: BunkerOptions) {
    this.relays = options.relays || [...DEFAULT_RELAYS]
    this.pubkey = options.pubkey
    this.npub = options.npub
    this.accountId = options.accountId
    
    // Validate session key
    const sk = options.sessionSecretKey
    if (sk && !(sk instanceof Uint8Array)) {
      throw new TypeError('[NIP-46] sessionSecretKey must be Uint8Array')
    }
    if (sk && sk.length !== 32) {
      throw new TypeError('[NIP-46] sessionSecretKey must be 32 bytes')
    }
    
    this.sessionSecretKey = sk || null
    this.signFn = options.signFn
    this.onRequest = options.onRequest
    
    console.log('[NIP-46] Bunker created with pubkey:', this.pubkey?.slice(0, 16))
  }

  /**
   * Start listening for NIP-46 requests
   */
  async start(): Promise<string> {
    console.log('[NIP-46] Starting bunker...')
    console.log('[NIP-46] Pubkey:', this.pubkey?.slice(0, 16))
    console.log('[NIP-46] Relays:', this.relays)
    
    this._pool = new SimplePool()
    
    // Subscribe to kind 24133 events addressed to us
    const filter = {
      kinds: [KIND_BUNKER],
      '#p': [this.pubkey],
      since: Math.floor(Date.now() / 1000) - 15,
    }
    
    console.log('[NIP-46] Filter:', JSON.stringify(filter))
    
    this._subscription = this._pool.subscribeMany(
      this.relays,
      filter,
      {
        onevent: (event: Nip46Event) => {
          // Skip our own events (responses)
          if (event.pubkey === this.pubkey) {
            console.log('[NIP-46] Skipping own event:', event.id.slice(0, 8))
            return
          }
          this.handleEvent(event)
        },
        oneose: () => {
          console.log('[NIP-46] EOSE - listening for requests')
        },
      }
    )
    
    console.log('[NIP-46] Bunker started')
    return this.npub
  }

  /**
   * Stop listening and disconnect
   */
  stop(): void {
    if (this._subscription) {
      this._subscription.close()
      this._subscription = null
    }
    if (this._pool) {
      this._pool.close(this.relays)
      this._pool = null
    }
    console.log('[NIP-46] Bunker stopped')
  }

  /**
   * Create bunker:// URI for pairing
   */
  createBunkerUri(secret = ''): string {
    const relayParams = this.relays
      .map(r => `relay=${encodeURIComponent(r)}`)
      .join('&')
    let uri = `bunker://${this.npub}?${relayParams}`
    if (secret) {
      uri += `&secret=${encodeURIComponent(secret)}`
    }
    return uri
  }

  /**
   * Handle incoming NIP-46 event
   */
  async handleEvent(event: Nip46Event): Promise<void> {
    console.log('[NIP-46] Event:', event.id.slice(0, 8), 'from:', event.pubkey.slice(0, 16))
    
    let requestId = 'unknown'
    
    try {
      // Decrypt request
      const decrypted = await this.decryptRequest(event)
      if (!decrypted) {
        console.log('[NIP-46] Failed to decrypt')
        return
      }
      
      console.log('[NIP-46] Decrypted:', decrypted.slice(0, 100))
      
      // Parse request
      const parsed = this.parseRequest(decrypted)
      const { method, params, id } = parsed
      requestId = id
      
      console.log('[NIP-46] Method:', method, 'id:', id)
      
      // Auto-approve safe methods
      if ((AUTO_APPROVE_METHODS as readonly string[]).includes(method)) {
        console.log('[NIP-46] Auto-approving:', method)
        const result = await this.handleMethod(method, params, event.pubkey)
        await this.sendResponse(event, id, result)
        return
      }
      
      // Create pending request for user approval
      const pendingId = `${event.id}-${Date.now()}`
      const requestPromise = new Promise<boolean>((resolve, reject) => {
        this._pendingRequests.set(pendingId, { resolve, reject })
      })
      
      // Show approval UI
      if (this.onRequest) {
        this.onRequest({
          id: pendingId,
          method,
          params,
          clientPubkey: event.pubkey,
          event,
        })
      }
      
      // Wait for user decision
      const approved = await requestPromise
      
      if (!approved) {
        await this.sendErrorResponse(event, id, 'Request denied by user')
        return
      }
      
      // Handle method
      const result = await this.handleMethod(method, params, event.pubkey)
      await this.sendResponse(event, id, result)
      
    } catch (err: any) {
      console.error('[NIP-46] Error:', err)
      await this.sendErrorResponse(event, requestId, err.message)
    }
  }

  /**
   * Parse decrypted request content
   */
  parseRequest(content: string): { id: string; method: string; params: string[] } {
    const parsed = JSON.parse(content)
    
    // Object format: {id, method, params}
    if (parsed.id && parsed.method) {
      return {
        id: parsed.id,
        method: parsed.method,
        params: Array.isArray(parsed.params) ? parsed.params : [parsed.params],
      }
    }
    
    // Array format: [method, pubkey, ...params]
    return {
      id: parsed[1] || 'unknown',
      method: parsed[0],
      params: parsed.slice(2),
    }
  }

  /**
   * Handle NIP-46 method
   */
  async handleMethod(method: string, params: string[], clientPubkey: HexPubkey): Promise<string> {
    switch (method) {
      case 'get_public_key':
        return this.pubkey
      
      case 'ping':
        return 'pong'
      
      case 'describe':
        return JSON.stringify(['get_public_key', 'sign_event', 'nip44_encrypt', 'nip44_decrypt', 'ping', 'describe'])
      
      case 'connect':
        return 'ack'
      
      case 'sign_event':
        return await this.signEvent(JSON.parse(params[0]))
      
      case 'nip44_encrypt':
        return this.nip44Encrypt(params[0], params[1])
      
      case 'nip44_decrypt':
        return this.nip44Decrypt(params[0], params[1])
      
      default:
        throw new Error(`Unknown method: ${method}`)
    }
  }

  /**
   * Sign a Nostr event using session key
   */
  async signEvent(eventJson: any): Promise<string> {
    if (!this.sessionSecretKey) {
      throw new Error('No session key available')
    }
    
    const template = {
      kind: eventJson.kind,
      content: eventJson.content || '',
      created_at: eventJson.created_at || Math.floor(Date.now() / 1000),
      tags: eventJson.tags || [],
    }
    
    const signedEvent = finalizeEvent(template, this.sessionSecretKey)
    return JSON.stringify(signedEvent)
  }

  /**
   * NIP-44 encrypt
   */
  nip44Encrypt(targetPubkey: HexPubkey, plaintext: string): string {
    if (!this.sessionSecretKey) {
      throw new Error('No session key available')
    }
    const key = nip44.getConversationKey(this.sessionSecretKey, targetPubkey)
    return nip44.encrypt(plaintext, key)
  }

  /**
   * NIP-44 decrypt
   */
  nip44Decrypt(senderPubkey: HexPubkey, ciphertext: string): string {
    if (!this.sessionSecretKey) {
      throw new Error('No session key available')
    }
    const key = nip44.getConversationKey(this.sessionSecretKey, senderPubkey)
    return nip44.decrypt(ciphertext, key)
  }

  /**
   * Decrypt incoming request
   */
  async decryptRequest(event: Nip46Event): Promise<string | null> {
    if (!this.sessionSecretKey) {
      console.error('[NIP-46] No session key')
      return null
    }
    
    try {
      const key = nip44.getConversationKey(this.sessionSecretKey, event.pubkey)
      return nip44.decrypt(event.content, key)
    } catch (err: any) {
      console.error('[NIP-46] Decrypt error:', err)
      return null
    }
  }

  /**
   * Encrypt outgoing response
   */
  encryptResponse(targetPubkey: HexPubkey, content: string): string {
    if (!this.sessionSecretKey) {
      console.error('[NIP-46] No session key')
      return content
    }
    
    try {
      const key = nip44.getConversationKey(this.sessionSecretKey, targetPubkey)
      return nip44.encrypt(content, key)
    } catch (err: any) {
      console.error('[NIP-46] Encrypt error:', err)
      return content
    }
  }

  /**
   * Send response event
   */
  async sendResponse(requestEvent: Nip46Event, id: string, result: string): Promise<void> {
    const response = { id, result }
    const encrypted = this.encryptResponse(requestEvent.pubkey, JSON.stringify(response))
    
    const event = {
      kind: KIND_BUNKER,
      pubkey: this.pubkey,
      created_at: Math.floor(Date.now() / 1000),
      content: encrypted,
      tags: [
        ['p', requestEvent.pubkey],
        ['e', requestEvent.id],
      ],
    }
    
    const signedEvent = finalizeEvent(event, this.sessionSecretKey!)
    await this._pool!.publish(this.relays, signedEvent)
    
    console.log('[NIP-46] Response sent:', id)
  }

  /**
   * Send error response
   */
  async sendErrorResponse(requestEvent: Nip46Event, id: string, error: string): Promise<void> {
    const response = { id, error }
    const encrypted = this.encryptResponse(requestEvent.pubkey, JSON.stringify(response))
    
    const event = {
      kind: KIND_BUNKER,
      pubkey: this.pubkey,
      created_at: Math.floor(Date.now() / 1000),
      content: encrypted,
      tags: [
        ['p', requestEvent.pubkey],
        ['e', requestEvent.id],
      ],
    }
    
    const signedEvent = finalizeEvent(event, this.sessionSecretKey!)
    await this._pool!.publish(this.relays, signedEvent)
    
    console.log('[NIP-46] Error response sent:', id, error)
  }

  /**
   * Approve pending request (called from UI)
   */
  approveRequest(pendingId: string): void {
    const pending = this._pendingRequests.get(pendingId)
    if (pending) {
      pending.resolve(true)
      this._pendingRequests.delete(pendingId)
    }
  }

  /**
   * Deny pending request (called from UI)
   */
  denyRequest(pendingId: string): void {
    const pending = this._pendingRequests.get(pendingId)
    if (pending) {
      pending.resolve(false)
      this._pendingRequests.delete(pendingId)
    }
  }
}