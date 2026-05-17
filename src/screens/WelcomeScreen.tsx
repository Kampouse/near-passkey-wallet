import React, { useState } from 'react';
import { useWallet } from '../hooks';
import { Button, Card, Input, Screen, LogPanel } from '../components/ui';
import { FACTORY_CONTRACT, MPC_CONTRACT, RELAY_URL } from '../lib';
import { Plus, Fingerprint } from 'lucide-react';

export const WelcomeScreen: React.FC = () => {
  const wallet = useWallet();
  const [loginAccountId, setLoginAccountId] = useState('');

  const handleLoginSubmit = async () => {
    if (!loginAccountId || loginAccountId.length < 3) return;
    await wallet.completeLoginWithAccountId(loginAccountId);
  };

  return (
    <Screen centered animate>
      <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 16 }}>
        {/* Header */}
        <div style={{ textAlign: 'center', marginBottom: 8 }}>
          <h1
            style={{
              margin: 0,
              fontSize: '32px',
              fontWeight: 700,
              fontFamily: 'var(--font-display)',
              color: 'var(--color-text)',
              letterSpacing: '-0.02em',
            }}
          >
            Passkey Wallet
          </h1>
          <p
            style={{
              margin: '8px 0 0',
              fontSize: '15px',
              color: 'var(--color-text-secondary)',
              fontFamily: 'var(--font-display)',
            }}
          >
            Cross-chain wallet secured by your face
          </p>
        </div>

        {/* Primary Actions */}
        <Button
          fullWidth
          onClick={() => wallet.navigate('naming')}
          style={{ padding: '16px 24px', fontSize: '17px', fontWeight: 600, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}
        >
          <Plus size={18} />
          Create Wallet
        </Button>

        <Button
          variant="secondary"
          fullWidth
          loading={wallet.loading}
          onClick={wallet.login}
          style={{ padding: '14px 24px', fontSize: '16px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}
        >
          <Fingerprint size={18} />
          Login with FaceID
        </Button>

        {/* Inline Account ID Input */}
        {wallet.needAccountId && (
          <Card title="Enter Account Name" style={{ borderLeft: '3px solid var(--color-accent)' }}>
            <p
              style={{
                margin: '0 0 12px',
                fontSize: '13px',
                color: 'var(--color-text-secondary)',
                lineHeight: 1.5,
              }}
            >
              Your passkey was found but we need your NEAR account name to complete login.
            </p>
            <Input
              placeholder="your-wallet.testnet"
              value={loginAccountId}
              onChange={(e) => setLoginAccountId(e.target.value.replace(/\s/g, '').toLowerCase())}
              autoFocus
              style={{ marginBottom: 12 }}
            />
            <Button
              fullWidth
              disabled={!loginAccountId || loginAccountId.length < 3}
              onClick={handleLoginSubmit}
            >
              Connect
            </Button>
          </Card>
        )}

        {/* How it Works */}
        <Card title="How it works" style={{ marginTop: 8 }}>
          <div
            style={{
              fontSize: '14px',
              color: 'var(--color-text-secondary)',
              lineHeight: 1.7,
            }}
          >
              {['Pick a name for your wallet', 'FaceID creates a passkey (secure enclave)', 'Your wallet gets a dedicated address on every chain', 'Send, swap, sign — all with your face'].map((step, i) => (
              <div
                key={i}
                style={{ display: 'flex', gap: 10, alignItems: 'flex-start', marginBottom: 8 }}
              >
                <span
                  style={{
                    width: 24,
                    height: 24,
                    borderRadius: '50%',
                    background: 'var(--color-accent)',
                    color: '#fff',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: 12,
                    fontWeight: 700,
                    flexShrink: 0,
                    marginTop: 1,
                  }}
                >
                  {i + 1}
                </span>
                <span>{step}</span>
              </div>
            ))}
            <p
              style={{
                margin: '12px 0 0',
                fontSize: '13px',
                color: 'var(--color-text-secondary)',
                opacity: 0.7,
              }}
            >
              No seed phrase. No private keys.
              <br />
              Backed up via iCloud Keychain / Google Password Manager.
            </p>
          </div>
        </Card>

        {/* Test Bench Info */}
        <Card title="Test Bench">
          <div
            style={{
              fontSize: '13px',
              color: 'var(--color-text-secondary)',
              lineHeight: 1.8,
            }}
          >
            <div>
              <span style={{ opacity: 0.6 }}>Factory:</span>{' '}
              <code style={{ fontSize: '12px' }}>{FACTORY_CONTRACT}</code>
            </div>
            <div>
              <span style={{ opacity: 0.6 }}>MPC:</span>{' '}
              <code style={{ fontSize: '12px' }}>{MPC_CONTRACT}</code>
            </div>
            <div>
              <span style={{ opacity: 0.6 }}>Relay:</span>{' '}
              <code style={{ fontSize: '12px' }}>{RELAY_URL.replace('https://', '')}</code>
            </div>
            <div>
              <span style={{ opacity: 0.6 }}>Test bench:</span> 48/48 passing
            </div>
          </div>
        </Card>

        {/* Log Panel */}
        <LogPanel logs={wallet.log} />
      </div>
    </Screen>
  );
};
