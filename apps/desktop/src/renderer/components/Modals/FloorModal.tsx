import React, { useState } from 'react'
import { useWorkspaceStore, Floor } from '../../store/workspaceStore'
import { X, Layers, Plus, GitBranch, Check, GitMerge } from 'lucide-react'

export const FloorModal: React.FC = () => {
  const { isFloorModalOpen, setFloorModalOpen, floors, activeFloor, setActiveFloor, setFloors } = useWorkspaceStore()
  const [newFloorName, setNewFloorName] = useState('')
  const [newBranchName, setNewBranchName] = useState('')

  if (!isFloorModalOpen) return null

  const handleCreateFloor = () => {
    if (!newFloorName.trim()) return
    const branch = newBranchName.trim() || `feature/${newFloorName.toLowerCase().replace(/\s+/g, '-')}`
    const newFloor: Floor = {
      id: `fl_${Date.now()}`,
      name: newFloorName,
      branch,
      path: `/home/user/dev/commerce/.floors/${newFloorName.toLowerCase()}`
    }

    if (window.orchestra?.invoke) {
      window.orchestra.invoke('git.create_floor', {
        path: '/home/user/dev/commerce',
        name: newFloorName,
        branch
      }).catch(console.error)
    }

    setFloors([...floors, newFloor])
    setActiveFloor(newFloor)
    setNewFloorName('')
    setNewBranchName('')
    setFloorModalOpen(false)
  }

  return (
    <div className="modal-layer" onClick={() => setFloorModalOpen(false)}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <b>Gestão de Floors (Git Worktrees Isolados)</b>
          <button className="icon-btn" onClick={() => setFloorModalOpen(false)}>
            <X className="icon" />
          </button>
        </div>

        <div className="modal-body">
          <label style={{ fontSize: 11, color: 'var(--dim)', display: 'block', marginBottom: 8 }}>Floors Existentes</label>
          <div style={{ display: 'grid', gap: 6, marginBottom: 18 }}>
            {floors.map((f) => (
              <div
                key={f.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  padding: '8px 12px',
                  background: activeFloor?.id === f.id ? 'var(--primary-muted)' : 'var(--panel2)',
                  border: activeFloor?.id === f.id ? '1px solid var(--primary)' : '1px solid var(--line)',
                  borderRadius: 8,
                  cursor: 'pointer'
                }}
                onClick={() => {
                  setActiveFloor(f)
                  setFloorModalOpen(false)
                }}
              >
                <i style={{ width: 8, height: 8, borderRadius: '50%', background: '#6d9eeb', marginRight: 8 }} />
                <div style={{ flex: 1 }}>
                  <b style={{ fontSize: 12 }}>{f.name}</b>
                  <span style={{ fontSize: 9, color: 'var(--dim)', display: 'block', fontFamily: 'var(--mono)' }}>
                    {f.branch} {f.isLanding ? '· Ground Floor' : ''}
                  </span>
                </div>
                {activeFloor?.id === f.id && <Check className="icon" style={{ color: 'var(--primary)' }} />}
              </div>
            ))}
          </div>

          <div style={{ borderTop: '1px solid var(--line)', paddingTop: 14 }}>
            <b style={{ fontSize: 11 }}>Criar Novo Floor (Worktree)</b>
            <div className="field" style={{ marginTop: 8 }}>
              <label>Nome do Floor</label>
              <input
                className="input"
                placeholder="ex: Auth Refactor"
                value={newFloorName}
                onChange={(e) => setNewFloorName(e.target.value)}
              />
            </div>
            <div className="field">
              <label>Nome da Branch Git</label>
              <input
                className="input"
                placeholder="ex: feature/authentication"
                value={newBranchName}
                onChange={(e) => setNewBranchName(e.target.value)}
              />
            </div>
          </div>
        </div>

        <div className="modal-foot">
          <button className="btn" onClick={() => setFloorModalOpen(false)}>Cancelar</button>
          <button className="btn primary" onClick={handleCreateFloor}>Criar Floor Worktree</button>
        </div>
      </div>
    </div>
  )
}
