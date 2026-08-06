import React, { useEffect, useMemo, useState } from 'react'
import { Send, Terminal, FileText, Check, X } from 'lucide-react'
import { useWorkspaceStore } from '../../store/workspaceStore'

export const PromptComposer: React.FC = () => {
  const [promptText, setPromptText] = useState('')
  const [sent, setSent] = useState(false)
  const [isOpen, setIsOpen] = useState(false)
  const { nodes, selectedNodeId } = useWorkspaceStore()
  const target = useMemo(() => {
    const selected = nodes.find((node) => node.id === selectedNodeId && node.kind === 'terminal')
    return selected || nodes.find((node) => node.kind === 'terminal') || null
  }, [nodes, selectedNodeId])

  const handleSend = () => {
    if (!promptText.trim()) return
    if (!target) return
    const message = `${promptText}\r`
    if (window.orchestra?.invoke) {
      window.orchestra.invoke('terminal.input', { sessionId: target.id, data: message }).catch(console.error)
    }
    setPromptText('')
    setSent(true)
    window.setTimeout(() => { setSent(false); setIsOpen(false) }, 650)
  }

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'p') {
        event.preventDefault()
        setIsOpen((open) => !open)
      }
      if (event.key === 'Escape') setIsOpen(false)
    }
    window.addEventListener('keydown', handleShortcut)
    return () => window.removeEventListener('keydown', handleShortcut)
  }, [])

  if (!isOpen) return null

  return (
    <div className="composer">
      <div className="composer-chips">
        <div className="chip" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <Terminal className="icon" style={{ width: 10, height: 10, color: 'var(--primary)' }} />
          {target?.properties.agent || 'Sem terminal selecionado'}
        </div>
        <button className="icon-btn composer-close" onClick={() => setIsOpen(false)} title="Fechar composer"><X className="icon" /></button>
        <div className="chip" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <FileText className="icon" style={{ width: 10, height: 10 }} />
          Especificação Auth
        </div>
      </div>

      <textarea
        placeholder="Instruir agentes no canvas... (ex: 'Implementar JWT refresh token e rever código')"
        value={promptText}
        onChange={(e) => setPromptText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            handleSend()
          }
        }}
      />

      <div className="composer-foot">
        <select className="select">
          <option value="all">Todos os Agentes</option>
          <option value="lead">Claude Code (Lead)</option>
          <option value="reviewer">Code Reviewer</option>
        </select>

        <button className="btn primary" onClick={handleSend} disabled={!target || !promptText.trim()}>
          {sent ? <Check className="icon" style={{ width: 12, height: 12 }} /> : <Send className="icon" style={{ width: 12, height: 12 }} />}
          {sent ? 'Enviado' : 'Enviar · Ctrl+Enter'}
        </button>
      </div>
    </div>
  )
}
