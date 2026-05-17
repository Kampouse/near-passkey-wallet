import React from 'react';
import { Screen, Spinner } from '../components/ui';

export const LoginScreen: React.FC = () => {
  return (
    <Screen centered animate>
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
          Authenticating...
        </h1>
        <p
          style={{
            margin: 0,
            fontSize: '14px',
            color: 'var(--color-text-secondary)',
          }}
        >
          Verifying your passkey and restoring wallet.
        </p>
      </div>
    </Screen>
  );
};
