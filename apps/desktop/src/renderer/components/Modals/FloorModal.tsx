import React, { useEffect, useRef, useState } from 'react'
import { useWorkspaceStore, Floor } from '../../store/workspaceStore'
import { X, Layers, Plus, GitBranch, Check, Trash2 } from 'lucide-react'
import { useModalA11y } from './modalUtils'

export const FloorModal: React.FC = () => {
  const { isFloorModalOpen, setFloorModalOpen, floors, activeFloor, setActiveFloor, setFloors, activeWorkspace } = useWorkspaceStore()
  const [newFloorName, setNewFloorName] = useState('')
  const [newBranchName, setNewBranchName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [removingFloorId, setRemovingFloorId] = useState<string | null>(null)
  const [deletingFloorId, setDeletingFloorId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const newFloorNameRef = useRef<HTMLInputElement>(null)
  const modalRef = useModalA11y({
    open: isFloorModalOpen,
    onClose: () => setFloorModalOpen(false),
    initialFocusRef: newFloorNameRef
  })

  useEffect(() => {
    if (!isFloorModalOpen) return
    // Do not carry a half-confirmed destructive action or an old transport
    // error into the next time the dialog is opened.
    setError(null)
    setRemovingFloorId(null)
    setDeletingFloorId(null)
  }, [isFloorModalOpen])

  if (!isFloorModalOpen) return null

  const handleCreateFloor = async () => {
    const floorName = newFloorName.trim()
    if (!floorName || creating) return
    const branch = newBranchName.trim() || `feature/${floorName.toLowerCase().replace(/\s+/g, '-')}`
    if (!activeWorkspace) {
      setError('Abre um workspace antes de criares um floor.')
      return
    }
    const invoke = window.orchestra?.invoke
    if (!invoke) {
      setError('Core indisponível. Inicia o daemon para criares um floor.')
      return
    }
    setCreating(true)
    setError(null)
    try {
      const result = await invoke('git.create_floor', {
        workspaceId: activeWorkspace.id,
        workspaceRoot: activeWorkspace.path,
        path: '.',
        name: floorName,
        branch
      })
      const worktreeDir = result && typeof result === 'object' && typeof (result as { worktreeDir?: unknown }).worktreeDir === 'string'
        ? (result as { worktreeDir: string }).worktreeDir
        : ''
      if (!worktreeDir) throw new Error('Core não devolveu o worktree criado')
      const newFloor: Floor = {
        id: `fl_${crypto.randomUUID()}`,
        workspaceId: activeWorkspace.id,
        name: floorName,
        branch,
        path: worktreeDir
      }
      const saved = await invoke('workspace.floor.save', { workspaceId: activeWorkspace.id, floor: newFloor })
      if (!saved || typeof saved !== 'object' || (saved as { success?: unknown }).success !== true) {
        throw new Error('Core não confirmou o floor criado')
      }
      setFloors([...floors, newFloor])
      setActiveFloor(newFloor)
      setNewFloorName('')
      setNewBranchName('')
      setFloorModalOpen(false)
      setError(null)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Não foi possível criar o floor')
    } finally {
      setCreating(false)
    }
  }

  const removeFloor = async (floor: Floor) => {
    if (!activeWorkspace || floor.isLanding) return
    if (removingFloorId !== floor.id) {
      setRemovingFloorId(floor.id)
      return
    }
    if (deletingFloorId === floor.id) return
    const invoke = window.orchestra?.invoke
    if (!invoke) {
      setError('Core indisponível. Inicia o daemon para remover este floor.')
      return
    }
    setDeletingFloorId(floor.id)
    try {
      const result = await invoke('workspace.floor.delete', { workspaceId: activeWorkspace.id, floorId: floor.id })
      if (!result || typeof result !== 'object' || (result as { success?: unknown }).success !== true) {
        throw new Error('Core não confirmou a remoção do floor')
      }
      const remaining = floors.filter((item) => item.id !== floor.id)
      setFloors(remaining)
      if (activeFloor?.id === floor.id) setActiveFloor(remaining[0] || null)
      setRemovingFloorId(null)
      setError(null)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Não foi possível remover o floor; verifique alterações pendentes')
    } finally {
      setDeletingFloorId(null)
    }
  }

  return (
    <div className="modal-layer" onMouseDown={(event) => { if (event.target === event.currentTarget) setFloorModalOpen(false) }}>
      <div
        ref={modalRef}
        className="modal floor-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="floor-modal-title"
        aria-describedby="floor-modal-description"
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="modal-head floor-modal-head">
          <span className="modal-heading-icon" aria-hidden="true"><Layers className="icon" /></span>
          <div className="modal-heading-copy">
            <h2 id="floor-modal-title">Floors</h2>
            <p id="floor-modal-description">Worktrees Git isolados para manter cada contexto organizado.</p>
          </div>
          <button className="icon-btn" type="button" aria-label="Fechar gestão de floors" onClick={() => setFloorModalOpen(false)}>
            <X className="icon" />
          </button>
        </header>

        <form className="floor-form" onSubmit={(event) => { event.preventDefault(); void handleCreateFloor() }}>
          <div className="modal-body floor-modal-body">
            {error && <div className="modal-error" role="alert"><span>{error}</span><button type="button" className="icon-btn" aria-label="Fechar mensagem de erro" onClick={() => setError(null)}><X className="icon" /></button></div>}
            <div className="modal-section-heading">
              <div><h3>Floors existentes</h3><p>{floors.length === 1 ? '1 contexto disponível' : `${floors.length} contextos disponíveis`}</p></div>
              <span className="modal-section-icon" aria-hidden="true"><Layers className="icon" /></span>
            </div>
            <div className="floor-list" role="list" aria-label="Floors existentes">
              {floors.length === 0 && <div className="floor-empty"><Layers className="icon" /><span>Ainda não existem floors neste workspace.</span></div>}
              {floors.map((f) => {
                const isActive = activeFloor?.id === f.id
                const isRemoving = removingFloorId === f.id
                const isDeleting = deletingFloorId === f.id
                return (
                  <div key={f.id} className={`floor-row ${isActive ? 'active' : ''} ${isRemoving ? 'removing' : ''}`} role="listitem" aria-current={isActive ? 'true' : undefined}>
                    <button
                      type="button"
                      className="floor-select"
                      onClick={() => { setActiveFloor(f); setFloorModalOpen(false) }}
                    >
                      <span className={`floor-status ${isActive ? 'active' : ''}`} aria-hidden="true" />
                      <span className="floor-copy">
                        <strong>{f.name}</strong>
                        <small>{f.branch}{f.isLanding ? ' · Ground floor' : ''}</small>
                      </span>
                      {isActive && <Check className="floor-active-icon" aria-hidden="true" />}
                    </button>
                    {!f.isLanding && <button
                      type="button"
                      className={`icon-btn danger floor-remove ${isRemoving ? 'confirm' : ''}`}
                      onClick={() => void removeFloor(f)}
                      disabled={isDeleting}
                      aria-busy={isDeleting}
                      aria-label={isDeleting ? `A remover ${f.name}` : isRemoving ? `Confirmar remoção de ${f.name}` : `Remover ${f.name}`}
                      title={isDeleting ? 'A remover worktree…' : isRemoving ? 'Clica novamente para confirmar a remoção' : 'Remover worktree limpo'}
                    >
                      {isDeleting ? <span className="modal-spinner" aria-hidden="true" /> : isRemoving ? <Check className="icon" /> : <Trash2 className="icon" />}
                    </button>}
                  </div>
                )
              })}
            </div>
          </div>

          <div className="floor-create-section">
            <div className="modal-section-heading compact">
              <div><h3>Criar novo floor</h3><p>Um worktree novo parte do repositório atual.</p></div>
              <span className="modal-section-icon accent" aria-hidden="true"><Plus className="icon" /></span>
            </div>
            <div className="floor-fields">
              <label className="floor-field">
                <span>Nome do floor</span>
                <input
                  ref={newFloorNameRef}
                  id="floor-name"
                  className="input"
                  placeholder="ex.: Auth refactor"
                  value={newFloorName}
                  required
                  onChange={(e) => { setNewFloorName(e.target.value); if (error) setError(null) }}
                />
              </label>
              <label className="floor-field">
                <span>Branch Git <em>opcional</em></span>
                <div className="floor-branch-input"><GitBranch className="icon" aria-hidden="true" /><input id="floor-branch" className="input" placeholder="feature/authentication" value={newBranchName} onChange={(e) => setNewBranchName(e.target.value)} /></div>
              </label>
            </div>
            {!activeWorkspace && <p className="floor-inline-warning" role="status">Seleciona um workspace para criar um floor.</p>}
          </div>

          <footer className="modal-foot floor-modal-foot">
            <span className="floor-foot-hint"><GitBranch className="icon" aria-hidden="true" /> Branches ficam isoladas por floor</span>
            <div className="modal-foot-actions">
              <button type="button" className="btn" onClick={() => setFloorModalOpen(false)}>Cancelar</button>
              <button type="submit" className="btn primary" disabled={creating || !newFloorName.trim() || !activeWorkspace} aria-busy={creating}>{creating ? 'A criar…' : 'Criar floor'}</button>
            </div>
          </footer>
        </form>
      </div>
    </div>
  )
}
