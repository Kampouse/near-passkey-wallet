// Raw relay probe — REQ kind-24133 events from the bunker pubkey, no nostr-tools.
import WebSocket from 'ws'

const bunkerPub = 'c140c000443969ac' // prefix for log matching
const BUNKER = process.argv[2] // full hex pubkey
const SINCE = Math.floor((Date.now() / 1000) - 3600)
const RELAYS = ['wss://relay.primal.net', 'wss://nos.lol', 'wss://relay.damus.io']

for (const url of RELAYS) {
  const ws = new WebSocket(url)
  const sub = JSON.stringify(['REQ', 'probe-' + Date.now(), { kinds: [24133], authors: [BUNKER], since: SINCE }])
  ws.on('open', () => {
    console.log(url, '→ OPEN, sending REQ')
    ws.send(sub)
  })
  ws.on('message', (data) => {
    const m = JSON.parse(data.toString())
    if (m[0] === 'EVENT' && m[2]) {
      const e = m[2]
      console.log(url, 'EVENT:', e.id.slice(0, 12), 'pub:', e.pubkey.slice(0, 10), 'tags:', JSON.stringify(e.tags), 'created:', e.created_at)
    } else if (m[0] === 'EOSE') {
      console.log(url, 'EOSE (end of stored events)')
    } else if (m[0] === 'NOTICE' || m[0] === 'CLOSED' || m[0] === 'AUTH') {
      console.log(url, m[0] + ':', JSON.stringify(m.slice(1)).slice(0, 140))
    }
  })
  ws.on('error', (err) => console.log(url, 'ERR:', err.message))
  ws.on('close', (c) => console.log(url, 'CLOSED', c))
  setTimeout(() => ws.close(), 15000)
}
setTimeout(() => { console.log('probe done'); process.exit(0) }, 17000)
