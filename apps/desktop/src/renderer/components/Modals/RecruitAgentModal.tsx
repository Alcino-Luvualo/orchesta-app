import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Bot, Check, Code2, FolderOpen, MousePointer2, Pencil, Sparkles, SquareTerminal, Terminal as TerminalIcon, Trash2, X } from 'lucide-react'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { CustomAgent, customAgentArgv, readCustomAgents, validateCustomAgent, writeCustomAgents } from './agentCatalog'
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

type ModalTab = 'details' | 'appearance' | 'agents'

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
  const [customAgents, setCustomAgents] = useState<CustomAgent[]>([])
  const [agentDraftId, setAgentDraftId] = useState('')
  const [agentDraftName, setAgentDraftName] = useState('')
  const [agentDraftCommand, setAgentDraftCommand] = useState('')
  const [agentDraftOptions, setAgentDraftOptions] = useState('')
  const [agentCatalogError, setAgentCatalogError] = useState('')
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
  const selectedCustomAgent = customAgents.find((agent) => `custom:${agent.id}` === selectedToolId)
  const commandValidation = validateCustomAgent({
    id: selectedCustomAgent?.id || 'custom_validation',
    name: terminalName || 'Terminal',
    command,
    options: selectedCustomAgent?.options || []
  })
  const canCreate = Boolean(commandValidation.value) && Boolean(terminalDirectory.trim()) && (selectedToolId === 'custom' || Boolean(selectedCustomAgent) || Boolean(selectedTool?.installed))

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
    setCustomAgents(readCustomAgents())
    setAgentDraftId('')
    setAgentDraftName('')
    setAgentDraftCommand('')
    setAgentDraftOptions('')
    setAgentCatalogError('')
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
          // Electron desktop launches do not inherit the user's interactive
          // shell PATH (notably nvm and ~/.local/bin). Detection already
          // resolved the executable, so preserve that absolute path in the
          // structured argv passed to the core.
          setCommand(firstInstalled.path || firstInstalled.cmd)
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
    setCommand(tool.path || tool.cmd)
  }

  const selectCustom = () => {
    selectionVersionRef.current += 1
    setSelectedToolId('custom')
    setTerminalName('Custom Terminal')
    setCommand(customCommand)
  }

  const selectCatalogAgent = (agent: CustomAgent) => {
    selectionVersionRef.current += 1
    setSelectedToolId(`custom:${agent.id}`)
    setTerminalName(agent.name)
    setCommand(agent.command)
    setTab('details')
  }

  const editCatalogAgent = (agent: CustomAgent) => {
    setAgentDraftId(agent.id)
    setAgentDraftName(agent.name)
    setAgentDraftCommand(agent.command)
    setAgentDraftOptions(agent.options.join('\n'))
    setAgentCatalogError('')
  }

  const clearAgentDraft = () => {
    setAgentDraftId('')
    setAgentDraftName('')
    setAgentDraftCommand('')
    setAgentDraftOptions('')
    setAgentCatalogError('')
  }

  const saveCatalogAgent = () => {
    const result = validateCustomAgent({
      id: agentDraftId || undefined,
      name: agentDraftName,
      command: agentDraftCommand,
      options: agentDraftOptions.split('\n')
    })
    if (!result.value) { setAgentCatalogError(result.error || 'Configuração inválida.'); return }
    const next = [...customAgents.filter((agent) => agent.id !== result.value?.id), result.value]
    writeCustomAgents(next)
    setCustomAgents(next)
    clearAgentDraft()
  }

  const removeCatalogAgent = (agent: CustomAgent) => {
    const next = customAgents.filter((candidate) => candidate.id !== agent.id)
    writeCustomAgents(next)
    setCustomAgents(next)
    if (selectedToolId === `custom:${agent.id}`) selectCustom()
    if (agentDraftId === agent.id) clearAgentDraft()
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

    const safeAgent = commandValidation.value
    if (!safeAgent) return
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
        command: safeAgent.command,
        ...((selectedTool?.id === 'zsh' || selectedTool?.id === 'bash') ? {} : { commandArgv: customAgentArgv(safeAgent) }),
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
            <button id="terminal-agents-tab" type="button" role="tab" aria-selected={tab === 'agents'} aria-controls="terminal-agents-panel" className={tab === 'agents' ? 'active' : ''} onClick={() => setTab('agents')}>Agents</button>
          </nav>

          <section id={`terminal-${tab}-panel`} className="terminal-create-body" role="tabpanel" aria-labelledby={`terminal-${tab}-tab`}>
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
            ) : tab === 'appearance' ? (
              <div className="terminal-appearance-panel">
                <span className="terminal-create-field-title">Accent color</span>
                <div className="terminal-accent-row" role="radiogroup" aria-label="Accent color">
                  {['lime', 'blue', 'purple', 'orange'].map((color) => (
                    <button key={color} type="button" role="radio" className={`terminal-accent terminal-accent-${color} ${accent === color ? 'selected' : ''}`} aria-label={color} aria-checked={accent === color} onClick={() => setAccent(color)} />
                  ))}
                </div>
                <p>Appearance settings are saved with this terminal node.</p>
              </div>
            ) : <div className="terminal-agents-panel">
              <div className="terminal-agent-section"><span className="terminal-create-field-title">Known agents</span><p>Detetados automaticamente; continuam disponíveis sem cadastro manual.</p><div className="terminal-known-agents">{quickTools.filter((tool) => tool.id !== 'zsh' && tool.id !== 'bash').map((tool) => <div key={tool.id}><ToolIcon id={tool.id} /><span><b>{tool.label}</b><small>{tool.cmd} · {tool.installed ? 'disponível' : 'não detetado'}</small></span></div>)}</div></div>
              <div className="terminal-agent-section"><span className="terminal-create-field-title">Custom agents</span><p>O executável e cada opção serão enviados como argv; nenhum comando é executado durante a configuração.</p><div className="terminal-custom-agents">{customAgents.map((agent) => <div key={agent.id}><span><b>{agent.name}</b><small>{customAgentArgv(agent).join(' ')}</small></span><button type="button" onClick={() => selectCatalogAgent(agent)}>Usar</button><button type="button" className="icon-btn" onClick={() => editCatalogAgent(agent)} aria-label={`Editar ${agent.name}`}><Pencil className="icon" /></button><button type="button" className="icon-btn danger" onClick={() => removeCatalogAgent(agent)} aria-label={`Remover ${agent.name}`}><Trash2 className="icon" /></button></div>)}{customAgents.length === 0 && <small>Nenhum agente personalizado.</small>}</div></div>
              <div className="terminal-agent-editor"><label className="terminal-create-field"><span>Name</span><input value={agentDraftName} maxLength={80} onChange={(event) => setAgentDraftName(event.target.value)} /></label><label className="terminal-create-field"><span>Executable</span><input value={agentDraftCommand} placeholder="my-agent" onChange={(event) => setAgentDraftCommand(event.target.value)} /></label><label className="terminal-create-field"><span>Options · one argv item per line</span><textarea value={agentDraftOptions} rows={3} placeholder={'--model\nfast model'} onChange={(event) => setAgentDraftOptions(event.target.value)} /></label>{agentCatalogError && <p className="terminal-agent-error" role="alert">{agentCatalogError}</p>}<div><button type="button" onClick={clearAgentDraft}>Limpar</button><button type="button" className="primary" onClick={saveCatalogAgent}>{agentDraftId ? 'Guardar alterações' : 'Adicionar agente'}</button></div></div>
            </div>}
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
