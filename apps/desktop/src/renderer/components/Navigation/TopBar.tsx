import React from 'react'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { Sun, Moon, Plus, Layers, Sparkles, Terminal } from 'lucide-react'

export const TopBar: React.FC = () => {
  const {
    activeWorkspace,
    activeFloor,
    theme,
    toggleTheme,
    setRecruitModalOpen,
    setFloorModalOpen,
    setCommandPaletteOpen
  } = useWorkspaceStore()

  return (
    <header className="topbar">
      <div className="brand">
        <img src="/icon.png" className="logo" alt="Orchestra" style={{ width: '24px', height: '24px', borderRadius: '5px', objectFit: 'contain' }} />
      </div>

      <div className="workspace-head">
        <span className="workspace-title">{activeWorkspace?.name || 'Orchestra Workspace'}</span>
        
        {/* Floor Selector Dropdown */}
        <button className="floor" onClick={() => setFloorModalOpen(true)} title="Selecionar ou gerir Floors">
          <i />
          <span>{activeFloor?.name || 'Main Ground'}</span>
          <span style={{ opacity: 0.6, fontSize: '9px', fontFamily: 'var(--mono)' }}>
            ({activeFloor?.branch || 'main'})
          </span>
        </button>
      </div>

      <div className="top-spacer" />

      <button className="top-action" onClick={() => setRecruitModalOpen(true)}>
        <Plus className="icon" />
        <span>Recrutar Agente</span>
      </button>

      <button className="top-action" onClick={() => setCommandPaletteOpen(true)}>
        <Sparkles className="icon" />
        <span>Command Palette (Ctrl+K)</span>
      </button>

      <div className="active-badge" style={{ margin: '0 8px' }}>
        <Terminal className="icon" style={{ width: 11, height: 11, display: 'inline', marginRight: 4 }} />
        2 agentes ativos
      </div>

      <button className="top-action theme-toggle" onClick={toggleTheme} title="Alternar tema claro/escuro">
        {theme === 'dark' ? <Sun className="icon" /> : <Moon className="icon" />}
      </button>

      <div className="avatar" style={{ marginLeft: 8 }} title="Perfil Alcino Luvualo">
        AL
      </div>
    </header>
  )
}
