import React, { useState, useEffect, useCallback } from 'react';
import { useWallet } from '../hooks';
import { Button, Card, Input, LogPanel, Modal, Toast, ToastMessage } from '../components/ui';
import { MPC_CONTRACT, formatEthBalance } from '../lib';
import { Scanner } from '@yudiel/react-qr-scanner';
import {
  Wallet,
  Send,
  KeyRound,
  Settings,
  Shield,
  RefreshCw,
  ScanLine,
  QrCode,
  Copy,
  ChevronDown,
  ChevronUp,
  CheckCircle2,
  Plus,
  XCircle,
  ArrowUpRight,
  StopCircle,
  Play,
} from 'lucide-react';

// ─── Helpers ──────────────────────────────────────────────────

function shorten(addr: string, head = 8, tail = 6): string {
  if (!addr || addr.length <= head + tail + 3) return addr;
  return `${addr.slice(0, head)}...${addr.slice(-tail)}`;
}

function formatNear(yocto: bigint): string {
  const near = Number(yocto) / 1e24;
  return near >= 1 ? near.toFixed(2) : near.toPrecision(3);
}

function parsePasskeyUri(uri: string) {
  try {
    const url = new URL(uri);
    if (url.protocol !== 'passkey:' || url.pathname !== '/send') return null;
    const params = url.searchParams;
    const to = params.get('to');
    const amount = params.get('amount');
    if (!to || !amount) return null;
    return { to, amount, chain: params.get('chain') || 'eth', label: params.get('label'), redirect: params.get('redirect') };
  } catch { return null; }
}

// ─── Tab Types ────────────────────────────────────────────────

type Tab = 'wallet' | 'send' | 'nostr' | 'settings';

const TABS: { id: Tab; icon: React.ReactNode; label: string }[] = [
  { id: 'wallet', icon: <Wallet size={22} />, label: 'Wallet' },
  { id: 'send', icon: <Send size={22} />, label: 'Send' },
  { id: 'nostr', icon: <KeyRound size={22} />, label: 'Keys' },
  { id: 'settings', icon: <Settings size={22} />, label: 'More' },
];

// ─── Dashboard ────────────────────────────────────────────────

export const DashboardScreen: React.FC = () => {
  const wallet = useWallet();
  const [tab, setTab] = useState<Tab>('wallet');

  // Form state
  const [sendTo, setSendTo] = useState('');
  const [sendAmount, setSendAmount] = useState('');
  const [sendChain, setSendChain] = useState<'eth' | 'sol'>('eth');
  const [solSendTo, setSolSendTo] = useState('');
  const [solSendAmount, setSolSendAmount] = useState('');
  const [bunkerRunning, setBunkerRunning] = useState(false);
  const [sessionLoading, setSessionLoading] = useState(false);
  const [backupKey, setBackupKey] = useState<string | null>(null);
  const [backupLoading, setBackupLoading] = useState(false);
  const [pendingTx, setPendingTx] = useState<{ to: string; amount: string; chain: string; label?: string | null; redirect?: string | null } | null>(null);
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const [showLogs, setShowLogs] = useState(false);
  const [showQrScanner, setShowQrScanner] = useState(false);

  const addToast = useCallback((type: 'success' | 'error' | 'info', message: string) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setToasts(prev => [...prev, { id, type, message }]);
  }, []);
  const dismissToast = useCallback((id: string) => setToasts(prev => prev.filter(t => t.id !== id)), []);

  const w = wallet.wallet;
  const ethBalance = wallet.ethBalance;

  // URL params
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const uri = params.get('uri');
    if (uri) {
      const tx = parsePasskeyUri(decodeURIComponent(uri));
      if (tx) {
        setPendingTx(tx);
        wallet.addLog(`Pending TX from URL: ${tx.amount} ${tx.chain.toUpperCase()} to ${tx.to}`);
      }
    }
  }, []);

  // Handlers
  const handleRefreshBalance = () => wallet.refreshBalance();

  const handleSendEth = () => {
    if (!sendTo || !sendAmount) return;
    wallet.sendEth(sendTo, sendAmount);
  };

  const handleLoadSol = async () => {
    try { await wallet.deriveSolAddress(); } catch (err: any) { wallet.addLog(`SOL error: ${err.message}`); }
  };

  const handleSendSol = () => {
    if (!solSendTo || !solSendAmount || !wallet.solAddress) return;
    wallet.sendSol(solSendTo, solSendAmount);
  };

  const handleDeriveNostr = async () => {
    try { await wallet.deriveNostr(); } catch (err: any) { wallet.addLog(`Nostr error: ${err.message}`); }
  };

  const handleStartBunker = () => { setBunkerRunning(true); wallet.startBunker?.(); };
  const handleStopBunker = () => { setBunkerRunning(false); wallet.stopBunker?.(); };

  const handleLoadSessionKeys = async () => {
    setSessionLoading(true);
    try { await wallet.getSessionKeys(); } catch (err: any) { wallet.addLog(`Session keys error: ${err.message}`); }
    finally { setSessionLoading(false); }
  };

  const handleCreateSession = async () => {
    setSessionLoading(true);
    try { await wallet.createSessionKey(); await handleLoadSessionKeys(); }
    catch (err: any) { wallet.addLog(`Create session error: ${err.message}`); }
    finally { setSessionLoading(false); }
  };

  const handleRevokeSession = async (id: string) => {
    setSessionLoading(true);
    try { await wallet.revokeSessionKey(id); await handleLoadSessionKeys(); }
    catch (err: any) { wallet.addLog(`Revoke error: ${err.message}`); }
    finally { setSessionLoading(false); }
  };

  const handleLoadBackup = async () => {
    setBackupLoading(true);
    try { await wallet.getBackupKey(); } catch (err: any) { wallet.addLog(`Backup error: ${err.message}`); }
    finally { setBackupLoading(false); }
  };

  const handleAddBackup = async () => {
    setBackupLoading(true);
    try { await wallet.addBackupKey(); await handleLoadBackup(); addToast('success', 'Backup passkey registered'); }
    catch (err: any) { addToast('error', `Failed: ${err.message}`); }
    finally { setBackupLoading(false); }
  };

  const handleTestBackup = async () => {
    setBackupLoading(true);
    try { await wallet.testBackupKey(); addToast('success', 'Backup verified!'); }
    catch (err: any) { addToast('error', `Test failed: ${err.message}`); }
    finally { setBackupLoading(false); }
  };

  const handleRemoveBackup = async () => {
    if (!confirm('Remove backup passkey?')) return;
    setBackupLoading(true);
    try { await wallet.removeBackupKey(); setBackupKey(null); addToast('info', 'Backup removed'); }
    catch (err: any) { wallet.addLog(`Remove backup error: ${err.message}`); }
    finally { setBackupLoading(false); }
  };

  const handleFillPending = () => {
    if (!pendingTx) return;
    if (pendingTx.chain === 'sol') { setSolSendTo(pendingTx.to); setSolSendAmount(pendingTx.amount); setSendChain('sol'); }
    else { setSendTo(pendingTx.to); setSendAmount(pendingTx.amount); setSendChain('eth'); }
    setPendingTx(null);
    setTab('send');
  };

  // ─── QR Scanner Handler ─────────────────────────────────
  const handleQrScan = useCallback((detectedCodes: { rawValue: string }[]) => {
    const uri = detectedCodes[0]?.rawValue;
    if (!uri) return;

    wallet.addLog(`QR scanned: ${uri.slice(0, 60)}...`);

    // nostrconnect:// URI (NIP-46 pairing)
    if (uri.startsWith('nostrconnect://')) {
      wallet.addLog('NostrConnect pairing detected — starting bunker...');
      setShowQrScanner(false);
      wallet.startBunker?.();
      addToast('info', 'NostrConnect pairing started');
      return;
    }

    // nearpasskey://connect URI (dApp scan-to-connect)
    if (uri.startsWith('nearpasskey://connect')) {
      try {
        const url = new URL(uri.replace('nearpasskey://', 'https://'));
        const relay = url.searchParams.get('relay');
        const session = url.searchParams.get('session');
        if (relay && session) {
          setShowQrScanner(false);
          wallet.setConnectParams({ relay, session });
          wallet.navigate('connect');
          wallet.addLog(`Connect request from relay: ${relay}`);
          return;
        }
      } catch {}
      addToast('error', 'Invalid connect QR');
      return;
    }

    // passkey://pay URI (POS payment)
    if (uri.startsWith('passkey://pay')) {
      try {
        const url = new URL(uri);
        const params = url.searchParams;
        const to = params.get('to') || params.get('depositAddress');
        const amount = params.get('amount');
        const chain = params.get('chain') || params.get('currency') || 'eth';
        const label = params.get('label') || params.get('merchant');
        if (to && amount) {
          setPendingTx({ to, amount, chain: chain.toLowerCase().replace('ethereum', 'eth').replace('solana', 'sol'), label, redirect: params.get('redirect') });
          setShowQrScanner(false);
          wallet.addLog(`Payment: ${amount} ${chain} → ${to.slice(0, 12)}...`);
          return;
        }
      } catch {}
      wallet.addLog('Failed to parse passkey://pay QR');
    }

    // Legacy passkey://send URI
    const tx = parsePasskeyUri(uri);
    if (tx) {
      setPendingTx(tx);
      setShowQrScanner(false);
      wallet.addLog(`Pending: ${tx.amount} ${tx.chain.toUpperCase()} → ${tx.to.slice(0, 12)}...`);
      return;
    }

    // Plain ETH/SOL address
    if (uri.startsWith('0x') && uri.length === 42) {
      setSendTo(uri);
      setSendChain('eth');
      setShowQrScanner(false);
      setTab('send');
      addToast('success', 'ETH address scanned');
      return;
    }
    if (uri.match(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/)) {
      setSolSendTo(uri);
      setSendChain('sol');
      setShowQrScanner(false);
      setTab('send');
      addToast('success', 'SOL address scanned');
      return;
    }

    addToast('error', 'Unrecognized QR code');
  }, [wallet, addToast]);

  const handleQrError = useCallback((error: { message?: string }) => {
    wallet.addLog(`QR error: ${error?.message || 'camera error'}`);
    setShowQrScanner(false);
    addToast('error', 'Camera error');
  }, [wallet, addToast]);

  // ─── Inline styles ─────────────────────────────────────
  const s = {
    card: { padding: 14 } as React.CSSProperties,
    sectionTitle: { fontSize: 13, fontWeight: 600, color: 'var(--color-text-secondary)', textTransform: 'uppercase' as const, letterSpacing: '0.05em', marginBottom: 10 } as React.CSSProperties,
    mono: { fontFamily: '"SF Mono", "Fira Code", monospace', fontSize: 12, color: 'var(--color-text-secondary)' } as React.CSSProperties,
    badge: (color: string, bg: string) => ({ padding: '3px 8px', borderRadius: 6, background: bg, color, fontSize: 11, fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 4 }) as React.CSSProperties,
  };

  // ─── Render Tab Content ────────────────────────────────

  return (
    <div className="app-shell">
      {/* ─── Header ──────────────────────────────────────── */}
      <div className="app-header">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Shield size={18} style={{ color: 'var(--color-accent)' }} />
            <span style={{ fontSize: 15, fontWeight: 600 }}>{w?.nearAccountId?.split('.')[0]}</span>
          </div>
          <button
            onClick={() => {
              if (w?.ethAddress) { navigator.clipboard?.writeText(w.ethAddress); addToast('success', 'Address copied'); }
            }}
            style={{ ...s.mono, background: 'var(--color-surface)', border: 'none', borderRadius: 8, padding: '4px 10px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4 }}
          >
            <Copy size={12} />
            {w?.ethAddress ? shorten(w.ethAddress, 6, 4) : '—'}
          </button>
        </div>
      </div>

      {/* ─── Scrollable Content ──────────────────────────── */}
      <div className="app-content">

        {/* Pending TX banner */}
        {pendingTx && (
          <Card style={{ borderLeft: '3px solid var(--color-accent)', padding: 12, marginBottom: 12 }}>
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>{pendingTx.label || 'Payment Request'}</div>
            <div style={{ fontSize: 13, color: 'var(--color-text-secondary)', marginBottom: 10 }}>
              {pendingTx.amount} {pendingTx.chain.toUpperCase()} → <code style={{ fontSize: 11 }}>{shorten(pendingTx.to, 10, 6)}</code>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <Button onClick={handleFillPending} style={{ flex: 1 }}>Pay</Button>
              <Button variant="secondary" onClick={() => setPendingTx(null)} style={{ flex: 1 }}>Dismiss</Button>
            </div>
          </Card>
        )}

        {/* ─── WALLET TAB ────────────────────────────────── */}
        {tab === 'wallet' && (
          <div className="animate-fade-in" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {/* Big Balance Card */}
            <Card style={{ textAlign: 'center', padding: '20px 16px' }}>
              <div style={{ fontSize: 13, color: 'var(--color-text-secondary)', marginBottom: 4 }}>Total Balance</div>
              <div style={{ fontSize: 36, fontWeight: 700, fontFamily: 'var(--font-display)', letterSpacing: '-0.02em' }}>
                {ethBalance !== null ? formatEthBalance(ethBalance) : '...'}
              </div>
              <div style={{ fontSize: 15, color: 'var(--color-text-secondary)', marginTop: 2 }}>ETH</div>
              <div style={{ display: 'flex', gap: 6, justifyContent: 'center', marginTop: 12 }}>
                <span style={s.badge('#627eea', 'rgba(98,126,234,0.15)')}>
                  <svg width="10" height="14" viewBox="0 0 10 14"><path d="M5 0l5 7.5L5 11 0 7.5z" fill="#627eea"/><path d="M5 11l5-3.5L5 14 0 7.5z" fill="#627eea" opacity=".6"/></svg>
                  ETH
                </span>
                <span style={s.badge('#a578ff', 'rgba(165,120,255,0.12)')}>SOL</span>
              </div>
              <Button variant="secondary" fullWidth onClick={handleRefreshBalance} disabled={wallet.loading} style={{ marginTop: 14, fontSize: 13, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
                <RefreshCw size={14} />
                Refresh
              </Button>
            </Card>

            {/* Quick Actions */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <Card style={{ padding: 14, cursor: 'pointer', textAlign: 'center' }} onClick={() => setTab('send')}>
                <Send size={22} style={{ marginBottom: 4, color: 'var(--color-accent)' }} />
                <div style={{ fontSize: 13, fontWeight: 500 }}>Send</div>
              </Card>
              <Card style={{ padding: 14, cursor: 'pointer', textAlign: 'center' }} onClick={() => setShowQrScanner(true)}>
                <QrCode size={22} style={{ marginBottom: 4, color: 'var(--color-accent)' }} />
                <div style={{ fontSize: 13, fontWeight: 500 }}>Scan QR</div>
              </Card>
            </div>

            {/* NEAR Balance */}
            <Card style={s.card}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <div style={{ width: 32, height: 32, borderRadius: '50%', background: 'linear-gradient(135deg, #00c08b, #009688)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <span style={{ color: 'white', fontSize: 14, fontWeight: 700, fontFamily: 'var(--font-display)' }}>N</span>
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 14, fontWeight: 600 }}>NEAR</div>
                  <div style={{ ...s.mono, fontSize: 11 }}>
                    {w?.nearAccountId || '—'}
                  </div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontSize: 16, fontWeight: 600 }}>
                    {wallet.nearBalance !== null ? formatNear(wallet.nearBalance) : '—'}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>NEAR</div>
                </div>
              </div>
            </Card>

            {/* SOL Balance (compact) */}
            <Card style={s.card}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <div style={{ width: 32, height: 32, borderRadius: '50%', background: 'linear-gradient(135deg, #a578ff, #6b3fa0)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <svg width="14" height="14" viewBox="0 0 32 32"><path d="M4 22h18l4-4H8zm24-8H10l-4 4h18z" fill="white"/></svg>
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 14, fontWeight: 600 }}>Solana</div>
                  <div style={{ ...s.mono, fontSize: 11 }}>
                    {wallet.solAddress ? shorten(wallet.solAddress, 6, 6) : 'Not loaded'}
                  </div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontSize: 16, fontWeight: 600 }}>
                    {wallet.solBalance !== null ? (Number(wallet.solBalance) / 1e9).toFixed(4) : '—'}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>SOL</div>
                </div>
              </div>
              {!wallet.solAddress && (
                <Button variant="secondary" fullWidth onClick={handleLoadSol} disabled={wallet.loading} style={{ marginTop: 10, fontSize: 12 }}>
                  Load SOL
                </Button>
              )}
            </Card>
          </div>
        )}

        {/* ─── SEND TAB ──────────────────────────────────── */}
        {tab === 'send' && (
          <div className="animate-fade-in" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {/* Chain selector */}
            <div style={{ display: 'flex', gap: 0, borderRadius: 10, overflow: 'hidden', border: '1px solid var(--color-border)' }}>
              {(['eth', 'sol'] as const).map(chain => (
                <button
                  key={chain}
                  onClick={() => setSendChain(chain)}
                  style={{
                    flex: 1, padding: '10px 0', border: 'none', cursor: 'pointer',
                    fontFamily: 'var(--font-display)', fontSize: 14, fontWeight: 600,
                    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                    background: sendChain === chain ? 'var(--color-accent)' : 'transparent',
                    color: sendChain === chain ? '#000' : 'var(--color-text-secondary)',
                    transition: 'all var(--transition-fast)',
                  }}
                >
                  {chain === 'eth' ? (
                    <><svg width="12" height="16" viewBox="0 0 10 14"><path d="M5 0l5 7.5L5 11 0 7.5z" fill="currentColor"/><path d="M5 11l5-3.5L5 14 0 7.5z" fill="currentColor" opacity=".6"/></svg> ETH</>
                  ) : (
                    <><svg width="12" height="12" viewBox="0 0 32 32"><path d="M4 22h18l4-4H8zm24-8H10l-4 4h18z" fill="currentColor"/></svg> SOL</>
                  )}
                </button>
              ))}
            </div>

            {sendChain === 'eth' ? (
              <Card style={s.card}>
                <div style={{ ...s.sectionTitle, marginBottom: 12 }}>Send Ethereum</div>
                <div style={{ fontSize: 28, fontWeight: 700, marginBottom: 12, textAlign: 'center' }}>
                  {ethBalance !== null ? formatEthBalance(ethBalance) : '...'} <span style={{ fontSize: 14, color: 'var(--color-text-secondary)' }}>ETH</span>
                </div>
                <Input placeholder="Recipient (0x...)" value={sendTo} onChange={(e) => setSendTo(e.target.value)} style={{ marginBottom: 8 }} />
                <Input placeholder="Amount (ETH)" value={sendAmount} onChange={(e) => setSendAmount(e.target.value)} type="number" step="0.0001" style={{ marginBottom: 12 }} />
                <Button fullWidth loading={wallet.loading} disabled={wallet.loading || !sendTo || !sendAmount} onClick={handleSendEth} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
                  <ArrowUpRight size={16} />
                  Send with FaceID
                </Button>
              </Card>
            ) : (
              <Card style={s.card}>
                <div style={{ ...s.sectionTitle, marginBottom: 12 }}>Send Solana</div>
                {wallet.solAddress ? (
                  <>
                    <div style={{ fontSize: 28, fontWeight: 700, marginBottom: 12, textAlign: 'center' }}>
                      {wallet.solBalance !== null ? (Number(wallet.solBalance) / 1e9).toFixed(4) : '...'} <span style={{ fontSize: 14, color: 'var(--color-text-secondary)' }}>SOL</span>
                    </div>
                    <Input placeholder="Recipient (Solana address)" value={solSendTo} onChange={(e) => setSolSendTo(e.target.value)} style={{ marginBottom: 8 }} />
                    <Input placeholder="Amount (SOL)" value={solSendAmount} onChange={(e) => setSolSendAmount(e.target.value)} type="number" step="0.001" style={{ marginBottom: 12 }} />
                    <Button fullWidth loading={wallet.loading} disabled={wallet.loading || !solSendTo || !solSendAmount} onClick={handleSendSol} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
                      <ArrowUpRight size={16} />
                      Send SOL
                    </Button>
                  </>
                ) : (
                  <div style={{ textAlign: 'center' }}>
                    <p style={{ fontSize: 13, color: 'var(--color-text-secondary)', marginBottom: 12 }}>Load your SOL address first</p>
                    <Button variant="secondary" fullWidth onClick={handleLoadSol} loading={wallet.loading}>Load SOL Address</Button>
                  </div>
                )}
              </Card>
            )}
          </div>
        )}

        {/* ─── KEYS TAB (Nostr + Session Keys) ───────────── */}
        {tab === 'nostr' && (
          <div className="animate-fade-in" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {/* Nostr Identity */}
            <Card style={s.card}>
              <div style={{ ...s.sectionTitle, display: 'flex', alignItems: 'center', gap: 6 }}>
                <KeyRound size={14} />
                Nostr Identity
              </div>
              {wallet.npub ? (
                <>
                  <div style={{ ...s.mono, wordBreak: 'break-all', marginBottom: 10, padding: '6px 10px', background: 'rgba(0,0,0,0.3)', borderRadius: 8, fontSize: 11 }}>
                    {wallet.npub}
                  </div>
                  {bunkerRunning ? (
                    <Button variant="danger" fullWidth onClick={handleStopBunker} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
                      <StopCircle size={14} />
                      Stop Bunker
                    </Button>
                  ) : (
                    <Button variant="secondary" fullWidth onClick={handleStartBunker} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
                      <Play size={14} />
                      Start Bunker
                    </Button>
                  )}
                </>
              ) : (
                <Button fullWidth onClick={handleDeriveNostr} loading={wallet.loading} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
                  <KeyRound size={14} />
                  Derive Nostr Key
                </Button>
              )}
            </Card>

            {/* Session Keys */}
            <Card style={s.card}>
              <div style={{ ...s.sectionTitle, display: 'flex', alignItems: 'center', gap: 6 }}>
                <Shield size={14} />
                Session Keys
              </div>
              <p style={{ fontSize: 12, color: 'var(--color-text-tertiary)', marginBottom: 10 }}>Skip FaceID for faster signing</p>

              {wallet.sessionKeys && Object.keys(wallet.sessionKeys).length > 0 && (
                <div style={{ marginBottom: 10 }}>
                  {Object.entries(wallet.sessionKeys).map(([id, key]: [string, any]) => {
                    const expiresAt = Number(key.expires_at) / 1e6;
                    const isExpired = Date.now() > expiresAt;
                    return (
                      <div key={id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid var(--color-border)' }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 12, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{id}</div>
                          <div style={{ fontSize: 10, color: isExpired ? 'var(--color-danger)' : 'var(--color-text-tertiary)', marginTop: 2 }}>
                            {isExpired ? 'Expired' : `Exp. ${new Date(expiresAt).toLocaleDateString()}`}
                          </div>
                        </div>
                        <button onClick={() => handleRevokeSession(id)} disabled={sessionLoading} style={{ background: 'var(--color-danger-muted)', border: 'none', borderRadius: 6, padding: '4px 10px', color: 'var(--color-danger)', fontSize: 11, cursor: 'pointer', fontFamily: 'var(--font-display)', display: 'flex', alignItems: 'center', gap: 4 }}>
                          <XCircle size={12} />
                          Revoke
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}

              {wallet.sessionKeys && Object.keys(wallet.sessionKeys).length === 0 && (
                <p style={{ fontSize: 12, color: 'var(--color-text-tertiary)', marginBottom: 10 }}>No active session keys</p>
              )}

              <div style={{ display: 'flex', gap: 8 }}>
                <Button variant="secondary" onClick={handleLoadSessionKeys} disabled={sessionLoading} style={{ flex: 1, fontSize: 12, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}>
                  <RefreshCw size={12} />
                  {wallet.sessionKeys ? 'Refresh' : 'Load'}
                </Button>
                <Button onClick={handleCreateSession} disabled={sessionLoading} loading={sessionLoading} style={{ flex: 1, fontSize: 12, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}>
                  <Plus size={12} />
                  Create
                </Button>
              </div>

              {wallet.sessionKeys && Object.keys(wallet.sessionKeys).length > 0 && (
                <Button variant="danger" fullWidth style={{ marginTop: 8, fontSize: 12 }} disabled={sessionLoading}
                  onClick={async () => {
                    if (!wallet.sessionKeys || !confirm(`Revoke all ${Object.keys(wallet.sessionKeys!).length} keys?`)) return;
                    setSessionLoading(true);
                    try { await wallet.revokeAllSessionKeys(); await handleLoadSessionKeys(); }
                    catch (err: any) { wallet.addLog(`Revoke all error: ${err.message}`); }
                    finally { setSessionLoading(false); }
                  }}>
                  Revoke All
                </Button>
              )}
            </Card>

            {/* Backup Passkey */}
            <Card style={s.card}>
              <div style={{ ...s.sectionTitle, display: 'flex', alignItems: 'center', gap: 6 }}>
                <Shield size={14} />
                Backup Passkey
              </div>
              {backupKey ? (
                <>
                  <div style={{ padding: '6px 10px', background: 'rgba(16,185,129,0.1)', border: '1px solid var(--color-accent)', borderRadius: 8, fontSize: 12, color: 'var(--color-accent)', marginBottom: 10, display: 'flex', alignItems: 'center', gap: 6 }}>
                    <CheckCircle2 size={14} />
                    Backup registered
                  </div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <Button variant="secondary" onClick={handleTestBackup} disabled={backupLoading} loading={backupLoading} style={{ flex: 1, fontSize: 12 }}>Test</Button>
                    <Button variant="danger" onClick={handleRemoveBackup} disabled={backupLoading} style={{ flex: 1, fontSize: 12 }}>Remove</Button>
                  </div>
                </>
              ) : (
                <Button fullWidth onClick={handleAddBackup} loading={backupLoading} disabled={backupLoading} style={{ fontSize: 13, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
                  <Plus size={14} />
                  Add Backup Passkey
                </Button>
              )}
            </Card>
          </div>
        )}

        {/* ─── SETTINGS TAB ──────────────────────────────── */}
        {tab === 'settings' && (
          <div className="animate-fade-in" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <Card style={s.card}>
              <div style={{ ...s.sectionTitle, display: 'flex', alignItems: 'center', gap: 6 }}>
                <Wallet size={14} />
                Wallet Info
              </div>
              <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', lineHeight: 2 }}>
                <div><span style={{ opacity: 0.5 }}>Account</span> {w?.nearAccountId}</div>
                <div><span style={{ opacity: 0.5 }}>ETH</span> <span style={s.mono}>{w?.ethAddress ? shorten(w.ethAddress, 12, 8) : '—'}</span></div>
                <div><span style={{ opacity: 0.5 }}>SOL</span> <span style={s.mono}>{wallet.solAddress ? shorten(wallet.solAddress, 8, 8) : '—'}</span></div>
                <div><span style={{ opacity: 0.5 }}>Passkey</span> <span style={s.mono}>{w?.credentialId?.slice(0, 16)}...</span></div>
                <div><span style={{ opacity: 0.5 }}>Path</span> {w?.path}</div>
                <div><span style={{ opacity: 0.5 }}>MPC</span> <span style={s.mono}>{MPC_CONTRACT}</span></div>
              </div>
            </Card>

            <Card style={s.card}>
              <div style={s.sectionTitle}>Actions</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <Button variant="secondary" fullWidth onClick={() => setShowQrScanner(true)} style={{ fontSize: 13, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
                  <ScanLine size={14} />
                  Scan QR to Pay
                </Button>
                <Button variant="danger" fullWidth onClick={wallet.logout} style={{ fontSize: 13 }}>
                  Logout
                </Button>
              </div>
            </Card>

            {/* Logs (collapsible) */}
            <Card style={{ ...s.card, cursor: 'pointer' }} onClick={() => setShowLogs(!showLogs)}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ ...s.sectionTitle, marginBottom: 0, display: 'flex', alignItems: 'center', gap: 6 }}>
                  Logs ({wallet.log.length})
                </span>
                {showLogs ? <ChevronUp size={16} style={{ color: 'var(--color-text-tertiary)' }} /> : <ChevronDown size={16} style={{ color: 'var(--color-text-tertiary)' }} />}
              </div>
            </Card>
            {showLogs && <LogPanel logs={wallet.log} />}
          </div>
        )}
      </div>

      {/* ─── Bottom Tab Bar ──────────────────────────────── */}
      <div className="app-tabbar">
        {TABS.map(t => (
          <button key={t.id} className={`tab-item ${tab === t.id ? 'active' : ''}`} onClick={() => setTab(t.id)}>
            <span className="tab-icon">{t.icon}</span>
            <span>{t.label}</span>
          </button>
        ))}
      </div>

      {/* ─── QR Scanner Modal ────────────────────────────── */}
      <Modal open={showQrScanner} onClose={() => setShowQrScanner(false)} title="Scan QR Code">
        <Scanner
          onScan={handleQrScan}
          onError={handleQrError}
          styles={{ container: { width: '100%', maxWidth: 400, borderRadius: 12, overflow: 'hidden' } }}
        />
        <p style={{ marginTop: 14, fontSize: 13, color: 'var(--color-text-secondary)', textAlign: 'center', lineHeight: 1.5 }}>
          Point camera at a <code style={{ fontSize: 12, color: 'var(--color-accent)' }}>nearpasskey://</code>, <code style={{ fontSize: 12, color: 'var(--color-accent)' }}>passkey://</code>, or <code style={{ fontSize: 12, color: 'var(--color-accent)' }}>nostrconnect://</code> QR code, or a plain ETH/SOL address
        </p>
      </Modal>

      {/* Toast */}
      <Toast toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
};
