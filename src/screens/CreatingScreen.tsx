import React from 'react';
import { useWallet } from '../hooks';
import { Screen, LogPanel, Spinner } from '../components/ui';

export const CreatingScreen: React.FC = () => {
  const wallet = useWallet();

  return (
    <Screen centered animate>
      <div style={{ width: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 24 }}>
        {/* Spinner + Title */}
        <div style={{ textAlign: 'center' }}>
          <Spinner size={48} />
          <h1
            style={{
              margin: '20px 0 8px',
              fontSize: '24px',
              fontWeight: 700,
              fontFamily: 'var(--font-display)',
              color: 'var(--color-text)',
            }}
          >
            Creating your wallet...
          </h1>
          <p
            style={{
              margin: 0,
              fontSize: '14px',
              color: 'var(--color-text-secondary)',
            }}
          >
            This may take a moment. Follow FaceID prompts.
          </p>
        </div>

        {/* Step indicators */}
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
            width: '100%',
            maxWidth: 320,
          }}
        >
          {[
            { label: 'FaceID / Passkey', step: 1 },
            { label: 'Passkey Registration', step: 2 },
            { label: 'Loading WASM Contract', step: 3 },
            { label: 'Creating Account', step: 4 },
            { label: 'Deriving ETH Address', step: 5 },
          ].map(({ label, step }) => (
            <div
              key={step}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '6px 0',
                fontSize: '13px',
                color: 'var(--color-text-secondary)',
              }}
            >
              <span
                style={{
                  width: 20,
                  height: 20,
                  borderRadius: '50%',
                  background: 'var(--color-surface)',
                  border: '1px solid var(--color-border)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: '10px',
                  fontWeight: 600,
                  flexShrink: 0,
                }}
              >
                {step}
              </span>
              {label}
            </div>
          ))}
        </div>

        {/* Live Log */}
        <div style={{ width: '100%' }}>
          <LogPanel logs={wallet.log} visible={true} />
        </div>
      </div>
    </Screen>
  );
};
