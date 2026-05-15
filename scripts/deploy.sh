#!/bin/bash
set -e
# Full deploy: contract → WASM → frontend → Cloudflare Pages

echo "🔨 Building contract..."
cd /tmp/near-passkey-wallet-gh/wallet-contract
cargo near build non-reproducible-wasm --no-abi --no-default-features --features contract,webauthn-p256

echo "📦 Building frontend..."
cd /tmp/near-passkey-wallet-gh
npm run build

echo "📦 Copying WASM to dist..."
cp target/near/defuse_wallet/defuse_wallet.wasm dist/wallet-p256.wasm
sha256sum dist/wallet-p256.wasm

echo "☁️  Deploying to Cloudflare Pages..."
npx wrangler pages deploy dist --project-name=near-passkey-wallet

echo "✅ Done! New accounts will use the updated contract."
echo "   WASM hash: $(sha256sum dist/wallet-p256.wasm | cut -d' ' -f1)"