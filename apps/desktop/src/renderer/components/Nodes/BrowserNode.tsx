import React, { useState } from 'react'
import { Handle, Position } from '@xyflow/react'
import { ArrowLeft, ArrowRight, MoreVertical, RefreshCw, ShieldCheck, X } from 'lucide-react'
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
        width: '100%',
        height: '100%',
        minWidth: 300,
        minHeight: 200
      }}
      onClick={() => setSelectedNodeId(id)}
    >
      <Handle type="target" position={Position.Left} className="port left" />
      <Handle type="source" position={Position.Right} className="port right" />

      <div className="chrome-shell">
        <div className="chrome-toolbar">
          <span className="mac-dot red" /><span className="mac-dot yellow" /><span className="mac-dot green" />
          <span className="chrome-divider" />
          <button className="icon-btn chrome-nav" title="Voltar"><ArrowLeft className="icon" /></button>
          <button className="icon-btn chrome-nav" title="Avançar"><ArrowRight className="icon" /></button>
          <button className="icon-btn chrome-nav" title="Recarregar"><RefreshCw className="icon" /></button>
          <div className="chrome-address">
            <ShieldCheck className="icon" />
            <input
              type="text"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
          </div>
          <button className="icon-btn chrome-nav" title="Mais"><MoreVertical className="icon" /></button>
          <button className="icon-btn chrome-nav" onClick={(event) => { event.stopPropagation(); deleteNode(id) }} title="Fechar portal"><X className="icon" /></button>
        </div>

        <div className="chrome-content">
          <div className="portal-page">
            <span className="portal-kicker">localhost:3000</span>
            <h3>Welcome back</h3>
            <p>Portal Chromium isolado. O agente Tester pode navegar, preencher e inspecionar esta página.</p>
            <label>Email<input value="developer@orchestra.dev" readOnly /></label>
            <button>Continue</button>
          </div>
        </div>
      </div>
    </div>
  )
}
