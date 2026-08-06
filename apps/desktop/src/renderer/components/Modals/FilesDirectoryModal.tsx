import React, { useEffect, useRef, useState } from 'react'
import { FolderOpen, FolderTree, X } from 'lucide-react'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { useModalA11y } from './modalUtils'

/** Choose the real root before a File Tree node is mounted. */
export const FilesDirectoryModal: React.FC = () => {
  const {
    isFilesModalOpen,
    setFilesModalOpen,
    pendingFilesRect,
    setPendingFilesRect,
    addNode,
    setSelectedNodeId,
    activeWorkspace,
    activeFloor
  } = useWorkspaceStore()
  const [directory, setDirectory] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const modalRef = useModalA11y({
    open: isFilesModalOpen,
    onClose: () => {
      setPendingFilesRect(null)
      setFilesModalOpen(false)
    },
    initialFocusRef: inputRef
  })

  useEffect(() => {
    if (!isFilesModalOpen) return
    setDirectory(activeFloor?.path || activeWorkspace?.path || '')
  }, [activeFloor?.path, activeWorkspace?.path, isFilesModalOpen])

  const close = () => {
    setPendingFilesRect(null)
    setFilesModalOpen(false)
  }

  const chooseDirectory = async () => {
    const selected = await window.orchestra?.chooseWorkspace?.()
    if (selected) setDirectory(selected)
  }

  const create = () => {
    const path = directory.trim()
    if (!path) return
    const rect = pendingFilesRect || { x: 280, y: 180, width: 380, height: 300 }
    const name = path.split('/').filter(Boolean).pop() || 'File Tree'
    const id = `files_${Date.now()}`
    addNode({
      id,
      kind: 'files',
      x: rect.x,
      y: rect.y,
      width: Math.max(320, rect.width),
      height: Math.max(240, rect.height),
      properties: {
        title: `File Tree · ${name}`,
        path,
        cwd: path
      }
    })
    setSelectedNodeId(id)
    setPendingFilesRect(null)
    setFilesModalOpen(false)
  }

  if (!isFilesModalOpen) return null

  return (
    <div className="modal-layer terminal-create-layer" onMouseDown={(event) => { if (event.target === event.currentTarget) close() }}>
      <div
        ref={modalRef}
        className="terminal-create-modal files-directory-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="files-directory-title"
        aria-describedby="files-directory-description"
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="terminal-create-head">
          <div className="terminal-create-title-wrap">
            <span className="terminal-create-title-icon" aria-hidden="true"><FolderTree className="icon" /></span>
            <div><h2 id="files-directory-title">Abrir File Tree</h2><p id="files-directory-description">Escolhe o diretório raiz que queres explorar.</p></div>
          </div>
          <button className="icon-btn" type="button" aria-label="Fechar escolha do diretório" onClick={close}><X className="icon" /></button>
        </header>

        <form className="terminal-create-form" onSubmit={(event) => { event.preventDefault(); create() }}>
          <section className="terminal-create-body files-directory-body">
            <label className="terminal-create-field terminal-directory-field">
              <span>Directory</span>
              <span className="terminal-directory-control">
                <input ref={inputRef} id="files-directory" value={directory} aria-label="Diretório do File Tree" placeholder={activeWorkspace?.path || '/workspace'} required onChange={(event) => setDirectory(event.target.value)} />
                <button type="button" className="terminal-directory-button" onClick={() => void chooseDirectory()} title="Escolher diretório" aria-label="Escolher diretório"><FolderOpen className="icon" /></button>
              </span>
            </label>
            <p className="terminal-command-help">A árvore, editor, Git e pesquisa vão usar esta pasta como raiz.</p>
          </section>
          <footer className="terminal-create-foot">
            <span className="terminal-foot-hint">{directory.trim() ? 'Ready to open' : 'Escolhe um diretório'}</span>
            <div className="terminal-foot-actions">
              <button type="button" className="terminal-create-cancel" onClick={close}>Cancelar</button>
              <button type="submit" className="terminal-create-submit" disabled={!directory.trim()}>Abrir File Tree</button>
            </div>
          </footer>
        </form>
      </div>
    </div>
  )
}
