import React, { useEffect, useRef, useState } from 'react'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { FolderOpen, Pencil, Plus, Trash2, X } from 'lucide-react'
import { WorkspaceGlyph } from '../WorkspaceGlyph'

export const Sidebar: React.FC = () => {
  const { workspaces, activeWorkspace, currentScreen, setActiveWorkspace, setWorkspaceModalOpen, editWorkspace, removeWorkspace } = useWorkspaceStore()
  const [menuWorkspaceId, setMenuWorkspaceId] = useState<string | null>(null)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState('')
  const [menuPosition, setMenuPosition] = useState({ top: 54, left: 62 })
  const menuRef = useRef<HTMLDivElement>(null)
  const menuWorkspace = workspaces.find((workspace) => workspace.id === menuWorkspaceId) || null

  const closeMenu = () => {
    setMenuWorkspaceId(null)
    setConfirmingDelete(false)
    setDeleting(false)
    setError('')
  }

  useEffect(() => {
    if (!menuWorkspaceId) return
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null
      if (menuRef.current?.contains(target) || target?.closest('[data-workspace-menu-trigger]')) return
      closeMenu()
    }
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') closeMenu() }
    window.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [menuWorkspaceId])

  const toggleMenu = (workspaceId: string, button: HTMLButtonElement) => {
    if (menuWorkspaceId === workspaceId) { closeMenu(); return }
    const rect = button.getBoundingClientRect()
    setMenuPosition({ top: Math.max(48, Math.min(window.innerHeight - 220, rect.top)), left: rect.right + 8 })
    setMenuWorkspaceId(workspaceId)
    setConfirmingDelete(false)
    setDeleting(false)
    setError('')
  }

  return (
    <aside className="sidebar" aria-label="Workspaces">
      <button type="button" className="side-btn workspace-add-btn" onClick={() => setWorkspaceModalOpen(true)} aria-label="Criar workspace" title="Novo workspace"><Plus className="icon" /></button>
      <div className="workspace-rail" role="list">
        {workspaces.map((workspace) => {
          const active = currentScreen === 'canvas' && activeWorkspace?.id === workspace.id
          return <button
            key={workspace.id}
            type="button"
            role="listitem"
            className={`side-btn workspace-rail-btn ${active ? 'active' : ''}`}
            aria-label={`Abrir workspace ${workspace.name}`}
            aria-current={active ? 'page' : undefined}
            aria-haspopup="menu"
            aria-expanded={menuWorkspaceId === workspace.id}
            data-workspace-menu-trigger
            title={`${workspace.name}\n${workspace.path}`}
            onClick={(event) => toggleMenu(workspace.id, event.currentTarget)}
          >
            <WorkspaceGlyph icon={workspace.icon} color={workspace.color} className="workspace-rail-glyph" />
          </button>
        })}
      </div>
      {menuWorkspace && <div ref={menuRef} className="workspace-rail-menu" role="menu" aria-label={`Opções de ${menuWorkspace.name}`} style={menuPosition}>
        <header><WorkspaceGlyph icon={menuWorkspace.icon} color={menuWorkspace.color} /><span><b>{menuWorkspace.name}</b><small>{menuWorkspace.path}</small></span><button type="button" onClick={closeMenu} aria-label="Fechar menu"><X className="icon" /></button></header>
        {!confirmingDelete ? <div className="workspace-rail-menu-actions">
          <button type="button" role="menuitem" onClick={() => { setActiveWorkspace(menuWorkspace); closeMenu() }}><FolderOpen className="icon" />Abrir</button>
          <button type="button" role="menuitem" onClick={() => { editWorkspace(menuWorkspace); closeMenu() }}><Pencil className="icon" />Editar</button>
          <button type="button" role="menuitem" className="danger" onClick={() => setConfirmingDelete(true)}><Trash2 className="icon" />Eliminar</button>
        </div> : <div className="workspace-delete-confirm">
          <b>Eliminar este workspace?</b>
          <p>Remove-o da aplicação e apaga o canvas guardado. Os ficheiros da pasta não serão eliminados.</p>
          {error && <small role="alert">{error}</small>}
          <div><button type="button" disabled={deleting} onClick={() => setConfirmingDelete(false)}>Cancelar</button><button type="button" className="danger" disabled={deleting} onClick={async () => {
            setDeleting(true); setError('')
            try { await removeWorkspace(menuWorkspace.id); closeMenu() }
            catch (reason) { setDeleting(false); setError(reason instanceof Error ? reason.message : 'Não foi possível eliminar.') }
          }}>{deleting ? 'A eliminar…' : 'Eliminar'}</button></div>
        </div>}
      </div>}
    </aside>
  )
}
