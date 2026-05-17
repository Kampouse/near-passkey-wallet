import React from 'react';
import { Spinner } from './Spinner';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  loading?: boolean;
  fullWidth?: boolean;
}

const variantStyles: Record<Variant, React.CSSProperties> = {
  primary: {
    background: 'var(--color-accent)',
    color: '#fff',
    fontWeight: 600,
  },
  secondary: {
    background: 'var(--color-surface)',
    color: 'var(--color-text)',
    border: '1px solid var(--color-border)',
  },
  ghost: {
    background: 'transparent',
    color: 'var(--color-text-secondary)',
  },
  danger: {
    background: 'var(--color-danger-muted)',
    color: 'var(--color-danger)',
  },
};

export const Button: React.FC<ButtonProps> = ({
  variant = 'primary',
  loading,
  fullWidth,
  children,
  disabled,
  style,
  ...props
}) => (
  <button
    disabled={disabled || loading}
    style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
      padding: '12px 24px',
      borderRadius: 'var(--radius-md)',
      fontSize: 'var(--text-base)',
      fontFamily: 'var(--font-display)',
      cursor: disabled || loading ? 'not-allowed' : 'pointer',
      opacity: disabled || loading ? 0.5 : 1,
      transition: 'all var(--transition-base)',
      width: fullWidth ? '100%' : undefined,
      border: 'none',
      outline: 'none',
      ...variantStyles[variant],
      ...style,
    }}
    {...props}
  >
    {loading && <Spinner size={18} />}
    {children}
  </button>
);
