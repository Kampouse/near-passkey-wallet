import React, { useState, useEffect } from 'react';
import { useWallet } from '../hooks';
import { Button, Card, Input, Screen, LogPanel } from '../components/ui';
import { FACTORY_CONTRACT } from '../lib';
import { Check } from 'lucide-react';

export const NamingScreen: React.FC = () => {
  const wallet = useWallet();
  const [name, setName] = useState('');
  const [accountType, setAccountType] = useState<'root' | 'sub'>('root');
  const [nameAvailable, setNameAvailable] = useState<boolean | null>(null);
  const [checkingName, setCheckingName] = useState(false);

  // Sanitize input: lowercase, no spaces, only alphanumeric + dash/underscore
  const sanitize = (val: string) => val.replace(/[^a-zA-Z0-9_-]/g, '').toLowerCase();

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setName(sanitize(e.target.value));
  };

  // Preview full account ID
  const previewId = name
    ? accountType === 'root'
      ? `${name}.testnet`
      : `${name}.${FACTORY_CONTRACT}`
    : '';

  // Debounced availability check (500ms)
  useEffect(() => {
    if (!name || name.length < 2) {
      setNameAvailable(null);
      return;
    }

    const timer = setTimeout(async () => {
      setCheckingName(true);
      try {
        const available = await wallet.checkAccountAvailable(previewId);
        setNameAvailable(available);
      } catch {
        setNameAvailable(null);
      } finally {
        setCheckingName(false);
      }
    }, 500);

    return () => clearTimeout(timer);
  }, [name, accountType]);

  const canCreate = name.length >= 2 && nameAvailable === true;

  return (
    <Screen centered animate>
      <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 16 }}>
        {/* Header */}
        <div style={{ textAlign: 'center', marginBottom: 8 }}>
          <h1
            style={{
              margin: 0,
              fontSize: '28px',
              fontWeight: 700,
              fontFamily: 'var(--font-display)',
              color: 'var(--color-text)',
            }}
          >
            Name Your Wallet
          </h1>
          <p
            style={{
              margin: '8px 0 0',
              fontSize: '15px',
              color: 'var(--color-text-secondary)',
            }}
          >
            Choose a name for your on-chain identity.
          </p>
        </div>

        {/* Account Type Toggle */}
        <Card title="Account Type">
          <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
            <Button
              variant={accountType === 'root' ? 'primary' : 'secondary'}
              onClick={() => setAccountType('root')}
              style={{ flex: 1 }}
            >
              Root Account
            </Button>
            <Button
              variant={accountType === 'sub' ? 'primary' : 'secondary'}
              onClick={() => setAccountType('sub')}
              style={{ flex: 1 }}
            >
              Subaccount
            </Button>
          </div>
          <p
            style={{
              margin: 0,
              fontSize: '13px',
              color: 'var(--color-text-secondary)',
              lineHeight: 1.5,
            }}
          >
            {accountType === 'root'
              ? 'You own the account directly: yourname.testnet'
              : `Under the factory: yourname.${FACTORY_CONTRACT}`}
          </p>
        </Card>

        {/* Name Input */}
        <Card>
          <Input
            label="Wallet Name"
            placeholder="your-name"
            value={name}
            onChange={handleChange}
            autoFocus
          />

          {/* Preview */}
          {previewId && (
            <div style={{ marginTop: 12, fontSize: '14px' }}>
              {checkingName ? (
                <span style={{ color: 'var(--color-text-secondary)' }}>Checking availability...</span>
              ) : nameAvailable === true ? (
                <span style={{ color: 'var(--color-accent)', display: 'flex', alignItems: 'center', gap: 4 }}><Check size={14} /> {previewId} is available</span>
              ) : nameAvailable === false ? (
                <span style={{ color: 'var(--color-danger)' }}>✗ {previewId} is taken</span>
              ) : null}
            </div>
          )}

          {/* Full ID Preview */}
          {previewId && (
            <div
              style={{
                marginTop: 8,
                padding: '8px 12px',
                background: 'rgba(0,0,0,0.2)',
                borderRadius: 'var(--radius-md)',
                fontSize: '13px',
                color: 'var(--color-text-secondary)',
                fontFamily: '"SF Mono", "Fira Code", monospace',
              }}
            >
              {previewId}
            </div>
          )}
        </Card>

        {/* Action Buttons */}
        <div style={{ display: 'flex', gap: 8 }}>
          <Button
            variant="ghost"
            onClick={() => wallet.navigate('welcome')}
            style={{ flex: 1 }}
          >
            Back
          </Button>
          <Button
            disabled={!canCreate}
            loading={wallet.loading}
            onClick={() => wallet.createWallet(name, accountType)}
            style={{ flex: 2 }}
          >
            Create with FaceID
          </Button>
        </div>

        {/* Log Panel */}
        <LogPanel logs={wallet.log} />
      </div>
    </Screen>
  );
};
