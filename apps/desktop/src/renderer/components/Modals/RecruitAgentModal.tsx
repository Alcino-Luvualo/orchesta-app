import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Bot, Check, Code2, FolderOpen, MousePointer2, Pencil, Plus, Sparkles, SquareTerminal, Terminal as TerminalIcon, Trash2, X } from 'lucide-react'
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
  const [agentEditorOpen, setAgentEditorOpen] = useState(false)
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
    setAgentEditorOpen(false)
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
    setTab('details')
  }

  const selectCustom = () => {
    selectionVersionRef.current += 1
    setSelectedToolId('custom')
    setTerminalName('Terminal personalizado')
    setCommand(customCommand)
    setTab('details')
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
    setAgentEditorOpen(true)
  }

  const clearAgentDraft = () => {
    setAgentDraftId('')
    setAgentDraftName('')
    setAgentDraftCommand('')
    setAgentDraftOptions('')
    setAgentCatalogError('')
    setAgentEditorOpen(false)
  }

  const startCatalogAgent = () => {
    clearAgentDraft()
    setAgentEditorOpen(true)
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
    selectCatalogAgent(result.value)
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
        title: terminalName.trim() || 'Novo terminal',
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
            <div><h2 id="terminal-create-title">Criar terminal</h2><p id="terminal-create-description">Escolhe um agente e configura o terminal.</p></div>
          </div>
          <button className="icon-btn" type="button" aria-label="Fechar criação de terminal" onClick={() => setRecruitModalOpen(false)}>
            <X className="icon" />
          </button>
        </header>

        <form className="terminal-create-form" onSubmit={(event) => { event.preventDefault(); handleCreate() }}>
          <section className="terminal-create-quick" aria-labelledby="terminal-quick-start">
            <div className="terminal-section-title-row"><span id="terminal-quick-start" className="terminal-create-label">Início rápido</span><span className="terminal-detected-status" aria-live="polite">{quickTools.filter((tool) => tool.installed).length} disponíveis</span></div>
            <div className="terminal-provider-row" role="list" aria-label="Agentes disponíveis">
              {quickTools.map((tool) => (
                <button
                  key={tool.id}
                  type="button"
                  className={`terminal-provider ${selectedToolId === tool.id && tool.installed ? 'selected' : ''}`}
                  aria-pressed={selectedToolId === tool.id && tool.installed}
                  aria-label={`${tool.label}${tool.installed ? '' : ' (indisponível)'}`}
                  disabled={!tool.installed}
                  onClick={() => selectTool(tool)}
                  title={tool.installed ? tool.description : `${tool.description} · indisponível`}
                >
                  <span className="terminal-provider-icon"><ToolIcon id={tool.id} /></span>
                  <span className="terminal-provider-name">{tool.label}</span>
                  <span className="terminal-provider-state">{tool.installed ? 'Pronto' : 'Indisponível'}</span>
                  {tool.installed && <Check className="terminal-provider-check" aria-hidden="true" />}
                </button>
              ))}
            </div>
            <button type="button" className={`terminal-custom-link ${selectedToolId === 'custom' ? 'selected' : ''}`} aria-pressed={selectedToolId === 'custom'} onClick={selectCustom}>
              <span>Usar comando personalizado</span><span aria-hidden="true">⌘</span>
            </button>
          </section>

          <nav className="terminal-create-tabs" aria-label="Definições do terminal" role="tablist">
            <button id="terminal-details-tab" type="button" role="tab" aria-selected={tab === 'details'} aria-controls="terminal-details-panel" className={tab === 'details' ? 'active' : ''} onClick={() => setTab('details')}>Detalhes</button>
            <button id="terminal-appearance-tab" type="button" role="tab" aria-selected={tab === 'appearance'} aria-controls="terminal-appearance-panel" className={tab === 'appearance' ? 'active' : ''} onClick={() => setTab('appearance')}>Aspeto</button>
            <button id="terminal-agents-tab" type="button" role="tab" aria-selected={tab === 'agents'} aria-controls="terminal-agents-panel" className={tab === 'agents' ? 'active' : ''} onClick={() => setTab('agents')}>Agentes</button>
          </nav>

          <section id={`terminal-${tab}-panel`} className="terminal-create-body" role="tabpanel" aria-labelledby={`terminal-${tab}-tab`}>
            {tab === 'details' ? (
              <div className="terminal-details-panel">
                <label className="terminal-create-field">
                  <span>Nome</span>
                  <input ref={nameInputRef} autoFocus id="terminal-name" value={terminalName} aria-label="Nome do terminal" onChange={(event) => setTerminalName(event.target.value)} />
                </label>
                <label className="terminal-create-field">
                  <span>Comando</span>
                  <input id="terminal-command" value={command} aria-label="Comando do terminal" aria-invalid={!command.trim() || undefined} required onChange={(event) => { setCommand(event.target.value); if (selectedToolId === 'custom') setCustomCommand(event.target.value) }} />
                </label>
                <label className="terminal-create-field terminal-directory-field">
                  <span>Diretório</span>
                  <span className="terminal-directory-control">
                    <input id="terminal-directory" value={terminalDirectory} aria-label="Diretório do terminal" placeholder={activeWorkspace?.path || '/workspace'} required onChange={(event) => setTerminalDirectory(event.target.value)} />
                    <button type="button" className="terminal-directory-button" onClick={() => void chooseTerminalDirectory()} title="Escolher diretório" aria-label="Escolher diretório"><FolderOpen className="icon" /></button>
                  </span>
                </label>
                <label className="terminal-create-check">
                  <input type="checkbox" checked={monitorActivity} onChange={(event) => setMonitorActivity(event.target.checked)} />
                  <span>Monitorizar atividade</span>
                  <span className="terminal-create-info" title="Mostra alterações de estado e de atenção no nó do terminal" aria-label="Monitora mudanças de estado">i</span>
                </label>
              </div>
            ) : tab === 'appearance' ? (
              <div className="terminal-appearance-panel">
                <span className="terminal-create-field-title">Cor de destaque</span>
                <div className="terminal-accent-row" role="radiogroup" aria-label="Cor de destaque">
                  {['lime', 'blue', 'purple', 'orange'].map((color) => (
                    <button key={color} type="button" role="radio" className={`terminal-accent terminal-accent-${color} ${accent === color ? 'selected' : ''}`} aria-label={color} aria-checked={accent === color} onClick={() => setAccent(color)} />
                  ))}
                </div>
                <p>A cor fica guardada apenas neste terminal.</p>
              </div>
            ) : <div className="terminal-agents-panel">
              <div className="terminal-agent-catalog-head">
                <div><span className="terminal-create-field-title">Agentes personalizados</span><p>Guarda comandos reutilizáveis; as opções são passadas como argv.</p></div>
                <button type="button" className="terminal-agent-add" onClick={startCatalogAgent} aria-expanded={agentEditorOpen}><Plus className="icon" />Novo agente</button>
              </div>
              <div className="terminal-custom-agents">
                {customAgents.map((agent) => <div key={agent.id}>
                  <span><b>{agent.name}</b><small>{customAgentArgv(agent).join(' ')}</small></span>
                  <div className="terminal-agent-actions"><button type="button" onClick={() => selectCatalogAgent(agent)}>Usar</button><button type="button" className="icon-btn" onClick={() => editCatalogAgent(agent)} aria-label={`Editar ${agent.name}`}><Pencil className="icon" /></button><button type="button" className="icon-btn danger" onClick={() => removeCatalogAgent(agent)} aria-label={`Remover ${agent.name}`}><Trash2 className="icon" /></button></div>
                </div>)}
                {customAgents.length === 0 && <div className="terminal-agent-empty"><TerminalIcon className="icon" /><span>Ainda não há agentes personalizados.</span></div>}
              </div>
              {agentEditorOpen && <section className="terminal-agent-editor" aria-label={agentDraftId ? 'Editar agente personalizado' : 'Adicionar agente personalizado'}>
                <div className="terminal-agent-editor-head"><span>{agentDraftId ? 'Editar agente' : 'Novo agente'}</span><button type="button" className="icon-btn" onClick={clearAgentDraft} aria-label="Fechar editor de agente"><X className="icon" /></button></div>
                <div className="terminal-agent-editor-fields">
                  <label><span>Nome</span><input value={agentDraftName} maxLength={80} onChange={(event) => setAgentDraftName(event.target.value)} /></label>
                  <label><span>Executável</span><input value={agentDraftCommand} placeholder="my-agent" onChange={(event) => setAgentDraftCommand(event.target.value)} /></label>
                </div>
                <label className="terminal-agent-options"><span>Opções <small>uma por linha</small></span><textarea value={agentDraftOptions} rows={2} placeholder={'--model\nfast model'} onChange={(event) => setAgentDraftOptions(event.target.value)} /></label>
                {agentCatalogError && <p className="terminal-agent-error" role="alert">{agentCatalogError}</p>}
                <div className="terminal-agent-editor-actions"><button type="button" onClick={clearAgentDraft}>Cancelar</button><button type="button" className="primary" disabled={!agentDraftName.trim() || !agentDraftCommand.trim()} onClick={saveCatalogAgent}>{agentDraftId ? 'Guardar' : 'Adicionar'}</button></div>
              </section>}
            </div>}
          </section>

          <footer className="terminal-create-foot">
            <span className="terminal-foot-hint">{canCreate ? `${terminalName || 'Terminal'} pronto a criar` : 'Seleciona um agente disponível ou define um comando.'}</span>
            <div className="terminal-foot-actions">
              <button type="button" className="terminal-create-cancel" onClick={() => setRecruitModalOpen(false)}>Cancelar</button>
              <button type="submit" className="terminal-create-submit" disabled={!canCreate}>Criar terminal</button>
            </div>
          </footer>
        </form>
      </div>
    </div>
  )
}
