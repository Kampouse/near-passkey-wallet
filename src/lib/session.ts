import type { SessionKeyPair, StoredSessionKey } from './types.js';
import { base58Encode } from './utils.js';

// ─── Session Keys ───────────────────────────────────────

/**
 * Generate an ed25519 keypair for session key use.
 * Uses Web Crypto API (SubtleCrypto) — available in all modern browsers.
 *
 * SECURITY: Private key is generated as NON-EXTRACTABLE.
 * - Cannot be exported to raw bytes (throws on exportKey)
 * - Can only be used for signing while in browser memory
 * - Stored in IndexedDB as CryptoKey handle (opaque reference)
 * - Attacker with XSS can only sign while tab is open, NOT exfiltrate the key
 *
 * Returns { publicKey: string (NEAR base58), privateKey: CryptoKey, publicKeyBytes: Uint8Array }
 */
export async function generateSessionKeyPair(): Promise<SessionKeyPair> {
  // Generate NON-EXTRACTABLE keypair for security
  // Private key cannot be exported, only used for signing
  const keyPair = await crypto.subtle.generateKey(
    { name: 'Ed25519' },
    false, // NON-extractable — key cannot be exported to bytes/JWK
    ['sign'],
  );

  const publicKeyBuffer = await crypto.subtle.exportKey('raw', keyPair.publicKey);
  const publicKeyBytes = new Uint8Array(publicKeyBuffer);
  const publicKeyB58 = 'ed25519:' + base58Encode(publicKeyBytes);

  // Private key is a CryptoKey handle, cannot be exported
  return {
    publicKey: publicKeyB58,
    privateKey: keyPair.privateKey, // CryptoKey handle, non-extractable
    publicKeyBytes,
  };
}

/**
 * Sign a message with an ed25519 session key.
 * Returns base58-encoded signature (64 bytes).
 */
export async function signWithSessionKey(privateKey: CryptoKey, messageBytes: Uint8Array): Promise<string> {
  const signature = await crypto.subtle.sign(
    { name: 'Ed25519' },
    privateKey,
    messageBytes as BufferSource,
  );
  return base58Encode(new Uint8Array(signature));
}

/**
 * Fetch all session keys from the wallet contract.
 */
export async function getSessionKeys(accountId: string): Promise<any> {
  const { nearView } = await import('./near.js');
  return nearView(accountId, 'w_session_keys');
}

/**
 * Fetch a specific session key by ID.
 */
export async function getSessionKey(accountId: string, sessionKeyId: string): Promise<any> {
  const { nearView } = await import('./near.js');
  return nearView(accountId, 'w_session_key', { session_key_id: sessionKeyId });
}

// ─── Session Key Storage (IndexedDB) ─────────────────────

const IDB_NAME = 'passkey-wallet';
const IDB_STORE = 'session-keys';
const IDB_VERSION = 3; // Bumped for CryptoKey storage format

export { IDB_NAME, IDB_STORE, IDB_VERSION };

export function openSessionDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.createObjectStore(IDB_STORE); // key = "accountId:sessionKeyId"
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Save a session key to IndexedDB.
 *
 * SECURITY: Stores the CryptoKey handle directly, NOT the raw key bytes.
 * - IndexedDB supports structured clone of CryptoKey objects
 * - The key remains non-extractable (cannot be exported)
 * - XSS attacker can only use it while the tab is open, cannot exfiltrate
 *
 * MIGRATION: Old records with `privateKeyJwk` are detected and flagged for re-creation.
 */
export async function saveSessionKey(
  sessionKeyId: string,
  keyPair: SessionKeyPair,
  accountId: string,
): Promise<void> {
  const db = await openSessionDB();
  const storeKey = `${accountId}:${sessionKeyId}`;
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put({
      sessionKeyId,
      publicKey: keyPair.publicKey,
      privateKey: keyPair.privateKey, // CryptoKey handle (non-extractable)
      accountId,
      createdAt: Date.now(),
      version: 1, // Version marker for future migrations
    }, storeKey);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Load a session key from IndexedDB.
 *
 * Returns the stored CryptoKey handle directly (no import needed).
 * Detects old JWK-format keys and returns null (caller must prompt re-creation).
 */
export async function loadSessionKey(
  sessionKeyId: string,
  accountId: string,
): Promise<StoredSessionKey | null> {
  const db = await openSessionDB();
  const storeKey = `${accountId}:${sessionKeyId}`;
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readonly');
    const req = tx.objectStore(IDB_STORE).get(storeKey);
    req.onsuccess = async () => {
      const record = req.result;
      if (!record) {
        resolve(null);
        return;
      }

      // MIGRATION: Detect old JWK-format keys
      if (record.privateKeyJwk && !record.privateKey) {
        // Old format - cannot securely use this key
        // Return special marker to indicate migration needed
        resolve({ ...record, needsMigration: true });
        return;
      }

      // New format - CryptoKey handle directly usable
      resolve(record);
    };
    req.onerror = () => reject(req.error);
  });
}

/**
 * Remove a session key from IndexedDB.
 */
export async function removeSessionKey(sessionKeyId: string, accountId: string): Promise<void> {
  const db = await openSessionDB();
  const storeKey = `${accountId}:${sessionKeyId}`;
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).delete(storeKey);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
