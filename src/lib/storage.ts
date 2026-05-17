import type { WalletState } from './types.js';
import { STORAGE_KEY, CRED_MAP_KEY } from './constants.js';
import { base64ToUint8 } from './utils.js';

// ─── Persistence ────────────────────────────────────────

export function saveWalletState(state: WalletState): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    nearAccountId: state.nearAccountId,
    ethAddress: state.ethAddress,
    credentialId: state.credentialId,
    credentialRawId: state.credentialRawId, // base64
    derivedKey: state.derivedKey,
    path: state.path,
  }));
}

export function loadWalletState(): (WalletState & { credentialRawIdUint8: Uint8Array }) | null {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    const state = JSON.parse(raw) as WalletState & { credentialRawIdUint8?: Uint8Array };
    // Restore rawId from base64
    if (state.credentialRawId && typeof state.credentialRawId === 'string') {
      state.credentialRawIdUint8 = base64ToUint8(state.credentialRawId);
    }
    return state as WalletState & { credentialRawIdUint8: Uint8Array };
  } catch { return null; }
}

export function clearWalletState(): void {
  localStorage.removeItem(STORAGE_KEY);
}

// CredentialId → accountId + credentialRawId mapping
// Survives logout. Lets old passkeys (without embedded userHandle) login without typing.
export function saveCredentialMapping(credentialId: string, accountId: string, credentialRawId: string): void {
  const map = JSON.parse(localStorage.getItem(CRED_MAP_KEY) || '{}');
  map[credentialId] = { accountId, credentialRawId };
  localStorage.setItem(CRED_MAP_KEY, JSON.stringify(map));
}

export function lookupCredential(credentialId: string): { accountId: string; credentialRawId: Uint8Array | null } | null {
  const map = JSON.parse(localStorage.getItem(CRED_MAP_KEY) || '{}');
  const entry = map[credentialId];
  if (!entry) return null;
  return {
    accountId: entry.accountId,
    credentialRawId: entry.credentialRawId ? base64ToUint8(entry.credentialRawId) : null,
  };
}
