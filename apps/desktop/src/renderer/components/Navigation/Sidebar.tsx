import React from 'react'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { Grid3X3, Plus } from 'lucide-react'

export const Sidebar: React.FC = () => {
  const { currentScreen, setScreen, createWorkspace } = useWorkspaceStore()

  return (
    <aside className="sidebar">
      <button className={`side-btn ${currentScreen === 'canvas' ? 'active' : ''}`} onClick={() => setScreen('canvas')} title="Workspaces">
        <Grid3X3 className="icon" />
      </button>
      <button className="side-btn" onClick={() => createWorkspace()} title="Novo workspace"><Plus className="icon" /></button>
    </aside>
  )
}
