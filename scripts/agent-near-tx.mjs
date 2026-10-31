#!/usr/bin/env node
/**
 * agent-near-tx.mjs — agent-side NIP-46 client: request the wallet bunker
 * to execute NEAR actions through the wallet contract.
 *
 * Usage: node scripts/agent-near-tx.mjs <bunker-npub-or-hex> '<actions-json>'
 * Example:
 *   node scripts/agent-near-tx.mjs npub1... \
 *     '[{"action":"transfer","receiver_id":"lff2.clmm5-51fe5a.testnet","amount":"100000000000000000000000"}]'
 *
 * The request is NIP-44 encrypted to the bunker's key and published as kind:24133.
 * The human approves in the wallet app; we wait for the encrypted response.
 *
 * NOTE on transport: nostr-tools SimplePool.publish works, but its live
 * subscriptions silently deliver nothing on primal/nos.lol (a raw-WS REQ with
 * the identical filter returns the same events) — so the receive path uses
 * raw WebSockets with reconnect.
 */
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import * as nip19 from 'nostr-tools/nip19'
import * as nip44 from 'nostr-tools/nip44'
import { SimplePool } from 'nostr-tools/pool'
import WebSocket from 'ws'

const RELAYS = ['wss://relay.primal.net', 'wss://nos.lol', 'wss://relay.damus.io']
const KIND_BUNKER = 24133

const [bunkerId, actionsJson] = process.argv.slice(2)
if (!bunkerId || !actionsJson) {
  console.error('usage: agent-near-tx.mjs <bunker-npub|hex-pubkey> <actions-json>')
  process.exit(2)
}

let bunkerPub
if (bunkerId.startsWith('npub1')) {
  bunkerPub = nip19.decode(bunkerId).data
} else {
  bunkerPub = bunkerId
}

const actions = JSON.parse(actionsJson)
const sk = generateSecretKey()
const myPub = getPublicKey(sk)
console.log(`agent pubkey: ${myPub}`)
console.log(`bunker:       ${bunkerPub.slice(0, 16)}…`)
console.log(`requesting:   ${actions.length} action(s) via ${RELAYS.length} relays`)

const reqId = `agt_${Date.now()}`
const request = JSON.stringify({ id: reqId, method: 'sign_near_tx', params: [JSON.stringify({ actions })] })

// ── publish the request (SimplePool.publish works fine) ──
const pool = new SimplePool()
const convoKey = nip44.getConversationKey(sk, bunkerPub)
const content = nip44.encrypt(request, convoKey)
const event = finalizeEvent(
  { kind: KIND_BUNKER, created_at: Math.floor(Date.now() / 1000), tags: [['p', bunkerPub]], content },
  sk,
)
await Promise.any(pool.publish(RELAYS, event))
console.log(`request ${reqId} published — waiting for approval in the wallet app…`)

// ── receive the response via raw WebSockets (SimplePool subs are silent) ──
const seen = new Set()
let done = false
const sockets = []

function handleEvent(e) {
  if (done || seen.has(e.id)) return
  seen.add(e.id)
  if (e.pubkey !== bunkerPub) return
  try {
    const plain = nip44.decrypt(e.content, convoKey)
    const parsed = JSON.parse(plain)
    const id = Array.isArray(parsed) ? parsed[1] : parsed.id
    if (id !== reqId) return
    const result = Array.isArray(parsed) ? parsed[2] : parsed.result
    const error = Array.isArray(parsed) ? null : parsed.error
    done = true
    if (error) {
      console.error(`DENIED/ERROR: ${error}`)
    } else {
      console.log(`EXECUTED: ${result}`)
      try {
        const { tx_hash } = JSON.parse(result)
        console.log(`tx hash: ${tx_hash}`)
        console.log(`explorer: https://testnet.nearblocks.io/tx/${tx_hash}`)
      } catch { /* raw */ }
    }
    for (const s of sockets) try { s.close() } catch { /* */ }
    process.exit(error ? 3 : 0)
  } catch (err) {
    console.log(`[debug] event ${e.id.slice(0, 8)} handler error: ${err.message}`)
  }
}

function connect(relay) {
  const ws = new WebSocket(relay)
  sockets.push(ws)
  ws.on('open', () => {
    ws.send(JSON.stringify(['REQ', 'agt-resp', { kinds: [KIND_BUNKER], '#p': [myPub], since: Math.floor(Date.now() / 1000) - 120 }]))
  })
  ws.on('message', (data) => {
    try {
      const m = JSON.parse(data.toString())
      if (m[0] === 'EVENT' && m[2]) handleEvent(m[2])
      else if (m[0] === 'CLOSED') console.log(relay, 'sub closed:', String(m[1]).slice(0, 80))
    } catch { /* malformed frame */ }
  })
  ws.on('close', () => { if (!done) setTimeout(() => connect(relay), 2000) })
  ws.on('error', () => { /* reconnect happens on close */ })
}
for (const r of RELAYS) connect(r)

setTimeout(() => {
  console.error('timeout: no response in 5 minutes (is the bunker listening? did you approve?)')
  process.exit(4)
}, 5 * 60 * 1000)
