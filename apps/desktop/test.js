const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const appRoot = path.resolve(__dirname)
const requiredArtifacts = [
  'dist/index.html',
  'dist-electron/main.js',
  'dist-electron/preload.js'
]

for (const relative of requiredArtifacts) {
  const file = path.join(appRoot, relative)
  if (!fs.existsSync(file) || fs.statSync(file).size === 0) {
    throw new Error(`Missing build artifact: ${relative}`)
  }
}

const sourceRoot = path.join(appRoot, 'src')
const files = []
function collect(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name)
    if (entry.isDirectory()) collect(fullPath)
    else if (/\.(ts|tsx)$/.test(entry.name)) files.push(fullPath)
  }
}
collect(sourceRoot)

const source = files.map((file) => fs.readFileSync(file, 'utf8')).join('\n')
const mainSource = fs.readFileSync(path.join(sourceRoot, 'main/index.ts'), 'utf8')
const indexHtml = fs.readFileSync(path.join(appRoot, 'index.html'), 'utf8')
const viteConfigPath = path.join(appRoot, 'vite.config.mts')
const viteConfigSource = fs.existsSync(viteConfigPath) ? fs.readFileSync(viteConfigPath, 'utf8') : ''
for (const forbidden of ['http://localhost:3000', 'sampleCode', 'demoEntries', 'PanOnScrollMode']) {
  if (source.includes(forbidden)) throw new Error(`Prototype placeholder remains: ${forbidden}`)
}
if (/\balert\s*\(/.test(source)) throw new Error('Blocking alert() remains in the desktop source')
for (const required of ['createCommandEditorEngine', 'EditorView.lineWrapping', 'Shift-Enter', 'Ctrl+Enter', 'terminal.richInputV2', 'isMultilineEnter', 'multilineEnterSequence', 'modifiedEnterSequence', 'modify_other_keys', 'kitty', 'TerminalBlockStore', 'TerminalBlockList', 'TerminalOutputBuffer', 'terminalBlockOutputText', 'VirtualBlockIndex', 'visibleRange', 'terminal-block-sticky', 'Filter output', 'Re-input', 'Re-run', 'terminal.execute', 'terminal.security', 'parseOsc52', 'registerOscHandler', 'registerLinkProvider', 'linkHandler', 'macOptionClickForcesSelection', 'mouseTrackingMode', 'promptFallbackCursorInput', 'bracketedPasteMode', 'dataBase64', 'terminal:open-external', 'orchestra:terminal-file-link', 'screenReaderMode', 'terminal-create-modal', 'Quick Start', 'Monitor Activity', 'pendingTerminalSpawns', 'spawnStartedRef', 'useModalA11y', 'note-editor-focused', 'terminal-create-form', 'aria-modal="true"', 'installXtermTransformCompensation', '_mouseService', 'getTerminalTransformScale', 'isDirectInteractiveTerminalCommand']) {
  if (!source.includes(required)) throw new Error(`Rich editor architecture is missing: ${required}`)
}

// Regression checks for the socket-generation/auth lifecycle. Keep these
// close to the desktop smoke assertions so a future refactor cannot silently
// reintroduce stale PTY tokens or pre-attach IPC storms.
const authChecks = [
  ['terminal tokens are cleared on socket disconnect', /function settleDisconnectedCore[\s\S]*?terminalTokens\.clear\(\)/],
  ['pending terminal spawns are cleared on socket disconnect', /function settleDisconnectedCore[\s\S]*?pendingTerminalSpawns\.clear\(\)/],
  ['terminal refresh is deduplicated', /pendingTerminalTokenRefreshes\.get\(sessionId\)/],
  ['refresh responses are generation scoped', /generation !== coreGeneration/],
  ['renderer receives reconnect lifecycle events', /type: 'core\.reconnect'/],
  ['renderer gates pre-attach terminal requests', /const attachOnly = type === 'terminal\.spawn' \|\| type === 'terminal\.attach'/],
  ['watchers are canonicalized per workspace', /function canonicalOrchestraDir\(/],
  ['partial watchers are closed after setup failure', /rootWatcher\?\.close\(\)[\s\S]*?notesWatcher\?\.close\(\)/],
  ['watcher descriptor exhaustion is backed off', /code === 'EMFILE' \|\| code === 'ENFILE'/],
  ['watcher descriptor exhaustion keeps a bounded polling fallback', /function startOrchestraPoller\([\s\S]*?setupOrchestraWatcher\(watchRoot\)[\s\S]*?ORCHESTRA_POLL_INTERVAL_MS/],
  ['watcher fallback timers are cleaned on shutdown', /for \(const poller of orchestraPollers\.values\(\)\) clearInterval\(poller\.timer\)/],
  ['native portal pinch has a cancellable mouse path', /before-mouse-event[\s\S]*?forwardPortalPinch[\s\S]*?preventDefault/],
  ['native portal pinch has an input fallback', /input-event[\s\S]*?forwardPortalPinch/],
  ['native portal pinch is sent to the board', /emitPortalRecordEvent\([\s\S]*?'portal:pinch'/],
  ['portal motion requests reject stale generations', /acceptedGeneration !== record\.motionGeneration/],
  ['native portals are suppressed while renderer surfaces are modal', /nativePortalSuppressionReasons[\s\S]*?applyPortalVisibility/],
  ['portal screenshots preserve a cached live frame', /lastSnapshot[\s\S]*?screenshotPortal/],
  ['canvas scale preserves the browser logical viewport', /function portalZoomForScale\(scale: number\)[\s\S]*?return clampPortalScale\(scale\)[\s\S]*?setZoomFactor\(nextZoom\)/],
  ['portal bounds track same-generation revisions', /boundsRevision/],
  ['portal bounds reject stale revisions', /revision < record\.boundsRevision/],
  ['portal handlers accept bounds revisions', /acceptedRevision/],
  ['portal snapshots use the exact native compositor surface', /capturePortalSnapshotNow[\s\S]*?webContents\.capturePage\(\)/],
  ['portal snapshots do not apply canvas scale twice', /Page\.captureScreenshot[\s\S]*?captureBeyondViewport: false[\s\S]*?acceptSnapshot/],
  ['portal destruction is idempotent during Electron teardown', /function destroyPortal\(portalId: string\)[\s\S]*?portals\.delete\(portalId\)[\s\S]*?windowRef\.isDestroyed\(\)[\s\S]*?webContents\.isDestroyed\(\)/],
  ['portal socket is unique per core socket', /function getPortalControlSocketPath\(\)[\s\S]*?coreSocketPath[\s\S]*?\.portal\.sock/],
  ['active portal socket is never unlinked', /probeUnixSocket\(socketPath\)[\s\S]*?fs\.unlinkSync\(socketPath\)/]
]
for (const [label, pattern] of authChecks) {
  if (!pattern.test(mainSource)) throw new Error(`Terminal/core regression guard missing: ${label}`)
}

const portalCaptureStart = mainSource.indexOf('async function capturePortalSnapshotNow')
const portalCaptureEnd = mainSource.indexOf('\nfunction screenshotPortal', portalCaptureStart)
const portalCaptureSource = mainSource.slice(portalCaptureStart, portalCaptureEnd)
if (portalCaptureStart < 0 || portalCaptureEnd < 0 || !portalCaptureSource.includes('webContents.capturePage()')) {
  throw new Error('Portal snapshots must capture the exact native compositor surface')
}
if (portalCaptureSource.includes('capturePage({') || portalCaptureSource.includes('clip:') || portalCaptureSource.includes('scale: record.canvasScale')) {
  throw new Error('Portal snapshot capture applies viewport bounds or canvas scale twice')
}
if (!portalCaptureSource.includes('revealedForCapture') || !portalCaptureSource.includes('record.desiredVisible') || !portalCaptureSource.includes('nativePortalSuppressionReasons.size === 0')) {
  throw new Error('First portal frame capture must wake a valid hidden compositor surface')
}
if (!mainSource.includes("ipcMain.handle('portal:screenshot'") || !mainSource.includes("if (!record) return ''") || !mainSource.includes("return record.lastSnapshot || ''")) {
  throw new Error('Portal screenshot startup retries must remain non-fatal')
}

if (indexHtml.includes('frame-ancestors')) throw new Error('Meta CSP must not contain ineffective frame-ancestors')
if (!fs.existsSync(viteConfigPath) || fs.existsSync(path.join(appRoot, 'vite.config.ts'))) {
  throw new Error('Vite config must use the ESM .mts entrypoint')
}
if (!viteConfigSource.includes('import.meta.url')) throw new Error('ESM Vite config lost its URL-relative path resolution')
if (!mainSource.includes('ORCHESTRA_DEVTOOLS_PORT')) throw new Error('Remote DevTools must remain opt-in')
if (mainSource.includes("appendSwitch('remote-debugging-port', '9231')")) throw new Error('Fixed remote DevTools port remains enabled')

// Exercise the pure pinch math in the same smoke harness as the desktop
// artifact checks. This catches regressions without requiring Electron input.
const typescript = require('typescript')
const pinchSource = fs.readFileSync(path.join(sourceRoot, 'renderer/utils/canvasPinchZoom.ts'), 'utf8')
const pinchModule = { exports: {} }
const pinchCode = typescript.transpileModule(pinchSource, {
  compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2022 }
}).outputText
new Function('exports', 'module', pinchCode)(pinchModule.exports, pinchModule)
const pinch = pinchModule.exports
if (!pinch.isCanvasPinchWheelEvent({ ctrlKey: true, metaKey: false, altKey: false, deltaY: -1 })) throw new Error('Pinch wheel detection failed')
if (!pinch.isCanvasPinchWheelEvent({ ctrlKey: false, metaKey: true, altKey: false, deltaY: -1 })) throw new Error('Meta pinch wheel detection failed')
if (pinch.isCanvasPinchWheelEvent({ ctrlKey: false, metaKey: false, altKey: false, deltaY: -1 })) throw new Error('Plain wheel was classified as pinch')
if (pinch.isCanvasPinchWheelEvent({ ctrlKey: false, metaKey: false, altKey: false, deltaX: 24, deltaY: 0 })) throw new Error('Plain horizontal pan was classified as pinch')
if (pinch.isCanvasPinchWheelEvent({ ctrlKey: true, metaKey: false, altKey: true, deltaY: -1 })) throw new Error('Alt wheel was classified as pinch')
if (pinch.getCanvasBoardWheelGesture({ deltaY: -24 }) !== 'vertical-zoom') throw new Error('Plain vertical board gesture did not zoom')
if (pinch.getCanvasBoardWheelGesture({ deltaY: 24 }) !== 'vertical-zoom') throw new Error('Plain downward board gesture did not zoom out')
if (pinch.getCanvasBoardWheelGesture({ deltaX: 24, deltaY: 0 }) !== 'horizontal-pan') throw new Error('Plain horizontal board gesture did not pan')
if (pinch.getCanvasBoardWheelGesture({ deltaX: 40, deltaY: 12 }) !== 'horizontal-pan') throw new Error('Diagonal board gesture did not lock to dominant horizontal axis')
if (pinch.getCanvasBoardWheelGesture({ deltaX: 8, deltaY: -40 }) !== 'vertical-zoom') throw new Error('Diagonal board gesture did not lock to dominant vertical axis')
if (pinch.getCanvasBoardWheelGesture({ deltaY: -24 }, { blocked: true }) !== 'none') throw new Error('Blocked node/editor surface was hijacked by board zoom')
if (pinch.getCanvasBoardWheelGesture({ ctrlKey: true, deltaY: -24 }) !== 'none') throw new Error('Modified pinch was misclassified as plain board gesture')
if (pinch.canvasPinchZoomFactor({ ctrlKey: true, deltaY: -100000, deltaMode: 0 }, false) > 2) throw new Error('Pinch packet upper guard failed')
if (pinch.canvasPinchZoomFactor({ ctrlKey: true, deltaY: 100000, deltaMode: 0 }, false) < 0.5) throw new Error('Pinch packet lower guard failed')
if (pinch.canvasPinchGestureFactor(0) !== 1 || pinch.canvasPinchGestureFactor('bad') !== 1) throw new Error('Native gesture factor validation failed')
const initialViewport = { x: 120, y: 80, zoom: 1 }
const pannedViewport = pinch.getCanvasPinchPanViewport(initialViewport, 36, 0)
if (pannedViewport.x !== initialViewport.x - 36 || pannedViewport.y !== initialViewport.y) throw new Error('Horizontal two-finger pan changed the wrong axis')
const offsetAnchor = pinch.getCanvasPinchAnchor({ x: 400, y: 250 }, { left: 120, top: 80 })
if (offsetAnchor.x !== 280 || offsetAnchor.y !== 170) throw new Error('Portal pinch anchor did not subtract renderer offset')
const anchor = { x: 300, y: 200 }
const nextViewport = pinch.getCanvasPinchViewport(initialViewport, anchor, 2)
const initialFlowPoint = { x: (anchor.x - initialViewport.x) / initialViewport.zoom, y: (anchor.y - initialViewport.y) / initialViewport.zoom }
const nextScreenPoint = { x: nextViewport.x + initialFlowPoint.x * nextViewport.zoom, y: nextViewport.y + initialFlowPoint.y * nextViewport.zoom }
if (Math.abs(nextScreenPoint.x - anchor.x) > 1e-9 || Math.abs(nextScreenPoint.y - anchor.y) > 1e-9) throw new Error('Pinch anchor drifted')
if (pinch.getCanvasPinchViewport(initialViewport, anchor, 100).zoom !== 4) throw new Error('Pinch max zoom clamp failed')
if (pinch.getCanvasPinchViewport(initialViewport, anchor, 0.001).zoom !== 0.25) throw new Error('Pinch min zoom clamp failed')
let repeatedViewport = initialViewport
for (const factor of [1.08, 0.94, 1.13, 0.87]) {
  repeatedViewport = pinch.getCanvasPinchViewport(repeatedViewport, anchor, factor)
  const repeatedFlowPoint = { x: (anchor.x - initialViewport.x) / initialViewport.zoom, y: (anchor.y - initialViewport.y) / initialViewport.zoom }
  const repeatedScreenPoint = { x: repeatedViewport.x + repeatedFlowPoint.x * repeatedViewport.zoom, y: repeatedViewport.y + repeatedFlowPoint.y * repeatedViewport.zoom }
  if (Math.abs(repeatedScreenPoint.x - anchor.x) > 1e-9 || Math.abs(repeatedScreenPoint.y - anchor.y) > 1e-9) throw new Error('Repeated pinch packets drifted anchor')
}

// Native WebContentsViews are not clipped by the DOM. Keep this pure geometry
// guard beside the pinch math so a portal cannot become a giant stale overlay
// while the board is being zoomed or panned.
const geometrySource = fs.readFileSync(path.join(sourceRoot, 'shared/browserPortalGeometry.ts'), 'utf8')
const geometryModule = { exports: {} }
const geometryCode = typescript.transpileModule(geometrySource, {
  compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2022 }
}).outputText
new Function('exports', 'module', geometryCode)(geometryModule.exports, geometryModule)
const geometry = geometryModule.exports
const partialPortal = geometry.getPortalGeometry({ left: -220, top: 40, right: 420, bottom: 340 }, { left: 0, top: 0, width: 800, height: 600 }, 640, 300)
if (partialPortal.visible || !partialPortal.clipped || partialPortal.bounds.width !== 420) throw new Error('Partially clipped portal was not hidden/intersected')
const fullPortal = geometry.getPortalGeometry({ left: 100, top: 80, right: 500, bottom: 380 }, { left: 0, top: 0, width: 800, height: 600 }, 200, 150)
if (!fullPortal.visible || fullPortal.scale !== 2) throw new Error('Fully visible portal scale geometry regressed')
const outsidePortal = geometry.getPortalGeometry({ left: -900, top: -800, right: -100, bottom: -20 }, { left: 0, top: 0, width: 800, height: 600 }, 800, 780)
if (outsidePortal.visible || outsidePortal.hasIntersection || outsidePortal.bounds.width !== 1 || outsidePortal.bounds.height !== 1) throw new Error('Offscreen portal geometry was not hidden')
const invalidViewport = geometry.getPortalGeometry({ left: 10, top: 10, right: 110, bottom: 110 }, { left: 0, top: 0, width: 0, height: 600 }, 100, 100)
if (invalidViewport.visible || invalidViewport.hasIntersection || invalidViewport.bounds.width !== 1 || invalidViewport.bounds.height !== 1) throw new Error('Invalid portal viewport was not safely hidden')
const fractionalPortal = geometry.getPortalGeometry({ left: 10.25, top: 20.75, right: 110.1, bottom: 120.2 }, { left: 0.5, top: 10.5, width: 240.25, height: 260.25 }, 100, 100)
if (!fractionalPortal.visible || fractionalPortal.clipped || fractionalPortal.bounds.x !== 10 || fractionalPortal.bounds.y !== 20 || fractionalPortal.bounds.width !== 101 || fractionalPortal.bounds.height !== 101) throw new Error('Fractional portal bounds lost visible pixels')
if (Math.abs(fractionalPortal.scale - 0.9965) > 0.002) throw new Error('Fractional portal scale is not responsive to both axes')
const movingPortal = geometry.getPortalGeometry({ left: 140.4, top: 95.7, right: 540.4, bottom: 395.7 }, { left: 0, top: 0, width: 1200, height: 800 }, 400, 300)
if (!movingPortal.visible || movingPortal.bounds.x !== 140 || movingPortal.bounds.y !== 95 || movingPortal.bounds.width !== 401 || movingPortal.bounds.height !== 301 || movingPortal.scale !== 1) throw new Error('Portal motion geometry did not preserve rounded bounds')

// Keep the file tree and graph layout helpers executable in the smoke suite.
// These checks are deliberately DOM-free: they protect keyboard order, status
// interpretation and merge-lane layout even when Electron is unavailable.
const treeUtilsSource = fs.readFileSync(path.join(sourceRoot, 'renderer/components/Nodes/filesTreeUtils.ts'), 'utf8')
const treeUtilsModule = { exports: {} }
const treeUtilsCode = typescript.transpileModule(treeUtilsSource, {
  compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2022 }
}).outputText
new Function('exports', 'module', treeUtilsCode)(treeUtilsModule.exports, treeUtilsModule)
const treeUtils = treeUtilsModule.exports
const treeRoot = { name: 'repo', path: '/repo', is_dir: true, children: [
  { name: 'src', path: '/repo/src', is_dir: true, children: [{ name: 'main.ts', path: '/repo/src/main.ts', is_dir: false }] },
  { name: 'README.md', path: '/repo/README.md', is_dir: false }
]}
const treeRows = treeUtils.flattenFileTree(treeRoot, new Set(['/repo', '/repo/src']))
if (treeRows.length !== 3 || treeRows[1].item.name !== 'main.ts') throw new Error('File tree flatten order regressed')
if (!treeUtils.filterFileTreeRows(treeRows, 'main.ts').some((row) => row.item.name === 'src')) throw new Error('File tree ancestor filtering regressed')
const refreshedTree = treeUtils.mergeRefreshedTree({
  name: 'repo', path: '/repo', is_dir: true, children: [
    { name: 'src', path: '/repo/src', is_dir: true, children: [{ name: 'main.ts', path: '/repo/src/main.ts', is_dir: false }] }
  ]
}, {
  name: 'repo', path: '/repo', is_dir: true, children: [
    { name: 'src', path: '/repo/src', is_dir: true, children: [] },
    { name: 'README.md', path: '/repo/README.md', is_dir: false }
  ]
})
if (!refreshedTree.children?.[0]?.children?.some((item) => item.name === 'main.ts')) throw new Error('File tree refresh discarded loaded descendants')
if (!treeUtils.gitStatusFlags('M ').staged || treeUtils.gitStatusFlags(' M').staged) throw new Error('Git porcelain status interpretation regressed')
const graphRows = treeUtils.buildGraphRows([
  { hash: 'a', parents: ['b', 'c'], message: 'merge' },
  { hash: 'b', parents: ['d'], message: 'main' },
  { hash: 'c', parents: ['d'], message: 'side' },
  { hash: 'd', parents: [], message: 'base' }
])
if (graphRows.length !== 4 || graphRows[0].laneCount < 2 || graphRows[0].lane !== 0) throw new Error('Git graph lane layout regressed')
if (graphRows[3].lane !== 0 || graphRows[3].laneCount !== 1) throw new Error('Git graph convergence left a ghost lane')
if (typeof graphRows[0].color !== 'string' || graphRows[0].color[0] !== '#') throw new Error('Git graph row color is not deterministic CSS')
const linearGraph = treeUtils.buildGraphRows([
  { hash: 'root', parents: ['base'], message: 'root' },
  { hash: 'base', parents: [], message: 'base' }
])
if (linearGraph[0].color !== linearGraph[1].color) throw new Error('Git graph lane color changed along a linear branch')
const graphWindow = treeUtils.buildGraphRows([{ hash: 'b', parents: ['d'], message: 'main' }])
if (graphWindow[0].color !== graphRows[1].color) throw new Error('Git graph color changed between virtual windows')
if (treeUtils.mapVisualPointToLayout({ x: 125, y: 80 }, { left: 100, top: 50, width: 50, height: 40 }, { width: 200, height: 160 }).x !== 100) throw new Error('File tree context menu did not undo ReactFlow scale')
if (treeUtils.mapVisualPointToLayout({ x: 300, y: 130 }, { left: 100, top: 50, width: 400, height: 320 }, { width: 200, height: 160 }).x !== 100) throw new Error('File tree context menu failed at zoom 2')
const clampedMenu = treeUtils.clampContextMenuPosition({ x: 800, y: 500 }, { width: 400, height: 300 }, 190, 176)
if (clampedMenu.x !== 210 || clampedMenu.y !== 124) throw new Error('File tree context menu escaped its node bounds')
const deletable = treeUtils.filterDeletableBranches([
  { name: 'main', current: true },
  { name: 'feature/ui', current: false },
], 'main')
if (deletable.some((branch) => branch.name === 'main') || deletable.length !== 1) throw new Error('Current Git branch became deletable')
const filesNodeSource = fs.readFileSync(path.join(sourceRoot, 'renderer/components/Nodes/FilesNode.tsx'), 'utf8')
if (!/workspace\.tree'[\s\S]{0,160}depth: 1/.test(filesNodeSource) || /depth:\s*[248]\b/.test(filesNodeSource)) throw new Error('File tree initial/lazy depth regressed')
if (!filesNodeSource.includes('setSelectedFilePath(joinWorkspacePath(projectPath, row.item.path))')) throw new Error('F2 no longer targets the focused tree row')
if (filesNodeSource.includes("git.branch.delete', { name: currentBranch") || !filesNodeSource.includes('filterDeletableBranches')) throw new Error('Current branch delete guard regressed')
if (filesNodeSource.includes('</span>{refs.map((ref)') || filesNodeSource.includes('stashes[0] &&')) throw new Error('Git refs/stashes lost compact selection')
if (!filesNodeSource.includes('stashTarget') || !filesNodeSource.includes('git.create_floor')) throw new Error('Worktree/stash controls lost real selection handlers')
if (!filesNodeSource.includes('useModalA11y') || !filesNodeSource.includes('ref={confirmRef}')) throw new Error('File tree destructive confirmation lost focus trapping')
const canvasSource = fs.readFileSync(path.join(sourceRoot, 'renderer/components/Canvas/CanvasArea.tsx'), 'utf8')
const browserSource = fs.readFileSync(path.join(sourceRoot, 'renderer/components/Nodes/BrowserNode.tsx'), 'utf8')
const terminalSource = fs.readFileSync(path.join(sourceRoot, 'renderer/components/Nodes/TerminalNode.tsx'), 'utf8')
if (!terminalSource.includes('scrollback: 1_000_000')) throw new Error('Terminal scrollback budget regressed from the unlimited-style buffer')
if (!browserSource.includes('propsRef.current') || !browserSource.includes('url: payload.url')) throw new Error('Browser navigation does not preserve current node properties')
if (!browserSource.includes("scheduleBoundsSync('snapshot')") || !browserSource.includes('pendingUpdate') || !browserSource.includes('snapshotRef.current')) throw new Error('Browser portal motion lost its cached snapshot/latest-only presentation bridge')
if (!canvasSource.includes("selectedNode.kind === 'browser' ? { portalId: duplicateId }")) throw new Error('Browser duplication can still share a native portal')
if (!canvasSource.includes("target.closest('.react-flow__node, .nowheel, .canvas-toolbar, .canvas-context-toolbar, .zoom')")) throw new Error('Board wheel handler can hijack node/editor surfaces')
if (!canvasSource.includes('activeFloor?.id || persistedFloorId') || !canvasSource.includes('focusSnapshotRef.current = null')) throw new Error('Focus mode is not cleaned up at a floor boundary')
if (!canvasSource.includes('canvasScopeKey') || !canvasSource.includes('hydratedWorkspaceRef.current !== canvasScopeKey')) throw new Error('Canvas hydration can cross workspace/floor boundaries')
if (!canvasSource.includes("reason: 'pinch'")) throw new Error('Programmatic pinch does not freeze native browser portals')
if (!canvasSource.includes('focusViewportRef.current = flowRef.current.getViewport()') || !canvasSource.includes('setViewport({ x: 0, y: 0, zoom: 1 })')) throw new Error('Focus mode must neutralize the React Flow transform for terminal rendering')
if (!canvasSource.includes('const next = { x: 24, y: 46, ...size }')) throw new Error('Focus mode must keep the focused node inside the workspace bounds')
if (!canvasSource.includes('focusTransitionRef') || !canvasSource.includes('setViewport({ x: 0, y: 0, zoom: 1 }).then')) throw new Error('Focus mode still publishes geometry before the neutral viewport commits')
if (filesNodeSource.includes('A pasta guardada deste File Tree já não pertence ao workspace atual')) throw new Error('File Tree external roots must not show the old workspace warning')
if (!filesNodeSource.includes('const externalRoot = resolvedProject.outside ? projectPath : \'\'')) throw new Error('File Tree does not preserve a selected external root')
if (!filesNodeSource.includes('fileWorkspaceId ? { workspaceId: fileWorkspaceId } : {}')) throw new Error('External File Tree requests must not send the active workspace id')
if (!filesNodeSource.includes('return { path: candidate || root, outside: Boolean(raw) && !inside }')) throw new Error('File Tree external roots are still collapsed to the active workspace')
if (!mainSource.includes('function portalEnsureSnapshot') || !mainSource.includes('history: { canGoBack, canGoForward }') || !mainSource.includes('viewport: record.logicalViewport')) throw new Error('Portal ensure response lost navigation/loading/viewport state')
const cssSource = fs.readFileSync(path.join(sourceRoot, 'renderer/index.css'), 'utf8')
if (!cssSource.includes('.terminal-create-modal { width: min(500px, 100%); max-height:')) throw new Error('Terminal creation modal lacks a viewport height guard')
if (!cssSource.includes('.portal-placeholder { display: flex;')) throw new Error('Browser portal empty state is not laid out')
if (cssSource.includes('.canvas-focus-active .react-flow__pane')) throw new Error('Focus mode must not dim the React Flow pane parent of the focused node')
if (cssSource.includes('.canvas-focus-active .react-flow__node.canvas-node-focus { max-width:')) throw new Error('Focus node sizing must stay in flow coordinates')
if (!canvasSource.includes('onNodeDrag={() => window.dispatchEvent')) throw new Error('Portal motion watchdog has no node-drag heartbeat')
if (/onMoveStart=\{\(\) => window\.dispatchEvent\(new CustomEvent\('orchestra:canvas-motion'/.test(canvasSource)) throw new Error('A simple board pointer-down still snapshots every browser portal')
const workspaceStoreSource = fs.readFileSync(path.join(sourceRoot, 'renderer/store/workspaceStore.ts'), 'utf8')
if (!workspaceStoreSource.includes("orchestra:node-deleting") || !canvasSource.includes("orchestra:node-deleting") || !canvasSource.includes('restoreFocus(false)')) throw new Error('Deleting a focused node must exit focus before removal')
if (!mainSource.includes('record.view.webContents.setZoomFactor(nextZoom)')) throw new Error('Browser logical viewport no longer follows the canvas scale')
const modalSources = [
  'components/Modals/RecruitAgentModal.tsx',
  'components/Modals/FilesDirectoryModal.tsx',
  'components/Modals/FloorModal.tsx',
  'components/Modals/CommandPalette.tsx'
].map((relative) => fs.readFileSync(path.join(sourceRoot, 'renderer', relative), 'utf8'))
if (modalSources.some((contents) => !contents.includes('useModalA11y') || !contents.includes('aria-modal="true"'))) {
  throw new Error('Global modal focus/surface guard regressed')
}
if (!source.includes('portal.suppress(\'modal\'')) throw new Error('Modal surface does not suppress native portals')
if (!filesNodeSource.includes('contextMenuRef') || !filesNodeSource.includes('role="tablist"') || !filesNodeSource.includes('parentIndex')) {
  throw new Error('File tree focus/context-menu ergonomics regressed')
}
const noteSource = fs.readFileSync(path.join(sourceRoot, 'renderer/components/Nodes/NoteNode.tsx'), 'utf8')
if (!noteSource.includes('note-resize-line') || !noteSource.includes('StarterKit.configure({ link: false })')) {
  throw new Error('Sticky note divider/editor guard regressed')
}
const responsiveFixturePath = path.join(appRoot, 'test-fixtures/responsive-portal.html')
const responsiveHarnessPath = path.join(appRoot, 'portal-responsive-harness.mjs')
if (!fs.existsSync(responsiveFixturePath) || !fs.existsSync(responsiveHarnessPath)) {
  throw new Error('Responsive browser portal fixture/harness is missing')
}
const responsiveFixture = fs.readFileSync(responsiveFixturePath, 'utf8')
const responsiveHarness = fs.readFileSync(responsiveHarnessPath, 'utf8')
if (!responsiveHarness.includes('WebContentsView') || !responsiveHarness.includes('portalView.setBounds') || !responsiveHarness.includes('capturePage()')) {
  throw new Error('Responsive browser harness must exercise a real WebContentsView')
}
for (const required of ['name="viewport"', 'max-width: 520px', 'max-width: 1000px', 'portalFixture', 'generation', 'revision']) {
  if (!responsiveFixture.includes(required)) throw new Error(`Responsive portal fixture lost ${required}`)
}
for (const required of ['offscreen: true', 'setZoomFactor', 'logicalWidths = [390, 768, 1440]', 'portalFixture.drag', 'portalFixture.snapshot']) {
  if (!responsiveHarness.includes(required)) throw new Error(`Responsive portal harness lost ${required}`)
}
const skillSource = fs.readFileSync(path.join(appRoot, '../../skills/orchestra-canvas/SKILL.md'), 'utf8')
if (skillSource.includes('You are running inside Orchestra Desktop')) throw new Error('Agent skill still injects the visible Orchestra startup banner')

execFileSync(process.execPath, [
  '--no-warnings',
  '--experimental-strip-types',
  path.join(appRoot, 'terminal-v2-unit.mjs')
], { stdio: 'inherit' })

console.log(`desktop smoke checks passed (${files.length} source files, ${requiredArtifacts.length} artifacts)`)
