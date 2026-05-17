import { NEAR_RPC, RELAY_URL } from './constants.js';

// ─── NEAR RPC ───────────────────────────────────────────

export async function nearView(
  contractId: string,
  method: string,
  args: Record<string, unknown> = {},
): Promise<any> {
  const argsB64 = btoa(JSON.stringify(args));
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
  });
  const data = await res.json();
  if (data.error) throw new Error(`RPC error: ${JSON.stringify(data.error)}`);
  const bytes = new Uint8Array(data.result.result);
  const str = new TextDecoder().decode(bytes);
  try { return JSON.parse(str); } catch { return str; }
}

// ─── Wallet Creation ────────────────────────────────────

/**
 * Create a root account wallet (e.g. "alice.testnet").
 * Uses the testnet helper API to create the account, then deploys wallet WASM.
 */
export async function createRootWallet(
  name: string,
  publicKey: string,
  wasmBase64: string,
): Promise<{ accountId: string; deployTx: string; initTx: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120_000); // 2 min timeout

  try {
    // Step 1: Create the account via relay
    const createRes = await fetch(`${RELAY_URL}/create-root`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, public_key: publicKey }),
      signal: controller.signal,
    });
    const createData = await createRes.json();
    if (createData.error) throw new Error(`Create account failed: ${createData.error}`);

    const accountId = `${name}.testnet`;

    // Step 2: Deploy wallet WASM + init (can take 10-15s for block finality)
    const deployRes = await fetch(`${RELAY_URL}/deploy-wallet`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ account_id: accountId, public_key: publicKey, wasm_base64: wasmBase64 }),
      signal: controller.signal,
    });
    const deployData = await deployRes.json();
    if (deployData.error) throw new Error(`Deploy failed: ${deployData.error}`);

    return { accountId, deployTx: deployData.deploy_tx, initTx: deployData.init_tx };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Create a subaccount wallet (e.g. "alice.pwallet-factory.kampy.testnet").
 * Uses the factory contract to create + deploy + init in one call.
 */
export async function createSubaccountWallet(
  name: string,
  publicKey: string,
  wasmBase64: string,
): Promise<{ accountId: string; txHash: string }> {
  const res = await fetch(`${RELAY_URL}/create-subaccount`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, public_key: publicKey, wasm_base64: wasmBase64 }),
  });
  const data = await res.json();
  if (data.error) throw new Error(`Factory create failed: ${data.error}`);
  return { accountId: data.account_id, txHash: data.tx_hash };
}

/**
 * Check if a NEAR account name is available.
 */
export async function checkAccountAvailable(accountId: string): Promise<boolean> {
  try {
    await nearView(accountId, 'w_public_key');
    return false; // account exists
  } catch {
    return true; // account doesn't exist
  }
}

// ─── NEAR Account Balance ──────────────────────────────────

export async function getNearBalance(accountId: string): Promise<bigint> {
  const res = await fetch(NEAR_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'donotbananaman',
      method: 'query',
      params: {
        request_type: 'view_account',
        finality: 'final',
        account_id: accountId,
      },
    }),
  });
  const data = await res.json();
  if (data.error) throw new Error(`NEAR RPC error: ${JSON.stringify(data.error)}`);
  return BigInt(data.result.amount);
}

/**
 * Get the wallet WASM bytes as base64 (for passing to creation endpoints).
 * Fetches from a static URL — the WASM is stored in the app's public dir.
 */
export async function getWalletWasmBase64(): Promise<string> {
  const res = await fetch('/wallet-p256.wasm');
  if (!res.ok) throw new Error('Failed to load wallet WASM');
  const arrayBuffer = await res.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}
