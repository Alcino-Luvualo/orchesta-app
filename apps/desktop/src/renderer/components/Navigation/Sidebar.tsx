import React from 'react'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { LayoutGrid, Grid3X3, Clock, Cpu, Settings } from 'lucide-react'

export const Sidebar: React.FC = () => {
  const { currentScreen, setScreen } = useWorkspaceStore()

  return (
    <aside className="sidebar">
      <button
        className={`side-btn ${currentScreen === 'canvas' ? 'active' : ''}`}
        onClick={() => setScreen('canvas')}
        title="Canvas Interativo"
      >
        <Grid3X3 className="icon" />
        <small />
      </button>

      <button
        className={`side-btn ${currentScreen === 'home' ? 'active' : ''}`}
        onClick={() => setScreen('home')}
        title="Workspaces & Projetos"
      >
        <LayoutGrid className="icon" />
      </button>

      <button
        className={`side-btn ${currentScreen === 'routines' ? 'active' : ''}`}
        onClick={() => setScreen('routines')}
        title="Routines & Automações"
      >
        <Clock className="icon" />
      </button>

      <button
        className={`side-btn ${currentScreen === 'environments' ? 'active' : ''}`}
        onClick={() => setScreen('environments')}
        title="Ambientes (Docker/SSH/Local)"
      >
        <Cpu className="icon" />
      </button>

      <div className="side-spacer" />

      <div className="side-divider" />

      <button
        className={`side-btn ${currentScreen === 'settings' ? 'active' : ''}`}
        onClick={() => setScreen('settings')}
        title="Configurações & Roles"
      >
        <Settings className="icon" />
      </button>
    </aside>
  )
}
