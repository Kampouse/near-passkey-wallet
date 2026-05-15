export interface PaymentQr {
  // Required
  amount: string
  currency: string
  depositAddress: string

  // Optional
  merchant?: string
  chain?: string
  orderId?: string
  callback?: string
  logo?: string
}

export interface ParsedPayment extends PaymentQr {
  // Computed defaults
  chain: string // always present after parse
}

export interface CallbackPayload {
  orderId?: string
  txHash: string
  from: string
  chain: string
}

/**
 * Create a passkey://pay URI
 */
export function createPaymentQr(params: PaymentQr): string {
  if (!params.amount) throw new Error('amount is required')
  if (!params.currency) throw new Error('currency is required')
  if (!params.depositAddress) throw new Error('depositAddress is required')

  const p = new URLSearchParams()

  // Required
  p.set('amount', params.amount)
  p.set('currency', params.currency)
  p.set('depositAddress', params.depositAddress)

  // Optional
  if (params.merchant) p.set('merchant', params.merchant)
  if (params.chain) p.set('chain', params.chain)
  if (params.orderId) p.set('orderId', params.orderId)
  if (params.callback) p.set('callback', params.callback)
  if (params.logo) p.set('logo', params.logo)

  return `passkey://pay?${p.toString()}`
}

/**
 * Parse a passkey://pay URI
 * Returns null if not a valid passkey payment URI
 */
export function parsePaymentQr(uri: string): ParsedPayment | null {
  try {
    const url = new URL(uri)

    if (url.protocol !== 'passkey:') return null
    if (url.pathname !== '/pay') return null

    const p = url.searchParams

    const amount = p.get('amount')
    const currency = p.get('currency')
    const depositAddress = p.get('depositAddress')

    if (!amount || !currency || !depositAddress) {
      return null
    }

    return {
      amount,
      currency,
      depositAddress,
      merchant: p.get('merchant') || undefined,
      chain: p.get('chain') || 'base',
      orderId: p.get('orderId') || undefined,
      callback: p.get('callback') || undefined,
      logo: p.get('logo') || undefined,
    }
  } catch {
    return null
  }
}

/**
 * Notify merchant callback after sending payment
 */
export async function notifyCallback(
  payment: ParsedPayment,
  payload: CallbackPayload
): Promise<{ ok: boolean; status?: number } | { ok: false; error: string }> {
  if (!payment.callback) {
    return { ok: false, error: 'No callback URL' }
  }

  try {
    const res = await fetch(payment.callback, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        orderId: payment.orderId,
        txHash: payload.txHash,
        from: payload.from,
        chain: payload.chain,
      }),
    })

    if (res.ok) {
      return { ok: true, status: res.status }
    } else {
      return { ok: false, error: `HTTP ${res.status}` }
    }
  } catch (err) {
    return { ok: false, error: String(err) }
  }
}

/**
 * Check if a string is a passkey://pay URI
 */
export function isPasskeyQr(uri: string): boolean {
  try {
    const url = new URL(uri)
    return url.protocol === 'passkey:' && url.pathname === '/pay'
  } catch {
    return false
  }
}