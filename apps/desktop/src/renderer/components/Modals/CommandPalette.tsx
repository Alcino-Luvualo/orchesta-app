import React, { useEffect, useState } from 'react'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { Search, Terminal, Plus, Layers, Settings, Sparkles } from 'lucide-react'

export const CommandPalette: React.FC = () => {
  const {
    isCommandPaletteOpen,
    setCommandPaletteOpen,
    setRecruitModalOpen,
    setFloorModalOpen,
    setScreen,
    addNode
  } = useWorkspaceStore()
  const [query, setQuery] = useState('')

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setCommandPaletteOpen(!isCommandPaletteOpen)
      }
      if (e.key === 'Escape' && isCommandPaletteOpen) {
        setCommandPaletteOpen(false)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isCommandPaletteOpen])

  if (!isCommandPaletteOpen) return null

  const commands = [
    {
      id: 'recruit',
      label: 'Recrutar Agente (Claude / Codex)',
      category: 'Agentes',
      icon: Terminal,
      action: () => {
        setCommandPaletteOpen(false)
        setRecruitModalOpen(true)
      }
    },
    {
      id: 'floor',
      label: 'Alternar / Criar Floor',
      category: 'Worktrees',
      icon: Layers,
      action: () => {
        setCommandPaletteOpen(false)
        setFloorModalOpen(true)
      }
    },
    {
      id: 'add_note',
      label: 'Criar Sticky Note',
      category: 'Canvas',
      icon: Plus,
      action: () => {
        setCommandPaletteOpen(false)
        addNode({
          id: `note_${Date.now()}`,
          kind: 'note',
          x: 400,
          y: 200,
          width: 320,
          height: 240,
          properties: { title: 'Nova Nota', content: '# Nota em Markdown\n\n- [ ] Tarefa' }
        })
      }
    },
    {
      id: 'settings',
      label: 'Abrir Roles Library',
      category: 'Configurações',
      icon: Settings,
      action: () => {
        setCommandPaletteOpen(false)
        setScreen('settings')
      }
    }
  ]

  const filtered = commands.filter((c) => c.label.toLowerCase().includes(query.toLowerCase()))

  return (
    <div className="modal-layer" onClick={() => setCommandPaletteOpen(false)}>
      <div className="modal palette" onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', padding: '0 14px', borderBottom: '1px solid var(--line)' }}>
          <Search className="icon" style={{ color: 'var(--dim)', marginRight: 10 }} />
          <input
            className="command-input"
            placeholder="Digita um comando ou pesquisa..."
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>

        <div className="command-list">
          {filtered.map((c) => {
            const IconComponent = c.icon
            return (
              <div key={c.id} className="command-item" onClick={c.action}>
                <IconComponent className="icon" style={{ color: 'var(--primary)' }} />
                <span>{c.label}</span>
                <span className="kbd">{c.category}</span>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
