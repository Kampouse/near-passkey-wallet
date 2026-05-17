import { useEffect } from 'react';
import { WalletProvider, useWallet } from '../hooks';
import { WelcomeScreen, NamingScreen, CreatingScreen, LoginScreen, DashboardScreen, SendingScreen, ConnectScreen } from '../screens';

/**
 * On mobile, dApps can open the wallet via:
 *   https://near-passkey-wallet.pages.dev/?connect=1&relay=ENCODED_RELAY&session=SESSION_ID
 *
 * This hook detects those URL params on mount and auto-navigates to ConnectScreen.
 */
function useDeepLinkConnect() {
  const { navigate, setConnectParams, wallet } = useWallet();

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('connect') !== '1') return;

    const relay = params.get('relay');
    const session = params.get('session');
    if (!relay || !session) return;

    // Only auto-connect if user has a wallet (logged in)
    if (!wallet) {
      // Store intent, let user login first — handled by WalletProvider
      try { sessionStorage.setItem('pending_connect', JSON.stringify({ relay, session })); } catch {}
      return;
    }

    // Clear URL params so we don't re-trigger on refresh
    window.history.replaceState({}, '', window.location.pathname);

    setConnectParams({ relay, session });
    navigate('connect');
  }, [wallet]);
}

function Router() {
  const { screen } = useWallet();
  useDeepLinkConnect();
  
  switch (screen) {
    case 'welcome': return <WelcomeScreen />;
    case 'naming': return <NamingScreen />;
    case 'creating': return <CreatingScreen />;
    case 'login': return <LoginScreen />;
    case 'dashboard': return <DashboardScreen />;
    case 'sending': return <SendingScreen />;
    case 'connect': return <ConnectScreenWrapper />;
    default: return <WelcomeScreen />;
  }
}

function ConnectScreenWrapper() {
  const { connectParams, navigate } = useWallet();
  
  if (!connectParams) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 24, minHeight: '60vh' }}>
        <p style={{ color: 'var(--color-text-secondary)' }}>No connection request</p>
        <button onClick={() => navigate('dashboard')} style={{ marginTop: 16, color: 'var(--color-accent)', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'var(--font-display)' }}>
          Back to wallet
        </button>
      </div>
    );
  }

  return <ConnectScreen params={connectParams} onDone={() => {
    navigate('dashboard');
    // If we were opened via deep link, try to go back or close
    if (window.history.length <= 2) {
      window.close();
    }
  }} />;
}

export default function App() {
  return (
    <WalletProvider>
      <Router />
    </WalletProvider>
  );
}
