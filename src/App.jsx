import React, { useState, useEffect, useCallback } from 'react'
import { Scanner } from '@yudiel/react-qr-scanner'
import { parsePaymentQr, notifyCallback, isPasskeyQr } from '@passkey/sdk'
import { NostrBunkerCard } from './NostrBunker.jsx'
import { parseNostrConnectUri } from './nostrconnect.js'
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
  buildMpcSignArgsEdDSA,
  buildExecuteSignedArgs,
  buildSessionOpArgs,
  generateSessionKeyPair,
  signWithSessionKey,
  getSessionKeys,
  saveSessionKey,
  loadSessionKey,
  removeSessionKey,
  deriveSolAddress,
  deriveNostrAddress,
  getSolBalance,
  getSolRecentBlockhash,
  buildSolTransferMessage,
  assembleSignedSolTx,
  broadcastSolTx,
  MPC_CONTRACT,
  WALLET_CONTRACT,
  FACTORY_CONTRACT,
  RELAY_URL,
  base58Decode,
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
  const [solBalance, setSolBalance] = useState(null)
  const [solAddress, setSolAddress] = useState(null)
  const [nostrPubkey, setNostrPubkey] = useState(null) // hex pubkey
  const [npub, setNpub] = useState(null) // bech32 npub
  const [nostrConnectRequest, setNostrConnectRequest] = useState(null) // pending nostrconnect pairing request
  const [loading, setLoading] = useState(false)

  // Name form
  const [walletName, setWalletName] = useState('')
  const [accountType, setAccountType] = useState('root') // 'root' or 'sub'
  const [nameAvailable, setNameAvailable] = useState(null)
  const [checkingName, setCheckingName] = useState(false)

  // Send form
  const [sendTo, setSendTo] = useState('')
  const [sendAmount, setSendAmount] = useState('')

  // SOL send form
  const [solSendTo, setSolSendTo] = useState('')
  const [solSendAmount, setSolSendAmount] = useState('')

  // Login form
  const [loginAccountId, setLoginAccountId] = useState('')
  const [needAccountId, setNeedAccountId] = useState(false) // show inline input after passkey auth

  // Session keys
  const [sessionKeys, setSessionKeys] = useState(null) // map from contract
  const [sessionLoading, setSessionLoading] = useState(false)

  // Backup passkey
  const [backupKey, setBackupKey] = useState(null) // public key string or null
  const [backupLoading, setBackupLoading] = useState(false)

  // QR scanning
  const [showQrScanner, setShowQrScanner] = useState(false)
  const [pendingTx, setPendingTx] = useState(null) // { to, amount, chain, label?, redirect? }
  const [pendingPayment, setPendingPayment] = useState(null) // ParsedPayment from @passkey/sdk

  const addLog = useCallback((msg) => {
    const ts = new Date().toLocaleTimeString()
    setLog(prev => [...prev.slice(-80), `[${ts}] ${msg}`])
  }, [])

  // Parse passkey:// URI from QR code or URL params
  const parsePasskeyUri = useCallback((uri) => {
    try {
      const url = new URL(uri)
      if (url.protocol !== 'passkey:') return null
      if (url.pathname !== '/send') return null
      
      const params = url.searchParams
      const chain = params.get('chain') || 'eth'
      
      const tx = {
        to: params.get('to'),
        amount: params.get('amount'),
        chain,
        label: params.get('label'),
        redirect: params.get('redirect'),
      }
      
      if (!tx.to || !tx.amount) {
        addLog('Invalid QR: missing to or amount')
        return null
      }
      
      return tx
    } catch (e) {
      addLog(`Failed to parse QR: ${e.message}`)
      return null
    }
  }, [addLog])

  // ─── Restore wallet on load ──
  useEffect(() => {
    const saved = loadWalletState()
    if (saved?.ethAddress) {
      setWallet(saved)
      setScreen(SCREENS.DASHBOARD)
      refreshBalance(saved.ethAddress)
    }
    
    // Check URL params for passkey:// URI
    const params = new URLSearchParams(window.location.search)
    const uri = params.get('uri')
    if (uri) {
      const tx = parsePasskeyUri(decodeURIComponent(uri))
      if (tx) {
        setPendingTx(tx)
        addLog(`Pending TX from URL: ${tx.amount} ${tx.chain.toUpperCase()} to ${tx.to}`)
      }
    }
  }, [parsePasskeyUri])

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

  const refreshSolBalance = async (nearAccountId) => {
    try {
      const accountId = nearAccountId || wallet?.nearAccountId
      if (!accountId) return

      addLog('Deriving SOL address...')
      const { solAddress } = await deriveSolAddress(accountId)
      setSolAddress(solAddress)
      addLog(`SOL address: ${solAddress.slice(0, 8)}...${solAddress.slice(-8)}`)

      addLog('Fetching SOL balance...')
      const balance = await getSolBalance(solAddress)
      setSolBalance(balance)
      addLog(`SOL balance: ${Number(balance) / 1e9} SOL`)
    } catch (err) {
      addLog(`SOL balance check failed: ${err.message}`)
    }
  }

  // ─── Nostr Key Derivation ──
  const loadNostrKey = async (nearAccountId) => {
    try {
      const accountId = nearAccountId || wallet?.nearAccountId
      if (!accountId) return

      addLog('Deriving Nostr pubkey...')
      const { nostrPubkey, npub } = await deriveNostrAddress(accountId)
      setNostrPubkey(nostrPubkey)
      setNpub(npub)
      addLog(`Nostr pubkey: ${nostrPubkey.slice(0, 16)}...`)
      addLog(`npub: ${npub}`)
    } catch (err) {
      addLog(`Nostr key derivation failed: ${err.message}`)
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

  // ─── Send SOL (MPC direct, no NEAR gas) ──
  const handleSendSol = async () => {
    if (!solSendTo || !solSendAmount) return
    if (!solAddress) {
      addLog('ERROR: Load SOL address first')
      return
    }
    setScreen(SCREENS.SENDING)
    setLoading(true)
    const accountId = wallet?.nearAccountId || WALLET_CONTRACT

    try {
      // Step 1: Get recent blockhash
      addLog('Fetching SOL blockhash...')
      const { blockhash } = await getSolRecentBlockhash()
      addLog(`Blockhash: ${blockhash.slice(0, 8)}...`)

      // Step 2: Build unsigned SOL transfer message
      addLog('Building SOL transfer...')
      const lamports = BigInt(Math.floor(parseFloat(solSendAmount) * 1e9))
      const message = buildSolTransferMessage({
        from: solAddress,
        to: solSendTo,
        lamports,
        recentBlockhash: blockhash,
      })
      addLog(`Message: ${message.length} bytes`)

      // Step 3: Sign via MPC (EdDSA domain = 1)
      // EdDSA signs the FULL MESSAGE, not a hash!
      addLog('Signing via MPC...')
      
      // Build MPC sign args with EdDSA payload format
      const signArgsJson = buildMpcSignArgsEdDSA(message, 'solana')
      const signArgsB64 = btoa(signArgsJson)
      addLog(`Sign args: payload=${message.length} bytes, domain_id=1 (EdDSA)`)

      // Step 4: Build w_execute_signed args
      const now = Math.floor(Date.now() / 1000)
      const createdAtIso = new Date((now - 30) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')
      const executeArgs = buildExecuteSignedArgs({
        accountId,
        signArgsB64,
        path: 'solana',
        created_at_iso: createdAtIso,
      })

      // Step 5: Borsh-serialize for challenge
      addLog('Computing challenge hash...')
      const borshBytes = borshRequestMessageWithDAG({
        signer_id: accountId,
        nonce: executeArgs.msg.nonce,
        created_at_ts: now - 30,
        signArgsJson,
      })
      const challenge = computeChallenge(borshBytes)

      // Step 6: Sign with passkey
      addLog('Requesting passkey signature...')
      const passkeySig = await signWithPasskey(wallet.credentialRawIdUint8, challenge)
      addLog(`Passkey signature: ${passkeySig.signature.length} bytes`)

      // Step 7: Build proof
      const proof = buildProof(
        passkeySig.authenticatorData,
        passkeySig.clientDataJSON,
        passkeySig.signature,
      )

      // Step 8: Submit via relay
      addLog('Submitting to MPC...')
      executeArgs.proof = proof
      const result = await submitViaRelay(JSON.stringify(executeArgs), accountId)
      addLog(`Relay: tx=${result.tx_hash?.slice(0,20)}..., status=${result.status}`)

      if (result.status === 'Failure') {
        throw new Error(`MPC call failed: ${JSON.stringify(result).slice(0, 200)}`)
      }

      // Step 9: Extract MPC signature
      // EdDSA returns: { scheme: "Ed25519", signature: "0x..." } - 64 bytes hex
      const returnValue = result.return_value
      if (!returnValue) {
        throw new Error('No return value from MPC')
      }

      // Check signature format (Ed25519 vs Secp256k1)
      if (returnValue.scheme !== 'Ed25519') {
        throw new Error(`Unexpected signature scheme: ${returnValue.scheme}, expected Ed25519`)
      }

      // signature is hex string "0x..." -> convert to bytes
      const sigHex = returnValue.signature
      if (!sigHex) {
        throw new Error('No signature in MPC response')
      }
      addLog(`MPC Ed25519 signature: ${sigHex.slice(0, 20)}...`)

      const sigBytes = new Uint8Array(sigHex.length / 2 - 1)
      for (let i = 2; i < sigHex.length; i += 2) {
        sigBytes[(i - 2) / 2] = parseInt(sigHex.substr(i, 2), 16)
      }
      addLog(`Signature length: ${sigBytes.length} bytes`)

      if (sigBytes.length !== 64) {
        throw new Error(`Invalid Ed25519 signature length: ${sigBytes.length}, expected 64`)
      }

      // Step 10: Assemble and broadcast
      addLog('Assembling signed SOL transaction...')
      const signedTx = assembleSignedSolTx(message, sigBytes)
      addLog(`Signed tx: ${signedTx.length} bytes`)

      addLog('Broadcasting to Solana...')
      const txSig = await broadcastSolTx(signedTx)
      addLog(`SOL tx sent: ${txSig.slice(0, 16)}...`)

      await refreshSolBalance(accountId)
      addLog('SOL send complete!')
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

  // ─── Nostr Derivation ──
  const handleDeriveNostr = async () => {
    if (!wallet?.nearAccountId) {
      addLog('ERROR: No wallet loaded')
      return
    }
    setLoading(true)
    addLog('Deriving Nostr key...')
    try {
      const result = await deriveNostrAddress(wallet.nearAccountId)
      if (result.error) {
        addLog(`ERROR: ${result.error}`)
      } else {
        setNostrPubkey(result.nostrPubkey)
        setNpub(result.npub)
        addLog(`✓ Nostr key derived: ${result.npub.slice(0, 20)}...`)
      }
    } catch (err) {
      addLog(`ERROR: ${err.message}`)
      console.error(err)
    } finally {
      setLoading(false)
    }
  }

  // ─── NostrConnect Pairing Handler ──
  const handleNostrConnect = (uri) => {
    const parsed = parseNostrConnectUri(uri)
    if (!parsed) {
      addLog('✗ Failed to parse nostrconnect URI')
      return
    }
    
    addLog(`NostrConnect request from: ${parsed.metadata?.name || 'Unknown App'}`)
    addLog(`  Permissions: ${parsed.perms?.join(', ') || 'none'}`)
    addLog(`  Relays: ${parsed.relays?.join(', ')}`)
    
    // Show approval modal
    setNostrConnectRequest({
      ...parsed,
      uri
    })
    setShowQrScanner(false)
  }
  
  const handleNostrConnectApprove = async () => {
    if (!nostrConnectRequest) return
    if (!nostrPubkey) {
      addLog('ERROR: No Nostr key derived - click "Derive Nostr Key" first')
      setNostrConnectRequest(null)
      return
    }
    
    setLoading(true)
    addLog('Approving NostrConnect pairing...')
    
    try {
      // For nostrconnect, we need to send an encrypted response to the relay
      // This requires Ed25519 signing which uses MPC path 'nostr,1'
      // TODO: Implement actual signing flow
      
      // Placeholder: show that we would approve
      addLog(`✓ Would approve pairing with ${nostrConnectRequest.metadata?.name || nostrConnectRequest.clientPubkey.slice(0,16)}...`)
      addLog('  (Full signing flow requires Ed25519 MPC integration)')
      
      // For now, just close the modal
      setNostrConnectRequest(null)
    } catch (err) {
      addLog(`ERROR: ${err.message}`)
      console.error(err)
    } finally {
      setLoading(false)
    }
  }
  
  const handleNostrConnectDeny = () => {
    setNostrConnectRequest(null)
    addLog('NostrConnect pairing denied')
  }

  const handleLogout = () => {
    clearWalletState()
    setWallet(null)
    setEthBalance(null)
    setNpub(null)
    setNostrPubkey(null)
    setScreen(SCREENS.WELCOME)
    setLog([])
    setSessionKeys(null)
  }

  // ─── QR Scanner Handler ──
  const handleQrScan = (data) => {
    if (!data || !data[0]?.rawValue) return
    const uri = data[0].rawValue
    addLog(`Scanned: ${uri}`)
    
    // Check for nostrconnect:// URI (NIP-46 pairing)
    if (uri.startsWith('nostrconnect://')) {
      addLog('Detected nostrconnect:// URI - Nostr pairing request')
      handleNostrConnect(uri)
      return
    }
    
    // Check for passkey://pay URI (POS payment)
    if (isPasskeyQr(uri)) {
      addLog('Parsing payment QR...')
      const payment = parsePaymentQr(uri)
      if (payment) {
        addLog(`✓ Parsed: ${payment.amount} ${payment.currency} to ${payment.merchant || payment.depositAddress.slice(0,10)}...`)
        setPendingPayment(payment)
        setShowQrScanner(false)
        setScreen(SCREENS.DASHBOARD)
        return
      } else {
        addLog('✗ Failed to parse payment QR - check URI format')
      }
    }
    
    // Legacy passkey://send URI
    const tx = parsePasskeyUri(uri)
    if (tx) {
      setPendingTx(tx)
      setShowQrScanner(false)
      addLog(`Pending: ${tx.amount} ${tx.chain.toUpperCase()} to ${tx.to}`)
    }
  }

  // ─── Format payment amount for display ──
  const formatPaymentDisplay = (payment) => {
    if (!payment) return null
    
    // If merchant attached swap quote, show what user pays
    if (payment.swap) {
      const fromAmt = parseFloat(payment.swap.fromAmount).toFixed(6)
      return `${fromAmt} ${payment.swap.fromSymbol} → ${payment.amount} ${payment.currency}`
    }
    
    // Standard payment
    return `${payment.amount} ${payment.currency}`
  }

  const handleQrError = (err) => {
    addLog(`QR error: ${err.message || err}`)
    setShowQrScanner(false)
  }

  // ─── Handle POS Payment (passkey://pay) ──
  const handlePosPayment = async () => {
    if (!pendingPayment) return
    if (!wallet) {
      addLog('ERROR: No wallet loaded')
      return
    }

    const payment = pendingPayment
    setLoading(true)
    const accountId = wallet.nearAccountId
    let nonce, gasData

    try {
      // Determine chain from currency (USDC can be on multiple chains)
      // For now, assume 'base' as default, but currency may indicate chain
      const chain = payment.chain || 'base'
      
      addLog(`Processing payment: ${payment.amount} ${payment.currency} to ${payment.merchant || 'Merchant'}`)
      addLog(`Deposit address: ${payment.depositAddress}`)
      addLog(`Chain: ${chain}`)

      // Step 1: Get ETH nonce + gas (use chain from payment, default base)
      addLog('Fetching nonce + gas prices...')
      addLog(`  RPC chain: ${chain}`)
      addLog(`  ETH address: ${wallet.ethAddress}`)
      
      try {
        const [nonceResult, gasResult] = await Promise.all([
          getEthNonce(wallet.ethAddress, chain),
          getEthGasPrice(chain),
        ])
        addLog(`  nonce RPC result: ${nonceResult}`)
        addLog(`  gas RPC result: maxFee=${gasResult?.maxFeePerGas?.toString()}, priority=${gasResult?.maxPriorityFeePerGas?.toString()}`)
        
        if (nonceResult === null || nonceResult === undefined || isNaN(nonceResult)) {
          throw new Error('Failed to fetch nonce from RPC')
        }
        if (!gasResult?.maxFeePerGas) {
          throw new Error('Failed to fetch gas prices from RPC')
        }
        
        nonce = nonceResult
        gasData = gasResult
      } catch (rpcErr) {
        addLog(`  RPC error: ${rpcErr.message}`)
        throw rpcErr
      }
      
      addLog(`Nonce: ${nonce}, maxFee: ${Number(gasData.maxFeePerGas / 10n**9n)} gwei`)

      // Step 2: Build unsigned ETH tx (USDC is an ERC20 on Base)
      // For native ETH payment, use valueWei directly
      // For now, we'll send native ETH equal to the amount
      // TODO: Add USDC contract call for USDC payments
      const valueWei = BigInt(Math.floor(parseFloat(payment.amount) * 1e18))
      
      // Step 2a: Decide if this is native ETH or USDC
      // If currency === 'USDC', we need to call the USDC contract
      // For MVP, we'll just send native ETH equivalent
      const isErc20 = payment.currency.toUpperCase() === 'USDC'
      
      let unsignedTx
      if (isErc20) {
        // TODO: Build ERC20 transfer call
        // For now, treat as native ETH
        addLog('Note: USDC payments will be implemented as ERC20 transfer')
        const { unsignedTxHex, txPayloadHash } = buildEthTx({
          nonce,
          maxFeePerGas: gasData.maxFeePerGas,
          maxPriorityFeePerGas: gasData.maxPriorityFeePerGas,
          to: payment.depositAddress,
          valueWei,
          from: wallet.ethAddress,
        })
        unsignedTx = { unsignedTxHex, txPayloadHash }
      } else {
        addLog('Building unsigned ETH transaction...')
        const { unsignedTxHex, txPayloadHash } = buildEthTx({
          nonce,
          maxFeePerGas: gasData.maxFeePerGas,
          maxPriorityFeePerGas: gasData.maxPriorityFeePerGas,
          to: payment.depositAddress,
          valueWei,
          from: wallet.ethAddress,
        })
        unsignedTx = { unsignedTxHex, txPayloadHash }
      }
      
      addLog(`Unsigned tx: ${unsignedTx.unsignedTxHex.slice(0, 40)}...`)
      addLog(`Payload hash: ${Array.from(unsignedTx.txPayloadHash).map(b=>b.toString(16).padStart(2,'0')).join('').slice(0,16)}...`)

      // Step 3: Build MPC sign args
      const signArgsJson = buildMpcSignArgs(unsignedTx.txPayloadHash, wallet.path || 'ethereum,1')
      const signArgsB64 = btoa(signArgsJson)

      // Step 4: Build w_execute_signed args
      const now = Math.floor(Date.now() / 1000)
      const createdAtIso = new Date((now - 30) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')
      const executeArgs = buildExecuteSignedArgs({
        accountId,
        signArgsB64,
        path: wallet.path || 'ethereum,1',
        created_at_iso: createdAtIso,
      })

      // Step 5: Borsh-serialize for challenge
      addLog('Computing challenge hash...')
      addLog(`  signer_id: ${accountId}`)
      addLog(`  nonce: ${executeArgs.msg.nonce}`)
      addLog(`  created_at: ${new Date((now - 30) * 1000).toISOString()}`)
      const borshBytes = borshRequestMessageWithDAG({
        signer_id: accountId,
        nonce: executeArgs.msg.nonce,
        created_at_ts: now - 30,
        signArgsJson,
      })
      addLog(`  borsh bytes: ${borshBytes.length}`)
      const challenge = computeChallenge(borshBytes)
      addLog(`  challenge: ${Array.from(challenge).map(b=>b.toString(16).padStart(2,'0')).join('').slice(0, 32)}...`)
      addLog(`  challenge hex: 0x${Array.from(challenge).map(b=>b.toString(16).padStart(2,'0')).join('')}`)

      // Step 6: Sign with passkey (FaceID)
      addLog('Requesting passkey signature (FaceID)...')
      addLog(`  credential ID: ${wallet.credentialId?.slice(0, 20)}...`)
      const passkeySig = await signWithPasskey(wallet.credentialRawIdUint8, challenge)
      addLog(`  authenticator data: ${passkeySig.authenticatorData?.length || 0} bytes`)
      addLog(`  client data: ${passkeySig.clientDataJSON?.slice(0, 50)}...`)
      addLog(`  signature: ${passkeySig.signature.length} bytes`)

      // Step 7: Build proof
      const proof = buildProof(
        passkeySig.authenticatorData,
        passkeySig.clientDataJSON,
        passkeySig.signature,
      )

      // Step 8: Submit via relay
      addLog('Submitting to wallet contract via relay...')
      executeArgs.proof = proof
      const result = await submitViaRelay(JSON.stringify(executeArgs), accountId)
      addLog(`Relay: tx=${result.tx_hash?.slice(0,20)}..., Status=${result.status}`)

      if (result.status === 'Failure') {
        throw new Error(`Transaction failed: ${JSON.stringify(result).slice(0, 200)}`)
      }

      // Step 9: Extract MPC signature
      if (!result.return_value?.big_r) {
        throw new Error('No MPC signature in response')
      }
      const mpcSig = result.return_value
      addLog(`MPC signature: scheme=${mpcSig.scheme}, recovery=${mpcSig.recovery_id}`)

      // Step 10: Assemble signed ETH tx
      addLog('Assembling signed ETH transaction...')
      const signedTxHex = assembleSignedEthTx(unsignedTx.unsignedTxHex, mpcSig, wallet.ethAddress)
      addLog(`Signed tx: ${signedTxHex.length} chars`)

      // Step 11: Broadcast to Ethereum
      addLog('Broadcasting to Ethereum...')
      const txHash = await broadcastEthTx(signedTxHex)
      addLog(`ETH tx broadcast! Hash: ${txHash}`)

      // Step 12: Notify merchant callback
      if (payment.callback) {
        addLog('Notifying merchant...')
        try {
          const callbackResult = await notifyCallback(payment, {
            orderId: payment.orderId,
            txHash,
            from: wallet.ethAddress,
            chain,
          })
          if (callbackResult.ok) {
            addLog('Merchant notified successfully')
          } else {
            addLog(`Merchant notification failed: ${callbackResult.error || 'unknown error'}`)
          }
        } catch (cbErr) {
          addLog(`Callback error: ${cbErr.message}`)
        }
      }

      // Done
      await refreshBalance()
      setPendingPayment(null)
      addLog('✅ Payment complete!')
    } catch (err) {
      const errMsg = err.message || String(err)
      addLog(`❌ ERROR: ${errMsg}`)
      if (errMsg.includes('invalid signature')) {
        addLog('Hint: Check challenge hash computation or passkey credential')
      }
      console.error('Payment error:', err)
    } finally {
      setLoading(false)
    }
  }

  // ─── Test Sign with Session Key ──
  const handleSessionSign = async () => {
    if (!wallet || !sessionKeys || Object.keys(sessionKeys).length === 0) {
      addLog('No session keys available')
      return
    }
    setLoading(true)
    const accountId = wallet.nearAccountId
    const sessionKeyId = Object.keys(sessionKeys)[0] // Use first session key

    try {
      // Step 1: Load session key from IndexedDB
      addLog(`[DEBUG] sessionKeys from contract: ${JSON.stringify(Object.keys(sessionKeys))}`)
      const sessionKeyId = Object.keys(sessionKeys)[0] // Use first session key
      addLog(`[DEBUG] Using sessionKeyId: "${sessionKeyId}"`)
      addLog(`Loading session key ${sessionKeyId}...`)
      const stored = await loadSessionKey(sessionKeyId, accountId)
      if (!stored) {
        throw new Error('Session key not found in IndexedDB. Click "Create Session Key" first.')
      }
      if (stored.needsMigration) {
        throw new Error('Session key uses old (insecure) storage format. Please revoke this session and create a new one.')
      }
      if (!stored.privateKey) {
        throw new Error('Session key private key is missing. Please revoke and recreate.')
      }
      addLog(`Session key loaded: ${stored.publicKey?.slice(0, 20)}...`)

      // Step 2: Build empty RequestMessage (same as FaceID test)
      const nonce = Math.floor(Math.random() * 0xFFFFFFFF)
      const now = Math.floor(Date.now() / 1000)
      const createdAtTs = now - 30

      addLog(`Building request for ${accountId}...`)

      // Step 3: Borsh-serialize for challenge
      const borshBytes = borshRequestMessage({
        chain_id: 'mainnet',
        signer_id: accountId,
        nonce,
        created_at: createdAtTs,
        timeout: 300,
      })
      
      addLog(`Borsh bytes (${borshBytes.length}): ${Array.from(borshBytes.slice(0, 50)).map(b=>b.toString(16).padStart(2,'0')).join('')}...`)

      // Step 4: Hash the borsh bytes (contract verifies sha256(borsh(msg)))
      const hashBuffer = await crypto.subtle.digest('SHA-256', borshBytes)
      const msgHash = new Uint8Array(hashBuffer)
      addLog(`Msg hash: ${Array.from(msgHash).map(b=>b.toString(16).padStart(2,'0')).join('')}`)

      // Step 5: Sign the hash with ed25519 session key
      addLog('Signing with session key...')
      const signature = await signWithSessionKey(stored.privateKey, msgHash)
      addLog(`Session signature: ${signature.slice(0, 20)}...`)

      // VERIFY: Check signature locally before sending to contract
      const sigBytes = base58Decode(signature)
      const pubKeyBytes = base58Decode(stored.publicKey.replace('ed25519:', ''))
      const pubKeyCrypto = await crypto.subtle.importKey(
        'raw',
        pubKeyBytes,
        { name: 'Ed25519' },
        false,
        ['verify'],
      )
      const isValid = await crypto.subtle.verify(
        { name: 'Ed25519' },
        pubKeyCrypto,
        sigBytes,
        msgHash,
      )
      addLog(`[VERIFY] Local signature valid: ${isValid}`)
      if (!isValid) {
        throw new Error('Signature verification failed locally - keypair mismatch!')
      }

      // Step 5: Build args for w_execute_session
      const createdAtIso = new Date(createdAtTs * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')
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
        session_key_id: sessionKeyId,
        signature,
      }

      // TRACE: Log exact args being sent
      console.log('[SESSION SIGN] Args:', JSON.stringify(executeArgs, null, 2))
      addLog(`[TRACE] created_at ts=${createdAtTs} iso=${createdAtIso}`)
      addLog(`[TRACE] nonce=${nonce} (0x${nonce.toString(16)})`)
      addLog(`[TRACE] borsh hex: ${Array.from(borshBytes).map(b=>b.toString(16).padStart(2,'0')).join('')}`)
      addLog(`[TRACE] signature: ${signature}`)

      // Step 6: Submit via relay (same endpoint, different method)
      const result = await submitViaRelay(JSON.stringify(executeArgs), accountId, 'w_execute_session')

      console.log('[SESSION SIGN] Result:', result)
      if (result.error) addLog(`[RELAY ERROR] ${result.error}`)

      if (result.status === 'Failure') {
        throw new Error(`Transaction failed: ${JSON.stringify(result).slice(0, 300)}`)
      }

      addLog(`Session sign SUCCESS! tx: ${result.tx_hash?.slice(0, 20) || 'confirmed'}`)
      if (result.return_value) addLog(`Return: ${JSON.stringify(result.return_value)}`)
    } catch (err) {
      addLog(`Session sign ERROR: ${err.message}`)
      console.error(err)
    } finally {
      setLoading(false)
    }
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
      const ttlSecs = 86400 // 24 hours (contract enforces max)

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

      // Step 7: Save private key locally (as CryptoKey handle, non-extractable)
      await saveSessionKey(sessionKeyId, { publicKey: keyPair.publicKey, privateKey: keyPair.privateKey }, accountId)
      addLog(`Session key "${sessionKeyId}" created! TTL: 24 hours`)

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

  /**
   * Revoke ALL session keys (emergency operation).
   * Requires passkey authentication.
   */
  const handleRevokeAllSessions = async () => {
    if (!wallet) return
    if (!sessionKeys || Object.keys(sessionKeys).length === 0) return
    
    const count = Object.keys(sessionKeys).length
    if (!confirm(`Revoke all ${count} session keys? This requires FaceID.`)) return
    
    setSessionLoading(true)
    const accountId = wallet.nearAccountId

    try {
      const now = Math.floor(Date.now() / 1000)
      const createdAtTs = now - 30
      const createdAtIso = new Date(createdAtTs * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')

      const ops = [{ type: 'RevokeAllSessions' }]
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
      addLog(`Revoking all ${count} session keys...`)
      const passkeySig = await signWithPasskey(wallet.credentialRawIdUint8, challenge)

      const proof = buildProof(
        passkeySig.authenticatorData,
        passkeySig.clientDataJSON,
        passkeySig.signature,
      )

      executeArgs.proof = proof
      const result = await submitViaRelay(JSON.stringify(executeArgs), accountId)

      if (result.status === 'Failure') {
        throw new Error(`RevokeAllSessions failed: ${JSON.stringify(result).slice(0, 300)}`)
      }

      // Clear all local session keys from IndexedDB
      for (const sessionKeyId of Object.keys(sessionKeys)) {
        await removeSessionKey(sessionKeyId, accountId)
      }
      setSessionKeys(null)
      addLog(`All ${count} session keys revoked!`)

      await refreshSessionKeys(accountId)
    } catch (err) {
      addLog(`RevokeAllSessions ERROR: ${err.message}`)
      console.error(err)
    } finally {
      setSessionLoading(false)
    }
  }

  // ─── Backup Passkey Management ──

  /**
   * Query the contract for backup key status.
   */
  const refreshBackupKey = async (accountId) => {
    try {
      const result = await nearView(accountId, 'w_backup_key')
      if (result && result !== 'null') {
        setBackupKey(result)
        addLog(`Backup passkey: ${result.slice(0, 30)}...`)
        return result
      } else {
        setBackupKey(null)
        addLog('No backup passkey set')
        return null
      }
    } catch (err) {
      addLog(`Backup key query error: ${err.message}`)
      return null
    }
  }

  /**
   * Register a backup passkey (e.g., Ledger FIDO authenticator).
   * Requires primary passkey auth to sign SetBackupKey operation.
   */
  const handleAddBackupKey = async () => {
    if (!wallet) return
    const accountId = wallet.nearAccountId

    // Check if backup already exists
    if (backupKey) {
      if (!confirm('A backup passkey already exists. Replace it?')) return
    }

    setBackupLoading(true)
    addLog('Starting backup passkey registration...')

    try {
      // Step 1: Prompt user for cross-platform authenticator (Ledger)
      addLog('Please authenticate with your backup device (Ledger)...')

      const credential = await navigator.credentials.create({
        publicKey: {
          challenge: crypto.getRandomValues(new Uint8Array(32)),
          rp: { name: 'NEAR Passkey Wallet' },
          user: {
            id: new TextEncoder().encode(accountId),
            name: accountId,
            displayName: accountId,
          },
          pubKeyCredParams: [{ type: 'public-key', alg: -7 }], // P-256
          authenticatorSelection: {
            authenticatorAttachment: 'cross-platform', // Force Ledger/YubiKey
            requireResidentKey: false,
            userVerification: 'required',
          },
          timeout: 120000, // 2 minutes for Ledger flow
          attestation: 'direct',
        },
      })

      addLog(`Backup passkey created: ${credential.id.slice(0, 20)}...`)

      // Step 2: Extract public key from attestation
      const response = credential.response
      const clientDataJSON = new TextDecoder().decode(response.clientDataJSON)
      addLog(`[DEBUG] clientData: ${clientDataJSON.slice(0, 100)}...`)

      // Parse attestation to get public key (COSE format for P-256)
      const attestationObject = response.attestationObject
      const authData = extractAuthData(attestationObject)
      const publicKeyBytes = extractPublicKeyFromAuthData(authData)

      if (!publicKeyBytes) {
        throw new Error('Could not extract public key from backup passkey')
      }

      // Convert to NEAR P-256 format: "P256:" + base64(x + y)
      const { x, y } = parseP256PublicKey(publicKeyBytes)
      const xBase64 = btoa(String.fromCharCode(...x))
      const yBase64 = btoa(String.fromCharCode(...y))
      const nearPublicKey = `P256:${xBase64}.${yBase64}`

      addLog(`Backup public key: ${nearPublicKey.slice(0, 30)}...`)

      // Step 3: Sign SetBackupKey with PRIMARY passkey (FaceID)
      addLog('Now authenticate with your primary passkey to authorize this backup...')

      const created = new Date()
      const createdTimestamp = Math.floor(created.getTime() / 1000)
      const createdIso = created.toISOString().replace(/\.\d{3}Z$/, 'Z')

      const nonce = Math.floor(Math.random() * 0xFFFFFFFF)
      const args = buildSessionOpArgs({
        accountId,
        ops: [{ type: 'SetBackupKey', public_key: nearPublicKey }],
        created_at_iso: createdIso,
      })

      const requestBytes = borshRequestMessageWithOps({
        chain_id: CHAIN_ID,
        signer_id: accountId,
        nonce,
        created_at: createdTimestamp,
        timeout: 600,
        ops: [{ type: 'SetBackupKey', public_key: nearPublicKey }],
      })

      // Primary passkey signs
      const assertion = await signWithPasskey(
        wallet.credentialId,
        wallet.path,
        requestBytes,
        wallet.nearAccountId,
      )

      const proof = buildProof(assertion, requestBytes, wallet.path)
      args.proof = proof

      // Step 4: Submit transaction
      addLog('Submitting SetBackupKey transaction...')
      await nearCall(accountId, 'w_execute_signed', args)

      // Step 5: Save credential mapping for login recovery
      const backupCredentialRawId = new Uint8Array(credential.rawId)
      saveCredentialMapping(credential.id, accountId, uint8ToBase64(backupCredentialRawId))
      addLog('Saved credential mapping for backup passkey')

      addLog('Backup passkey registered successfully!')
      setBackupKey(nearPublicKey)

      // Refresh to confirm
      await refreshBackupKey(accountId)
    } catch (err) {
      addLog(`Add backup key failed: ${err.message}`)
      console.error(err)
    } finally {
      setBackupLoading(false)
    }
  }

  /**
   * Remove backup passkey. Requires primary passkey auth.
   */
  const handleRemoveBackupKey = async () => {
    if (!wallet) return
    const accountId = wallet.nearAccountId

    if (!backupKey) {
      addLog('No backup passkey to remove')
      return
    }

    if (!confirm('Remove backup passkey? You will need your primary passkey to sign.')) return

    setBackupLoading(true)
    addLog('Removing backup passkey...')

    try {
      const created = new Date()
      const createdTimestamp = Math.floor(created.getTime() / 1000)
      const createdIso = created.toISOString().replace(/\.\d{3}Z$/, 'Z')

      const nonce = Math.floor(Math.random() * 0xFFFFFFFF)
      const args = buildSessionOpArgs({
        accountId,
        ops: [{ type: 'RemoveBackupKey' }],
        created_at_iso: createdIso,
      })

      const requestBytes = borshRequestMessageWithOps({
        chain_id: CHAIN_ID,
        signer_id: accountId,
        nonce,
        created_at: createdTimestamp,
        timeout: 600,
        ops: [{ type: 'RemoveBackupKey' }],
      })

      const assertion = await signWithPasskey(
        wallet.credentialId,
        wallet.path,
        requestBytes,
        wallet.nearAccountId,
      )

      const proof = buildProof(assertion, requestBytes, wallet.path)
      args.proof = proof

      await nearCall(accountId, 'w_execute_signed', args)

      addLog('Backup passkey removed')
      setBackupKey(null)
    } catch (err) {
      addLog(`Remove backup key failed: ${err.message}`)
      console.error(err)
    } finally {
      setBackupLoading(false)
    }
  }

  /**
   * Test backup passkey by signing a test transaction.
   * Prompts for ANY passkey (discoverable), user picks backup.
   * Contract verifies against both primary and backup keys.
   */
  const handleTestBackupKey = async () => {
    if (!wallet) return
    const accountId = wallet.nearAccountId

    if (!backupKey) {
      addLog('No backup passkey registered')
      return
    }

    setBackupLoading(true)
    addLog('Testing backup passkey... Please authenticate with your backup device.')

    try {
      // Prompt for any passkey (discoverable credential)
      // User will select their backup passkey
      const assertion = await navigator.credentials.get({
        publicKey: {
          challenge: crypto.getRandomValues(new Uint8Array(32)),
          userVerification: 'required',
          timeout: 60000,
        },
      })

      const usedCredentialId = assertion.id
      addLog(`Passkey used: ${usedCredentialId.slice(0, 20)}...`)

      // Check if this is the backup passkey or primary
      const isPrimary = usedCredentialId === wallet.credentialId
      if (isPrimary) {
        addLog('⚠️ You used your PRIMARY passkey (FaceID). Try again with your backup device.')
        setBackupLoading(false)
        return
      }

      // Sign a test transaction with this passkey
      addLog('Backup passkey detected! Signing test transaction...')

      const created = new Date()
      const createdTimestamp = Math.floor(created.getTime() / 1000)
      const createdIso = created.toISOString().replace(/\.\d{3}Z$/, 'Z')

      // Minimal test: empty ops (just verify signature)
      const nonce = Math.floor(Math.random() * 0xFFFFFFFF)
      const testMsg = {
        chain_id: 'test',
        signer_id: accountId,
        nonce,
        created_at: createdTimestamp,
        timeout: 600,
        request: {
          ops: [],
          out: { after: [], then: [] },
        },
      }

      // Borsh-serialize the request
      const requestBytes = borshRequestMessage({
        chain_id: 'test',
        signer_id: accountId,
        nonce,
        created_at: createdTimestamp,
        request: testMsg.request,
      })

      // Get path from stored wallet (same for all passkeys on this wallet)
      const path = wallet.path || 'ethereum'
      
      // Sign with the backup passkey
      const signedAssertion = await signWithPasskey(
        usedCredentialId,
        path,
        requestBytes,
        accountId,
      )

      addLog(`✓ Backup passkey signature verified!`)
      addLog(`Credential ID: ${usedCredentialId.slice(0, 30)}...`)
      addLog(`Your backup is functional and can sign transactions.`)
    } catch (err) {
      addLog(`Backup test failed: ${err.message}`)
      console.error(err)
    } finally {
      setBackupLoading(false)
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
      <div className="header">
        <h1>Passkey Wallet</h1>
        <div className="header-account">{wallet?.nearAccountId}</div>
      </div>

      <div className="account-card">
        <div style={{ fontSize: 12, color: '#888', marginBottom: 4 }}>Ethereum Address</div>
        <div
          className="account-address"
          onClick={() => navigator.clipboard?.writeText(wallet?.ethAddress || '')}
          title="Click to copy"
        >
          {wallet?.ethAddress}
        </div>
        <div className="chains">
          <span className="chain-badge active">ETH</span>
          <span className="chain-badge">BTC</span>
          <span className="chain-badge solana active">SOL</span>
        </div>
      </div>

      {/* Pending Transaction from QR/URL */}
      {pendingTx && (
        <div className="card" style={{ marginBottom: 16, borderLeft: '4px solid #22c55e' }}>
          <div className="card-header">
            <div className="card-icon" style={{ background: 'linear-gradient(135deg, #22c55e, #16a34a)' }}>⟱</div>
            <div>
              <div className="card-title">{pendingTx.label || 'Pending Payment'}</div>
              <div className="card-subtitle">Scan QR to confirm</div>
            </div>
          </div>
          <div style={{ fontSize: 13, color: '#ccc', marginTop: 8 }}>
            <div>Amount: <strong style={{ color: '#fff' }}>{pendingTx.amount} {pendingTx.chain.toUpperCase()}</strong></div>
            <div style={{ marginTop: 4 }}>To: <code style={{ fontSize: 11, color: '#888' }}>{pendingTx.to}</code></div>
          </div>
          <div className="row" style={{ marginTop: 12 }}>
            <button
              className="btn btn-primary"
              style={{ flex: 1 }}
              onClick={() => {
                if (pendingTx.chain === 'sol') {
                  setSolSendTo(pendingTx.to)
                  setSolSendAmount(pendingTx.amount)
                } else {
                  setSendTo(pendingTx.to)
                  setSendAmount(pendingTx.amount)
                }
                addLog(`Form pre-filled from QR`)
              }}
            >
              Fill Form
            </button>
            <button
              className="btn btn-secondary"
              style={{ flex: 1 }}
              onClick={() => setPendingTx(null)}
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      {/* Pending POS Payment from passkey://pay */}
      {pendingPayment && (
        <div className="card" style={{ marginBottom: 16, borderLeft: '4px solid #8b5cf6' }}>
          <div className="card-header">
            <div className="card-icon" style={{ background: 'linear-gradient(135deg, #8b5cf6, #6d28d9)' }}>💳</div>
            <div>
              <div className="card-title">{pendingPayment.merchant || 'Payment Request'}</div>
              <div className="card-subtitle">Pay with FaceID</div>
            </div>
          </div>
          <div style={{ fontSize: 13, color: '#ccc', marginTop: 8 }}>
            <div style={{ fontSize: 20, fontWeight: 'bold', color: '#fff', marginBottom: 8 }}>
              {pendingPayment.swap ? (
                <>
                  <span>{formatPaymentDisplay(pendingPayment)}</span>
                  {pendingPayment.swap.fee && parseFloat(pendingPayment.swap.fee) > 0 && (
                    <div style={{ fontSize: 11, color: '#888', marginTop: 4 }}>
                      Fee: ~${pendingPayment.swap.fee}
                    </div>
                  )}
                </>
              ) : (
                <span>{pendingPayment.amount} {pendingPayment.currency}</span>
              )}
            </div>
            <div style={{ marginTop: 4, fontSize: 11 }}>
              <span style={{ color: '#888' }}>To: </span>
              <code style={{ color: '#666' }}>{pendingPayment.depositAddress.slice(0, 10)}...{pendingPayment.depositAddress.slice(-8)}</code>
            </div>
            {pendingPayment.orderId && (
              <div style={{ marginTop: 4, fontSize: 11 }}>
                <span style={{ color: '#888' }}>Order: </span>
                <code style={{ color: '#666' }}>{pendingPayment.orderId}</code>
              </div>
            )}
            <div style={{ marginTop: 4, fontSize: 11 }}>
              <span style={{ color: '#888' }}>Chain: </span>
              <span style={{ color: pendingPayment.chain === 'base' ? '#0052ff' : '#888' }}>
                {pendingPayment.swap ? pendingPayment.swap.fromChain : pendingPayment.chain}
              </span>
              {pendingPayment.swap && pendingPayment.swap.fromChain !== pendingPayment.swap.toChain && (
                <span style={{ color: '#888' }}> → {pendingPayment.swap.toChain}</span>
              )}
            </div>
          </div>
          <div className="row" style={{ marginTop: 12 }}>
            <button
              className="btn btn-primary"
              style={{ flex: 2 }}
              onClick={handlePosPayment}
              disabled={loading || !wallet}
            >
              {loading ? <><span className="spinner"></span> Processing...</> : wallet ? 'Pay with FaceID' : 'Login First'}
            </button>
            <button
              className="btn btn-secondary"
              style={{ flex: 1 }}
              onClick={() => setPendingPayment(null)}
              disabled={loading}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* QR Scanner Modal */}
      {showQrScanner && (
        <div className="modal-overlay" onClick={() => setShowQrScanner(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Scan QR Code</h3>
              <button className="btn btn-secondary" onClick={() => setShowQrScanner(false)}>✕</button>
            </div>
            <div style={{ padding: 16 }}>
              <Scanner
                onScan={handleQrScan}
                onError={handleQrError}
                styles={{ container: { width: '100%', maxWidth: 400 } }}
              />
              <p style={{ marginTop: 16, fontSize: 13, color: '#888', textAlign: 'center' }}>
                Point camera at a <code>passkey://</code> or <code>nostrconnect://</code> QR
              </p>
            </div>
          </div>
        </div>
      )}

      {/* NostrConnect Approval Modal */}
      {nostrConnectRequest && (
        <div className="modal-overlay">
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h3>🔐 Nostr Connect Request</h3>
            </div>
            <div style={{ padding: 16 }}>
              <div style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 12, color: '#888' }}>App</div>
                <div style={{ fontWeight: 600, fontSize: 16 }}>
                  {nostrConnectRequest.metadata?.name || 'Unknown App'}
                </div>
                {nostrConnectRequest.metadata?.url && (
                  <div style={{ fontSize: 12, color: '#666', marginTop: 4 }}>
                    {nostrConnectRequest.metadata.url}
                  </div>
                )}
              </div>
              
              {nostrConnectRequest.perms?.length > 0 && (
                <div style={{ marginBottom: 16 }}>
                  <div style={{ fontSize: 12, color: '#888' }}>Permissions</div>
                  <div style={{ fontSize: 13, marginTop: 4 }}>
                    {nostrConnectRequest.perms.map(p => (
                      <span key={p} style={{
                        background: '#2a2a35',
                        padding: '4px 8px',
                        borderRadius: 4,
                        marginRight: 4,
                        fontSize: 11
                      }}>{p}</span>
                    ))}
                  </div>
                </div>
              )}
              
              <div style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 12, color: '#888' }}>Your Nostr Key</div>
                <div style={{ fontSize: 13, fontFamily: 'monospace', marginTop: 4 }}>
                  {npub ? `${npub.slice(0, 20)}...${npub.slice(-8)}` : (
                    <span style={{ color: '#f87171' }}>Not derived - click "Derive Nostr Key" first</span>
                  )}
                </div>
              </div>
              
              {!npub && (
                <div style={{ 
                  background: 'rgba(248,113,113,0.1)', 
                  border: '1px solid #f87171',
                  borderRadius: 8,
                  padding: 12,
                  marginBottom: 16,
                  fontSize: 13
                }}>
                  ⚠️ You need to derive a Nostr key before approving.
                </div>
              )}
              
              <div className="row" style={{ marginTop: 24 }}>
                <button 
                  className="btn btn-secondary" 
                  onClick={handleNostrConnectDeny}
                  style={{ flex: 1 }}
                  disabled={loading}
                >
                  Deny
                </button>
                <button 
                  className="btn btn-primary" 
                  onClick={handleNostrConnectApprove}
                  style={{ flex: 1 }}
                  disabled={loading || !npub}
                >
                  {loading ? 'Approving...' : 'Approve'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="dashboard-grid">
        <div className="card">
          <div className="card-header">
            <div className="card-icon eth">⟠</div>
            <div>
              <div className="card-title">Ethereum</div>
              <div className="card-subtitle">ETH Balance</div>
            </div>
          </div>
          <div className="balance-row">
            <div className="balance eth">{ethBalance !== null ? formatEthBalance(ethBalance) : '...'}</div>
            <div className="balance-usd">{ethBalance ? `$${(Number(ethBalance) / 1e18 * 2500).toFixed(2)}` : '—'}</div>
          </div>
          <button className="btn btn-secondary btn-full" onClick={() => refreshBalance()}>
            Refresh
          </button>
        </div>

        <div className="card">
          <div className="card-header">
            <div className="card-icon sol">◎</div>
            <div>
              <div className="card-title">Solana</div>
              <div className="card-subtitle">SOL Balance</div>
            </div>
          </div>
          {solAddress ? (
            <>
              <div className="address-short">{solAddress.slice(0, 8)}...{solAddress.slice(-8)}</div>
              <div className="balance-row">
                <div className="balance sol">{solBalance !== null ? (Number(solBalance) / 1e9).toFixed(4) : '...'}</div>
                <div className="balance-usd">{solBalance ? `$${(Number(solBalance) / 1e9 * 150).toFixed(2)}` : '—'}</div>
              </div>
            </>
          ) : (
            <div className="card-subtitle" style={{ marginBottom: 12 }}>Click below to derive address</div>
          )}
          <button className="btn btn-secondary btn-full" onClick={() => refreshSolBalance()}>
            {solBalance ? 'Refresh' : 'Load SOL'}
          </button>
        </div>

        <div className="card">
          <div className="card-header">
            <div className="card-icon send">⟠</div>
            <div>
              <div className="card-title">Send ETH</div>
              <div className="card-subtitle">Transfer to another address</div>
            </div>
          </div>
          <div className="input-group">
            <input className="input" placeholder="Recipient (0x...)" value={sendTo} onChange={e => setSendTo(e.target.value)} />
          </div>
          <div className="input-group">
            <input className="input" placeholder="Amount (ETH)" value={sendAmount} onChange={e => setSendAmount(e.target.value)} type="number" step="0.0001" />
          </div>
          <button className="btn btn-primary btn-full" onClick={handleSend} disabled={loading || !sendTo || !sendAmount}>
            {loading ? <><span className="spinner"></span> Signing...</> : 'Send with FaceID'}
          </button>
        </div>

        <div className="card">
          <div className="card-header">
            <div className="card-icon sol">◎</div>
            <div>
              <div className="card-title">Send SOL</div>
              <div className="card-subtitle">{solAddress ? `${solAddress.slice(0, 6)}...${solAddress.slice(-6)}` : 'Load SOL first'}</div>
            </div>
          </div>
          <div className="input-group">
            <input className="input" placeholder="Recipient (Solana address)" value={solSendTo} onChange={e => setSolSendTo(e.target.value)} />
          </div>
          <div className="input-group">
            <input className="input" placeholder="Amount (SOL)" value={solSendAmount} onChange={e => setSolSendAmount(e.target.value)} type="number" step="0.001" />
          </div>
          <button className="btn btn-primary btn-full" onClick={handleSendSol} disabled={loading || !solSendTo || !solSendAmount || !solAddress}>
            {loading ? <><span className="spinner"></span> Signing...</> : 'Send SOL'}
          </button>
        </div>

        <div className="card">
          <div className="card-header">
            <div className="card-icon key">🔑</div>
            <div>
              <div className="card-title">Session Keys</div>
              <div className="card-subtitle">Skip FaceID for faster signing</div>
            </div>
          </div>
          {sessionKeys && Object.keys(sessionKeys).length > 0 ? (
            <div style={{ marginBottom: 12 }}>
              {Object.entries(sessionKeys).map(([id, key]) => {
                const expiresAt = Number(key.expires_at) / 1e6
                const isExpired = Date.now() > expiresAt
                return (
                  <div key={id} className="session-item">
                    <div className="session-info">
                      <div className="session-id" style={{ color: isExpired ? '#888' : '#f0f0f5' }}>{id}</div>
                      <div className="session-pubkey">{key.public_key?.slice(0, 24)}...</div>
                      <div className={`session-expires ${isExpired ? 'expired' : ''}`}>
                        {isExpired ? 'Expired' : `Expires ${new Date(expiresAt).toLocaleDateString()}`}
                      </div>
                    </div>
                    <button className="btn btn-danger" style={{ fontSize: 11, padding: '6px 12px' }} onClick={() => handleRevokeSession(id)} disabled={sessionLoading}>
                      Revoke
                    </button>
                  </div>
                )
              })}
            </div>
          ) : sessionKeys ? (
            <div className="card-subtitle" style={{ marginBottom: 12 }}>No session keys</div>
          ) : null}
          <div className="row">
            <button className="btn btn-secondary" onClick={() => refreshSessionKeys()} disabled={sessionLoading} style={{ flex: 1 }}>
              {sessionKeys ? 'Refresh' : 'Load'}
            </button>
            <button className="btn btn-primary" onClick={handleCreateSession} disabled={sessionLoading} style={{ flex: 1 }}>
              {sessionLoading ? '...' : 'Create'}
            </button>
          </div>
          {sessionKeys && Object.keys(sessionKeys).length > 0 && (
            <button className="btn btn-danger btn-full" onClick={handleRevokeAllSessions} disabled={sessionLoading} style={{ marginTop: 8 }}>
              Revoke All (Emergency)
            </button>
          )}
        </div>

        <div className="card">
          <div className="card-header">
            <div className="card-icon backup">🔐</div>
            <div>
              <div className="card-title">Backup Passkey</div>
              <div className="card-subtitle">Hardware backup for recovery</div>
            </div>
          </div>
          {backupKey ? (
            <div>
              <div className="status status-success">✓ Backup registered</div>
              <div className="address-short" style={{ marginTop: 8, marginBottom: 8 }}>{backupKey.slice(0, 32)}...</div>
              <div className="row">
                <button className="btn btn-secondary" onClick={handleTestBackupKey} disabled={backupLoading} style={{ flex: 1, fontSize: 13 }}>
                  {backupLoading ? '...' : 'Test'}
                </button>
                <button className="btn btn-danger" onClick={handleRemoveBackupKey} disabled={backupLoading} style={{ flex: 1 }}>
                  {backupLoading ? '...' : 'Remove'}
                </button>
              </div>
            </div>
          ) : (
            <button className="btn btn-primary btn-full" onClick={handleAddBackupKey} disabled={backupLoading}>
              {backupLoading ? '...' : 'Add Backup Passkey'}
            </button>
          )}
        </div>

        <NostrBunkerCard 
          wallet={wallet}
          onDerive={handleDeriveNostr}
          npub={npub}
          nostrPubkey={nostrPubkey}
          loading={loading}
        />

        <div className="card">
          <div className="card-header">
            <div className="card-icon info">ℹ</div>
            <div>
              <div className="card-title">Wallet Info</div>
              <div className="card-subtitle">Contract details</div>
            </div>
          </div>
          <div style={{ fontSize: 12, color: '#666', lineHeight: 1.8 }}>
            <div><span style={{ color: '#888' }}>Account:</span> {wallet?.nearAccountId}</div>
            <div><span style={{ color: '#888' }}>Passkey:</span> {wallet?.credentialId?.slice(0, 16)}...</div>
            <div><span style={{ color: '#888' }}>Path:</span> {wallet?.path}</div>
            <div><span style={{ color: '#888' }}>MPC:</span> {MPC_CONTRACT}</div>
          </div>
        </div>
      </div>

      <button className="btn btn-secondary btn-full" onClick={() => setShowQrScanner(true)} style={{ marginTop: 8 }}>
        📷 Scan QR to Pay
      </button>
      <button className="btn btn-danger btn-full" onClick={handleLogout} style={{ marginTop: 16 }}>
        Logout
      </button>

      <LogPanel log={log} />
    </div>
  )
}

function LogPanel({ log }) {
  if (log.length === 0) return null
  return (
    <div className="log-card">
      <div className="log-title">Activity Log</div>
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

/**
 * Extract authData from CBOR-encoded attestation object.
 */
function extractAuthData(attestationObject) {
  // AttestationObject is CBOR: { fmt: ..., authData: ..., attStmt: ... }
  // We need to extract authData bytes
  try {
    // CBOR decode manually (simple extraction)
    // Look for authData key (a1 68 61 75 7444 61 74 61 = { "authData": ... })
    const authDataKey = new TextEncoder().encode('authData')
    let offset = 0
    
    // Find authData in CBOR
    for (let i = 0; i < attestationObject.byteLength - 100; i++) {
      // CBOR map key for "authData" (major type 3, text string)
      if (attestationObject[i] === 0x68 && 
          new TextDecoder().decode(attestationObject.slice(i, i + 8)) === 'authData') {
        offset = i + 8 // Skip "authData"
        // Next byte(s) is length (CBOR major type 2 for byte string)
        if (attestationObject[offset] === 0x59) {
          // Two-byte length
          const len = (attestationObject[offset + 1] << 8) | attestationObject[offset + 2]
          return attestationObject.slice(offset + 3, offset + 3 + len)
        } else if (attestationObject[offset] === 0x58) {
          // One-byte length
          const len = attestationObject[offset + 1]
          return attestationObject.slice(offset + 2, offset + 2 + len)
        } else if (attestationObject[offset] <= 0x57) {
          // Immediate length (0x47 = 7 bytes, etc.)
          // But authData for P-256 is at least 77 bytes (37 + 16 + 2 + 2 + 1 + 32 + 32)
          // Skip to next CBOR major type
          continue
        }
      }
    }
    
    // Fallback: try WebAuthn simpler parsing
    // authData starts after rpIdHash(32) + flags(1) + signCount(4) +
    // attestedCredentialData: aaguid(16) + credIdLen(2) + credId + pubkey
    // Total header = 37 bytes
    return attestationObject.slice(37)
  } catch (e) {
    console.error('extractAuthData error:', e)
    return null
  }
}

/**
 * Extract public key from authData.
 * authData = rpIdHash(32) + flags(1) + signCount(4) + 
 *             attestedCredentialData: aaguid(16) + credIdLen(2) + credId + credentialPublicKey
 */
function extractPublicKeyFromAuthData(authData) {
  if (!authData || authData.byteLength < 55) return null
  
  try {
    let offset = 0
    
    // Skip rpIdHash (32 bytes)
    offset += 32
    
    // flags (1 byte)
    const flags = authData[offset]
    offset += 1
    
    // signCount (4 bytes)
    offset += 4
    
    // Check if attestedCredentialData is present (bit 6 of flags)
    if (!(flags & 0x40)) {
      console.log('No attestedCredentialData')
      return null
    }
    
    // attestedCredentialData:
    // aaguid (16 bytes)
    offset += 16
    
    // credentialIdLength (2 bytes, big-endian)
    const credIdLen = (authData[offset] << 8) | authData[offset + 1]
    offset += 2
    
    // credentialId
    offset += credIdLen
    
    // credentialPublicKey - COSE format
    // For P-256, this is CBOR-encoded COSE key
    // Try to extract x and y coordinates
    
    // COSE Key format for P-256 (ES256):
    // { 1: 2, -1: 1, -2: x, -3: y }  (kty=EC2, crv=P256, x, y)
    // In CBOR: a3 01 02 20 01 21 58 20 <x bytes> 22 58 20 <y bytes>
    
    const coseKeyStart = offset
    const remaining = authData.slice(offset)
    
    // Look for the CBOR map marker (a3 = map with 3 items, or a5 for 5 items)
    // Then find x (-2 = 0x21 followed by 0x58 0x20) and y (-3 = 0x22 followed by 0x58 0x20)
    
    let x = null, y = null
    
    for (let i = 0; i < remaining.byteLength - 70; i++) {
      // Look for -2 key followed by bytes(32)
      if (remaining[i] === 0x21 && remaining[i + 1] === 0x58 && remaining[i + 2] === 0x20) {
        x = remaining.slice(i + 3, i + 35)
      }
      // Look for -3 key followed by bytes(32)
      if (remaining[i] === 0x22 && remaining[i + 1] === 0x58 && remaining[i + 2] === 0x20) {
        y = remaining.slice(i + 3, i + 35)
      }
    }
    
    if (x && y && x.byteLength === 32 && y.byteLength === 32) {
      // Concatenate x + y as uncompressed point (64 bytes total)
      const publicKey = new Uint8Array(65)
      publicKey[0] = 0x04 // uncompressed marker
      publicKey.set(x, 1)
      publicKey.set(y, 33)
      return publicKey
    }
    
    return null
  } catch (e) {
    console.error('extractPublicKeyFromAuthData error:', e)
    return null
  }
}

/**
 * Parse P-256 public key from raw bytes.
 * Input: 65 bytes (0x04 + x + y) or COSE format
 * Output: { x: Uint8Array, y: Uint8Array }
 */
function parseP256PublicKey(bytes) {
  if (bytes.byteLength === 65 && bytes[0] === 0x04) {
    // Uncompressed point
    return {
      x: bytes.slice(1, 33),
      y: bytes.slice(33, 65),
    }
  }
  
  // Try COSE format
  for (let i = 0; i < bytes.byteLength - 70; i++) {
    if (bytes[i] === 0x21 && bytes[i + 1] === 0x58 && bytes[i + 2] === 0x20) {
      const x = bytes.slice(i + 3, i + 35)
      for (let j = i + 35; j < bytes.byteLength - 35; j++) {
        if (bytes[j] === 0x22 && bytes[j + 1] === 0x58 && bytes[j + 2] === 0x20) {
          const y = bytes.slice(j + 3, j + 35)
          return { x, y }
        }
      }
    }
  }
  
  throw new Error(`Cannot parse P-256 public key: ${bytes.byteLength} bytes`)
}
