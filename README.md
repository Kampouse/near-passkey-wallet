# near-passkey-wallet

Passkey-based cross-chain wallet using NEAR MPC signatures.

Live at [near-passkey-wallet.pages.dev](https://near-passkey-wallet.pages.dev)

## Features

- WebAuthn/Passkey authentication (no passwords, no seed phrases)
- NEAR MPC chain signatures for cross-chain transactions
- Session keys (ed25519) for gasless operations without FaceID
- Factory-based wallet deployment
- Non-extractable CryptoKey storage in IndexedDB

## Architecture

- **Frontend:** Vite + React, deployed on Cloudflare Pages
- **Wallet Contract:** `wallet-contract/` — forked from [near/intents](https://github.com/near/intents) (`contracts/wallet/`) with custom session key additions
- **MPC:** v1.signer-prod.testnet for chain signature requests

## Session Keys (custom addition)

Session keys are NOT part of upstream near/intents. Added to the wallet contract:

- `w_execute_session` — ed25519-only execution path, bypasses FaceID/P-256
- `WalletOp::CreateSession(3)` / `WalletOp::RevokeSession(4)` — manage session keys (requires passkey auth)
- State migration with borsh deserialize fallback for existing wallets

Build from the [near-intents workspace](https://github.com/near/intents):

```bash
cargo near build non-reproducible-wasm --no-default-features --features=contract,webauthn-p256
```

See `wallet-contract/README.md` for details.

## Setup

```bash
npm install
npm run dev
```

## Deploy

```bash
npm run build
cp public/wallet-p256.wasm dist/wallet-p256.wasm
npx wrangler pages deploy dist/ --project-name=near-passkey-wallet
```

## Contract Addresses (Testnet)

- Factory: `pwallet-v2.kampy.testnet`
- MPC Signer: `v1.signer-prod.testnet`
