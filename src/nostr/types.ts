/**
 * NIP-46 Type Definitions
 */

// ─── Core Types ─────────────────────────────────────────────────────

/** 64-character hex public key */
export type HexPubkey = string

/** bech32-encoded public key (npub1...) */
export type Npub = string

/** 32-byte Ed25519 secret key */
export type SecretKey = Uint8Array

// ─── Session Types ───────────────────────────────────────────────────

export interface SessionKeypair {
  secretKey: SecretKey
  pubkey: HexPubkey
}

// ─── NostrConnect Types ───────────────────────────────────────────────

export interface NostrConnectUri {
  clientPubkey: HexPubkey
  relays: string[]
  secret: string | null
  perms: string[]
  metadata: {
    name?: string
    url?: string
  }
}

// ─── NIP-46 Request/Response Types ─────────────────────────────────────

export interface Nip46Request {
  id: string
  method: string
  params: string[]
}

export interface Nip46Response {
  id: string
  result?: string
  error?: string
}

export interface Nip46Event {
  id: string
  pubkey: string
  created_at: number
  kind: number
  content: string
  tags: string[][]
}

// ─── Pending Request Types ───────────────────────────────────────────

export interface PendingRequest {
  id: string
  method: string
  params: string[]
  clientPubkey: HexPubkey
  event: Nip46Event
  /// signer-side decoded human summary lines
  summary?: string[]
}

// ─── Bunker Options ───────────────────────────────────────────────────

export interface BunkerOptions {
  relays?: string[]
  pubkey: HexPubkey
  npub: Npub
  sessionSecretKey: SecretKey
  accountId?: string
  signFn?: (messageHash: Uint8Array) => Promise<Uint8Array>
  onRequest?: (request: PendingRequest) => void
  /// executes sign_near_tx through the wallet contract (w_execute_session)
  executeNearTx?: (req: NearTxRequest) => Promise<{ tx_hash: string }>
  /// in-app visibility for relay publish results (wired to the Activity log)
  onLog?: (line: string) => void
}

// ─── Approved App Types ───────────────────────────────────────────────

export interface ApprovedApp {
  name?: string
  url?: string
  perms: string[]
  approvedAt: number
}

// ─── Constants ────────────────────────────────────────────────────────

export const KIND_BUNKER = 24133

export const DEFAULT_RELAYS: string[] = [
  'wss://relay.primal.net',
  'wss://nos.lol',
  'wss://relay.damus.io',
]

export const AUTO_APPROVE_METHODS = ['get_public_key', 'ping', 'describe'] as const

// ─── NEAR tx requests (sign_near_tx) ─────────────────────────────────

/// Matches the wallet contract's action shape (ExecuteSessionParams.actions)
export interface NearTxAction {
  action: string // 'FunctionCall' | 'Transfer' | ...
  function_name?: string
  args?: string // JSON string
  deposit?: string
  amount?: string
  receiver_id?: string
}

export interface NearTxRequest {
  account_id?: string // informational; the wallet executes from ITS account
  actions: NearTxAction[]
}

/// True when NO action carries value — pure calls the wallet executes for gas only.
/// These auto-execute without human approval (tier-1): the wallet risks nothing
/// but a bounded gas fee, and cannot lose assets with zero attached deposit.
export function isZeroValueRequest(req: NearTxRequest): boolean {
  return (req.actions ?? []).every(a => {
    const zero = (v?: string) => !v || v === '0' || /^0+$/.test(v)
    return a.action !== 'Transfer' && zero(a.deposit) && zero(a.amount)
  })
}

/// Human summary of a NEAR tx request — the signer's own decode (never trust the client).
export function describeNearTxRequest(req: NearTxRequest): string[] {
  return req.actions.map(a => {
    if (a.action === 'Transfer' || a.amount) {
      return `transfer ${a.amount ?? a.deposit ?? '?'} yocto → ${a.receiver_id ?? '?'}`
    }
    const argsShort = a.args && a.args.length > 60 ? a.args.slice(0, 60) + '…' : (a.args ?? '{}')
    const dep = a.deposit && a.deposit !== '0' ? ` · attach ${a.deposit} yocto` : ''
    return `${a.action}:${a.function_name ?? '?'}(${argsShort}) → ${a.receiver_id ?? '?'}${dep}`
  })
}