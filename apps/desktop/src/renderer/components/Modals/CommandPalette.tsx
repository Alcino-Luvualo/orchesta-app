import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { Search, Terminal, Plus, Layers } from 'lucide-react'
import { useModalA11y } from './modalUtils'

export const CommandPalette: React.FC = () => {
  const {
    isCommandPaletteOpen,
    setCommandPaletteOpen,
    setRecruitModalOpen,
    setFloorModalOpen,
    addNode
  } = useWorkspaceStore()
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const modalRef = useModalA11y({
    open: isCommandPaletteOpen,
    onClose: () => setCommandPaletteOpen(false),
    initialFocusRef: inputRef
  })

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setCommandPaletteOpen(!isCommandPaletteOpen)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isCommandPaletteOpen])

  useEffect(() => {
    if (!isCommandPaletteOpen) return
    // A palette is a fresh command surface on every opening. Persisting the
    // previous filter/index makes Enter unexpectedly execute another command
    // after Escape -> Ctrl/Cmd+K.
    setQuery('')
    setActiveIndex(0)
  }, [isCommandPaletteOpen])

  const commands = useMemo(() => [
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
  ], [addNode, setCommandPaletteOpen, setFloorModalOpen, setRecruitModalOpen])

  const filtered = useMemo(
    () => commands.filter((command) => command.label.toLowerCase().includes(query.trim().toLowerCase())),
    [commands, query]
  )

  useEffect(() => {
    setActiveIndex(0)
  }, [query])

  useEffect(() => {
    if (filtered.length > 0 && activeIndex >= filtered.length) setActiveIndex(filtered.length - 1)
  }, [activeIndex, filtered.length])

  if (!isCommandPaletteOpen) return null

  const runCommand = (index: number) => {
    const command = filtered[index]
    if (!command) return
    command.action()
  }

  const handleInputKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActiveIndex((index) => filtered.length ? (index + 1) % filtered.length : 0)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveIndex((index) => filtered.length ? (index - 1 + filtered.length) % filtered.length : 0)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      runCommand(activeIndex)
    }
  }

  return (
    <div className="modal-layer palette-layer" onMouseDown={(event) => { if (event.target === event.currentTarget) setCommandPaletteOpen(false) }}>
      <div
        ref={modalRef}
        className="modal palette"
        role="dialog"
        aria-modal="true"
        aria-labelledby="command-palette-title"
        aria-describedby="command-palette-hint"
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="palette-header">
          <span className="palette-search-icon" aria-hidden="true"><Search className="icon" /></span>
          <span id="command-palette-title" className="sr-only">Command palette</span>
          <input
            ref={inputRef}
            className="command-input"
            placeholder="Digita um comando ou pesquisa..."
            aria-label="Pesquisar comandos"
            aria-controls="command-palette-list"
            aria-activedescendant={filtered[activeIndex] ? `command-${filtered[activeIndex].id}` : undefined}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleInputKeyDown}
          />
          <kbd className="palette-escape-hint">Esc</kbd>
        </div>

        <div id="command-palette-hint" className="palette-hint">Navega com ↑ ↓ · Enter para executar</div>
        <div id="command-palette-list" className="command-list" role="listbox" aria-label="Comandos">
          {filtered.map((c, index) => {
            const IconComponent = c.icon
            return (
              <button
                key={c.id}
                id={`command-${c.id}`}
                type="button"
                role="option"
                aria-selected={activeIndex === index}
                className={`command-item ${activeIndex === index ? 'active' : ''}`}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => runCommand(index)}
              >
                <span className="command-item-icon" aria-hidden="true"><IconComponent className="icon" /></span>
                <span className="command-item-copy"><strong>{c.label}</strong><small>{c.category}</small></span>
                <span className="kbd" aria-hidden="true">↵</span>
              </button>
            )
          })}
          {filtered.length === 0 && <div className="command-empty" role="status">Nenhum comando encontrado</div>}
        </div>
      </div>
    </div>
  )
}
