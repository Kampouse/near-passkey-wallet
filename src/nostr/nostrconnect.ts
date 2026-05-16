/**
 * NostrConnect Handler
 * 
 * Handles nostrconnect:// URIs for NIP-46 pairing.
 */

// @ts-ignore - nostr-tools subpath imports work at runtime
import * as nip44 from 'nostr-tools/nip44'
// @ts-ignore
import { finalizeEvent } from 'nostr-tools/pure'
// @ts-ignore
import { SimplePool } from 'nostr-tools/pool'
import { KIND_BUNKER, type NostrConnectUri, type HexPubkey, type SecretKey } from './types'
import { generateId } from './crypto'

/**
 * Parse nostrconnect:// URI
 */
export function parseNostrConnectUri(uri: string): NostrConnectUri | null {
  try {
    if (!uri.startsWith('nostrconnect://')) return null
    
    const url = new URL(uri)
    const clientPubkey = url.host as HexPubkey
    
    const relays = url.searchParams.getAll('relay')
    const secret = url.searchParams.get('secret')
    const perms = url.searchParams.get('perms')
    const name = url.searchParams.get('name')
    const urlParam = url.searchParams.get('url')
    
    return {
      clientPubkey,
      relays: relays.length > 0 ? relays : ['wss://relay.primal.net'],
      secret,
      perms: perms ? perms.split(',') : [],
      metadata: { name: name || undefined, url: urlParam || undefined },
    }
  } catch (err) {
    console.error('[NostrConnect] Failed to parse URI:', err)
    return null
  }
}

/**
 * Handle nostrconnect pairing request
 */
export async function handleNostrConnectRequest(params: {
  clientPubkey: HexPubkey
  relays: string[]
  secret: string | null
  ourSecretKey: SecretKey
  ourPubkey: HexPubkey
  addLog?: (msg: string) => void
}): Promise<{ success: boolean; eventId?: string }> {
  const { clientPubkey, relays, secret, ourSecretKey, ourPubkey, addLog } = params
  
  const log = (msg: string) => {
    if (addLog) addLog(msg)
    console.log('[NostrConnect]', msg)
  }
  
  // Validate inputs
  if (!(ourSecretKey instanceof Uint8Array)) {
    throw new TypeError('ourSecretKey must be Uint8Array')
  }
  if (ourSecretKey.length !== 32) {
    throw new TypeError('ourSecretKey must be 32 bytes')
  }
  if (typeof clientPubkey !== 'string' || clientPubkey.length !== 64) {
    throw new TypeError('clientPubkey must be 64-char hex string')
  }
  
  log(`Pairing with client: ${clientPubkey.slice(0, 16)}...`)
  
  // Build response
  const response = {
    id: generateId(),
    result: secret || 'ack',
  }
  
  const pool = new SimplePool()
  
  try {
    // Derive conversation key
    log('Deriving conversation key...')
    const conversationKey = nip44.getConversationKey(ourSecretKey, clientPubkey)
    
    // Encrypt response
    log('Encrypting response...')
    const encryptedContent = nip44.encrypt(JSON.stringify(response), conversationKey)
    
    // Build event
    const eventTemplate = {
      kind: KIND_BUNKER,
      content: encryptedContent,
      tags: [['p', clientPubkey]],
      created_at: Math.floor(Date.now() / 1000),
      pubkey: ourPubkey,
    }
    
    // Sign event
    log('Signing event...')
    const signedEvent = finalizeEvent(eventTemplate, ourSecretKey)
    
    log(`Event ID: ${signedEvent.id.slice(0, 16)}...`)
    log(`Publishing to ${relays.length} relays...`)
    
    // Publish to relays
    const results = await Promise.allSettled(
      relays.map(relay => pool.publish([relay], signedEvent))
    )
    
    const successCount = results.filter(r => r.status === 'fulfilled').length
    log(`Published to ${successCount}/${relays.length} relays`)
    
    return { success: successCount > 0, eventId: signedEvent.id }
    
  } catch (err: any) {
    log(`ERROR: ${err.message}`)
    throw err
  } finally {
    pool.close(relays)
  }
}