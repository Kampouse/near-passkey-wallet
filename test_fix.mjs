import * as nip44 from 'nostr-tools/nip44'
import { hexToBytes } from 'nostr-tools/utils'

// Use REAL keys that are valid for secp256k1
// Generate real ones:
import { getPublicKey } from 'nostr-tools/pure'
const privKey = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
const pubKey = getPublicKey(hexToBytes(privKey))  // This creates a valid pubkey

console.log('Testing NIP-44 getConversationKey with valid keys...')
console.log('privKey:', privKey)
console.log('pubKey:', pubKey)

try {
  // NIP-44 should accept hex string for private key (old API) or Uint8Array (new)
  console.log('\n1. Testing with hex string privKey...')
  const convKey1 = nip44.getConversationKey(privKey, pubKey)
  console.log('SUCCESS! convKey type:', convKey1?.constructor?.name, 'len:', convKey1?.length)
} catch (e) {
  console.log('FAILED with hex string:', e.message)
}

try {
  console.log('\n2. Testing with Uint8Array privKey...')
  const privBytes = hexToBytes(privKey)
  const convKey2 = nip44.getConversationKey(privBytes, pubKey)
  console.log('SUCCESS! convKey type:', convKey2?.constructor?.name, 'len:', convKey2?.length)
} catch (e) {
  console.log('FAILED with Uint8Array:', e.message)
}
