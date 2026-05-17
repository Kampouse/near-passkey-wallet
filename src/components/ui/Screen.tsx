import React, { useEffect } from 'react';

interface ScreenProps {
  children: React.ReactNode;
  centered?: boolean;
  animate?: boolean;
}

const keyframes = `
@keyframes ui-screen-fade-in {
  from {
    opacity: 0;
    transform: translateY(12px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
`;

let injected = false;

function injectScreenKeyframes() {
  if (injected) return;
  const style = document.createElement('style');
  style.textContent = keyframes;
  document.head.appendChild(style);
  injected = true;
}

export const Screen: React.FC<ScreenProps> = ({
  children,
  centered = true,
  animate = true,
}) => {
  useEffect(() => {
    injectScreenKeyframes();
  }, []);

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        maxWidth: 480,
        width: '100%',
        minHeight: '100vh',
        padding: '24px 20px',
        boxSizing: 'border-box',
        fontFamily: 'var(--font-display)',
        color: 'var(--color-text)',
        ...(centered
          ? {
              justifyContent: 'center',
              alignItems: 'center',
              margin: '0 auto',
            }
          : {
              margin: '0 auto',
            }),
        ...(animate
          ? {
              animation: 'ui-screen-fade-in 0.4s ease-out',
            }
          : {}),
      }}
    >
      {children}
    </div>
  );
};
