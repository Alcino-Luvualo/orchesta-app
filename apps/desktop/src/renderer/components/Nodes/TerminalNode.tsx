import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Handle, Position, NodeResizer } from '@xyflow/react'
import { CompletionContext } from '@codemirror/autocomplete'
import { FileCode2, FolderOpen, GitBranch, Maximize2, Mic, Minimize2, Paperclip, Plus, X } from 'lucide-react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { SerializeAddon } from '@xterm/addon-serialize'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'
import { CanvasComponentData, useWorkspaceStore } from '../../store/workspaceStore'
import { CommandHistoryEntry, CommandHistoryStore } from './commandHistory'
import { CommandSearchOverlay } from './CommandSearchOverlay'
import { TerminalSearchOverlay } from './TerminalSearchOverlay'
import { CompletionController, HistoryCompletionProvider, QueryCompletionProvider } from './completionProviders'
import { RichCommandEditor } from './RichCommandEditor'
import { TerminalBlockList } from './TerminalBlockList'
import { TerminalBlockStore } from './terminalBlocks'
import { detectTerminalFileReferences, osc52Response, parseOsc52, readTerminalSecuritySettings, sanitizeTerminalUrl, TerminalSecuritySettings, writeTerminalSecuritySettings } from './terminalSecurity'
import { getTerminalTransformScale, isIdentityTerminalScale, mapTerminalPointerToLayout } from './terminalGeometry'
import { DEFAULT_TERMINAL_KEYBOARD_PROTOCOL, isDirectInteractiveTerminalCommand, isMultilineEnter, isNativeEnterData, multilineEnterPayload, TerminalKeyboardProtocol } from './terminalInput'

type TerminalInteractionMode =
  | 'shell_prompt'
  | 'command_running'
  | 'interactive_program'
  | 'alternate_screen'
  | 'password_input'
  | 'shell_fallback'
  | 'disconnected'

type PendingClipboardRequest = {
  direction: 'read' | 'write'
  selection: string
  text?: string
}

function decodeOutput(value: unknown): Uint8Array {
  if (typeof value !== 'string') return new Uint8Array()
  try {
    const binary = atob(value)
    return Uint8Array.from(binary, (char) => char.charCodeAt(0))
  } catch {
    return new TextEncoder().encode(value)
  }
}

function normalizeTerminalPath(value: string): string {
  const absolute = value.startsWith('/')
  const parts: string[] = []
  value.split('/').forEach((part) => {
    if (!part || part === '.') return
    if (part === '..') { parts.pop(); return }
    parts.push(part)
  })
  return `${absolute ? '/' : ''}${parts.join('/')}` || (absolute ? '/' : '.')
}

/** Keep legacy terminal cwd values inside the authenticated workspace. */
function resolveTerminalCwd(cwd: string, workspaceRoot?: string): string | undefined {
  const rawRoot = typeof workspaceRoot === 'string' ? workspaceRoot.trim() : ''
  const rawCwd = cwd.trim()
  if (!rawCwd) return undefined
  if (!rawRoot) return rawCwd
  const root = normalizeTerminalPath(rawRoot)
  const candidate = normalizeTerminalPath(rawCwd.startsWith('/') ? rawCwd : `${root}/${rawCwd}`)
  return candidate === root || candidate.startsWith(`${root}/`) ? candidate : root
}

function isRichInputV2Enabled(property: unknown): boolean {
  if (property === true || property === 'true') return true
  if (property === false || property === 'false') return false
  try {
    const override = window.localStorage.getItem('terminal.richInputV2')
    if (override === 'false') return false
    if (override === 'true') return true
  } catch {
    // A restricted storage context keeps the native PTY terminal default.
  }
  // Native xterm/PTY input is the default. The semantic editor is an explicit
  // opt-in for users who need its separate editing affordances.
  return false
}

function promptFallbackCursorInput(term: Terminal, event: MouseEvent): string | null {
  const element = term.element
  if (!element || term.buffer.active.type === 'alternate') return null
  const bounds = element.getBoundingClientRect()
  if (bounds.width < 1 || bounds.height < 1) return null
  const cellWidth = bounds.width / Math.max(1, term.cols)
  const cellHeight = bounds.height / Math.max(1, term.rows)
  const targetX = Math.max(0, Math.min(term.cols, Math.floor((event.clientX - bounds.left) / cellWidth)))
  const targetRow = Math.max(0, Math.min(term.rows - 1, Math.floor((event.clientY - bounds.top) / cellHeight)))
  const buffer = term.buffer.active
  const lineIndex = buffer.viewportY + targetRow
  if (lineIndex !== buffer.viewportY + buffer.cursorY) return null
  const line = buffer.getLine(lineIndex)?.translateToString(true) || ''
  const promptMatches = [...line.matchAll(/(?:^|\s)([$%#>])\s/g)]
    .filter((match) => (match.index || 0) < buffer.cursorX)
  const prompt = promptMatches[promptMatches.length - 1]
  const promptEnd = prompt ? (prompt.index || 0) + prompt[0].length : 0
  const inputColumn = Math.max(0, Math.min(512, targetX - promptEnd))
  // Ctrl+A moves to the start of the native shell line editor; arrows then
  // place the caret at the clicked command column in fallback mode.
  return `\u0001${'\u001b[C'.repeat(inputColumn)}`
}

function terminalTheme(theme: 'dark' | 'light') {
  return theme === 'light'
    ? {
        background: '#f7f8f5', foreground: '#273029', cursor: '#718d27', selectionBackground: 'rgba(130, 169, 28, .22)',
        black: '#f7f8f5', white: '#273029', brightWhite: '#1a1f1b', brightBlack: '#a0a6ad',
        red: '#a63d40', brightRed: '#c54b50', green: '#4b6e22', brightGreen: '#66942e',
        cyan: '#217075', brightCyan: '#2d99a0', blue: '#2f5b99', brightBlue: '#427cd1',
        yellow: '#8f7b1b', brightYellow: '#b39a22', magenta: '#7f4f9d', brightMagenta: '#9f6fbd'
      }
    : {
        background: '#0c0e10', foreground: '#e7ece8', cursor: '#c8f169', selectionBackground: 'rgba(200, 241, 105, .22)', selectionForeground: '#ffffff',
        black: '#161a1e', red: '#ff757f', green: '#c8f169', yellow: '#e8c56a', blue: '#7aa2f7', magenta: '#bb9af7', cyan: '#62d9ef', white: '#d7dde8',
        brightBlack: '#67717e', brightRed: '#ff9aa2', brightGreen: '#dcff91', brightYellow: '#ffe08a', brightBlue: '#9ab8ff', brightMagenta: '#d6b7ff', brightCyan: '#94ebff', brightWhite: '#ffffff'
      }
}

type XtermMouseService = {
  getCoords?: (event: { clientX: number; clientY: number }, element: HTMLElement, ...rest: unknown[]) => unknown
  getMouseReportCoords?: (event: { clientX: number; clientY: number }, element: HTMLElement, ...rest: unknown[]) => unknown
}

/**
 * xterm's mouse service receives a painted DOM rectangle but divides its
 * offset by unscaled character metrics. React Flow applies that exact CSS
 * scale to every node, so selection drifts by the board zoom (most visibly
 * when zoomed in: the selected row is below the pointer). Keep xterm's
 * renderer untouched and normalize only the pointer coordinates at its
 * service boundary. The current rectangle is read for every event, so pan,
 * node drag, resize, DPR and browser zoom remain safe without a hot loop.
 */
function installXtermTransformCompensation(term: Terminal): () => void {
  // xterm keeps this browser service on the public Terminal wrapper (not on
  // `_core`, which only owns renderer dimensions and PTY state).
  const mouseService = (term as unknown as { _mouseService?: XtermMouseService })._mouseService
  if (!mouseService) return () => undefined

  const originalGetCoords = mouseService.getCoords
  const originalGetMouseReportCoords = mouseService.getMouseReportCoords
  if (!originalGetCoords && !originalGetMouseReportCoords) return () => undefined

  const mapEvent = (event: { clientX: number; clientY: number }, element: HTMLElement) => {
    const visual = element.getBoundingClientRect()
    const layout = {
      width: element.offsetWidth || element.clientWidth,
      height: element.offsetHeight || element.clientHeight
    }
    const scale = getTerminalTransformScale(visual, layout)
    if (isIdentityTerminalScale(scale)) return event
    return mapTerminalPointerToLayout(event, visual, scale)
  }

  if (originalGetCoords) {
    mouseService.getCoords = (event, element, ...rest) => originalGetCoords.call(
      mouseService,
      mapEvent(event, element),
      element,
      ...rest
    )
  }
  if (originalGetMouseReportCoords) {
    mouseService.getMouseReportCoords = (event, element, ...rest) => originalGetMouseReportCoords.call(
      mouseService,
      mapEvent(event, element),
      element,
      ...rest
    )
  }

  return () => {
    if (originalGetCoords) mouseService.getCoords = originalGetCoords
    if (originalGetMouseReportCoords) mouseService.getMouseReportCoords = originalGetMouseReportCoords
  }
}

export const TerminalNode: React.FC<{ id: string; data: CanvasComponentData }> = ({ id, data }) => {
  const terminalRef = useRef<HTMLDivElement>(null)
  const xtermInstance = useRef<Terminal | null>(null)
  const fitAddonInstance = useRef<FitAddon | null>(null)
  const searchAddonInstance = useRef<SearchAddon | null>(null)
  const resizeObserverRef = useRef<ResizeObserver | null>(null)
  const outputQueueRef = useRef<Uint8Array[]>([])
  const outputFrameRef = useRef<number | null>(null)
  const inputQueueRef = useRef<string[]>([])
  const inputFrameRef = useRef<number | null>(null)
  // Match Ghostty's negotiation rules: an application starts in the legacy
  // encoding (the Ctrl/Shift+Enter form is CSI 27), and only opts into Kitty
  // CSI-u after it explicitly pushes/sets the Kitty keyboard protocol.
  // Sending CSI-u before a TUI negotiates it makes some agent key parsers
  // discard Ctrl+Enter instead of treating it as a distinct key.
  const keyboardProtocolRef = useRef<TerminalKeyboardProtocol>(DEFAULT_TERMINAL_KEYBOARD_PROTOCOL)
  const kittyKeyboardProtocolStackRef = useRef<TerminalKeyboardProtocol[]>([])
  const suppressNativeModifiedEnterRef = useRef(false)
  const suppressNativeModifiedEnterTimerRef = useRef<number | null>(null)
  const fitFrameRef = useRef<number | null>(null)
  const lastSentSizeRef = useRef<string | null>(null)
  const sessionReadyRef = useRef(false)
  const spawnStartedRef = useRef(false)
  const terminalLifecycleRef = useRef<Promise<void> | null>(null)
  const lastCoreGenerationRef = useRef(0)
  const interactionModeRef = useRef<TerminalInteractionMode>('shell_fallback')
  const attachmentInputRef = useRef<HTMLInputElement>(null)
  const historyStoreRef = useRef<CommandHistoryStore | null>(null)
  const completionControllerRef = useRef<CompletionController | null>(null)
  const blockStoreRef = useRef<TerminalBlockStore | null>(null)
  const blockRenderFrameRef = useRef<number | null>(null)
  const activeHistoryIdRef = useRef<string | null>(null)
  const securitySettingsRef = useRef<TerminalSecuritySettings | null>(null)
  const pendingClipboardRef = useRef<PendingClipboardRequest | null>(null)
  const runningSinceRef = useRef<number | null>(null)
  const windowFocusedRef = useRef(true)
  const [isLifted, setIsLifted] = useState(false)
  const [attachments, setAttachments] = useState<Array<{ name: string; path?: string; size: number }>>([])
  const [interactionMode, setInteractionMode] = useState<TerminalInteractionMode>('shell_fallback')
  const [editorRevision, setEditorRevision] = useState(0)
  const [editorHandoffPending, setEditorHandoffPending] = useState(false)
  const [editorSeed, setEditorSeed] = useState('')
  const [historySearchOpen, setHistorySearchOpen] = useState(false)
  const [terminalSearchOpen, setTerminalSearchOpen] = useState(false)
  const [terminalSearchQuery, setTerminalSearchQuery] = useState('')
  const [terminalSearchFound, setTerminalSearchFound] = useState<boolean | null>(null)
  const [historyEntries, setHistoryEntries] = useState<CommandHistoryEntry[]>([])
  const [blocks, setBlocks] = useState(() => blockStoreRef.current?.blocks || [])
  const [clipboardPrompt, setClipboardPrompt] = useState<PendingClipboardRequest | null>(null)
  const [attention, setAttention] = useState(false)
  const [notificationText, setNotificationText] = useState('')
  const { updateNode, deleteNode, setSelectedNodeId, commitHistory, theme, activeWorkspace } = useWorkspaceStore()

  const props = data.properties || {}
  const agent = String(props.agent || 'Terminal')
  const cwd = String(props.cwd || '')
  const command = typeof props.command === 'string' ? props.command : ''
  const status = String(props.status || 'starting')
  const richInputEnabled = isRichInputV2Enabled(props.richInputV2)
  const runtimeChip = String(props.runtime || props.nodeVersion || 'v26.7.0')
  const gitSummary = typeof props.gitSummary === 'string' && props.gitSummary.trim() ? props.gitSummary : 'Git · clean'
  const explorerLabel = String(props.explorerLabel || 'File explorer')
  if (!securitySettingsRef.current) securitySettingsRef.current = readTerminalSecuritySettings()
  if (!historyStoreRef.current) historyStoreRef.current = new CommandHistoryStore(id, id)
  if (!blockStoreRef.current) blockStoreRef.current = new TerminalBlockStore()
  const completionQuery = useCallback(async (kind: string, context: { token: string; document: string; from: number; to: number; cwd: string }, signal: AbortSignal) => {
    if (signal.aborted) return []
    try {
      const result = await window.orchestra?.invoke('terminal.complete', {
        sessionId: id,
        kind,
        value: context.token,
        cwd: context.cwd
      }) as { items?: Array<{ label: string; type?: string; detail?: string }> } | undefined
      if (signal.aborted) return []
      return (result?.items || []).map((item) => ({ label: item.label, type: item.type === 'folder' || item.type === 'file' ? 'text' : item.type as 'text' | 'keyword' | 'function' | 'variable' | 'constant' | 'class' | 'interface' | 'module' | 'property' | 'enum' | 'type' | 'namespace' | 'method' | 'event' | 'operator' | undefined, detail: item.detail }))
    } catch {
      return []
    }
  }, [id])
  if (!completionControllerRef.current) {
    completionControllerRef.current = new CompletionController([
      new HistoryCompletionProvider(() => historyStoreRef.current?.entries || []),
      new QueryCompletionProvider('path', 'path', completionQuery, (context) => context.token.includes('/') || /^\s*cd\b/.test(context.document)),
      new QueryCompletionProvider('executable', 'executable', completionQuery, (context) => context.document.trim().split(/\s+/).length <= 1),
      new QueryCompletionProvider('git', 'git', completionQuery, (context) => /^\s*git\b/.test(context.document)),
      new QueryCompletionProvider('npm', 'npm', completionQuery, (context) => /^\s*(npm|pnpm|yarn|bun)\s+run\b/.test(context.document))
    ])
  }
  const provideCompletions = useCallback((context: CompletionContext) => completionControllerRef.current?.provide(context, cwd) || Promise.resolve(null), [cwd])
  const scheduleBlockRender = useCallback(() => {
    if (blockRenderFrameRef.current !== null) return
    blockRenderFrameRef.current = requestAnimationFrame(() => {
      blockRenderFrameRef.current = null
      setBlocks(blockStoreRef.current?.blocks || [])
    })
  }, [])

  const notifyTerminal = (text: string) => {
    setNotificationText(text)
    setAttention(true)
    const settings = securitySettingsRef.current || readTerminalSecuritySettings()
    const shouldNotify = settings.notifications === 'always' || (settings.notifications === 'when-unfocused' && !windowFocusedRef.current)
    if (shouldNotify && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      try { new Notification('Orchesta terminal', { body: text }) } catch { /* visual fallback remains available */ }
    }
    window.setTimeout(() => setNotificationText(''), 5000)
  }

  const queueClipboardDecision = (decision: 'allow-once' | 'allow-always' | 'deny-once' | 'deny-always') => {
    const request = pendingClipboardRef.current
    if (!request) return
    pendingClipboardRef.current = null
    setClipboardPrompt(null)
    if (decision === 'deny-always') {
      const key = request.direction === 'read' ? 'clipboardRead' : 'clipboardWrite'
      const settings = securitySettingsRef.current || readTerminalSecuritySettings()
      settings[key] = 'deny'
      securitySettingsRef.current = settings
      writeTerminalSecuritySettings({ [key]: 'deny' })
    }
    if (decision === 'deny-once' || decision === 'deny-always') return
    if (decision === 'allow-always') {
      const key = request.direction === 'read' ? 'clipboardRead' : 'clipboardWrite'
      const settings = securitySettingsRef.current || readTerminalSecuritySettings()
      settings[key] = 'allow'
      securitySettingsRef.current = settings
      writeTerminalSecuritySettings({ [key]: 'allow' })
    }
    if (request.direction === 'write') {
      if (typeof request.text === 'string') navigator.clipboard?.writeText(request.text).catch(() => undefined)
      return
    }
    navigator.clipboard?.readText().then((text) => {
      void window.orchestra?.invoke('terminal.input', { sessionId: id, data: osc52Response(request.selection, text) }).catch(() => undefined)
    }).catch(() => undefined)
  }

  const requestClipboardPermission = (request: PendingClipboardRequest) => {
    pendingClipboardRef.current = request
    setClipboardPrompt(request)
  }

  const restart = async () => {
    try {
      const safeCwd = resolveTerminalCwd(cwd, activeWorkspace?.path)
      const result = await window.orchestra?.invoke('terminal.spawn', {
        sessionId: id,
        workspaceId: activeWorkspace?.id,
        cwd: safeCwd,
        workspaceRoot: activeWorkspace?.path,
        cols: Math.max(20, xtermInstance.current?.cols || 80),
        rows: Math.max(4, xtermInstance.current?.rows || 24),
        command,
        env: { ORCHESTRA: '1' }
      }) as { status?: string }
      updateNode(id, { properties: { ...props, status: result?.status === 'started' ? 'running' : 'error' } })
    } catch (error) {
      updateNode(id, { properties: { ...props, status: 'error', error: error instanceof Error ? error.message : 'Falha ao reiniciar' } })
    }
  }

  useEffect(() => {
    if (!terminalRef.current || !window.orchestra?.invoke) return
    const activateTerminalUrl = (event: MouseEvent, uri: string) => {
      if (!event.ctrlKey && !event.metaKey) return
      const safeUrl = sanitizeTerminalUrl(uri)
      if (safeUrl) window.orchestra?.openExternalUrl?.(safeUrl)?.catch(() => undefined)
    }
    const term = new Terminal({
      allowProposedApi: true,
      theme: terminalTheme(theme),
      fontFamily: 'JetBrains Mono, monospace',
      fontSize: 13,
      lineHeight: 1.24,
      letterSpacing: 0.1,
      // Long agent sessions commonly exceed ten thousand lines. Keep a
      // generous bounded client buffer so the user can scroll back through
      // build logs without allowing an unbounded DOM/memory growth.
      scrollback: 50000,
      cursorBlink: true,
      cursorStyle: 'bar',
      rightClickSelectsWord: false,
      macOptionIsMeta: true,
      macOptionClickForcesSelection: true,
      scrollOnUserInput: true,
      smoothScrollDuration: 0,
      screenReaderMode: true,
      linkHandler: { activate: activateTerminalUrl }
    })
    const fitAddon = new FitAddon()
    const searchAddon = new SearchAddon()
    const serializeAddon = new SerializeAddon()
    term.loadAddon(fitAddon)
    term.loadAddon(searchAddon)
    term.loadAddon(serializeAddon)
    term.loadAddon(new WebLinksAddon(activateTerminalUrl))
    try {
      term.loadAddon(new Unicode11Addon())
      term.unicode.activeVersion = '11'
    } catch {
      // Unicode fallback remains available on older Chromium builds.
    }
    try {
      term.loadAddon(new WebglAddon())
    } catch {
      // Canvas rendering fallback is safe when WebGL is unavailable.
    }
    term.open(terminalRef.current)
    xtermInstance.current = term
    fitAddonInstance.current = fitAddon
    searchAddonInstance.current = searchAddon
    const removeXtermTransformCompensation = installXtermTransformCompensation(term)
    const directInteractiveCommand = isDirectInteractiveTerminalCommand(command)

    const sendSize = () => {
      if (!sessionReadyRef.current) return
      if (term.cols < 1 || term.rows < 1) return
      const size = `${term.cols}x${term.rows}`
      if (lastSentSizeRef.current === size) return
      lastSentSizeRef.current = size
      window.orchestra?.invoke('terminal.resize', { sessionId: id, cols: term.cols, rows: term.rows }).catch(() => {
        // Permit a later fit to retry after a transient daemon/IPC failure.
        if (lastSentSizeRef.current === size) lastSentSizeRef.current = null
      })
    }
    const fitTerminal = () => {
      fitFrameRef.current = null
      const container = terminalRef.current
      if (!container || container.clientWidth < 2 || container.clientHeight < 2) return
      try {
        fitAddon.fit()
        if (term.cols > 0 && term.rows > 0) sendSize()
      } catch {
        // xterm can be measured before its font is ready; ResizeObserver retries.
      }
    }
    const scheduleFit = () => {
      if (fitFrameRef.current === null) fitFrameRef.current = requestAnimationFrame(fitTerminal)
    }
    const flushOutput = () => {
      outputFrameRef.current = null
      if (!outputQueueRef.current.length) return
      const chunks = outputQueueRef.current
      outputQueueRef.current = []
      const size = chunks.reduce((total, chunk) => total + chunk.length, 0)
      const combined = new Uint8Array(size)
      let offset = 0
      chunks.forEach((chunk) => { combined.set(chunk, offset); offset += chunk.length })
      term.write(combined)
    }
    const enqueueOutput = (bytes: Uint8Array) => {
      if (!bytes.length) return
      outputQueueRef.current.push(bytes)
      if (outputFrameRef.current === null) outputFrameRef.current = requestAnimationFrame(flushOutput)
    }

    const flushInput = () => {
      inputFrameRef.current = null
      if (!sessionReadyRef.current || inputQueueRef.current.length === 0) return
      const text = inputQueueRef.current.join('')
      inputQueueRef.current = []
      window.orchestra?.invoke('terminal.input', { sessionId: id, data: text }).then((result) => {
        const status = result && typeof result === 'object' ? (result as { status?: unknown }).status : undefined
        if (status === 'not_ready' || status === 'not_running') inputQueueRef.current.unshift(text)
      }).catch(() => {
        // Restore the exact ordered chunk so a transient IPC failure does not
        // lose interactive-program input. It will be retried on the next
        // input event or after the session becomes ready again.
        inputQueueRef.current.unshift(text)
      })
    }
    const scheduleInput = () => {
      if (inputFrameRef.current === null) inputFrameRef.current = requestAnimationFrame(flushInput)
    }
    const clearNativeModifiedEnterSuppression = () => {
      suppressNativeModifiedEnterRef.current = false
      if (suppressNativeModifiedEnterTimerRef.current !== null) {
        window.clearTimeout(suppressNativeModifiedEnterTimerRef.current)
        suppressNativeModifiedEnterTimerRef.current = null
      }
    }
    const queuePtyInput = (text: string) => {
      if (!text) return
      inputQueueRef.current.push(text)
      if (sessionReadyRef.current) scheduleInput()
    }
    const queueInput = (text: string) => {
      if (!text) return
      // xterm may report the browser Enter as onData even after a custom key
      // handler has consumed it. Consume that one native byte so the custom
      // protocol sequence is delivered exactly once.
      if (suppressNativeModifiedEnterRef.current && isNativeEnterData(text)) {
        clearNativeModifiedEnterSuppression()
        return
      }
      // A direct agent/TUI can emit an early OSC 133;A while its own prompt
      // is active. That marker must not hand its raw input to the rich shell
      // editor: the command prop remains the authoritative owner for direct
      // launches until the PTY exits.
      if (richInputEnabled && !directInteractiveCommand && interactionModeRef.current === 'shell_prompt') return
      queuePtyInput(text)
    }

    const binaryInput = term.onBinary((data) => {
      if (!sessionReadyRef.current || (richInputEnabled && !directInteractiveCommand && interactionModeRef.current === 'shell_prompt')) return
      const bytes = Uint8Array.from(data, (character) => character.charCodeAt(0) & 0xff)
      let binary = ''
      for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
      void window.orchestra?.invoke('terminal.input', { sessionId: id, dataBase64: btoa(binary) }).catch(() => undefined)
    })

    const flattenCsiParams = (params: unknown[]) => params.flatMap((value) => Array.isArray(value) ? value : [value])
    const kittyKeyboardMode = term.parser.registerCsiHandler({ prefix: '>', final: 'u' }, (params) => {
      const values = flattenCsiParams(params)
      kittyKeyboardProtocolStackRef.current.push(keyboardProtocolRef.current)
      // Kitty's 0/reset request hands control back to the compatibility
      // encoding. A non-zero push means the TUI requested CSI-u key events.
      keyboardProtocolRef.current = values[0] === 0 ? 'modify_other_keys' : 'kitty'
      return false
    })
    const kittyKeyboardSetMode = term.parser.registerCsiHandler({ prefix: '=', final: 'u' }, (params) => {
      const values = flattenCsiParams(params)
      // CSI = flags;action is the non-stacking Kitty form. Any enabled flag
      // means CSI-u; zero restores the compatibility encoding.
      keyboardProtocolRef.current = values[0] === 0 ? 'modify_other_keys' : 'kitty'
      return false
    })
    const kittyKeyboardPopMode = term.parser.registerCsiHandler({ prefix: '<', final: 'u' }, (params) => {
      const values = flattenCsiParams(params)
      const count = Math.max(1, Number(values[0] || 1))
      for (let index = 0; index < count; index += 1) {
        const previous = kittyKeyboardProtocolStackRef.current.pop()
        if (!previous) {
          keyboardProtocolRef.current = 'modify_other_keys'
          break
        }
        keyboardProtocolRef.current = previous
      }
      return false
    })
    const modifyOtherKeysMode = term.parser.registerCsiHandler({ prefix: '>', final: 'm' }, (params) => {
      const values = flattenCsiParams(params)
      // modifyOtherKeys is the legacy compatibility layer. A TUI can leave
      // its legacy mode enabled while Kitty CSI-u is active; that report must
      // not downgrade a negotiated Kitty session and make the next modified
      // Enter disappear from the app's parser.
      if (keyboardProtocolRef.current !== 'kitty' && values[0] === 4 && values[1] !== 0) {
        keyboardProtocolRef.current = 'modify_other_keys'
      }
      return false
    })

    const osc52Handler = term.parser.registerOscHandler(52, (data) => {
      const request = parseOsc52(data)
      if (!request) return true
      const settings = securitySettingsRef.current || readTerminalSecuritySettings()
      if (request.query) {
        if (settings.clipboardRead === 'allow') {
          void navigator.clipboard?.readText().then((text) => {
            // OSC 52 is a terminal protocol response, not user editor input.
            // It must reach the PTY even when the optional rich shell editor
            // currently owns the visible prompt.
            queuePtyInput(osc52Response(request.selection, text))
          }).catch(() => undefined)
        } else if (settings.clipboardRead === 'ask') {
          requestClipboardPermission({ direction: 'read', selection: request.selection })
        }
        return true
      }
      if (settings.clipboardWrite === 'allow') {
        if (typeof request.text === 'string') navigator.clipboard?.writeText(request.text).catch(() => undefined)
      } else if (settings.clipboardWrite === 'ask') {
        requestClipboardPermission({ direction: 'write', selection: request.selection, text: request.text || '' })
      }
      return true
    })

    const fileLinkProvider = term.registerLinkProvider({
      provideLinks: (y, callback) => {
        const line = term.buffer.active.getLine(y - 1)
        const text = line?.translateToString(true) || ''
        const links = detectTerminalFileReferences(text).map((reference) => ({
          text: reference.text,
          range: { start: { x: reference.start + 1, y }, end: { x: reference.end, y } },
          activate: (event: MouseEvent) => {
            if (!event.ctrlKey && !event.metaKey) return
            window.dispatchEvent(new CustomEvent('orchestra:terminal-file-link', {
            detail: { path: reference.path, line: reference.line, column: reference.column, cwd, workspaceId: activeWorkspace?.id }
            }))
          }
        }))
        callback(links)
      }
    })

    const selectionListener = term.onSelectionChange(() => {
      const settings = securitySettingsRef.current || readTerminalSecuritySettings()
      if (settings.copyOnSelect && term.hasSelection()) navigator.clipboard?.writeText(term.getSelection()).catch(() => undefined)
    })
    const bellListener = term.onBell(() => notifyTerminal('O terminal recebeu atenção (BEL)'))
    const windowFocus = () => { windowFocusedRef.current = true; setAttention(false) }
    const windowBlur = () => { windowFocusedRef.current = false }
    window.addEventListener('focus', windowFocus)
    window.addEventListener('blur', windowBlur)
    const pasteGuard = (event: ClipboardEvent) => {
      const text = event.clipboardData?.getData('text/plain') || ''
      if (!/[\r\n]/.test(text) || term.modes.bracketedPasteMode) return
      event.preventDefault()
      event.stopImmediatePropagation()
      queueInput(`\u001b[200~${text.replace(/\r\n?/g, '\n')}\u001b[201~`)
    }
    term.textarea?.addEventListener('paste', pasteGuard, true)
    const forceLocalSelection = (event: MouseEvent) => {
      // xterm.js normally forwards mouse reports once a TUI enables them.
      // Alt-drag is the explicit local-selection escape hatch on Linux and
      // complements macOptionClickForcesSelection on macOS.
      if (event.altKey && term.modes.mouseTrackingMode !== 'none') event.stopPropagation()
    }
    term.element?.addEventListener('mousedown', forceLocalSelection, true)
    const promptFallback = (event: MouseEvent) => {
      if (!event.altKey || richInputEnabled || interactionModeRef.current !== 'shell_prompt' || term.modes.mouseTrackingMode !== 'none') return
      const input = promptFallbackCursorInput(term, event)
      if (!input) return
      event.preventDefault()
      event.stopPropagation()
      queueInput(input)
    }
    term.element?.addEventListener('mousedown', promptFallback, true)

    const applyInteractionMode = (value: unknown, commandExitCode?: number) => {
      const next = typeof value === 'string' ? value as TerminalInteractionMode : 'shell_fallback'
      if (next === interactionModeRef.current) return
      const previous = interactionModeRef.current
      interactionModeRef.current = next
      setInteractionMode(next)
      if (next === 'command_running') {
        if (previous !== 'command_running') runningSinceRef.current = Date.now()
        blockStoreRef.current?.markRunning()
        scheduleBlockRender()
      }
      if (richInputEnabled && next === 'shell_prompt' && previous !== 'shell_prompt') {
        const runningSince = runningSinceRef.current
        if (runningSince !== null) {
          const duration = Date.now() - runningSince
          const settings = securitySettingsRef.current || readTerminalSecuritySettings()
          if (duration >= settings.notificationThresholdMs) notifyTerminal(`Comando concluído em ${(duration / 1000).toFixed(1)}s`)
        }
        runningSinceRef.current = null
        if (activeHistoryIdRef.current) {
          historyStoreRef.current?.finish(activeHistoryIdRef.current, commandExitCode)
          activeHistoryIdRef.current = null
        }
        blockStoreRef.current?.finish(commandExitCode)
        scheduleBlockRender()
        setEditorHandoffPending(false)
        setEditorRevision((revision) => revision + 1)
      }
    }

    let disposed = false
    let reconnectTerminal: (() => void) | null = null
    let reconnectQueued = false

    const observer = new ResizeObserver(scheduleFit)
    observer.observe(terminalRef.current)
    resizeObserverRef.current = observer
    scheduleFit()

    const unsubscribe = window.orchestra.onEvent((event) => {
      const payload = event.payload || {}
      if (event.type === 'core.ready' || event.type === 'core.reconnect') {
        const generation = typeof payload.generation === 'number' ? payload.generation : 0
        const isReconnect = event.type === 'core.reconnect' || payload.reconnect === true || generation > 1
        if (!isReconnect || generation <= lastCoreGenerationRef.current || disposed) return
        lastCoreGenerationRef.current = generation
        if (!spawnStartedRef.current) return
        sessionReadyRef.current = false
        lastSentSizeRef.current = null
        updateNode(id, { properties: { ...props, status: 'starting' } })
        if (terminalLifecycleRef.current) {
          reconnectQueued = true
        } else {
          reconnectTerminal?.()
        }
        return
      }
      if (payload.sessionId !== id) return
      if (event.type === 'terminal.output') {
        if (payload.encoding === 'base64') {
          blockStoreRef.current?.appendOutput(id, String(payload.data || ''))
          scheduleBlockRender()
        }
        enqueueOutput(payload.encoding === 'base64' ? decodeOutput(payload.data) : new TextEncoder().encode(String(payload.data || '')))
      } else if (event.type === 'terminal.state') {
        const process = payload.process as { status?: unknown; exit_code?: unknown } | undefined
        const processStatus = String(payload.processStatus || process?.status || '')
        const session = payload.session as { command_exit_code?: unknown } | undefined
        applyInteractionMode(payload.mode, typeof session?.command_exit_code === 'number' ? session.command_exit_code : undefined)
        if (processStatus === 'running' || processStatus === 'starting') {
          sessionReadyRef.current = true
          updateNode(id, { properties: { ...props, status: 'running' } })
        } else if (processStatus === 'exited' || processStatus === 'disconnected') {
          sessionReadyRef.current = false
          lastSentSizeRef.current = null
          updateNode(id, { properties: { ...props, status: 'exited', exitCode: process?.exit_code } })
        }
      } else if (event.type === 'terminal.exit') {
        sessionReadyRef.current = false
        lastSentSizeRef.current = null
        if (activeHistoryIdRef.current) {
          historyStoreRef.current?.finish(activeHistoryIdRef.current, typeof payload.exitCode === 'number' ? payload.exitCode : undefined)
          activeHistoryIdRef.current = null
        }
        blockStoreRef.current?.finish(typeof payload.exitCode === 'number' ? payload.exitCode : undefined)
        scheduleBlockRender()
        applyInteractionMode('disconnected')
        updateNode(id, { properties: { ...props, status: 'exited', exitCode: payload.exitCode } })
      }
    })

    term.onData(queueInput)
    term.attachCustomKeyEventHandler((event) => {
      // xterm invokes this hook for keypress/keyup as well. A keydown that we
      // handle below can still produce a native keypress in screen-reader
      // mode, so consume the matching follow-up event too.
      const enterKey = event.key === 'Enter' || event.code === 'Enter' || event.code === 'NumpadEnter'
      if (event.type !== 'keydown') {
        if (suppressNativeModifiedEnterRef.current && enterKey && event.type === 'keypress') {
          event.preventDefault()
          return false
        }
        if (suppressNativeModifiedEnterRef.current && enterKey && event.type === 'keyup') {
          clearNativeModifiedEnterSuppression()
        }
        return true
      }
      if (suppressNativeModifiedEnterRef.current && !isMultilineEnter(event)) clearNativeModifiedEnterSuppression()
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'f') {
        event.preventDefault()
        setTerminalSearchOpen(true)
        return false
      }
      const copyShortcut = event.key.toLowerCase() === 'c'
        && !event.altKey
        && ((event.ctrlKey && event.shiftKey) || (event.metaKey && !event.shiftKey))
      if (copyShortcut) {
        if (!term.hasSelection()) return true
        navigator.clipboard?.writeText(term.getSelection()).catch(() => undefined)
        return false
      }
      if (isMultilineEnter(event) && !event.isComposing) {
        // The PTY remains the only editor. Bracketed paste makes a newline
        // part of the current native shell/agent input instead of submitting
        // it. If xterm has not reported bracketed paste, the shell helper
        // still sends one framed LF because zle can interpret readline's
        // Ctrl+V/LF quoted-insert fallback as accept-line. Raw alternate
        // screen programs retain their key semantics unless they explicitly
        // requested bracketed paste.
        event.preventDefault()
        // A directly-created agent has no preceding user-facing shell prompt.
        // Its first state is therefore still ShellFallback while the focused
        // process is already a TUI. Keep direct non-shell launches on the
        // interactive key protocol so Ctrl+Enter follows the same path as
        // `zsh` -> `codex`, even if a wrapper emits an early OSC 133;A.
        // The command prop is the authoritative owner for a direct launch;
        // an initial OSC 133;A emitted by an interactive shell wrapper is not
        // a user-facing prompt while that child process is still running.
        const directInteractive = directInteractiveCommand
        const nativeShellInput = !directInteractive && (interactionModeRef.current === 'shell_prompt' || interactionModeRef.current === 'shell_fallback')
        const sequence = multilineEnterPayload(
          event,
          nativeShellInput ? 'shell' : 'interactive',
          term.modes.bracketedPasteMode,
          keyboardProtocolRef.current
        )
        if (!sequence) return true
        // Arm before queueing. Some Chromium/xterm combinations deliver the
        // native CR before the custom handler returns; either ordering must
        // result in one PTY payload, never a newline plus the custom sequence.
        suppressNativeModifiedEnterRef.current = true
        if (suppressNativeModifiedEnterTimerRef.current !== null) window.clearTimeout(suppressNativeModifiedEnterTimerRef.current)
        suppressNativeModifiedEnterTimerRef.current = window.setTimeout(clearNativeModifiedEnterSuppression, 250)
        queueInput(sequence)
        return false
      }
      return true
    })

    const runLifecycle = (initial: boolean): Promise<void> => {
      if (disposed) return Promise.resolve()
      if (initial) {
        if (spawnStartedRef.current) return Promise.resolve()
        spawnStartedRef.current = true
      } else if (!spawnStartedRef.current) {
        return Promise.resolve()
      }
      if (terminalLifecycleRef.current) return terminalLifecycleRef.current

      let operation: Promise<void>
      operation = (async () => {
        try {
          // Let Chromium lay out xterm before creating the PTY. This avoids a
          // startup race where a TUI receives an arbitrary default width and
          // permanently renders its first screen with broken wrapping.
          await new Promise<void>((resolve) => requestAnimationFrame(() => {
            fitTerminal()
            resolve()
          }))
          try {
            const attached = await window.orchestra?.invoke('terminal.attach', { sessionId: id }) as { status?: string; scrollback?: string; token?: string; state?: { mode?: string } }
            if (attached?.status === 'running') {
              if (disposed) {
                await window.orchestra?.invoke('terminal.detach', { sessionId: id, token: attached.token }).catch(() => undefined)
                return
              }
              applyInteractionMode(attached.state?.mode)
              sessionReadyRef.current = true
              if (attached.scrollback) enqueueOutput(decodeOutput(attached.scrollback))
              sendSize()
              if (inputQueueRef.current.length) scheduleInput()
              updateNode(id, { properties: { ...props, status: 'running' } })
              return
            }
          } catch {
            // A new canvas node has no existing session; create it below.
          }
          const result = await window.orchestra?.invoke('terminal.spawn', {
            sessionId: id,
            workspaceId: activeWorkspace?.id,
            cwd: resolveTerminalCwd(cwd, activeWorkspace?.path),
            workspaceRoot: activeWorkspace?.path,
            // Dimensions are measured from the real xterm before the PTY exists.
            cols: Math.max(20, term.cols),
            rows: Math.max(4, term.rows),
            command,
            env: { ORCHESTRA: '1' }
          }) as { status?: string; token?: string; state?: { mode?: string } }
          if (disposed) {
            await window.orchestra?.invoke('terminal.kill', { sessionId: id, token: result?.token }).catch(() => undefined)
            return
          }
          applyInteractionMode(result?.state?.mode)
          sessionReadyRef.current = true
          sendSize()
          if (inputQueueRef.current.length) scheduleInput()
          updateNode(id, { properties: { ...props, status: result?.status === 'started' ? 'running' : 'error' } })
        } catch (error) {
          if (!disposed) updateNode(id, { properties: { ...props, status: 'error', error: error instanceof Error ? error.message : 'Falha ao iniciar' } })
        }
      })().finally(() => {
        if (terminalLifecycleRef.current === operation) terminalLifecycleRef.current = null
        if (reconnectQueued && !disposed) {
          reconnectQueued = false
          window.setTimeout(() => reconnectTerminal?.(), 0)
        }
      })
      terminalLifecycleRef.current = operation
      return operation
    }

    reconnectTerminal = () => {
      if (disposed || !spawnStartedRef.current) return
      sessionReadyRef.current = false
      lastSentSizeRef.current = null
      if (terminalLifecycleRef.current) {
        reconnectQueued = true
        return
      }
      void runLifecycle(false)
    }

    void runLifecycle(true)

    return () => {
      disposed = true
      unsubscribe()
      binaryInput.dispose()
      kittyKeyboardMode.dispose()
      kittyKeyboardSetMode.dispose()
      kittyKeyboardPopMode.dispose()
      modifyOtherKeysMode.dispose()
      kittyKeyboardProtocolStackRef.current = []
      osc52Handler.dispose()
      fileLinkProvider.dispose()
      selectionListener.dispose()
      bellListener.dispose()
      window.removeEventListener('focus', windowFocus)
      window.removeEventListener('blur', windowBlur)
      term.textarea?.removeEventListener('paste', pasteGuard, true)
      term.element?.removeEventListener('mousedown', forceLocalSelection, true)
      term.element?.removeEventListener('mousedown', promptFallback, true)
      observer.disconnect()
      resizeObserverRef.current = null
      if (outputFrameRef.current !== null) cancelAnimationFrame(outputFrameRef.current)
      if (inputFrameRef.current !== null) cancelAnimationFrame(inputFrameRef.current)
      if (fitFrameRef.current !== null) cancelAnimationFrame(fitFrameRef.current)
      if (blockRenderFrameRef.current !== null) cancelAnimationFrame(blockRenderFrameRef.current)
      if (sessionReadyRef.current) void window.orchestra?.invoke('terminal.detach', { sessionId: id }).catch(() => undefined)
      inputQueueRef.current = []
      suppressNativeModifiedEnterRef.current = false
      if (suppressNativeModifiedEnterTimerRef.current !== null) window.clearTimeout(suppressNativeModifiedEnterTimerRef.current)
      suppressNativeModifiedEnterTimerRef.current = null
      outputQueueRef.current = []
      inputFrameRef.current = null
      fitFrameRef.current = null
      removeXtermTransformCompensation()
      term.dispose()
      xtermInstance.current = null
      searchAddonInstance.current = null
      // PTYs belong to the session manager, not the React component. Closing
      // the node calls deleteNode, which explicitly kills the session; a
      // screen change or StrictMode re-attach must not orphan/kill it.
    }
  }, [id])

  useEffect(() => {
    if (!xtermInstance.current) return
    xtermInstance.current.options.theme = terminalTheme(theme)
  }, [theme])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      try { fitAddonInstance.current?.fit() } catch { /* layout is not ready */ }
    }, 80)
    return () => window.clearTimeout(timer)
  }, [isLifted])

  const chooseAttachments = () => attachmentInputRef.current?.click()

  const handleAttachments = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || [])
    if (!files.length) return
    setAttachments((current) => [
      ...current,
      ...files.map((file) => {
        const localFile = file as File & { path?: string }
        let path = localFile.path
        try { path = window.orchestra?.filePath?.(file) || path }
        catch { /* Browser fallback below keeps the visible file name. */ }
        return { name: file.name, path: path || file.name, size: file.size }
      })
    ])
    event.target.value = ''
  }

  const insertAttachment = (attachment: { name: string; path?: string }) => {
    const location = attachment.path || attachment.name
    const terminal = xtermInstance.current
    if (!terminal || !location) return
    terminal.focus()
    // xterm routes paste through the same PTY input path as normal typing,
    // preserving the native agent/shell cursor and bracketed-paste mode.
    terminal.paste(location)
  }

  const executeRichCommand = async (document: string) => {
    if (!richInputEnabled || !sessionReadyRef.current || interactionModeRef.current !== 'shell_prompt') return
    setEditorHandoffPending(true)
    const historyEntry = historyStoreRef.current?.start(document, {
      cwd: cwd || 'Local',
      shell: String(props.shell || 'shell'),
      workspaceId: activeWorkspace?.id
    })
    activeHistoryIdRef.current = historyEntry?.id || null
    const block = blockStoreRef.current?.begin(id, { command: document, cwd: cwd || 'Local' })
    if (block) setBlocks(blockStoreRef.current?.blocks || [])
    try {
      const result = await window.orchestra?.invoke('terminal.execute', { sessionId: id, data: document }) as { status?: string } | undefined
      if (result?.status === 'not_ready' || result?.status === 'not_running') throw new Error('Terminal indisponível')
      setEditorSeed('')
      // The editor is now out of the keyboard path. Focus xterm immediately so
      // Ctrl+C, readline prompts, and interactive programs receive raw input.
      xtermInstance.current?.focus()
    } catch {
      // Keep the command in the editor when the atomic handoff fails.
      if (historyEntry) historyStoreRef.current?.remove(historyEntry.id)
      activeHistoryIdRef.current = null
      if (block) blockStoreRef.current?.remove(block.id)
      setBlocks(blockStoreRef.current?.blocks || [])
      setEditorHandoffPending(false)
    }
  }

  const getSuggestion = useCallback((document: string) => historyStoreRef.current?.suggestion(document) || '', [])
  const openHistorySearch = useCallback(() => {
    setHistoryEntries(historyStoreRef.current?.entries || [])
    setHistorySearchOpen(true)
  }, [])
  const searchTerminalOutput = useCallback((query: string, direction: 'next' | 'previous' = 'next') => {
    setTerminalSearchQuery(query)
    if (!query) {
      searchAddonInstance.current?.clearDecorations()
      setTerminalSearchFound(null)
      return
    }
    try {
      const found = direction === 'previous'
        ? searchAddonInstance.current?.findPrevious(query, { decorations: { matchOverviewRuler: 'rgba(200, 241, 105, .45)', activeMatchColorOverviewRuler: '#c8f169' } })
        : searchAddonInstance.current?.findNext(query, { decorations: { matchOverviewRuler: 'rgba(200, 241, 105, .45)', activeMatchColorOverviewRuler: '#c8f169' } })
      setTerminalSearchFound(found ?? false)
    } catch {
      setTerminalSearchFound(false)
    }
  }, [])
  const closeTerminalSearch = useCallback(() => {
    setTerminalSearchOpen(false)
    setTerminalSearchQuery('')
    setTerminalSearchFound(null)
    searchAddonInstance.current?.clearDecorations()
    xtermInstance.current?.focus()
  }, [])
  const reinputHistory = useCallback((entry: CommandHistoryEntry) => {
    setEditorSeed(entry.command)
    setEditorRevision((revision) => revision + 1)
    setHistorySearchOpen(false)
  }, [])
  const reinputCommand = useCallback((commandText: string) => {
    setEditorSeed(commandText)
    setEditorRevision((revision) => revision + 1)
    setHistorySearchOpen(false)
  }, [])
  const rerunCommand = (commandText: string) => {
    if (richInputEnabled && interactionModeRef.current === 'shell_prompt' && !editorHandoffPending) {
      void executeRichCommand(commandText)
      return
    }
    reinputCommand(commandText)
  }
  const clearTerminal = () => {
    xtermInstance.current?.clear()
    setAttention(false)
  }
  const sendEditorInput = (data: string) => {
    if (!data || !sessionReadyRef.current) return
    void window.orchestra?.invoke('terminal.input', { sessionId: id, data }).catch(() => undefined)
  }

  return (
    <div className={`node ${isLifted ? 'lifted' : ''}`} style={{ width: '100%', height: '100%', minWidth: 320, minHeight: 220 }} onClick={() => { setSelectedNodeId(id); setAttention(false) }}>
      <NodeResizer isVisible={data.selected} minWidth={320} minHeight={220} handleClassName="nodrag nopan canvas-resize-handle" lineClassName="nodrag nopan canvas-resize-line" onResizeStart={commitHistory} onResize={(_, params) => updateNode(id, { width: params.width, height: params.height })} />
      <Handle type="target" position={Position.Left} className="port left" />
      <Handle type="source" position={Position.Right} className="port right" />
      <div className="mac-terminal">
        <div className="mac-chrome">
          <span className="mac-dot red" /><span className="mac-dot yellow" /><span className="mac-dot green" />
          <div className="mac-title"><strong>{agent}</strong><span>· zsh</span></div>
          <span className={`status ${status === 'running' ? '' : 'wait'} ${attention ? 'attention' : ''}`} title={attention ? (notificationText || 'Terminal requer atenção') : status} />
          <button className="icon-btn mac-action" onClick={(event) => { event.stopPropagation(); setIsLifted(!isLifted); window.dispatchEvent(new CustomEvent('orchestra:focus-node', { detail: { nodeId: id } })) }} title="Focar terminal">{isLifted ? <Minimize2 className="icon" /> : <Maximize2 className="icon" />}</button>
          <button className="icon-btn mac-action" onClick={(event) => { event.stopPropagation(); deleteNode(id) }} title="Fechar terminal"><X className="icon" /></button>
        </div>
        <div className="terminal-chipbar nodrag nopan" onMouseDown={(event) => event.stopPropagation()}>
          <button className="terminal-chip terminal-chip-add" onClick={chooseAttachments} title="Adicionar ficheiro"><Plus className="icon" /></button>
          {attachments.map((attachment, index) => <span className="terminal-chip terminal-chip-file" key={`${attachment.name}-${index}`} role="button" tabIndex={0} onClick={() => insertAttachment(attachment)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); insertAttachment(attachment) } }} title={`Inserir ${attachment.path || attachment.name}`}>
            <Paperclip className="icon" /><span className="terminal-chip-file-name">{attachment.name}</span>
            <button className="terminal-chip-file-remove" type="button" onClick={(event) => { event.stopPropagation(); setAttachments((current) => current.filter((_, itemIndex) => itemIndex !== index)) }} title="Remover ficheiro" aria-label={`Remover ${attachment.name}`}><X className="icon" /></button>
          </span>)}
          <span className="terminal-chip" title="Runtime do terminal"><FileCode2 className="icon" />{runtimeChip}</span>
          <span className="terminal-chip terminal-chip-icon" title="Entrada de voz"><Mic className="icon" /></span>
          <span className="terminal-chip terminal-chip-git" title="Estado do Git"><GitBranch className="icon" />{gitSummary}</span>
          <span className="terminal-chip terminal-chip-explorer" title="Explorador de ficheiros"><FolderOpen className="icon" />{explorerLabel}</span>
        </div>
        <input ref={attachmentInputRef} className="terminal-attachment-input" type="file" multiple onChange={handleAttachments} />
        <div
          className="terminal-viewport nodrag nowheel"
          onMouseDown={(event) => { event.stopPropagation(); xtermInstance.current?.focus() }}
          onContextMenu={(event) => {
            event.preventDefault()
            event.stopPropagation()
            const selected = xtermInstance.current?.getSelection()
            if (selected) navigator.clipboard?.writeText(selected).catch(() => undefined)
            else navigator.clipboard?.readText().then((value) => { xtermInstance.current?.paste(value) }).catch(() => undefined)
          }}
        >
          <TerminalBlockList blocks={blocks} onReinput={reinputCommand} onRerun={rerunCommand} />
          <div ref={terminalRef} className="terminal-body" />
          {notificationText && <div className="terminal-notification" role="status">{notificationText}</div>}
          {clipboardPrompt && <div className="terminal-security-prompt nodrag" role="dialog" aria-label="Permissão de clipboard">
            <strong>{clipboardPrompt.direction === 'write' ? 'Um programa quer escrever no clipboard.' : 'Um programa quer ler o clipboard.'}</strong>
            <span>OSC 52 · {clipboardPrompt.selection || 'c'}</span>
            <div><button type="button" onClick={() => queueClipboardDecision('allow-once')}>Permitir uma vez</button><button type="button" onClick={() => queueClipboardDecision('allow-always')}>Permitir sempre</button><button type="button" onClick={() => queueClipboardDecision('deny-once')}>Bloquear</button><button type="button" onClick={() => queueClipboardDecision('deny-always')}>Bloquear sempre</button></div>
          </div>}
          {richInputEnabled && interactionMode === 'shell_prompt' && !editorHandoffPending && (
            <RichCommandEditor
              key={`${id}:${editorRevision}`}
              initialDocument={editorSeed}
              onExecute={executeRichCommand}
              onClearTerminal={clearTerminal}
              onSendInput={sendEditorInput}
              onHistorySearch={openHistorySearch}
              getSuggestion={getSuggestion}
              provideCompletions={provideCompletions}
            />
          )}
          {terminalSearchOpen && <TerminalSearchOverlay
            query={terminalSearchQuery}
            found={terminalSearchFound}
            onQueryChange={(query) => searchTerminalOutput(query)}
            onNext={() => searchTerminalOutput(terminalSearchQuery, 'next')}
            onPrevious={() => searchTerminalOutput(terminalSearchQuery, 'previous')}
            onClose={closeTerminalSearch}
          />}
          {historySearchOpen && <CommandSearchOverlay entries={historyEntries} onSelect={reinputHistory} onClose={() => setHistorySearchOpen(false)} />}
        </div>
        <div className="node-foot terminal-foot"><span>{cwd || 'Local'}</span><span>{status}</span>{(status === 'exited' || status === 'error') && <button className="terminal-restart" onClick={(event) => { event.stopPropagation(); void restart() }} title="Reiniciar terminal">Reiniciar</button>}</div>
      </div>
    </div>
  )
}
