// NEAR wire watcher — polls balances of the wallet + lff2, prints deltas.
const RPC = 'https://rpc.testnet.near.org'
const ACCTS = { 'wallet(g3rg3)': 'g3rg3gl3k4gl34lg4l3.testnet', lff2: 'lff2.clmm5-51fe5a.testnet' }
const TRANSFER = 100000000000000000000000n
const prev = {}

async function probe(acct) {
  const r = await fetch(RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'query', params: { request_type: 'view_account', account_id: acct, finality: 'final' } }),
  })
  const j = await r.json()
  return j.result
}

async function tick() {
  for (const [label, acct] of Object.entries(ACCTS)) {
    try {
      const a = await probe(acct)
      if (!a) continue
      const amt = BigInt(a.amount)
      if (prev[label] !== undefined && amt !== prev[label].amt) {
        const d = amt - prev[label].amt
        const sign = d > 0n ? '+' : ''
        console.log(new Date().toISOString().slice(11, 19), label, 'delta', sign, d.toString(), '(' + Number(d / 10n ** 20n) / 1e4 + ' N)')
        if (label === 'lff2' && d === TRANSFER) console.log('>>> TRANSFER FROM AGENT REQUEST LANDED <<<')
      }
      prev[label] = { amt }
    } catch (e) { /* transient rpc errors ignored */ }
  }
}

console.log('NEAR WIRE WATCHER — watching wallet + lff2 every 2s (15 min window)')
setInterval(tick, 2000)
setTimeout(() => { console.log('watcher window closed'); process.exit(0) }, 900000)
