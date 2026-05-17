import React, { useEffect } from 'react';

interface SpinnerProps {
  size?: number;
  color?: string;
}

const keyframes = `
@keyframes ui-spinner-rotate {
  to { transform: rotate(360deg); }
}
`;

let injected = false;

function injectSpinnerKeyframes() {
  if (injected) return;
  const style = document.createElement('style');
  style.textContent = keyframes;
  document.head.appendChild(style);
  injected = true;
}

export const Spinner: React.FC<SpinnerProps> = ({ size = 24, color }) => {
  useEffect(() => {
    injectSpinnerKeyframes();
  }, []);

  return (
    <span
      style={{
        display: 'inline-block',
        width: size,
        height: size,
        border: `${Math.max(2, size / 8)}px solid ${color ?? 'var(--color-accent)'}33`,
        borderTopColor: color ?? 'var(--color-accent)',
        borderRadius: '50%',
        animation: 'ui-spinner-rotate 0.6s linear infinite',
        flexShrink: 0,
      }}
    />
  );
};
