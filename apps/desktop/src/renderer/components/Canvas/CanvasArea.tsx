import React, { useMemo, useCallback, useEffect, useRef, useState } from 'react'
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  Connection,
  NodeChange,
  ReactFlowInstance
} from '@xyflow/react'
import { useWorkspaceStore, CanvasEdgeData, CanvasNodeData } from '../../store/workspaceStore'
import { TerminalNode } from '../Nodes/TerminalNode'
import { NoteNode } from '../Nodes/NoteNode'
import { FilesNode } from '../Nodes/FilesNode'
import { BrowserNode } from '../Nodes/BrowserNode'
import { TextNode } from '../Nodes/TextNode'
import { ShapeNode } from '../Nodes/ShapeNode'
import { Terminal, FileText, FolderTree, Globe, MousePointer, Cable, Copy, Trash2, Pencil, RotateCw, Bold, Italic, List, CheckSquare, PenLine, Square, Type } from 'lucide-react'
import { CableSystem } from './CableSystem/CableSystem'
import { CANVAS_MAX_ZOOM, CANVAS_MIN_ZOOM, canvasPinchGestureFactor, canvasPinchZoomFactor, getCanvasBoardWheelGesture, getCanvasPinchAnchor, getCanvasPinchPanViewport, getCanvasPinchViewport, isCanvasPinchWheelEvent } from '../../utils/canvasPinchZoom'
import { applyCanvasNodeChanges } from './canvasNodeChanges'
import type { CanvasNodeMeasurement } from './canvasNodeChanges'

type CanvasTool = 'select' | 'terminal' | 'note' | 'files' | 'browser' | 'text' | 'shape' | 'draw'

const GENERIC_CONNECTION_PERMISSIONS = ['read', 'write', 'send_prompt', 'receive_response', 'control', 'share_context']
const BROWSER_CONNECTION_PERMISSIONS = ['inspect', 'navigate', 'control', 'screenshot']

function isTerminalBrowserConnection(edge: Pick<CanvasEdgeData, 'source' | 'target'>, nodes: CanvasNodeData[]) {
  const sourceKind = nodes.find((node) => node.id === edge.source)?.kind
  const targetKind = nodes.find((node) => node.id === edge.target)?.kind
  return (sourceKind === 'terminal' && targetKind === 'browser') || (sourceKind === 'browser' && targetKind === 'terminal')
}

/**
 * Older canvases could persist a browser cable in the reverse visual
 * direction with only generic permissions. Those permissions are not valid
 * for a browser portal, so repair only this unambiguous legacy shape. A
 * partially configured modern browser cable keeps its explicit choices.
 */
function normalizeBrowserEdgePermissions(edge: CanvasEdgeData, nodes: CanvasNodeData[]) {
  if (!isTerminalBrowserConnection(edge, nodes)) return edge
  const permissions = Array.isArray(edge.permissions) ? edge.permissions : []
  if (permissions.some((permission) => BROWSER_CONNECTION_PERMISSIONS.includes(permission))) return edge
  return { ...edge, permissions: [...new Set([...permissions, ...BROWSER_CONNECTION_PERMISSIONS])] }
}

// CanvasArea is unmounted when the user temporarily visits another app
// screen. Keep the inventory at module scope so those hidden portals retain
// their live session and can be reconciled (or destroyed) on the next canvas
// hydration instead of being leaked or needlessly reloaded.
const browserPortalInventory: { scope: string | null; portals: Map<string, string> } = {
  scope: null,
  portals: new Map()
}

export const CanvasArea: React.FC = () => {
  const { nodes: storeNodes, edges: storeEdges, addNode, addEdge, setNodes, setEdges, setViewport, commitHistory, undo, redo, setSelectedNodeId, selectedNodeId, deleteNode, deleteEdge, activeWorkspace, activeFloor, setPendingTerminalRect, setRecruitModalOpen, setPendingFilesRect, setFilesModalOpen, updateNode } = useWorkspaceStore()
  // The landing floor is the legacy/default canvas and is stored as NULL so
  // existing workspaces created before floors were introduced remain visible.
  const persistedFloorId = activeFloor?.isLanding ? null : activeFloor?.id || null
  const [connectMode, setConnectMode] = useState(false)
  const [connectionSourceId, setConnectionSourceId] = useState<string | null>(null)
  const [connectionPointer, setConnectionPointer] = useState<{ x: number; y: number } | null>(null)
  const [connectionHoverId, setConnectionHoverId] = useState<string | null>(null)
  const [focusSnapshot, setFocusSnapshot] = useState<CanvasNodeData | null>(null)
  const focusViewportRef = useRef<{ x: number; y: number; zoom: number } | null>(null)
  const focusTransitionRef = useRef(0)
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null)
  // The cursor is the single navigation mode: dragging empty canvas pans,
  // while dragging a node belongs to that node.
  const [tool, setTool] = useState<CanvasTool>('select')
  const [drawStart, setDrawStart] = useState<{ x: number; y: number; flowX: number; flowY: number } | null>(null)
  const [drawRect, setDrawRect] = useState<{ left: number; top: number; width: number; height: number } | null>(null)
  const flowRef = useRef<ReactFlowInstance | null>(null)
  const drawPointsRef = useRef<Array<{ x: number; y: number }>>([])
  // React Flow's measured dimensions are internal DOM state. Keep them in a
  // runtime-only cache so controlled domain rerenders do not reset a node to
  // the uninitialized state that causes error#015 during a drag.
  const measuredNodeDimensionsRef = useRef<Map<string, CanvasNodeMeasurement>>(new Map())
  const [measurementRevision, setMeasurementRevision] = useState(0)
  const hydratedWorkspaceRef = useRef<string | null>(null)
  const persistedNodeIdsRef = useRef<Set<string>>(new Set())
  const persistedEdgeIdsRef = useRef<Set<string>>(new Set())
  const persistedNodeHashesRef = useRef<Map<string, string>>(new Map())
  const persistedEdgeHashesRef = useRef<Map<string, string>>(new Map())
  const fittedWorkspaceRef = useRef<string | null>(null)

  useEffect(() => {
    measuredNodeDimensionsRef.current.clear()
    setMeasurementRevision((revision) => revision + 1)
  }, [activeWorkspace?.id, persistedFloorId])

  // WebContentsViews live in the Electron main process, outside React's
  // lifecycle. Reconcile them with the hydrated canvas so deleting a browser
  // through a keyboard shortcut, an external refresh, or a scope transition
  // cannot leave an invisible Chromium renderer running indefinitely.
  useEffect(() => {
    const workspaceId = activeWorkspace?.id
    const scope = workspaceId ? `${workspaceId}:${persistedFloorId || 'landing'}` : null
    const tracked = browserPortalInventory
    if (tracked.scope !== scope) {
      for (const portalId of tracked.portals.values()) {
        void window.orchestra?.portal?.destroy(portalId).catch(() => undefined)
      }
      browserPortalInventory.scope = scope
      browserPortalInventory.portals = new Map()
    }
    if (!scope || hydratedWorkspaceRef.current !== scope) return
    const next = new Map(storeNodes
      .filter((node) => node.kind === 'browser')
      .map((node) => [node.id, String(node.properties?.portalId || node.id)]))
    for (const [nodeId, portalId] of browserPortalInventory.portals) {
      if (!next.has(nodeId)) void window.orchestra?.portal?.destroy(portalId).catch(() => undefined)
    }
    browserPortalInventory.portals = next
  }, [activeWorkspace?.id, persistedFloorId, storeNodes])

  const nodeTypes = useMemo(() => ({
    terminal: TerminalNode,
    note: NoteNode,
    files: FilesNode,
    browser: BrowserNode,
    text: TextNode,
    shape: ShapeNode,
  }), [])
  const edgeTypes = useMemo(() => ({ rope: () => null }), [])

  useEffect(() => {
    const workspaceId = activeWorkspace?.id
    if (!workspaceId || !window.orchestra?.invoke) return
    const canvasScopeKey = `${workspaceId}:${persistedFloorId || 'landing'}`
    let cancelled = false
    hydratedWorkspaceRef.current = null
    fittedWorkspaceRef.current = null
    Promise.all([
      window.orchestra.invoke('canvas.node.list', { workspaceId, floorId: persistedFloorId }),
      window.orchestra.invoke('canvas.edge.list', { workspaceId, floorId: persistedFloorId }),
      window.orchestra.invoke('canvas.viewport.get', { workspaceId, floorId: persistedFloorId })
    ]).then(([storedNodes, storedEdges, storedViewport]) => {
      if (cancelled) return
      const nextNodes = Array.isArray(storedNodes) ? storedNodes as CanvasNodeData[] : []
      const nextEdges = Array.isArray(storedEdges)
        ? (storedEdges as CanvasEdgeData[]).map((edge) => normalizeBrowserEdgePermissions(edge, nextNodes))
        : []
      setNodes(nextNodes)
      setEdges(nextEdges)
      persistedNodeIdsRef.current = new Set(nextNodes.map((node) => node.id))
      persistedEdgeIdsRef.current = new Set(nextEdges.map((edge) => edge.id))
      persistedNodeHashesRef.current = new Map(nextNodes.map((node) => [node.id, JSON.stringify(node)]))
      persistedEdgeHashesRef.current = new Map(nextEdges.map((edge) => [edge.id, JSON.stringify(edge)]))
      // Persist the compatibility repair so CLI requests work immediately,
      // including when the user starts an agent before creating a new cable.
      nextEdges.forEach((edge, index) => {
        const original = Array.isArray(storedEdges) ? (storedEdges as CanvasEdgeData[])[index] : undefined
        if (original && JSON.stringify(original) !== JSON.stringify(edge)) {
          window.orchestra?.invoke('canvas.edge.save', { workspaceId, floorId: persistedFloorId, edge }).catch(() => undefined)
        }
      })
      if (storedViewport && typeof storedViewport === 'object') {
        const viewportKey = `${workspaceId}:${activeFloor?.id || 'landing'}`
        setViewport(viewportKey, storedViewport as { x: number; y: number; zoom: number })
        window.setTimeout(() => flowRef.current?.setViewport(storedViewport as { x: number; y: number; zoom: number }), 0)
      }
      hydratedWorkspaceRef.current = canvasScopeKey
      if (Array.isArray(storedNodes) && storedNodes.length) {
        window.setTimeout(() => {
          if (!cancelled && fittedWorkspaceRef.current !== canvasScopeKey) {
            flowRef.current?.fitView({ padding: 0.18 })
            fittedWorkspaceRef.current = canvasScopeKey
          }
        }, 70)
      }
    }).catch(() => { hydratedWorkspaceRef.current = canvasScopeKey })
    return () => { cancelled = true }
  }, [activeFloor?.id, activeFloor?.isLanding, activeWorkspace?.id, persistedFloorId, setEdges, setNodes, setViewport])

  // CLI-created visible terminals and other external canvas writes are merged
  // into the live view. This avoids requiring Ctrl+R after a daemon action.
  useEffect(() => {
    const workspaceId = activeWorkspace?.id
    if (!workspaceId || !window.orchestra?.invoke) return
    let cancelled = false
    const refreshExternalNodes = async () => {
      try {
        const [remoteNodes, remoteEdges] = await Promise.all([
          window.orchestra?.invoke('canvas.node.list', { workspaceId, floorId: persistedFloorId }),
          window.orchestra?.invoke('canvas.edge.list', { workspaceId, floorId: persistedFloorId })
        ])
        if (cancelled || !Array.isArray(remoteNodes) || !Array.isArray(remoteEdges)) return
        const current = useWorkspaceStore.getState()
        const nextRemoteNodes = remoteNodes as CanvasNodeData[]
        const nextRemoteEdges = (remoteEdges as CanvasEdgeData[]).map((edge) => normalizeBrowserEdgePermissions(edge, nextRemoteNodes))
        const remoteNodeIds = new Set(nextRemoteNodes.map((node) => node.id))
        const remoteEdgeIds = new Set(nextRemoteEdges.map((edge) => edge.id))
        // Only remove records that were already observed as persisted. This
        // keeps a freshly-created local node alive during its debounce window,
        // while still reflecting CLI/agent deletions and allowing the portal
        // lifecycle reconciler to destroy their native WebContentsViews.
        const retainedNodes = current.nodes.filter((node) => !persistedNodeIdsRef.current.has(node.id) || remoteNodeIds.has(node.id))
        const retainedEdges = current.edges.filter((edge) => !persistedEdgeIdsRef.current.has(edge.id) || remoteEdgeIds.has(edge.id))
        const missingNodes = nextRemoteNodes.filter((node) => !retainedNodes.some((existing) => existing.id === node.id))
        const missingEdges = nextRemoteEdges.filter((edge) => !retainedEdges.some((existing) => existing.id === edge.id))
        if (missingNodes.length || retainedNodes.length !== current.nodes.length) current.setNodes([...retainedNodes, ...missingNodes])
        const repairedEdges = nextRemoteEdges.filter((edge) => {
          const previous = retainedEdges.find((existing) => existing.id === edge.id)
          return previous && JSON.stringify(previous) !== JSON.stringify(edge)
        })
        if (missingEdges.length || repairedEdges.length || retainedEdges.length !== current.edges.length) {
          const repairedById = new Map(repairedEdges.map((edge) => [edge.id, edge]))
          current.setEdges([
            ...retainedEdges.map((edge) => repairedById.get(edge.id) || edge),
            ...missingEdges
          ])
        }
        nextRemoteEdges.forEach((edge, index) => {
          const original = (remoteEdges as CanvasEdgeData[])[index]
          if (JSON.stringify(original) !== JSON.stringify(edge)) {
            window.orchestra?.invoke('canvas.edge.save', { workspaceId, floorId: persistedFloorId, edge }).catch(() => undefined)
          }
        })
      } catch { /* transient daemon errors are handled by the regular hydrate */ }
    }
    const timer = window.setInterval(() => { void refreshExternalNodes() }, 900)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [activeWorkspace?.id, persistedFloorId])

  useEffect(() => {
    const workspaceId = activeWorkspace?.id
    const canvasScopeKey = workspaceId ? `${workspaceId}:${persistedFloorId || 'landing'}` : null
    if (!workspaceId || hydratedWorkspaceRef.current !== canvasScopeKey || !window.orchestra?.invoke || focusSnapshot) return
    const timer = window.setTimeout(() => {
      const current = new Set(storeNodes.map((node) => node.id))
      for (const removedId of persistedNodeIdsRef.current) {
        if (!current.has(removedId)) {
          window.orchestra?.invoke('canvas.node.delete', { workspaceId, id: removedId }).catch(() => undefined)
          persistedNodeHashesRef.current.delete(removedId)
        }
      }
      storeNodes.forEach((node) => {
        const hash = JSON.stringify(node)
        if (persistedNodeHashesRef.current.get(node.id) === hash) return
        window.orchestra?.invoke('canvas.node.save', { workspaceId, floorId: persistedFloorId, node }).catch(() => undefined)
        persistedNodeHashesRef.current.set(node.id, hash)
      })
      persistedNodeIdsRef.current = current
    }, 350)
    return () => window.clearTimeout(timer)
  }, [activeWorkspace?.id, focusSnapshot, persistedFloorId, storeNodes])

  useEffect(() => {
    const workspaceId = activeWorkspace?.id
    const canvasScopeKey = workspaceId ? `${workspaceId}:${persistedFloorId || 'landing'}` : null
    if (!workspaceId || hydratedWorkspaceRef.current !== canvasScopeKey || !window.orchestra?.invoke || focusSnapshot) return
    const timer = window.setTimeout(() => {
      const current = new Set(storeEdges.map((edge) => edge.id))
      for (const removedId of persistedEdgeIdsRef.current) {
        if (!current.has(removedId)) {
          window.orchestra?.invoke('canvas.edge.delete', { workspaceId, id: removedId }).catch(() => undefined)
          persistedEdgeHashesRef.current.delete(removedId)
        }
      }
      storeEdges.forEach((edge) => {
        const hash = JSON.stringify(edge)
        if (persistedEdgeHashesRef.current.get(edge.id) === hash) return
        window.orchestra?.invoke('canvas.edge.save', { workspaceId, floorId: persistedFloorId, edge }).catch(() => undefined)
        persistedEdgeHashesRef.current.set(edge.id, hash)
      })
      persistedEdgeIdsRef.current = current
    }, 350)
    return () => window.clearTimeout(timer)
  }, [activeWorkspace?.id, focusSnapshot, persistedFloorId, storeEdges])

  // Real-time canvas context sync for terminal agents & notes
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const terminalNodes = storeNodes.filter((n) => n.kind === 'terminal')
      if (terminalNodes.length === 0) return

      // Build a unified context for ALL terminals
      const allTerminals = terminalNodes.map((termNode) => {
        const connectedEdges = storeEdges.filter((e) => e.source === termNode.id || e.target === termNode.id)
        const connectedNodeIds = connectedEdges.map((e) => (e.source === termNode.id ? e.target : e.source))
        const connectedNodes = storeNodes.filter((n) => connectedNodeIds.includes(n.id))

        return {
          sessionId: termNode.id,
          agent: termNode.properties.agent || termNode.properties.title || 'Terminal',
          cwd: termNode.properties.cwd || '',
          connectedNotes: connectedNodes.filter((n) => n.kind === 'note').map((n) => ({
            id: n.id,
            title: n.properties.title || 'NOTE',
            content: n.properties.content || ''
          })),
          connectedPeerAgents: connectedNodes.filter((n) => n.kind === 'terminal').map((n) => ({
            id: n.id,
            agent: n.properties.agent || n.properties.title || 'Agent',
          })),
          connectedBrowsers: connectedNodes.filter((n) => n.kind === 'browser').map((n) => ({
            id: n.id,
            title: n.properties.title || 'Browser',
            url: n.properties.url || ''
          })),
          connectedFileTrees: connectedNodes.filter((n) => n.kind === 'files').map((n) => ({
            id: n.id,
            title: n.properties.title || 'File Tree',
            path: n.properties.path || ''
          }))
        }
      })

      window.orchestra?.syncCanvasContext?.(allTerminals).catch(() => {})
    }, 500)
    return () => window.clearTimeout(timer)
  }, [storeNodes, storeEdges])

  // Listen for live external note updates (e.g. from AI agents writing to .orchestra/canvas_context.json)
  useEffect(() => {
    if (!window.orchestra?.onEvent) return
    const cleanup = window.orchestra.onEvent((event) => {
      const payload = event.payload || {}
      if (event.type === 'agent.request.progress' && typeof payload.targetSessionId === 'string' && typeof payload.status === 'string') {
        const statusMap: Record<string, string> = { queued: 'queued', delivering: 'running', generating: 'thinking', completed: 'completed', cancelled: 'cancelled', timed_out: 'error' }
        const nextStatus = statusMap[payload.status] || payload.status
        const target = storeNodes.find((node) => node.id === payload.targetSessionId)
        if (target && target.kind === 'terminal' && target.properties.status !== nextStatus) {
          updateNode(target.id, { properties: { ...target.properties, status: nextStatus } })
        }
      }
      if (event.type === 'orchestra:note-external-update' && typeof payload.id === 'string' && typeof payload.content === 'string') {
        const existingNode = storeNodes.find((node) => node.id === payload.id)
        if (existingNode && existingNode.properties.content !== payload.content) {
          updateNode(existingNode.id, {
            properties: { ...existingNode.properties, content: payload.content }
          })
        }
        return
      }

      if (event.type === 'orchestra:canvas-external-update' && Array.isArray(payload.terminals)) {
        payload.terminals.filter((term): term is Record<string, unknown> => Boolean(term && typeof term === 'object')).forEach((term) => {
          const notes = Array.isArray(term.connectedNotes) ? term.connectedNotes : []
          notes.filter((note): note is Record<string, unknown> => Boolean(note && typeof note === 'object')).forEach((n) => {
              if (typeof n.id === 'string' && typeof n.content === 'string') {
                const existingNode = storeNodes.find((node) => node.id === n.id)
                if (existingNode && existingNode.properties.content !== n.content) {
                  updateNode(n.id, {
                    properties: {
                      ...existingNode.properties,
                      content: n.content,
                      title: typeof n.title === 'string' ? n.title : existingNode.properties.title
                    }
                  })
                }
              }
            })
        })
      }
    })
    return () => cleanup()
  }, [storeNodes, updateNode])


  const workspaceRef = useRef<HTMLDivElement>(null)

  // Pinch is handled in one place for every DOM surface inside the board. In
  // particular, React Flow's d3 listener otherwise competes with our handler
  // on `.nowheel` nodes (terminal/editor) and ignores Meta+wheel on Linux.
  // Keeping the latest viewport locally also prevents a burst of wheel
  // packets from calculating several updates from the same stale transform.
  const pinchViewportRef = useRef<{ x: number; y: number; zoom: number } | null>(null)
  const pinchResetTimerRef = useRef<number | null>(null)
  const pinchMotionActiveRef = useRef(false)

  const setPinchMotion = useCallback((active: boolean) => {
    if (pinchMotionActiveRef.current === active) return
    pinchMotionActiveRef.current = active
    window.dispatchEvent(new CustomEvent('orchestra:canvas-motion', {
      detail: { active, reason: 'pinch' }
    }))
  }, [])

  const endPinchMotion = useCallback(() => {
    pinchViewportRef.current = null
    if (pinchResetTimerRef.current !== null) {
      window.clearTimeout(pinchResetTimerRef.current)
      pinchResetTimerRef.current = null
    }
    setPinchMotion(false)
  }, [setPinchMotion])

  const finishPinchSoon = useCallback(() => {
    if (pinchResetTimerRef.current !== null) window.clearTimeout(pinchResetTimerRef.current)
    pinchResetTimerRef.current = window.setTimeout(() => {
      pinchViewportRef.current = null
      pinchResetTimerRef.current = null
      setPinchMotion(false)
    }, 180)
  }, [setPinchMotion])

  useEffect(() => () => {
    endPinchMotion()
  }, [endPinchMotion])

  const applyBoardPinch = useCallback((anchor: { x: number; y: number }, zoomFactor: number, pan: { x?: number; y?: number } = {}) => {
    if (focusSnapshot) return
    const flow = flowRef.current
    if (!flow || !Number.isFinite(anchor.x) || !Number.isFinite(anchor.y)) return
    setPinchMotion(true)
    const viewport = pinchViewportRef.current || flow.getViewport()
    const zoomedViewport = zoomFactor === 1 ? viewport : getCanvasPinchViewport(viewport, anchor, zoomFactor)
    // Wheel deltas describe content motion: scrolling right moves the board
    // left, so subtract the native delta from React Flow's screen translation.
    const nextViewport = getCanvasPinchPanViewport(
      zoomedViewport,
      Number.isFinite(pan.x) ? Number(pan.x) : 0,
      Number.isFinite(pan.y) ? Number(pan.y) : 0
    )
    pinchViewportRef.current = nextViewport
    // `setViewport` has no animation here: every packet is one part of the
    // same native gesture and must keep the exact screen-space anchor fixed.
    void flow.setViewport(nextViewport).catch(() => undefined)
    finishPinchSoon()
  }, [finishPinchSoon, focusSnapshot, setPinchMotion])

  // React Flow intentionally ignores wheel events inside `.nowheel` nodes.
  // Trackpad pinch is encoded as ctrl/meta+wheel in Chromium/Electron. Own
  // that event at capture phase for the whole workspace, including the pane,
  // so React Flow cannot zoom the same packet a second time. Plain wheel and
  // pointer drag are left to React Flow/node scroll containers.
  useEffect(() => {
    const workspace = workspaceRef.current
    if (!workspace) return

    const resetPinchViewport = () => {
      // A real pointer gesture (node drag, canvas pan, toolbar click) starts a
      // new interaction domain. Do not let its first wheel packet reuse the
      // previous pinch's locally accumulated transform.
      endPinchMotion()
    }

    const handlePinchWheel = (event: WheelEvent) => {
      if (focusSnapshot) return
      const target = event.target
      if (!(target instanceof Element)) return
      // Toolbars, node-local editors/xterm and browser surfaces own their
      // wheel stream. This guard deliberately runs before pinch detection so
      // a ctrl/meta packet cannot move the board underneath a `.nowheel`
      // terminal or editor either.
      if (target.closest('.react-flow__node, .nowheel, .canvas-toolbar, .canvas-context-toolbar, .zoom')) {
        resetPinchViewport()
        return
      }

      const isPinch = isCanvasPinchWheelEvent(event)
      const plainGesture = getCanvasBoardWheelGesture(event, {
        // `.nowheel` is an explicit contract used by xterm, editors and
        // browser surfaces. Keep the node guard as well because native
        // BrowserNode WebContentsViews are not descendants of this DOM tree.
        blocked: false
      })
      const isHorizontalPan = !isPinch && plainGesture === 'horizontal-pan'
      // A two-finger vertical trackpad packet is a plain wheel event in
      // Chromium (there is no reliable touch-count on WheelEvent). Treat it
      // as board zoom only while the pointer is over the empty pane. Nodes
      // keep their own scroll semantics: xterm/editor `.nowheel` surfaces
      // and the native browser portal must never be hijacked here.
      const isVerticalBoardZoom = !isPinch && plainGesture === 'vertical-zoom'
      if (!isPinch && !isHorizontalPan && !isVerticalBoardZoom) {
        // Other wheel packets remain owned by the target's scroll container.
        resetPinchViewport()
        return
      }

      // Prevent Chromium's native page zoom for pinch and stop both React
      // Flow's d3 listener and node-local editors/xterm from seeing a
      // horizontal board-pan packet.
      event.preventDefault()
      event.stopPropagation()

      const renderer = workspace.querySelector<HTMLElement>('.react-flow__renderer')
      const bounds = renderer?.getBoundingClientRect() || workspace.getBoundingClientRect()
      const anchor = getCanvasPinchAnchor({ x: event.clientX, y: event.clientY }, bounds)
      const isMacOS = typeof navigator !== 'undefined' && /Mac/.test(navigator.userAgent)
      applyBoardPinch(anchor, (isPinch || isVerticalBoardZoom) ? canvasPinchZoomFactor(event, isMacOS) : 1, {
        x: isHorizontalPan ? event.deltaX : 0
      })
    }

    workspace.addEventListener('pointerdown', resetPinchViewport, { capture: true })
    workspace.addEventListener('wheel', handlePinchWheel, { capture: true, passive: false })
    return () => {
      workspace.removeEventListener('pointerdown', resetPinchViewport, true)
      workspace.removeEventListener('wheel', handlePinchWheel, true)
    }
  }, [applyBoardPinch, endPinchMotion, focusSnapshot])

  // A WebContentsView used by BrowserNode is a native child of Electron's
  // contentView, so its wheel events never bubble through #workspace. The
  // main process forwards the already-normalized native portal packet here.
  // This keeps the board anchor math identical for canvas, terminal, editor
  // and browser content without trying to zoom the page inside the portal.
  useEffect(() => {
    if (!window.orchestra?.onEvent) return
    return window.orchestra.onEvent((event) => {
      if (focusSnapshot || event.type !== 'portal:pinch') return
      const payload = event.payload || {}
      const phase = payload.phase
      if (phase === 'begin') return
      if (phase === 'end' || phase === 'cancel') {
        endPinchMotion()
        return
      }
      const x = Number(payload.x)
      const y = Number(payload.y)
      if (!Number.isFinite(x) || !Number.isFinite(y)) return
      const factor = canvasPinchGestureFactor(payload.zoomFactor)
      if (factor === 1 && payload.zoomFactor !== 1) return
      // Main emits native WebContentsView coordinates relative to the whole
      // renderer window. ReactFlow's viewport math is relative to its own
      // renderer, which may start below the topbar and beside the sidebar.
      const renderer = workspaceRef.current?.querySelector<HTMLElement>('.react-flow__renderer')
      const bounds = renderer?.getBoundingClientRect() || workspaceRef.current?.getBoundingClientRect()
      if (!bounds) return
      applyBoardPinch(getCanvasPinchAnchor({ x, y }, bounds), factor, {
        x: Number.isFinite(Number(payload.panX)) ? Number(payload.panX) : 0,
        y: Number.isFinite(Number(payload.panY)) ? Number(payload.panY) : 0
      })
    })
  }, [applyBoardPinch, endPinchMotion, focusSnapshot])

  // Map Zustand nodes to ReactFlow nodes
  const reactFlowNodes = useMemo(() => {
    // Device/phone nodes are a removed feature. Keep old persisted records
    // hidden instead of asking React Flow to render an obsolete node type.
    return storeNodes.filter((n) => !['device', 'routine'].includes(String(n.kind))).map((n) => {
      const width = n.width || 300
      const height = n.height || 200
      // Seed the first projection with the persisted dimensions. The node
      // style is fixed to these dimensions, so this is a safe initialization
      // fallback while the DOM measurement pass is still pending.
      const measured = measuredNodeDimensionsRef.current.get(n.id) || { width, height }
      return {
        id: n.id,
        type: n.kind,
        position: { x: n.x, y: n.y },
        width,
        height,
        initialWidth: width,
        initialHeight: height,
        measured,
        style: { width, height },
        selected: selectedNodeId === n.id,
        data: {
          properties: n.properties || {},
          width,
          height,
          selected: selectedNodeId === n.id,
          zIndex: n.zIndex ?? 1,
          focusModeActive: Boolean(focusSnapshot),
          focused: focusSnapshot?.id === n.id,
          interactive: !connectMode && tool === 'select'
        },
        className: focusSnapshot ? (focusSnapshot.id === n.id ? 'canvas-node-focus' : 'canvas-node-blurred') : ''
      }
    })
  }, [connectMode, focusSnapshot?.id, measurementRevision, selectedNodeId, storeNodes, tool])

  // Map Zustand edges to ReactFlow edges
  const reactFlowEdges = useMemo(() => {
    const visibleNodeIds = new Set(storeNodes.filter((node) => !['device', 'routine'].includes(String(node.kind))).map((node) => node.id))
    return storeEdges.filter((e) => visibleNodeIds.has(e.source) && visibleNodeIds.has(e.target)).map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      label: e.label,
      type: 'rope',
      selected: e.id === selectedEdgeId
    }))
  }, [selectedEdgeId, storeEdges])

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      const result = applyCanvasNodeChanges(
        changes,
        storeNodes,
        measuredNodeDimensionsRef.current,
        selectedNodeId,
      )

      if (result.measurements.size !== measuredNodeDimensionsRef.current.size || result.measurements.size > 0) {
        const measurementsChanged = [...result.measurements].some(([id, measurement]) => {
          const previous = measuredNodeDimensionsRef.current.get(id)
          return !previous || previous.width !== measurement.width || previous.height !== measurement.height
        })
        if (measurementsChanged) {
          measuredNodeDimensionsRef.current = result.measurements
          setMeasurementRevision((revision) => revision + 1)
        }
      }

      if (result.removedNodeIds.length > 0) {
        result.removedNodeIds.forEach((id) => {
          measuredNodeDimensionsRef.current.delete(id)
          deleteNode(id)
        })
      }

      if (result.positionChanged) setNodes(result.nodes)

      const nextSelectedNodeId = result.removedNodeIds.includes(result.selectedNodeId) ? null : result.selectedNodeId
      if (nextSelectedNodeId !== selectedNodeId) setSelectedNodeId(nextSelectedNodeId)
    },
    [deleteNode, selectedNodeId, setNodes, setSelectedNodeId, storeNodes]
  )

  const connectionPermissions = useCallback((sourceId: string, targetId: string) => {
    const edge = { source: sourceId, target: targetId }
    const permissions = [...GENERIC_CONNECTION_PERMISSIONS]
    // Browser portals have a separate authenticated bridge. Check both
    // endpoints: a cable may be drawn browser -> terminal even though its
    // effective resource direction is terminal -> browser.
    if (isTerminalBrowserConnection(edge, storeNodes)) {
      permissions.push(...BROWSER_CONNECTION_PERMISSIONS.filter((permission) => !permissions.includes(permission)))
    }
    return permissions
  }, [storeNodes])

  const onConnect = useCallback(
    (params: Connection) => {
      if (params.source && params.target) {
        const newEdge = {
          id: `e_${params.source}_${params.target}`,
          source: params.source,
          target: params.target,
          label: 'connected', permissions: connectionPermissions(params.source, params.target)
        }
        addEdge(newEdge)
        setConnectMode(false)
        setConnectionSourceId(null)
      }
    },
    [addEdge, connectionPermissions]
  )

  const handleAddNode = (kind: CanvasNodeData['kind'], position?: { x: number; y: number }, dimensions?: { width: number; height: number }) => {
    const id = `${kind}_${Date.now()}`
    const newNode: CanvasNodeData = {
      id,
      kind,
      x: position?.x ?? 200 + Math.random() * 200,
      y: position?.y ?? 150 + Math.random() * 150,
      width: dimensions?.width ?? (kind === 'terminal' ? 420 : kind === 'files' ? 330 : 300),
      height: dimensions?.height ?? (kind === 'terminal' ? 250 : kind === 'files' ? 280 : 220),
      properties: {
        title: kind.toUpperCase(),
        cwd: activeFloor?.path || activeWorkspace?.path || '',
        agent: kind === 'terminal' ? 'Claude Code' : undefined,
        ...(kind === 'browser' ? { url: 'about:blank' } : {})
      }
    }
    addNode(newNode)
    setSelectedNodeId(id)
  }

  const selectTool = (nextTool: typeof tool) => {
    setTool(nextTool)
    setConnectMode(false)
  }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (!event.altKey || target?.matches('input, textarea, [contenteditable="true"]')) return
      const shortcuts: Record<string, CanvasTool> = { v: 'select', t: 'terminal', n: 'note', e: 'files', b: 'browser', x: 'text', s: 'shape', p: 'draw' }
      const next = shortcuts[event.key.toLowerCase()]
      if (!next) return
      event.preventDefault()
      selectTool(next)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [tool])

  useEffect(() => {
    const finishOnEnter = (event: KeyboardEvent) => {
      if (event.key !== 'Enter' || !connectMode || !connectionSourceId || !connectionHoverId || connectionHoverId === connectionSourceId) return
      event.preventDefault()
      const exists = storeEdges.some((edge) => edge.source === connectionSourceId && edge.target === connectionHoverId)
      if (!exists) addEdge({ id: `e_${connectionSourceId}_${connectionHoverId}`, source: connectionSourceId, target: connectionHoverId, label: 'connected', permissions: connectionPermissions(connectionSourceId, connectionHoverId) })
      setConnectMode(false); setConnectionSourceId(null); setConnectionPointer(null); setConnectionHoverId(null); setSelectedNodeId(connectionHoverId)
    }
    window.addEventListener('keydown', finishOnEnter)
    return () => window.removeEventListener('keydown', finishOnEnter)
  }, [addEdge, connectMode, connectionPermissions, connectionSourceId, connectionHoverId, setSelectedNodeId, storeEdges])

  const restoreFocus = useCallback(() => {
    if (!focusSnapshot) return
    const transition = ++focusTransitionRef.current
    const previousViewport = focusViewportRef.current
    focusViewportRef.current = null
    const restoredNodes = storeNodes.map((node) => node.id === focusSnapshot.id
      ? { ...node, x: focusSnapshot.x, y: focusSnapshot.y, width: focusSnapshot.width, height: focusSnapshot.height, zIndex: focusSnapshot.zIndex, locked: focusSnapshot.locked, collapsed: focusSnapshot.collapsed }
      : node)
    const finish = () => {
      if (focusTransitionRef.current !== transition) return
      setNodes(restoredNodes)
      focusSnapshotRef.current = null
      setFocusSnapshot(null)
    }
    if (previousViewport && flowRef.current) {
      void flowRef.current.setViewport(previousViewport).then(finish).catch(finish)
    } else {
      finish()
    }
  }, [focusSnapshot, setNodes, storeNodes])

  const toggleFocus = useCallback((nodeId: string) => {
    if (focusSnapshot?.id === nodeId) { restoreFocus(); return }
    const restoredNodes = focusSnapshot
      ? storeNodes.map((item) => item.id === focusSnapshot.id
        ? { ...item, x: focusSnapshot.x, y: focusSnapshot.y, width: focusSnapshot.width, height: focusSnapshot.height, zIndex: focusSnapshot.zIndex, locked: focusSnapshot.locked, collapsed: focusSnapshot.collapsed }
        : item)
      : storeNodes
    const node = restoredNodes.find((item) => item.id === nodeId)
    if (!node || !flowRef.current) return
    const canvasBounds = workspaceRef.current?.getBoundingClientRect()
    const canvasWidth = Math.max(1, canvasBounds?.width || window.innerWidth)
    const canvasHeight = Math.max(1, canvasBounds?.height || window.innerHeight)
    // Focus uses a neutral 1:1 React Flow viewport. Keeping the focused node
    // in CSS-pixel flow coordinates prevents xterm/WebGL and native portal
    // children from being painted into a tiny transformed surface.
    const availableWidth = Math.max(320, canvasWidth - 48)
    const availableHeight = Math.max(220, canvasHeight - 92)
    const size = {
      width: availableWidth,
      height: availableHeight
    }
    if (!focusViewportRef.current) focusViewportRef.current = flowRef.current.getViewport()
    const transition = ++focusTransitionRef.current
    const focusedNodes = restoredNodes.map((item) => item.id === node.id ? { ...item, x: 24, y: 46, ...size } : item)
    // React Flow applies its viewport transform asynchronously. Applying the
    // enlarged node and focus blur in the same tick used to expose one frame
    // with the old pan/zoom, which looked like every node suddenly growing and
    // the focused browser being clipped. Neutralize the transform first, then
    // publish the focus state after that transform has committed.
    void flowRef.current.setViewport({ x: 0, y: 0, zoom: 1 }).then(() => {
      if (focusTransitionRef.current !== transition) return
      setNodes(focusedNodes)
      focusSnapshotRef.current = node
      setFocusSnapshot(node)
    }).catch(() => {
      if (focusTransitionRef.current !== transition) return
      setNodes(focusedNodes)
      focusSnapshotRef.current = node
      setFocusSnapshot(node)
    })
  }, [focusSnapshot, restoreFocus, setNodes, storeNodes])

  // Keep the focused node inside the actual workspace when the window or
  // browser viewport is resized while Focus mode is active. The snapshot
  // remains untouched, so Escape still restores the user's original geometry.
  useEffect(() => {
    if (!focusSnapshot) return
    const syncFocusedBounds = () => {
      const flow = flowRef.current
      const workspace = workspaceRef.current
      if (!flow || !workspace) return
      const bounds = workspace.getBoundingClientRect()
      const availableWidth = Math.max(320, bounds.width - 48)
      const availableHeight = Math.max(220, bounds.height - 92)
      const size = { width: availableWidth, height: availableHeight }
      const currentNodes = useWorkspaceStore.getState().nodes
      const focused = currentNodes.find((node) => node.id === focusSnapshot.id)
      if (!focused) return
      const next = { x: 24, y: 46, ...size }
      if (focused.x === next.x && focused.y === next.y && focused.width === next.width && focused.height === next.height) return
      setNodes(currentNodes.map((node) => node.id === focused.id ? { ...node, ...next } : node))
    }
    syncFocusedBounds()
    window.addEventListener('resize', syncFocusedBounds)
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(syncFocusedBounds) : null
    if (workspaceRef.current) observer?.observe(workspaceRef.current)
    return () => {
      window.removeEventListener('resize', syncFocusedBounds)
      observer?.disconnect()
    }
  }, [focusSnapshot, setNodes])

  // Focus is scoped to one workspace/floor. Do not carry a stale snapshot or
  // native suppression lease into the next canvas; its hydration will provide
  // the correct node geometry and live browser URL.
  const focusScopeRef = useRef<string | null>(null)
  const focusSnapshotRef = useRef<CanvasNodeData | null>(null)
  useEffect(() => {
    focusSnapshotRef.current = focusSnapshot
  }, [focusSnapshot])
  useEffect(() => {
    // Include the floor record id even for a landing floor. This makes a
    // workspace/floor transition a hard focus boundary rather than relying on
    // the legacy NULL backend floor id.
    const scope = `${activeWorkspace?.id || 'none'}:${activeFloor?.id || persistedFloorId || 'landing'}`
    if (focusScopeRef.current === null) {
      focusScopeRef.current = scope
      return
    }
    if (focusScopeRef.current !== scope) {
      const previousScope = focusScopeRef.current
      const snapshot = focusSnapshotRef.current
      const previousWorkspaceId = previousScope.split(':', 1)[0]
      const nextWorkspaceId = (activeWorkspace?.id || 'none')
      // When only the floor changes, restore the old node before hydration so
      // a transient daemon delay cannot persist the expanded Focus geometry
      // into the next floor. Workspace changes replace the node collection and
      // therefore must not mutate a coincidentally reused node id.
      if (snapshot && previousWorkspaceId === nextWorkspaceId) {
        const currentNodes = useWorkspaceStore.getState().nodes
        if (currentNodes.some((node) => node.id === snapshot.id)) {
          setNodes(currentNodes.map((node) => node.id === snapshot.id
            ? { ...node, x: snapshot.x, y: snapshot.y, width: snapshot.width, height: snapshot.height, zIndex: snapshot.zIndex, locked: snapshot.locked, collapsed: snapshot.collapsed }
            : node))
        }
      }
      const previousViewport = focusViewportRef.current
      focusViewportRef.current = null
      focusScopeRef.current = scope
      focusSnapshotRef.current = null
      setFocusSnapshot(null)
      if (previousViewport && flowRef.current) void flowRef.current.setViewport(previousViewport)
    }
  }, [activeFloor?.id, activeWorkspace?.id, persistedFloorId, setNodes])

  // A focused non-browser node must not leave a native portal painting above
  // the dimmed canvas. Browser focus keeps its own WebContentsView visible so
  // the page remains interactive.
  useEffect(() => {
    const portal = window.orchestra?.portal
    if (!portal?.suppress) return
    const suppress = Boolean(focusSnapshot && focusSnapshot.kind !== 'browser')
    void portal.suppress('focus', suppress).catch(() => undefined)
    return () => {
      if (suppress) void portal.suppress('focus', false).catch(() => undefined)
    }
  }, [focusSnapshot])

  useEffect(() => {
    const onFocusNode = (event: Event) => {
      const nodeId = (event as CustomEvent<{ nodeId?: string }>).detail?.nodeId
      if (nodeId) toggleFocus(nodeId)
    }
    window.addEventListener('orchestra:focus-node', onFocusNode)
    return () => window.removeEventListener('orchestra:focus-node', onFocusNode)
  }, [toggleFocus])

  useEffect(() => {
    const exitOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      restoreFocus(); setTool('select'); setConnectMode(false); setConnectionSourceId(null); setConnectionPointer(null)
    }
    window.addEventListener('keydown', exitOnEscape)
    return () => window.removeEventListener('keydown', exitOnEscape)
  }, [restoreFocus])

  const onWorkspaceMouseDown = (event: React.MouseEvent) => {
    if (event.button !== 0 || !flowRef.current) return
    const targetEl = event.target as HTMLElement
    
    // Ignore if clicking on a resize handle
    if (targetEl.closest('.react-flow__resize-control') || targetEl.closest('.resize-handle')) {
      return
    }

    if (targetEl.closest('.canvas-toolbar') || targetEl.closest('.canvas-context-toolbar') || targetEl.closest('.zoom')) return
    // React Flow owns panning, pinch and node dragging in select mode. This
    // handler only creates a node when a creation tool is active.
    if (tool === 'select' || focusSnapshot || targetEl.closest('.react-flow__node')) return

    // Capture this before React Flow can turn the same pointer gesture into
    // panning or selection. Tool drags belong exclusively to node creation.
    event.preventDefault()
    event.stopPropagation()

    const flow = flowRef.current.screenToFlowPosition({ x: event.clientX, y: event.clientY })
    drawPointsRef.current = tool === 'draw' ? [{ x: flow.x, y: flow.y }] : []
    setDrawStart({ x: event.clientX, y: event.clientY, flowX: flow.x, flowY: flow.y })
    setDrawRect({ left: event.clientX, top: event.clientY, width: 0, height: 0 })
  }

  const onWorkspaceMouseMove = (event: React.MouseEvent) => {
    if (connectMode && connectionSourceId) setConnectionPointer({ x: event.clientX, y: event.clientY })

    if (!drawStart) return
    event.preventDefault()
    event.stopPropagation()
    if (tool === 'draw' && flowRef.current) {
      drawPointsRef.current.push(flowRef.current.screenToFlowPosition({ x: event.clientX, y: event.clientY }))
    }
    setDrawRect({
      left: Math.min(drawStart.x, event.clientX),
      top: Math.min(drawStart.y, event.clientY),
      width: Math.abs(event.clientX - drawStart.x),
      height: Math.abs(event.clientY - drawStart.y)
    })
  }

  const onWorkspaceMouseUp = (event: React.MouseEvent) => {
    if (!drawStart || !flowRef.current) return
    event.preventDefault()
    event.stopPropagation()
    const target = flowRef.current.screenToFlowPosition({ x: event.clientX, y: event.clientY })
    const draggedWidth = Math.abs(target.x - drawStart.flowX)
    const draggedHeight = Math.abs(target.y - drawStart.flowY)
    
    // Default size for each node type
    const defaultSizes: Record<string, { width: number; height: number }> = {
      terminal: { width: 440, height: 260 },
      note: { width: 280, height: 230 },
      files: { width: 380, height: 300 },
      browser: { width: 380, height: 260 },
      text: { width: 200, height: 80 },
      shape: { width: 200, height: 140 }
    }
    const def = defaultSizes[tool] || { width: 300, height: 200 }

    let width = draggedWidth > 25 ? Math.max(120, draggedWidth) : def.width
    let height = draggedHeight > 25 ? Math.max(80, draggedHeight) : def.height
    
    const nodeKind = tool === 'draw' ? 'shape' : tool as Exclude<CanvasTool, 'select' | 'draw'>
    const position = draggedWidth > 25 && draggedHeight > 25
      ? { x: Math.min(drawStart.flowX, target.x), y: Math.min(drawStart.flowY, target.y) }
      : { x: drawStart.flowX - width / 2, y: drawStart.flowY - height / 2 }

    if (tool === 'terminal') {
      setPendingTerminalRect({ x: position.x, y: position.y, width, height })
      setRecruitModalOpen(true)
    } else if (tool === 'files') {
      // File Trees need a real root before mounting: opening the picker here
      // avoids creating a node that immediately points at the wrong workspace.
      setPendingFilesRect({ x: position.x, y: position.y, width, height })
      setFilesModalOpen(true)
    } else if (tool === 'draw') {
      const id = `shape_${Date.now()}`
      const points = [...drawPointsRef.current, target].map((point) => ({ x: point.x - position.x, y: point.y - position.y }))
      addNode({ id, kind: 'shape', ...position, width, height, properties: { drawing: true, points } })
      setSelectedNodeId(id)
    } else {
      handleAddNode(nodeKind, position, { width, height })
    }

    setDrawStart(null)
    setDrawRect(null)
    setTool('select')
  }

  const selectedNode = storeNodes.find((node) => node.id === selectedNodeId && !['device', 'routine'].includes(String(node.kind)))
  const connectionCapabilities = GENERIC_CONNECTION_PERMISSIONS
  const selectedEdge = selectedEdgeId ? storeEdges.find((edge) => edge.id === selectedEdgeId) : undefined
  const visibleConnectionCapabilities = selectedEdge && isTerminalBrowserConnection(selectedEdge, storeNodes)
    ? BROWSER_CONNECTION_PERMISSIONS
    : connectionCapabilities
  const toggleEdgePermission = (permission: string) => {
    if (!selectedEdgeId) return
    commitHistory()
    setEdges(storeEdges.map((edge) => {
      if (edge.id !== selectedEdgeId) return edge
      const current = edge.permissions || visibleConnectionCapabilities
      const permissions = current.includes(permission)
        ? current.filter((value) => value !== permission)
        : [...current, permission]
      return { ...edge, permissions }
    }))
  }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return
      const target = event.target as HTMLElement | null
      if (target?.matches('input, textarea, [contenteditable="true"]')) return
      if (event.key.toLowerCase() === 'z') {
        event.preventDefault()
        if (event.shiftKey) redo()
        else undo()
      } else if (event.key.toLowerCase() === 'y') {
        event.preventDefault()
        redo()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [redo, undo])
  const pendingRope = null
  const duplicateSelected = () => {
    if (!selectedNode) return
    const duplicateId = `${selectedNode.kind}_${Date.now()}`
    // A native BrowserNode is keyed by its portal id rather than by the
    // ReactFlow node id. Copying the old property would make both nodes share
    // one WebContentsView, so a duplicate could paint over the original (or
    // follow the other node while the board is moving). Every duplicated
    // browser gets an independent native portal session.
    const duplicateProperties = {
      ...selectedNode.properties,
      title: `${selectedNode.properties.title || selectedNode.kind} copy`,
      ...(selectedNode.kind === 'browser' ? { portalId: duplicateId } : {})
    }
    addNode({
      ...selectedNode,
      id: duplicateId,
      x: selectedNode.x + 28,
      y: selectedNode.y + 28,
      properties: duplicateProperties
    })
  }

  const noteAction = (command: 'bold' | 'italic' | 'list' | 'check') => {
    window.dispatchEvent(new CustomEvent('orchestra:note-action', { detail: { command, nodeId: selectedNodeId } }))
  }
  const toolLabel: Record<CanvasTool, string> = { select: 'Selecionar', terminal: 'Terminal', note: 'Nota', files: 'File Tree', browser: 'Portal', text: 'Texto', shape: 'Forma', draw: 'Desenhar' }

  const handleZoomIn = () => {
    flowRef.current?.zoomIn({ duration: 140 })
  }
  const handleZoomOut = () => {
    flowRef.current?.zoomOut({ duration: 140 })
  }
  const handleFitView = () => {
    flowRef.current?.fitView({ padding: 0.18, duration: 180 })
  }

  return (
    <div
      id="workspace"
      ref={workspaceRef}
      onMouseDownCapture={onWorkspaceMouseDown}
      onMouseMoveCapture={onWorkspaceMouseMove}
      onMouseUpCapture={onWorkspaceMouseUp}
      style={{ cursor: tool === 'select' ? 'default' : 'crosshair' }}
    >
      <ReactFlow
        nodes={reactFlowNodes}
        edges={reactFlowEdges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onConnect={onConnect}
        // The cursor is the single navigation mode: a primary-button drag on
        // empty pane pans the workspace, while a drag that starts on a node
        // belongs to that node. Creation tools intercept empty-pane drags.
        panOnDrag={focusSnapshot ? false : tool === 'select'}
        selectionOnDrag={false}
        panOnScroll={!focusSnapshot}
        zoomOnScroll={!focusSnapshot}
        zoomOnPinch={!focusSnapshot}
        // Chromium page zoom is used to preserve each browser's logical CSS
        // viewport while the canvas is scaled. Keep React Flow inside the
        // same supported range so a desktop portal never flips to a mobile
        // breakpoint merely because the board was zoomed too far out.
        minZoom={CANVAS_MIN_ZOOM}
        maxZoom={CANVAS_MAX_ZOOM}
        zoomOnDoubleClick={false}
        preventScrolling={false}
        nodesDraggable={!focusSnapshot}
        elementsSelectable
        onNodeClick={(_, node) => {
          if (connectMode && connectionSourceId && connectionSourceId !== node.id) {
            const exists = storeEdges.some((edge) => edge.source === connectionSourceId && edge.target === node.id)
            if (!exists) addEdge({ id: `e_${connectionSourceId}_${node.id}`, source: connectionSourceId, target: node.id, label: 'connected', permissions: connectionPermissions(connectionSourceId, node.id) })
            setConnectMode(false); setConnectionSourceId(null); setConnectionPointer(null); setSelectedNodeId(node.id)
            return
          }
          setSelectedEdgeId(null); setSelectedNodeId(node.id)
        }}
        onMoveStart={() => window.dispatchEvent(new CustomEvent('orchestra:canvas-motion', { detail: { active: true, reason: 'viewport' } }))}
        onNodeDragStart={() => {
          commitHistory()
          window.dispatchEvent(new CustomEvent('orchestra:canvas-motion', { detail: { active: true, reason: 'node' } }))
        }}
        onNodeDrag={() => window.dispatchEvent(new CustomEvent('orchestra:canvas-motion', { detail: { active: true, reason: 'node' } }))}
        onNodeDragStop={() => window.dispatchEvent(new CustomEvent('orchestra:canvas-motion', { detail: { active: false, reason: 'node' } }))}
        onNodeDoubleClick={(_, node) => toggleFocus(node.id)}
        onNodeMouseEnter={(_, node) => { if (connectMode) setConnectionHoverId(node.id) }}
        onNodeMouseLeave={() => setConnectionHoverId(null)}
        onEdgeClick={(_, edge) => { setSelectedNodeId(null); setSelectedEdgeId(edge.id) }}
        onInit={(instance) => {
          flowRef.current = instance
          const viewportKey = `${activeWorkspace?.id || 'workspace'}:${useWorkspaceStore.getState().activeFloor?.id || 'landing'}`
          const storedViewport = useWorkspaceStore.getState().viewports[viewportKey]
          if (storedViewport) instance.setViewport(storedViewport)
        }}
        onMove={(_, viewport) => {
          window.dispatchEvent(new CustomEvent('orchestra:canvas-motion', { detail: { active: true, reason: 'viewport' } }))
          const label = document.getElementById('zoom-label')
          if (label) label.innerText = `${Math.round(viewport.zoom * 100)}%`
        }}
        onMoveEnd={(_, viewport) => {
          window.dispatchEvent(new CustomEvent('orchestra:canvas-motion', { detail: { active: false, reason: 'viewport' } }))
          if (focusSnapshotRef.current) return
          const viewportKey = `${activeWorkspace?.id || 'workspace'}:${useWorkspaceStore.getState().activeFloor?.id || 'landing'}`
          useWorkspaceStore.getState().setViewport(viewportKey, viewport)
          const currentFloor = useWorkspaceStore.getState().activeFloor
          const backendFloorId = currentFloor?.isLanding ? null : currentFloor?.id || null
          if (activeWorkspace?.id) window.orchestra?.invoke('canvas.viewport.save', { workspaceId: activeWorkspace.id, floorId: backendFloorId, viewport }).catch(() => undefined)
        }}
        onPaneClick={() => { setSelectedNodeId(null); setSelectedEdgeId(null); setConnectMode(false); setConnectionSourceId(null); setConnectionPointer(null) }}
        connectionLineStyle={{ stroke: 'var(--primary)', strokeWidth: 2, strokeDasharray: '6 7' }}
        className={`${connectMode ? 'canvas-connecting' : ''} ${tool !== 'select' ? 'canvas-draw-mode' : ''} ${tool === 'select' ? 'canvas-cursor-mode' : ''} ${focusSnapshot ? 'canvas-focus-active' : ''}`}
      >
        <Background id="grid-lines" variant={BackgroundVariant.Lines} color="#272c37" gap={24} size={1} />
        <Background id="grid-dots" variant={BackgroundVariant.Dots} color="#485266" gap={24} size={1.5} />
        {storeNodes.length > 0 && <MiniMap
          style={{ width: 128, height: 78, background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 8, opacity: .92 }}
          nodeColor={() => '#505762'}
          maskColor="rgba(11, 12, 14, .55)"
          pannable
        />}
        <CableSystem
          connectMode={connectMode}
          connectionSourceId={connectionSourceId}
          connectionPointer={connectionPointer}
          connectionHoverId={connectionHoverId}
          selectedEdgeId={selectedEdgeId}
          onEdgeClick={(id) => {
            setSelectedNodeId(null);
            setSelectedEdgeId(id);
          }}
        />
      </ReactFlow>

      {/* Floating Zoom Bar (Bottom Right) */}
      <div className="zoom" aria-label="Controlo de Zoom">
        <button onClick={handleZoomOut} title="Diminuir Zoom (-)">−</button>
        <span id="zoom-label">100%</span>
        <button onClick={handleZoomIn} title="Aumentar Zoom (+)">+</button>
        <button onClick={handleFitView} title="Ajustar ao ecrã (Fit)">Fit</button>
      </div>

      {drawRect && <div className="canvas-draw-rect" style={{ left: drawRect.left, top: drawRect.top, width: drawRect.width, height: drawRect.height }} />}
      {pendingRope && <svg className="pending-rope" aria-hidden="true"><path d={pendingRope.d} /></svg>}
      {focusSnapshot && <div className="focus-mode-pill">Modo foco <button onClick={restoreFocus}>Esc · Voltar</button></div>}
      {tool !== 'select' && <div className="canvas-mode-banner"><b>{toolLabel[tool]}</b><span>Arrasta no canvas para criar</span><kbd>Esc</kbd></div>}

      {storeNodes.length === 0 && (
        <div className="canvas-empty-state">
          <span className="empty-diagram"><i /><i /><i /></span>
          <h2>Começa por adicionar um agente.</h2>
          <p>Arrasta no canvas para decidir onde o elemento fica.</p>
          <div>
            <button className="btn primary" onClick={() => selectTool('terminal')}>Adicionar terminal</button>
            <button className="btn" onClick={() => selectTool('note')}>Adicionar nota</button>
          </div>
        </div>
      )}

      {(selectedNode || selectedEdgeId) && (
        <div className="canvas-context-toolbar" aria-label={selectedEdgeId ? 'Ações da conexão' : `Ações para ${selectedNode?.kind}`}>
          {selectedEdgeId && <>
            <span className="connection-selection">Conexão selecionada</span>
            {visibleConnectionCapabilities.map((permission) => {
              const edge = storeEdges.find((item) => item.id === selectedEdgeId)
              const enabled = (edge?.permissions || connectionCapabilities).includes(permission)
              return (
                <button
                  key={permission}
                  className={enabled ? 'active' : ''}
                  onClick={() => toggleEdgePermission(permission)}
                  title={enabled ? `Remover permissão: ${permission}` : `Permitir: ${permission}`}
                >
                  {permission}
                </button>
              )
            })}
            <button className="danger" onClick={() => { deleteEdge(selectedEdgeId); setSelectedEdgeId(null) }} title="Desconectar"><Trash2 className="icon" /></button>
          </>}
          {selectedNode && <>
          {selectedNode.kind === 'note' && (
            <>
              <button onClick={() => noteAction('bold')} title="Negrito"><Bold className="icon" /></button>
              <button onClick={() => noteAction('italic')} title="Itálico"><Italic className="icon" /></button>
              <button onClick={() => noteAction('list')} title="Lista"><List className="icon" /></button>
              <button onClick={() => noteAction('check')} title="Checklist"><CheckSquare className="icon" /></button>
              <span className="context-separator" />
            </>
          )}
          {selectedNode.kind === 'terminal' && (
            <>
              <button title="Editar terminal"><Pencil className="icon" /></button>
              <button title="Reiniciar terminal"><RotateCw className="icon" /></button>
              <span className="context-separator" />
            </>
          )}
          <button className={connectMode ? 'active' : ''} onClick={() => {
            const next = !connectMode
            setConnectMode(next); setConnectionSourceId(next ? selectedNode.id : null); setConnectionPointer(null)
          }} title="Criar conexão">
            <Cable className="icon" /><small>{storeEdges.filter((edge) => edge.source === selectedNode.id || edge.target === selectedNode.id).length}</small>
          </button>
          <button onClick={duplicateSelected} title="Duplicar"><Copy className="icon" /></button>
          <button className="danger" onClick={() => deleteNode(selectedNode.id)} title="Eliminar"><Trash2 className="icon" /></button>
          </>}
        </div>
      )}

      {/* Floating Canvas Lower Toolbar */}
      <div className="canvas-toolbar">
        <button className={`tool ${tool === 'select' ? 'active' : ''}`} onClick={() => selectTool('select')} title="Cursor · arrasta o canvas vazio · Alt + V">
          <MousePointer className="icon" />
          <span className="tip">Cursor · arrasta o canvas vazio · Alt + V</span>
        </button>

        <div className="tool-divider" />

        <button className={`tool ${tool === 'terminal' ? 'active' : ''}`} onClick={() => selectTool('terminal')} title="Terminal · Alt + T">
          <Terminal className="icon" />
          <span className="tip">Terminal · Alt + T</span>
        </button>

        <button className={`tool ${tool === 'note' ? 'active' : ''}`} onClick={() => selectTool('note')} title="Nota · Alt + N">
          <FileText className="icon" />
          <span className="tip">Nota · Alt + N</span>
        </button>

        <button className={`tool ${tool === 'files' ? 'active' : ''}`} onClick={() => selectTool('files')} title="File Tree · Alt + E">
          <FolderTree className="icon" />
          <span className="tip">File Tree · Alt + E</span>
        </button>

        <button className={`tool ${tool === 'browser' ? 'active' : ''}`} onClick={() => selectTool('browser')} title="Portal · Alt + B">
          <Globe className="icon" />
          <span className="tip">Portal · Alt + B</span>
        </button>

        <div className="tool-divider" />

        <button className={`tool ${tool === 'text' ? 'active' : ''}`} onClick={() => selectTool('text')} title="Texto · Alt + X">
          <Type className="icon" />
          <span className="tip">Texto · Alt + X</span>
        </button>

        <button className={`tool ${tool === 'shape' ? 'active' : ''}`} onClick={() => selectTool('shape')} title="Forma · Alt + S">
          <Square className="icon" />
          <span className="tip">Forma · Alt + S</span>
        </button>

        <button className={`tool ${tool === 'draw' ? 'active' : ''}`} onClick={() => selectTool('draw')} title="Desenhar · Alt + P">
          <PenLine className="icon" />
          <span className="tip">Desenhar · Alt + P</span>
        </button>

      </div>
    </div>
  )
}
