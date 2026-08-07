import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Bot, Check, Code2, FolderOpen, MousePointer2, Sparkles, SquareTerminal, Terminal as TerminalIcon, X } from 'lucide-react'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { useModalA11y } from './modalUtils'

interface DetectedTool {
  id: string
  name: string
  cmd: string
  description: string
  installed: boolean
  path?: string
}

interface QuickTool extends DetectedTool {
  label: string
}

type ModalTab = 'details' | 'appearance'

const knownTools: DetectedTool[] = [
  { id: 'claude', name: 'Claude Code', cmd: 'claude', description: 'Anthropic coding agent', installed: false },
  { id: 'codex', name: 'Codex CLI', cmd: 'codex', description: 'OpenAI coding agent', installed: false },
  { id: 'cursor', name: 'Cursor CLI', cmd: 'cursor-agent', description: 'Cursor coding agent CLI', installed: false },
  { id: 'agy', name: 'Antigravity CLI', cmd: 'agy', description: 'Gemini coding agent', installed: false },
  { id: 'opencode', name: 'OpenCode', cmd: 'opencode', description: 'Open-source coding agent', installed: false },
  { id: 'zsh', name: 'Zsh Shell', cmd: 'zsh', description: 'System shell', installed: false }
]

function quickToolList(detected: DetectedTool[]): QuickTool[] {
  const byId = new Map(detected.map((tool) => [tool.id, tool]))
  const get = (id: string) => byId.get(id) || knownTools.find((tool) => tool.id === id)
  const shell = byId.get('zsh') || byId.get('bash') || get('zsh')
  const result = [
    get('claude') && { ...get('claude')!, label: 'Claude Code' },
    get('codex') && { ...get('codex')!, label: 'Codex' },
    get('cursor') && { ...get('cursor')!, label: 'Cursor CLI' },
    get('agy') && { ...get('agy')!, label: 'Gemini CLI' },
    get('opencode') && { ...get('opencode')!, label: 'OpenCode' },
    shell && { ...shell, label: 'Shell' }
  ].filter((tool): tool is QuickTool => Boolean(tool))
  return result
}

function ToolIcon({ id }: { id: string }) {
  if (id === 'claude') return <Sparkles className="icon" />
  if (id === 'codex') return <Bot className="icon" />
  if (id === 'cursor') return <MousePointer2 className="icon" />
  if (id === 'agy') return <Code2 className="icon" />
  if (id === 'opencode') return <SquareTerminal className="icon" />
  return <TerminalIcon className="icon" />
}

export const RecruitAgentModal: React.FC = () => {
  const {
    isRecruitModalOpen,
    setRecruitModalOpen,
    addNode,
    pendingTerminalRect,
    setPendingTerminalRect,
    activeWorkspace
  } = useWorkspaceStore()
  const [tools, setTools] = useState<DetectedTool[]>(knownTools)
  const [selectedToolId, setSelectedToolId] = useState('codex')
  const [terminalName, setTerminalName] = useState('Codex')
  const [command, setCommand] = useState('codex')
  const [terminalDirectory, setTerminalDirectory] = useState('')
  const [customCommand, setCustomCommand] = useState('')
  const [monitorActivity, setMonitorActivity] = useState(true)
  const [tab, setTab] = useState<ModalTab>('details')
  const [accent, setAccent] = useState('lime')
  const selectionVersionRef = useRef(0)
  const nameInputRef = useRef<HTMLInputElement>(null)
  const modalRef = useModalA11y({
    open: isRecruitModalOpen,
    onClose: () => setRecruitModalOpen(false),
    initialFocusRef: nameInputRef
  })

  const quickTools = useMemo(() => quickToolList(tools), [tools])
  const selectedTool = quickTools.find((tool) => tool.id === selectedToolId)
  const canCreate = Boolean(command.trim()) && Boolean(terminalDirectory.trim()) && (selectedToolId === 'custom' || Boolean(selectedTool?.installed))

  useEffect(() => {
    if (!isRecruitModalOpen) return
    let mounted = true
    setTab('details')
    setMonitorActivity(true)
    setAccent('lime')
    setSelectedToolId('codex')
    setTerminalName('Codex')
    setCommand('codex')
    setTerminalDirectory(activeWorkspace?.path || '')
    setTools(knownTools)
    setCustomCommand('')
    selectionVersionRef.current = 0
    const initialSelectionVersion = selectionVersionRef.current

    const loadDetectedTools = async () => {
      try {
        const detected = await window.orchestra?.detectTools?.()
        if (!mounted || !Array.isArray(detected)) return
        const nextTools = detected as DetectedTool[]
        const nextQuickTools = quickToolList(nextTools)
        setTools(nextTools)
        if (selectionVersionRef.current !== initialSelectionVersion) return
        const firstInstalled = nextQuickTools.find((tool) => tool.installed) || nextQuickTools[0]
        if (firstInstalled) {
          setSelectedToolId(firstInstalled.id)
          setTerminalName(firstInstalled.label)
          setCommand(firstInstalled.cmd)
        }
      } catch {
        // The known provider list remains usable while detection is unavailable.
      }
    }

    void loadDetectedTools()
    return () => { mounted = false }
  }, [activeWorkspace?.path, isRecruitModalOpen])

  const selectTool = (tool: QuickTool) => {
    selectionVersionRef.current += 1
    setSelectedToolId(tool.id)
    setTerminalName(tool.label)
    setCommand(tool.cmd)
  }

  const selectCustom = () => {
    selectionVersionRef.current += 1
    setSelectedToolId('custom')
    setTerminalName('Custom Terminal')
    setCommand(customCommand)
  }

  const chooseTerminalDirectory = async () => {
    const selected = await window.orchestra?.chooseWorkspace?.()
    if (selected) setTerminalDirectory(selected)
  }

  const handleCreate = () => {
    if (!canCreate) return
    const nodeWidth = pendingTerminalRect ? Math.max(340, pendingTerminalRect.width) : 480
    const nodeHeight = pendingTerminalRect ? Math.max(220, pendingTerminalRect.height) : 280
    const nodeX = pendingTerminalRect ? pendingTerminalRect.x : 280 + Math.random() * 80
    const nodeY = pendingTerminalRect ? pendingTerminalRect.y : 180 + Math.random() * 80

    addNode({
      id: `term_${Date.now()}`,
      kind: 'terminal',
      x: nodeX,
      y: nodeY,
      width: nodeWidth,
      height: nodeHeight,
      properties: {
        title: terminalName.trim() || 'New Terminal',
        agent: terminalName.trim() || 'Terminal',
        command: command.trim(),
        cwd: terminalDirectory.trim(),
        status: 'starting',
        monitorActivity,
        accent
      }
    })

    setPendingTerminalRect(null)
    setRecruitModalOpen(false)
  }

  if (!isRecruitModalOpen) return null

  return (
    <div className="modal-layer terminal-create-layer" onMouseDown={(event) => { if (event.target === event.currentTarget) setRecruitModalOpen(false) }}>
      <div
        ref={modalRef}
        className="terminal-create-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="terminal-create-title"
        aria-describedby="terminal-create-description"
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="terminal-create-head">
          <div className="terminal-create-title-wrap">
            <span className="terminal-create-title-icon" aria-hidden="true"><TerminalIcon className="icon" /></span>
            <div><h2 id="terminal-create-title">New Terminal</h2><p id="terminal-create-description">Escolhe um provider e configura o teu terminal.</p></div>
          </div>
          <button className="icon-btn" type="button" aria-label="Fechar criação de terminal" onClick={() => setRecruitModalOpen(false)}>
            <X className="icon" />
          </button>
        </header>

        <form className="terminal-create-form" onSubmit={(event) => { event.preventDefault(); handleCreate() }}>
          <section className="terminal-create-quick" aria-labelledby="terminal-quick-start">
            <div className="terminal-section-title-row"><span id="terminal-quick-start" className="terminal-create-label">Quick Start</span><span className="terminal-detected-status" aria-live="polite">{quickTools.filter((tool) => tool.installed).length} available</span></div>
            <div className="terminal-provider-row" role="list" aria-label="Terminal providers">
              {quickTools.map((tool) => (
                <button
                  key={tool.id}
                  type="button"
                  className={`terminal-provider ${selectedToolId === tool.id && tool.installed ? 'selected' : ''}`}
                  aria-pressed={selectedToolId === tool.id && tool.installed}
                  aria-label={`${tool.label}${tool.installed ? '' : ' (unavailable)'}`}
                  disabled={!tool.installed}
                  onClick={() => selectTool(tool)}
                  title={tool.installed ? tool.description : `${tool.description} · unavailable`}
                >
                  <span className="terminal-provider-icon"><ToolIcon id={tool.id} /></span>
                  <span className="terminal-provider-name">{tool.label}</span>
                  <small>{tool.installed ? 'Ready' : 'Unavailable'}</small>
                  {tool.installed && <Check className="terminal-provider-check" aria-hidden="true" />}
                </button>
              ))}
            </div>
            <button type="button" className={`terminal-custom-link ${selectedToolId === 'custom' ? 'selected' : ''}`} aria-pressed={selectedToolId === 'custom'} onClick={selectCustom}>
              <span>Use a custom command</span><span aria-hidden="true">⌘</span>
            </button>
          </section>

          <nav className="terminal-create-tabs" aria-label="Terminal settings" role="tablist">
            <button id="terminal-details-tab" type="button" role="tab" aria-selected={tab === 'details'} aria-controls="terminal-details-panel" className={tab === 'details' ? 'active' : ''} onClick={() => setTab('details')}>Details</button>
            <button id="terminal-appearance-tab" type="button" role="tab" aria-selected={tab === 'appearance'} aria-controls="terminal-appearance-panel" className={tab === 'appearance' ? 'active' : ''} onClick={() => setTab('appearance')}>Appearance</button>
          </nav>

          <section id={tab === 'details' ? 'terminal-details-panel' : 'terminal-appearance-panel'} className="terminal-create-body" role="tabpanel" aria-labelledby={tab === 'details' ? 'terminal-details-tab' : 'terminal-appearance-tab'}>
            {tab === 'details' ? (
              <>
                <label className="terminal-create-field">
                  <span>Name</span>
                  <input ref={nameInputRef} autoFocus id="terminal-name" value={terminalName} aria-label="Terminal name" onChange={(event) => setTerminalName(event.target.value)} />
                </label>
                <label className="terminal-create-field">
                  <span>Command</span>
                  <input id="terminal-command" value={command} aria-label="Terminal command" aria-describedby="terminal-command-help" aria-invalid={!command.trim() || undefined} required onChange={(event) => { setCommand(event.target.value); if (selectedToolId === 'custom') setCustomCommand(event.target.value) }} />
                </label>
                <p id="terminal-command-help" className="terminal-command-help">O comando será iniciado no diretório escolhido.</p>
                <label className="terminal-create-field terminal-directory-field">
                  <span>Directory</span>
                  <span className="terminal-directory-control">
                    <input id="terminal-directory" value={terminalDirectory} aria-label="Terminal directory" placeholder={activeWorkspace?.path || '/workspace'} required onChange={(event) => setTerminalDirectory(event.target.value)} />
                    <button type="button" className="terminal-directory-button" onClick={() => void chooseTerminalDirectory()} title="Escolher diretório" aria-label="Escolher diretório"><FolderOpen className="icon" /></button>
                  </span>
                </label>
                <p className="terminal-command-help">O agente ou shell abre diretamente nesta pasta.</p>
                <label className="terminal-create-check">
                  <input type="checkbox" checked={monitorActivity} onChange={(event) => setMonitorActivity(event.target.checked)} />
                  <span>Monitor Activity</span>
                  <span className="terminal-create-info" title="Show status and attention changes on the terminal node" aria-label="Monitora mudanças de estado">i</span>
                </label>
              </>
            ) : (
              <div className="terminal-appearance-panel">
                <span className="terminal-create-field-title">Accent color</span>
                <div className="terminal-accent-row" role="radiogroup" aria-label="Accent color">
                  {['lime', 'blue', 'purple', 'orange'].map((color) => (
                    <button key={color} type="button" role="radio" className={`terminal-accent terminal-accent-${color} ${accent === color ? 'selected' : ''}`} aria-label={color} aria-checked={accent === color} onClick={() => setAccent(color)} />
                  ))}
                </div>
                <p>Appearance settings are saved with this terminal node.</p>
              </div>
            )}
          </section>

          <footer className="terminal-create-foot">
            <span className="terminal-foot-hint">{canCreate ? 'Ready to create' : 'Choose an available provider or custom command'}</span>
            <div className="terminal-foot-actions">
              <button type="button" className="terminal-create-cancel" onClick={() => setRecruitModalOpen(false)}>Cancel</button>
              <button type="submit" className="terminal-create-submit" disabled={!canCreate}>Create terminal</button>
            </div>
          </footer>
        </form>
      </div>
    </div>
  )
}
