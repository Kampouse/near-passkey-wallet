import bs58 from 'bs58';
import { SOL_RPC, MPC_CONTRACT } from './constants.js';
import { encodeCompactU16, concatBytes } from './utils.js';

// ─── Solana Chain Support ───────────────────────────────

/**
 * Derive Solana address from NEAR account via MPC.
 * Solana uses Ed25519 (domain_id: 1 = FROST), NOT secp256k1 (domain_id: 0).
 * Path: "solana" → Ed25519 public key → base58 address
 */
export async function deriveSolAddress(
  nearAccountId: string,
  path: string = 'solana',
): Promise<{ derivedKey: string; solAddress: string }> {
  // Import nearView dynamically to avoid circular dep
  const { nearView } = await import('./near.js');

  // Ed25519 is domain 1 (FROST protocol), secp256k1 is domain 0 (CaitSith)
  const result = await nearView(MPC_CONTRACT, 'derived_public_key', {
    path,
    predecessor: nearAccountId,  // Account context for tweak derivation (NOT predecessor_id)
    domain_id: 1,  // 1 = Ed25519/FROST, 0 = Secp256k1/CaitSith
  });

  // MPC returns: "ed25519:Base58..." for domain 1
  // or "secp256k1:Base58..." for domain 0
  const publicKey = result;

  if (!publicKey || !publicKey.startsWith('ed25519:')) {
    throw new Error(`Invalid Solana derived key (expected Ed25519, got ${publicKey}). ` +
      `The MPC may not support Ed25519 domain. Check MPC contract version.`);
  }

  // The base58 part IS the Solana address (32 bytes Ed25519 public key)
  const solAddress = publicKey.replace('ed25519:', '');
  return { derivedKey: publicKey, solAddress };
}

/**
 * Get SOL balance via RPC.
 */
export async function getSolBalance(address: string): Promise<bigint> {
  const res = await fetch(SOL_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'getBalance',
      params: [address],
    }),
  });
  const data = await res.json();
  if (data.error) throw new Error(`SOL RPC: ${JSON.stringify(data.error)}`);
  // Balance in lamports (1 SOL = 1e9 lamports)
  return BigInt(data.result.value);
}

/**
 * Get recent blockhash for transaction.
 */
export async function getSolRecentBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: number }> {
  const res = await fetch(SOL_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'getLatestBlockhash',
      params: [{ commitment: 'finalized' }],
    }),
  });
  const data = await res.json();
  if (data.error) throw new Error(`SOL RPC: ${JSON.stringify(data.error)}`);
  return {
    blockhash: data.result.value.blockhash,
    lastValidBlockHeight: data.result.value.lastValidBlockHeight,
  };
}

/**
 * Get SOL account info (check if initialized).
 */
export async function getSolAccountInfo(address: string): Promise<any> {
  const res = await fetch(SOL_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'getAccountInfo',
      params: [address, { encoding: 'base64' }],
    }),
  });
  const data = await res.json();
  if (data.error) throw new Error(`SOL RPC: ${JSON.stringify(data.error)}`);
  return data.result.value;
}

/**
 * Build a Solana transfer transaction message.
 * Returns serialized transaction message bytes for MPC signing.
 *
 * Solana transfer = SystemProgram.transfer instruction
 * The message to sign is: header + accounts + blockhash + instructions
 */
export function buildSolTransferMessage(params: {
  from: string;
  to: string;
  lamports: bigint | number;
  recentBlockhash: string;
}): Uint8Array {
  const { from, to, lamports, recentBlockhash } = params;
  // Account addresses are base58 encoded, 32 bytes each
  const fromBytes = bs58.decode(from);
  const toBytes = bs58.decode(to);
  const systemProgramBytes = bs58.decode('11111111111111111111111111111111');

  // Recent blockhash is 32 bytes base58
  const blockhashBytes = bs58.decode(recentBlockhash);

  // Build compact-u16 array of accounts
  // Accounts: from, to, systemProgram (in that order, from is fee payer)
  const numAccounts = 3;
  const accounts = concatBytes(
    encodeCompactU16(numAccounts),
    fromBytes,
    toBytes,
    systemProgramBytes,
  );

  // Message header: 1 required signature (from), 0 readonly signed, 1 readonly unsigned (systemProgram)
  const header = new Uint8Array([1, 0, 1]);

  // Build instructions
  // SystemProgram.transfer({ from, to, lamports })
  // Instruction = { program_id_index, accounts, data }
  const programIdIndex = 2; // systemProgram is at index 2 in accounts array
  const fromAccountIndex = 0;
  const toAccountIndex = 1;
  const instructionAccounts = new Uint8Array([fromAccountIndex, toAccountIndex]);

  // Instruction data: 4-byte instruction discriminator (2 = Transfer) + 8-byte lamports
  const instructionData = new Uint8Array(12);
  const view = new DataView(instructionData.buffer);
  view.setUint32(0, 2, true); // Transfer instruction discriminator (little-endian)
  view.setBigUint64(4, BigInt(lamports), true); // lamports (little-endian)

  // Compact array of instructions (1 instruction)
  const instructions = concatBytes(
    new Uint8Array([1]), // 1 instruction
    new Uint8Array([programIdIndex]), // program_id_index
    encodeCompactU16(2), // num accounts
    instructionAccounts,
    encodeCompactU16(instructionData.length), // data length
    instructionData,
  );

  // Build complete message
  const message = concatBytes(
    header,
    accounts,
    blockhashBytes,
    instructions,
  );

  return message;
}

/**
 * Assemble a signed Solana transaction.
 * Format: <num_signatures> <signatures> <message>
 */
export function assembleSignedSolTx(message: Uint8Array, signature: string | Uint8Array): Uint8Array {
  // Transaction format:
  // 1 byte: num_required_signatures (1 for transfer)
  // 1 byte: num_readonly_signed_accounts (0)
  // 1 byte: num_readonly_unsigned_accounts (1 - system program)
  // Then: compact array of signatures, then message

  // For Ed25519, signature is 64 bytes
  const sigBytes = typeof signature === 'string'
    ? bs58.decode(signature)
    : signature;

  if (sigBytes.length !== 64) {
    throw new Error(`Invalid signature length: ${sigBytes.length}, expected 64`);
  }

  // Compact array of signatures
  const signatures = concatBytes(
    encodeCompactU16(1), // 1 signature
    sigBytes,
  );

  // Full transaction = signatures + message
  return concatBytes(signatures, message);
}

/**
 * Broadcast a signed Solana transaction.
 */
export async function broadcastSolTx(signedTxBytes: Uint8Array): Promise<string> {
  const txBase64 = btoa(String.fromCharCode(...signedTxBytes));

  const res = await fetch(SOL_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'sendTransaction',
      params: [txBase64, { encoding: 'base64' }],
    }),
  });
  const data = await res.json();
  if (data.error) throw new Error(`SOL RPC: ${JSON.stringify(data.error)}`);
  return data.result; // transaction signature
}
