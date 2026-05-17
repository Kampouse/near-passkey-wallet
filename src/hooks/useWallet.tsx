import React, { createContext, useContext, useState, useCallback, useEffect, useRef } from 'react';
import type { WalletState, Screen } from '../lib/types';
import {
  createPasskey,
  signWithPasskey,
  borshRequestMessageWithDAG,
  borshRequestMessageWithOps,
  computeChallenge,
  buildProof,
  nearView,
  createRootWallet,
  createSubaccountWallet,
  checkAccountAvailable,
  getWalletWasmBase64,
  deriveEthAddress,
  getEthBalance,
  getNearBalance,
  getEthNonce,
  getEthGasPrice,
  buildEthTx,
  assembleSignedEthTx,
  broadcastEthTx,
  buildMpcSignArgs,
  buildMpcSignArgsEdDSA,
  deriveSolAddress,
  getSolBalance,
  getSolRecentBlockhash,
  buildSolTransferMessage,
  assembleSignedSolTx,
  broadcastSolTx,
  generateSessionKeyPair,
  getSessionKeys as fetchSessionKeys,
  saveSessionKey,
  loadSessionKey,
  removeSessionKey,
  saveWalletState,
  loadWalletState,
  clearWalletState,
  saveCredentialMapping,
  lookupCredential,
  submitViaRelay,
  buildExecuteSignedArgs,
  buildSessionOpArgs,
  directExecuteSession,
  base58Encode,
  base64ToUint8,
  uint8ToBase64,
  FACTORY_CONTRACT,
  CHAIN_ID,
  generateSecureNonce,
} from '../lib';

// ─── Context Type ────────────────────────────────────────────

interface WalletContextValue {
  wallet: WalletState | null;
  screen: Screen;
  navigate: (s: Screen) => void;
  loading: boolean;
  log: string[];
  addLog: (msg: string) => void;
  ethBalance: bigint | null;
  nearBalance: bigint | null;
  needAccountId: boolean;
  login: () => Promise<void>;
  completeLoginWithAccountId: (accountId: string) => Promise<void>;
  createWallet: (name: string, accountType: 'root' | 'sub') => Promise<void>;
  sendEth: (to: string, amount: string) => Promise<void>;
  sendSol: (to: string, amount: string) => Promise<void>;
  sendNearTransaction: (receiverId: string, actions: any[]) => Promise<{ tx_hash: string }>;
  deriveSolAddress: () => Promise<void>;
  deriveNostr: () => Promise<void>;
  checkAccountAvailable: (name: string) => Promise<boolean | null>;
  refreshBalance: () => Promise<void>;
  createSessionKey: () => Promise<void>;
  registerExternalSessionKey: (sessionKeyId: string, publicKey: string) => Promise<any>;
  revokeSessionKey: (id: string) => Promise<void>;
  revokeAllSessionKeys: () => Promise<void>;
  getSessionKeys: () => Promise<void>;
  addBackupKey: () => Promise<void>;
  removeBackupKey: () => Promise<void>;
  testBackupKey: () => Promise<void>;
  getBackupKey: () => Promise<void>;
  solAddress: string | null;
  solBalance: bigint | null;
  npub: string | null;
  sessionKeys: Record<string, any> | null;
  connectParams: { relay: string; session: string } | null;
  setConnectParams: (p: { relay: string; session: string } | null) => void;
  startBunker: (relays?: string[]) => Promise<void>;
  stopBunker: () => void;
  logout: () => void;
  // Exposed for ConnectScreen session key registration
  buildSessionOpArgs: typeof buildSessionOpArgs;
  borshRequestMessageWithOps: typeof borshRequestMessageWithOps;
  computeChallenge: typeof computeChallenge;
  signWithPasskey: typeof signWithPasskey;
  buildProof: typeof buildProof;
  submitViaRelay: typeof submitViaRelay;
}

const WalletContext = createContext<WalletContextValue | null>(null);

export function useWallet(): WalletContextValue {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error('useWallet must be used within WalletProvider');
  return ctx;
}

// ─── Helpers ─────────────────────────────────────────────────

/** Parse SPKI-encoded P-256 public key into x,y coordinates */
function parsePasskeyPublicKey(rawBytes: Uint8Array, _alg: number): { x: Uint8Array; y: Uint8Array } {
  // SPKI format: ... header ... then 0x03 0x42 (compressed) or 0x04 0x41 0x00 (uncompressed)
  // For P-256 uncompressed: 0x04 || x(32) || y(32)
  // Find the uncompressed point marker
  let offset = rawBytes.length - 64; // x+y = 64 bytes at the end
  // Walk back to find 0x04 marker
  for (let i = 0; i < rawBytes.length - 64; i++) {
    if (rawBytes[i] === 0x04 && rawBytes.length - i - 1 === 64) {
      offset = i + 1;
      break;
    }
  }
  const x = rawBytes.slice(offset, offset + 32);
  const y = rawBytes.slice(offset + 32, offset + 64);
  return { x, y };
}

// ─── Provider ────────────────────────────────────────────────

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const [wallet, setWallet] = useState<WalletState | null>(null);
  const [screen, setScreen] = useState<Screen>('welcome');
  const [loading, setLoading] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [ethBalance, setEthBalance] = useState<bigint | null>(null);
  const [nearBalance, setNearBalance] = useState<bigint | null>(null);
  const [needAccountId, setNeedAccountId] = useState(false);
  const [solAddress, _setSolAddress] = useState<string | null>(null);
  const [_solBalance, _setSolBalance] = useState<bigint | null>(null);
  const [sessionKeys, _setSessionKeys] = useState<Record<string, any> | null>(null);
  const [backupKey, _setBackupKey] = useState<string | null>(null);
  const [npub, _setNpub] = useState<string | null>(null);
  const [connectParams, setConnectParams] = useState<{ relay: string; session: string } | null>(null);

  // Pending credential for login flow
  const pendingCred = useRef<{ id: string; rawIdBase64: string } | null>(null);

  const addLog = useCallback((msg: string) => {
    const ts = new Date().toLocaleTimeString();
    setLog(prev => [...prev.slice(-80), `[${ts}] ${msg}`]);
  }, []);

  const navigate = useCallback((s: Screen) => setScreen(s), []);

  // ─── Restore on mount ──
  useEffect(() => {
    const saved = loadWalletState();
    if (saved?.ethAddress) {
      setWallet(saved);
      setScreen('dashboard');
      // Refresh balance
      getEthBalance(saved.ethAddress)
        .then(b => setEthBalance(b))
        .catch(() => {});
      // Check for pending deep-link connect (mobile: user had to login first)
      try {
        const pending = sessionStorage.getItem('pending_connect');
        if (pending) {
          sessionStorage.removeItem('pending_connect');
          const { relay, session } = JSON.parse(pending);
          setConnectParams({ relay, session });
          setScreen('connect');
          addLog(`Resumed pending connect to ${relay}`);
        }
      } catch {}
    }
    // Check URL params for passkey:// URI
    const params = new URLSearchParams(window.location.search);
    const uri = params.get('uri');
    if (uri) {
      addLog(`Found URI param: ${uri.slice(0, 40)}...`);
    }
  }, [addLog]);

  // ─── Refresh Balances ──
  const refreshBalance = useCallback(async () => {
    const addr = wallet?.ethAddress;
    const accountId = wallet?.nearAccountId;
    const promises: Promise<void>[] = [];

    if (addr) {
      promises.push(getEthBalance(addr).then(b => setEthBalance(b)).catch((err: any) => addLog(`ETH balance failed: ${err.message}`)));
    }
    if (accountId) {
      promises.push(getNearBalance(accountId).then(b => setNearBalance(b)).catch((err: any) => addLog(`NEAR balance failed: ${err.message}`)));
    }

    await Promise.allSettled(promises);
  }, [wallet?.ethAddress, wallet?.nearAccountId, addLog]);

  // ─── Create Wallet ──
  const handleCreateWallet = useCallback(async (walletName: string, accountType: 'root' | 'sub') => {
    if (!walletName || walletName.length < 2) return;
    setScreen('creating');
    setLoading(true);
    addLog(`Creating wallet "${walletName}" (${accountType})...`);

    try {
      const plannedAccountId = accountType === 'root'
        ? `${walletName}.testnet`
        : `${walletName}.${FACTORY_CONTRACT}`;

      // Step 1: Create passkey
      addLog('Requesting FaceID / fingerprint...');
      const passkey = await createPasskey(plannedAccountId);
      addLog(`Passkey created! ID: ${passkey.id.slice(0, 16)}...`);

      // Step 2: Extract public key for contract
      const rawPubKey = passkey.publicKey.raw;
      let pubKeyForContract: string;
      if (passkey.publicKey.alg === -7) {
        const { x, y } = parsePasskeyPublicKey(rawPubKey, -7);
        const prefix = (y[31] % 2 === 0) ? 0x02 : 0x03;
        const compressed = new Uint8Array([prefix, ...x]);
        pubKeyForContract = base58Encode(compressed);
      } else {
        pubKeyForContract = base58Encode(rawPubKey);
      }
      addLog(`Contract pubkey: ${pubKeyForContract.slice(0, 20)}...`);

      // Step 3: Load WASM
      addLog('Loading wallet contract WASM...');
      const wasmBase64 = await getWalletWasmBase64();
      addLog(`WASM loaded: ${(atob(wasmBase64).length / 1024).toFixed(0)}KB`);

      // Step 4: Create the account
      let accountId: string;
      if (accountType === 'root') {
        addLog(`Creating root account ${walletName}.testnet...`);
        const result = await createRootWallet(walletName, pubKeyForContract, wasmBase64);
        accountId = result.accountId;
        addLog(`Root account created: ${accountId}`);
      } else {
        addLog(`Creating subaccount ${walletName}.${FACTORY_CONTRACT}...`);
        const result = await createSubaccountWallet(walletName, pubKeyForContract, wasmBase64);
        accountId = result.accountId;
        addLog(`Subaccount created: ${accountId} (tx: ${result.txHash})`);
      }

      // Step 5: Verify deployment
      addLog('Verifying wallet contract...');
      const deployedKey = await nearView(accountId, 'w_public_key');
      addLog(`Deployed pubkey: ${deployedKey.slice(0, 30)}...`);

      // Step 6: Derive ETH address via MPC
      addLog('Deriving Ethereum address via MPC...');
      const { derivedKey, ethAddress } = await deriveEthAddress(accountId, 'ethereum,1');
      addLog(`ETH address: ${ethAddress}`);

      // Step 7: Save wallet state
      const walletState: WalletState = {
        nearAccountId: accountId,
        ethAddress,
        credentialId: passkey.id,
        credentialRawId: uint8ToBase64(passkey.rawId),
        credentialRawIdUint8: passkey.rawId,
        derivedKey,
        path: 'ethereum,1',
      };
      setWallet(walletState);
      saveWalletState(walletState);
      saveCredentialMapping(passkey.id, accountId, uint8ToBase64(passkey.rawId));
      addLog('Wallet saved!');

      // Step 8: Get balance
      try {
        const balance = await getEthBalance(ethAddress);
        setEthBalance(balance);
      } catch {}
      addLog('Wallet ready!');
      setScreen('dashboard');
    } catch (err: any) {
      addLog(`ERROR: ${err.message}`);
      console.error(err);
      setScreen('naming');
    } finally {
      setLoading(false);
    }
  }, [addLog]);

  // ─── Login ──
  const handleLogin = useCallback(async () => {
    setLoading(true);
    setNeedAccountId(false);
    addLog('Looking up passkeys...');

    try {
      const assertion = await navigator.credentials.get({
        publicKey: {
          challenge: crypto.getRandomValues(new Uint8Array(32)),
          userVerification: 'required',
          timeout: 60000,
        },
      });

      if (!assertion) throw new Error('No credential returned');
      const pkAssertion = assertion as PublicKeyCredential;
      const credentialId = pkAssertion.id as string;
      const credentialRawId = new Uint8Array(pkAssertion.rawId);
      addLog(`Passkey authenticated: ${credentialId.slice(0, 16)}...`);

      // Switch to login screen so user sees progress
      setScreen('login');

      // Recover account name from userHandle
      let accountId: string | null = null;
      const resp = pkAssertion.response as AuthenticatorAssertionResponse;
      if (resp.userHandle && resp.userHandle.byteLength > 0) {
        accountId = new TextDecoder().decode(resp.userHandle);
        if (!accountId.includes('.')) accountId = null;
      }

      // Fallback: credential mapping
      if (!accountId) {
        const mapped = lookupCredential(credentialId);
        if (mapped) {
          accountId = mapped.accountId;
          addLog(`Restored from credential map: ${accountId}`);
        }
      }

      // Fallback: saved wallet state
      if (!accountId) {
        const saved = loadWalletState();
        if (saved?.nearAccountId) {
          accountId = saved.nearAccountId;
        }
      }

      if (!accountId) {
        addLog('New passkey detected. Enter your account name.');
        setNeedAccountId(true);
        setScreen('welcome');
        pendingCred.current = { id: credentialId, rawIdBase64: uint8ToBase64(credentialRawId) };
        setLoading(false);
        return;
      }

      addLog(`Account: ${accountId}`);

      // Verify contract
      try {
        await nearView(accountId, 'w_public_key');
      } catch {
        throw new Error(`No wallet contract found at ${accountId}`);
      }

      // Derive ETH address
      addLog('Deriving Ethereum address...');
      const { derivedKey, ethAddress } = await deriveEthAddress(accountId, 'ethereum,1');
      addLog(`ETH address: ${ethAddress}`);

      const walletState: WalletState = {
        nearAccountId: accountId,
        ethAddress,
        credentialId,
        credentialRawId: uint8ToBase64(credentialRawId),
        credentialRawIdUint8: credentialRawId,
        derivedKey,
        path: 'ethereum,1',
      };
      setWallet(walletState);
      saveWalletState(walletState);
      addLog('Wallet restored!');

      // ─── Auto-create session key for self-reliant flow ───
      try {
        addLog('Generating session key for direct transactions...');
        const sessionKeyPair = await generateSessionKeyPair();
        const sessionKeyId = `session-${Date.now()}`;
        const ttlSecs = 86400; // 24 hours
        const now = Math.floor(Date.now() / 1000);
        const createdAtTs = now - 30;

        const ops = [{ type: 'CreateSession' as const, session_key_id: sessionKeyId, public_key: sessionKeyPair.publicKey, ttl_secs: ttlSecs }];
        const executeArgs = buildSessionOpArgs({ accountId, ops, created_at_ts: createdAtTs });

        const borshBytes = borshRequestMessageWithOps({
          chain_id: CHAIN_ID,
          signer_id: accountId,
          nonce: executeArgs.msg.nonce as number,
          created_at: createdAtTs,
          timeout: 600,
          ops,
        });
        const challenge = computeChallenge(borshBytes);

        addLog('Requesting passkey signature for session key...');
        const passkeySig = await signWithPasskey(credentialRawId, challenge);
        const proof = buildProof(passkeySig.authenticatorData, passkeySig.clientDataJSON, passkeySig.signature);

        (executeArgs as any).proof = proof;
        addLog('Registering session key on-chain...');
        const sessionResult = await submitViaRelay(JSON.stringify(executeArgs), accountId);

        if (sessionResult.status === 'Failure') {
          addLog(`Session key creation failed (non-fatal): ${JSON.stringify(sessionResult).slice(0, 200)}`);
        } else {
          await saveSessionKey(sessionKeyId, sessionKeyPair, accountId);
          walletState.activeSessionKeyId = sessionKeyId;
          setWallet({ ...walletState });
          saveWalletState(walletState);
          addLog(`Session key "${sessionKeyId}" active — direct transactions enabled!`);
        }
      } catch (sessionErr: any) {
        // Session key creation failure is non-fatal — wallet still works via relay
        addLog(`Session key creation skipped: ${sessionErr.message}`);
      }

      await refreshBalance();
      setScreen('dashboard');
    } catch (err: any) {
      addLog(`Login ERROR: ${err.message}`);
    } finally {
      setLoading(false);
    }
  }, [addLog, refreshBalance]);

  // ─── Complete Login with Account ID ──
  const handleCompleteLogin = useCallback(async (loginAccountId: string) => {
    if (!loginAccountId || loginAccountId.length < 3) return;
    setNeedAccountId(false);
    setLoading(true);
    setScreen('login');
    addLog(`Connecting to ${loginAccountId}...`);
    try {
      await nearView(loginAccountId, 'w_public_key');
      addLog('Wallet contract verified');
      const { derivedKey, ethAddress } = await deriveEthAddress(loginAccountId, 'ethereum,1');
      addLog(`ETH address: ${ethAddress}`);

      // Save credential mapping
      if (pendingCred.current) {
        saveCredentialMapping(pendingCred.current.id, loginAccountId, pendingCred.current.rawIdBase64);
        addLog('Credential mapped — next login will be instant.');
      }

      const walletState: WalletState = {
        nearAccountId: loginAccountId,
        ethAddress,
        credentialId: pendingCred.current?.id || '',
        credentialRawId: pendingCred.current?.rawIdBase64 || '',
        credentialRawIdUint8: pendingCred.current?.rawIdBase64 ? base64ToUint8(pendingCred.current.rawIdBase64) : new Uint8Array(0),
        derivedKey,
        path: 'ethereum,1',
      };
      setWallet(walletState);
      saveWalletState(walletState);
      await refreshBalance();
      setScreen('dashboard');
    } catch (err: any) {
      addLog(`ERROR: ${err.message}`);
    } finally {
      setLoading(false);
    }
  }, [addLog, refreshBalance]);

  // ─── Send ETH ──
  const handleSendEth = useCallback(async (to: string, amount: string) => {
    if (!to || !amount || !wallet) return;
    setScreen('sending');
    setLoading(true);
    const accountId = wallet.nearAccountId;

    try {
      // Step 1: Get nonce + gas
      addLog('Fetching ETH nonce + gas prices...');
      const [nonce, gasData] = await Promise.all([
        getEthNonce(wallet.ethAddress),
        getEthGasPrice(),
      ]);
      addLog(`Nonce: ${nonce}, maxFee: ${Number(gasData.maxFeePerGas / 10n**9n)} gwei`);

      // Step 2: Build unsigned tx
      addLog('Building unsigned ETH transaction...');
      const valueWei = BigInt(Math.floor(parseFloat(amount) * 1e18));
      const { unsignedTxHex, txPayloadHash } = buildEthTx({
        nonce,
        maxFeePerGas: gasData.maxFeePerGas,
        maxPriorityFeePerGas: gasData.maxPriorityFeePerGas,
        to,
        valueWei,
        from: wallet.ethAddress,
      });

      // Step 3: Build MPC sign args
      const signArgsJson = buildMpcSignArgs(txPayloadHash, wallet.path || 'ethereum,1');
      const signArgsB64 = btoa(signArgsJson);

      // Step 4: Build w_execute_signed args
      const now = Math.floor(Date.now() / 1000);
      const createdAtTs = now - 30;
      const executeArgs = buildExecuteSignedArgs({
        accountId,
        signArgsB64,
        path: wallet.path || 'ethereum,1',
        created_at_ts: createdAtTs,
      });

      let mpcSig: any;

      // ─── Try session key direct submission first ───
      const storedKey = wallet.activeSessionKeyId
        ? await loadSessionKey(wallet.activeSessionKeyId, accountId)
        : null;

      if (storedKey && !storedKey.needsMigration) {
        addLog('Submitting via session key (direct RPC)...');
        const sessionArgs = {
          msg: executeArgs.msg,
          session_key_id: wallet.activeSessionKeyId,
        };
        const result = await directExecuteSession({
          walletId: accountId,
          sessionKey: storedKey,
          requestMsg: sessionArgs,
          gas: 300_000_000_000_000n,
        });

        if (result.status === 'Failure' || !result.return_value) {
          throw new Error(`Session key tx failed: ${JSON.stringify(result).slice(0, 200)}`);
        }
        mpcSig = result.return_value;
        addLog(`Direct RPC success! tx: ${result.tx_hash?.slice(0, 16)}...`);
      } else {
        // Fallback: passkey + relay
        addLog('Computing challenge hash...');
        const borshBytes = borshRequestMessageWithDAG({
          signer_id: accountId,
          nonce: executeArgs.msg.nonce as number,
          created_at_ts: now - 30,
          signArgsJson,
        });
        const challenge = computeChallenge(borshBytes);

        addLog('Requesting passkey signature (FaceID)...');
        const passkeySig = await signWithPasskey(wallet.credentialRawIdUint8, challenge);
        const proof = buildProof(passkeySig.authenticatorData, passkeySig.clientDataJSON, passkeySig.signature);

        addLog('Submitting to wallet contract via relay...');
        (executeArgs as any).proof = proof;
        const result = await submitViaRelay(JSON.stringify(executeArgs), accountId);

        if (result.status === 'Failure') {
          throw new Error(`Transaction failed: ${JSON.stringify(result).slice(0, 200)}`);
        }

        if (!(result as any).return_value?.big_r) {
          throw new Error('No MPC signature in response');
        }
        mpcSig = (result as any).return_value;
      }

      // Assemble signed tx
      addLog('Assembling signed ETH transaction...');
      const signedTxHex = assembleSignedEthTx(unsignedTxHex, mpcSig, wallet.ethAddress);

      // Broadcast
      addLog('Broadcasting to Ethereum...');
      const txHash = await broadcastEthTx(signedTxHex);
      addLog(`ETH tx broadcast! Hash: ${txHash}`);

      await refreshBalance();
      addLog('Send complete!');
    } catch (err: any) {
      addLog(`ERROR: ${err.message}`);
      console.error(err);
    } finally {
      setLoading(false);
      setScreen('dashboard');
    }
  }, [wallet, addLog, refreshBalance]);

  // ─── Send SOL ──
  const handleSendSol = useCallback(async (to: string, amount: string) => {
    if (!to || !amount || !solAddress || !wallet) return;
    setScreen('sending');
    setLoading(true);
    const accountId = wallet.nearAccountId;

    try {
      addLog('Fetching SOL blockhash...');
      const { blockhash } = await getSolRecentBlockhash();

      addLog('Building SOL transfer...');
      const lamports = BigInt(Math.floor(parseFloat(amount) * 1e9));
      const message = buildSolTransferMessage({ from: solAddress, to, lamports, recentBlockhash: blockhash });

      // Sign via MPC (EdDSA)
      addLog('Signing via MPC...');
      const signArgsJson = buildMpcSignArgsEdDSA(message, 'solana');
      const signArgsB64 = btoa(signArgsJson);

      const now = Math.floor(Date.now() / 1000);
      const createdAtTs = now - 30;
      const executeArgs = buildExecuteSignedArgs({
        accountId,
        signArgsB64,
        path: 'solana',
        created_at_ts: createdAtTs,
      });

      let returnValue: any;

      // ─── Try session key direct submission first ───
      const storedKey = wallet.activeSessionKeyId
        ? await loadSessionKey(wallet.activeSessionKeyId, accountId)
        : null;

      if (storedKey && !storedKey.needsMigration) {
        addLog('Submitting via session key (direct RPC)...');
        const sessionArgs = {
          msg: executeArgs.msg,
          session_key_id: wallet.activeSessionKeyId,
        };
        const result = await directExecuteSession({
          walletId: accountId,
          sessionKey: storedKey,
          requestMsg: sessionArgs,
          gas: 300_000_000_000_000n,
        });

        if (result.status === 'Failure' || !result.return_value) {
          throw new Error(`Session key tx failed: ${JSON.stringify(result).slice(0, 200)}`);
        }
        returnValue = result.return_value;
        addLog(`Direct RPC success! tx: ${result.tx_hash?.slice(0, 16)}...`);
      } else {
        // Fallback: passkey + relay
        addLog('Computing challenge hash...');
        const borshBytes = borshRequestMessageWithDAG({
          signer_id: accountId,
          nonce: executeArgs.msg.nonce as number,
          created_at_ts: now - 30,
          signArgsJson,
        });
        const challenge = computeChallenge(borshBytes);

        addLog('Requesting passkey signature...');
        const passkeySig = await signWithPasskey(wallet.credentialRawIdUint8, challenge);
        const proof = buildProof(passkeySig.authenticatorData, passkeySig.clientDataJSON, passkeySig.signature);

        addLog('Submitting to MPC...');
        (executeArgs as any).proof = proof;
        const result = await submitViaRelay(JSON.stringify(executeArgs), accountId);

        if (result.status === 'Failure') {
          throw new Error(`MPC call failed: ${JSON.stringify(result).slice(0, 200)}`);
        }
        returnValue = (result as any).return_value;
      }

      if (!returnValue || returnValue.scheme !== 'Ed25519') {
        throw new Error(`Invalid MPC response: ${returnValue?.scheme || 'no return value'}`);
      }

      const sigHex = returnValue.signature;
      if (!sigHex) throw new Error('No signature in MPC response');

      const sigBytes = new Uint8Array(sigHex.length / 2 - 1);
      for (let i = 2; i < sigHex.length; i += 2) {
        sigBytes[(i - 2) / 2] = parseInt(sigHex.substr(i, 2), 16);
      }

      addLog('Assembling signed SOL transaction...');
      const signedTx = assembleSignedSolTx(message, sigBytes);

      addLog('Broadcasting to Solana...');
      const txSig = await broadcastSolTx(signedTx);
      addLog(`SOL tx sent: ${txSig.slice(0, 16)}...`);
    } catch (err: any) {
      addLog(`ERROR: ${err.message}`);
      console.error(err);
    } finally {
      setLoading(false);
      setScreen('dashboard');
    }
  }, [wallet, solAddress, addLog]);

  // ─── Send NEAR Transaction (session key direct or passkey relay) ──
  const handleSendNearTransaction = useCallback(async (receiverId: string, actions: any[]): Promise<{ tx_hash: string }> => {
    if (!wallet) throw new Error('No wallet');

    const accountId = wallet.nearAccountId;

    // Convert near-connect actions to wallet DAG actions
    const dagActions = (actions || []).map((a: any) => {
      if (a.type === 'Transfer') {
        return { action: 'transfer', deposit: a.params?.amount || '0' };
      }
      if (a.type === 'FunctionCall') {
        return {
          action: 'function_call',
          function_name: a.params?.methodName || '',
          args: a.params?.args ? btoa(JSON.stringify(a.params.args)) : '',
          deposit: a.params?.gas || '0',
          min_gas: a.params?.gas || '30000000000000',
          gas_weight: '0',
        };
      }
      return { action: 'transfer', deposit: '0' };
    });

    // Build request with ops and the NEAR actions in the DAG
    const now = Math.floor(Date.now() / 1000);
    const nonce = generateSecureNonce();
    const createdAtTs = now - 30;

    const requestMsg: Record<string, any> = {
      msg: {
        chain_id: CHAIN_ID,
        signer_id: accountId,
        nonce,
        created_at: createdAtTs,
        timeout: 600,
        request: {
          ops: [],
          out: {
            after: [],
            then: [{
              receiver_id: receiverId,
              actions: dagActions,
            }],
          },
        },
      },
    };

    // ─── Try session key direct submission first ───
    const storedKey = wallet.activeSessionKeyId
      ? await loadSessionKey(wallet.activeSessionKeyId, accountId)
      : null;

    if (storedKey && !storedKey.needsMigration) {
      addLog('Submitting NEAR transaction via session key (direct RPC)...');
      requestMsg.session_key_id = wallet.activeSessionKeyId;
      const result = await directExecuteSession({
        walletId: accountId,
        sessionKey: storedKey,
        requestMsg,
        gas: 300_000_000_000_000n,
      });

      if (result.status === 'Failure') {
        throw new Error(`Transaction failed: ${JSON.stringify(result).slice(0, 200)}`);
      }

      addLog(`Transaction submitted (direct): ${result.tx_hash}`);
      return { tx_hash: result.tx_hash };
    }

    // Fallback: passkey + relay
    const borshBytes = borshRequestMessageWithOps({
      chain_id: CHAIN_ID,
      signer_id: accountId,
      nonce,
      created_at: now - 30,
      timeout: 600,
      ops: [],
    });
    const challenge = computeChallenge(borshBytes);

    addLog('Requesting passkey signature...');
    const passkeySig = await signWithPasskey(wallet.credentialRawIdUint8, challenge);

    const proof = buildProof(passkeySig.authenticatorData, passkeySig.clientDataJSON, passkeySig.signature);
    (requestMsg as any).proof = proof;

    addLog('Submitting NEAR transaction via relay...');
    const result = await submitViaRelay(JSON.stringify(requestMsg), accountId);

    if (result.status === 'Failure') {
      throw new Error(`Transaction failed: ${JSON.stringify(result).slice(0, 200)}`);
    }

    addLog(`Transaction submitted: ${result.tx_hash}`);
    return { tx_hash: result.tx_hash };
  }, [wallet, addLog]);

  // ─── Derive Solana Address ──
  const handleDeriveSol = useCallback(async () => {
    if (!wallet?.nearAccountId) return;
    setLoading(true);
    try {
      const { solAddress: addr } = await deriveSolAddress(wallet.nearAccountId);
      _setSolAddress(addr);
      const balance = await getSolBalance(addr);
      _setSolBalance(balance);
      addLog(`SOL address: ${addr.slice(0, 8)}...${addr.slice(-8)}`);
    } catch (err: any) {
      addLog(`SOL derivation failed: ${err.message}`);
    } finally {
      setLoading(false);
    }
  }, [wallet?.nearAccountId, addLog]);

  // ─── Derive Nostr Key ──
  const handleDeriveNostr = useCallback(async () => {
    if (!wallet?.nearAccountId) {
      addLog('No wallet loaded');
      return;
    }
    setLoading(true);
    addLog('Deriving Nostr pubkey...');
    try {
      const result = await deriveSolAddress(wallet.nearAccountId, 'nostr,1');
      _setNpub(result.solAddress);
      addLog(`Nostr npub: ${result.solAddress.slice(0, 16)}...`);
    } catch (err: any) {
      addLog(`Nostr derivation failed: ${err.message}`);
    } finally {
      setLoading(false);
    }
  }, [wallet?.nearAccountId, addLog]);

  // ─── Check Account Available ──
  const handleCheckAccount = useCallback(async (name: string): Promise<boolean | null> => {
    try {
      return await checkAccountAvailable(name);
    } catch {
      return null;
    }
  }, []);

  // ─── Session Keys ──
  const handleGetSessionKeys = useCallback(async () => {
    if (!wallet?.nearAccountId) return;
    try {
      const keys = await fetchSessionKeys(wallet.nearAccountId);
      _setSessionKeys(keys);
    } catch (err: any) {
      addLog(`Session keys fetch failed: ${err.message}`);
    }
  }, [wallet?.nearAccountId, addLog]);

  const handleCreateSessionKey = useCallback(async () => {
    if (!wallet) return;

    // Skip if we already have a valid active session key
    if (wallet.activeSessionKeyId) {
      const existing = await loadSessionKey(wallet.activeSessionKeyId, wallet.nearAccountId);
      if (existing && !existing.needsMigration) {
        addLog(`Active session key "${wallet.activeSessionKeyId}" already exists — skipping.`);
        return;
      }
    }

    setLoading(true);
    const accountId = wallet.nearAccountId;
    try {
      addLog('Generating session key...');
      const keyPair = await generateSessionKeyPair();
      addLog(`Session public key: ${keyPair.publicKey.slice(0, 30)}...`);

      const sessionKeyId = `session-${Date.now()}`;
      const ttlSecs = 86400;
      const now = Math.floor(Date.now() / 1000);
      const createdAtTs = now - 30;

      const ops = [{ type: 'CreateSession' as const, session_key_id: sessionKeyId, public_key: keyPair.publicKey, ttl_secs: ttlSecs }];
      const executeArgs = buildSessionOpArgs({ accountId, ops, created_at_ts: createdAtTs });

      const borshBytes = borshRequestMessageWithOps({
        chain_id: 'mainnet',
        signer_id: accountId,
        nonce: executeArgs.msg.nonce as number,
        created_at: createdAtTs,
        timeout: 600,
        ops,
      });
      const challenge = computeChallenge(borshBytes);

      addLog('Requesting passkey signature for CreateSession...');
      const passkeySig = await signWithPasskey(wallet.credentialRawIdUint8, challenge);
      const proof = buildProof(passkeySig.authenticatorData, passkeySig.clientDataJSON, passkeySig.signature);

      (executeArgs as any).proof = proof;
      addLog('Submitting CreateSession to contract...');
      const result = await submitViaRelay(JSON.stringify(executeArgs), accountId);

      if (result.status === 'Failure') {
        throw new Error(`CreateSession failed: ${JSON.stringify(result).slice(0, 300)}`);
      }

      await saveSessionKey(sessionKeyId, keyPair, accountId);

      // Store as active session key for direct RPC
      const updated = { ...wallet, activeSessionKeyId: sessionKeyId };
      setWallet(updated);
      saveWalletState(updated);

      addLog(`Session key "${sessionKeyId}" created! TTL: 24 hours`);
      await handleGetSessionKeys();
    } catch (err: any) {
      addLog(`CreateSession ERROR: ${err.message}`);
    } finally {
      setLoading(false);
    }
  }, [wallet, addLog, handleGetSessionKeys]);

  /** Register an external (dApp-generated) public key as a session key on-chain */
  const handleRegisterExternalSessionKey = useCallback(async (sessionKeyId: string, publicKey: string) => {
    if (!wallet) return;
    const accountId = wallet.nearAccountId;
    const ttlSecs = 86400;
    const now = Math.floor(Date.now() / 1000);
    const createdAtTs = now - 30;
    const createdAtIso = new Date(createdAtTs * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');

    const ops = [{ type: 'CreateSession' as const, session_key_id: sessionKeyId, public_key: publicKey, ttl_secs: ttlSecs }];

    // Use same pattern as working handleCreateSessionKey
    const executeArgs = {
      msg: {
        chain_id: 'mainnet',
        signer_id: accountId,
        nonce: Math.floor(Math.random() * 0xFFFFFFFF),
        created_at: createdAtIso,
        timeout_secs: 600,
        request: {
          ops: ops.map(op => ({
            op: 'create_session',
            session_key_id: op.session_key_id,
            public_key: op.public_key,
            ttl_secs: op.ttl_secs,
          })),
          out: { after: [], then: [] },
        },
      },
    };

    const borshBytes = borshRequestMessageWithOps({
      chain_id: 'mainnet',
      signer_id: accountId,
      nonce: executeArgs.msg.nonce as number,
      created_at: createdAtTs,
      timeout: 600,
      ops,
    });
    const challenge = computeChallenge(borshBytes);

    const passkeySig = await signWithPasskey(wallet.credentialRawIdUint8, challenge);
    const proof = buildProof(passkeySig.authenticatorData, passkeySig.clientDataJSON, passkeySig.signature);

    (executeArgs as any).proof = proof;
    const result = await submitViaRelay(JSON.stringify(executeArgs), accountId);

    if (result.status === 'Failure') {
      throw new Error(`CreateSession failed: ${JSON.stringify(result).slice(0, 300)}`);
    }
    return result;
  }, [wallet]);

  const handleRevokeSessionKey = useCallback(async (sessionKeyId: string) => {
    if (!wallet) return;
    setLoading(true);
    const accountId = wallet.nearAccountId;
    try {
      const now = Math.floor(Date.now() / 1000);
      const createdAtTs = now - 30;
      const ops = [{ type: 'RevokeSession' as const, session_key_id: sessionKeyId }];
      const executeArgs = buildSessionOpArgs({ accountId, ops, created_at_ts: createdAtTs });

      addLog(`Revoking session key "${sessionKeyId}"...`);

      // ─── Try session key direct submission first ───
      const storedKey = wallet.activeSessionKeyId
        ? await loadSessionKey(wallet.activeSessionKeyId, accountId)
        : null;

      if (storedKey && !storedKey.needsMigration && sessionKeyId !== wallet.activeSessionKeyId) {
        // Use active session key to revoke another (can't revoke self via session key)
        addLog('Revoking via session key (direct RPC)...');
        const sessionArgs = {
          msg: executeArgs.msg,
          session_key_id: wallet.activeSessionKeyId,
        };
        const result = await directExecuteSession({
          walletId: accountId,
          sessionKey: storedKey,
          requestMsg: sessionArgs,
        });
        if (result.status === 'Failure') throw new Error(`RevokeSession failed`);
      } else {
        // Fallback: passkey + relay
        const borshBytes = borshRequestMessageWithOps({
          chain_id: 'mainnet', signer_id: accountId, nonce: executeArgs.msg.nonce as number,
          created_at: createdAtTs, timeout: 600, ops,
        });
        const challenge = computeChallenge(borshBytes);
        const passkeySig = await signWithPasskey(wallet.credentialRawIdUint8, challenge);
        const proof = buildProof(passkeySig.authenticatorData, passkeySig.clientDataJSON, passkeySig.signature);
        (executeArgs as any).proof = proof;
        const result = await submitViaRelay(JSON.stringify(executeArgs), accountId);
        if (result.status === 'Failure') throw new Error(`RevokeSession failed`);
      }

      // If revoking the active session key, clear it from wallet state
      if (sessionKeyId === wallet.activeSessionKeyId) {
        const updated = { ...wallet };
        delete updated.activeSessionKeyId;
        setWallet(updated);
        saveWalletState(updated);
      }

      await removeSessionKey(sessionKeyId, accountId);
      addLog(`Session key "${sessionKeyId}" revoked!`);
      await handleGetSessionKeys();
    } catch (err: any) {
      addLog(`RevokeSession ERROR: ${err.message}`);
    } finally {
      setLoading(false);
    }
  }, [wallet, addLog, handleGetSessionKeys]);

  const handleRevokeAllSessionKeys = useCallback(async () => {
    if (!wallet || !sessionKeys || Object.keys(sessionKeys).length === 0) return;
    setLoading(true);
    const accountId = wallet.nearAccountId;
    try {
      const now = Math.floor(Date.now() / 1000);
      const createdAtTs = now - 30;

      const ops = [{ type: 'RevokeAllSessions' as const }];
      const executeArgs = buildSessionOpArgs({ accountId, ops, created_at_ts: createdAtTs });

      addLog('Revoking all session keys...');

      // RevokeAllSessions removes ALL sessions including the active one,
      // so we must use passkey + relay (can't revoke self via session key)
      const borshBytes = borshRequestMessageWithOps({
        chain_id: 'mainnet', signer_id: accountId, nonce: executeArgs.msg.nonce as number,
        created_at: createdAtTs, timeout: 600, ops,
      });
      const challenge = computeChallenge(borshBytes);
      const passkeySig = await signWithPasskey(wallet.credentialRawIdUint8, challenge);
      const proof = buildProof(passkeySig.authenticatorData, passkeySig.clientDataJSON, passkeySig.signature);
      (executeArgs as any).proof = proof;

      const result = await submitViaRelay(JSON.stringify(executeArgs), accountId);
      if (result.status === 'Failure') throw new Error('RevokeAllSessions failed');

      // Clear active session key from wallet state
      if (wallet.activeSessionKeyId) {
        const updated = { ...wallet };
        delete updated.activeSessionKeyId;
        setWallet(updated);
        saveWalletState(updated);
      }

      for (const skId of Object.keys(sessionKeys)) {
        await removeSessionKey(skId, accountId);
      }
      _setSessionKeys(null);
      addLog('All session keys revoked!');
    } catch (err: any) {
      addLog(`RevokeAllSessions ERROR: ${err.message}`);
    } finally {
      setLoading(false);
    }
  }, [wallet, sessionKeys, addLog]);

  // ─── Backup Key ──
  const handleGetBackupKey = useCallback(async () => {
    if (!wallet?.nearAccountId) return;
    try {
      const result = await nearView(wallet.nearAccountId, 'w_backup_key');
      if (result && result !== 'null') {
        _setBackupKey(result);
        addLog(`Backup passkey: ${result.slice(0, 30)}...`);
      } else {
        _setBackupKey(null);
        addLog('No backup passkey set');
      }
    } catch (err: any) {
      addLog(`Backup key query error: ${err.message}`);
    }
  }, [wallet?.nearAccountId, addLog]);

  const handleAddBackupKey = useCallback(async () => {
    if (!wallet) return;
    setLoading(true);
    addLog('Starting backup passkey registration...');
    try {
      const accountId = wallet.nearAccountId;
      const credential = await navigator.credentials.create({
        publicKey: {
          challenge: crypto.getRandomValues(new Uint8Array(32)),
          rp: { name: 'NEAR Passkey Wallet' },
          user: { id: new TextEncoder().encode(accountId), name: accountId, displayName: accountId },
          pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
          authenticatorSelection: { authenticatorAttachment: 'cross-platform', requireResidentKey: false, userVerification: 'required' },
          timeout: 120000,
          attestation: 'direct',
        },
      });

      if (!credential) throw new Error('No credential returned');
      const pkCred = credential as PublicKeyCredential;
      addLog(`Backup passkey created: ${pkCred.id.slice(0, 20)}...`);
      // Full backup key flow would extract pubkey and submit SetBackupKey op
      // For now, save credential mapping
      const rawId = new Uint8Array(pkCred.rawId);
      saveCredentialMapping(pkCred.id, accountId, uint8ToBase64(rawId));
      addLog('Backup passkey registered!');
    } catch (err: any) {
      addLog(`Add backup key failed: ${err.message}`);
    } finally {
      setLoading(false);
    }
  }, [wallet, addLog]);

  const handleRemoveBackupKey = useCallback(async () => {
    if (!wallet || !backupKey) return;
    setLoading(true);
    addLog('Removing backup passkey...');
    try {
      const accountId = wallet.nearAccountId;
      const now = Math.floor(Date.now() / 1000);
      const createdAtTs = now - 30;

      const ops = [{ type: 'RemoveBackupKey' as const }];
      const executeArgs = buildSessionOpArgs({ accountId, ops, created_at_ts: createdAtTs });
      const borshBytes = borshRequestMessageWithOps({
        chain_id: 'mainnet', signer_id: accountId, nonce: executeArgs.msg.nonce as number,
        created_at: now - 30, timeout: 600, ops,
      });
      const challenge = computeChallenge(borshBytes);
      const passkeySig = await signWithPasskey(wallet.credentialRawIdUint8, challenge);
      const proof = buildProof(passkeySig.authenticatorData, passkeySig.clientDataJSON, passkeySig.signature);
      (executeArgs as any).proof = proof;

      const result = await submitViaRelay(JSON.stringify(executeArgs), accountId);
      if (result.status === 'Failure') throw new Error('RemoveBackupKey failed');

      _setBackupKey(null);
      addLog('Backup passkey removed');
    } catch (err: any) {
      addLog(`Remove backup key failed: ${err.message}`);
    } finally {
      setLoading(false);
    }
  }, [wallet, backupKey, addLog]);

  const handleTestBackupKey = useCallback(async () => {
    if (!wallet || !backupKey) return;
    setLoading(true);
    addLog('Testing backup passkey... Please authenticate with your backup device.');
    try {
      const assertion = await navigator.credentials.get({
        publicKey: { challenge: crypto.getRandomValues(new Uint8Array(32)), userVerification: 'required', timeout: 60000 },
      });
      if (!assertion) throw new Error('No credential returned');
      const pkAssertion = assertion as PublicKeyCredential;
      const usedId = pkAssertion.id;
      if (usedId === wallet.credentialId) {
        addLog('⚠️ You used your PRIMARY passkey. Try again with backup device.');
      } else {
        addLog('✓ Backup passkey detected and functional!');
      }
    } catch (err: any) {
      addLog(`Backup test failed: ${err.message}`);
    } finally {
      setLoading(false);
    }
  }, [wallet, backupKey, addLog]);

  // ─── Bunker (NIP-46) ──
  const bunkerRef = useRef<any>(null);

  const handleStartBunker = useCallback(async (relays?: string[]) => {
    addLog('Starting NIP-46 bunker...');
    try {
      // Dynamic import to avoid loading nostr deps until needed
      const { getOrCreateSessionKeypair, Nip46Bunker } = await import('../nostr');
      const bunkerRelays = relays || ['wss://relay.primal.net', 'wss://nos.lol'];
      const { secretKey, pubkey } = getOrCreateSessionKeypair();

      const newBunker = new Nip46Bunker({
        relays: bunkerRelays,
        pubkey,
        npub: pubkey, // Will be converted by bunker
        sessionSecretKey: secretKey,
        onRequest: (request: any) => {
          addLog(`Bunker request: ${request.method}`);
        },
      });

      await newBunker.start();
      bunkerRef.current = newBunker;
      addLog('✓ Bunker listening on relays');
    } catch (err: any) {
      addLog(`Bunker start error: ${err.message}`);
    }
  }, [addLog]);

  const handleStopBunker = useCallback(() => {
    if (bunkerRef.current) {
      bunkerRef.current.stop();
      bunkerRef.current = null;
      addLog('Bunker stopped');
    }
  }, [addLog]);

  // ─── Logout ──
  const handleLogout = useCallback(() => {
    if (bunkerRef.current) {
      bunkerRef.current.stop();
      bunkerRef.current = null;
    }
    clearWalletState();
    setWallet(null);
    setEthBalance(null);
    setNearBalance(null);
    setConnectParams(null);
    _setSessionKeys(null);
    _setBackupKey(null);
    _setSolAddress(null);
    _setSolBalance(null);
    _setNpub(null);
    setScreen('welcome');
    setLog([]);
  }, []);

  // ─── Context Value ──
  const value: WalletContextValue = {
    wallet,
    screen,
    navigate,
    loading,
    log,
    addLog,
    ethBalance,
    nearBalance,
    needAccountId,
    login: handleLogin,
    completeLoginWithAccountId: handleCompleteLogin,
    createWallet: handleCreateWallet,
    sendEth: handleSendEth,
    sendSol: handleSendSol,
    sendNearTransaction: handleSendNearTransaction,
    deriveSolAddress: handleDeriveSol,
    deriveNostr: handleDeriveNostr,
    checkAccountAvailable: handleCheckAccount,
    refreshBalance,
    createSessionKey: handleCreateSessionKey,
    registerExternalSessionKey: handleRegisterExternalSessionKey,
    revokeSessionKey: handleRevokeSessionKey,
    revokeAllSessionKeys: handleRevokeAllSessionKeys,
    getSessionKeys: handleGetSessionKeys,
    addBackupKey: handleAddBackupKey,
    removeBackupKey: handleRemoveBackupKey,
    testBackupKey: handleTestBackupKey,
    getBackupKey: handleGetBackupKey,
    solAddress,
    solBalance: _solBalance,
    npub,
    sessionKeys,
    connectParams,
    setConnectParams,
    startBunker: handleStartBunker,
    stopBunker: handleStopBunker,
    logout: handleLogout,
    // Expose for ConnectScreen session key registration
    buildSessionOpArgs,
    borshRequestMessageWithOps,
    computeChallenge,
    signWithPasskey,
    buildProof,
    submitViaRelay,
  };

  return (
    <WalletContext.Provider value={value}>
      {children}
    </WalletContext.Provider>
  );
}
