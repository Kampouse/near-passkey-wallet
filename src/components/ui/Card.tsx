import React from 'react';

interface CardProps {
  title?: string;
  subtitle?: string;
  children: React.ReactNode;
  padding?: 'sm' | 'md' | 'lg';
  style?: React.CSSProperties;
  onClick?: () => void;
}

const paddingMap: Record<string, string> = {
  sm: '12px',
  md: '20px',
  lg: '28px',
};

export const Card: React.FC<CardProps> = ({
  title,
  subtitle,
  children,
  padding = 'md',
  style,
  onClick,
}) => (
  <div
    onClick={onClick}
    style={{
      background: 'var(--color-surface)',
      border: '1px solid var(--color-border)',
      borderRadius: 'var(--radius-lg, 16px)',
      padding: paddingMap[padding] ?? '20px',
      boxShadow: 'var(--shadow-md)',
      backdropFilter: 'blur(20px)',
      WebkitBackdropFilter: 'blur(20px)',
      transition: 'all var(--transition-base)',
      ...style,
    }}
  >
    {(title || subtitle) && (
      <div style={{ marginBottom: title || subtitle ? 16 : 0 }}>
        {title && (
          <h3
            style={{
              margin: 0,
              fontSize: '17px',
              fontWeight: 600,
              color: 'var(--color-text)',
              fontFamily: 'var(--font-display)',
              lineHeight: 1.3,
            }}
          >
            {title}
          </h3>
        )}
        {subtitle && (
          <p
            style={{
              margin: 0,
              marginTop: 4,
              fontSize: '13px',
              color: 'var(--color-text-secondary)',
              fontFamily: 'var(--font-display)',
              lineHeight: 1.4,
            }}
          >
            {subtitle}
          </p>
        )}
      </div>
    )}
    {children}
  </div>
);
