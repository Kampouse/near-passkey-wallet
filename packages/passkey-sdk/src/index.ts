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

  // Multi-currency / swap support
  accepts?: AcceptsCurrency[]  // List of accepted currencies with deposit addresses
  swap?: SwapQuote             // Pre-computed swap quote from merchant
}

export interface AcceptsCurrency {
  currency: string    // e.g., "USDC", "ETH"
  chain: string       // e.g., "base", "eth", "sol"
  depositAddress: string
  assetId?: string    // NEAR Intents asset ID (for 1Click)
}

export interface SwapQuote {
  // What the user will pay
  fromAsset: string       // NEAR Intents asset ID (e.g., "nep141:base.omft.near")
  fromAmount: string      // Human-readable amount (e.g., "0.00682")
  fromAmountWei: string   // Wei/lamports (e.g., "6820823980945403")
  fromChain: string       // Chain (e.g., "base")
  fromSymbol: string      // Symbol (e.g., "ETH")

  // What the merchant receives
  toAsset: string         // NEAR Intents asset ID
  toAmount: string        // Human-readable amount
  toAmountWei: string     // Smallest unit
  toChain: string
  toSymbol: string

  // Quote metadata
  quoteId: string         // Unique quote ID
  deadline: string        // ISO 8601 expiration timestamp
  fee: string             // Fee amount in USD

  // NEAR Intents specific
  depositAddress?: string  // Where to deposit for 1Click
  signature?: string      // 1Click signature for verification
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

  // Multi-currency: accepts=<currency>:<chain>:<address>,...
  if (params.accepts?.length) {
    const acceptsStr = params.accepts
      .map(a => `${a.currency}:${a.chain}:${a.depositAddress}${a.assetId ? `@${a.assetId}` : ''}`)
      .join(',')
    p.set('accepts', acceptsStr)
  }

  // Swap quote (JSON encoded)
  if (params.swap) {
    p.set('swap', btoa(JSON.stringify(params.swap)))
  }

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

    // Parse accepts currencies
    let accepts: AcceptsCurrency[] | undefined
    const acceptsStr = p.get('accepts')
    if (acceptsStr) {
      accepts = acceptsStr.split(',').map(s => {
        // Format: CURRENCY:CHAIN:ADDRESS or CURRENCY:CHAIN:ADDRESS@assetId
        const [cur, chain, addrAsset] = s.split(':')
        const [addr, assetId] = addrAsset?.split('@') || [addrAsset]
        return {
          currency: cur,
          chain,
          depositAddress: addr,
          assetId: assetId || undefined,
        }
      })
    }

    // Parse swap quote
    let swap: SwapQuote | undefined
    const swapStr = p.get('swap')
    if (swapStr) {
      try {
        swap = JSON.parse(atob(swapStr))
      } catch {
        // Invalid swap encoding, ignore
      }
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
      accepts,
      swap,
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

/**
 * Fetch 1Click swap quote (unauthenticated, 0.2% fee)
 * Called by merchant to pre-compute swap for QR
 */
export async function fetch1ClickQuote(params: {
  originAsset: string     // NEAR Intents asset ID user will pay
  destinationAsset: string // NEAR Intents asset ID merchant receives
  amount: string          // Amount in smallest unit (wei/lamports)
  recipient: string       // Merchant's NEAR account or address
  deadlineMinutes?: number // Quote expiry (default 30)
}): Promise<SwapQuote | { error: string }> {
  const { originAsset, destinationAsset, amount, recipient, deadlineMinutes = 30 } = params

  const deadline = new Date(Date.now() + deadlineMinutes * 60 * 1000).toISOString()

  try {
    const res = await fetch('https://1click.chaindefuser.com/v0/quote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        dry: true,  // Quote only, don't execute
        swapType: 'EXACT_OUTPUT',
        originAsset,
        destinationAsset,
        amount,
        recipient,
        recipientType: 'INTENTS',
        slippageTolerance: 100, // 1%
        depositType: 'INTENTS',
        refundTo: recipient,
        refundType: 'INTENTS',
        deadline,
      }),
    })

    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      return { error: data.message || `HTTP ${res.status}` }
    }

    const data = await res.json()

    // Extract asset info from the response
    const quote = data.quote
    const request = data.quoteRequest

    return {
      fromAsset: request.originAsset,
      fromAmount: quote.amountInFormatted || (BigInt(quote.amountIn) / BigInt(10**18)).toString(),
      fromAmountWei: quote.amountIn,
      fromChain: extractChain(originAsset),
      fromSymbol: extractSymbol(originAsset),
      toAsset: request.destinationAsset,
      toAmount: quote.amountOutFormatted || (BigInt(quote.amountOut) / BigInt(10**6)).toString(),
      toAmountWei: quote.amountOut,
      toChain: extractChain(destinationAsset),
      toSymbol: extractSymbol(destinationAsset),
      quoteId: data.correlationId,
      deadline,
      fee: quote.amountInUsd ? (parseFloat(quote.amountInUsd) - parseFloat(quote.amountOutUsd)).toFixed(4) : '0',
      signature: data.signature,
    }
  } catch (err) {
    return { error: String(err) }
  }
}

/**
 * Parse chain from NEAR Intents asset ID
 */
function extractChain(assetId: string): string {
  // nep141:eth-0x... -> eth
  // nep141:base-0x... -> base
  // nep245:v2_1.omni.hot.tg:56_... -> bsc (chain ID 56)
  // 1cs_v1:base:erc20:... -> base
  const parts = assetId.split(':')
  if (parts[0] === 'nep141') {
    const second = parts[1]
    if (second.startsWith('eth-') || second === 'eth.omft.near') return 'eth'
    if (second.startsWith('base-') || second === 'base.omft.near') return 'base'
    if (second.startsWith('arb-') || second === 'arb.omft.near') return 'arb'
    if (second.startsWith('sol-') || second === 'sol.omft.near') return 'sol'
    if (second.startsWith('gnosis-') || second === 'gnosis.omft.near') return 'gnosis'
    if (second.startsWith('polygon-')) return 'polygon'
    return 'near' // native NEAR tokens
  }
  if (parts[0] === 'nep245') {
    // v2_1.omni.hot.tg:56_... -> chain ID is after ":"
    const chainId = parts[1].split('_')[2]?.split(':')[0]
    const chainIdMap: Record<string, string> = {
      '1': 'eth', '10': 'op', '56': 'bsc', '137': 'polygon',
      '196': 'xlayer', '43114': 'avax', '9745': 'plasma',
      '1100': 'stellar', '1117': 'ton', '143': 'monad',
    }
    return chainIdMap[chainId] || chainId || 'unknown'
  }
  if (parts[0] === '1cs_v1') {
    return parts[1] // 1cs_v1:base:erc20:... -> base
  }
  return 'unknown'
}

/**
 * Parse symbol from NEAR Intents asset ID
 */
function extractSymbol(assetId: string): string {
  // nep141:eth-0x...omft.near -> ETH (from API response)
  // For now return a generic placeholder
  // Real implementation would use the /tokens API
  const parts = assetId.split(':')
  if (parts.length >= 2) {
    // Try to extract from contract address or common patterns
    if (parts[1].includes('usdc') || parts[1].includes('USDC')) return 'USDC'
    if (parts[1].includes('usdt') || parts[1].includes('USDT')) return 'USDT'
    if (parts[1] === 'eth.omft.near' || parts[1] === 'base.omft.near') return 'ETH'
    if (parts[1] === 'sol.omft.near') return 'SOL'
    if (parts[1] === 'btc.omft.near') return 'BTC'
    if (parts[1] === 'wrap.near') return 'wNEAR'
  }
  return '???'
}