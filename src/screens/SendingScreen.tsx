import React from 'react';
import { useWallet } from '../hooks';
import { Screen, LogPanel, Spinner } from '../components/ui';

export const SendingScreen: React.FC = () => {
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
            Sending transaction...
          </h1>
          <p
            style={{
              margin: 0,
              fontSize: '14px',
              color: 'var(--color-text-secondary)',
            }}
          >
            Signing and broadcasting. Please approve FaceID if prompted.
          </p>
        </div>

        {/* Progress Steps */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, width: '100%', maxWidth: 320 }}>
          {[
            'Fetching nonce & gas prices',
            'Building unsigned transaction',
            'Computing challenge hash',
            'Requesting passkey signature (FaceID)',
            'Submitting to wallet contract via relay',
            'Assembling signed transaction',
            'Broadcasting to network',
          ].map((step, i) => (
            <div
              key={i}
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
                {i + 1}
              </span>
              {step}
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
