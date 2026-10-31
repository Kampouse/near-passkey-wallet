// Probe: does the '#p' tag filter return events on these relays?
import WebSocket from 'ws'

const BUNKER = 'c140c000443969ac0cafb2a3d9115d9959578c09cdd05fa62d986d74b50881bb'
const AGENT = process.argv[2] // current agent pubkey
const SINCE = Math.floor(Date.now() / 1000) - 7200
const RELAYS = ['wss://relay.primal.net', 'wss://nos.lol']

for (const url of RELAYS) {
  const ws = new WebSocket(url)
  ws.on('open', () => {
    // same shape nostr-tools sends for the agent subscription
    ws.send(JSON.stringify(['REQ', 'p-tag-test', { kinds: [24133], '#p': [AGENT], since: SINCE }]))
  })
  ws.on('message', (data) => {
    const m = JSON.parse(data.toString())
    if (m[0] === 'EVENT') console.log(url, 'HIT:', m[2].id.slice(0, 12), 'tags:', JSON.stringify(m[2].tags))
    else if (m[0] === 'EOSE') console.log(url, 'EOSE — nothing more')
    else if (m[0] === 'AUTH') console.log(url, 'AUTH challenge:', JSON.stringify(m.slice(1)).slice(0, 100))
    else if (m[0] === 'CLOSED') console.log(url, 'CLOSED:', JSON.stringify(m.slice(1)).slice(0, 120))
  })
  ws.on('error', (e) => console.log(url, 'ERR:', e.message))
  setTimeout(() => ws.close(), 12000)
}
setTimeout(() => process.exit(0), 14000)
