import React, { useState, useEffect, useCallback } from 'react'
import {
  createPasskey,
  signWithPasskey,
  borshRequestMessage,
  borshRequestMessageWithDAG,
  borshRequestMessageWithOps,
  computeChallenge,
  buildProof,
  nearView,
  deriveEthAddress,
  getEthBalance,
  getEthNonce,
  getEthGasPrice,
  submitViaRelay,
  saveWalletState,
  loadWalletState,
  clearWalletState,
  saveCredentialMapping,
  lookupCredential,
  base64ToUint8,
  formatEthBalance,
  createRootWallet,
  createSubaccountWallet,
  getWalletWasmBase64,
  checkAccountAvailable,
  buildEthTx,
  assembleSignedEthTx,
  broadcastEthTx,
  buildMpcSignArgs,
  buildExecuteSignedArgs,
  buildSessionOpArgs,
  generateSessionKeyPair,
  signWithSessionKey,
  getSessionKeys,
  saveSessionKey,
  loadSessionKey,
  removeSessionKey,
  MPC_CONTRACT,
  WALLET_CONTRACT,
  FACTORY_CONTRACT,
  RELAY_URL,
} from './wallet.js'

// ─── States ──────────────────────────────────────────────────

const SCREENS = {
  WELCOME: 'welcome',
  NAMING: 'naming',
  CREATING: 'creating',
  LOGIN: 'login',
  DASHBOARD: 'dashboard',
  SENDING: 'sending',
}

export default function App() {
  const [screen, setScreen] = useState(SCREENS.WELCOME)
  const [log, setLog] = useState([])
  const [wallet, setWallet] = useState(null)
  const [ethBalance, setEthBalance] = useState(null)
  const [loading, setLoading] = useState(false)

  // Name form
  const [walletName, setWalletName] = useState('')
  const [accountType, setAccountType] = useState('root') // 'root' or 'sub'
  const [nameAvailable, setNameAvailable] = useState(null)
  const [checkingName, setCheckingName] = useState(false)

  // Send form
  const [sendTo, setSendTo] = useState('')
  const [sendAmount, setSendAmount] = useState('')

  // Login form
  const [loginAccountId, setLoginAccountId] = useState('')
  const [needAccountId, setNeedAccountId] = useState(false) // show inline input after passkey auth

  // Session keys
  const [sessionKeys, setSessionKeys] = useState(null) // map from contract
  const [sessionLoading, setSessionLoading] = useState(false)

  const addLog = useCallback((msg) => {
    const ts = new Date().toLocaleTimeString()
    setLog(prev => [...prev.slice(-80), `[${ts}] ${msg}`])
  }, [])

  // ─── Restore wallet on load ──
  useEffect(() => {
    const saved = loadWalletState()
    if (saved?.ethAddress) {
      setWallet(saved)
      setScreen(SCREENS.DASHBOARD)
      refreshBalance(saved.ethAddress)
    }
  }, [])

  // ─── Check name availability ──
  useEffect(() => {
    if (!walletName || walletName.length < 2) {
      setNameAvailable(null)
      return
    }
    const timer = setTimeout(async () => {
      setCheckingName(true)
      try {
        const fullId = accountType === 'root'
          ? `${walletName}.testnet`
          : `${walletName}.${FACTORY_CONTRACT}`
        const available = await checkAccountAvailable(fullId)
        setNameAvailable(available)
      } catch {
        setNameAvailable(null)
      } finally {
        setCheckingName(false)
      }
    }, 500)
    return () => clearTimeout(timer)
  }, [walletName, accountType])

  // ─── Create wallet ──
  const handleCreate = async () => {
    if (!walletName || walletName.length < 2) return
    setScreen(SCREENS.CREATING)
    setLoading(true)
    addLog(`Creating wallet "${walletName}" (${accountType})...`)

    try {
      // Step 1: Create passkey (embeds account name for login recovery)
      const plannedAccountId = accountType === 'root'
        ? `${walletName}.testnet`
        : `${walletName}.${FACTORY_CONTRACT}`
      addLog('Requesting FaceID / fingerprint...')
      const passkey = await createPasskey(plannedAccountId)
      addLog(`Passkey created! ID: ${passkey.id.slice(0, 16)}...`)
      const algName = passkey.publicKey.alg === -7 ? 'P-256 (ES256)' : passkey.publicKey.alg === -8 ? 'Ed25519' : `unknown (${passkey.publicKey.alg})`
      addLog(`Algorithm: ${algName}`)

      // Step 2: Convert passkey public key to NEAR base58 format
      // WebAuthn getPublicKey() returns COSE-encoded key (CBOR), NOT raw bytes.
      // For P-256: COSE key ~77-91 bytes containing x(32) + y(32) coordinates.
      // The contract expects compressed P-256 key (33 bytes: 0x02/0x03 + x) as base58.
      const rawPubKey = passkey.publicKey.raw
      addLog(`Raw public key: ${rawPubKey.length} bytes (SPKI)`)
      let pubKeyForContract
      if (passkey.publicKey.alg === -7) {
        const { x, y } = parsePasskeyPublicKey(rawPubKey, -7)
        const prefix = (y[31] % 2 === 0) ? 0x02 : 0x03
        const compressed = new Uint8Array([prefix, ...x])
        pubKeyForContract = base58Encode(compressed)
      } else {
        // Ed25519 — raw 32 bytes
        pubKeyForContract = base58Encode(rawPubKey)
      }
      addLog(`Contract pubkey: ${pubKeyForContract.slice(0, 20)}...`)

      // Step 3: Load WASM
      addLog('Loading wallet contract WASM...')
      const wasmBase64 = await getWalletWasmBase64()
      addLog(`WASM loaded: ${(atob(wasmBase64).length / 1024).toFixed(0)}KB`)

      // Step 4: Create the account
      let accountId
      if (accountType === 'root') {
        addLog(`Creating root account ${walletName}.testnet...`)
        const result = await createRootWallet(walletName, pubKeyForContract, wasmBase64)
        accountId = result.accountId
        addLog(`Root account created: ${accountId}`)
      } else {
        addLog(`Creating subaccount ${walletName}.${FACTORY_CONTRACT}...`)
        const result = await createSubaccountWallet(walletName, pubKeyForContract, wasmBase64)
        accountId = result.accountId
        addLog(`Subaccount created: ${accountId} (tx: ${result.txHash})`)
      }

      // Step 5: Verify deployment
      addLog('Verifying wallet contract...')
      const deployedKey = await nearView(accountId, 'w_public_key')
      addLog(`Deployed pubkey: ${deployedKey.slice(0, 30)}...`)

      // Step 6: Derive ETH address via MPC
      addLog('Deriving Ethereum address via MPC...')
      const { derivedKey, ethAddress } = await deriveEthAddress(accountId, 'ethereum,1')
      addLog(`MPC derived key: ${derivedKey.slice(0, 40)}...`)
      addLog(`ETH address: ${ethAddress}`)

      // Step 7: Save wallet state
      const walletState = {
        nearAccountId: accountId,
        ethAddress,
        credentialId: passkey.id,
        credentialRawId: uint8ToBase64(passkey.rawId),
        credentialRawIdUint8: passkey.rawId,
        derivedKey,
        path: 'ethereum,1',
      }
      setWallet(walletState)
      saveWalletState(walletState)
      saveCredentialMapping(passkey.id, accountId, uint8ToBase64(passkey.rawId))
      addLog('Wallet saved!')

      // Step 8: Get balance
      await refreshBalance(ethAddress)
      addLog('Wallet ready!')

      setScreen(SCREENS.DASHBOARD)
    } catch (err) {
      addLog(`ERROR: ${err.message}`)
      console.error(err)
      setScreen(SCREENS.NAMING)
    } finally {
      setLoading(false)
    }
  }

  const refreshBalance = async (address) => {
    try {
      const addr = address || wallet?.ethAddress
      if (!addr) return
      const balance = await getEthBalance(addr)
      setEthBalance(balance)
      addLog(`Balance: ${formatEthBalance(balance)} ETH`)
    } catch (err) {
      addLog(`Balance check failed: ${err.message}`)
    }
  }

  // ─── Send ETH (full signing flow) ──
  const handleSend = async () => {
    if (!sendTo || !sendAmount) return
    setScreen(SCREENS.SENDING)
    setLoading(true)
    const accountId = wallet?.nearAccountId || WALLET_CONTRACT

    try {
      // Step 1: Get ETH nonce + gas
      addLog('Fetching ETH nonce + gas prices...')
      const [nonce, gasData] = await Promise.all([
        getEthNonce(wallet.ethAddress),
        getEthGasPrice(),
      ])
      addLog(`Nonce: ${nonce}, maxFee: ${Number(gasData.maxFeePerGas / 10n**9n)} gwei`)

      // Step 2: Build unsigned ETH tx
      addLog('Building unsigned ETH transaction...')
      const valueWei = BigInt(Math.floor(parseFloat(sendAmount) * 1e18))
      const { unsignedTxHex, txPayloadHash } = buildEthTx({
        nonce,
        maxFeePerGas: gasData.maxFeePerGas,
        maxPriorityFeePerGas: gasData.maxPriorityFeePerGas,
        to: sendTo,
        valueWei,
        from: wallet.ethAddress,
      })
      addLog(`Unsigned tx: ${unsignedTxHex.slice(0, 40)}...`)
      addLog(`Payload hash: ${Array.from(txPayloadHash).map(b=>b.toString(16).padStart(2,'0')).join('').slice(0,16)}...`)

      // Step 3: Build MPC sign args
      const signArgsJson = buildMpcSignArgs(txPayloadHash, wallet.path || 'ethereum,1')
      const signArgsB64 = btoa(signArgsJson)

      // Step 4: Build the w_execute_signed args with PromiseDAG
      const now = Math.floor(Date.now() / 1000)
      const createdAtIso = new Date((now - 30) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')
      const executeArgs = buildExecuteSignedArgs({
        accountId,
        signArgsB64,
        path: wallet.path || 'ethereum,1',
        created_at_iso: createdAtIso,
      })

      // Step 5: Borsh-serialize the RequestMessage with DAG for challenge hash
      addLog('Computing challenge hash...')
      const borshBytes = borshRequestMessageWithDAG({
        signer_id: accountId,
        nonce: executeArgs.msg.nonce,
        created_at_ts: now - 30,
        signArgsJson,
      })
      const challenge = computeChallenge(borshBytes)
      addLog(`Challenge: ${Array.from(challenge).map(b=>b.toString(16).padStart(2,'0')).join('').slice(0, 16)}...`)

      // Step 6: Sign with passkey (FaceID)
      addLog('Requesting passkey signature (FaceID)...')
      const passkeySig = await signWithPasskey(wallet.credentialRawIdUint8, challenge)
      addLog(`Passkey signature: ${passkeySig.signature.length} bytes`)

      // Step 7: Build proof
      const proof = buildProof(
        passkeySig.authenticatorData,
        passkeySig.clientDataJSON,
        passkeySig.signature,
      )

      // Step 8: Submit via relay
      addLog('Submitting to wallet contract via relay...')
      executeArgs.proof = proof
      const argsJson = JSON.stringify(executeArgs)

      const result = await submitViaRelay(argsJson, accountId)
      addLog(`Relay: tx=${result.tx_hash?.slice(0,20)}..., status=${result.status}`)

      if (result.status === 'Failure') {
        throw new Error(`Transaction failed: ${JSON.stringify(result).slice(0, 200)}`)
      }

      // Step 9: Extract MPC signature from return value
      if (!result.return_value?.big_r) {
        throw new Error('No MPC signature in response')
      }
      const mpcSig = result.return_value
      addLog(`MPC signature: scheme=${mpcSig.scheme}, recovery=${mpcSig.recovery_id}`)

      // Step 10: Assemble signed ETH tx
      addLog('Assembling signed ETH transaction...')
      const signedTxHex = assembleSignedEthTx(unsignedTxHex, mpcSig, wallet.ethAddress)
      addLog(`Signed tx: ${signedTxHex.length} chars`)

      // Step 11: Broadcast to Ethereum
      addLog('Broadcasting to Ethereum...')
      const txHash = await broadcastEthTx(signedTxHex)
      addLog(`ETH tx broadcast! Hash: ${txHash}`)

      // Done
      await refreshBalance()
      addLog('Send complete!')
    } catch (err) {
      addLog(`ERROR: ${err.message}`)
      console.error(err)
    } finally {
      setLoading(false)
      setScreen(SCREENS.DASHBOARD)
    }
  }

  // ─── Test Sign (call w_execute_signed with empty request) ──
  const handleTestSign = async () => {
    if (!wallet) return
    setLoading(true)
    addLog('Test sign: authenticating with passkey...')
    try {
      const accountId = wallet.nearAccountId

      // Step 1: Build an empty RequestMessage (no ops, no MPC call — just proves passkey auth)
      const nonce = Math.floor(Math.random() * 0xFFFFFFFF)
      const now = Math.floor(Date.now() / 1000)
      const createdAtTs = now - 30
      const createdAtIso = new Date(createdAtTs * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')

      addLog(`Test sign: building request for ${accountId}...`)

      // Step 2: Borsh-serialize empty request for challenge hash
      const borshBytes = borshRequestMessage({
        chain_id: 'mainnet',
        signer_id: accountId,
        nonce,
        created_at: createdAtTs,
        timeout: 300,
      })
      const challengeHash = computeChallenge(borshBytes)
      addLog(`Challenge: ${Array.from(challengeHash).map(b=>b.toString(16).padStart(2,'0')).join('').slice(0, 16)}...`)

      // Step 3: Sign with passkey (FaceID)
      addLog('Test sign: requesting FaceID...')
      const passkeySig = await signWithPasskey(wallet.credentialRawIdUint8, challengeHash)
      addLog(`Passkey signed: ${passkeySig.signature.length} bytes`)

      // Step 4: Build proof
      const proof = buildProof(
        passkeySig.authenticatorData,
        passkeySig.clientDataJSON,
        passkeySig.signature,
      )

      // Step 5: Build JSON args for w_execute_signed
      const executeArgs = {
        msg: {
          chain_id: 'mainnet',
          signer_id: accountId,
          nonce,
          created_at: createdAtIso,
          timeout_secs: 300,
          request: {
            ops: [],
            out: { after: [], then: [] },
          },
        },
        proof,
      }

      addLog('Test sign: submitting to contract via relay...')

      // Step 6: Submit via relay
      const result = await submitViaRelay(JSON.stringify(executeArgs), accountId)

      if (result.status === 'Failure') {
        throw new Error(`Transaction failed: ${JSON.stringify(result).slice(0, 300)}`)
      }

      addLog(`Test sign SUCCESS! tx: ${result.tx_hash?.slice(0, 20) || 'confirmed'}`)
      if (result.return_value) addLog(`Return: ${JSON.stringify(result.return_value)}`)
    } catch (err) {
      addLog(`Test sign ERROR: ${err.message}`)
      console.error(err)
    } finally {
      setLoading(false)
    }
  }

  const handleLogout = () => {
    clearWalletState()
    setWallet(null)
    setEthBalance(null)
    setScreen(SCREENS.WELCOME)
    setLog([])
    setSessionKeys(null)
  }

  // ─── Session Keys ──

  const refreshSessionKeys = async (accountId) => {
    try {
      const keys = await getSessionKeys(accountId || wallet?.nearAccountId)
      setSessionKeys(keys)
      return keys
    } catch (err) {
      addLog(`Session keys fetch failed: ${err.message}`)
      return null
    }
  }

  /**
   * Create a session key: generate ed25519 keypair, then call w_execute_signed
   * with CreateSession op (requires passkey auth).
   */
  const handleCreateSession = async () => {
    if (!wallet) return
    setSessionLoading(true)
    const accountId = wallet.nearAccountId

    try {
      // Step 1: Generate ed25519 keypair
      addLog('Generating session key...')
      const keyPair = await generateSessionKeyPair()
      addLog(`Session public key: ${keyPair.publicKey.slice(0, 30)}...`)

      const sessionKeyId = `session-${Date.now()}`
      const ttlSecs = 86400 * 30 // 30 days

      // Step 2: Build the CreateSession op args
      const now = Math.floor(Date.now() / 1000)
      const createdAtTs = now - 30
      const createdAtIso = new Date(createdAtTs * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')

      const ops = [{ type: 'CreateSession', session_key_id: sessionKeyId, public_key: keyPair.publicKey, ttl_secs: ttlSecs }]
      const executeArgs = buildSessionOpArgs({ accountId, ops, created_at_iso: createdAtIso })

      // Step 3: Borsh-serialize for challenge hash
      const borshBytes = borshRequestMessageWithOps({
        chain_id: 'mainnet',
        signer_id: accountId,
        nonce: executeArgs.msg.nonce,
        created_at: createdAtTs,
        timeout: 600,
        ops,
      })
      const challenge = computeChallenge(borshBytes)

      // Step 4: Sign with passkey (FaceID)
      addLog('Requesting passkey signature for CreateSession...')
      const passkeySig = await signWithPasskey(wallet.credentialRawIdUint8, challenge)

      // Step 5: Build proof
      const proof = buildProof(
        passkeySig.authenticatorData,
        passkeySig.clientDataJSON,
        passkeySig.signature,
      )

      // Step 6: Submit via relay
      executeArgs.proof = proof
      addLog('Submitting CreateSession to contract...')
      const result = await submitViaRelay(JSON.stringify(executeArgs), accountId)

      if (result.status === 'Failure') {
        throw new Error(`CreateSession failed: ${JSON.stringify(result).slice(0, 300)}`)
      }

      // Step 7: Save private key locally
      await saveSessionKey(sessionKeyId, keyPair, accountId)
      addLog(`Session key "${sessionKeyId}" created! TTL: 30 days`)

      // Refresh the list
      await refreshSessionKeys(accountId)
    } catch (err) {
      addLog(`CreateSession ERROR: ${err.message}`)
      console.error(err)
    } finally {
      setSessionLoading(false)
    }
  }

  /**
   * Revoke a session key: call w_execute_signed with RevokeSession op.
   */
  const handleRevokeSession = async (sessionKeyId) => {
    if (!wallet) return
    setSessionLoading(true)
    const accountId = wallet.nearAccountId

    try {
      const now = Math.floor(Date.now() / 1000)
      const createdAtTs = now - 30
      const createdAtIso = new Date(createdAtTs * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')

      const ops = [{ type: 'RevokeSession', session_key_id: sessionKeyId }]
      const executeArgs = buildSessionOpArgs({ accountId, ops, created_at_iso: createdAtIso })

      // Borsh-serialize for challenge hash
      const borshBytes = borshRequestMessageWithOps({
        chain_id: 'mainnet',
        signer_id: accountId,
        nonce: executeArgs.msg.nonce,
        created_at: createdAtTs,
        timeout: 600,
        ops,
      })
      const challenge = computeChallenge(borshBytes)

      // Sign with passkey
      addLog(`Revoking session key "${sessionKeyId}"...`)
      const passkeySig = await signWithPasskey(wallet.credentialRawIdUint8, challenge)

      const proof = buildProof(
        passkeySig.authenticatorData,
        passkeySig.clientDataJSON,
        passkeySig.signature,
      )

      executeArgs.proof = proof
      const result = await submitViaRelay(JSON.stringify(executeArgs), accountId)

      if (result.status === 'Failure') {
        throw new Error(`RevokeSession failed: ${JSON.stringify(result).slice(0, 300)}`)
      }

      // Remove from local storage
      removeSessionKey(sessionKeyId, accountId)
      addLog(`Session key "${sessionKeyId}" revoked!`)

      await refreshSessionKeys(accountId)
    } catch (err) {
      addLog(`RevokeSession ERROR: ${err.message}`)
      console.error(err)
    } finally {
      setSessionLoading(false)
    }
  }

  // ─── Login with existing passkey ──
  const handleLogin = async () => {
    setLoading(true)
    setNeedAccountId(false)
    setLoginAccountId('')
    addLog('Looking up passkeys...')

    try {
      // Discoverable credential — user picks their passkey, no typing needed
      const assertion = await navigator.credentials.get({
        publicKey: {
          challenge: crypto.getRandomValues(new Uint8Array(32)),
          userVerification: 'required',
          timeout: 60000,
        },
      })

      const credentialId = assertion.id
      const credentialRawId = new Uint8Array(assertion.rawId)
      addLog(`Passkey selected: ${credentialId.slice(0, 16)}...`)

      // Recover account name from the passkey's userHandle
      // (we embedded it during creation as the accountId bytes)
      let accountId = null
      if (assertion.response.userHandle && assertion.response.userHandle.byteLength > 0) {
        accountId = new TextDecoder().decode(assertion.response.userHandle)
        // Validate it looks like a NEAR account (has a dot)
        if (!accountId.includes('.')) accountId = null
      }

      // Fallback 1: credential mapping (survives logout, keyed by credentialId)
      if (!accountId) {
        const mapped = lookupCredential(credentialId)
        if (mapped) {
          accountId = mapped.accountId
          addLog(`Restored from credential map: ${accountId}`)
        }
      }

      // Fallback 2: saved wallet state
      if (!accountId) {
        const saved = loadWalletState()
        if (saved?.nearAccountId) {
          accountId = saved.nearAccountId
          addLog(`Restored from saved wallet: ${accountId}`)
        }
      }

      if (!accountId) {
        // First time with this passkey — need account name once
        addLog('New passkey detected. Enter your account name (only once).')
        setNeedAccountId(true)
        // Store the credentialId + rawId so the inline handler can save the mapping
        window._pendingCredentialId = credentialId
        window._pendingCredentialRawId = uint8ToBase64(credentialRawId)
        setLoading(false)
        return
      }

      addLog(`Account: ${accountId}`)

      // Verify contract exists
      try {
        const deployedKey = await nearView(accountId, 'w_public_key')
        addLog(`Contract verified. Pubkey: ${deployedKey.slice(0, 30)}...`)
      } catch {
        throw new Error(`No wallet contract found at ${accountId}`)
      }

      // Derive ETH address
      addLog('Deriving Ethereum address...')
      const { derivedKey, ethAddress } = await deriveEthAddress(accountId, 'ethereum,1')
      addLog(`ETH address: ${ethAddress}`)

      // Save
      const walletState = {
        nearAccountId: accountId,
        ethAddress,
        credentialId,
        credentialRawId: uint8ToBase64(credentialRawId),
        credentialRawIdUint8: credentialRawId,
        derivedKey,
        path: 'ethereum,1',
      }
      setWallet(walletState)
      saveWalletState(walletState)
      addLog('Wallet restored!')

      await refreshBalance(ethAddress)
      setScreen(SCREENS.DASHBOARD)
    } catch (err) {
      addLog(`Login ERROR: ${err.message}`)
      console.error(err)
    } finally {
      setLoading(false)
    }
  }

  const previewAccountId = walletName
    ? accountType === 'root'
      ? `${walletName}.testnet`
      : `${walletName}.${FACTORY_CONTRACT}`
    : ''

  // ─── Render ────────────────────────────────────────────────

  if (screen === SCREENS.WELCOME) {
    return (
      <div className="container">
        <h1>Passkey Wallet</h1>
        <p className="subtitle">Cross-chain wallet secured by your face. No seed phrase.</p>

        <button className="btn btn-primary" onClick={() => setScreen(SCREENS.NAMING)}>
          Create Wallet
        </button>

        <button className="btn btn-secondary" style={{ marginTop: 8 }} onClick={handleLogin}>
          Login with FaceID
        </button>

        {needAccountId && (
          <div className="card" style={{ marginTop: 16 }}>
            <div className="card-title">Enter Account Name</div>
            <div style={{ fontSize: 12, color: '#888', marginBottom: 8 }}>
              Your passkey was found but we need your NEAR account name to complete login.
            </div>
            <input
              className="input"
              placeholder="your-wallet.testnet"
              value={loginAccountId}
              onChange={e => setLoginAccountId(e.target.value.replace(/\s/g, '').toLowerCase())}
              autoFocus
              style={{ marginBottom: 8 }}
            />
            <button
              className="btn btn-primary"
              onClick={async () => {
                if (!loginAccountId || loginAccountId.length < 3) return
                setNeedAccountId(false)
                setLoading(true)
                try {
                  await nearView(loginAccountId, 'w_public_key')
                  const { derivedKey, ethAddress } = await deriveEthAddress(loginAccountId, 'ethereum,1')

                  // Save credential mapping so next login is zero-typing
                  if (window._pendingCredentialId) {
                    saveCredentialMapping(
                      window._pendingCredentialId,
                      loginAccountId,
                      window._pendingCredentialRawId || null,
                    )
                    addLog(`Credential mapped — next login will be instant.`)
                  }

                  const walletState = {
                    nearAccountId: loginAccountId,
                    ethAddress,
                    credentialId: window._pendingCredentialId || null,
                    credentialRawId: window._pendingCredentialRawId || null,
                    credentialRawIdUint8: window._pendingCredentialRawId
                      ? base64ToUint8(window._pendingCredentialRawId) : null,
                    derivedKey,
                    path: 'ethereum,1',
                  }
                  setWallet(walletState)
                  saveWalletState(walletState)
                  await refreshBalance(ethAddress)
                  setScreen(SCREENS.DASHBOARD)
                } catch (err) {
                  addLog(`ERROR: ${err.message}`)
                } finally {
                  setLoading(false)
                }
              }}
              disabled={!loginAccountId || loginAccountId.length < 3}
            >
              Connect
            </button>
          </div>
        )}

        <div style={{ marginTop: 24 }}>
          <div className="card">
            <div className="card-title">How it works</div>
            <div style={{ fontSize: 13, color: '#888', lineHeight: 1.6 }}>
              1. Pick a name for your wallet<br />
              2. FaceID creates a passkey (secure enclave)<br />
              3. Your wallet gets a dedicated address on every chain<br />
              4. Send, swap, sign — all with your face<br />
              <br />
              No seed phrase. No private keys.<br />
              Backed up via iCloud Keychain / Google Password Manager.
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-title">Test Bench</div>
          <div style={{ fontSize: 12, color: '#555', lineHeight: 1.8 }}>
            <div>Factory: {FACTORY_CONTRACT}</div>
            <div>MPC: {MPC_CONTRACT}</div>
            <div>Relay: {RELAY_URL.replace('https://', '')}</div>
            <div>Test bench: 48/48 passing</div>
          </div>
        </div>

        {log.length > 0 && <LogPanel log={log} />}
      </div>
    )
  }

  if (screen === SCREENS.NAMING) {
    return (
      <div className="container">
        <h1>Name Your Wallet</h1>
        <p className="subtitle">Choose a name for your on-chain identity.</p>

        <div className="card">
          <div className="card-title">Account Type</div>
          <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
            <button
              className={`btn ${accountType === 'root' ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setAccountType('root')}
              style={{ flex: 1 }}
            >
              Root Account
            </button>
            <button
              className={`btn ${accountType === 'sub' ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setAccountType('sub')}
              style={{ flex: 1 }}
            >
              Subaccount
            </button>
          </div>
          <div style={{ fontSize: 12, color: '#888', marginBottom: 12 }}>
            {accountType === 'root'
              ? 'You own the account directly: yourname.testnet'
              : `Under the factory: yourname.${FACTORY_CONTRACT}`}
          </div>

          <input
            className="input"
            placeholder="your-name"
            value={walletName}
            onChange={e => setWalletName(e.target.value.replace(/[^a-zA-Z0-9_-]/g, '').toLowerCase())}
            autoFocus
          />

          {previewAccountId && (
            <div style={{ marginTop: 8, fontSize: 13, color: '#666' }}>
              {checkingName ? 'Checking...' :
               nameAvailable === true ? <span style={{ color: '#22c55e' }}>✓ {previewAccountId} is available</span> :
               nameAvailable === false ? <span style={{ color: '#ef4444' }}>✗ {previewAccountId} is taken</span> :
               null}
            </div>
          )}
        </div>

        <div className="row">
          <button className="btn btn-secondary" onClick={() => setScreen(SCREENS.WELCOME)}>
            Back
          </button>
          <button
            className="btn btn-primary"
            onClick={handleCreate}
            disabled={!walletName || walletName.length < 2 || nameAvailable === false}
          >
            Create with FaceID
          </button>
        </div>

        {log.length > 0 && <LogPanel log={log} />}
      </div>
    )
  }

  if (screen === SCREENS.CREATING) {
    return (
      <div className="container">
        <h1>Creating Wallet</h1>
        <div style={{ marginTop: 24, textAlign: 'center' }}>
          {loading && <><span className="spinner"></span> <span style={{ marginLeft: 8 }}>Setting up...</span></>}
        </div>
        <LogPanel log={log} />
      </div>
    )
  }

  // Dashboard + Sending
  return (
    <div className="container">
      <h1>Passkey Wallet</h1>

      <div className="card">
        <div className="card-title">
          <span>{wallet?.nearAccountId}</span>
        </div>
        <div style={{ fontSize: 12, color: '#888', marginTop: 4 }}>
          ETH address
        </div>
        <div
          className="address"
          onClick={() => navigator.clipboard?.writeText(wallet?.ethAddress || '')}
          title="Click to copy"
        >
          {wallet?.ethAddress}
        </div>
        <div className="chains">
          <span className="chain-badge active">Ethereum</span>
          <span className="chain-badge">Bitcoin</span>
          <span className="chain-badge">Solana</span>
        </div>
      </div>

      <div className="card">
        <div className="card-title">Balance</div>
        <div className="balance">
          {ethBalance !== null ? formatEthBalance(ethBalance) : '...'} ETH
        </div>
        <div className="balance-label">
          {ethBalance ? `$${(Number(ethBalance) / 1e18 * 2500).toFixed(2)}` : '—'}
        </div>
        <div className="row">
          <button className="btn btn-secondary" onClick={() => refreshBalance()}>
            Refresh
          </button>
        </div>
      </div>

      <div className="card">
        <div className="card-title">Send ETH</div>
        <input
          className="input"
          placeholder="Recipient (0x...)"
          value={sendTo}
          onChange={e => setSendTo(e.target.value)}
          style={{ marginBottom: 8 }}
        />
        <input
          className="input"
          placeholder="Amount (ETH)"
          value={sendAmount}
          onChange={e => setSendAmount(e.target.value)}
          type="number"
          step="0.0001"
        />
        <div className="row">
          <button
            className="btn btn-primary"
            onClick={handleSend}
            disabled={loading || !sendTo || !sendAmount}
          >
            {loading ? <><span className="spinner"></span> Signing...</> : 'Send with FaceID'}
          </button>
        </div>
      </div>

      <div className="card">
        <div className="card-title">Sign Test Transaction</div>
        <div style={{ fontSize: 13, color: '#777', marginBottom: 8 }}>
          Test passkey signing with the wallet contract
        </div>
        <div className="row">
          <button
            className="btn btn-primary"
            onClick={handleTestSign}
            disabled={loading}
          >
            {loading ? <><span className="spinner"></span> Signing...</> : 'Sign with FaceID'}
          </button>
        </div>
      </div>

      <div className="card">
        <div className="card-title">Wallet Info</div>
        <div style={{ fontSize: 12, color: '#555', lineHeight: 1.8 }}>
          <div>Account: {wallet?.nearAccountId}</div>
          <div>Passkey: {wallet?.credentialId?.slice(0, 20)}...</div>
          <div>Path: {wallet?.path}</div>
          <div>MPC: {MPC_CONTRACT}</div>
        </div>
      </div>

      <div className="card">
        <div className="card-title">Session Keys</div>
        <div style={{ fontSize: 13, color: '#777', marginBottom: 8 }}>
          Ed25519 keys that skip FaceID for faster signing. Require FaceID to create/revoke.
        </div>
        {sessionKeys && Object.keys(sessionKeys).length > 0 ? (
          <div style={{ marginBottom: 12 }}>
            {Object.entries(sessionKeys).map(([id, key]) => {
              const expiresAt = Number(key.expires_at) / 1e6 // ns → ms
              const isExpired = Date.now() > expiresAt
              const expiresLabel = isExpired
                ? 'Expired'
                : `Expires ${new Date(expiresAt).toLocaleDateString()}`
              return (
                <div key={id} style={{ padding: '8px 0', borderBottom: '1px solid #222', fontSize: 12 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div>
                      <div style={{ color: isExpired ? '#888' : '#eee', fontWeight: 500 }}>{id}</div>
                      <div style={{ color: isExpired ? '#666' : '#888', marginTop: 2 }}>
                        {key.public_key?.slice(0, 30)}...
                        {' · '}
                        <span style={{ color: isExpired ? '#ef4444' : '#22c55e' }}>{expiresLabel}</span>
                      </div>
                    </div>
                    <button
                      className="btn btn-danger"
                      style={{ fontSize: 11, padding: '4px 10px' }}
                      onClick={() => handleRevokeSession(id)}
                      disabled={sessionLoading}
                    >
                      Revoke
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        ) : sessionKeys ? (
          <div style={{ fontSize: 12, color: '#666', marginBottom: 12 }}>No session keys</div>
        ) : null}
        <div className="row">
          <button
            className="btn btn-secondary"
            onClick={() => refreshSessionKeys()}
            disabled={sessionLoading}
            style={{ flex: 1 }}
          >
            {sessionKeys ? 'Refresh' : 'Load Keys'}
          </button>
          <button
            className="btn btn-primary"
            onClick={handleCreateSession}
            disabled={sessionLoading}
            style={{ flex: 1 }}
          >
            {sessionLoading ? '...' : 'Create Session Key'}
          </button>
        </div>
      </div>

      <button className="btn btn-danger" onClick={handleLogout}>
        Logout
      </button>

      <LogPanel log={log} />
    </div>
  )
}

function LogPanel({ log }) {
  if (log.length === 0) return null
  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div className="card-title">Activity Log</div>
      <div className="log">{log.join('\n')}</div>
    </div>
  )
}

// ─── Helpers ─────────────────────────────────────────────────

function uint8ToBase64(bytes) {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary)
}

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
function base58Encode(data) {
  let num = 0n
  for (const b of data) num = num * 256n + BigInt(b)
  let result = ''
  while (num > 0n) { result = B58[Number(num % 58n)] + result; num /= 58n; }
  for (const b of data) { if (b === 0) result = '1' + result; else break; }
  return result
}

/**
 * Parse a passkey public key from WebAuthn getPublicKey().
 * Returns 91 bytes = DER-encoded SPKI (SubjectPublicKeyInfo) for P-256.
 * NOT COSE/CBOR despite what MDN says in some browsers.
 *
 * SPKI structure for P-256 (91 bytes):
 *   30 59       - SEQUENCE (89 bytes)
 *     30 13     - SEQUENCE (19 bytes) — algorithm identifier
 *       06 07   - OID 1.2.840.10045.2.1 (EC)
 *       06 08   - OID 1.2.840.10045.3.1.7 (P-256)
 *     03 42 00  - BIT STRING (66 bytes, 0 unused bits)
 *       04      - uncompressed point marker
 *       [32 bytes x]
 *       [32 bytes y]
 *
 * For Ed25519 (44 bytes): raw 32-byte key.
 */
function parsePasskeyPublicKey(rawBytes, alg) {
  if (alg === -7) {
    // P-256: SPKI format, uncompressed point at byte 26
    if (rawBytes.length === 91 && rawBytes[26] === 0x04) {
      const x = rawBytes.slice(27, 59)
      const y = rawBytes.slice(59, 91)
      return { x, y }
    }
    // Fallback: try COSE format (0x58 0x20 headers)
    const positions = []
    for (let i = 0; i < rawBytes.length - 33; i++) {
      if (rawBytes[i] === 0x58 && rawBytes[i + 1] === 0x20) {
        positions.push(i + 2)
      }
    }
    if (positions.length >= 2) {
      return {
        x: rawBytes.slice(positions[0], positions[0] + 32),
        y: rawBytes.slice(positions[1], positions[1] + 32),
      }
    }
    throw new Error(`Cannot parse P-256 key: ${rawBytes.length} bytes, no SPKI or COSE format found`)
  }
  throw new Error(`Unsupported algorithm: ${alg}`)
}
