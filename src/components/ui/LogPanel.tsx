import React, { useState } from 'react';

interface LogPanelProps {
  logs: string[];
  visible?: boolean;
}

export const LogPanel: React.FC<LogPanelProps> = ({ logs, visible: controlledVisible }) => {
  const [internalVisible, setInternalVisible] = useState(false);
  const isVisible = controlledVisible !== undefined ? controlledVisible : internalVisible;

  return (
    <div
      style={{
        width: '100%',
        fontFamily: 'var(--font-display)',
      }}
    >
      {controlledVisible === undefined && (
        <button
          onClick={() => setInternalVisible((v) => !v)}
          style={{
            background: 'var(--color-surface)',
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-md)',
            padding: '6px 12px',
            color: 'var(--color-text-secondary)',
            fontSize: '12px',
            fontFamily: 'var(--font-display)',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            marginBottom: 8,
            transition: 'all var(--transition-base)',
          }}
        >
          <span
            style={{
              display: 'inline-block',
              width: 6,
              height: 6,
              borderRadius: '50%',
              background: logs.length > 0 ? 'var(--color-accent)' : 'var(--color-border)',
            }}
          />
          {isVisible ? 'Hide Logs' : 'Show Logs'} ({logs.length})
        </button>
      )}

      {isVisible && (
        <div
          style={{
            background: 'rgba(0, 0, 0, 0.3)',
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-md)',
            maxHeight: 200,
            overflowY: 'auto',
            padding: '10px 12px',
            fontFamily: '"SF Mono", "Fira Code", "Fira Mono", Menlo, Consolas, monospace',
            fontSize: '11px',
            lineHeight: 1.6,
            color: 'var(--color-text-secondary)',
            wordBreak: 'break-all',
          }}
        >
          {logs.length === 0 ? (
            <span style={{ opacity: 0.5 }}>No logs yet…</span>
          ) : (
            logs.map((log, i) => (
              <div
                key={i}
                style={{
                  padding: '2px 0',
                  borderBottom:
                    i < logs.length - 1 ? '1px solid var(--color-border)' : 'none',
                }}
              >
                <span style={{ opacity: 0.4, marginRight: 8 }}>{i + 1}.</span>
                {log}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
};
