import { RELAY_URL, WALLET_CONTRACT, CHAIN_ID, MPC_CONTRACT } from './constants.js';
import type { WalletOp } from './types.js';
import { generateSecureNonce } from './utils.js';

// ─── Relay Submission ───────────────────────────────────

/**
 * Submit a signed request to the wallet contract via the CF Worker relay.
 * The relay builds a NEAR tx and submits it to RPC.
 *
 * @param argsJson - JSON-encoded args for w_execute_signed: { msg, proof }
 * @returns {{ tx_hash: string, status: string }}
 */
export async function submitViaRelay(
  argsJson: string,
  walletAccountId: string,
  method: string = 'w_execute_signed',
): Promise<{ tx_hash: string; status: string }> {
  const argsBase64 = btoa(argsJson);
  const res = await fetch(`${RELAY_URL}/relay`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      method_name: method,
      args_base64: argsBase64,
      wallet_account_id: walletAccountId || WALLET_CONTRACT,
    }),
  });
  return res.json();
}

/**
 * Build the full PromiseDAG JSON for w_execute_signed with MPC sign.
 * SECURITY FIX: Uses generateSecureNonce() instead of Math.random().
 */
export function buildExecuteSignedArgs(params: {
  accountId: string;
  signArgsB64: string;
  path: string;
  created_at_ts: number;
}): { msg: Record<string, unknown> } {
  const { accountId, signArgsB64, created_at_ts } = params;
  const nonce = generateSecureNonce();
  const created_at = new Date(created_at_ts * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  return {
    msg: {
      chain_id: CHAIN_ID,
      signer_id: accountId,
      nonce,
      created_at,
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
  };
}

/**
 * Build the JSON args for w_execute_signed with a CreateSession, RevokeSession, RevokeAllSessions, SetBackupKey, or RemoveBackupKey op.
 * This goes through the passkey auth flow (same as handleSend/handleTestSign).
 * SECURITY FIX: Uses generateSecureNonce() instead of Math.random().
 */
export function buildSessionOpArgs(params: {
  accountId: string;
  ops: WalletOp[];
  created_at_ts: number;
}): { msg: Record<string, unknown> } {
  const { accountId, ops, created_at_ts } = params;
  const nonce = generateSecureNonce();
  const created_at = new Date(created_at_ts * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  return {
    msg: {
      chain_id: CHAIN_ID,
      signer_id: accountId,
      nonce,
      created_at,
      timeout_secs: 600,
      request: {
        ops: ops.map(op => {
          if (op.type === 'CreateSession') {
            return { op: 'create_session', session_key_id: op.session_key_id, public_key: op.public_key, ttl_secs: op.ttl_secs };
          }
          if (op.type === 'RevokeAllSessions') {
            return { op: 'revoke_all_sessions' };
          }
          if (op.type === 'SetBackupKey') {
            return { op: 'set_backup_key', public_key: op.public_key };
          }
          if (op.type === 'RemoveBackupKey') {
            return { op: 'remove_backup_key' };
          }
          return { op: 'revoke_session', session_key_id: op.session_key_id };
        }),
        out: { after: [], then: [] },
      },
    },
  };
}
