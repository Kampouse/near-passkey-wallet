import * as nip44 from 'nostr-tools/nip44'

// Test what getConversationKey expects
const privKey = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
const pubKey = 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789'

console.log('privKey type:', typeof privKey)
console.log('pubKey type:', typeof pubKey)

try {
  const convKey = nip44.getConversationKey(privKey, pubKey)
  console.log('SUCCESS! convKey type:', convKey?.constructor?.name, 'len:', convKey?.length)
} catch (e) {
  console.log('ERROR:', e.message)
  console.log('Stack:', e.stack)
}
