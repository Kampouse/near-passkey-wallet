import React, { useState, useEffect, useCallback } from 'react';
import { useWallet } from '../hooks/useWallet.js';
import { Shield, AlertTriangle, CheckCircle2, Fingerprint, ArrowRight, Loader } from 'lucide-react';
interface ConnectParams {
  relay: string;
  session: string;
}

interface PendingRequest {
  type: string;
  network?: string;
  signerId?: string;
  receiverId?: string;
  actions?: any[];
  message?: string;
  recipient?: string;
  nonce?: number[];
  sessionPublicKey?: string;
  sessionKeyId?: string;
}

interface ToastMessage {
  id: string;
  type: 'success' | 'error' | 'info';
  message: string;
}

export const ConnectScreen: React.FC<{ params: ConnectParams; onDone: () => void }> = ({ params, onDone }) => {
  const wallet = useWallet();
  const w = wallet.wallet;

  const [dappInfo, setDappInfo] = useState<{ name?: string; url?: string } | null>(null);
  const [request, setRequest] = useState<PendingRequest | null>(null);
  const [status, setStatus] = useState<'loading' | 'approve' | 'signing' | 'done' | 'error'>('loading');
  const [errorMsg, setErrorMsg] = useState('');
  const [toasts, setToasts] = useState<ToastMessage[]>([]);

  const addToast = useCallback((type: 'success' | 'error' | 'info', message: string) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setToasts(prev => [...prev, { id, type, message }]);
  }, []);

  const [debugLog, setDebugLog] = useState<string[]>([]);
  const dbg = useCallback((msg: string) => {
    const ts = new Date().toLocaleTimeString();
    const line = `[${ts}] ${msg}`;
    console.log(line);
    setDebugLog(prev => [...prev, line]);
  }, []);

  // Fetch dApp info and pending request
  useEffect(() => {
    let cancelled = false;

    const fetchInfo = async () => {
      try {
        const sessionRes = await fetch(`${params.relay}/v1/session/${params.session}/request`);
        const reqData = await sessionRes.json();

        if (cancelled) return;

        if (!reqData) {
          setErrorMsg('No pending request. The QR may have expired.');
          setStatus('error');
          return;
        }

        setRequest(reqData);
        setDappInfo({ name: new URL(params.relay).hostname });
        setStatus('approve');
      } catch (err: any) {
        if (cancelled) return;
        setErrorMsg(err.message);
        setStatus('error');
      }
    };

    fetchInfo();
    return () => { cancelled = true; };
  }, [params.relay, params.session]);

  // Approve handler
  const handleApprove = async () => {
    if (!request) { setErrorMsg('No request to approve'); setStatus('error'); return; }
    if (!w?.nearAccountId) { setErrorMsg('No wallet logged in. Go back and login first.'); setStatus('error'); return; }
    setStatus('signing');

    try {
      if (request.type === 'signIn') {
        // If dApp sent a session public key, register it on-chain
        let sessionKeyId: string | undefined;
        addToast('info', `Request: pubKey=${request.sessionPublicKey || 'none'} keyId=${request.sessionKeyId || 'none'}`);
        dbg(`signIn request: sessionPublicKey="${request.sessionPublicKey || ''}" sessionKeyId="${request.sessionKeyId || ''}"`);
        if (request.sessionPublicKey && request.sessionKeyId) {
          try {
            dbg(`Calling registerExternalSessionKey("${request.sessionKeyId}", "${request.sessionPublicKey}")`);
            await wallet.registerExternalSessionKey(request.sessionKeyId, request.sessionPublicKey);
            sessionKeyId = request.sessionKeyId;
            addToast('success', `Session key registered: ${sessionKeyId}`);
          } catch (err: any) {
            addToast('error', `Session key error: ${err.message?.slice(0, 80)}`);
            dbg(`Session key FAILED: ${err.message}`);
            // Continue without session key — dApp will fall back to relay
          }
        }

        // Respond with account info + session key ID
        const res = await fetch(`${params.relay}/v1/session/${params.session}/response`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            accountId: w.nearAccountId,
            publicKey: w.credentialId ? `passkey:${w.credentialId.slice(0, 32)}` : undefined,
            sessionKeyId,
          }),
        });
        if (!res.ok) throw new Error(`Relay responded ${res.status}`);
        addToast('success', `Connected as ${w.nearAccountId}`);
        setStatus('done');
        setTimeout(() => onDone(), 1500);

      } else if (request.type === 'signAndSendTransaction') {
        // Passkey signing — dApp handles session key signing locally
        const txResult = await wallet.sendNearTransaction(
          request.receiverId || '',
          request.actions || [],
        );
        const txHash = txResult.tx_hash;

        const res = await fetch(`${params.relay}/v1/session/${params.session}/response`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            outcome: {
              status: { SuccessValue: '' },
              transaction: {
                signer_id: w.nearAccountId,
                receiver_id: request.receiverId,
                hash: txHash,
              },
            },
          }),
        });
        if (!res.ok) throw new Error(`Relay responded ${res.status}`);
        addToast('success', `Tx submitted: ${txHash?.slice(0, 16)}...`);
        setStatus('done');
        setTimeout(() => onDone(), 1500);

      } else if (request.type === 'signMessage') {
        // Sign message with passkey (direct WebAuthn assertion)
        addToast('info', 'Starting signMessage...');
        if (!w?.credentialRawId) throw new Error('No passkey credential');
        addToast('info', `Credential: ${w.credentialRawId.slice(0, 16)}...`);
        const msgPayload = JSON.stringify({
          message: request.message,
          recipient: request.recipient,
          nonce: request.nonce,
        });
        const challengeBuffer = new TextEncoder().encode(msgPayload);
        addToast('info', 'Requesting Face ID...');
        const assertion = await navigator.credentials.get({
          publicKey: {
            challenge: challengeBuffer,
            allowCredentials: [{
              id: Uint8Array.from(atob(w.credentialRawId.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0)),
              type: 'public-key',
            }],
            userVerification: 'required',
          },
        }) as PublicKeyCredential;
        const assertResp = assertion.response as AuthenticatorAssertionResponse;
        const sigHex = Array.from(new Uint8Array(assertResp.signature))
          .map(b => b.toString(16).padStart(2, '0')).join('');
        addToast('info', `Got signature: ${sigHex.slice(0, 16)}...`);
        addToast('info', `Posting to ${params.relay}/v1/session/${params.session}/response`);

        const res = await fetch(`${params.relay}/v1/session/${params.session}/response`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            signedMessage: {
              accountId: w.nearAccountId,
              publicKey: w.credentialId || '',
              signature: sigHex,
            },
          }),
        });
        if (!res.ok) throw new Error(`Relay responded ${res.status}`);
        const resData = await res.text();
        addToast('success', `Message signed! Relay: ${resData.slice(0, 50)}`);
        setStatus('done');
        setTimeout(() => onDone(), 1500);
      }

    } catch (err: any) {
      setErrorMsg(err.message);
      setStatus('error');
      addToast('error', `Failed: ${err.message}`);
    }
  };

  // Reject
  const handleReject = async () => {
    await fetch(`${params.relay}/v1/session/${params.session}/response`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rejected: true }),
    }).catch(() => {});
    onDone();
  };

  // ─── Render ─────────────────────────────────────────────

  const s = {
    card: {
      maxWidth: 360,
      margin: '0 auto',
      padding: '32px 24px',
      display: 'flex',
      flexDirection: 'column' as const,
      alignItems: 'center',
      gap: 16,
    },
    icon: (_color: string, bg: string) => ({
      width: 56,
      height: 56,
      borderRadius: 16,
      background: bg,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      marginBottom: 4,
    }),
  };

  return (
    <div style={s.card}>
      {/* Toasts */}
      {toasts.map(t => (
        <div key={t.id} style={{
          position: 'fixed', top: 12, left: '50%', transform: 'translateX(-50%)',
          padding: '8px 16px', borderRadius: 10, fontSize: 13, fontWeight: 500, zIndex: 99,
          background: t.type === 'error' ? '#ef4444' : t.type === 'success' ? '#10b981' : '#3b82f6',
          color: '#fff',
        }}>
          {t.message}
        </div>
      ))}

      {status === 'loading' && (
        <>
          <div style={s.icon('var(--color-accent)', 'rgba(16,185,129,0.1)')}>
            <Loader size={28} style={{ color: 'var(--color-accent)', animation: 'spin 1s linear infinite' }} />
          </div>
          <div style={{ fontSize: 15, color: 'var(--color-text-secondary)' }}>Loading request...</div>
          <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
        </>
      )}

      {status === 'approve' && request && (
        <>
          <div style={s.icon('var(--color-accent)', 'rgba(16,185,129,0.1)')}>
            {request.type === 'signIn' ? <Fingerprint size={28} style={{ color: 'var(--color-accent)' }} /> :
             <Shield size={28} style={{ color: 'var(--color-accent)' }} />}
          </div>

          <div style={{ fontSize: 17, fontWeight: 600, marginBottom: 2 }}>
            {request.type === 'signIn' ? 'Connect to dApp' :
             request.type === 'signAndSendTransaction' ? 'Approve Transaction' :
             'Sign Message'}
          </div>

          <div style={{ fontSize: 13, color: 'var(--color-text-secondary)', textAlign: 'center', marginBottom: 8 }}>
            {dappInfo?.name || 'Unknown dApp'} wants to{' '}
            {request.type === 'signIn' ? 'connect to your wallet' :
             request.type === 'signAndSendTransaction' ? `send a transaction to ${request.receiverId}` :
             'sign a message'}
          </div>

          {request.type === 'signIn' && (
            <div style={{
              background: 'rgba(255,255,255,0.05)', borderRadius: 12, padding: '12px 16px',
              width: '100%', textAlign: 'center',
            }}>
              <div style={{ fontSize: 11, color: 'var(--color-text-secondary)', marginBottom: 4 }}>Account</div>
              <div style={{ fontSize: 14, fontWeight: 600 }}>{w?.nearAccountId}</div>
            </div>
          )}

          {request.type === 'signAndSendTransaction' && (
            <div style={{
              background: 'rgba(255,255,255,0.05)', borderRadius: 12, padding: '12px 16px',
              width: '100%', fontSize: 12,
            }}>
              <div style={{ color: 'var(--color-text-secondary)', marginBottom: 6 }}>Transaction</div>
              <div>To: <strong>{request.receiverId}</strong></div>
              {(request.actions || []).map((a: any, i: number) => (
                <div key={i} style={{ marginTop: 4, display: 'flex', alignItems: 'center', gap: 6 }}>
                  <ArrowRight size={12} />
                  <span>{a.type === 'Transfer' ? `Transfer ${a.params?.amount ? Number(a.params.amount) / 1e24 + ' NEAR' : ''}` : a.type}</span>
                </div>
              ))}
            </div>
          )}

          {request.type === 'signMessage' && (
            <div style={{
              background: 'rgba(255,255,255,0.05)', borderRadius: 12, padding: '12px 16px',
              width: '100%', fontSize: 12,
            }}>
              <div style={{ color: 'var(--color-text-secondary)', marginBottom: 6 }}>Message</div>
              <div style={{ wordBreak: 'break-all' }}>{request.message || 'N/A'}</div>
            </div>
          )}

          <div style={{ display: 'flex', gap: 8, width: '100%', marginTop: 8 }}>
            <button onClick={handleReject} style={{
              flex: 1, padding: 14, border: '1px solid rgba(255,255,255,0.1)', borderRadius: 12,
              background: 'transparent', color: 'var(--color-text-secondary)', fontSize: 14, fontWeight: 500, cursor: 'pointer',
            }}>
              Reject
            </button>
            <button onClick={handleApprove} style={{
              flex: 2, padding: 14, border: 'none', borderRadius: 12,
              background: 'var(--color-accent)', color: '#fff', fontSize: 14, fontWeight: 600, cursor: 'pointer',
            }}>
              Approve
            </button>
          </div>
        </>
      )}

      {status === 'signing' && (
        <>
          <div style={s.icon('var(--color-accent)', 'rgba(16,185,129,0.1)')}>
            <Shield size={28} style={{ color: 'var(--color-accent)' }} />
          </div>
          <div style={{ fontSize: 17, fontWeight: 600, marginBottom: 6 }}>Confirm with Passkey</div>
          <div style={{ fontSize: 13, color: 'var(--color-text-secondary)' }}>Waiting for biometric authentication...</div>
        </>
      )}

      {status === 'done' && (
        <>
          <div style={s.icon('var(--color-accent)', 'rgba(16,185,129,0.15)')}>
            <CheckCircle2 size={28} style={{ color: 'var(--color-accent)' }} />
          </div>
          <div style={{ fontSize: 17, fontWeight: 600, marginBottom: 6 }}>Done!</div>
          <div style={{ fontSize: 13, color: 'var(--color-text-secondary)', marginBottom: 20 }}>
            You can close this tab
          </div>
        </>
      )}

      {status === 'error' && (
        <>
          <div style={s.icon('var(--color-danger)', 'rgba(239,68,68,0.1)')}>
            <AlertTriangle size={28} style={{ color: 'var(--color-danger)' }} />
          </div>
          <div style={{ fontSize: 17, fontWeight: 600, marginBottom: 6 }}>Error</div>
          <div style={{ fontSize: 13, color: 'var(--color-text-secondary)', marginBottom: 20, textAlign: 'center' }}>
            {errorMsg}
          </div>
          <button onClick={onDone} style={{
            padding: '10px 24px', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 12,
            background: 'transparent', color: 'var(--color-text-secondary)', fontSize: 14, cursor: 'pointer',
          }}>
            Close
          </button>
        </>
      )}

      {/* Debug log */}
      {debugLog.length > 0 && (
        <div style={{
          marginTop: 16, padding: 12, background: 'rgba(0,0,0,0.6)', borderRadius: 8,
          maxHeight: 200, overflow: 'auto', textAlign: 'left', width: '100%',
          fontSize: 11, fontFamily: 'monospace', color: '#aaa', lineHeight: 1.6,
          wordBreak: 'break-all',
        }}>
          {debugLog.map((line, i) => <div key={i}>{line}</div>)}
        </div>
      )}
    </div>
  );
};
