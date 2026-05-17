import React, { useEffect, useCallback } from 'react';

type ToastType = 'success' | 'error' | 'info';

export interface ToastMessage {
  id: string;
  type: ToastType;
  message: string;
}

interface ToastProps {
  toasts: ToastMessage[];
  onDismiss: (id: string) => void;
}

const keyframes = `
@keyframes ui-toast-slide-in {
  from {
    transform: translateX(100%);
    opacity: 0;
  }
  to {
    transform: translateX(0);
    opacity: 1;
  }
}
@keyframes ui-toast-fade-out {
  from {
    opacity: 1;
  }
  to {
    opacity: 0;
    transform: translateY(10px);
  }
}
`;

let injected = false;

function injectToastKeyframes() {
  if (injected) return;
  const style = document.createElement('style');
  style.textContent = keyframes;
  document.head.appendChild(style);
  injected = true;
}

const typeStyles: Record<ToastType, { background: string; borderColor: string; icon: string }> = {
  success: {
    background: 'rgba(16, 185, 129, 0.12)',
    borderColor: 'var(--color-accent)',
    icon: '✓',
  },
  error: {
    background: 'rgba(239, 68, 68, 0.12)',
    borderColor: 'var(--color-danger)',
    icon: '✕',
  },
  info: {
    background: 'rgba(59, 130, 246, 0.12)',
    borderColor: '#3b82f6',
    icon: 'ℹ',
  },
};

const ToastItem: React.FC<{ toast: ToastMessage; onDismiss: (id: string) => void }> = ({
  toast,
  onDismiss,
}) => {
  useEffect(() => {
    injectToastKeyframes();
    const timer = setTimeout(() => onDismiss(toast.id), 4000);
    return () => clearTimeout(timer);
  }, [toast.id, onDismiss]);

  const cfg = typeStyles[toast.type];

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '12px 16px',
        background: cfg.background,
        border: `1px solid ${cfg.borderColor}`,
        borderRadius: 'var(--radius-md)',
        fontFamily: 'var(--font-display)',
        fontSize: '14px',
        color: 'var(--color-text)',
        backdropFilter: 'blur(20px)',
        WebkitBackdropFilter: 'blur(20px)',
        boxShadow: 'var(--shadow-md)',
        animation: 'ui-toast-slide-in 0.3s ease-out',
        minWidth: 280,
        maxWidth: 400,
      }}
    >
      <span
        style={{
          flexShrink: 0,
          width: 22,
          height: 22,
          borderRadius: '50%',
          background: cfg.borderColor,
          color: '#fff',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: '12px',
          fontWeight: 700,
        }}
      >
        {cfg.icon}
      </span>
      <span style={{ flex: 1 }}>{toast.message}</span>
      <button
        onClick={() => onDismiss(toast.id)}
        style={{
          background: 'none',
          border: 'none',
          color: 'var(--color-text-secondary)',
          cursor: 'pointer',
          padding: 2,
          fontSize: '16px',
          lineHeight: 1,
          fontFamily: 'var(--font-display)',
        }}
      >
        ×
      </button>
    </div>
  );
};

export const Toast: React.FC<ToastProps> = ({ toasts, onDismiss }) => {
  const dismiss = useCallback((id: string) => onDismiss(id), [onDismiss]);

  if (toasts.length === 0) return null;

  return (
    <div
      style={{
        position: 'fixed',
        bottom: 24,
        right: 24,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        zIndex: 'var(--z-toast, 9999)',
      }}
    >
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} onDismiss={dismiss} />
      ))}
    </div>
  );
};
