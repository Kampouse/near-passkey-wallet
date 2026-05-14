const bs58 = require("bs58").default;
const crypto = require("crypto");
const tweetnacl = require("tweetnacl");

// Simulate contract's view of the data
// Contract receives JSON, parses it, then borsh-serializes

// JSON args from the failed transaction:
const jsonArgs = {
  msg: {
    chain_id: "mainnet",
    signer_id: "f3if43kong43jong3io4ng34ui.testnet",
    nonce: 1021582992,
    created_at: "2026-05-14T22:07:18Z",
    timeout_secs: 300,
    request: {
      ops: [],
      out: { after: [], then: [] }
    }
  },
  session_key_id: "session-1778796450784",
  signature: "5RPSJ4wKuSApKDEEWuL1ZxfJcnX92wVX3kAHP18dAbzao9DmWBKMB9KEUDREk73MPTF7nzfH2bVtvS18qarC1zse"
};

// Convert ISO created_at to timestamp (as contract does)
const created_at_ts = Math.floor(new Date(jsonArgs.msg.created_at).getTime() / 1000);
console.log("created_at timestamp:", created_at_ts);

// Borsh encode (same as frontend)
function borshU32(n) {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(n, 0);
  return buf;
}

function borshString(s) {
  const encoded = Buffer.from(s, "utf8");
  return Buffer.concat([borshU32(encoded.length), encoded]);
}

function borshRequestMessage(msg) {
  return Buffer.concat([
    borshString(msg.chain_id),
    borshString(msg.signer_id),
    borshU32(msg.nonce),
    borshU32(msg.created_at),  // u32 timestamp
    borshU32(msg.timeout),     // u32 seconds
    borshU32(0),               // ops.len = 0
    borshU32(0),               // out.after.len = 0
    borshU32(0),               // out.then.len = 0
  ]);
}

const borshBytes = borshRequestMessage({
  chain_id: jsonArgs.msg.chain_id,
  signer_id: jsonArgs.msg.signer_id,
  nonce: jsonArgs.msg.nonce,
  created_at: created_at_ts,
  timeout: jsonArgs.msg.timeout_secs,
});

console.log("Borsh bytes:", borshBytes.toString("hex"));
console.log("Borsh length:", borshBytes.length);

const msgHash = crypto.createHash("sha256").update(borshBytes).digest();
console.log("Message hash:", msgHash.toString("hex"));

// Verify signature
const pkB58 = "5jk42D4s2CMvmkyBUXbf6FAExoB7k72TCYSxvKA1wVfX";
const pkBytesFromContract = bs58.decode(pkB58);
const sigBytes = bs58.decode(jsonArgs.signature);
console.log("Signature length:", sigBytes.length);

const valid = tweetnacl.sign.detached.verify(msgHash, sigBytes, pkBytesFromContract);
console.log("Signature valid:", valid);