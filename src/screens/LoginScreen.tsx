import React from 'react';
import { Screen, Spinner } from '../components/ui';
import { useWallet } from '../hooks';

export const LoginScreen: React.FC = () => {
  const { log } = useWallet();

  // Show the last few log entries as progress steps
  const recentLogs = log.slice(-6);

  return (
    <Screen centered animate>
      <div style={{ width: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        <div style={{
          width: 64,
          height: 64,
          borderRadius: 20,
          background: 'rgba(16, 185, 129, 0.12)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          marginBottom: 20,
        }}>
          <Spinner size={32} />
        </div>

        <h1 style={{
          margin: '0 0 6px',
          fontSize: '24px',
          fontWeight: 700,
          fontFamily: 'var(--font-display)',
          color: 'var(--color-text)',
        }}>
          Restoring Wallet
        </h1>
        <p style={{
          margin: '0 0 24px',
          fontSize: '14px',
          color: 'var(--color-text-secondary)',
        }}>
          Setting up your secure session...
        </p>

        {/* Live progress steps */}
        <div style={{
          width: '100%',
          maxWidth: 320,
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
        }}>
          {recentLogs.map((entry, i) => {
            const isLast = i === recentLogs.length - 1;
            // Extract message after timestamp
            const msg = entry.replace(/^\[.*?\]\s*/, '');
            return (
              <div
                key={i}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  opacity: isLast ? 1 : 0.5,
                  transition: 'opacity 0.3s ease',
                }}
              >
                <div style={{
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  background: isLast ? 'var(--color-accent)' : 'var(--color-text-secondary)',
                  flexShrink: 0,
                  animation: isLast ? 'pulse 1.5s ease-in-out infinite' : 'none',
                }} />
                <span style={{
                  fontSize: '13px',
                  color: isLast ? 'var(--color-text)' : 'var(--color-text-secondary)',
                  fontFamily: 'var(--font-body)',
                  lineHeight: 1.4,
                }}>
                  {msg.length > 60 ? msg.slice(0, 57) + '...' : msg}
                </span>
              </div>
            );
          })}
        </div>

        <style>{`
          @keyframes pulse {
            0%, 100% { opacity: 1; transform: scale(1); }
            50% { opacity: 0.5; transform: scale(0.8); }
          }
        `}</style>
      </div>
    </Screen>
  );
};
