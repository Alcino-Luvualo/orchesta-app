import React, { useState } from 'react'
import { Send, Paperclip, Sparkles, Terminal, FileText } from 'lucide-react'

export const PromptComposer: React.FC = () => {
  const [promptText, setPromptText] = useState('')

  const handleSend = () => {
    if (!promptText.trim()) return
    if (window.orchestra?.invoke) {
      window.orchestra.invoke('agent.message.send', {
        agent: 'Claude Code',
        message: promptText
      })
    }
    alert(`Prompt enviado para os Agentes do Canvas: "${promptText}"`)
    setPromptText('')
  }

  return (
    <div className="composer">
      <div className="composer-chips">
        <div className="chip" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <Terminal className="icon" style={{ width: 10, height: 10, color: 'var(--primary)' }} />
          Claude Code (Lead)
        </div>
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

        <button className="btn primary" onClick={handleSend}>
          <Send className="icon" style={{ width: 12, height: 12 }} /> Enviar Prompt (Ctrl+Enter)
        </button>
      </div>
    </div>
  )
}
