import React, { useEffect, useRef } from 'react';

interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
  hint?: string;
}

const keyframes = `
@keyframes ui-input-focus-border {
  from { width: 0%; }
  to { width: 100%; }
}
`;

let injected = false;

function injectInputKeyframes() {
  if (injected) return;
  const style = document.createElement('style');
  style.textContent = keyframes;
  document.head.appendChild(style);
  injected = true;
}

export const Input: React.FC<InputProps> = ({
  label,
  error,
  hint,
  style,
  autoFocus,
  ...props
}) => {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    injectInputKeyframes();
  }, []);

  useEffect(() => {
    if (autoFocus && inputRef.current) {
      inputRef.current.focus();
    }
  }, [autoFocus]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, width: '100%', ...style }}>
      {label && (
        <label
          style={{
            fontSize: '13px',
            fontWeight: 500,
            color: 'var(--color-text-secondary)',
            fontFamily: 'var(--font-display)',
            letterSpacing: '0.02em',
          }}
        >
          {label}
        </label>
      )}
      <div style={{ position: 'relative' }}>
        <input
          ref={inputRef}
          style={{
            width: '100%',
            padding: '12px 16px',
            background: 'var(--color-surface)',
            color: 'var(--color-text)',
            border: `1px solid ${error ? 'var(--color-danger)' : 'var(--color-border)'}`,
            borderRadius: 'var(--radius-md)',
            fontSize: '15px',
            fontFamily: 'var(--font-display)',
            outline: 'none',
            transition: 'all var(--transition-base)',
            boxSizing: 'border-box',
            boxShadow: error ? '0 0 0 3px var(--color-danger-muted)' : 'none',
          }}
          onFocus={(e) => {
            e.currentTarget.style.borderColor = error
              ? 'var(--color-danger)'
              : 'var(--color-accent)';
            e.currentTarget.style.boxShadow = error
              ? '0 0 0 3px var(--color-danger-muted)'
              : '0 0 0 3px var(--color-accent-muted, rgba(16,185,129,0.15))';
            props.onFocus?.(e);
          }}
          onBlur={(e) => {
            e.currentTarget.style.borderColor = error
              ? 'var(--color-danger)'
              : 'var(--color-border)';
            e.currentTarget.style.boxShadow = error
              ? '0 0 0 3px var(--color-danger-muted)'
              : 'none';
            props.onBlur?.(e);
          }}
          {...props}
        />
      </div>
      {(error || hint) && (
        <span
          style={{
            fontSize: '12px',
            color: error ? 'var(--color-danger)' : 'var(--color-text-secondary)',
            fontFamily: 'var(--font-display)',
            marginTop: 2,
          }}
        >
          {error || hint}
        </span>
      )}
    </div>
  );
};
