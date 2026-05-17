import React, { useEffect } from 'react';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: React.ReactNode;
}

const keyframes = `
@keyframes ui-modal-backdrop-in {
  from { opacity: 0; }
  to { opacity: 1; }
}
@keyframes ui-modal-panel-in {
  from {
    opacity: 0;
    transform: scale(0.95) translateY(10px);
  }
  to {
    opacity: 1;
    transform: scale(1) translateY(0);
  }
}
`;

let injected = false;

function injectModalKeyframes() {
  if (injected) return;
  const style = document.createElement('style');
  style.textContent = keyframes;
  document.head.appendChild(style);
  injected = true;
}

export const Modal: React.FC<ModalProps> = ({ open, onClose, title, children }) => {
  useEffect(() => {
    injectModalKeyframes();
  }, []);

  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 'var(--z-modal, 1000)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        animation: 'ui-modal-backdrop-in 0.2s ease-out',
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {/* Backdrop */}
      <div
        onClick={onClose}
        style={{
          position: 'absolute',
          inset: 0,
          background: 'rgba(0, 0, 0, 0.6)',
          backdropFilter: 'blur(8px)',
          WebkitBackdropFilter: 'blur(8px)',
        }}
      />

      {/* Panel */}
      <div
        style={{
          position: 'relative',
          background: 'var(--color-surface-elevated, rgba(30, 30, 30, 0.95))',
          border: '1px solid var(--color-border)',
          borderRadius: 'var(--radius-lg, 16px)',
          padding: 24,
          minWidth: 320,
          maxWidth: '90vw',
          maxHeight: '85vh',
          overflow: 'auto',
          boxShadow: 'var(--shadow-md)',
          animation: 'ui-modal-panel-in 0.25s ease-out',
        }}
      >
        {/* Header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: title ? 20 : 0,
          }}
        >
          {title && (
            <h2
              style={{
                margin: 0,
                fontSize: '18px',
                fontWeight: 600,
                color: 'var(--color-text)',
                fontFamily: 'var(--font-display)',
              }}
            >
              {title}
            </h2>
          )}
          <button
            onClick={onClose}
            style={{
              background: 'var(--color-surface)',
              border: '1px solid var(--color-border)',
              borderRadius: '50%',
              width: 28,
              height: 28,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'var(--color-text-secondary)',
              cursor: 'pointer',
              fontSize: '14px',
              lineHeight: 1,
              fontFamily: 'var(--font-display)',
              marginLeft: 'auto',
              flexShrink: 0,
            }}
          >
            ×
          </button>
        </div>

        {children}
      </div>
    </div>
  );
};
