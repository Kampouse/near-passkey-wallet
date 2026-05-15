/**
 * NostrBunker.jsx
 * 
 * UI component for the Nostr bunker feature.
 * - Shows npub and bunker QR
 * - Displays connected sessions
 * - Handles sign request approvals
 */

import React, { useState, useEffect, useCallback } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import { deriveNostrAddress } from './wallet.js'

// NIP-46 relay endpoints
const NIP46_RELAYS = [
  'wss://relay.primal.net',
  'wss://nos.lol',
  'wss://relay.damus.io',
]

export function NostrBunkerCard({ wallet, onDerive, npub, nostrPubkey, loading, bunker, onStartBunker, onStopBunker }) {
  const [showBunkerQr, setShowBunkerQr] = useState(false)

  return (
    <div className="card">
      <div className="card-header">
        <div className="card-icon" style={{ background: 'linear-gradient(135deg, #8b5cf6, #6d28d9)' }}>⚡</div>
        <div>
          <div className="card-title">Nostr Identity</div>
          <div className="card-subtitle">{npub ? 'Sign with FaceID' : 'Create session key'}</div>
        </div>
      </div>
      {npub ? (
        <div>
          <div className="address-short" style={{ marginBottom: 8 }}>
            {npub.slice(0, 20)}...{npub.slice(-8)}
          </div>
          <div style={{ fontSize: 11, color: '#888', marginBottom: 12 }}>
            Pubkey: {nostrPubkey?.slice(0, 16)}...
          </div>
          
          {bunker ? (
            <button className="btn btn-secondary btn-full" onClick={onStopBunker} style={{ marginBottom: 8 }}>
              Stop Listening
            </button>
          ) : (
            <button className="btn btn-primary btn-full" onClick={onStartBunker} disabled={loading} style={{ marginBottom: 8 }}>
              {loading ? 'Starting...' : 'Start Bunker'}
            </button>
          )}
          
          <button className="btn btn-secondary btn-full" onClick={() => setShowBunkerQr(true)}>
            Show Bunker QR
          </button>
          
          {showBunkerQr && (
            <BunkerQRModal 
              npub={npub} 
              nostrPubkey={nostrPubkey}
              onClose={() => setShowBunkerQr(false)} 
            />
          )}
        </div>
      ) : (
        <button className="btn btn-primary btn-full" onClick={onDerive} disabled={loading}>
          {loading ? 'Creating...' : 'Create Nostr Key'}
        </button>
      )}
    </div>
  )
}

function BunkerQRModal({ npub, nostrPubkey, onClose }) {
  const bunkerUri = `bunker://${npub}?relay=${encodeURIComponent(NIP46_RELAYS[0])}`
  
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 360 }}>
        <div className="modal-header">
          <h3>Nostr Bunker</h3>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>
        
        <div style={{ textAlign: 'center', padding: 16 }}>
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 12, color: '#888', marginBottom: 8 }}>
              Scan with Primal, Damus, or Amethyst
            </div>
            <div style={{ 
              background: '#fff', 
              padding: 16, 
              borderRadius: 12, 
              display: 'inline-block' 
            }}>
              <QRCodeSVG value={bunkerUri} size={200} />
            </div>
          </div>
          
          <div style={{ fontSize: 11, color: '#666', marginBottom: 8, wordBreak: 'break-all' }}>
            {bunkerUri}
          </div>
          
          <button 
            className="btn btn-secondary"
            onClick={() => navigator.clipboard.writeText(bunkerUri)}
          >
            Copy URI
          </button>
        </div>
        
        <div style={{ marginTop: 16, fontSize: 11, color: '#888', lineHeight: 1.6 }}>
          <p>• Your Nostr key is derived from NEAR MPC</p>
          <p>• Sign requests require FaceID approval</p>
          <p>• Connected apps appear in Sessions below</p>
        </div>
      </div>
    </div>
  )
}

export function NostrSessionsCard({ sessions, onRevoke }) {
  if (!sessions || sessions.length === 0) return null
  
  return (
    <div className="card">
      <div className="card-header">
        <div className="card-icon" style={{ background: 'linear-gradient(135deg, #22c55e, #16a34a)' }}>🔗</div>
        <div>
          <div className="card-title">Connected Apps</div>
          <div className="card-subtitle">Nostr sessions</div>
        </div>
      </div>
      {sessions.map((session, i) => (
        <div key={i} className="session-item">
          <div className="session-info">
            <div className="session-id">{session.name || 'Unknown App'}</div>
            <div className="session-pubkey">{session.pubkey?.slice(0, 24)}...</div>
          </div>
          <button 
            className="btn btn-danger" 
            style={{ fontSize: 11, padding: '6px 12px' }}
            onClick={() => onRevoke(session.pubkey)}
          >
            Revoke
          </button>
        </div>
      ))}
    </div>
  )
}

export function SignRequestModal({ request, onApprove, onDeny, loading }) {
  if (!request) return null
  
  const eventTypes = {
    0: 'Profile Update',
    1: 'Note',
    4: 'Direct Message',
    5: 'Delete',
    7: 'Reaction',
    42: 'Channel Message',
    30023: 'Long Form Content',
  }
  
  const typeName = eventTypes[request.kind] || `Kind ${request.kind}`
  
  return (
    <div className="modal-overlay">
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h3>🔐 Sign Request</h3>
        </div>
        
        <div style={{ padding: 16 }}>
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 12, color: '#888' }}>App</div>
            <div style={{ fontWeight: 600 }}>{request.client || 'Unknown'}</div>
          </div>
          
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 12, color: '#888' }}>Type</div>
            <div>{typeName}</div>
          </div>
          
          {request.content && (
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 12, color: '#888' }}>Content</div>
              <div style={{ 
                background: '#1a1a1f', 
                padding: 8, 
                borderRadius: 8, 
                fontSize: 12,
                wordBreak: 'break-all',
                maxHeight: 100,
                overflow: 'auto'
              }}>
                {request.content.slice(0, 200)}{request.content.length > 200 ? '...' : ''}
              </div>
            </div>
          )}
          
          <div className="row" style={{ marginTop: 24 }}>
            <button 
              className="btn btn-secondary" 
              onClick={onDeny}
              style={{ flex: 1 }}
              disabled={loading}
            >
              Deny
            </button>
            <button 
              className="btn btn-primary" 
              onClick={onApprove}
              style={{ flex: 1 }}
              disabled={loading}
            >
              {loading ? <><span className="spinner"></span> Signing...</> : 'Approve'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// Export bunker URI generator
export function createBunkerUri(npub, relays = NIP46_RELAYS) {
  const relayParams = relays.map(r => `relay=${encodeURIComponent(r)}`).join('&')
  return `bunker://${npub}?${relayParams}`
}

// Export relays for external use
export { NIP46_RELAYS }