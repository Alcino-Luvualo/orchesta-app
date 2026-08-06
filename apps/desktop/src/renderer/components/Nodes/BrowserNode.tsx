import React, { useState } from 'react'
import { Handle, Position } from '@xyflow/react'
import { Globe, RefreshCw, Lock, X } from 'lucide-react'
import { useWorkspaceStore } from '../../store/workspaceStore'

export const BrowserNode: React.FC<{ id: string; data: any }> = ({ id, data }) => {
  const props = data.properties || {}
  const [url, setUrl] = useState(props.url || 'http://localhost:3000')
  const { deleteNode, setSelectedNodeId } = useWorkspaceStore()

  return (
    <div
      className="node"
      data-kind="browser"
      style={{
        width: data.width || 400,
        height: data.height || 280,
        minWidth: 300,
        minHeight: 200
      }}
      onClick={() => setSelectedNodeId(id)}
    >
      <Handle type="target" position={Position.Left} className="port left" />
      <Handle type="source" position={Position.Right} className="port right" />

      {/* Chrome address bar header */}
      <div className="chrome-shell">
        <div className="chrome-toolbar">
          <div className="mac-dot red" style={{ width: 8, height: 8, borderRadius: '50%', background: '#ff5f57' }} />
          <div className="mac-dot yellow" style={{ width: 8, height: 8, borderRadius: '50%', background: '#febc2e' }} />
          <div className="mac-dot green" style={{ width: 8, height: 8, borderRadius: '50%', background: '#28c840' }} />
          
          <button className="icon-btn" style={{ marginLeft: 6 }}>
            <RefreshCw className="icon" style={{ width: 12, height: 12 }} />
          </button>

          <div className="chrome-address">
            <Lock className="icon" style={{ width: 10, height: 10, marginRight: 5, color: 'var(--success)' }} />
            <input
              type="text"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              style={{ border: 0, background: 'transparent', outline: 0, width: '100%', font: 'inherit', color: 'inherit' }}
            />
          </div>

          <button className="icon-btn" onClick={() => deleteNode(id)}>
            <X className="icon" />
          </button>
        </div>

        {/* Embedded Browser Web Content Surface */}
        <div className="chrome-content" style={{ height: 'calc(100% - 34px)', padding: 14, overflow: 'auto' }}>
          <div className="web-card" style={{ padding: 12, background: 'var(--panel2)', borderRadius: 8, textAlign: 'center' }}>
            <b style={{ fontSize: 11, display: 'block' }}>Orchestra Portal Preview</b>
            <p style={{ fontSize: 9, color: 'var(--dim)', margin: '6px 0 10px' }}>
              Sessão Chromium isolada. Controlada por agentes via CDP.
            </p>
            <div style={{ height: 28, background: 'var(--primary)', color: '#111', borderRadius: 6, display: 'grid', placeItems: 'center', fontWeight: 600, fontSize: 10 }}>
              App React Localhost Vivo
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
