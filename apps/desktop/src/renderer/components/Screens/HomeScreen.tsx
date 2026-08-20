import React from 'react'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { Plus } from 'lucide-react'
import { WorkspaceGlyph } from '../WorkspaceGlyph'

export const HomeScreen: React.FC = () => {
  const { workspaces, setActiveWorkspace, setWorkspaceModalOpen } = useWorkspaceStore()

  return (
    <div className="panel-screen">
      <div className="page-head">
        <div>
          <h1>Workspaces</h1>
          <p>Abre um projeto recente ou cria um espaço novo.</p>
        </div>
        <button className="btn primary" onClick={() => setWorkspaceModalOpen(true)}>
          <Plus className="icon" /> Novo Workspace
        </button>
      </div>

      <div className="home-grid">
        <div>
          <div className="section-title">Workspaces Recentes</div>
          <div className="recent">
            {workspaces.length === 0 && <div className="empty-state">Ainda não existem workspaces guardados.</div>}
            {workspaces.map((ws) => (
              <div
                key={ws.id}
                className="workspace-card"
                onClick={() => {
                  setActiveWorkspace(ws)
                }}
              >
                <WorkspaceGlyph icon={ws.icon} color={ws.color} className="workspace-icon" />
                <div>
                  <b>{ws.name}</b>
                  <p>{ws.path}</p>
                </div>
                <button className="btn" style={{ height: 28, fontSize: 9 }}>Abrir Canvas</button>
              </div>
            ))}
          </div>

          <div className="section-title" style={{ marginTop: 28 }}>Dica</div>
          <div className="template"><p>Escolhe um diretório real para começar. O canvas e as sessões são guardados por workspace.</p></div>
        </div>

        <aside>
          <div className="section-title">Atividade Recente dos Agentes</div>
          <div className="activity"><div className="empty-state">A atividade aparece quando existirem sessões e pedidos reais.</div></div>
        </aside>
      </div>
    </div>
  )
}
