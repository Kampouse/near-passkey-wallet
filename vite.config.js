/**
 * NEAR Passkey Wallet — Web App
 * 
 * Flow:
 * 1. User clicks "Create Wallet" → browser creates WebAuthn passkey (FaceID)
 * 2. Passkey public key → derive deterministic NEAR account (NEP-616)
 * 3. Passkey public key → derive Ethereum address via MPC (v1.signer)
 * 4. User sees ETH address + balance
 * 5. User sends ETH: signs request with passkey → wallet contract → MPC → broadcast
 */

import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: { port: 3000 },
  build: { target: 'esnext' },
})
