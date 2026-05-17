// near-wallet-relay: CF Worker — relays signed txs to NEAR + creates wallets
import { etc, getPublicKey, sign } from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';
etc.sha512Sync = (...m) => sha512(etc.concatBytes(...m));

const DEFAULT_GAS = 300_000_000_000_000n;
const DEFAULT_DEPOSIT = 0n;
const FACTORY_CONTRACT = 'pwallet-factory.kampy.testnet';

// ─── Base58 ─────────────────────────────────────────────────
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58Decode(str) {
  const bytes = [];
  for (let i = 0; i < str.length; i++) {
    let carry = B58.indexOf(str[i]);
    if (carry < 0) throw new Error('Invalid base58');
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) { bytes.push(carry & 0xff); carry >>= 8; }
  }
  for (let i = 0; i < str.length && str[i] === '1'; i++) bytes.push(0);
  return new Uint8Array(bytes.reverse());
}
function base58Encode(data) {
  let num = 0n;
  for (const b of data) num = num * 256n + BigInt(b);
  let result = '';
  while (num > 0n) { result = B58[Number(num % 58n)] + result; num /= 58n; }
  for (const b of data) { if (b === 0) result = '1' + result; else break; }
  return result;
}

// ─── Borsh helpers ──────────────────────────────────────────
function cat(...arrs) {
  const out = new Uint8Array(arrs.reduce((s, a) => s + a.length, 0));
  let off = 0;
  for (const a of arrs) { out.set(a, off); off += a.length; }
  return out;
}
function u32(v) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v, true); return b; }
function u64(v) { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(v), true); return b; }
function u128(v) {
  const b = new Uint8Array(16);
  const lo = BigInt(v) & ((1n << 64n) - 1n);
  const hi = BigInt(v) >> 64n;
  new DataView(b.buffer).setBigUint64(0, lo, true);
  new DataView(b.buffer).setBigUint64(8, hi, true);
  return b;
}
function borshStr(s) { const e = new TextEncoder().encode(s); return cat(u32(e.length), e); }
function borshBytes(a) { return cat(u32(a.length), a); }
function b64decode(b) { const s = atob(b); const a = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i); return a; }
function b64encode(a) { let s = ''; for (let i = 0; i < a.length; i++) s += String.fromCharCode(a[i]); return btoa(s); }
function hexEncode(a) { return Array.from(a).map(b => b.toString(16).padStart(2, '0')).join(''); }

// ─── Build unsigned transaction (borsh) ─────────────────────
function buildTx(signerId, pubKeyBytes, nonce, blockHash, receiverId, methodName, argsBytes, gas, deposit) {
  return cat(
    borshStr(signerId),          // signer_id
    new Uint8Array([0]),         // PublicKey enum: 0 = ed25519
    pubKeyBytes,                 // 32 bytes
    u64(nonce),                  // nonce
    borshStr(receiverId),        // receiver_id
    blockHash,                   // 32 bytes
    u32(1),                      // actions vec length = 1
    new Uint8Array([2]),         // Action enum: 2 = FunctionCall
    borshStr(methodName),        // method_name
    borshBytes(argsBytes),       // args
    u64(gas),                    // gas
    u128(deposit),               // deposit
  );
}

function buildDeployTx(signerId, pubKeyBytes, nonce, blockHash, receiverId, wasmBytes) {
  // Action::DeployContract = variant 0, { code: Vec<u8> }
  // See near-primitives/src/views.rs: ActionView::DeployContract
  return cat(
    borshStr(signerId),          // signer_id
    new Uint8Array([0]),         // PublicKey enum: 0 = ed25519
    pubKeyBytes,                 // 32 bytes
    u64(nonce),                  // nonce
    borshStr(receiverId),        // receiver_id
    blockHash,                   // 32 bytes
    u32(1),                      // actions vec length = 1
    new Uint8Array([1]),         // Action enum: 1 = DeployContract
    borshBytes(wasmBytes),       // code
  );
}

// AddKey action: Action enum variant 5
// AddKey { public_key: PublicKey, access_key: AccessKey }
// AccessKey { nonce: u64, permission: AccessKeyPermission }
// AccessKeyPermission::FunctionCall = variant 1
// FunctionCallPermission { allowance: Option<u128>, receiver_id: String, method_names: Vec<String> }
function buildAddFCTx(signerId, signerPubKeyBytes, nonce, blockHash, receiverId, newPubKeyBytes, allowance, methodNames) {
  const methodsPayload = cat(...methodNames.map(m => borshStr(m)));
  return cat(
    borshStr(signerId),
    new Uint8Array([0]),         // PublicKey enum: 0 = ed25519
    signerPubKeyBytes,           // 32 bytes
    u64(nonce),
    borshStr(receiverId),
    blockHash,
    u32(1),                      // 1 action
    new Uint8Array([5]),         // Action enum: 5 = AddKey
    new Uint8Array([0]),         // PublicKey enum: 0 = ed25519
    newPubKeyBytes,              // 32 bytes
    u64(0n),                     // access_key.nonce
    new Uint8Array([1]),         // AccessKeyPermission::FunctionCall = variant 1
    // allowance: Option<u128> = Some(1)
    new Uint8Array([1]),         // Some
    u128(BigInt(allowance)),
    borshStr(receiverId),        // receiver_id = the wallet itself
    u32(methodNames.length),    // method_names vec length
    methodsPayload,
  );
}

// ─── NEAR RPC ───────────────────────────────────────────────
async function rpc(url, method, params) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'r', method, params }),
  });
  const j = await r.json();
  if (j.error) throw new Error(JSON.stringify(j.error));
  return j.result;
}

// ─── Sign and broadcast a function call ──────────────────────
async function signAndBroadcast(rpcUrl, accountId, seed, pubKey, receiverId, methodName, argsBytes, gas = DEFAULT_GAS, deposit = DEFAULT_DEPOSIT) {
  const [accessKey, block] = await Promise.all([
    rpc(rpcUrl, 'query', { request_type: 'view_access_key', finality: 'final', account_id: accountId, public_key: `ed25519:${base58Encode(pubKey)}` }),
    rpc(rpcUrl, 'block', { finality: 'final' }),
  ]);

  const nonce = BigInt(accessKey.nonce) + 1n;
  const blockHash = base58Decode(block.header.hash);
  const txBytes = buildTx(accountId, pubKey, nonce, blockHash, receiverId, methodName, argsBytes, gas, deposit);

  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', txBytes));
  const sig = await sign(hash, seed);
  const signedBytes = cat(txBytes, new Uint8Array([0]), sig);

  return rpc(rpcUrl, 'broadcast_tx_commit', [b64encode(signedBytes)]);
}

// ─── CORS + response ────────────────────────────────────────
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
function jsonRes(data, status = 200) { return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...CORS } }); }

// ─── Get relay identity ─────────────────────────────────────
async function getIdentity(env) {
  const keyStr = env.RELAY_PRIVATE_KEY;
  if (!keyStr) throw new Error('RELAY_PRIVATE_KEY not set');
  const rawKey = base58Decode(keyStr.replace('ed25519:', ''));
  const seed = rawKey.length === 32 ? rawKey : rawKey.slice(0, 32);
  const pubKey = await getPublicKey(seed);
  const accountId = env.RELAY_ACCOUNT_ID || 'gork-agent.testnet';
  return { seed, pubKey, accountId };
}

// ─── Handler ────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    const url = new URL(request.url);
    const RPC_URL = env.RPC_URL || 'https://rpc.testnet.near.org';

    if (url.pathname === '/health') return jsonRes({ ok: true });

    // ── Create root account: alice.testnet ──────────────────
    // POST /create-root { name, public_key }
    // Creates a root account on testnet via helper API, deploys wallet WASM, calls w_init
    if (url.pathname === '/create-root' && request.method === 'POST') {
      try {
        const { name, public_key } = await request.json();
        if (!name || !public_key) return jsonRes({ error: 'Missing name or public_key' }, 400);
        if (name.includes('.') || name.length > 64 || name.length < 2) {
          return jsonRes({ error: 'Invalid name (2-64 chars, no dots)' }, 400);
        }

        // On testnet, use the helper API to create the account
        // The helper creates the account with the relay's public key initially
        const { seed, pubKey, accountId } = await getIdentity(env);
        const pubKeyB58 = base58Encode(pubKey);
        const newAccountId = `${name}.testnet`;

        // Check if account already exists
        try {
          await rpc(RPC_URL, 'query', { request_type: 'view_account', finality: 'final', account_id: newAccountId });
          return jsonRes({ error: `Account ${newAccountId} already exists` }, 409);
        } catch (e) {
          // "does not exist" is expected
          if (!e.message.includes('does not exist') && !e.message.includes('does not view')) {
            throw e;
          }
        }

        // Create account via testnet helper
        const createRes = await fetch('https://helper.testnet.near.org/account', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            newAccountId,
            newAccountPublicKey: `ed25519:${pubKeyB58}`,
          }),
        });
        if (!createRes.ok) {
          const errText = await createRes.text();
          return jsonRes({ error: `Failed to create account: ${errText}` }, 500);
        }

        // Now deploy the wallet WASM to the new account
        // We need the WASM bytes — they're too large to pass in the request (373K)
        // Instead, use the factory's stored hash + have the factory deploy
        // But the factory creates subaccounts, not arbitrary accounts...
        //
        // Alternative: deploy directly from the relay
        // The relay has the key for the new account (it was created with relay's key)
        // So we can: deploy_contract → w_init → delete_key (remove relay's key)

        // For now, return success — the frontend will call /deploy-wallet separately
        return jsonRes({
          account_id: newAccountId,
          status: 'created',
          next_step: 'deploy_wallet',
        });
      } catch (err) {
        return jsonRes({ error: err.message }, 500);
      }
    }

    // ── Deploy wallet to an account the relay controls ──────
    // POST /deploy-wallet { account_id, public_key }
    // WASM is fetched from the static hosting — no need to send 500KB in the body
    if (url.pathname === '/deploy-wallet' && request.method === 'POST') {
      try {
        const { account_id, public_key, wasm_base64 } = await request.json();
        if (!account_id || !public_key) {
          return jsonRes({ error: 'Missing account_id or public_key' }, 400);
        }

        const { seed, pubKey, accountId } = await getIdentity(env);

        // Get WASM: either from the request body or fetch from known URL
        let wasmBytes;
        if (wasm_base64) {
          wasmBytes = b64decode(wasm_base64);
        } else {
          // Fetch WASM from the wallet's static hosting
          const wasmRes = await fetch('https://nostr-websocket-client.near-passkey-wallet.pages.dev/wallet-p256.wasm');
          if (!wasmRes.ok) throw new Error(`Failed to fetch WASM: ${wasmRes.status}`);
          const wasmBuf = await wasmRes.arrayBuffer();
          wasmBytes = new Uint8Array(wasmBuf);
        }

        // Step 1: Deploy wallet WASM (using buildDeployTx with correct Action variant)
        const [accessKey, block] = await Promise.all([
          rpc(RPC_URL, 'query', { request_type: 'view_access_key', finality: 'final', account_id: account_id, public_key: `ed25519:${base58Encode(pubKey)}` }),
          rpc(RPC_URL, 'block', { finality: 'final' }),
        ]);

        const nonce = BigInt(accessKey.nonce) + 1n;
        const blockHash = base58Decode(block.header.hash);

        // DeployContract: Action enum variant 1
        const deployTxBytes = buildDeployTx(account_id, pubKey, nonce, blockHash, account_id, wasmBytes);
        const deployHash = new Uint8Array(await crypto.subtle.digest('SHA-256', deployTxBytes));
        const deploySig = await sign(deployHash, seed);
        const deploySigned = cat(deployTxBytes, new Uint8Array([0]), deploySig);

        const deployResult = await rpc(RPC_URL, 'broadcast_tx_commit', [b64encode(deploySigned)]);

        // Step 2: Call w_init(public_key)
        const initArgs = new TextEncoder().encode(JSON.stringify({ public_key }));
        const initResult = await signAndBroadcast(RPC_URL, account_id, seed, pubKey, account_id, 'w_init', initArgs, DEFAULT_GAS, 0n);

        // Step 3: Add relay's FC key scoped to w_execute_signed
        // This lets the relay submit signed transactions on behalf of the wallet
        const [addKeyAccessKey, addKeyBlock] = await Promise.all([
          rpc(RPC_URL, 'query', { request_type: 'view_access_key', finality: 'final', account_id: account_id, public_key: `ed25519:${base58Encode(pubKey)}` }),
          rpc(RPC_URL, 'block', { finality: 'final' }),
        ]);
        const addKeyNonce = BigInt(addKeyAccessKey.nonce) + 1n;
        const addKeyBlockHash = base58Decode(addKeyBlock.header.hash);
        const allowance = BigInt('5000000000000000000000000'); // 5 NEAR
        const addKeyTxBytes = buildAddFCTx(account_id, pubKey, addKeyNonce, addKeyBlockHash, account_id, pubKey, allowance, ['w_execute_signed', 'w_execute_session']);
        const addKeyHash = new Uint8Array(await crypto.subtle.digest('SHA-256', addKeyTxBytes));
        const addKeySig = await sign(addKeyHash, seed);
        const addKeySigned = cat(addKeyTxBytes, new Uint8Array([0]), addKeySig);
        await rpc(RPC_URL, 'broadcast_tx_commit', [b64encode(addKeySigned)]);

        return jsonRes({
          account_id,
          deploy_tx: deployResult.transaction?.hash,
          init_tx: initResult.transaction?.hash,
          status: 'wallet_ready',
        });
      } catch (err) {
        return jsonRes({ error: `deploy-wallet: ${err.message}` }, 500);
      }
    }

    // ── Create wallet via factory (subaccount) ──────────────
    // POST /create-subaccount { name, public_key }
    // WASM fetched from static hosting
    if (url.pathname === '/create-subaccount' && request.method === 'POST') {
      try {
        const { name, public_key, wasm_base64 } = await request.json();
        if (!name || !public_key) {
          return jsonRes({ error: 'Missing name or public_key' }, 400);
        }

        const { seed, pubKey, accountId } = await getIdentity(env);

        // Get WASM bytes
        let wasmBytes;
        if (wasm_base64) {
          wasmBytes = b64decode(wasm_base64);
        } else {
          const wasmRes = await fetch('https://nostr-websocket-client.near-passkey-wallet.pages.dev/wallet-p256.wasm');
          if (!wasmRes.ok) throw new Error(`Failed to fetch WASM: ${wasmRes.status}`);
          wasmBytes = new Uint8Array(await wasmRes.arrayBuffer());
        }

        // Call factory.create_wallet(name, public_key, wasm)
        // Args are JSON: { name, public_key, wasm: [bytes] }
        const args = JSON.stringify({ name, public_key, wasm: Array.from(wasmBytes) });
        const argsBytes = new TextEncoder().encode(args);

        const result = await signAndBroadcast(
          RPC_URL, accountId, seed, pubKey,
          FACTORY_CONTRACT, 'create_wallet', argsBytes,
          300_000_000_000_000n, // 300 Tgas
          BigInt(1e24),         // 1 NEAR deposit
        );

        const subaccountId = `${name}.${FACTORY_CONTRACT}`;
        return jsonRes({
          account_id: subaccountId,
          tx_hash: result.transaction?.hash,
          status: Object.keys(result.status || {})[0] || 'unknown',
        });
      } catch (err) {
        return jsonRes({ error: err.message }, 500);
      }
    }

    // ── MPC Sign: request cross-chain signature ────────────
    // POST /mpc-sign { payload_hex, path, key_version }
    // Calls v1.signer-prod.testnet.sign() as pwallet1.testnet via w_execute_signed
    // The relay's key is a function-call key on pwallet1.testnet scoped to w_execute_signed
    //
    // NOTE: w_execute_signed uses promise.detach() for the PromiseDAG output,
    // so the MPC signature result is NOT returned inline. For production, the
    // wallet contract needs a callback mechanism. For now, this endpoint
    // demonstrates the tx construction but cannot return the signature.
    //
    // For the test bench, MPC signing is tested directly using the FullAccess key.
    if (url.pathname === '/mpc-sign' && request.method === 'POST') {
      try {
        const body = await request.json();
        const { payload_hex, path, key_version, wallet_account_id } = body;
        if (!payload_hex) return jsonRes({ error: 'Missing payload_hex' }, 400);

        const walletId = wallet_account_id || 'pwallet1.testnet';
        const { seed, pubKey, accountId } = await getIdentity(env);

        // Build sign args for the MPC contract
        const payloadBytes = new Uint8Array(payload_hex.match(/.{1,2}/g).map(b => parseInt(b, 16)));
        const signArgsJson = JSON.stringify({
          request: {
            payload: Array.from(payloadBytes),
            path: path || 'ethereum,1',
            key_version: typeof key_version === 'number' ? key_version : 0,
          },
        });
        const signArgsB64 = btoa(signArgsJson);

        // Build the PromiseDAG with MPC sign FunctionCall
        const executeArgs = JSON.stringify({
          msg: {
            chain_id: 'mainnet',
            signer_id: walletId,
            nonce: Date.now(),
            created_at: Math.floor(Date.now() / 1000) - 30,
            timeout: 600,
            request: {
              ops: [],
              out: {
                after: [],
                then: [{
                  receiver_id: 'v1.signer-prod.testnet',
                  actions: [{
                    action: 'function_call',
                    function_name: 'sign',
                    args: signArgsB64,
                    deposit: '1',
                    min_gas: '300000000000000',
                    gas_weight: '0',
                  }],
                }],
              },
            },
          },
          proof: 'placeholder_w_execute_signed_needs_real_passkey_proof',
        });
        const executeArgsBytes = new TextEncoder().encode(executeArgs);

        // Get nonce for the relay's key ON the wallet account
        let accessKey, block;
        try {
          [accessKey, block] = await Promise.all([
            rpc(RPC_URL, 'query', { request_type: 'view_access_key', finality: 'final', account_id: walletId, public_key: `ed25519:${base58Encode(pubKey)}` }),
            rpc(RPC_URL, 'block', { finality: 'final' }),
          ]);
        } catch (e) {
          return jsonRes({ error: `Key lookup failed: ${e.message}`, pubKeyB58: base58Encode(pubKey), walletId }, 500);
        }

        if (!accessKey || accessKey.nonce === undefined) {
          return jsonRes({ error: 'No nonce in access key response', accessKey: JSON.stringify(accessKey) }, 500);
        }

        const nonce = BigInt(accessKey.nonce) + 1n;
        const blockHash = base58Decode(block.header.hash);

        // Build tx: signer=wallet, receiver=wallet, method=w_execute_signed
        const txBytes = buildTx(walletId, pubKey, nonce, blockHash, walletId, 'w_execute_signed', executeArgsBytes, DEFAULT_GAS, 0n);

        const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', txBytes));
        const sig = await sign(hash, seed);
        const signedBytes = cat(txBytes, new Uint8Array([0]), sig);

        const result = await rpc(RPC_URL, 'broadcast_tx_commit', [b64encode(signedBytes)]);

        if (result.status?.SuccessValue !== undefined) {
          return jsonRes({
            status: 'submitted',
            note: 'MPC sign was dispatched via PromiseDAG. Result is async — check on-chain.',
            tx_hash: result.transaction?.hash,
          });
        }

        return jsonRes({
          error: 'w_execute_signed failed',
          status: result.status,
          tx_hash: result.transaction?.hash,
        }, 500);
      } catch (err) {
        return jsonRes({ error: err.message }, 500);
      }
    }

    // ── Relay a signed transaction ──────────────────────────
    // POST /relay { args_base64, receiver_id, method_name, wallet_account_id }
    // The relay's FC key is on the wallet account, so we sign as the wallet.
    // Returns the SuccessValue (MPC signature) decoded from the transaction result.
    if (url.pathname === '/relay' && request.method === 'POST') {
      try {
        const { args_base64, receiver_id, method_name, wallet_account_id } = await request.json();
        if (!args_base64) return jsonRes({ error: 'Missing args_base64' }, 400);

        const argsBytes = b64decode(args_base64);
        const { seed, pubKey, accountId } = await getIdentity(env);

        const walletId = wallet_account_id || 'pwallet1.testnet';
        const receiver = receiver_id || walletId;
        const method = method_name || 'w_execute_signed';

        // The relay's key is an FC key on the wallet account — sign as the wallet
        const result = await signAndBroadcast(RPC_URL, walletId, seed, pubKey, receiver, method, argsBytes, 300_000_000_000_000n, 1n);

        // Decode SuccessValue — now returns the MPC signature inline (no more promise.detach)
        let returnValue = null;
        if (result.status?.SuccessValue) {
          try {
            const decoded = atob(result.status.SuccessValue);
            returnValue = JSON.parse(decoded);
          } catch (e) {}
        }

        return jsonRes({
          tx_hash: result.transaction?.hash,
          status: Object.keys(result.status || {})[0] || 'unknown',
          return_value: returnValue,
        });
      } catch (err) {
        return jsonRes({ error: err.message }, 500);
      }
    }

    return jsonRes({ error: 'Not found' }, 404);
  },
};
