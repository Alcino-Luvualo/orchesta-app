import React, { useMemo, useCallback, useEffect, useRef, useState } from 'react'
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  Connection,
  ReactFlowInstance,
  PanOnScrollMode
} from '@xyflow/react'
import { useWorkspaceStore, CanvasNodeData } from '../../store/workspaceStore'
import { TerminalNode } from '../Nodes/TerminalNode'
import { NoteNode } from '../Nodes/NoteNode'
import { FilesNode } from '../Nodes/FilesNode'
import { BrowserNode } from '../Nodes/BrowserNode'
import { DeviceNode } from '../Nodes/DeviceNode'
import { TextNode } from '../Nodes/TextNode'
import { ShapeNode } from '../Nodes/ShapeNode'
import { Terminal, FileText, FolderTree, Globe, Smartphone, MousePointer, Cable, Copy, Trash2, Pencil, RotateCw, Bold, Italic, List, CheckSquare, PenLine, Square, Type } from 'lucide-react'
import { RopeEdge } from './RopeEdge'

export const CanvasArea: React.FC = () => {
  const { nodes: storeNodes, edges: storeEdges, addNode, setNodes, setEdges, setSelectedNodeId, selectedNodeId, deleteNode, deleteEdge, activeWorkspace, setPendingTerminalRect, setRecruitModalOpen } = useWorkspaceStore()
  const [connectMode, setConnectMode] = useState(false)
  const [connectionSourceId, setConnectionSourceId] = useState<string | null>(null)
  const [connectionPointer, setConnectionPointer] = useState<{ x: number; y: number } | null>(null)
  const [connectionHoverId, setConnectionHoverId] = useState<string | null>(null)
  const [focusSnapshot, setFocusSnapshot] = useState<CanvasNodeData | null>(null)
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null)
  const [tool, setTool] = useState<'select' | 'terminal' | 'note' | 'files' | 'browser' | 'device' | 'text' | 'shape' | 'draw'>('select')
  const [drawStart, setDrawStart] = useState<{ x: number; y: number; flowX: number; flowY: number } | null>(null)
  const [drawRect, setDrawRect] = useState<{ left: number; top: number; width: number; height: number } | null>(null)
  const flowRef = useRef<ReactFlowInstance | null>(null)
  const drawPointsRef = useRef<Array<{ x: number; y: number }>>([])
  const hydratedWorkspaceRef = useRef<string | null>(null)
  const persistedNodeIdsRef = useRef<Set<string>>(new Set())
  const persistedEdgeIdsRef = useRef<Set<string>>(new Set())
  const fittedWorkspaceRef = useRef<string | null>(null)

  const nodeTypes = useMemo(() => ({
    terminal: TerminalNode,
    note: NoteNode,
    files: FilesNode,
    browser: BrowserNode,
    device: DeviceNode,
    text: TextNode,
    shape: ShapeNode
  }), [])

  const edgeTypes = useMemo(() => ({ rope: RopeEdge }), [])

  useEffect(() => {
    const workspaceId = activeWorkspace?.id
    if (!workspaceId || !window.orchestra?.invoke) return
    let cancelled = false
    hydratedWorkspaceRef.current = null
    fittedWorkspaceRef.current = null
    Promise.all([
      window.orchestra.invoke('canvas.node.list', { workspaceId }),
      window.orchestra.invoke('canvas.edge.list', { workspaceId })
    ]).then(([storedNodes, storedEdges]) => {
      if (cancelled) return
      if (Array.isArray(storedNodes) && storedNodes.length) setNodes(storedNodes as CanvasNodeData[])
      if (Array.isArray(storedEdges) && storedEdges.length) setEdges(storedEdges)
      persistedNodeIdsRef.current = new Set(Array.isArray(storedNodes) ? storedNodes.map((node: CanvasNodeData) => node.id) : [])
      persistedEdgeIdsRef.current = new Set(Array.isArray(storedEdges) ? storedEdges.map((edge: { id: string }) => edge.id) : [])
      hydratedWorkspaceRef.current = workspaceId
      if (Array.isArray(storedNodes) && storedNodes.length) {
        window.setTimeout(() => {
          if (!cancelled && fittedWorkspaceRef.current !== workspaceId) {
            flowRef.current?.fitView({ padding: .18, duration: 220 })
            fittedWorkspaceRef.current = workspaceId
          }
        }, 70)
      }
    }).catch(() => { hydratedWorkspaceRef.current = workspaceId })
    return () => { cancelled = true }
  }, [activeWorkspace?.id, setEdges, setNodes])

  useEffect(() => {
    const workspaceId = activeWorkspace?.id
    if (!workspaceId || hydratedWorkspaceRef.current !== workspaceId || !window.orchestra?.invoke || focusSnapshot) return
    const timer = window.setTimeout(() => {
      const current = new Set(storeNodes.map((node) => node.id))
      for (const removedId of persistedNodeIdsRef.current) if (!current.has(removedId)) window.orchestra?.invoke('canvas.node.delete', { id: removedId }).catch(() => undefined)
      storeNodes.forEach((node) => window.orchestra?.invoke('canvas.node.save', { workspaceId, node }).catch(() => undefined))
      persistedNodeIdsRef.current = current
    }, 350)
    return () => window.clearTimeout(timer)
  }, [activeWorkspace?.id, focusSnapshot, storeNodes])

  useEffect(() => {
    const workspaceId = activeWorkspace?.id
    if (!workspaceId || hydratedWorkspaceRef.current !== workspaceId || !window.orchestra?.invoke || focusSnapshot) return
    const timer = window.setTimeout(() => {
      const current = new Set(storeEdges.map((edge) => edge.id))
      for (const removedId of persistedEdgeIdsRef.current) if (!current.has(removedId)) window.orchestra?.invoke('canvas.edge.delete', { id: removedId }).catch(() => undefined)
      storeEdges.forEach((edge) => window.orchestra?.invoke('canvas.edge.save', { workspaceId, edge }).catch(() => undefined))
      persistedEdgeIdsRef.current = current
    }, 350)
    return () => window.clearTimeout(timer)
  }, [activeWorkspace?.id, focusSnapshot, storeEdges])

  // Real-time canvas context sync for terminal agents & notes
  useEffect(() => {
    const terminalNodes = storeNodes.filter((n) => n.kind === 'terminal')
    if (terminalNodes.length === 0) return

    terminalNodes.forEach((termNode) => {
      const connectedEdges = storeEdges.filter((e) => e.source === termNode.id || e.target === termNode.id)
      const connectedNodeIds = connectedEdges.map((e) => (e.source === termNode.id ? e.target : e.source))
      const connectedNodes = storeNodes.filter((n) => connectedNodeIds.includes(n.id))

      const noteNodes = connectedNodes.filter((n) => n.kind === 'note')
      const peerTerminals = connectedNodes.filter((n) => n.kind === 'terminal')

      const contextSummary = {
        sessionId: termNode.id,
        terminalTitle: termNode.properties.title || 'Terminal',
        connectedNotes: noteNodes.map((n) => ({
          id: n.id,
          title: n.properties.title || 'NOTE',
          content: n.properties.content || ''
        })),
        connectedPeerAgents: peerTerminals.map((n) => ({
          id: n.id,
          title: n.properties.title || n.properties.agent || 'Agente'
        }))
      }

      if ((window as any).orchestra?.syncCanvasContext) {
        ;(window as any).orchestra.syncCanvasContext(contextSummary).catch(() => {})
      }
    })
  }, [storeNodes, storeEdges])

  const workspaceRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = workspaceRef.current
    if (!el) return
    const handleWheel = (e: WheelEvent) => {
      e.preventDefault()
      const instance = flowRef.current
      if (!instance) return

      // Smooth zoom in/out for mouse wheel and trackpad pinch
      const zoomFactor = e.deltaY < 0 ? 1.09 : 0.91
      const currentZoom = instance.getZoom()
      const nextZoom = Math.max(0.15, Math.min(3.0, currentZoom * zoomFactor))

      instance.zoomTo(nextZoom, { duration: 30 })
      setZoomLevel(Math.round(nextZoom * 100))
    }
    el.addEventListener('wheel', handleWheel, { passive: false })
    return () => el.removeEventListener('wheel', handleWheel)
  }, [])

  // Map Zustand nodes to ReactFlow nodes
  const reactFlowNodes = useMemo(() => {
    return storeNodes.map((n) => ({
      id: n.id,
      type: n.kind,
      position: { x: n.x, y: n.y },
      style: { width: n.width, height: n.height },
      selected: selectedNodeId === n.id,
      data: { properties: n.properties, width: n.width, height: n.height, selected: selectedNodeId === n.id },
      className: focusSnapshot?.id === n.id ? 'canvas-node-focus' : ''
    }))
  }, [focusSnapshot?.id, selectedNodeId, storeNodes])

  // Map Zustand edges to ReactFlow edges
  const reactFlowEdges = useMemo(() => {
    return storeEdges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      label: e.label,
      type: 'rope',
      selected: e.id === selectedEdgeId
    }))
  }, [storeEdges])

  const onNodesChange = useCallback(
    (changes: any) => {
      let updated = false
      const rectsTouch = (
        r1: { x: number; y: number; width: number; height: number },
        r2: { x: number; y: number; width: number; height: number },
        gap = 8
      ) => {
        return !(
          r1.x + r1.width + gap <= r2.x ||
          r1.x >= r2.x + r2.width + gap ||
          r1.y + r1.height + gap <= r2.y ||
          r1.y >= r2.y + r2.height + gap
        )
      }

      const newNodes = storeNodes.map((n) => {
        const change = changes.find((c: any) => c.id === n.id && c.type === 'position' && c.position)
        if (change?.type === 'position') {
          const wantedX = Math.round(change.position.x)
          const wantedY = Math.round(change.position.y)

          // Test horizontal movement
          const candidateX = { ...n, x: wantedX }
          const collideX = storeNodes.some((other) => other.id !== n.id && rectsTouch(candidateX, other))
          const finalX = collideX ? n.x : wantedX

          // Test vertical movement
          const candidateY = { ...n, x: finalX, y: wantedY }
          const collideY = storeNodes.some((other) => other.id !== n.id && rectsTouch(candidateY, other))
          const finalY = collideY ? n.y : wantedY

          if (finalX !== n.x || finalY !== n.y) {
            updated = true
            return { ...n, x: finalX, y: finalY }
          }
        }
        return n
      })
      if (updated) {
        setNodes(newNodes)
      }
    },
    [storeNodes, setNodes]
  )

  const onConnect = useCallback(
    (params: Connection) => {
      if (params.source && params.target) {
        const newEdge = {
          id: `e_${params.source}_${params.target}`,
          source: params.source,
          target: params.target,
          label: 'connected'
        }
        setEdges([...storeEdges, newEdge])
        setConnectMode(false)
        setConnectionSourceId(null)
      }
    },
    [storeEdges, setEdges]
  )

  const handleAddNode = (kind: CanvasNodeData['kind'], position?: { x: number; y: number }, dimensions?: { width: number; height: number }) => {
    const id = `${kind}_${Date.now()}`
    const newNode: CanvasNodeData = {
      id,
      kind,
      x: position?.x ?? 200 + Math.random() * 200,
      y: position?.y ?? 150 + Math.random() * 150,
      width: dimensions?.width ?? (kind === 'terminal' ? 420 : kind === 'files' ? 330 : kind === 'device' ? 250 : 300),
      height: dimensions?.height ?? (kind === 'terminal' ? 250 : kind === 'files' ? 280 : kind === 'device' ? 510 : 220),
      properties: {
        title: kind.toUpperCase(),
        cwd: '~/dev/commerce',
        agent: kind === 'terminal' ? 'Claude Code' : undefined,
        role: kind === 'terminal' ? 'Developer' : undefined
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
      const shortcuts: Record<string, typeof tool> = { v: 'select', t: 'terminal', n: 'note', e: 'files', b: 'browser', d: 'device', x: 'text', s: 'shape', p: 'draw' }
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
      if (!exists) setEdges([...storeEdges, { id: `e_${connectionSourceId}_${connectionHoverId}`, source: connectionSourceId, target: connectionHoverId, label: 'connected' }])
      setConnectMode(false); setConnectionSourceId(null); setConnectionPointer(null); setConnectionHoverId(null); setSelectedNodeId(connectionHoverId)
    }
    window.addEventListener('keydown', finishOnEnter)
    return () => window.removeEventListener('keydown', finishOnEnter)
  }, [connectMode, connectionSourceId, connectionHoverId, setEdges, setSelectedNodeId, storeEdges])

  const restoreFocus = useCallback(() => {
    if (!focusSnapshot) return
    setNodes(storeNodes.map((node) => node.id === focusSnapshot.id ? focusSnapshot : node))
    setFocusSnapshot(null)
  }, [focusSnapshot, setNodes, storeNodes])

  const toggleFocus = useCallback((nodeId: string) => {
    if (focusSnapshot?.id === nodeId) { restoreFocus(); return }
    const restoredNodes = focusSnapshot ? storeNodes.map((item) => item.id === focusSnapshot.id ? focusSnapshot : item) : storeNodes
    const node = restoredNodes.find((item) => item.id === nodeId)
    if (!node || !flowRef.current) return
    const size = node.kind === 'device'
      ? { width: 320, height: 690 }
      : { width: Math.min(900, Math.max(580, node.width)), height: Math.min(650, Math.max(410, node.height)) }
    const center = flowRef.current.screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 })
    setFocusSnapshot(node)
    setNodes(restoredNodes.map((item) => item.id === node.id ? { ...item, x: center.x - size.width / 2, y: center.y - size.height / 2, ...size } : item))
  }, [focusSnapshot, restoreFocus, setNodes, storeNodes])

  useEffect(() => {
    const exitOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      restoreFocus(); setTool('select'); setConnectMode(false); setConnectionSourceId(null); setConnectionPointer(null)
    }
    window.addEventListener('keydown', exitOnEscape)
    return () => window.removeEventListener('keydown', exitOnEscape)
  }, [restoreFocus])

  const onWorkspaceMouseDown = (event: React.MouseEvent) => {
    if (tool === 'select' || event.button !== 0 || !flowRef.current) return
    const targetEl = event.target as HTMLElement
    // Only capture on canvas pane or background
    if (targetEl.closest('.react-flow__node') || targetEl.closest('.canvas-toolbar') || targetEl.closest('.canvas-context-toolbar')) return
    const flow = flowRef.current.screenToFlowPosition({ x: event.clientX, y: event.clientY })
    drawPointsRef.current = tool === 'draw' ? [{ x: flow.x, y: flow.y }] : []
    setDrawStart({ x: event.clientX, y: event.clientY, flowX: flow.x, flowY: flow.y })
    setDrawRect({ left: event.clientX, top: event.clientY, width: 0, height: 0 })
  }

  const onWorkspaceMouseMove = (event: React.MouseEvent) => {
    if (connectMode && connectionSourceId) setConnectionPointer({ x: event.clientX, y: event.clientY })
    if (!drawStart) return
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
    const target = flowRef.current.screenToFlowPosition({ x: event.clientX, y: event.clientY })
    const draggedWidth = Math.abs(target.x - drawStart.flowX)
    const draggedHeight = Math.abs(target.y - drawStart.flowY)
    
    // Default size for each node type
    const defaultSizes: Record<string, { width: number; height: number }> = {
      terminal: { width: 440, height: 260 },
      note: { width: 280, height: 230 },
      files: { width: 380, height: 300 },
      browser: { width: 380, height: 260 },
      device: { width: 250, height: 510 },
      text: { width: 200, height: 80 },
      shape: { width: 200, height: 140 }
    }
    const def = defaultSizes[tool] || { width: 300, height: 200 }

    let width = draggedWidth > 25 ? Math.max(120, draggedWidth) : def.width
    let height = draggedHeight > 25 ? Math.max(80, draggedHeight) : def.height
    
    // Special ratio for device portal if dragged
    if (tool === 'device' && draggedHeight > 25) {
      width = Math.round(height * (250 / 510))
    }

    const nodeKind = tool === 'draw' ? 'shape' : tool as Exclude<typeof tool, 'select' | 'draw'>
    const position = draggedWidth > 25 && draggedHeight > 25
      ? { x: Math.min(drawStart.flowX, target.x), y: Math.min(drawStart.flowY, target.y) }
      : { x: drawStart.flowX - width / 2, y: drawStart.flowY - height / 2 }

    if (tool === 'terminal') {
      setPendingTerminalRect({ x: position.x, y: position.y, width, height })
      setRecruitModalOpen(true)
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

  const selectedNode = storeNodes.find((node) => node.id === selectedNodeId)
  const pendingRope = useMemo(() => {
    const source = storeNodes.find((node) => node.id === connectionSourceId)
    if (!source || !connectionPointer || !flowRef.current) return null
    const start = flowRef.current.flowToScreenPosition({ x: source.x + source.width, y: source.y + source.height / 2 })
    const sag = Math.max(18, Math.abs(connectionPointer.x - start.x) * .16)
    return { start, end: connectionPointer, d: `M ${start.x} ${start.y} C ${start.x + sag} ${start.y + 24}, ${connectionPointer.x - sag} ${connectionPointer.y + 24}, ${connectionPointer.x} ${connectionPointer.y}` }
  }, [storeNodes, connectionPointer, connectionSourceId])
  const duplicateSelected = () => {
    if (!selectedNode) return
    addNode({
      ...selectedNode,
      id: `${selectedNode.kind}_${Date.now()}`,
      x: selectedNode.x + 28,
      y: selectedNode.y + 28,
      properties: { ...selectedNode.properties, title: `${selectedNode.properties.title || selectedNode.kind} copy` }
    })
  }

  const noteAction = (command: 'bold' | 'italic' | 'list' | 'check') => {
    window.dispatchEvent(new CustomEvent('orchestra:note-action', { detail: command }))
  }
  const toolLabel: Record<typeof tool, string> = { select: 'Selecionar', terminal: 'Terminal', note: 'Nota', files: 'File Tree', browser: 'Portal', device: 'Device Portal', text: 'Texto', shape: 'Forma', draw: 'Desenhar' }

  const [zoomLevel, setZoomLevel] = useState(100)

  const handleZoomIn = () => {
    flowRef.current?.zoomIn({ duration: 200 })
  }
  const handleZoomOut = () => {
    flowRef.current?.zoomOut({ duration: 200 })
  }
  const handleFitView = () => {
    flowRef.current?.fitView({ padding: 0.18, duration: 250 })
  }

  return (
    <div
      id="workspace"
      ref={workspaceRef}
      onMouseDown={onWorkspaceMouseDown}
      onMouseMove={onWorkspaceMouseMove}
      onMouseUp={onWorkspaceMouseUp}
      style={{ cursor: tool === 'select' ? 'default' : 'crosshair' }}
    >
      <ReactFlow
        nodes={reactFlowNodes}
        edges={reactFlowEdges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onConnect={onConnect}
        panOnDrag={tool === 'select' ? [0, 1, 2] : false}
        selectionOnDrag={false}
        panOnScroll={false}
        zoomOnScroll={false}
        zoomOnPinch={false}
        zoomOnDoubleClick={false}
        preventScrolling={true}
        onMove={(_, viewport) => setZoomLevel(Math.round(viewport.zoom * 100))}
        onNodeClick={(_, node) => {
          if (connectMode && connectionSourceId && connectionSourceId !== node.id) {
            const exists = storeEdges.some((edge) => edge.source === connectionSourceId && edge.target === node.id)
            if (!exists) setEdges([...storeEdges, { id: `e_${connectionSourceId}_${node.id}`, source: connectionSourceId, target: node.id, label: 'connected' }])
            setConnectMode(false); setConnectionSourceId(null); setConnectionPointer(null); setSelectedNodeId(node.id)
            return
          }
          setSelectedEdgeId(null); setSelectedNodeId(node.id)
        }}
        onNodeDoubleClick={(_, node) => toggleFocus(node.id)}
        onNodeMouseEnter={(_, node) => { if (connectMode) setConnectionHoverId(node.id) }}
        onNodeMouseLeave={() => setConnectionHoverId(null)}
        onEdgeClick={(_, edge) => { setSelectedNodeId(null); setSelectedEdgeId(edge.id) }}
        onInit={(instance) => {
          flowRef.current = instance
          setZoomLevel(Math.round(instance.getZoom() * 100))
        }}
        onPaneClick={() => { setSelectedNodeId(null); setSelectedEdgeId(null); setConnectMode(false); setConnectionSourceId(null); setConnectionPointer(null) }}
        fitView
        fitViewOptions={{ padding: 0.18, maxZoom: 1 }}
        connectionLineStyle={{ stroke: 'var(--primary)', strokeWidth: 2, strokeDasharray: '6 7' }}
        className={`${connectMode ? 'canvas-connecting' : ''} ${tool !== 'select' ? 'canvas-draw-mode' : ''}`}
      >
        <Background color="#333840" gap={24} size={1} />
        {storeNodes.length > 0 && <MiniMap
          style={{ width: 128, height: 78, background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 8, opacity: .92 }}
          nodeColor={() => '#505762'}
          maskColor="rgba(11, 12, 14, .55)"
          pannable
        />}
      </ReactFlow>

      {/* Floating Zoom Bar (Bottom Right) */}
      <div className="zoom" aria-label="Controlo de Zoom">
        <button onClick={handleZoomOut} title="Diminuir Zoom (-)">−</button>
        <span>{zoomLevel}%</span>
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
        <button className={`tool ${tool === 'select' ? 'active' : ''}`} onClick={() => selectTool('select')} title="Selecionar · Alt + V">
          <MousePointer className="icon" />
          <span className="tip">Selecionar · Alt + V</span>
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

        <button className={`tool ${tool === 'device' ? 'active' : ''}`} onClick={() => selectTool('device')} title="Device Portal">
          <Smartphone className="icon" />
          <span className="tip">Device Portal</span>
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
