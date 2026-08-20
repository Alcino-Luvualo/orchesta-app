import React, { useEffect, useRef, useState } from 'react'
import { FolderOpen, Palette, Plus, X } from 'lucide-react'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { WORKSPACE_COLORS, WORKSPACE_ICONS } from '../WorkspaceGlyph'
import { useModalA11y } from './modalUtils'

export const WorkspaceCreateModal: React.FC = () => {
  const { isWorkspaceModalOpen, editingWorkspace, setWorkspaceModalOpen, createWorkspace, updateWorkspace } = useWorkspaceStore()
  const [name, setName] = useState('')
  const [directory, setDirectory] = useState('')
  const [icon, setIcon] = useState('folder-kanban')
  const [color, setColor] = useState(WORKSPACE_COLORS[0])
  const [nameEdited, setNameEdited] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const nameInputRef = useRef<HTMLInputElement>(null)
  const modalRef = useModalA11y({ open: isWorkspaceModalOpen, onClose: () => setWorkspaceModalOpen(false), initialFocusRef: nameInputRef })
  const canCreate = Boolean(name.trim() && directory.trim() && !submitting)

  useEffect(() => {
    if (!isWorkspaceModalOpen) return
    setName(editingWorkspace?.name || '')
    setDirectory(editingWorkspace?.path || '')
    setIcon(editingWorkspace?.icon || 'folder-kanban')
    setColor(editingWorkspace?.color || WORKSPACE_COLORS[0])
    setNameEdited(Boolean(editingWorkspace))
    setSubmitting(false)
    setError('')
  }, [editingWorkspace, isWorkspaceModalOpen])

  const chooseDirectory = async () => {
    const selected = await window.orchestra?.chooseWorkspace?.()
    if (!selected) return
    setDirectory(selected)
    if (!nameEdited) setName(selected.split('/').filter(Boolean).pop() || 'Workspace')
  }

  const submit = async () => {
    if (!canCreate) return
    setSubmitting(true)
    setError('')
    try {
      if (editingWorkspace) {
        await updateWorkspace({ ...editingWorkspace, name: name.trim(), path: directory.trim(), icon, color })
      } else {
        const created = await createWorkspace(name, directory, { icon, color })
        if (!created) throw new Error('Seleciona um nome e um diretório válidos.')
      }
      setWorkspaceModalOpen(false)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Não foi possível criar o workspace.')
      setSubmitting(false)
    }
  }

  if (!isWorkspaceModalOpen) return null

  return <div className="modal-layer workspace-create-layer" onMouseDown={(event) => { if (event.target === event.currentTarget && !submitting) setWorkspaceModalOpen(false) }}>
    <div ref={modalRef} className="workspace-create-modal" role="dialog" aria-modal="true" aria-labelledby="workspace-create-title" aria-describedby="workspace-create-description" tabIndex={-1} onMouseDown={(event) => event.stopPropagation()}>
      <header className="workspace-create-head">
        <div><h2 id="workspace-create-title">{editingWorkspace ? 'Editar Workspace' : 'Novo Workspace'}</h2><p id="workspace-create-description">{editingWorkspace ? 'Atualiza a aparência e o diretório.' : 'Configura o teu espaço de trabalho.'}</p></div>
        <button type="button" className="icon-btn" aria-label="Fechar criação de workspace" disabled={submitting} onClick={() => setWorkspaceModalOpen(false)}><X className="icon" /></button>
      </header>

      <form className="workspace-create-form" onSubmit={(event) => { event.preventDefault(); void submit() }}>
        <label className="workspace-create-field">
          <span>Nome</span>
          <input ref={nameInputRef} autoFocus value={name} maxLength={120} placeholder="Nome do workspace" required onChange={(event) => { setName(event.target.value); setNameEdited(true) }} />
        </label>

        <fieldset className="workspace-create-section">
          <legend>Ícone</legend>
          <div className="workspace-icon-grid" role="radiogroup" aria-label="Ícone do workspace">
            {WORKSPACE_ICONS.map((item) => <button key={item.id} type="button" role="radio" aria-label={item.label} aria-checked={icon === item.id} className={icon === item.id ? 'selected' : ''} onClick={() => setIcon(item.id)}><item.icon className="icon" /></button>)}
          </div>
        </fieldset>

        <fieldset className="workspace-create-section">
          <legend>Cor</legend>
          <div className="workspace-color-row" role="radiogroup" aria-label="Cor do workspace">
            {WORKSPACE_COLORS.map((item) => <button key={item} type="button" role="radio" aria-label={item} aria-checked={color === item} className={color === item ? 'selected' : ''} style={{ background: item }} onClick={() => setColor(item)} />)}
            <label className="workspace-custom-color" aria-label="Cor personalizada" title="Cor personalizada"><Palette className="icon" /><input type="color" value={color} onChange={(event) => setColor(event.target.value)} /></label>
          </div>
        </fieldset>

        <label className="workspace-create-field">
          <span>Diretório</span>
          <span className="workspace-directory-control">
            <input value={directory} placeholder="Seleciona uma pasta…" required onChange={(event) => setDirectory(event.target.value)} />
            <button type="button" onClick={() => void chooseDirectory()}><FolderOpen className="icon" />Procurar</button>
          </span>
        </label>

        {error && <div className="workspace-create-error" role="alert">{error}</div>}

        <footer className="workspace-create-foot">
          <button type="button" className="terminal-create-cancel" disabled={submitting} onClick={() => setWorkspaceModalOpen(false)}>Cancelar</button>
          <button type="submit" className="terminal-create-submit" disabled={!canCreate}><Plus className="icon" />{submitting ? 'A guardar…' : editingWorkspace ? 'Guardar alterações' : 'Criar workspace'}</button>
        </footer>
      </form>
    </div>
  </div>
}
