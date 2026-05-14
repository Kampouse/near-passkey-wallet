# Wallet Contract

Source: [near/intents](https://github.com/near/intents) — `contracts/wallet/`

This is the on-chain wallet contract deployed to each passkey wallet account. Forked from the
near-intents project with session key support added.

## Features

- **Passkey auth** (P-256 via WebAuthn) — `w_execute_signed`
- **Session keys** (ed25519) — `w_execute_session` — bypass FaceID for faster signing
- **CreateSession / RevokeSession** — manage session keys (requires passkey auth)
- **Extensions** — `w_execute_extension` for composable ops

## Session Key Flow

1. User creates a session key via passkey-authenticated `CreateSession` op
2. Ed25519 keypair stored in browser IndexedDB (non-extractable CryptoKey)
3. Subsequent transactions signed with ed25519 — no FaceID prompt
4. Session key has TTL (30 days), scoped to specific operations

## Build

This contract is part of the [near-intents workspace](https://github.com/near/intents).
Clone that repo to build:

```bash
cargo near build non-reproducible-wasm --no-default-features --features=contract,webauthn-p256
```

## Key Files

- `src/contract/mod.rs` — Main contract logic, `w_execute_signed`, `w_execute_session`
- `src/signature/` — Signature verification (WebAuthn, ed25519, no-sign)
- `src/state.rs` — Contract state including session keys map
- `src/request/ops.rs` — WalletOp enum (CreateSession, RevokeSession, etc.)
