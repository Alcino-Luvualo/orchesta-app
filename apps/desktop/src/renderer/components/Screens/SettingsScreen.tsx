import React, { useState } from 'react'
import { Settings, Shield, Terminal, Plus, Edit2, Trash2 } from 'lucide-react'

export const SettingsScreen: React.FC = () => {
  const [activeTab, setActiveTab] = useState<'general' | 'roles'>('roles')
  const [roles, setRoles] = useState([
    {
      id: 'role_lead',
      name: 'Lead Developer',
      description: 'Coordenador técnico de projeto e decisões de arquitetura',
      color: '#c8f169',
      instructions: 'És o desenvolvedor principal da equipa. Analisa o contexto e toma decisões de arquitetura.',
      permissions: ['read', 'write', 'execute', 'git']
    },
    {
      id: 'role_frontend',
      name: 'Frontend Architect',
      description: 'Especialista em React, CSS e UX',
      color: '#74a7f5',
      instructions: 'És o especialista de frontend. Garante fidelidade visual e UX excelente.',
      permissions: ['read', 'write']
    },
    {
      id: 'role_reviewer',
      name: 'Code Reviewer',
      description: 'Garante qualidade de código, testes e padrões',
      color: '#f2c46d',
      instructions: 'Revê o código minuciosamente e aponta melhorias e testes em falta.',
      permissions: ['read']
    }
  ])
  const [editingRoleId, setEditingRoleId] = useState<string | null>(null)

  const createRole = () => {
    const id = `role_${Date.now()}`
    setRoles((current) => [...current, { id, name: 'New Role', description: 'Descrição do papel do agente', color: '#a989f5', instructions: 'Define as instruções deste agente.', permissions: ['read'] }])
    setEditingRoleId(id)
  }

  return (
    <div className="panel-screen">
      <div className="page-head">
        <div>
          <h1>Configurações & Roles Library</h1>
          <p>Gere as preferências globais da aplicação e a biblioteca de papéis dos agentes.</p>
        </div>
      </div>

      <div className="settings-layout">
        <div className="settings-nav">
          <button className={activeTab === 'roles' ? 'active' : ''} onClick={() => setActiveTab('roles')}>
            <Shield className="icon" /> Roles Library
          </button>
          <button className={activeTab === 'general' ? 'active' : ''} onClick={() => setActiveTab('general')}>
            <Settings className="icon" /> Geral & XDG Paths
          </button>
        </div>

        <div>
          {activeTab === 'roles' && (
            <div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
                <h3>Biblioteca de Roles de Agentes</h3>
                <button className="btn primary" style={{ height: 28, fontSize: 9 }} onClick={createRole}>
                  <Plus className="icon" style={{ width: 12, height: 12 }} /> Criar Role
                </button>
              </div>

              <div style={{ display: 'grid', gap: 12 }}>
                {roles.map((r) => (
                  <div key={r.id} style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 10, padding: 14 }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ width: 12, height: 12, borderRadius: '50%', background: r.color }} />
                        <b style={{ fontSize: 13 }}>{r.name}</b>
                      </div>
                      <div>
                        <button className="icon-btn" onClick={() => setEditingRoleId(editingRoleId === r.id ? null : r.id)} title="Editar role"><Edit2 className="icon" /></button>
                      </div>
                    </div>

                    <p style={{ fontSize: 10, color: 'var(--dim)', margin: '6px 0 10px' }}>{r.description}</p>
                    <div style={{ background: 'var(--panel2)', padding: 8, borderRadius: 6, font: '9px var(--mono)', color: 'var(--muted)' }}>
                      "{r.instructions}"
                    </div>

                    <div style={{ display: 'flex', gap: 4, marginTop: 8 }}>
                      {r.permissions.map((p) => (
                        <span key={p} style={{ fontSize: 8, background: 'var(--primary-muted)', color: 'var(--primary)', padding: '2px 6px', borderRadius: 4 }}>
                          {p}
                        </span>
                      ))}
                    </div>
                    {editingRoleId === r.id && <div className="role-editor">
                      <input value={r.name} onChange={(event) => setRoles((current) => current.map((role) => role.id === r.id ? { ...role, name: event.target.value } : role))} aria-label="Nome da role" />
                      <textarea value={r.instructions} onChange={(event) => setRoles((current) => current.map((role) => role.id === r.id ? { ...role, instructions: event.target.value } : role))} aria-label="Instruções da role" />
                      <button className="btn primary" onClick={() => setEditingRoleId(null)}>Guardar role</button>
                    </div>}
                  </div>
                ))}
              </div>
            </div>
          )}

          {activeTab === 'general' && (
            <div>
              <h3>Diretórios XDG Linux</h3>
              <div style={{ font: '10px var(--mono)', color: 'var(--muted)', background: 'var(--panel)', padding: 14, borderRadius: 8 }}>
                <div>Config: ~/.config/orchestra/settings.json</div>
                <div style={{ marginTop: 6 }}>Data: ~/.local/share/orchestra/orchestra.db</div>
                <div style={{ marginTop: 6 }}>Socket: $XDG_RUNTIME_DIR/orchestra/orchestra.sock</div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
