/**
 * NostrConnect Handler
 * 
 * Handles nostrconnect:// URIs where:
 * 1. Another app generates a nostrconnect:// QR
 * 2. User scans with wallet
 * 3. Wallet sends encrypted response to relay
 * 4. Session established
 */

const KIND_BUNKER = 24133

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

// Helper
function generateRequestId(len = 16) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
  let id = ''
  const arr = new Uint8Array(len)
  crypto.getRandomValues(arr)
  for (let i = 0; i < len; i++) id += chars[arr[i] % chars.length]
  return id
}