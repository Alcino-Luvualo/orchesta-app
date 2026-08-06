import React, { useState } from 'react'
import { Handle, Position, NodeResizer } from '@xyflow/react'
import { ArrowLeft, ArrowRight, MoreVertical, RefreshCw, ShieldCheck, X, Search } from 'lucide-react'
import { useWorkspaceStore } from '../../store/workspaceStore'

export const BrowserNode: React.FC<{ id: string; data: any }> = ({ id, data }) => {
  const props = data.properties || {}
  const [address, setAddress] = useState(props.url || 'https://www.google.com')
  const [currentUrl, setCurrentUrl] = useState(props.url || 'https://www.google.com')
  const { updateNode, deleteNode, setSelectedNodeId } = useWorkspaceStore()

  const handleNavigate = (e?: React.FormEvent) => {
    if (e) e.preventDefault()
    let query = address.trim()
    if (!query) return
    if (!/^https?:\/\//i.test(query)) {
      if (query.includes('.') && !query.includes(' ')) {
        query = `https://${query}`
      } else {
        query = `https://www.google.com/search?q=${encodeURIComponent(query)}`
      }
    }
    setAddress(query)
    setCurrentUrl(query)
    updateNode(id, { properties: { ...props, url: query } })
  }

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
      <NodeResizer
        isVisible={data.selected}
        minWidth={300}
        minHeight={200}
        onResize={(_, params) => updateNode(id, { width: params.width, height: params.height })}
      />
      <Handle type="target" position={Position.Left} className="port left" />
      <Handle type="source" position={Position.Right} className="port right" />

      <div className="chrome-shell">
        <form className="chrome-toolbar" onSubmit={handleNavigate}>
          <span className="mac-dot red" /><span className="mac-dot yellow" /><span className="mac-dot green" />
          <span className="chrome-divider" />
          <button type="button" className="icon-btn chrome-nav" title="Voltar"><ArrowLeft className="icon" /></button>
          <button type="button" className="icon-btn chrome-nav" title="Avançar"><ArrowRight className="icon" /></button>
          <button type="button" className="icon-btn chrome-nav" title="Recarregar" onClick={() => setCurrentUrl(`${currentUrl}?t=${Date.now()}`)}><RefreshCw className="icon" /></button>
          <div className="chrome-address">
            <Search className="icon" />
            <input
              type="text"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder="Pesquisar no Google ou digitar URL..."
            />
          </div>
          <button type="button" className="icon-btn chrome-nav" title="Mais"><MoreVertical className="icon" /></button>
          <button type="button" className="icon-btn chrome-nav" onClick={(event) => { event.stopPropagation(); deleteNode(id) }} title="Fechar portal"><X className="icon" /></button>
        </form>

        <div className="chrome-content nodrag">
          {currentUrl.startsWith('http://localhost') ? (
            <div className="portal-page">
              <span className="portal-kicker">{currentUrl}</span>
              <h3>Welcome back</h3>
              <p>Portal Chromium isolado. O agente Tester pode navegar, preencher e inspecionar esta página.</p>
              <label>Email<input value="developer@orchestra.dev" readOnly /></label>
              <button>Continue</button>
            </div>
          ) : (
            <iframe
              src={currentUrl}
              className="chrome-iframe nodrag"
              title="Browser Preview"
              style={{ width: '100%', height: '100%', border: 0, background: '#fff' }}
            />
          )}
        </div>
      </div>
    </div>
  )
}
