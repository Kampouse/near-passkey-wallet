# NIP-46 Bunker Implementation Status

## Goal
Enable passkey wallet as a NIP-46 bunker for Nostr authentication. Other apps can scan the wallet's NostrConnect QR to authenticate with FaceID.

## Current State: Refactored to Modular TypeScript-ready Structure

**Latest Deployment**: https://0dfe81cf.near-passkey-wallet.pages.dev

**Status**: Code refactored into clean modular structure. Ready for testing.

## Code Structure (After Refactor)

```
src/nostr/
├── index.js          # Barrel export
├── types.js          # Type definitions (JSDoc) + constants
├── crypto.js         # NIP-44 encryption utilities
├── session.js        # Session key management (localStorage)
├── nostrconnect.js   # NostrConnect URI handling
└── bunker.js         # Nip46Bunker class
```

### Module Responsibilities

| File | Purpose |
|------|---------|
| `types.js` | Constants (`KIND_BUNKER`, `DEFAULT_RELAYS`), JSDoc type definitions |
| `crypto.js` | `getConversationKey`, `encrypt`, `decrypt`, `toHex`, `fromHex`, `generateId` |
| `session.js` | `getOrCreateSessionKeypair`, `clearSessionKeypair`, `storeApprovedApp`, `getApprovedApps` |
| `nostrconnect.js` | `parseNostrConnectUri`, `handleNostrConnectRequest` |
| `bunker.js` | `Nip46Bunker` class with `start()`, `stop()`, `handleEvent()`, etc. |

### Key Improvements

1. **Clean separation of concerns**: Each module has a single responsibility
2. **Explicit exports**: `index.js` barrel file makes imports clean
3. **JSDoc types**: Full IDE support without TypeScript compilation
4. **Consistent error handling**: Type validation at entry points
5. **Clear documentation**: Each function has purpose, params, returns documented

## Architecture

```
[Client App] --nostrconnect://--> [Wallet (Bunker)]
                kind 24133 events
                NIP-44 encrypted
                             
Client generates: clientSecretKey (random, localStorage)
Wallet generates: sessionSecretKey (random, localStorage)

Conversation key = getConversationKey(mySecretKey, theirPubkey)
```

## What's Working
1. ✅ NostrConnect QR parsing
2. ✅ Session keypair generation (stored in localStorage)
3. ✅ NIP-44 encryption for ACK response
4. ✅ Publishing encrypted events to relays
5. ✅ Client receives ACK and establishes `BunkerSigner` connection

## What's Broken / In Progress
1. ❓ Bunker receives `get_public_key` request - need to test after refactor
2. ❓ TDZ error in `nip44.decrypt` - should be fixed by noble dedupe

## Key Technical Details

### NIP-44 API Change (Critical)
**nostr-tools 2.x bundles `@noble/curves` v2.0.1** which requires Uint8Array for private key, NOT hex string.

```javascript
// OLD (broken): nip44.getConversationKey(secretKeyHex, clientPubkey)
// NEW (fixed):  nip44.getConversationKey(secretKeyUint8Array, clientPubkey)
```

### Usage Example (After Refactor)

```javascript
// Import all from the barrel
import { 
  getOrCreateSessionKeypair, 
  handleNostrConnectRequest, 
  Nip46Bunker 
} from './nostr/index.js'

// Get session key
const { secretKey, pubkey } = getOrCreateSessionKeypair()

// Handle NostrConnect pairing
await handleNostrConnectRequest({
  clientPubkey: parsed.clientPubkey,
  relays: parsed.relays,
  secret: parsed.secret,
  ourSecretKey: secretKey,  // Uint8Array
  ourPubkey: pubkey,
  addLog: console.log,
})

// Start bunker
const bunker = new Nip46Bunker({
  relays: ['wss://relay.primal.net'],
  pubkey: pubkey,
  npub: npubFromHex(pubkey),
  sessionSecretKey: secretKey,  // Uint8Array
  onRequest: (request) => showApprovalUI(request),
})
await bunker.start()
```

### Vite Dependency Issue
Multiple packages bring different `@noble/curves` versions:
- ethers@6.16.0 → @noble/curves@1.2.0
- near-api-js@5.1.1 → @noble/curves@1.8.1  
- nostr-tools@2.23.3 → @noble/curves@2.0.1

**Fix**: Added as direct devDependencies:
```json
"devDependencies": {
  "@noble/curves": "2.0.1",
  "@noble/hashes": "2.0.1"
}
```

## Files Changed

| Old | New | Notes |
|-----|-----|-------|
| `src/nostrconnect.js` | `src/nostr/nostrconnect.js` | Modular refactor |
| `src/nip46.js` | `src/nostr/bunker.js` | Cleaner implementation |
| - | `src/nostr/crypto.js` | NIP-44 utilities extracted |
| - | `src/nostr/session.js` | Session management extracted |
| - | `src/nostr/types.js` | Constants + JSDoc types |
| - | `src/nostr/index.js` | Barrel export |

## Next Steps
1. Test fresh browser session at deployment URL
2. Check logs for `[NIP-46] Decrypted:` - confirms decrypt works
3. Verify `get_public_key` returns bunker's pubkey
4. Implement `sign_event` with FaceID via MPC (future)

## Errors We've Fixed
1. **`getConversationKey` expected Uint8Array** - Pass Uint8Array directly
2. **Client timeout on `get_public_key`** - Restart bunker on re-pair
3. **TDZ error `Cannot access 'm' before initialization`** - Dedupe noble versions
4. **ID mismatch in responses** - Use request.id in response

## Open Questions
- Should bunker pubkey be MPC-derived Nostr key (path: 'nostr,1') or session key?
  - Current: session key (random, localStorage)
  - Future: MPC-derived for FaceID-protected signing
- How to handle `sign_event` requests?
  - Current: session key signs (no FaceID)
  - Future: MPC sign via NEAR passkey contract

## Reference Links
- nostr-tools nip46.ts: https://github.com/nbd-wtf/nostr-tools/blob/master/nip46.ts
- nostr-tools nip44.ts: https://github.com/nbd-wtf/nostr-tools/blob/master/nip44.ts
- NIP-46 spec: https://github.com/nostr-protocol/nips/blob/master/46.md
- NIP-44 spec: https://github.com/nostr-protocol/nips/blob/master/44.md