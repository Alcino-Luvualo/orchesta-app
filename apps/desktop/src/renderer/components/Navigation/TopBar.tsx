import React from 'react'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { Sun, Moon, Terminal, Minus, Square, X } from 'lucide-react'

declare global {
  interface Window {
    windowControls?: {
      minimize: () => void
      maximize: () => void
      close: () => void
      isMaximized: () => Promise<boolean>
    }
  }
}

export const TopBar: React.FC = () => {
  const {
    activeWorkspace,
    nodes,
    theme,
      toggleTheme
  } = useWorkspaceStore()

  return (
    <header className="topbar">
      <div className="brand">
        <img src="./icon.png" className="logo" alt="Orchestra" style={{ width: '24px', height: '24px', borderRadius: '5px', objectFit: 'contain' }} onError={(e) => { (e.currentTarget as HTMLImageElement).src = 'icon.png' }} />
      </div>

      <div className="workspace-head"><span className="workspace-title">{activeWorkspace?.name || 'Workspace 1'}</span></div>

      <div className="top-spacer" />

      <div className="active-badge compact" title={`${nodes.filter((node) => node.kind === 'terminal').length} agentes no canvas`}>
        <Terminal className="icon" /> <span>{nodes.filter((node) => node.kind === 'terminal').length}</span>
      </div>

      <button className="top-action theme-toggle" onClick={toggleTheme} title="Alternar tema claro/escuro">
        {theme === 'dark' ? <Sun className="icon" /> : <Moon className="icon" />}
      </button>

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
