#!/usr/bin/env node
/**
 * agent-near-tx.mjs — agent-side NIP-46 client: request the wallet bunker
 * to execute NEAR actions through the wallet contract.
 *
 * Usage: node scripts/agent-near-tx.mjs <bunker-npub-or-hex> '<actions-json>'
 * Example:
 *   node scripts/agent-near-tx.mjs npub1... \
 *     '[{"action":"FunctionCall","receiver_id":"pool7.clmm5-51fe5a.testnet","function_name":"get_state","args":"{}","deposit":"0"}]'
 *
 * The request is NIP-44 encrypted to the bunker's key and published as kind:24133.
 * The human approves in the wallet app; we poll for the encrypted response.
 */
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import * as nip19 from 'nostr-tools/nip19'
import * as nip44 from 'nostr-tools/nip44'
import { SimplePool } from 'nostr-tools/pool'

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

const pool = new SimplePool()
const convoKey = nip44.getConversationKey(sk, bunkerPub)
const content = nip44.encrypt(request, convoKey)

const event = finalizeEvent(
  { kind: KIND_BUNKER, created_at: Math.floor(Date.now() / 1000), tags: [['p', bunkerPub]], content },
  sk,
)

await Promise.any(pool.publish(RELAYS, event))
console.log(`request ${reqId} published — waiting for approval in the wallet app…`)

let lastSeenIds = new Set()
let sub = null
function subscribeFresh() {
  if (sub) try { sub.close([]) } catch { /* already gone */ }
  sub = pool.subscribeMany(
    RELAYS,
    [{ kinds: [KIND_BUNKER], '#p': [myPub], since: Math.floor(Date.now() / 1000) - 60 }],
    {
      onevent: (e) => {
        if (e.pubkey !== bunkerPub) return
        if (lastSeenIds.has(e.id)) return
        lastSeenIds.add(e.id)
        try {
          const key = nip44.getConversationKey(sk, bunkerPub)
          const plain = nip44.decrypt(e.content, key)
          const parsed = JSON.parse(plain)
          // responses come as ["response"-ish] or {id, result|error}
          const id = Array.isArray(parsed) ? parsed[1] : parsed.id
          if (id !== reqId) return
          const result = Array.isArray(parsed) ? parsed[2] : parsed.result
          const error = Array.isArray(parsed) ? null : parsed.error
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
          clearInterval(reup)
          pool.close(RELAYS)
          process.exit(error ? 3 : 0)
        } catch (err) {
          // not for us / undecryptable
        }
      },
      oneose: () => {},
    },
  )
}
// Zombie-socket fix: relays silently drop idle subscriber sockets, so re-open
// the subscription every 5s with a 60s lookback; ids dedupe replays.
subscribeFresh()
const reup = setInterval(subscribeFresh, 5000)

setTimeout(() => {
  console.error('timeout: no response in 5 minutes (is the bunker listening? did you approve?)')
  process.exit(4)
}, 5 * 60 * 1000)
