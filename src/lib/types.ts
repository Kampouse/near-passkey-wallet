export interface WalletState {
  nearAccountId: string;
  ethAddress: string;
  credentialId: string;
  credentialRawId: string; // base64
  credentialRawIdUint8: Uint8Array;
  derivedKey: string;
  path: string;
  activeSessionKeyId?: string;
}

export interface PasskeyCredential {
  id: string;
  rawId: Uint8Array;
  publicKey: { raw: Uint8Array; alg: number };
}

export interface PasskeySignature {
  authenticatorData: Uint8Array;
  clientDataJSON: string;
  signature: Uint8Array;
}

export interface MpcSignature {
  big_r: { affine_point: string };
  s: { scalar: string };
  recovery_id: number;
  scheme?: string;
}

export interface GasData {
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

export interface EthTx {
  unsignedTxHex: string;
  txPayloadHash: Uint8Array;
}

export type WalletOp =
  | { type: 'CreateSession'; session_key_id: string; public_key: string; ttl_secs: number }
  | { type: 'RevokeSession'; session_key_id: string }
  | { type: 'RevokeAllSessions' }
  | { type: 'SetBackupKey'; public_key: string }
  | { type: 'RemoveBackupKey' };

export interface SessionKeyPair {
  publicKey: string;
  privateKey: CryptoKey;
  publicKeyBytes: Uint8Array;
}

export interface StoredSessionKey {
  sessionKeyId: string;
  publicKey: string;
  privateKey: CryptoKey;
  accountId: string;
  createdAt: number;
  version: number;
  needsMigration?: boolean;
}

export type Screen = 'welcome' | 'naming' | 'creating' | 'login' | 'dashboard' | 'sending' | 'connect';
