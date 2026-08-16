import { app, BrowserWindow, WebContentsView, dialog, ipcMain, session, shell } from 'electron'
import path from 'path'
import net from 'net'
import { spawn, ChildProcess } from 'child_process'
import fs from 'fs'
import { randomUUID } from 'crypto'
import { canvasPinchGestureFactor, canvasPinchZoomFactor } from '../renderer/utils/canvasPinchZoom'
import { clampPortalScale, getPortalGeometry, PortalBounds } from '../shared/browserPortalGeometry'

let mainWindow: BrowserWindow | null = null
let coreProcess: ChildProcess | null = null
// Only a process started by this Electron instance may be terminated during
// recovery.  A socket that happens to be present at startup may belong to a
// separately managed Orchestra daemon (or another application) and must be
// treated as external until we have a positive ownership signal.
let ownsCoreDaemon = false
let ownedCoreSocketPath: string | null = null
let coreSpawnInFlight = false
let socketClient: net.Socket | null = null
let socketRetryTimer: ReturnType<typeof setTimeout> | null = null
const MAX_SOCKET_RETRIES = 10
const SOCKET_RETRY_BASE_MS = 250
const SOCKET_RETRY_MAX_MS = 2000
let socketRetryCount = 0
let socketConnectionInFlight = false
const pendingRequests = new Map<string, { resolve: (val: unknown) => void; reject: (err: Error) => void }>()
const terminalTokens = new Map<string, string>()
const pendingTerminalSpawns = new Map<string, Promise<unknown>>()
const pendingTerminalTokenRefreshes = new Map<string, Promise<string | null>>()
const PROTOCOL_VERSION = 2
let coreClientToken: string | null = null
let coreGeneration = 0
let coreReadyResolve: (() => void) | null = null
let coreReadyReject: ((error: Error) => void) | null = null
let coreReadyPromise: Promise<void>
let shutdownStarted = false

interface CoreHelloResponse {
  clientToken: string
  protocolVersion: number
  [key: string]: unknown
}

function isCoreHelloResponse(value: unknown): value is CoreHelloResponse {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return typeof record.clientToken === 'string' && typeof record.protocolVersion === 'number'
}

function atomicWriteFile(filePath: string, contents: string) {
  const directory = path.dirname(filePath)
  fs.mkdirSync(directory, { recursive: true })
  const temporaryPath = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`)
  try {
    fs.writeFileSync(temporaryPath, contents, 'utf-8')
    fs.renameSync(temporaryPath, filePath)
  } catch (error) {
    try { fs.unlinkSync(temporaryPath) } catch { /* best effort cleanup */ }
    throw error
  }
}

function resetCoreReady() {
  coreReadyPromise = new Promise<void>((resolve, reject) => {
    coreReadyResolve = resolve
    coreReadyReject = reject
  })
}

resetCoreReady()

function waitForCore(timeoutMs = 10000): Promise<void> {
  if (coreClientToken && socketClient && !socketClient.destroyed) return Promise.resolve()
  return Promise.race([
    coreReadyPromise,
    new Promise<void>((_, reject) => setTimeout(() => reject(new Error('Core indisponível')), timeoutMs))
  ])
}

function sendCoreRequest(type: string, payload: Record<string, unknown> = {}): Promise<unknown> {
  if (!socketClient || socketClient.destroyed) return Promise.reject(new Error('Core indisponível'))
  const requestId = `req_${Math.random().toString(36).slice(2, 12)}`
  const message = Buffer.from(JSON.stringify({
    protocolVersion: PROTOCOL_VERSION,
    requestId,
    type,
    payload
  }), 'utf-8')
  if (message.length > 8 * 1024 * 1024) return Promise.reject(new Error('Pedido excede o limite do protocolo'))
  const frame = Buffer.allocUnsafe(4 + message.length)
  frame.writeUInt32BE(message.length, 0)
  message.copy(frame, 4)
  return new Promise((resolve, reject) => {
    pendingRequests.set(requestId, { resolve, reject })
    socketClient?.write(frame, (error) => {
      if (error) {
        pendingRequests.delete(requestId)
        reject(error)
      }
    })
    setTimeout(() => {
      if (pendingRequests.has(requestId)) {
        pendingRequests.delete(requestId)
        reject(new Error('Pedido expirou'))
      }
    }, 10000)
  })
}

function isUnauthorizedTerminalError(error: unknown): boolean {
  return error instanceof Error && /unauthorized terminal request|unauthorized terminal attach/i.test(error.message)
}

function terminalUnavailableResult(type: string, sessionId: string): Record<string, unknown> | null {
  if (type === 'terminal.attach') return { status: 'not_running', sessionId }
  if (type === 'terminal.resize') return { success: false, status: 'not_ready', sessionId }
  if (type === 'terminal.kill') return { success: true, status: 'not_running', sessionId }
  if (type === 'terminal.input' || type === 'terminal.detach') {
    return { success: false, status: 'not_running', sessionId }
  }
  // Completion, state and screen requests are also best-effort while a
  // persisted node is waiting for its first attach. Returning a structured
  // result keeps xterm/TUI polling from turning a transient reconnect into a
  // stream of rejected Electron IPC handlers.
  if (type === 'terminal.complete' || type === 'terminal.execute' || type === 'terminal.screen' || type === 'terminal.state') {
    return { success: false, status: 'not_ready', sessionId }
  }
  return { success: false, status: 'not_ready', sessionId }
}

/**
 * A terminal token is scoped to the daemon connection that issued it. When a
 * persisted canvas is served by a newer daemon, use the connection's client
 * token to attach once and replace the stale PTY token. The in-flight map
 * prevents every xterm event from starting its own attach storm.
 */
function refreshTerminalToken(sessionId: string): Promise<string | null> {
  const generation = coreGeneration
  terminalTokens.delete(sessionId)
  const pending = pendingTerminalTokenRefreshes.get(sessionId)
  if (pending) return pending

  let refresh: Promise<string | null>
  refresh = sendCoreRequest('terminal.attach', {
    sessionId,
    clientToken: coreClientToken
  }).then((result) => {
    // A response from the previous socket can arrive after a reconnect. Do
    // not let its PTY token repopulate the map for the new generation.
    if (generation !== coreGeneration) return null
    const record = result && typeof result === 'object' ? result as Record<string, unknown> : null
    const token = typeof record?.token === 'string' ? record.token : null
    if (token) terminalTokens.set(sessionId, token)
    return token
  }).catch(() => null).finally(() => {
    if (pendingTerminalTokenRefreshes.get(sessionId) === refresh) {
      pendingTerminalTokenRefreshes.delete(sessionId)
    }
  })
  pendingTerminalTokenRefreshes.set(sessionId, refresh)
  return refresh
}

async function sendTerminalRequest(
  type: string,
  payload: Record<string, unknown>,
  sessionId?: string
): Promise<unknown> {
  const generation = coreGeneration
  try {
    return await sendCoreRequest(type, payload)
  } catch (error) {
    if (!sessionId || type === 'terminal.spawn' || !isUnauthorizedTerminalError(error)) throw error

    // Reconnects invalidate every PTY token. Let the renderer's reconnect
    // path attach the node on the new socket instead of retrying with a stale
    // generation while the socket is changing underneath this request.
    if (generation !== coreGeneration) {
      return terminalUnavailableResult(type, sessionId) || { success: false, status: 'not_ready', sessionId }
    }

    const token = await refreshTerminalToken(sessionId)
    if (!token) {
      const unavailable = terminalUnavailableResult(type, sessionId)
      if (unavailable) return unavailable
      throw error
    }

    try {
      return await sendCoreRequest(type, {
        ...payload,
        clientToken: coreClientToken,
        token
      })
    } catch (retryError) {
      // The daemon may have rotated its PTY token while the refresh was in
      // flight. Invalidate only this session and let the renderer's next
      // attach recover it; never turn a TUI's polling loop into repeated IPC
      // handler rejections.
      if (isUnauthorizedTerminalError(retryError)) {
        terminalTokens.delete(sessionId)
        return terminalUnavailableResult(type, sessionId) || { success: false, status: 'not_ready', sessionId }
      }
      throw retryError
    }
  }
}

const orchestraWatchers = new Map<string, { root: fs.FSWatcher; notes: fs.FSWatcher }>()
type OrchestraPoller = {
  timer: ReturnType<typeof setInterval>
  snapshot: Map<string, string>
}
// Linux limits the number of inotify instances per user. When the limit is
// reached, fs.watch cannot be opened even though the app is otherwise healthy.
// Keep a slow, bounded fallback alive until the native watcher can be retried;
// this preserves note/context sync instead of silently losing agent access.
const orchestraPollers = new Map<string, OrchestraPoller>()
const lastSyncedNotes = new Map<string, string>()
const ORCHESTRA_POLL_INTERVAL_MS = 2500
const lastSyncedContexts = new Map<string, string>()
const lastWrittenNotes = new Map<string, string>()
const orchestraWatcherRetryAfter = new Map<string, number>()
const orchestraWatcherFailureLogged = new Set<string>()

interface PortalRecord {
  id: string
  view: WebContentsView
  partition: string
  url: string
  console: string[]
  pinchSource: 'wheel' | 'gesture' | null
  pinchResetTimer: ReturnType<typeof setTimeout> | null
  beforeMouseEventAvailable: boolean
  lastWheelSignature: string | null
  lastWheelAt: number
  motionGeneration: number
  // Renderer bounds requests can overlap while ReactFlow is moving or a
  // ResizeObserver is flushing. Keep a second monotonic token so an older
  // request from the same motion generation cannot restore stale geometry.
  boundsRevision: number
  lastVisibleBounds: PortalBounds
  bounds: PortalBounds
  visible: boolean
  frozen: boolean
  zoomFactor: number
  // Browser inspections expose short-lived refs (`@e1`, `@e2`, ...), just like
  // Orca's snapshot loop. Keep the mapping in the main process so agents never
  // have to execute arbitrary page code to turn a ref into a selector.
  refs: Map<string, string>
}

type PortalInspection = {
  url: string
  title: string
  text: string
  links: Array<{ text: string; href: string }>
  accessibility: Array<{
    ref: string
    selector: string
    role: string
    name: string
    disabled: boolean
  }>
}

type JsonObject = Record<string, unknown>

interface ConnectedNote extends JsonObject {
  id: string
  title?: string
  content?: string
}

interface ConnectedTerminal extends JsonObject {
  sessionId: string
  cwd?: string
  agent?: string
  connectedNotes: ConnectedNote[]
  connectedBrowsers: JsonObject[]
  connectedPeerAgents: JsonObject[]
}

function isJsonObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function normalizeContextTerminals(value: unknown): ConnectedTerminal[] {
  const candidates = Array.isArray(value) ? value : [value]
  return candidates.flatMap((candidate) => {
    if (!isJsonObject(candidate) || typeof candidate.sessionId !== 'string' || !candidate.sessionId.trim()) return []
    const notes = Array.isArray(candidate.connectedNotes)
      ? candidate.connectedNotes.filter((note): note is ConnectedNote => isJsonObject(note) && typeof note.id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(note.id))
      : []
    const browsers = Array.isArray(candidate.connectedBrowsers)
      ? candidate.connectedBrowsers.filter(isJsonObject)
      : []
    const peers = Array.isArray(candidate.connectedPeerAgents)
      ? candidate.connectedPeerAgents.filter(isJsonObject)
      : []
    return [{
      ...candidate,
      sessionId: candidate.sessionId.trim(),
      cwd: typeof candidate.cwd === 'string' ? candidate.cwd : undefined,
      agent: typeof candidate.agent === 'string' ? candidate.agent : undefined,
      connectedNotes: notes,
      connectedBrowsers: browsers,
      connectedPeerAgents: peers
    }]
  })
}

const portals = new Map<string, PortalRecord>()
// WebContentsView is composited above the renderer DOM. Keep the desired
// visibility on each portal, but temporarily suppress painting while a modal
// or focus surface owns the UI. A reason set avoids one surface reopening a
// portal while another surface is still active.
const nativePortalSuppressionReasons = new Set<string>()
let portalControlServer: net.Server | null = null
let portalControlSocketPath: string | null = null
let portalControlBoundPath: string | null = null
let portalControlStartInFlight: Promise<void> | null = null
let portalControlStopRequested = false

function applyPortalVisibility(record: PortalRecord): void {
  record.view.setVisible(Boolean(record.visible && nativePortalSuppressionReasons.size === 0))
}

function setPortalTransientVisibility(record: PortalRecord, visible: boolean): void {
  // Temporary compositor surfaces used for screenshots obey the same
  // suppression lease as normal portal visibility.
  record.view.setVisible(Boolean(visible && nativePortalSuppressionReasons.size === 0))
}

function setPortalSuppression(reason: unknown, suppressed: unknown): void {
  const key = typeof reason === 'string' && reason.trim() ? reason.trim() : 'renderer'
  if (suppressed === true) nativePortalSuppressionReasons.add(key)
  else nativePortalSuppressionReasons.delete(key)
  for (const record of portals.values()) applyPortalVisibility(record)
}

function emitPortalEvent(type: string, portalId: string, payload: Record<string, unknown> = {}) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('orchestra:event', { type, payload: { portalId, ...payload } })
  }
}

function normalizePortalUrl(value: string): string {
  const url = value.trim()
  if (!url) return 'about:blank'
  if (/^https?:\/\//i.test(url) || /^about:/i.test(url)) return url
  if (url.includes('.') && !url.includes(' ')) return `https://${url}`
  return `https://search.brave.com/search?q=${encodeURIComponent(url)}`
}

function sanitizeExternalUrl(value: string): string | null {
  try {
    const url = new URL(value.trim())
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) return null
    return url.toString()
  } catch {
    return null
  }
}

type PortalPinchSource = 'wheel' | 'gesture'

const inputModifier = (input: Record<string, unknown>, names: string[]) => {
  const modifiers = Array.isArray(input.modifiers) ? input.modifiers : []
  return modifiers.some((modifier) => names.includes(String(modifier).toLowerCase()))
}

const finiteInputNumber = (input: Record<string, unknown>, key: string) => {
  const value = Number(input[key])
  return Number.isFinite(value) ? value : null
}

/**
 * WebContentsView lives above the renderer DOM. Electron sends its native
 * wheel/gesture packets to `input-event`, not to #workspace. Normalize them
 * here and forward one board-level event; the renderer applies the exact same
 * anchor-preserving viewport math used for terminal/editor surfaces.
 */
function forwardPortalPinch(
  record: PortalRecord,
  inputEvent: Electron.InputEvent,
  inputEventObject: Electron.Event,
  channel: 'before-mouse' | 'input-event' = 'input-event'
) {
  const input = inputEvent as unknown as Record<string, unknown>
  const type = String(input.type || '')
  const isWheel = type === 'mouseWheel'
  const isGesture = type === 'gesturePinchBegin' || type === 'gesturePinchUpdate' || type === 'gesturePinchEnd'
  if (!isWheel && !isGesture) return

  const bounds = record.view.getBounds()
  const localX = finiteInputNumber(input, 'x') ?? bounds.width / 2
  const localY = finiteInputNumber(input, 'y') ?? bounds.height / 2
  const x = bounds.x + localX
  const y = bounds.y + localY
  const source: PortalPinchSource = isWheel ? 'wheel' : 'gesture'
  const phase = type === 'gesturePinchBegin' ? 'begin' : type === 'gesturePinchEnd' ? 'end' : 'update'

  let zoomFactor = 1
  let panX = 0
  let panY = 0
  if (isWheel) {
    const ctrlKey = inputModifier(input, ['ctrl', 'control'])
    const metaKey = inputModifier(input, ['meta', 'command', 'cmd'])
    const altKey = inputModifier(input, ['alt'])
    const deltaX = finiteInputNumber(input, 'deltaX') ?? 0
    const deltaY = finiteInputNumber(input, 'deltaY') ?? 0
    const isHorizontalPan = !ctrlKey && !metaKey && !altKey && deltaX !== 0 && deltaY === 0
    // Once Electron has delivered its documented cancellable mouse path, the
    // later input-event notification is informational only. Handling it too
    // would duplicate every packet (and can be visible as a zoom jump).
    if (channel === 'input-event' && record.beforeMouseEventAvailable) return
    if (!isHorizontalPan && !((ctrlKey || metaKey) && !altKey && (deltaY !== 0 || deltaX !== 0))) return
    // Electron exposes wheel data through both `before-mouse-event` (the
    // cancellable path) and `input-event` on some versions. Suppress the
    // second notification for the same packet, while allowing subsequent
    // packets with the same delta once the compositor has advanced.
    const signature = [localX, localY, deltaY, finiteInputNumber(input, 'deltaX') ?? 0].join(':')
    const now = Date.now()
    if (channel === 'input-event' && record.lastWheelSignature === signature && now - record.lastWheelAt < 12) return
    record.lastWheelSignature = signature
    record.lastWheelAt = now
    panX = deltaX
    if (isHorizontalPan) {
      inputEventObject.preventDefault()
      zoomFactor = 1
    } else {
      inputEventObject.preventDefault()
      zoomFactor = deltaY !== 0
      ? canvasPinchZoomFactor({
          ctrlKey,
          metaKey,
          deltaY,
          deltaMode: finiteInputNumber(input, 'deltaMode') ?? 0
        }, process.platform === 'darwin')
      : 1
    }
  } else {
    // Chromium versions that expose native gesture events have used both
    // `scale` and `zoomFactor` names. Treat either as an incremental factor;
    // if unavailable, fall back to the same delta normalization as wheel.
    inputEventObject.preventDefault()
    if (phase === 'update') {
      const rawFactor = finiteInputNumber(input, 'scale') ?? finiteInputNumber(input, 'zoomFactor')
      const deltaY = finiteInputNumber(input, 'deltaY')
      panX = finiteInputNumber(input, 'deltaX') ?? 0
      zoomFactor = rawFactor !== null
        ? canvasPinchGestureFactor(rawFactor)
        : deltaY !== null && deltaY !== 0
          ? canvasPinchZoomFactor({ deltaY, deltaMode: finiteInputNumber(input, 'deltaMode') ?? 0 }, process.platform === 'darwin')
          : 1
      if (zoomFactor === 1 && rawFactor === null && (deltaY === null || deltaY === 0) && panX === 0) return
    }
  }

  // Some Chromium/Linux combinations expose both a ctrl+wheel stream and a
  // gesture stream for one physical pinch. Lock to whichever source arrived
  // first until the stream is idle/end; never apply both streams.
  if (phase === 'end') {
    if (record.pinchSource && record.pinchSource !== source) return
    if (record.pinchResetTimer) clearTimeout(record.pinchResetTimer)
    record.pinchResetTimer = null
    record.pinchSource = null
  } else {
    if (record.pinchSource && record.pinchSource !== source) return
    record.pinchSource = source
    if (record.pinchResetTimer) clearTimeout(record.pinchResetTimer)
    record.pinchResetTimer = setTimeout(() => {
      record.pinchSource = null
      record.pinchResetTimer = null
    }, 220)
  }

  emitPortalEvent('portal:pinch', record.id, {
    phase,
    source,
    x,
    y,
    zoomFactor,
    panX,
    panY
  })
}

function ensurePortal(portalId: string, requestedUrl: string): PortalRecord {
  const existing = portals.get(portalId)
  if (existing) {
    // Canvas scale is represented by the native view bounds. Repair records
    // created by older builds that accidentally stored that transform as
    // Chromium page zoom.
    if (existing.zoomFactor !== 1) {
      existing.zoomFactor = 1
      try { existing.view.webContents.setZoomFactor(1) } catch { /* teardown race */ }
    }
    return existing
  }
  const partition = `persist:orchestra-portal-${portalId.replace(/[^a-zA-Z0-9_-]/g, '_')}`
  const portalSession = session.fromPartition(partition)
  portalSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
  const view = new WebContentsView({
    webPreferences: {
      partition,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false
    }
  })
  const record: PortalRecord = {
    id: portalId,
    view,
    partition,
    url: normalizePortalUrl(requestedUrl),
    console: [],
    pinchSource: null,
    pinchResetTimer: null,
    beforeMouseEventAvailable: false,
    lastWheelSignature: null,
    lastWheelAt: 0,
    motionGeneration: 0,
    boundsRevision: 0,
    lastVisibleBounds: { x: 0, y: 0, width: 1, height: 1 },
    bounds: { x: 0, y: 0, width: 1, height: 1 },
    visible: false,
    frozen: false,
    zoomFactor: 1,
    refs: new Map()
  }
  portals.set(portalId, record)
  mainWindow?.contentView.addChildView(view)
  applyPortalVisibility(record)
  // before-mouse-event is the cancellable Electron path. It prevents
  // Chromium from scrolling/zooming the page before the board receives the
  // normalized packet. `input-event` remains as a fallback for Electron
  // builds where only that notification is delivered, and for gesture types.
  // Electron 33's type declarations omit the documented event even though
  // Chromium emits it at runtime, so narrow the cast to this one overload.
  const webContentsWithBeforeMouse = view.webContents as unknown as {
    on: (event: 'before-mouse-event', listener: (event: Electron.Event, mouseEvent: Electron.MouseInputEvent) => void) => unknown
  }
  webContentsWithBeforeMouse.on('before-mouse-event', (event, mouseEvent) => {
    if (mouseEvent.type === 'mouseWheel') {
      record.beforeMouseEventAvailable = true
      forwardPortalPinch(record, mouseEvent as Electron.InputEvent, event, 'before-mouse')
    }
  })
  view.webContents.on('input-event', (event, inputEvent) => forwardPortalPinch(record, inputEvent, event, 'input-event'))
  view.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url) || /^about:/i.test(url)) {
      view.webContents.loadURL(normalizePortalUrl(url))
    }
    return { action: 'deny' }
  })
  view.webContents.on('will-navigate', (event, url) => {
    if (!/^https?:\/\//i.test(url) && !/^about:/i.test(url)) event.preventDefault()
  })
  view.webContents.on('did-start-loading', () => {
    clearPortalRefs(record)
    emitPortalEvent('portal:loading', portalId, { loading: true })
  })
  view.webContents.on('did-stop-loading', () => emitPortalEvent('portal:loading', portalId, { loading: false }))
  view.webContents.on('did-navigate', (_event, url) => {
    clearPortalRefs(record)
    record.url = url
    emitPortalEvent('portal:navigation', portalId, { url, canGoBack: view.webContents.navigationHistory.canGoBack(), canGoForward: view.webContents.navigationHistory.canGoForward() })
  })
  view.webContents.on('did-navigate-in-page', (_event, url) => {
    clearPortalRefs(record)
    record.url = url
    emitPortalEvent('portal:navigation', portalId, { url, canGoBack: view.webContents.navigationHistory.canGoBack(), canGoForward: view.webContents.navigationHistory.canGoForward() })
  })
  view.webContents.on('page-title-updated', (_event, title) => emitPortalEvent('portal:title', portalId, { title }))
  view.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    emitPortalEvent('portal:error', portalId, { errorCode, errorDescription, url: validatedURL })
  })
  view.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    const entry = `[${level}] ${message} (${sourceId}:${line})`
    record.console.push(entry)
    if (record.console.length > 200) record.console.splice(0, record.console.length - 200)
    emitPortalEvent('portal:console', portalId, { level, message, line, sourceId })
  })
  view.webContents.loadURL(record.url).catch((error) => emitPortalEvent('portal:error', portalId, { error: String(error) }))
  return record
}

function destroyPortal(portalId: string) {
  const record = portals.get(portalId)
  if (!record) return

  // Remove the record before touching Electron objects. Closing a
  // WebContentsView can synchronously emit navigation/console events and the
  // app's before-quit path may call this function again while those events are
  // unwinding. Making the map removal first makes destruction idempotent.
  portals.delete(portalId)
  if (record.pinchResetTimer) clearTimeout(record.pinchResetTimer)
  record.pinchResetTimer = null
  record.pinchSource = null
  record.beforeMouseEventAvailable = false
  record.lastWheelSignature = null
  record.lastWheelAt = 0
  record.refs.clear()

  // Electron may destroy the window or the view first during app shutdown.
  // Both removeChildView and WebContents.close throw in that race, which used
  // to surface as `TypeError: Object has been destroyed` from main.
  const windowRef = mainWindow
  if (windowRef && !windowRef.isDestroyed()) {
    try { windowRef.contentView.removeChildView(record.view) } catch { /* teardown race */ }
  }
  try {
    const webContents = record.view.webContents
    if (!webContents.isDestroyed()) webContents.close()
  } catch { /* WebContentsView already destroyed */ }
}

function portalGeneration(value: unknown, fallback: number) {
  if (value === undefined || value === null || value === '') return fallback
  const numeric = Number(value)
  return Number.isFinite(numeric) && numeric >= 0 ? Math.floor(numeric) : fallback
}

function portalRevision(value: unknown, fallback: number) {
  if (value === undefined || value === null || value === '') return fallback
  const numeric = Number(value)
  return Number.isFinite(numeric) && numeric >= 0 ? Math.floor(numeric) : fallback
}

/**
 * Accept bounds revisions independently from motion generations. A resize and
 * a resume may legitimately share a generation, but their IPC handlers still
 * complete out of order when Chromium is capturing a portal frame.
 */
function acceptPortalRevision(record: PortalRecord, value: unknown) {
  if (value === undefined || value === null || value === '') return record.boundsRevision
  const revision = portalRevision(value, record.boundsRevision)
  if (revision < record.boundsRevision) return null
  record.boundsRevision = revision
  return revision
}

function portalContentSize() {
  if (!mainWindow || mainWindow.isDestroyed()) return { width: 1, height: 1 }
  const [width, height] = mainWindow.getContentSize()
  return {
    width: Math.max(1, Math.floor(Number(width) || 1)),
    height: Math.max(1, Math.floor(Number(height) || 1))
  }
}

function safePortalBounds(value: unknown) {
  const next = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const viewport = portalContentSize()
  const rawX = Number(next.x)
  const rawY = Number(next.y)
  const rawWidth = Number(next.width)
  const rawHeight = Number(next.height)
  if (![rawX, rawY, rawWidth, rawHeight].every(Number.isFinite) || rawWidth <= 0 || rawHeight <= 0) {
    return {
      bounds: { x: 0, y: 0, width: 1, height: 1 } as PortalBounds,
      fullyInside: false,
      scale: clampPortalScale(next.scale)
    }
  }
  // Do not clamp x/y independently. Intersecting the full rectangle first is
  // what prevents a node at x=-400 from retaining its original 720px width
  // and painting a giant native white view from the window's left edge.
  const geometry = getPortalGeometry(
    { left: rawX, top: rawY, right: rawX + rawWidth, bottom: rawY + rawHeight },
    { left: 0, top: 0, width: viewport.width, height: viewport.height }
  )
  return {
    bounds: geometry.bounds,
    fullyInside: geometry.visible,
    scale: clampPortalScale(next.scale)
  }
}

function acceptPortalGeneration(record: PortalRecord, value: unknown) {
  const generation = portalGeneration(value, record.motionGeneration)
  if (generation < record.motionGeneration) return null
  record.motionGeneration = generation
  return generation
}

function assertPortalSelector(selector: unknown): asserts selector is string {
  if (typeof selector !== 'string' || selector.trim().length === 0 || selector.length > 512) {
    throw new Error('Selector de portal inválido')
  }
}

const PORTAL_INSPECTABLE_SELECTOR = 'a,button,input,textarea,select,[role],[aria-label],[tabindex],[contenteditable]'

function clearPortalRefs(record: PortalRecord): void {
  record.refs.clear()
}

function resolvePortalSelector(record: PortalRecord, selector: unknown): string {
  assertPortalSelector(selector)
  if (!selector.startsWith('@')) return selector
  if (!/^@e[1-9][0-9]*$/.test(selector)) {
    throw new Error('Referência de portal inválida; execute portal inspect novamente')
  }
  const resolved = record.refs.get(selector)
  if (!resolved) {
    throw new Error(`Referência ${selector} expirada; execute portal inspect novamente`)
  }
  return resolved
}

async function inspectPortal(record: PortalRecord): Promise<PortalInspection> {
  const result = await record.view.webContents.executeJavaScript(`(() => {
    const inspectable = ${JSON.stringify(PORTAL_INSPECTABLE_SELECTOR)};
    const selectorFor = (element) => {
      if (element.id && /^[A-Za-z][A-Za-z0-9_:-]*$/.test(element.id) && document.querySelectorAll('#' + element.id).length === 1) {
        return '#' + element.id;
      }
      const parts = [];
      let current = element;
      while (current && current.nodeType === 1 && current !== document.documentElement) {
        let index = 1;
        let sibling = current;
        while ((sibling = sibling.previousElementSibling)) {
          if (sibling.tagName === current.tagName) index += 1;
        }
        parts.unshift(current.tagName.toLowerCase() + ':nth-of-type(' + index + ')');
        current = current.parentElement;
      }
      return parts.join(' > ');
    };
    const elements = Array.from(document.querySelectorAll(inspectable)).filter((element) => {
      if (!(element instanceof Element)) return false;
      const style = window.getComputedStyle(element);
      return style.display !== 'none' && style.visibility !== 'hidden';
    });
    return {
      url: location.href,
      title: document.title,
      text: (document.body?.innerText || '').slice(0, 20000),
      links: Array.from(document.querySelectorAll('a')).slice(0, 100).map((link) => ({
        text: (link.innerText || '').trim().slice(0, 300),
        href: link.href
      })),
      accessibility: elements.slice(0, 200).map((element, index) => ({
        ref: '@e' + (index + 1),
        selector: selectorFor(element),
        role: element.getAttribute('role') || element.tagName.toLowerCase(),
        name: element.getAttribute('aria-label') || element.getAttribute('placeholder') || (element.textContent || '').trim().slice(0, 200),
        disabled: Boolean(element.disabled)
      }))
    };
  })()`, true) as PortalInspection

  clearPortalRefs(record)
  for (const entry of result.accessibility || []) {
    if (typeof entry.ref === 'string' && typeof entry.selector === 'string') {
      record.refs.set(entry.ref, entry.selector)
    }
  }
  return result
}

async function clickPortal(record: PortalRecord, selector: unknown) {
  const resolvedSelector = resolvePortalSelector(record, selector)
  const encodedSelector = JSON.stringify(resolvedSelector)
  return record.view.webContents.executeJavaScript(`(() => {
    const element = document.querySelector(${encodedSelector});
    if (!element) throw new Error('Elemento não encontrado');
    element.scrollIntoView({ block: 'center', inline: 'center' });
    element.focus?.();
    element.click();
    return true;
  })()`, true)
    .then((value) => {
      // A click can re-render a SPA without a full navigation. Force the next
      // action through a fresh snapshot instead of reusing a stale ref.
      clearPortalRefs(record)
      return value
    })
}

async function typePortal(record: PortalRecord, selector: unknown, text: unknown) {
  const resolvedSelector = resolvePortalSelector(record, selector)
  if (typeof text !== 'string' || text.length > 10000) throw new Error('Texto de portal inválido')
  const encodedSelector = JSON.stringify(resolvedSelector)
  const encodedText = JSON.stringify(text)
  return record.view.webContents.executeJavaScript(`(() => {
    const element = document.querySelector(${encodedSelector});
    if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLElement && element.isContentEditable)) throw new Error('Elemento não editável');
    element.focus();
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      const setter = Object.getOwnPropertyDescriptor(element instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype, 'value')?.set;
      setter?.call(element, ${encodedText});
    } else {
      element.textContent = ${encodedText};
    }
    element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ${encodedText} }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`, true).then((value) => {
    clearPortalRefs(record)
    return value
  })
}

function portalCaptureSize(record: PortalRecord): { width: number; height: number } {
  const current = record.view.getBounds()
  const windowSize = portalContentSize()
  // A portal is commonly hidden at 1x1 while a modal or motion lease owns the
  // renderer. Preserve the last real node viewport for screenshots instead of
  // falling back to the whole window (or Chromium's full document size).
  const fallback = record.lastVisibleBounds
  const width = record.visible && current.width > 1
    ? current.width
    : fallback.width > 1
      ? fallback.width
      : current.width > 1
        ? current.width
        : Math.min(windowSize.width, 1280)
  const height = record.visible && current.height > 1
    ? current.height
    : fallback.height > 1
      ? fallback.height
      : current.height > 1
        ? current.height
        : Math.min(windowSize.height, 800)
  return { width: Math.max(1, Math.floor(width)), height: Math.max(1, Math.floor(height)) }
}

async function withPortalTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('Captura do portal expirou')), timeoutMs)
      })
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

async function capturePortalOffscreen(record: PortalRecord, captureSize: { width: number; height: number }): Promise<string> {
  // A WebContentsView can be fully loaded yet have no compositor surface when
  // it is hidden behind a modal or while a canvas motion lease is active. Use a
  // short-lived offscreen BrowserWindow with the same persistent partition as
  // a compositor-backed fallback. Cookies and local storage remain shared,
  // while no native child is ever painted over the user's window.
  const offscreenWindow = new BrowserWindow({
    show: false,
    width: captureSize.width,
    height: captureSize.height,
    webPreferences: {
      partition: record.partition,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      offscreen: true
    }
  })
  let debuggerAttachedHere = false
  try {
    await withPortalTimeout(offscreenWindow.loadURL(record.url), 10000)
    const webContents = offscreenWindow.webContents
    webContents.invalidate()
    if (!webContents.debugger.isAttached()) {
      webContents.debugger.attach('1.3')
      debuggerAttachedHere = true
    }
    await new Promise((resolve) => setTimeout(resolve, 80))
    const metrics = await withPortalTimeout(
      webContents.debugger.sendCommand('Page.getLayoutMetrics') as Promise<{
        cssVisualViewport?: { clientWidth?: number; clientHeight?: number }
      }>,
      8000
    )
      // The page's document size can be thousands of pixels tall. A portal
      // screenshot must match the node viewport, not the page's scrollable
    // scrollable content. Clamp to the compositor viewport when Chromium
    // reports it, otherwise use the explicit offscreen window size.
    const visualViewport = metrics.cssVisualViewport
    const width = Number.isFinite(visualViewport?.clientWidth) && (visualViewport?.clientWidth || 0) > 0
      ? Math.min(captureSize.width, Math.ceil(visualViewport!.clientWidth!))
      : captureSize.width
    const height = Number.isFinite(visualViewport?.clientHeight) && (visualViewport?.clientHeight || 0) > 0
      ? Math.min(captureSize.height, Math.ceil(visualViewport!.clientHeight!))
      : captureSize.height
    const response = await withPortalTimeout(
      webContents.debugger.sendCommand('Page.captureScreenshot', {
        format: 'png',
        fromSurface: true,
        captureBeyondViewport: false,
        clip: { x: 0, y: 0, width, height, scale: 1 }
      }) as Promise<{ data?: string }>,
      8000
    )
    if (!response?.data) throw new Error('O compositor offscreen devolveu uma imagem vazia')
    return `data:image/png;base64,${response.data}`
  } finally {
    if (debuggerAttachedHere && !offscreenWindow.isDestroyed() && offscreenWindow.webContents.debugger.isAttached()) {
      try { offscreenWindow.webContents.debugger.detach() } catch { /* teardown race */ }
    }
    if (!offscreenWindow.isDestroyed()) offscreenWindow.destroy()
  }
}

async function screenshotPortal(record: PortalRecord): Promise<string> {
  const webContents = record.view.webContents
  const originalBounds = record.view.getBounds()
  const captureSize = portalCaptureSize(record)
  const isNativeVisible = Boolean(record.visible && nativePortalSuppressionReasons.size === 0)
  const needsTemporaryViewport = originalBounds.width <= 1 || originalBounds.height <= 1 || !isNativeVisible
  const temporaryBounds = { x: -captureSize.width, y: -captureSize.height, ...captureSize }
  if (needsTemporaryViewport) {
    // Chromium may return an empty image for a hidden WebContentsView. Give it
    // a real compositor surface briefly, but place that surface entirely
    // outside the app viewport so a modal can never flash a page over the UI.
    // The desired portal visibility/bounds are restored in the finally block.
    record.view.setBounds(temporaryBounds)
    // A modal/screen suppression is a hard invariant: do not briefly reveal a
    // native child above its DOM overlay just to obtain a screenshot. The
    // offscreen BrowserWindow fallback remains compositor-backed.
    setPortalTransientVisibility(record, true)
  }

  try {
    try {
      webContents.invalidate()
    } catch {
      // Repaint is best-effort; CDP can still capture a loaded document.
    }

    let debuggerAttachedHere = false
    try {
      if (!webContents.debugger.isAttached()) {
        webContents.debugger.attach('1.3')
        debuggerAttachedHere = true
      }
      await new Promise((resolve) => setTimeout(resolve, 40))
      const metrics = await withPortalTimeout(
        webContents.debugger.sendCommand('Page.getLayoutMetrics') as Promise<{
          cssVisualViewport?: { clientWidth?: number; clientHeight?: number }
        }>,
        8000
      )
      // Never use the entire scrollable document here: long pages otherwise
      // render with the wrong aspect/size.
      const visualViewport = metrics.cssVisualViewport
      const width = Number.isFinite(visualViewport?.clientWidth) && (visualViewport?.clientWidth || 0) > 0
        ? Math.min(captureSize.width, Math.ceil(visualViewport!.clientWidth!))
        : captureSize.width
      const height = Number.isFinite(visualViewport?.clientHeight) && (visualViewport?.clientHeight || 0) > 0
        ? Math.min(captureSize.height, Math.ceil(visualViewport!.clientHeight!))
        : captureSize.height
      const response = await withPortalTimeout(
        webContents.debugger.sendCommand('Page.captureScreenshot', {
          format: 'png',
          fromSurface: true,
          captureBeyondViewport: false,
          clip: { x: 0, y: 0, width, height, scale: 1 }
        }) as Promise<{ data?: string }>,
        8000
      )
      if (response?.data) {
        return `data:image/png;base64,${response.data}`
      }
    } catch {
      // Fall back to Electron's native capture below. Some Chromium builds do
      // not allow a second debugger attachment while DevTools is open.
    } finally {
      if (debuggerAttachedHere && webContents.debugger.isAttached()) {
        try { webContents.debugger.detach() } catch { /* teardown race */ }
      }
    }

    const image = await withPortalTimeout(
      webContents.capturePage({ x: 0, y: 0, width: captureSize.width, height: captureSize.height }),
      8000
    )
    if (!image.isEmpty()) {
      const bytes = image.toPNG()
      if (bytes.length > 0) return `data:image/png;base64,${bytes.toString('base64')}`
    }
    return await capturePortalOffscreen(record, captureSize)
  } finally {
    if (needsTemporaryViewport) {
      // A drag/resize can arrive while CDP is capturing. Only restore the
      // temporary bounds if this request still owns them; otherwise restoring
      // the stale snapshot would jump the portal back over the user's latest
      // position.
      const currentBounds = record.view.getBounds()
      const stillTemporary = currentBounds.x === temporaryBounds.x &&
        currentBounds.y === temporaryBounds.y &&
        currentBounds.width === temporaryBounds.width &&
        currentBounds.height === temporaryBounds.height
      if (stillTemporary) record.view.setBounds(originalBounds)
      applyPortalVisibility(record)
    }
  }
}

function canonicalOrchestraDir(orchestraDir: string): string {
  const resolved = path.resolve(orchestraDir)
  try { return fs.realpathSync(resolved) } catch { return resolved }
}

function processOrchestraChange(
  watchRoot: string,
  baseDir: string,
  filename: string | Buffer | null
) {
  if (!filename) return
  const name = filename.toString()
  if (name.includes('canvas_context.json')) {
    try {
      const filePath = path.join(watchRoot, 'canvas_context.json')
      if (!fs.existsSync(filePath)) return
      const raw = fs.readFileSync(filePath, 'utf-8')
      if (raw === lastSyncedContexts.get(watchRoot)) return

      const parsed = JSON.parse(raw)
      lastSyncedContexts.set(watchRoot, raw)

      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('orchestra:event', {
          type: 'orchestra:canvas-external-update',
          payload: parsed
        })
      }
    } catch (err) {
      console.error('Failed to process watched canvas_context.json:', err)
    }
  } else if (name.endsWith('.md')) {
    try {
      const filePath = path.join(baseDir, name)
      if (!fs.existsSync(filePath)) return
      const content = fs.readFileSync(filePath, 'utf-8')
      if (content === lastSyncedNotes.get(filePath)) return
      lastSyncedNotes.set(filePath, content)
      const noteId = path.basename(name, '.md')
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('orchestra:event', {
          type: 'orchestra:note-external-update',
          payload: { id: noteId, content }
        })
      }
    } catch (err) {
      console.error('Failed to process watched note:', err)
    }
  }
}

function primeOrchestraPollSnapshot(watchRoot: string, snapshot: Map<string, string>) {
  const contextPath = path.join(watchRoot, 'canvas_context.json')
  try {
    if (fs.existsSync(contextPath)) snapshot.set(contextPath, fs.readFileSync(contextPath, 'utf-8'))
  } catch { /* the next poll retries a transient read */ }
  const notesDir = path.join(watchRoot, 'notes')
  try {
    for (const entry of fs.readdirSync(notesDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue
      const filePath = path.join(notesDir, entry.name)
      try { snapshot.set(filePath, fs.readFileSync(filePath, 'utf-8')) } catch { /* retry later */ }
    }
  } catch { /* notes directory may be created concurrently */ }
}

function pollOrchestraDirectory(watchRoot: string, snapshot: Map<string, string>) {
  const contextPath = path.join(watchRoot, 'canvas_context.json')
  try {
    if (fs.existsSync(contextPath)) {
      const raw = fs.readFileSync(contextPath, 'utf-8')
      if (snapshot.get(contextPath) !== raw) {
        snapshot.set(contextPath, raw)
        processOrchestraChange(watchRoot, watchRoot, 'canvas_context.json')
      }
    }
  } catch { /* keep the fallback alive through transient writes */ }

  const notesDir = path.join(watchRoot, 'notes')
  try {
    const seen = new Set<string>()
    for (const entry of fs.readdirSync(notesDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue
      const filePath = path.join(notesDir, entry.name)
      seen.add(filePath)
      try {
        const content = fs.readFileSync(filePath, 'utf-8')
        if (snapshot.get(filePath) !== content) {
          snapshot.set(filePath, content)
          processOrchestraChange(watchRoot, notesDir, entry.name)
        }
      } catch { /* retry the individual note next interval */ }
    }
    for (const filePath of snapshot.keys()) {
      if (filePath.startsWith(`${notesDir}${path.sep}`) && !seen.has(filePath)) snapshot.delete(filePath)
    }
  } catch { /* keep the fallback alive through transient directory errors */ }
}

function stopOrchestraPoller(watchRoot: string) {
  const poller = orchestraPollers.get(watchRoot)
  if (!poller) return
  clearInterval(poller.timer)
  orchestraPollers.delete(watchRoot)
}

function startOrchestraPoller(orchestraDir: string) {
  const watchRoot = canonicalOrchestraDir(orchestraDir)
  if (orchestraPollers.has(watchRoot)) return
  try { fs.mkdirSync(path.join(watchRoot, 'notes'), { recursive: true }) } catch { /* retry in interval */ }
  const snapshot = new Map<string, string>()
  primeOrchestraPollSnapshot(watchRoot, snapshot)
  const timer = setInterval(() => {
    if (shutdownStarted) {
      stopOrchestraPoller(watchRoot)
      return
    }
    pollOrchestraDirectory(watchRoot, snapshot)
    // Native fs.watch is preferred. Once the retry window opens, setup can
    // atomically replace this poller and clear the interval on success.
    if (!orchestraWatchers.has(watchRoot) && (orchestraWatcherRetryAfter.get(watchRoot) || 0) <= Date.now()) {
      setupOrchestraWatcher(watchRoot)
    }
  }, ORCHESTRA_POLL_INTERVAL_MS)
  timer.unref?.()
  orchestraPollers.set(watchRoot, { timer, snapshot })
}

function rememberOrchestraWatcherFailure(orchestraDir: string, error: unknown) {
  const code = error && typeof error === 'object' && 'code' in error
    ? String((error as NodeJS.ErrnoException).code || '')
    : ''
  const retryDelay = code === 'EMFILE' || code === 'ENFILE' ? 30_000 : 5_000
  orchestraWatcherRetryAfter.set(orchestraDir, Date.now() + retryDelay)
  if (code === 'EMFILE' || code === 'ENFILE') startOrchestraPoller(orchestraDir)
  if (!orchestraWatcherFailureLogged.has(orchestraDir)) {
    orchestraWatcherFailureLogged.add(orchestraDir)
    console.warn(`Failed to setup fs.watch on .orchestra (${code || 'unknown'}); retrying after backoff: ${orchestraDir}`)
  }
}

function setupOrchestraWatcher(orchestraDir: string) {
  const watchRoot = canonicalOrchestraDir(orchestraDir)
  if (orchestraWatchers.has(watchRoot)) return
  const retryAfter = orchestraWatcherRetryAfter.get(watchRoot) || 0
  if (retryAfter > Date.now()) return

  let rootWatcher: fs.FSWatcher | null = null
  let notesWatcher: fs.FSWatcher | null = null
  try {
    const handleChange = (baseDir: string, _eventType: fs.WatchEventType, filename: string | Buffer | null) => {
      processOrchestraChange(watchRoot, baseDir, filename)
    }
    const notesDir = path.join(watchRoot, 'notes')
    fs.mkdirSync(notesDir, { recursive: true })
    rootWatcher = fs.watch(watchRoot, handleChange.bind(null, watchRoot))
    notesWatcher = fs.watch(notesDir, handleChange.bind(null, notesDir))
    const watchers = { root: rootWatcher, notes: notesWatcher }
    orchestraWatchers.set(watchRoot, watchers)
    stopOrchestraPoller(watchRoot)
    orchestraWatcherRetryAfter.delete(watchRoot)
    orchestraWatcherFailureLogged.delete(watchRoot)
    const handleWatcherError = (error: unknown) => {
      if (orchestraWatchers.get(watchRoot) !== watchers) return
      watchers.root.close()
      watchers.notes.close()
      orchestraWatchers.delete(watchRoot)
      rememberOrchestraWatcherFailure(watchRoot, error)
    }
    rootWatcher.on('error', handleWatcherError)
    notesWatcher.on('error', handleWatcherError)
  } catch (err) {
    // If opening the second watcher fails, never leave the first one behind.
    // EMFILE/ENFILE is deliberately rate-limited so a renderer update cannot
    // turn descriptor pressure into a tight watcher creation loop.
    rootWatcher?.close()
    notesWatcher?.close()
    orchestraWatchers.delete(watchRoot)
    rememberOrchestraWatcherFailure(watchRoot, err)
  }
}



if (process.env.VITE_DEV_SERVER_URL) {
  // Remote DevTools is deliberately opt-in. A fixed, always-on port caused
  // bind collisions with other Electron apps and exposed an unnecessary
  // inspection endpoint during every `npm run dev` session. Use `0` for a
  // Chromium-assigned free port or an explicit 1024-65535 port.
  const configuredDevToolsPort = process.env.ORCHESTRA_DEVTOOLS_PORT?.trim()
  if (configuredDevToolsPort) {
    const devToolsPort = Number(configuredDevToolsPort)
    const validDevToolsPort = /^\d+$/.test(configuredDevToolsPort)
      && Number.isInteger(devToolsPort)
      && (devToolsPort === 0 || (devToolsPort >= 1024 && devToolsPort <= 65535))
    if (validDevToolsPort) {
      app.commandLine.appendSwitch('remote-debugging-port', String(devToolsPort))
    } else {
      console.warn('Ignoring invalid ORCHESTRA_DEVTOOLS_PORT; expected 0 or an integer between 1024 and 65535')
    }
  }
}

function getSocketPath(): string {
  if (process.env.ORCHESTRA_SOCKET) return process.env.ORCHESTRA_SOCKET
  const runtimeDir = process.env.XDG_RUNTIME_DIR
  if (runtimeDir) {
    return path.join(runtimeDir, 'orchestra', 'orchestra.sock')
  }
  return '/tmp/orchestra.sock'
}

function getPortalControlSocketPath(): string {
  // A terminal may carry an explicit instance endpoint from its launcher.
  // Honour it on the Desktop side as well as in the CLI/PTY environment;
  // otherwise the daemon advertises one portal socket while the bridge
  // listens on another, producing a misleading "socket not found" error.
  const configured = process.env.ORCHESTRA_PORTAL_SOCKET?.trim()
  if (configured) return path.resolve(configured)

  // The old dirname-based `portal.sock` was shared by every dev instance
  // whose core socket lived in the same directory (`/tmp`, for example).
  // Derive the control endpoint from the exact core endpoint instead.
  const coreSocketPath = path.resolve(getSocketPath())
  return coreSocketPath.endsWith('.sock')
    ? `${coreSocketPath.slice(0, -'.sock'.length)}.portal.sock`
    : `${coreSocketPath}.portal.sock`
}

type PortalControlRequest = {
  requestId?: string
  type?: string
  token?: string
  payload?: Record<string, unknown>
}

function portalControlFrame(value: unknown): Buffer {
  const encoded = Buffer.from(JSON.stringify(value), 'utf8')
  if (encoded.length > 16 * 1024 * 1024) throw new Error('Portal response exceeds the frame limit')
  const frame = Buffer.allocUnsafe(4 + encoded.length)
  frame.writeUInt32BE(encoded.length, 0)
  encoded.copy(frame, 4)
  return frame
}

async function dispatchPortalControl(type: string, payload: Record<string, unknown>): Promise<unknown> {
  if (type === 'portal.list') {
    return Array.from(portals.values()).map((record) => ({
      portalId: record.id,
      url: record.url,
      partition: record.partition,
      bounds: record.bounds,
      visible: record.visible,
      frozen: record.frozen,
      generation: record.motionGeneration,
      revision: record.boundsRevision,
      zoomFactor: record.zoomFactor
    }))
  }

  if (type === 'portal.open') {
    const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : ''
    const terminalToken = typeof payload.authToken === 'string' ? payload.authToken : ''
    if (!sessionId || !terminalToken) throw new Error('Portal open requer uma sessão de terminal autenticada')
    const url = normalizePortalUrl(typeof payload.url === 'string' ? payload.url : 'about:blank')
    const portalId = typeof payload.portalId === 'string' && payload.portalId.trim()
      ? payload.portalId.trim()
      : `browser_${randomUUID()}`
    await waitForCore()
    const context = await sendCoreRequest('canvas.node.context', {
      sessionId,
      token: terminalToken,
      clientToken: coreClientToken
    }) as Record<string, unknown>
    const record = ensurePortal(portalId, url)
    const node = {
      id: portalId,
      floorId: context.floorId ?? null,
      kind: 'browser',
      x: Number(context.x || 0) + Number(context.width || 520) + 96,
      y: Number(context.y || 0),
      width: 720,
      height: 460,
      z_index: 1,
      locked: false,
      collapsed: false,
      properties: {
        title: 'Browser Portal',
        url: record.url,
        portalId,
        cwd: typeof (context.properties as Record<string, unknown> | undefined)?.cwd === 'string'
          ? (context.properties as Record<string, unknown>).cwd
          : ''
      }
    }
    const workspaceId = String(context.workspaceId || '')
    try {
      await sendCoreRequest('canvas.node.save', { workspaceId, floorId: context.floorId ?? null, node, clientToken: coreClientToken })
      await sendCoreRequest('canvas.edge.save', {
        workspaceId,
        floorId: context.floorId ?? null,
        edge: {
          id: `e_${sessionId}_${portalId}`,
          floorId: context.floorId ?? null,
          source: sessionId,
          target: portalId,
          label: 'connected',
          permissions: ['inspect', 'navigate', 'control', 'screenshot']
        },
        clientToken: coreClientToken
      })
    } catch (error) {
      destroyPortal(portalId)
      throw error
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('orchestra:event', { type: 'canvas.external-change', payload: { workspaceId, nodeId: portalId } })
    }
    return { portalId, nodeId: portalId, workspaceId, connectedTo: sessionId, url: record.url, visible: true }
  }

  const portalId = typeof payload.portalId === 'string' ? payload.portalId : ''
  if (!portalId) throw new Error('Portal id obrigatório')
  if (type === 'portal.ensure') {
    const record = ensurePortal(portalId, typeof payload.url === 'string' ? payload.url : 'about:blank')
    return { portalId: record.id, url: record.url, generation: record.motionGeneration }
  }
  const record = portals.get(portalId)
  if (!record) throw new Error('Portal não encontrado')
  const permission = type === 'portal.inspect' || type === 'portal.console'
    ? 'inspect'
    : type === 'portal.navigate'
      ? 'navigate'
      : type === 'portal.screenshot'
        ? 'screenshot'
        : type === 'portal.click' || type === 'portal.type'
          ? 'control'
          : null
  if (permission) {
    const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : ''
    const terminalToken = typeof payload.authToken === 'string' ? payload.authToken : ''
    if (!sessionId || !terminalToken) throw new Error('Portal CLI requer uma sessão de terminal autenticada')
    await waitForCore()
    await sendCoreRequest('portal.authorize', {
      sessionId,
      token: terminalToken,
      portalId,
      permission,
      clientToken: coreClientToken
    })
  }
  if (type === 'portal.inspect') return inspectPortal(record)
  if (type === 'portal.click') return clickPortal(record, payload.selector)
  if (type === 'portal.type') return typePortal(record, payload.selector, payload.text)
  if (type === 'portal.screenshot') return { data: await screenshotPortal(record) }
  if (type === 'portal.console') return record.console
  if (type === 'portal.navigate') {
    const url = normalizePortalUrl(typeof payload.url === 'string' ? payload.url : 'about:blank')
    record.url = url
    await record.view.webContents.loadURL(url)
    return { url }
  }
  if (type === 'portal.action') {
    const action = payload.action
    if (action === 'back' && record.view.webContents.navigationHistory.canGoBack()) record.view.webContents.goBack()
    else if (action === 'forward' && record.view.webContents.navigationHistory.canGoForward()) record.view.webContents.goForward()
    else if (action === 'reload') record.view.webContents.reload()
    else if (action === 'stop') record.view.webContents.stop()
    else throw new Error('Ação de portal inválida')
    return { url: record.url }
  }
  if (type === 'portal.destroy') {
    destroyPortal(portalId)
    return { ok: true }
  }
  throw new Error(`Comando de portal desconhecido: ${type}`)
}

function probeUnixSocket(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (active: boolean) => {
      if (settled) return
      settled = true
      resolve(active)
    }
    const probe = net.createConnection(socketPath)
    const timer = setTimeout(() => {
      probe.destroy()
      finish(false)
    }, 250)
    probe.once('connect', () => {
      clearTimeout(timer)
      probe.destroy()
      finish(true)
    })
    probe.once('error', () => {
      clearTimeout(timer)
      probe.destroy()
      finish(false)
    })
  })
}

async function startPortalControlServer() {
  if (portalControlServer) return
  if (portalControlStartInFlight) return portalControlStartInFlight
  portalControlStopRequested = false
  portalControlStartInFlight = (async () => {
    const socketPath = getPortalControlSocketPath()
    portalControlSocketPath = socketPath
    try {
      fs.mkdirSync(path.dirname(socketPath), { recursive: true })
      // A stale socket from this app may be removed, but an active endpoint
      // belongs to another instance and must never be unlinked underneath it.
      if (fs.existsSync(socketPath)) {
        const socketStat = fs.lstatSync(socketPath)
        if (!socketStat.isSocket()) {
          console.error(`O caminho do socket de portais já existe e não é um socket: ${socketPath}`)
          portalControlSocketPath = null
          return
        }
        if (await probeUnixSocket(socketPath)) {
          console.error(`Socket de portais já está em uso: ${socketPath}`)
          portalControlSocketPath = null
          return
        }
        try { fs.unlinkSync(socketPath) } catch (error) {
          console.error('Não foi possível remover socket de portais obsoleto:', error)
          portalControlSocketPath = null
          return
        }
      }
    } catch (error) {
      console.error('Não foi possível preparar o socket de portais:', error)
      portalControlSocketPath = null
      return
    }
    if (portalControlStopRequested || shutdownStarted) {
      portalControlSocketPath = null
      return
    }
    const controlToken = randomUUID()
    const server = net.createServer((socket) => {
    let buffer = Buffer.alloc(0)
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      while (buffer.length >= 4) {
        const length = buffer.readUInt32BE(0)
        if (length === 0 || length > 16 * 1024 * 1024) {
          socket.destroy()
          return
        }
        if (buffer.length < length + 4) return
        const frame = buffer.subarray(4, length + 4)
        buffer = buffer.subarray(length + 4)
        let request: PortalControlRequest
        try {
          request = JSON.parse(frame.toString('utf8')) as PortalControlRequest
        } catch {
          socket.write(portalControlFrame({ ok: false, error: 'JSON inválido' }))
          continue
        }
        const requestId = typeof request.requestId === 'string' ? request.requestId : ''
        const type = typeof request.type === 'string' ? request.type : ''
        if (type === 'portal.hello') {
          socket.write(portalControlFrame({ requestId, ok: true, result: { protocolVersion: PROTOCOL_VERSION, token: controlToken } }))
          continue
        }
        if (request.token !== controlToken) {
          socket.write(portalControlFrame({ requestId, ok: false, error: 'Portal control não autenticado' }))
          continue
        }
        void dispatchPortalControl(type, request.payload || {})
          .then((result) => socket.write(portalControlFrame({ requestId, ok: true, result })))
          .catch((error) => socket.write(portalControlFrame({ requestId, ok: false, error: error instanceof Error ? error.message : String(error) })))
      }
    })
    })
    portalControlServer = server
    server.on('error', (error) => {
      console.error('Portal control socket error:', error)
      // If another instance won the race after our probe, do not unlink its
      // socket during shutdown.
      if (!portalControlBoundPath) {
        portalControlServer = null
        portalControlSocketPath = null
        server.close()
      }
    })
    server.listen(socketPath, () => {
      portalControlBoundPath = socketPath
      try { fs.chmodSync(socketPath, 0o600) } catch (error) { console.error('Não foi possível proteger o socket de portais:', error) }
    })
  })()
  try {
    await portalControlStartInFlight
  } finally {
    portalControlStartInFlight = null
  }
}

function stopPortalControlServer() {
  portalControlStopRequested = true
  portalControlServer?.close()
  portalControlServer = null
  if (portalControlBoundPath) {
    try { if (fs.existsSync(portalControlBoundPath)) fs.unlinkSync(portalControlBoundPath) } catch { /* best effort cleanup */ }
  }
  portalControlBoundPath = null
  portalControlSocketPath = null
}

function isLiveChild(process: ChildProcess | null): process is ChildProcess {
  return Boolean(process && !process.killed && process.exitCode === null && process.signalCode === null)
}

function resolveCoreBinary(): string | null {
  // Vite Electron emits main.js to apps/desktop/dist-electron. The resource
  // candidate is last so a development build always uses the local target.
  const candidates = [
    path.resolve(__dirname, '../../../target/debug/orchestra-core'),
    path.resolve(__dirname, '../../../target/release/orchestra-core'),
    path.resolve(process.cwd(), '../../target/debug/orchestra-core'),
    path.resolve(process.cwd(), '../../target/release/orchestra-core'),
    path.join(process.resourcesPath || '', 'bin/orchestra-core')
  ]
  return candidates.find((candidate) => fs.existsSync(candidate)) || null
}

// npm adds lifecycle metadata to the environment of every process launched
// from an npm script. Forwarding that metadata to a long-lived daemon is both
// misleading and harmful to nvm: nvm scans all case variants of
// npm_config_prefix and refuses to activate when one is present. Keep ordinary
// npm configuration (registry, auth, etc.) intact, while removing only state
// that belongs to the npm parent process.
function isNpmProcessEnvironmentKey(key: string): boolean {
  const normalized = key.toLowerCase()
  return normalized === 'prefix'
    || normalized === 'npm_config_prefix'
    || normalized === 'npm_config_local_prefix'
    || normalized === 'npm_lifecycle_event'
    || normalized === 'npm_lifecycle_script'
    || normalized === 'npm_execpath'
    || normalized === 'npm_node_execpath'
    || normalized === 'npm_command'
    || normalized.startsWith('npm_lifecycle_')
    || normalized.startsWith('npm_package_')
}

function coreDaemonEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !isNpmProcessEnvironmentKey(key)) {
      environment[key] = value
    }
  }

  // Electron may have been started by npm with a PATH that only contains the
  // app's local shims. If nvm has already selected a version, NVM_BIN is the
  // portable, user-provided source of truth for that version; prepend it
  // without hardcoding a home directory or Node version. The PTY shell also
  // sources the user's startup files, so this is a fallback rather than a
  // replacement for normal shell configuration.
  const nvmBin = environment.NVM_BIN?.trim()
  if (nvmBin) {
    try {
      if (fs.statSync(nvmBin).isDirectory()) {
        const entries = (environment.PATH || '').split(path.delimiter).filter(Boolean)
        if (!entries.includes(nvmBin)) environment.PATH = [nvmBin, ...entries].join(path.delimiter)
      }
    } catch {
      // A stale NVM_BIN should not prevent the daemon from starting; the
      // selected shell can still reconstruct PATH from its login files.
    }
  }

  return environment
}

/**
 * Start the bundled daemon only when this app can prove the socket is free or
 * stale. In particular, a successful connection to an incompatible daemon is
 * never a reason to kill it: it may be managed by another Orchestra process.
 */
function ensureCoreDaemonRunning(forceSpawn = false, reason: 'startup' | 'refused' | 'incompatible' = 'startup') {
  if (shutdownStarted || isLiveChild(coreProcess) || coreSpawnInFlight) return false

  const sockPath = getSocketPath()
  const socketExists = fs.existsSync(sockPath)
  let socketClaimed = !socketExists

  if (socketExists) {
    if (!forceSpawn) return false

    // An incompatible peer is connected and therefore not ours. Never try to
    // replace it. A refused UNIX socket, on the other hand, has no listener;
    // removing only the stale pathname lets our daemon bind without touching
    // any external process.
    if (reason !== 'refused' || ownsCoreDaemon) return false
    try {
      const stat = fs.statSync(sockPath)
      if (!stat.isSocket()) return false
      fs.unlinkSync(sockPath)
      socketClaimed = true
    } catch (error) {
      console.warn('Could not reclaim a refused Orchestra socket:', error)
      return false
    }
  }

  const binPath = resolveCoreBinary()
  if (!binPath) {
    console.warn('orchestra-core binary not found')
    return false
  }

  console.log(`Starting Orchestra core daemon (${binPath})`)
  coreSpawnInFlight = true
  const child = spawn(binPath, [], {
    detached: true,
    stdio: 'ignore',
    env: {
      ...coreDaemonEnvironment(),
      // Never let a stale inherited value make a child bind a different or
      // already-owned pathname than the one this app claimed.
      ORCHESTRA_SOCKET: sockPath,
      // Make resource-relative skill/plugin resolution explicit for packaged
      // builds without overriding a user-selected socket.
      ORCHESTRA_RESOURCES_DIR: process.resourcesPath || process.env.ORCHESTRA_RESOURCES_DIR || ''
    }
  })
  coreProcess = child
  ownsCoreDaemon = true
  ownedCoreSocketPath = socketClaimed ? sockPath : null
  coreSpawnInFlight = false
  child.unref()
  child.once('error', (error) => {
    console.error('Orchestra core daemon failed to start:', error)
  })
  child.once('exit', (code, signal) => {
    if (coreProcess !== child) return
    coreProcess = null
    ownsCoreDaemon = false
    // Do not unlink here. A child can lose a bind race after another daemon
    // takes the pathname; removing it would destroy that daemon's socket.
    // The next ECONNREFUSED probe removes only a genuinely stale pathname.
    if (ownedCoreSocketPath === sockPath) ownedCoreSocketPath = null
    if (!shutdownStarted) {
      scheduleSocketReconnect('core-exited')
    }
  })
  return true
}

function settleDisconnectedCore(connection: net.Socket) {
  if (socketClient !== connection) return
  socketClient = null
  coreClientToken = null
  // These credentials belong to the old socket connection. Keeping them
  // would make every persisted terminal send a token issued by another core
  // instance and produce a tight Unauthorized terminal request loop.
  terminalTokens.clear()
  pendingTerminalSpawns.clear()
  pendingTerminalTokenRefreshes.clear()
  for (const [requestId, pending] of pendingRequests) {
    pending.reject(new Error('Core indisponível'))
    pendingRequests.delete(requestId)
  }
  // Keep the initial readiness promise pending across transient failures so a
  // renderer request can survive a stale/incompatible daemon replacement.
  // Once a previously-ready connection drops, create a fresh generation.
  if (coreReadyResolve === null) resetCoreReady()
}

function scheduleSocketReconnect(reason: string, attempt = socketRetryCount) {
  if (shutdownStarted || socketRetryTimer || socketConnectionInFlight) return
  if (attempt >= MAX_SOCKET_RETRIES) {
    console.warn(`Orchestra core reconnect budget exhausted (${reason})`)
    return
  }
  socketRetryCount = attempt + 1
  const delay = Math.min(SOCKET_RETRY_BASE_MS * 2 ** attempt, SOCKET_RETRY_MAX_MS)
  socketRetryTimer = setTimeout(() => {
    socketRetryTimer = null
    connectToSocket(socketRetryCount)
  }, delay)
}

function recoverAfterSocketFailure(reason: 'refused' | 'incompatible' | 'closed') {
  if (shutdownStarted) return
  if (reason === 'refused') {
    // This is the only recovery path allowed to reclaim a socket that was not
    // created by this process. ECONNREFUSED proves there is no listener now;
    // the pathname itself is stale and does not identify a daemon to kill.
    ensureCoreDaemonRunning(true, 'refused')
  } else if (reason === 'incompatible' && ownsCoreDaemon) {
    // We own this process and can safely replace it. External incompatible
    // daemons are left alone and are retried only within the bounded budget.
    const ownedProcess = coreProcess
    const ownedSocket = ownedCoreSocketPath
    coreProcess = null
    ownsCoreDaemon = false
    ownedCoreSocketPath = null
    if (ownedProcess && isLiveChild(ownedProcess)) ownedProcess.kill('SIGTERM')
    ensureCoreDaemonRunning(false, 'startup')
  }
  scheduleSocketReconnect(reason)
}

function connectToSocket(attempt = socketRetryCount) {
  if (shutdownStarted || socketClient || socketConnectionInFlight) return
  if (attempt >= MAX_SOCKET_RETRIES) {
    console.warn('Max socket retry attempts reached. Orchestra core daemon not available.')
    return
  }

  const sockPath = getSocketPath()
  if (!fs.existsSync(sockPath)) {
    ensureCoreDaemonRunning(false, 'startup')
    scheduleSocketReconnect('socket-missing', attempt)
    return
  }

  socketConnectionInFlight = true
  const connection = net.createConnection(sockPath)
  socketClient = connection
  let buffer = Buffer.alloc(0)
  let helloAccepted = false
  let failureHandled = false

  const handleFailure = (reason: 'refused' | 'incompatible' | 'closed') => {
    if (failureHandled) return
    failureHandled = true
    socketConnectionInFlight = false
    settleDisconnectedCore(connection)
    recoverAfterSocketFailure(reason)
  }

  connection.once('connect', () => {
    console.log('Connected to Orchestra Core daemon unix socket!')
    sendCoreRequest('system.hello').then((hello) => {
      const capabilities = Array.isArray((hello as Record<string, unknown>).capabilities)
        ? (hello as Record<string, unknown>).capabilities as unknown[]
        : []
      const requiredCapabilities = ['terminal.screen', 'terminal.control', 'terminal.state', 'terminal.detach', 'terminal.execute', 'terminal.complete', 'workspace.tree', 'workspace.read_file', 'portal.open']
      if (!isCoreHelloResponse(hello) || hello.protocolVersion !== PROTOCOL_VERSION || !requiredCapabilities.every((capability) => capabilities.includes(capability))) {
        throw new Error('Daemon protocol incompatível')
      }
      helloAccepted = true
      socketConnectionInFlight = false
      socketRetryCount = 0
      // A client token and all PTY tokens are scoped to this handshake. The
      // renderer may keep the canvas/session ids, but it must re-attach them
      // through this connection before sending terminal I/O.
      terminalTokens.clear()
      pendingTerminalSpawns.clear()
      pendingTerminalTokenRefreshes.clear()
      coreClientToken = hello.clientToken
      coreGeneration += 1
      coreReadyResolve?.()
      coreReadyResolve = null
      coreReadyReject = null
      if (mainWindow && !mainWindow.isDestroyed()) {
        const readyPayload = { ...hello, generation: coreGeneration, reconnect: coreGeneration > 1 }
        mainWindow.webContents.send('orchestra:event', {
          type: 'core.ready',
          payload: readyPayload
        })
        // Keep a distinct reconnect event for consumers that only need to
        // rebind live sessions. TerminalNode de-duplicates by generation, so
        // emitting both events is safe and makes the lifecycle explicit to
        // future renderer consumers.
        if (coreGeneration > 1) {
          mainWindow.webContents.send('orchestra:event', {
            type: 'core.reconnect',
            payload: readyPayload
          })
        }
      }
    }).catch((error) => {
      console.warn('Orchestra core handshake failed:', error instanceof Error ? error.message : String(error))
      // Destroying this client causes `close`, but the explicit flag keeps the
      // recovery path deterministic if a platform emits close first.
      handleFailure('incompatible')
      connection.destroy()
    })
  })

  connection.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk])
    while (buffer.length >= 4) {
      const len = buffer.readUInt32BE(0)
      if (len === 0 || len > 8 * 1024 * 1024) {
        console.error('Invalid Orchestra IPC frame length:', len)
        handleFailure('closed')
        connection.destroy()
        break
      }
      if (buffer.length < 4 + len) break

      const msgBuf = buffer.subarray(4, 4 + len)
      buffer = buffer.subarray(4 + len)

      try {
        const msg = JSON.parse(msgBuf.toString('utf-8'))
        if (msg.requestId) {
          const pending = pendingRequests.get(msg.requestId)
          if (pending) {
            if (msg.ok) pending.resolve(msg.result)
            else pending.reject(new Error(msg.error || 'Request failed'))
            pendingRequests.delete(msg.requestId)
          }
        } else if (msg.type || msg.eventId) {
          if (msg.type === 'terminal.exit' && typeof msg.payload?.sessionId === 'string') {
            terminalTokens.delete(msg.payload.sessionId)
          }
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('orchestra:event', msg)
          }
        }
      } catch (error) {
        console.error('Error parsing IPC JSON message:', error)
      }
    }
  })

  connection.on('error', (error) => {
    const code = (error as NodeJS.ErrnoException).code
    console.error('Socket client error:', error.message)
    handleFailure(code === 'ECONNREFUSED' ? 'refused' : 'closed')
  })

  connection.on('close', () => {
    console.log('Socket client connection closed')
    if (!helloAccepted) handleFailure('closed')
    else {
      socketConnectionInFlight = false
      settleDisconnectedCore(connection)
      scheduleSocketReconnect('closed')
    }
  })
}

async function shutdownTerminalSessions() {
  const sessions = [...terminalTokens.entries()]
  await Promise.all(sessions.map(([sessionId, token]) => sendCoreRequest('terminal.kill', {
    sessionId,
    token,
    clientToken: coreClientToken
  }).catch(() => undefined)))
  terminalTokens.clear()
}

function stopCoreDaemon() {
  const ownedProcess = coreProcess
  const ownedSocket = ownedCoreSocketPath
  coreProcess = null
  coreSpawnInFlight = false
  ownsCoreDaemon = false
  ownedCoreSocketPath = null
  if (ownedProcess && !ownedProcess.killed) ownedProcess.kill('SIGTERM')
  // Leave the pathname for the core's stale-socket recovery. It is unsafe to
  // unlink synchronously: a replacement daemon may already own that path.
}

function getIconPath(): string | undefined {
  // In development
  const devIcon = path.join(__dirname, '../resources/icon.png')
  if (fs.existsSync(devIcon)) return devIcon

  // In packaged app
  try {
    const prodIcon = path.join(process.resourcesPath || '', 'icon.png')
    if (fs.existsSync(prodIcon)) return prodIcon
  } catch (_) {}

  return undefined
}

function createWindow() {
  const isLinux = process.platform === 'linux'

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    backgroundColor: '#0b0c0e',
    icon: getIconPath(),
    // On Linux, 'hidden' titleBarStyle causes fullscreen crashes.
    // Use frameless + custom titlebar instead on Linux, standard on other platforms.
    frame: !isLinux,
    titleBarStyle: isLinux ? undefined : 'hidden',
    trafficLightPosition: isLinux ? undefined : { x: 12, y: 12 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false
    }
  })

  mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    console.log(`[Renderer Console] [level ${level}] ${message} (${sourceId}:${line})`)
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const devUrl = process.env.VITE_DEV_SERVER_URL
    if (devUrl && url.startsWith(devUrl)) return
    if (!url.startsWith('file://')) event.preventDefault()
  })

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    console.error(`[Renderer Failed Load] Code: ${errorCode}, Desc: ${errorDescription}, URL: ${validatedURL}`)
  })

  // Prevent unhandled errors from crashing the app
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error('Renderer process gone:', details.reason, details.exitCode)
    if (details.reason !== 'clean-exit') {
      // Recreate the window
      createWindow()
    }
  })

  mainWindow.webContents.on('unresponsive', () => {
    console.warn('Window became unresponsive')
  })

  mainWindow.webContents.on('responsive', () => {
    console.log('Window became responsive again')
  })

  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL)
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'))
  }
}

app.whenReady().then(() => {
  ensureCoreDaemonRunning()
  connectToSocket()

  // Window control IPC handlers for frameless window on Linux
  ipcMain.handle('window:minimize', () => {
    mainWindow?.minimize()
  })

  ipcMain.handle('window:maximize', () => {
    if (mainWindow?.isMaximized()) {
      mainWindow.unmaximize()
    } else {
      mainWindow?.maximize()
    }
  })

  ipcMain.handle('window:close', () => {
    mainWindow?.close()
  })

  ipcMain.handle('window:isMaximized', () => {
    return mainWindow?.isMaximized() ?? false
  })

  ipcMain.handle('system:detect-tools', async () => {
    const tools = [
      { id: 'claude', name: 'Claude Code', cmd: 'claude', aliases: [], description: 'Anthropic Agentic Coding CLI' },
      { id: 'agy', name: 'Antigravity CLI', cmd: 'agy', aliases: ['antigravity'], description: 'Google Antigravity Agent Runtime' },
      { id: 'codex', name: 'Codex CLI', cmd: 'codex', aliases: [], description: 'OpenAI Codex Terminal' },
      { id: 'cursor', name: 'Cursor CLI', cmd: 'cursor-agent', aliases: ['cursor'], description: 'Cursor coding agent CLI' },
      { id: 'opencode', name: 'OpenCode', cmd: 'opencode', aliases: [], description: 'Open-source Multi-Agent Engine' },
      { id: 'zsh', name: 'Zsh Shell', cmd: 'zsh', description: 'Standard System Shell' },
      { id: 'bash', name: 'Bash Shell', cmd: 'bash', description: 'GNU Bash Terminal Shell' },
      { id: 'git', name: 'Git', cmd: 'git', description: 'Version control' },
      { id: 'docker', name: 'Docker', cmd: 'docker', description: 'Container runtime' },
      { id: 'podman', name: 'Podman', cmd: 'podman', description: 'Rootless container runtime' },
      { id: 'ssh', name: 'OpenSSH', cmd: 'ssh', description: 'Remote environment bridge' },
    ]

    const pathEnv = process.env.PATH || ''
    const userHome = process.env.HOME || process.env.USERPROFILE || process.cwd()
    const extraPaths = [
      path.join(userHome, '.local/bin'),
      path.join(userHome, '.nvm/current/bin'),
      process.env.NVM_BIN || '',
      '/usr/local/bin',
      '/usr/bin',
      '/bin'
    ]
    // nvm versions can change independently of the desktop build. Include
    // every installed version's bin directory as a fallback when Electron
    // was launched with a reduced PATH.
    try {
      const versionsRoot = path.join(userHome, '.nvm/versions/node')
      if (fs.existsSync(versionsRoot)) {
        for (const version of fs.readdirSync(versionsRoot)) {
          extraPaths.push(path.join(versionsRoot, version, 'bin'))
        }
      }
    } catch {
      // PATH and the standard system locations remain sufficient when nvm is
      // unavailable or its directory is not readable.
    }
    const searchDirs = [...new Set([...pathEnv.split(path.delimiter), ...extraPaths])]

    return tools.map((t) => {
      let installed = false
      let binPath = ''
      let resolvedCommand = t.cmd
      for (const command of [t.cmd, ...(t.aliases || [])]) {
        for (const dir of searchDirs) {
          if (!dir) continue
          const candidate = path.join(dir, command)
          if (fs.existsSync(candidate)) {
            installed = true
            binPath = candidate
            resolvedCommand = command
            break
          }
        }
        if (installed) break
      }
      return { ...t, cmd: resolvedCommand, installed, path: binPath }
    })
  })

  ipcMain.handle('workspace:default-path', () => process.cwd())

  ipcMain.handle('workspace:choose', async () => {
    const result = await dialog.showOpenDialog(mainWindow ?? undefined, {
      properties: ['openDirectory', 'createDirectory'],
      title: 'Escolher workspace'
    })
    return result.canceled ? null : result.filePaths[0] ?? null
  })

  ipcMain.handle('portal:ensure', async (_event, { portalId, url }) => {
    const record = ensurePortal(String(portalId), String(url || 'about:blank'))
    return { portalId: record.id, url: record.url, generation: record.motionGeneration, revision: record.boundsRevision }
  })

  ipcMain.handle('portal:suppress', (_event, { reason, suppressed }) => {
    setPortalSuppression(reason, suppressed)
    return {
      suppressed: nativePortalSuppressionReasons.size > 0,
      reasons: Array.from(nativePortalSuppressionReasons)
    }
  })

  ipcMain.handle('portal:freeze', async (_event, { portalId, generation, scale, revision }) => {
    const record = portals.get(String(portalId))
    if (!record) throw new Error('Portal não encontrado')
    const acceptedGeneration = acceptPortalGeneration(record, generation)
    if (acceptedGeneration === null) return { portalId: record.id, url: record.url, stale: true, generation: record.motionGeneration, revision: record.boundsRevision }
    const acceptedRevision = acceptPortalRevision(record, revision)
    if (acceptedRevision === null) return { portalId: record.id, url: record.url, stale: true, generation: record.motionGeneration, revision: record.boundsRevision }
    // `scale` is the ReactFlow canvas transform, not browser page zoom. The
    // native view is already resized in screen pixels below; applying it to
    // Chromium as well would render the page at a fraction of the node size.
    void scale
    // Hide before awaiting Chromium. A capture/resume from an older motion
    // generation must never leave a native page visible over the moving DOM.
    record.frozen = true
    record.visible = false
    applyPortalVisibility(record)
    // The renderer hides the native view immediately after starting the
    // freeze. Restore only a hidden compositor surface at the last real node
    // size for the capture; never expose it while the DOM is moving.
    const captureBounds = record.lastVisibleBounds.width > 1 && record.lastVisibleBounds.height > 1
      ? record.lastVisibleBounds
      : record.bounds
    if (captureBounds.width > 1 && captureBounds.height > 1) {
      record.view.setBounds(captureBounds)
    }
    const image = await record.view.webContents.capturePage({
      x: 0,
      y: 0,
      width: Math.max(1, captureBounds.width),
      height: Math.max(1, captureBounds.height)
    })
    // A newer resume/bounds request may have won while capturePage was
    // awaiting Chromium. Never let this older capture hide a live portal.
    if (acceptedGeneration !== record.motionGeneration || acceptedRevision !== record.boundsRevision) {
      return { portalId: record.id, url: record.url, stale: true, generation: record.motionGeneration, revision: record.boundsRevision }
    }
    applyPortalVisibility(record)
    return {
      portalId: record.id,
      url: record.url,
      stale: false,
      generation: acceptedGeneration,
      revision: acceptedRevision,
      data: `data:image/png;base64,${image.toPNG().toString('base64')}`
    }
  })

  ipcMain.handle('portal:resume', (_event, { portalId, bounds, generation, scale, revision }) => {
    const record = portals.get(String(portalId))
    if (!record || !mainWindow) return { ok: false }
    const acceptedGeneration = acceptPortalGeneration(record, generation)
    if (acceptedGeneration === null) return { ok: false, stale: true, generation: record.motionGeneration }
    const acceptedRevision = acceptPortalRevision(record, revision)
    if (acceptedRevision === null) return { ok: false, stale: true, generation: record.motionGeneration, revision: record.boundsRevision }
    const safe = safePortalBounds({ ...(bounds || {}), scale })
    record.bounds = safe.bounds
    if (safe.fullyInside && safe.bounds.width > 1 && safe.bounds.height > 1) record.lastVisibleBounds = safe.bounds
    record.zoomFactor = 1
    record.view.setBounds(safe.bounds)
    // A native child is not clipped by the DOM. It must be fully inside the
    // content viewport before it is made visible.
    record.visible = safe.fullyInside
    record.frozen = !safe.fullyInside
    applyPortalVisibility(record)
    return { ok: record.visible, visible: record.visible, generation: acceptedGeneration, revision: acceptedRevision, bounds: safe.bounds }
  })

  ipcMain.handle('portal:bounds', (_event, { portalId, bounds, visible, generation, scale, revision }) => {
    const record = portals.get(String(portalId))
    if (!record || !mainWindow) return { ok: false }
    const acceptedGeneration = acceptPortalGeneration(record, generation)
    if (acceptedGeneration === null) return { ok: false, stale: true, generation: record.motionGeneration }
    const acceptedRevision = acceptPortalRevision(record, revision)
    if (acceptedRevision === null) return { ok: false, stale: true, generation: record.motionGeneration, revision: record.boundsRevision }
    const safe = safePortalBounds({ ...(bounds || {}), scale })
    record.bounds = safe.bounds
    if (Boolean(visible) && safe.fullyInside && safe.bounds.width > 1 && safe.bounds.height > 1) record.lastVisibleBounds = safe.bounds
    record.zoomFactor = 1
    record.view.setBounds(safe.bounds)
    const shouldShow = Boolean(visible) && safe.fullyInside
    record.visible = shouldShow
    record.frozen = !shouldShow
    applyPortalVisibility(record)
    return { ok: true, visible: shouldShow, generation: acceptedGeneration, revision: acceptedRevision, bounds: safe.bounds }
  })

  ipcMain.handle('portal:navigate', async (_event, { portalId, url }) => {
    const record = portals.get(String(portalId)) || ensurePortal(String(portalId), String(url || 'about:blank'))
    const nextUrl = normalizePortalUrl(String(url || 'about:blank'))
    record.url = nextUrl
    await record.view.webContents.loadURL(nextUrl)
    return { url: nextUrl }
  })

  ipcMain.handle('portal:action', (_event, { portalId, action }) => {
    const record = portals.get(String(portalId))
    if (!record) throw new Error('Portal não encontrado')
    if (action === 'back' && record.view.webContents.navigationHistory.canGoBack()) record.view.webContents.goBack()
    else if (action === 'forward' && record.view.webContents.navigationHistory.canGoForward()) record.view.webContents.goForward()
    else if (action === 'reload') record.view.webContents.reload()
    else if (action === 'stop') record.view.webContents.stop()
    return { url: record.url }
  })

  ipcMain.handle('portal:destroy', (_event, { portalId }) => {
    destroyPortal(String(portalId))
    return { ok: true }
  })

  ipcMain.handle('portal:open-external', async (_event, { portalId }) => {
    const record = portals.get(String(portalId))
    if (record) await shell.openExternal(record.url)
    return { ok: Boolean(record) }
  })

  ipcMain.handle('terminal:open-external', async (_event, { url }) => {
    const safeUrl = sanitizeExternalUrl(String(url || ''))
    if (!safeUrl) throw new Error('Only credential-free HTTP(S) terminal links can be opened')
    await shell.openExternal(safeUrl)
    return { ok: true, url: safeUrl }
  })

  ipcMain.handle('portal:inspect', async (_event, { portalId }) => {
    const record = portals.get(String(portalId))
    if (!record) throw new Error('Portal não encontrado')
    return inspectPortal(record)
  })

  ipcMain.handle('portal:click', async (_event, { portalId, selector }) => {
    const record = portals.get(String(portalId))
    if (!record) throw new Error('Portal não encontrado')
    return clickPortal(record, selector)
  })

  ipcMain.handle('portal:type', async (_event, { portalId, selector, text }) => {
    const record = portals.get(String(portalId))
    if (!record) throw new Error('Portal não encontrado')
    return typePortal(record, selector, text)
  })

  ipcMain.handle('portal:screenshot', async (_event, { portalId }) => {
    const record = portals.get(String(portalId))
    if (!record) throw new Error('Portal não encontrado')
    return screenshotPortal(record)
  })

  ipcMain.handle('terminal:relay', async (_, { fromSessionId, toSessionId, message }) => {
    void fromSessionId
    void toSessionId
    void message
    throw new Error('Terminal relay requires an authenticated agent request')
  })

  ipcMain.handle('canvas:context:sync', async (_, { contextSummary, cwd }) => {
    try {
      const terminals = normalizeContextTerminals(contextSummary)

      const userHome = process.env.HOME || process.env.USERPROFILE || process.cwd()
      const payloadCwd = cwd || (terminals.length > 0 ? terminals[0].cwd : null)
      let projectDir = userHome
      if (payloadCwd) {
        const expanded = payloadCwd === '~'
          ? userHome
          : payloadCwd.startsWith('~/')
            ? path.join(userHome, payloadCwd.slice(2))
            : payloadCwd
        projectDir = path.resolve(expanded)
      } else {
        projectDir = process.cwd()
      }

      try {
        projectDir = fs.realpathSync(projectDir)
      } catch {
        // The selected directory may be created by the terminal command itself.
      }

      const orchestraDir = path.join(projectDir, '.orchestra')
      if (!fs.existsSync(orchestraDir)) {
        fs.mkdirSync(orchestraDir, { recursive: true })
      }

      const jsonStr = JSON.stringify({ terminals, updatedAt: new Date().toISOString() }, null, 2)
      lastSyncedContexts.set(orchestraDir, jsonStr)

      // Write unified canvas_context.json
      atomicWriteFile(path.join(orchestraDir, 'canvas_context.json'), jsonStr)

      setupOrchestraWatcher(orchestraDir)


      // Collect ALL connected notes from ALL terminals
      const allNotes: Array<ConnectedNote & { fromAgent?: string }> = []
      const allBrowsers: Array<JsonObject & { fromAgent?: string }> = []
      const allPeers: Array<JsonObject & { fromAgent?: string }> = []

      for (const term of terminals) {
        // Keep each terminal's context next to the PTY workspace selected for it.
        // The Rust core uses the same resolution rules before it launches the shell.
        const rawTerminalCwd = typeof term.cwd === 'string' && term.cwd.trim()
          ? term.cwd.trim()
          : projectDir
        const expandedTerminalCwd = rawTerminalCwd === '~'
          ? userHome
          : rawTerminalCwd.startsWith('~/')
            ? path.join(userHome, rawTerminalCwd.slice(2))
            : rawTerminalCwd
        let terminalProjectDir = path.resolve(expandedTerminalCwd)
        try {
          terminalProjectDir = fs.realpathSync(terminalProjectDir)
        } catch {
          // Keep the resolved path if it does not exist yet.
        }

        const localOrchestraDir = path.join(terminalProjectDir, '.orchestra')
        const notesDir = path.join(localOrchestraDir, 'notes')
        fs.mkdirSync(notesDir, { recursive: true })
        setupOrchestraWatcher(localOrchestraDir)

        // A note has one canonical Markdown file. Both the canvas and agents use it.
        const notes = term.connectedNotes.map((note) => {
          const notePath = path.join(notesDir, `${note.id}.md`)
          const requestedContent = typeof note.content === 'string' ? note.content : ''
          let content = requestedContent
          if (fs.existsSync(notePath)) {
            const existingContent = fs.readFileSync(notePath, 'utf-8')
            const previousWrite = lastWrittenNotes.get(notePath)
            if (existingContent !== requestedContent && (previousWrite === undefined || existingContent !== previousWrite)) {
              // A process outside the canvas changed the canonical note. Keep
              // that version and let the renderer merge it into the editor.
              content = existingContent
              if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('orchestra:event', {
                  type: 'orchestra:note-external-update',
                  payload: { id: note.id, content: existingContent }
                })
              }
            } else if (existingContent !== requestedContent) {
              atomicWriteFile(notePath, requestedContent)
              lastWrittenNotes.set(notePath, requestedContent)
            }
          } else {
            atomicWriteFile(notePath, requestedContent)
            lastWrittenNotes.set(notePath, requestedContent)
          }
          return { ...note, content, filePath: notePath }
        })

        // Per-terminal directory
        const termDir = path.join(localOrchestraDir, 'terminals', term.sessionId)
        if (!fs.existsSync(termDir)) {
          fs.mkdirSync(termDir, { recursive: true })
        }
        atomicWriteFile(
          path.join(termDir, 'context.json'),
          JSON.stringify({ ...term, connectedNotes: notes }, null, 2)
        )

        let notesMd = `# Notas Conectadas ao Terminal: ${term.agent}\n\n`
        if (notes.length > 0) {
          notes.forEach((n) => {
            notesMd += `## ${n.title || 'Nota'}\n${n.content || ''}\n\n`
            allNotes.push({ ...n, fromAgent: term.agent })
          })
        } else {
          notesMd += `*Nenhuma nota conectada.*\n`
        }
        atomicWriteFile(path.join(termDir, 'connected_notes.md'), notesMd)

        // Collect browsers and peers
        term.connectedBrowsers.forEach((browser) => allBrowsers.push({ ...browser, fromAgent: term.agent }))
        term.connectedPeerAgents.forEach((peer) => allPeers.push({ ...peer, fromAgent: term.agent }))
      }

      // Write unified connected_notes.md
      let unifiedMd = `# Orchestra Canvas - Contexto Conectado\n\n`
      if (allNotes.length > 0) {
        allNotes.forEach((n) => {
          unifiedMd += `## Nota: ${n.title || 'Nota'} (conectada a ${n.fromAgent})\n${n.content || ''}\n\n`
        })
      } else {
        unifiedMd += `*Nenhuma nota conectada a nenhum terminal no momento.*\n`
      }
      atomicWriteFile(path.join(orchestraDir, 'connected_notes.md'), unifiedMd)

      return { ok: true }
    } catch (err) {
      console.error('Failed to sync canvas context:', err)
      return { ok: false, error: (err as Error).message }
    }
  })

  ipcMain.handle('orchestra:invoke', async (_, { type, payload }) => {
    if (type === 'workspace.default-path') return process.cwd()
    await waitForCore()
    const requestGeneration = coreGeneration
    const sessionId = payload && typeof payload === 'object' && typeof payload.sessionId === 'string'
      ? payload.sessionId
      : undefined
    const authenticatedPayload: Record<string, unknown> = {
      ...(payload && typeof payload === 'object' ? payload : {}),
      clientToken: coreClientToken
    }
    // A canvas can contain a persisted terminal whose PTY belonged to an
    // older daemon process. Do not send token-requiring requests before the
    // node has attached on this socket; this is what prevents resize/input
    // polling from producing an Unauthorized terminal request storm.
    const attachOnly = type === 'terminal.spawn' || type === 'terminal.attach'
    if (sessionId && !attachOnly && !terminalTokens.has(sessionId)) {
      return terminalUnavailableResult(type, sessionId)
    }
    // Attach is the token refresh primitive. Never send a cached PTY token
    // with it: a persisted node can be probing a daemon generation that did
    // not issue that token, while the current client token authorizes attach.
    if (type !== 'terminal.spawn' && type !== 'terminal.attach' && sessionId && terminalTokens.has(sessionId)) {
      authenticatedPayload.token = terminalTokens.get(sessionId)
    }
    let result: unknown
    let requestPromise: Promise<unknown>
    if (type === 'terminal.spawn' && sessionId) {
      const pending = pendingTerminalSpawns.get(sessionId)
      if (pending) return pending
      requestPromise = sendTerminalRequest(type, authenticatedPayload, sessionId)
      pendingTerminalSpawns.set(sessionId, requestPromise)
    } else {
      requestPromise = sendTerminalRequest(type, authenticatedPayload, sessionId)
    }
    try {
      result = await requestPromise
    } catch (error) {
      // A persisted canvas node may outlive its PTY after the daemon restarts.
      // Attach is an expected probe in that case; let the renderer continue
      // with a fresh spawn without polluting the Electron error log.
      if (type === 'terminal.attach' && error instanceof Error && /not running/i.test(error.message)) {
        return { status: 'not_running', sessionId }
      }
      throw error
    } finally {
      if (type === 'terminal.spawn' && sessionId && pendingTerminalSpawns.get(sessionId) === requestPromise) {
        pendingTerminalSpawns.delete(sessionId)
      }
    }
    const resultObject = result && typeof result === 'object' ? result as Record<string, unknown> : null
    if (requestGeneration === coreGeneration && type === 'terminal.spawn' && typeof resultObject?.sessionId === 'string' && typeof resultObject.token === 'string') {
      terminalTokens.set(resultObject.sessionId, resultObject.token)
    }
    if (requestGeneration === coreGeneration && type === 'terminal.attach' && typeof resultObject?.sessionId === 'string' && typeof resultObject.token === 'string') {
      terminalTokens.set(resultObject.sessionId, resultObject.token)
    }
    if (type === 'terminal.kill' && sessionId) terminalTokens.delete(sessionId)
    return result
  })

  startPortalControlServer()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  // Clear socket retry timer
  if (socketRetryTimer) {
    clearTimeout(socketRetryTimer)
    socketRetryTimer = null
  }
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', (event) => {
  if (shutdownStarted) return
  shutdownStarted = true
  event.preventDefault()
  for (const watchers of orchestraWatchers.values()) {
    watchers.root.close()
    watchers.notes.close()
  }
  orchestraWatchers.clear()
  for (const poller of orchestraPollers.values()) clearInterval(poller.timer)
  orchestraPollers.clear()
  lastSyncedNotes.clear()
  for (const portalId of portals.keys()) destroyPortal(portalId)
  stopPortalControlServer()
  void shutdownTerminalSessions().finally(() => {
    socketClient?.destroy()
    stopCoreDaemon()
    app.exit(0)
  })
})

// Catch unhandled errors at the process level
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception in main process:', err)
})

process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection in main process:', err)
})
