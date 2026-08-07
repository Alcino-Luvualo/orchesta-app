import React, { useEffect, useState } from 'react'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { X, Sparkles, Terminal, CheckCircle, Circle, Cpu } from 'lucide-react'

interface DetectedTool {
  id: string
  name: string
  cmd: string
  description: string
  installed: boolean
  path?: string
}

export const RecruitAgentModal: React.FC = () => {
  const { isRecruitModalOpen, setRecruitModalOpen, addNode, pendingTerminalRect, setPendingTerminalRect } = useWorkspaceStore()
  const [tools, setTools] = useState<DetectedTool[]>([])
  const [selectedToolId, setSelectedToolId] = useState<string>('claude')
  const [customCmd, setCustomCmd] = useState('')
  const [role, setRole] = useState('Lead Developer')

  useEffect(() => {
    if (!isRecruitModalOpen) return
    let isMounted = true

    const loadDetectedTools = async () => {
      try {
        if ((window as any).orchestra?.detectTools) {
          const detected: DetectedTool[] = await (window as any).orchestra.detectTools()
          if (isMounted && Array.isArray(detected) && detected.length > 0) {
            setTools(detected)
            const firstInstalled = detected.find((t) => t.installed)
            if (firstInstalled) setSelectedToolId(firstInstalled.id)
          }
        }
      } catch (err) {
        console.error('Failed to detect installed tools:', err)
      }
    }

    loadDetectedTools()

    return () => {
      isMounted = false
    }
  }, [isRecruitModalOpen])

  if (!isRecruitModalOpen) return null

  const defaultTools: DetectedTool[] = [
    { id: 'claude', name: 'Claude Code', cmd: 'claude', description: 'Anthropic Agentic Coding CLI', installed: true },
    { id: 'agy', name: 'Antigravity CLI', cmd: 'agy', description: 'Google Antigravity Agent Runtime', installed: true },
    { id: 'codex', name: 'Codex CLI', cmd: 'codex', description: 'OpenAI Codex Terminal', installed: true },
    { id: 'opencode', name: 'OpenCode', cmd: 'opencode', description: 'Multi-Agent Engine', installed: false },
    { id: 'zsh', name: 'Zsh Shell', cmd: 'zsh', description: 'Standard System Terminal', installed: true },
    { id: 'bash', name: 'Bash Shell', cmd: 'bash', description: 'GNU Bash Shell', installed: true }
  ]

  const displayTools = tools.length > 0 ? tools : defaultTools
  const activeTool = displayTools.find((t) => t.id === selectedToolId) || displayTools[0]

  const handleRecruit = () => {
    const agentName = activeTool.id === 'custom' ? (customCmd || 'Custom Shell') : activeTool.name
    const commandToRun = activeTool.id === 'custom' ? customCmd : activeTool.cmd
    const roleColor = role === 'Lead Developer' ? '#c8f169' : role === 'Frontend Architect' ? '#74a7f5' : '#f2c46d'

    const nodeWidth = pendingTerminalRect ? Math.max(340, pendingTerminalRect.width) : 480
    const nodeHeight = pendingTerminalRect ? Math.max(220, pendingTerminalRect.height) : 280
    const nodeX = pendingTerminalRect ? pendingTerminalRect.x : 280 + Math.random() * 80
    const nodeY = pendingTerminalRect ? pendingTerminalRect.y : 180 + Math.random() * 80

    addNode({
      id: `term_${Date.now()}`,
      kind: 'terminal',
      x: nodeX,
      y: nodeY,
      width: nodeWidth,
      height: nodeHeight,
      properties: {
        title: agentName,
        agent: agentName,
        command: commandToRun,
        role,
        roleColor,
        cwd: '~/dev/project',
        status: 'running'
      }
    })

    setPendingTerminalRect(null)
    setRecruitModalOpen(false)
  }

  return (
    <div className="modal-layer" onClick={() => setRecruitModalOpen(false)}>
      <div className="modal" style={{ width: 560, maxWidth: '92vw' }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Cpu className="icon" style={{ color: 'var(--primary)' }} />
            <b>Novo Terminal / Agente de IA</b>
          </div>
          <button className="icon-btn" onClick={() => setRecruitModalOpen(false)}>
            <X className="icon" />
          </button>
        </div>

        <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div>
            <label style={{ fontSize: 11, color: 'var(--dim)', display: 'block', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Selecione o Agente / CLI Instalado no Sistema
            </label>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8 }}>
              {displayTools.map((tool) => (
                <button
                  key={tool.id}
                  className={`provider ${selectedToolId === tool.id ? 'active' : ''}`}
                  onClick={() => setSelectedToolId(tool.id)}
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'flex-start',
                    justifyContent: 'center',
                    padding: '10px 12px',
                    borderRadius: 8,
                    border: selectedToolId === tool.id ? '1px solid var(--primary)' : '1px solid rgba(255,255,255,0.08)',
                    background: selectedToolId === tool.id ? 'rgba(200, 241, 105, 0.08)' : 'rgba(255,255,255,0.02)',
                    textAlign: 'left',
                    cursor: 'pointer',
                    position: 'relative'
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', marginBottom: 4 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      {tool.id === 'claude' || tool.id === 'agy' ? <Sparkles size={14} style={{ color: 'var(--primary)' }} /> : <Terminal size={14} />}
                      <b style={{ fontSize: 13, color: '#f1f3f4' }}>{tool.name}</b>
                    </div>
                    {tool.installed ? (
                      <span style={{ fontSize: 9, background: 'rgba(0, 202, 78, 0.15)', color: '#00ca4e', border: '1px solid rgba(0, 202, 78, 0.3)', padding: '1px 6px', borderRadius: 4, display: 'flex', alignItems: 'center', gap: 3 }}>
                        <CheckCircle size={8} /> Instalado
                      </span>
                    ) : (
                      <span style={{ fontSize: 9, background: 'rgba(255,255,255,0.05)', color: 'var(--dim)', padding: '1px 6px', borderRadius: 4, display: 'flex', alignItems: 'center', gap: 3 }}>
                        <Circle size={8} /> Disponível
                      </span>
                    )}
                  </div>
                  <span style={{ fontSize: 10, color: 'var(--dim)' }}>{tool.description}</span>
                </button>
              ))}
            </div>
          </div>

          {selectedToolId === 'custom' && (
            <div className="field">
              <label>Comando Personalizado</label>
              <input
                className="input"
                placeholder="ex: npx @anthropic-ai/claude-code"
                value={customCmd}
                onChange={(e) => setCustomCmd(e.target.value)}
              />
            </div>
          )}

          <div className="field">
            <label>Atribuir Função / Role no Canvas</label>
            <select className="select" value={role} onChange={(e) => setRole(e.target.value)}>
              <option value="Lead Developer">Lead Developer (Coordenador de Tarefas)</option>
              <option value="Frontend Architect">Frontend Architect (Interface & Componentes)</option>
              <option value="Backend & Core Engineer">Backend & Core Engineer (Rust & Serviços)</option>
              <option value="Code Reviewer">Code Reviewer (Testes & Auditoria)</option>
            </select>
          </div>
        </div>

        <div className="modal-foot" style={{ marginTop: 20 }}>
          <button className="btn" onClick={() => setRecruitModalOpen(false)}>
            Cancelar
          </button>
          <button className="btn primary" onClick={handleRecruit}>
            Instanciar Agente no Canvas
          </button>
        </div>
      </div>
    </div>
  )
}
