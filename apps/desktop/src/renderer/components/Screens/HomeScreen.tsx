import React from 'react'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { Plus, Folder, Layers, Sparkles, Clock, CheckCircle } from 'lucide-react'

export const HomeScreen: React.FC = () => {
  const { workspaces, setActiveWorkspace, setScreen } = useWorkspaceStore()

  return (
    <div className="panel-screen">
      <div className="page-head">
        <div>
          <h1>Workspaces & Projetos</h1>
          <p>Gere os teus ambientes de trabalho, Partituras e projetos ativos.</p>
        </div>
        <button className="btn primary" onClick={() => alert('Criar novo Workspace')}>
          <Plus className="icon" /> Novo Workspace
        </button>
      </div>

      <div className="home-grid">
        <div>
          <div className="section-title">Workspaces Recentes</div>
          <div className="recent">
            {workspaces.map((ws) => (
              <div
                key={ws.id}
                className="workspace-card"
                onClick={() => {
                  setActiveWorkspace(ws)
                  setScreen('canvas')
                }}
              >
                <div className="workspace-icon">
                  <Folder className="icon" />
                </div>
                <div>
                  <b>{ws.name}</b>
                  <p>{ws.path}</p>
                </div>
                <button className="btn" style={{ height: 28, fontSize: 9 }}>Abrir Canvas</button>
              </div>
            ))}
          </div>

          <div className="section-title" style={{ marginTop: 28 }}>Partituras (Templates Reutilizáveis)</div>
          <div className="templates">
            <div className="template" style={{ cursor: 'pointer' }} onClick={() => setScreen('canvas')}>
              <b style={{ color: 'var(--primary)', display: 'block', marginBottom: 4 }}>Fullstack Dev Stack</b>
              <p>Terminal Lead + Frontend + Files + Browser Portal local.</p>
            </div>
            <div className="template" style={{ cursor: 'pointer' }} onClick={() => setScreen('canvas')}>
              <b style={{ color: 'var(--info)', display: 'block', marginBottom: 4 }}>Code Review & Audit</b>
              <p>Terminal Reviewer + Sticky Notes + Git Diff visualizer.</p>
            </div>
          </div>
        </div>

        <aside>
          <div className="section-title">Atividade Recente dos Agentes</div>
          <div className="activity">
            <div className="activity-row">
              <i />
              <div>
                <b>Claude Code</b>
                <span>Finalizou refatoração do módulo auth</span>
              </div>
            </div>
            <div className="activity-row">
              <i />
              <div>
                <b>Code Reviewer</b>
                <span>Aprovou 3 commits na branch main</span>
              </div>
            </div>
          </div>
        </aside>
      </div>
    </div>
  )
}
