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
- **Wallet Contract:** Forked from [near-intents](https://github.com/near intents) with session key support
- **Factory Contract:** Deploys and manages wallet instances
- **MPC:** v1.signer-prod.testnet for chain signature requests

## Setup

```bash
npm install
npm run dev
```

## Deploy

```bash
npm run build
npx wrangler pages deploy dist/ --project-name=near-passkey-wallet
```

## Contract Addresses (Testnet)

- Factory: `pwallet-v2.kampy.testnet`
- MPC Signer: `v1.signer-prod.testnet`
