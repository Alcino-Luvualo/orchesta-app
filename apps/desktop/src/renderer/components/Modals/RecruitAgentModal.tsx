import React, { useState } from 'react'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { X, Sparkles, Terminal } from 'lucide-react'

export const RecruitAgentModal: React.FC = () => {
  const { isRecruitModalOpen, setRecruitModalOpen, addNode } = useWorkspaceStore()
  const [provider, setProvider] = useState<'claude' | 'codex' | 'opencode'>('claude')
  const [role, setRole] = useState('Lead Developer')

  if (!isRecruitModalOpen) return null

  const handleRecruit = () => {
    const agentName = provider === 'claude' ? 'Claude Code' : provider === 'codex' ? 'Codex Agent' : 'OpenCode'
    const roleColor = role === 'Lead Developer' ? '#c8f169' : role === 'Frontend Architect' ? '#74a7f5' : '#f2c46d'

    addNode({
      id: `term_${Date.now()}`,
      kind: 'terminal',
      x: 300 + Math.random() * 100,
      y: 200 + Math.random() * 100,
      width: 480,
      height: 280,
      properties: {
        title: agentName,
        agent: agentName,
        role,
        roleColor,
        cwd: '~/dev/commerce',
        status: 'running'
      }
    })

    setRecruitModalOpen(false)
  }

  return (
    <div className="modal-layer" onClick={() => setRecruitModalOpen(false)}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <b>Recrutar Novo Agente para o Canvas</b>
          <button className="icon-btn" onClick={() => setRecruitModalOpen(false)}>
            <X className="icon" />
          </button>
        </div>

        <div className="modal-body">
          <label style={{ fontSize: 11, color: 'var(--dim)', display: 'block', marginBottom: 8 }}>Motor / Provider do Agente</label>
          <div className="provider-grid">
            <button className={`provider ${provider === 'claude' ? 'active' : ''}`} onClick={() => setProvider('claude')}>
              <Terminal className="icon" />
              <b>Claude Code</b>
            </button>
            <button className={`provider ${provider === 'codex' ? 'active' : ''}`} onClick={() => setProvider('codex')}>
              <Sparkles className="icon" />
              <b>Codex</b>
            </button>
            <button className={`provider ${provider === 'opencode' ? 'active' : ''}`} onClick={() => setProvider('opencode')}>
              <Sparkles className="icon" />
              <b>OpenCode</b>
            </button>
          </div>

          <div className="field" style={{ marginTop: 16 }}>
            <label>Atribuir Role</label>
            <select className="select" value={role} onChange={(e) => setRole(e.target.value)}>
              <option value="Lead Developer">Lead Developer (Coordenador)</option>
              <option value="Frontend Architect">Frontend Architect (UI/UX)</option>
              <option value="Backend & Core Engineer">Backend & Core Engineer (Core/Rust)</option>
              <option value="Code Reviewer">Code Reviewer (Testes/Audit)</option>
            </select>
          </div>
        </div>

        <div className="modal-foot">
          <button className="btn" onClick={() => setRecruitModalOpen(false)}>Cancelar</button>
          <button className="btn primary" onClick={handleRecruit}>Instanciar Agente no Canvas</button>
        </div>
      </div>
    </div>
  )
}
