# @passkey/sdk

Passkey payment URI specification — generate and parse `passkey://pay` QR codes.

## Install

```bash
npm install @passkey/sdk
```

## Usage

### Merchant (Create QR)

```typescript
import { createPaymentQr } from '@passkey/sdk'

const qr = createPaymentQr({
  amount: '15.00',
  currency: 'USDC',
  depositAddress: '0xABC123...',
  merchant: 'Pizza Boy Billy',
  chain: 'base',
  orderId: 'ord_123',
  callback: 'https://api.pingpay.io/webhooks/passkey',
})

// Display as QR code
showQRCode(qr)
```

### Wallet (Parse QR)

```typescript
import { parsePaymentQr, notifyCallback, isPasskeyQr } from '@passkey/sdk'

// When QR scanned:
const scanned = 'passkey://pay?amount=15.00&currency=USDC&...'

if (!isPasskeyQr(scanned)) {
  throw new Error('Not a passkey payment')
}

const payment = parsePaymentQr(scanned)
// { amount: '15.00', currency: 'USDC', merchant: 'Pizza Boy Billy', ... }

// Show "Pay $15.00 to Pizza Boy Billy"
// User confirms FaceID
// Broadcast tx to payment.depositAddress

// After tx sent:
await notifyCallback(payment, {
  txHash: '0x...',
  from: wallet.address,
  chain: payment.chain,
})
```

## URI Specification

```
passkey://pay?
  amount=15.00          (required)
  &currency=USDC        (required)
  &depositAddress=0x... (required)
  &merchant=Pizza%20Boy (optional)
  &chain=base           (optional, default: base)
  &orderId=pay_abc123   (optional)
  &callback=https://... (optional)
  &logo=https://...     (optional)
```

## Callback Payload

Wallet POSTs to callback after tx broadcast:

```json
{
  "orderId": "pay_abc123",
  "txHash": "0x...",
  "from": "0x...",
  "chain": "base"
}
```

## API

### `createPaymentQr(params: PaymentQr): string`

Create a `passkey://pay` URI.

### `parsePaymentQr(uri: string): ParsedPayment | null`

Parse a URI. Returns `null` if invalid.

### `notifyCallback(payment: ParsedPayment, payload: CallbackPayload): Promise<...>`

POST to merchant callback after payment.

### `isPasskeyQr(uri: string): boolean`

Check if string is a valid passkey payment URI.