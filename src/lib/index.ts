// Re-export everything from all modules

// Types
export type {
  WalletState,
  PasskeyCredential,
  PasskeySignature,
  MpcSignature,
  GasData,
  EthTx,
  WalletOp,
  SessionKeyPair,
  StoredSessionKey,
  Screen,
} from './types.js';

// Constants
export {
  NEAR_RPC,
  MPC_CONTRACT,
  WALLET_CONTRACT,
  FACTORY_CONTRACT,
  ETH_RPC,
  BASE_RPC,
  SOL_RPC,
  RELAY_URL,
  CHAIN_ID,
  WALLET_DOMAIN,
  STORAGE_KEY,
  CRED_MAP_KEY,
} from './constants.js';

// Utils
export {
  base58Encode,
  base58Decode,
  uint8ToBase64url,
  base64ToUint8,
  uint8ToBase64,
  uint8ToHex,
  hexToUint8,
  concat,
  formatEthBalance,
  generateSecureNonce,
  base58ToBytes,
  bytesToHex,
  bytesToNpub,
  encodeCompactU16,
  concatBytes,
} from './utils.js';

// Passkey
export {
  createPasskey,
  signWithPasskey,
} from './passkey.js';

// Borsh
export {
  borshU32,
  borshString,
  borshU64,
  borshU128,
  borshRequestMessage,
  borshRequestMessageWithDAG,
  borshRequestMessageWithOps,
  borshRequestMessageWithSessionActions,
  computeChallenge,
  buildProof,
  derToRawP256,
} from './borsh.js';

// Near
export {
  nearView,
  createRootWallet,
  createSubaccountWallet,
  checkAccountAvailable,
  getWalletWasmBase64,
  getNearBalance,
} from './near.js';

// Ethereum
export {
  getEthBalance,
  getEthNonce,
  getEthGasPrice,
  getEthBlockNumber,
  nearPubkeyToEthAddress,
  deriveEthAddress,
  buildEthTx,
  assembleSignedEthTx,
  broadcastEthTx,
  buildMpcSignArgs,
  buildMpcSignArgsEdDSA,
} from './ethereum.js';

// Solana
export {
  deriveSolAddress,
  getSolBalance,
  getSolRecentBlockhash,
  getSolAccountInfo,
  buildSolTransferMessage,
  assembleSignedSolTx,
  broadcastSolTx,
} from './solana.js';

// Session
export {
  generateSessionKeyPair,
  signWithSessionKey,
  getSessionKeys,
  getSessionKey,
  saveSessionKey,
  loadSessionKey,
  removeSessionKey,
  openSessionDB,
  IDB_NAME,
  IDB_STORE,
  IDB_VERSION,
} from './session.js';

// Storage
export {
  saveWalletState,
  loadWalletState,
  clearWalletState,
  saveCredentialMapping,
  lookupCredential,
} from './storage.js';

// Relay
export {
  submitViaRelay,
  buildExecuteSignedArgs,
  buildSessionOpArgs,
} from './relay.js';

// Near Direct (session key RPC)
export {
  directFunctionCall,
  directExecuteSession,
  getAccessKey,
} from './nearDirect.js';
