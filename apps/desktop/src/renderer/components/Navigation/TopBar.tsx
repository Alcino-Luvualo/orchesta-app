import React from 'react'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { Sun, Moon, Search, Terminal, Minus, Square, X, Maximize, Settings } from 'lucide-react'

declare global {
  interface Window {
    windowControls?: {
      minimize: () => void
      maximize: () => void
      close: () => void
      isMaximized: () => Promise<boolean>
      toggleFullscreen: () => void
    }
  }
}

export const TopBar: React.FC = () => {
  const {
    activeWorkspace,
    theme,
    toggleTheme,
    setCommandPaletteOpen,
    setScreen
  } = useWorkspaceStore()

  return (
    <header className="topbar">
      <div className="brand">
        <img src="/icon.png" className="logo" alt="Orchestra" style={{ width: '24px', height: '24px', borderRadius: '5px', objectFit: 'contain' }} />
      </div>

      <div className="workspace-head"><span className="workspace-title">{activeWorkspace?.name || 'Workspace 1'}</span></div>

      <div className="top-spacer" />

      <button className="top-action icon-only" onClick={() => setCommandPaletteOpen(true)} title="Pesquisar · Ctrl + K"><Search className="icon" /></button>

      <div className="active-badge compact" title="2 agentes ativos">
        <Terminal className="icon" /> <span>2</span>
      </div>

      <button className="top-action theme-toggle" onClick={toggleTheme} title="Alternar tema claro/escuro">
        {theme === 'dark' ? <Sun className="icon" /> : <Moon className="icon" />}
      </button>

      <button className="top-action icon-only" onClick={() => setScreen('settings')} title="Definições"><Settings className="icon" /></button>

      {/* Window controls for frameless window on Linux */}
      {window.windowControls && (
        <div className="window-controls no-drag">
          <button
            className="window-btn"
            onClick={() => window.windowControls?.minimize()}
            title="Minimizar"
          >
            <Minus style={{ width: 14, height: 14 }} />
          </button>
          <button
            className="window-btn"
            onClick={() => window.windowControls?.maximize()}
            title="Maximizar"
          >
            <Square style={{ width: 12, height: 12 }} />
          </button>
          <button
            className="window-btn"
            onClick={() => window.windowControls?.toggleFullscreen()}
            title="Tela Cheia (F11)"
          >
            <Maximize style={{ width: 12, height: 12 }} />
          </button>
          <button
            className="window-btn window-btn-close"
            onClick={() => window.windowControls?.close()}
            title="Fechar"
          >
            <X style={{ width: 14, height: 14 }} />
          </button>
        </div>
      )}
    </header>
  )
}
