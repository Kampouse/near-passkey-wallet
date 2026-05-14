/**
 * Core wallet module — real implementation
 * 
 * Passkey → NEAR wallet contract → MPC → cross-chain
 * 
 * All functions tested in test-bench.mjs (22/22 passing)
 */

import bs58 from 'bs58'
import { keccak_256 } from '@noble/hashes/sha3.js'
import { sha256 } from '@noble/hashes/sha2.js'

// ─── Config ──────────────────────────────────────────────────

export const NEAR_RPC = 'https://rpc.testnet.near.org'
export const MPC_CONTRACT = 'v1.signer-prod.testnet'
export const WALLET_CONTRACT = 'pwallet2.testnet'
export const FACTORY_CONTRACT = 'pwallet-v2.kampy.testnet'
export const ETH_RPC = 'https://ethereum-rpc.publicnode.com'
export const RELAY_URL = 'https://near-wallet-relay.kj95hgdgnn.workers.dev'

const CHAIN_ID = 'mainnet' // hardcoded in contract utils.rs
const WALLET_DOMAIN = 'NEAR_WALLET_CONTRACT/V1'
const STORAGE_KEY = 'passkey-wallet-state'
const CRED_MAP_KEY = 'passkey-cred-map'

// ─── Base58 helpers ──────────────────────────────────────

export function base58Encode(bytes) {
  return bs58.encode(bytes)
}

export function base58Decode(str) {
  return bs58.decode(str)
}

// ─── Passkey Management ──────────────────────────────────────

const PASSKEY_RP_NAME = 'Passkey Wallet'

/**
 * Create a new passkey (WebAuthn credential)
 */
/**
 * Create a new passkey (WebAuthn credential).
 * @param {string} accountId - NEAR account name stored in the passkey for login recovery.
 */
export async function createPasskey(accountId) {
  const rpId = window.location.hostname
  // Embed account name so we can recover it on a new device via passkey sync
  const userId = new TextEncoder().encode(accountId)

  const credential = await navigator.credentials.create({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      rp: { name: PASSKEY_RP_NAME, id: rpId },
      user: {
        id: userId,
        name: accountId,
        displayName: accountId,
      },
      pubKeyCredParams: [
        { type: 'public-key', alg: -8 },   // Ed25519
        { type: 'public-key', alg: -7 },    // P-256 (fallback)
      ],
      authenticatorSelection: {
        authenticatorAttachment: 'platform',
        userVerification: 'required',
        residentKey: 'preferred',
      },
      timeout: 60000,
    },
  })

  const response = credential.response
  return {
    id: credential.id,
    rawId: new Uint8Array(credential.rawId),
    publicKey: {
      raw: new Uint8Array(response.getPublicKey()),
      alg: response.getPublicKeyAlgorithm(),
    },
  }
}

/**
 * Sign a challenge with the passkey.
 * The challenge is SHA256("NEAR_WALLET_CONTRACT/V1" + borsh(RequestMessage))
 */
export async function signWithPasskey(credentialRawId, challengeHash) {
  // WebAuthn challenge must be a Uint8Array
  const assertion = await navigator.credentials.get({
    publicKey: {
      challenge: challengeHash,
      allowCredentials: [{
        type: 'public-key',
        id: credentialRawId,
      }],
      userVerification: 'required',
      timeout: 60000,
    },
  })

  return {
    authenticatorData: new Uint8Array(assertion.response.authenticatorData),
    clientDataJSON: new TextDecoder().decode(assertion.response.clientDataJSON),
    signature: new Uint8Array(assertion.response.signature),
  }
}

// ─── Borsh Serialization ─────────────────────────────────────

function borshU32(n) {
  const buf = new Uint8Array(4)
  new DataView(buf.buffer).setUint32(0, n, true)
  return buf
}

function borshString(s) {
  const encoded = new TextEncoder().encode(s)
  return new Uint8Array([...borshU32(encoded.length), ...encoded])
}

function concat(...arrays) {
  const total = arrays.reduce((s, a) => s + a.length, 0)
  const result = new Uint8Array(total)
  let offset = 0
  for (const a of arrays) {
    result.set(a, offset)
    offset += a.length
  }
  return result
}

/**
 * Borsh-serialize a RequestMessage for the wallet contract.
 * 
 * struct RequestMessage {
 *   chain_id: String,        // "mainnet"
 *   signer_id: AccountId,    // "pwallet1.testnet"
 *   nonce: u32,
 *   created_at: u32,         // TimestampSeconds<u32>
 *   timeout: u32,            // DurationSeconds<u32>
 *   request: Request {
 *     ops: Vec<WalletOp>,    // empty for simple operations
 *     out: PromiseDAG,       // Vec<PromiseSingle> — empty
 *   }
 * }
 */
export function borshRequestMessage(msg) {
  return concat(
    borshString(msg.chain_id),
    borshString(msg.signer_id),
    borshU32(msg.nonce),
    borshU32(msg.created_at),
    borshU32(msg.timeout),
    borshU32(0), // 0 ops
    // PromiseDAG.after (empty vec)
    borshU32(0),
    // PromiseDAG.then (empty vec)
    borshU32(0),
  )
}

/**
 * Compute the challenge hash that the passkey must sign.
 * Pipeline: borsh(msg) → prepend WALLET_DOMAIN → SHA256
 */
export function computeChallenge(borshBytes) {
  const domainBytes = new TextEncoder().encode(WALLET_DOMAIN)
  const prefixed = new Uint8Array([...domainBytes, ...borshBytes])
  return sha256(prefixed)
}

/**
 * Convert a DER-encoded P-256 signature to raw r||s (64 bytes).
 * WebAuthn produces DER: 30 <len> 02 <rlen> <r> 02 <slen> <s>
 * Contract expects raw: r (32 bytes) || s (32 bytes)
 */
function derToRawP256(der) {
  // Skip SEQUENCE tag (0x30) and length
  let offset = 2

  // Parse r: skip INTEGER tag (0x02), read length, read value
  if (der[offset] !== 0x02) throw new Error('Expected INTEGER tag for r')
  offset++
  const rLen = der[offset++]
  const r = der.slice(offset, offset + rLen)
  offset += rLen

  // Parse s: skip INTEGER tag (0x02), read length, read value
  if (der[offset] !== 0x02) throw new Error('Expected INTEGER tag for s')
  offset++
  const sLen = der[offset++]
  const s = der.slice(offset, offset + sLen)

  // Strip leading 0x00 padding (added when high bit is set)
  const rStrip = (r[0] === 0x00 && r.length === 33) ? r.slice(1) : r
  const sStrip = (s[0] === 0x00 && s.length === 33) ? s.slice(1) : s

  if (rStrip.length !== 32 || sStrip.length !== 32) {
    throw new Error(`Unexpected r/s lengths: ${rStrip.length}, ${sStrip.length}`)
  }

  const raw = new Uint8Array(64)
  raw.set(rStrip, 0)
  raw.set(sStrip, 32)
  return raw
}

/**
 * Build the proof JSON string for w_execute_signed (WebAuthn P-256 variant).
 * The contract expects:
 *   authenticator_data: base64url-unpadded
 *   client_data_json: raw JSON string from WebAuthn
 *   signature: base58-encoded raw r||s (64 bytes) P-256 signature
 */
export function buildProof(authenticatorData, clientDataJSON, signatureBytes) {
  const authenticatorDataB64 = uint8ToBase64url(authenticatorData)
  const rawSig = derToRawP256(signatureBytes)
  const signatureB58 = base58Encode(rawSig)
  return JSON.stringify({
    authenticator_data: authenticatorDataB64,
    client_data_json: clientDataJSON,
    signature: signatureB58,
  })
}

// ─── NEAR RPC ────────────────────────────────────────────────

export async function nearView(contractId, method, args = {}) {
  const argsB64 = btoa(JSON.stringify(args))
  const res = await fetch(NEAR_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'query',
      params: {
        request_type: 'call_function', finality: 'final',
        account_id: contractId, method_name: method, args_base64: argsB64,
      },
    }),
  })
  const data = await res.json()
  if (data.error) throw new Error(`RPC error: ${JSON.stringify(data.error)}`)
  const bytes = new Uint8Array(data.result.result)
  const str = new TextDecoder().decode(bytes)
  try { return JSON.parse(str) } catch { return str }
}

// ─── Key Derivation ──────────────────────────────────────────

/**
 * Derive Ethereum address from NEAR account via MPC.
 * Returns { derivedKey, ethAddress }
 */
export async function deriveEthAddress(nearAccountId, path = 'ethereum,1') {
  const derivedKey = await nearView(MPC_CONTRACT, 'derived_public_key', {
    path,
    predecessor: nearAccountId,
  })

  const ethAddress = nearPubkeyToEthAddress(derivedKey)
  return { derivedKey, ethAddress }
}

/**
 * Convert NEAR secp256k1 pubkey string to ETH address.
 * "secp256k1:base58..." → 0x... (20 bytes)
 * NEAR stores secp256k1 keys as 64 bytes raw (x + y, no 0x04 prefix).
 */
export function nearPubkeyToEthAddress(nearKey) {
  const parts = nearKey.split(':')
  if (parts.length !== 2 || parts[0] !== 'secp256k1') {
    throw new Error(`Invalid NEAR pubkey: ${nearKey}`)
  }
  const decoded = bs58.decode(parts[1])
  let pubKeyBytes
  if (decoded.length === 65 && decoded[0] === 0x04) {
    pubKeyBytes = decoded.slice(1)
  } else {
    // NEAR: 64 bytes raw x+y
    pubKeyBytes = decoded
  }
  const hash = keccak_256(pubKeyBytes)
  return '0x' + uint8ToHex(hash.slice(-20))
}

// ─── Ethereum RPC ────────────────────────────────────────────

async function ethRpc(method, params = []) {
  const res = await fetch(ETH_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method, params, id: 1 }),
  })
  const data = await res.json()
  if (data.error) throw new Error(`ETH RPC: ${JSON.stringify(data.error)}`)
  return data.result
}

export async function getEthBalance(address) {
  const balance = await ethRpc('eth_getBalance', [address, 'latest'])
  return BigInt(balance)
}

export async function getEthNonce(address) {
  const nonce = await ethRpc('eth_getTransactionCount', [address, 'latest'])
  return parseInt(nonce, 16)
}

export async function getEthGasPrice() {
  const res = await ethRpc('eth_feeHistory', [1, 'latest', [25]])
  if (res?.baseFeePerGas?.[1]) {
    const baseFee = BigInt(res.baseFeePerGas[1])
    return {
      maxFeePerGas: baseFee * 3n,
      maxPriorityFeePerGas: BigInt('2000000000'),
    }
  }
  return {
    maxFeePerGas: BigInt('30000000000'),
    maxPriorityFeePerGas: BigInt('2000000000'),
  }
}

export async function getEthBlockNumber() {
  const hex = await ethRpc('eth_blockNumber')
  return parseInt(hex, 16)
}

// ─── Relay Submission ────────────────────────────────────────

/**
 * Submit a signed request to the wallet contract via the CF Worker relay.
 * The relay builds a NEAR tx and submits it to RPC.
 * 
 * @param {string} argsJson - JSON-encoded args for w_execute_signed: { msg, proof }
 * @returns {{ tx_hash: string, status: string }}
 */
export async function submitViaRelay(argsJson, walletAccountId) {
  const argsBase64 = btoa(argsJson)
  const res = await fetch(`${RELAY_URL}/relay`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      args_base64: argsBase64,
      wallet_account_id: walletAccountId || WALLET_CONTRACT,
    }),
  })
  return res.json()
}

// ─── Wallet Creation ─────────────────────────────────────────

/**
 * Create a root account wallet (e.g. "alice.testnet").
 * Uses the testnet helper API to create the account, then deploys wallet WASM.
 */
export async function createRootWallet(name, publicKey, wasmBase64) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 120_000) // 2 min timeout

  try {
    // Step 1: Create the account via relay
    const createRes = await fetch(`${RELAY_URL}/create-root`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, public_key: publicKey }),
      signal: controller.signal,
    })
    const createData = await createRes.json()
    if (createData.error) throw new Error(`Create account failed: ${createData.error}`)

    const accountId = `${name}.testnet`

    // Step 2: Deploy wallet WASM + init (can take 10-15s for block finality)
    const deployRes = await fetch(`${RELAY_URL}/deploy-wallet`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ account_id: accountId, public_key: publicKey, wasm_base64: wasmBase64 }),
      signal: controller.signal,
    })
    const deployData = await deployRes.json()
    if (deployData.error) throw new Error(`Deploy failed: ${deployData.error}`)

    return { accountId, deployTx: deployData.deploy_tx, initTx: deployData.init_tx }
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * Create a subaccount wallet (e.g. "alice.pwallet-factory.kampy.testnet").
 * Uses the factory contract to create + deploy + init in one call.
 */
export async function createSubaccountWallet(name, publicKey, wasmBase64) {
  const res = await fetch(`${RELAY_URL}/create-subaccount`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, public_key: publicKey, wasm_base64: wasmBase64 }),
  })
  const data = await res.json()
  if (data.error) throw new Error(`Factory create failed: ${data.error}`)
  return { accountId: data.account_id, txHash: data.tx_hash }
}

/**
 * Check if a NEAR account name is available.
 */
export async function checkAccountAvailable(accountId) {
  try {
    await nearView(accountId, 'w_public_key')
    return false // account exists
  } catch {
    return true // account doesn't exist
  }
}

/**
 * Get the wallet WASM bytes as base64 (for passing to creation endpoints).
 * Fetches from a static URL — the WASM is stored in the app's public dir.
 */
export async function getWalletWasmBase64() {
  const res = await fetch('/wallet-p256.wasm')
  if (!res.ok) throw new Error('Failed to load wallet WASM')
  const arrayBuffer = await res.arrayBuffer()
  const bytes = new Uint8Array(arrayBuffer)
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary)
}

// ─── Persistence ─────────────────────────────────────────────

export function saveWalletState(state) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    nearAccountId: state.nearAccountId,
    ethAddress: state.ethAddress,
    credentialId: state.credentialId,
    credentialRawId: state.credentialRawId, // base64
    derivedKey: state.derivedKey,
    path: state.path,
  }))
}

export function loadWalletState() {
  const raw = localStorage.getItem(STORAGE_KEY)
  if (!raw) return null
  try {
    const state = JSON.parse(raw)
    // Restore rawId from base64
    if (state.credentialRawId && typeof state.credentialRawId === 'string') {
      state.credentialRawIdUint8 = base64ToUint8(state.credentialRawId)
    }
    return state
  } catch { return null }
}

export function clearWalletState() {
  localStorage.removeItem(STORAGE_KEY)
}

// CredentialId → accountId + credentialRawId mapping
// Survives logout. Lets old passkeys (without embedded userHandle) login without typing.
export function saveCredentialMapping(credentialId, accountId, credentialRawId) {
  const map = JSON.parse(localStorage.getItem(CRED_MAP_KEY) || '{}')
  map[credentialId] = { accountId, credentialRawId }
  localStorage.setItem(CRED_MAP_KEY, JSON.stringify(map))
}

export function lookupCredential(credentialId) {
  const map = JSON.parse(localStorage.getItem(CRED_MAP_KEY) || '{}')
  const entry = map[credentialId]
  if (!entry) return null
  return {
    accountId: entry.accountId,
    credentialRawId: entry.credentialRawId ? base64ToUint8(entry.credentialRawId) : null,
  }
}

// ─── Helpers ─────────────────────────────────────────────────

export function formatEthBalance(weiBigInt) {
  const eth = Number(weiBigInt) / 1e18
  if (eth === 0) return '0'
  if (eth < 0.0001) return '<0.0001'
  return eth.toFixed(4)
}

function uint8ToBase64url(bytes) {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function base64ToUint8(b64) {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function uint8ToBase64(bytes) {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary)
}

function uint8ToHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')
}

function hexToUint8(hex) {
  const h = hex.replace(/^0x/, '')
  const bytes = new Uint8Array(h.length / 2)
  for (let i = 0; i < h.length; i += 2) bytes[i / 2] = parseInt(h.substr(i, 2), 16)
  return bytes
}

// ─── ETH Transaction Building ──────────────────────────────

/**
 * Build an unsigned EIP-1559 ETH transfer transaction.
 * Returns { unsignedTxHex, txPayloadHash } where txPayloadHash is the 32-byte hash
 * that needs to be signed by MPC.
 */
export function buildEthTx({ nonce, maxFeePerGas, maxPriorityFeePerGas, to, valueWei, from }) {
  // EIP-1559 tx fields:
  // [chainId, nonce, maxPriorityFeePerGas, maxFeePerGas, gasLimit, to, value, data, accessList]
  const gasLimit = 21000n // simple ETH transfer
  const chainId = 1 // mainnet

  const fields = [
    intToRlp(chainId),
    intToRlp(nonce),
    intToRlp(maxPriorityFeePerGas),
    intToRlp(maxFeePerGas),
    intToRlp(gasLimit),
    to.length === 20 ? bytesToRlp(hexToUint8(to)) : bytesToRlp(to),
    intToRlp(valueWei),
    bytesToRlp(new Uint8Array(0)), // empty data
    bytesToRlp(new Uint8Array(0)), // empty access list
  ]

  // Encode as RLP list (unsigned: type 0x02 + RLP([fields]))
  const rlpFields = rlpEncodeList(fields)
  const unsignedTx = new Uint8Array([0x02, ...rlpFields])

  // Hash for signing: keccak256(0x02 || RLP([fields]))
  const txHash = keccak_256(unsignedTx)

  return {
    unsignedTxHex: '0x' + uint8ToHex(unsignedTx),
    txPayloadHash: txHash,
  }
}

/**
 * Assemble a signed EIP-1559 tx from the unsigned tx + MPC signature.
 */
export function assembleSignedEthTx(unsignedTxHex, mpcSignature, ethAddress) {
  // mpcSignature: { big_r: { affine_point: "0x..." }, s: { scalar: "0x..." }, recovery_id: number }
  const rHex = mpcSignature.big_r.affine_point.replace(/^0x/, '')
  const sHex = mpcSignature.s.scalar.replace(/^0x/, '')
  const v = 27 + mpcSignature.recovery_id

  const unsignedBytes = hexToUint8(unsignedTxHex.replace(/^0x/, ''))
  // Strip the 0x02 type byte for re-encoding
  const rlpData = unsignedBytes.slice(1)

  // Decode the RLP list to get the fields
  const decoded = rlpDecode(rlpData)
  // Add signature fields: [v, r, s]
  const signedFields = [...decoded, intToRlp(v), bytesToRlp(hexToUint8(rHex)), bytesToRlp(hexToUint8(sHex))]

  const signedRlp = rlpEncodeList(signedFields)
  const signedTx = new Uint8Array([0x02, ...signedRlp])

  return '0x' + uint8ToHex(signedTx)
}

/**
 * Broadcast a signed ETH tx to the network.
 */
export async function broadcastEthTx(signedTxHex) {
  return ethRpc('eth_sendRawTransaction', [signedTxHex])
}

/**
 * Build the MPC sign args JSON for an ETH tx payload hash.
 */
export function buildMpcSignArgs(payloadHash, path = 'ethereum,1') {
  return JSON.stringify({
    request: {
      payload: Array.from(payloadHash),
      path,
      key_version: 0,
    },
  })
}

/**
 * Build the full PromiseDAG JSON for w_execute_signed with MPC sign.
 */
export function buildExecuteSignedArgs({ accountId, signArgsB64, path, created_at_iso }) {
  const nonce = Math.floor(Math.random() * 0xFFFFFFFF)
  return {
    msg: {
      chain_id: CHAIN_ID,
      signer_id: accountId,
      nonce,
      created_at: created_at_iso,
      timeout_secs: 600,
      request: {
        ops: [],
        out: {
          after: [],
          then: [{
            receiver_id: MPC_CONTRACT,
            actions: [{
              action: 'function_call',
              function_name: 'sign',
              args: signArgsB64,
              deposit: '1',
              min_gas: '200000000000000',
              gas_weight: '0',
            }],
          }],
        },
      },
    },
    // proof will be added by the caller (after passkey signing)
  }
}

/**
 * Build the borsh-serialized RequestMessage with PromiseDAG.
 * This is needed for the challenge hash computation.
 */
export function borshRequestMessageWithDAG(msg) {
  const signArgsBytes = new TextEncoder().encode(msg.signArgsJson)
  return concat(
    borshString(CHAIN_ID),
    borshString(msg.signer_id),
    borshU32(msg.nonce),
    borshU32(msg.created_at_ts),
    borshU32(600), // timeout
    borshU32(0), // 0 ops
    // PromiseDAG.after
    borshU32(0),
    // PromiseDAG.then
    borshU32(1),
    // PromiseSingle.receiver_id
    borshString(MPC_CONTRACT),
    // PromiseSingle.refund_to: None
    new Uint8Array([0]),
    // PromiseSingle.actions
    borshU32(1),
    // PromiseAction::FunctionCall = variant 2
    new Uint8Array([2]),
    borshString('sign'),
    borshU32(signArgsBytes.length),
    signArgsBytes,
    // deposit: NearToken (u128)
    borshU128(1n),
    // gas: Gas (u64)
    borshU64(200_000_000_000_000n),
    // gas_weight: u64
    borshU64(0n),
  )
}

function borshU64(n) {
  const buf = new Uint8Array(8)
  new DataView(buf.buffer).setBigUint64(0, BigInt(n), true)
  return buf
}

function borshU128(n) {
  const lo = BigInt(n) & ((1n << 64n) - 1n)
  const hi = BigInt(n) >> 64n
  const buf = new Uint8Array(16)
  new DataView(buf.buffer).setBigUint64(0, lo, true)
  new DataView(buf.buffer).setBigUint64(8, BigInt(hi), true)
  return buf
}

// ─── RLP Encoding (minimal for EIP-1559 tx) ────────────────

function intToRlp(n) {
  if (n === 0n || n === 0) return bytesToRlp(new Uint8Array(0))
  const big = BigInt(n)
  const bytes = []
  let tmp = big
  while (tmp > 0n) { bytes.unshift(Number(tmp & 0xffn)); tmp >>= 8n }
  return bytesToRlp(new Uint8Array(bytes))
}

function bytesToRlp(bytes) {
  if (bytes.length === 1 && bytes[0] < 0x80) return new Uint8Array([bytes[0]])
  if (bytes.length < 56) {
    return new Uint8Array([0x80 + bytes.length, ...bytes])
  }
  const lenBytes = encodeLength(bytes.length)
  return new Uint8Array([0x80 + 55 + lenBytes.length, ...lenBytes, ...bytes])
}

function encodeLength(len) {
  const bytes = []
  let tmp = len
  while (tmp > 0) { bytes.unshift(tmp & 0xff); tmp >>= 8 }
  return new Uint8Array(bytes)
}

function rlpEncodeList(items) {
  // Concatenate all RLP-encoded items
  const parts = items.map(i => {
    if (i instanceof Uint8Array) return i
    return new Uint8Array(0)
  })
  const totalLen = parts.reduce((s, p) => s + p.length, 0)
  const payload = new Uint8Array(totalLen)
  let off = 0
  for (const p of parts) { payload.set(p, off); off += p.length }

  if (totalLen < 56) {
    return new Uint8Array([0xc0 + totalLen, ...payload])
  }
  const lenBytes = encodeLength(totalLen)
  return new Uint8Array([0xc0 + 55 + lenBytes.length, ...lenBytes, ...payload])
}

function rlpDecode(data) {
  const [result] = rlpDecodeAt(data, 0)
  return result
}

function rlpDecodeAt(data, offset) {
  const b = data[offset]
  if (b < 0x80) {
    // Single byte
    return [new Uint8Array([b]), offset + 1]
  } else if (b <= 0xb7) {
    // Short string
    const len = b - 0x80
    return [data.slice(offset + 1, offset + 1 + len), offset + 1 + len]
  } else if (b <= 0xbf) {
    // Long string
    const lenLen = b - 0xb7
    const len = readBeInt(data, offset + 1, lenLen)
    return [data.slice(offset + 1 + lenLen, offset + 1 + lenLen + len), offset + 1 + lenLen + len]
  } else if (b <= 0xf7) {
    // Short list
    const len = b - 0xc0
    const items = []
    let pos = offset + 1
    const end = pos + len
    while (pos < end) {
      const [item, newPos] = rlpDecodeAt(data, pos)
      items.push(item)
      pos = newPos
    }
    return [items, end]
  } else {
    // Long list
    const lenLen = b - 0xf7
    const len = readBeInt(data, offset + 1, lenLen)
    const items = []
    let pos = offset + 1 + lenLen
    const end = pos + len
    while (pos < end) {
      const [item, newPos] = rlpDecodeAt(data, pos)
      items.push(item)
      pos = newPos
    }
    return [items, end]
  }
}

function readBeInt(data, offset, len) {
  let n = 0
  for (let i = 0; i < len; i++) n = n * 256 + data[offset + i]
  return n
}

// ─── Session Keys ──────────────────────────────────────────

/**
 * Generate an ed25519 keypair for session key use.
 * Uses Web Crypto API (SubtleCrypto) — available in all modern browsers.
 * Returns { publicKey: string (NEAR base58), privateKey: CryptoKey, publicKeyBytes: Uint8Array }
 */
export async function generateSessionKeyPair() {
  // Generate extractable first to get raw public key bytes for the contract
  const extractable = await crypto.subtle.generateKey(
    { name: 'Ed25519' },
    true, // extractable — needed to export public key
    ['sign'],
  )

  const publicKeyBuffer = await crypto.subtle.exportKey('raw', extractable.publicKey)
  const publicKeyBytes = new Uint8Array(publicKeyBuffer)
  const publicKeyB58 = 'ed25519:' + base58Encode(publicKeyBytes)

  // Re-import private key as non-extractable for secure storage
  const jwk = await crypto.subtle.exportKey('jwk', extractable.privateKey)
  const privateKey = await crypto.subtle.importKey(
    'jwk', jwk, { name: 'Ed25519' }, false, ['sign'], // non-extractable
  )

  return {
    publicKey: publicKeyB58,
    privateKey, // non-extractable — can sign, can't be read back
    publicKeyBytes,
  }
}

/**
 * Sign a message with an ed25519 session key.
 * Returns base58-encoded signature (64 bytes).
 */
export async function signWithSessionKey(privateKey, messageBytes) {
  const signature = await crypto.subtle.sign(
    { name: 'Ed25519' },
    privateKey,
    messageBytes,
  )
  return base58Encode(new Uint8Array(signature))
}

/**
 * Fetch all session keys from the wallet contract.
 */
export async function getSessionKeys(accountId) {
  return nearView(accountId, 'w_session_keys')
}

/**
 * Fetch a specific session key by ID.
 */
export async function getSessionKey(accountId, sessionKeyId) {
  return nearView(accountId, 'w_session_key', { session_key_id: sessionKeyId })
}

// ─── Session Key Storage (IndexedDB) ─────────────────────

const IDB_NAME = 'passkey-wallet'
const IDB_STORE = 'session-keys'
const IDB_VERSION = 1

function openSessionDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, IDB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.createObjectStore(IDB_STORE) // key = "accountId:sessionKeyId"
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

/**
 * Save session key to IndexedDB.
 * Private key is a non-extractable CryptoKey — can sign, can't be read out.
 * Metadata (public key, timestamps) stored alongside.
 */
export async function saveSessionKey(sessionKeyId, keyPair, accountId) {
  const db = await openSessionDB()
  const storeKey = `${accountId}:${sessionKeyId}`
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite')
    tx.objectStore(IDB_STORE).put({
      sessionKeyId,
      publicKey: keyPair.publicKey,
      privateKey: keyPair.privateKey, // non-extractable CryptoKey
      accountId,
      createdAt: Date.now(),
    }, storeKey)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

/**
 * Load a session key from IndexedDB.
 * Returns the non-extractable CryptoKey ready for signing.
 */
export async function loadSessionKey(sessionKeyId, accountId) {
  const db = await openSessionDB()
  const storeKey = `${accountId}:${sessionKeyId}`
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readonly')
    const req = tx.objectStore(IDB_STORE).get(storeKey)
    req.onsuccess = () => resolve(req.result || null)
    req.onerror = () => reject(req.error)
  })
}

/**
 * Remove a session key from IndexedDB.
 */
export async function removeSessionKey(sessionKeyId, accountId) {
  const db = await openSessionDB()
  const storeKey = `${accountId}:${sessionKeyId}`
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite')
    tx.objectStore(IDB_STORE).delete(storeKey)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

/**
 * Borsh-serialize a RequestMessage with ops (for CreateSession/RevokeSession).
 * The ops are serialized as borsh WalletOp variants.
 *
 * WalletOp::CreateSession { session_key_id, public_key, ttl_secs } = discriminant 3
 * WalletOp::RevokeSession { session_key_id } = discriminant 4
 *
 * struct RequestMessage {
 *   chain_id, signer_id, nonce, created_at, timeout,
 *   request: { ops: Vec<WalletOp>, out: PromiseDAG }
 * }
 */
export function borshRequestMessageWithOps(msg) {
  const opsParts = []

  for (const op of msg.ops) {
    if (op.type === 'CreateSession') {
      // Discriminant 3
      opsParts.push(new Uint8Array([3]))
      opsParts.push(borshString(op.session_key_id))
      opsParts.push(borshString(op.public_key))
      opsParts.push(borshU32(op.ttl_secs))
    } else if (op.type === 'RevokeSession') {
      // Discriminant 4
      opsParts.push(new Uint8Array([4]))
      opsParts.push(borshString(op.session_key_id))
    }
  }

  return concat(
    borshString(msg.chain_id),
    borshString(msg.signer_id),
    borshU32(msg.nonce),
    borshU32(msg.created_at),
    borshU32(msg.timeout),
    borshU32(msg.ops.length),
    ...opsParts,
    // PromiseDAG: empty after + empty then
    borshU32(0),
    borshU32(0),
  )
}

/**
 * Build the JSON args for w_execute_signed with a CreateSession or RevokeSession op.
 * This goes through the passkey auth flow (same as handleSend/handleTestSign).
 */
export function buildSessionOpArgs({ accountId, ops, created_at_iso }) {
  const nonce = Math.floor(Math.random() * 0xFFFFFFFF)
  return {
    msg: {
      chain_id: CHAIN_ID,
      signer_id: accountId,
      nonce,
      created_at: created_at_iso,
      timeout_secs: 600,
      request: {
        ops: ops.map(op => {
          if (op.type === 'CreateSession') {
            return { op: 'create_session', session_key_id: op.session_key_id, public_key: op.public_key, ttl_secs: op.ttl_secs }
          }
          return { op: 'revoke_session', session_key_id: op.session_key_id }
        }),
        out: { after: [], then: [] },
      },
    },
  }
}
