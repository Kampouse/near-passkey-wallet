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