import React, { useMemo, useCallback } from 'react'
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  addEdge,
  Connection,
  Edge
} from '@xyflow/react'
import { useWorkspaceStore, CanvasNodeData } from '../../store/workspaceStore'
import { TerminalNode } from '../Nodes/TerminalNode'
import { NoteNode } from '../Nodes/NoteNode'
import { FilesNode } from '../Nodes/FilesNode'
import { BrowserNode } from '../Nodes/BrowserNode'
import { DeviceNode } from '../Nodes/DeviceNode'
import { RoutineNode } from '../Nodes/RoutineNode'
import { Terminal, FileText, FolderTree, Globe, Smartphone, Clock, Plus, MousePointer } from 'lucide-react'

export const CanvasArea: React.FC = () => {
  const { nodes: storeNodes, edges: storeEdges, addNode, setNodes, setEdges, setSelectedNodeId } = useWorkspaceStore()

  const nodeTypes = useMemo(() => ({
    terminal: TerminalNode,
    note: NoteNode,
    files: FilesNode,
    browser: BrowserNode,
    device: DeviceNode,
    routine: RoutineNode
  }), [])

  // Map Zustand nodes to ReactFlow nodes
  const reactFlowNodes = useMemo(() => {
    return storeNodes.map((n) => ({
      id: n.id,
      type: n.kind,
      position: { x: n.x, y: n.y },
      data: { properties: n.properties, width: n.width, height: n.height }
    }))
  }, [storeNodes])

  // Map Zustand edges to ReactFlow edges
  const reactFlowEdges = useMemo(() => {
    return storeEdges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      label: e.label,
      animated: true,
      style: { stroke: 'var(--primary)', strokeWidth: 2, strokeDasharray: '5,5' }
    }))
  }, [storeEdges])

  const onNodesChange = useCallback(
    (changes: any) => {
      // Handle node position changes with immutable updates
      let updated = false
      const newNodes = storeNodes.map((n) => {
        const change = changes.find((c: any) => c.type === 'position' && c.position && c.id === n.id)
        if (change) {
          updated = true
          return { ...n, x: change.position.x, y: change.position.y }
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
      }
    },
    [storeEdges, setEdges]
  )

  const handleAddNode = (kind: CanvasNodeData['kind']) => {
    const id = `${kind}_${Date.now()}`
    const newNode: CanvasNodeData = {
      id,
      kind,
      x: 200 + Math.random() * 200,
      y: 150 + Math.random() * 150,
      width: kind === 'terminal' ? 480 : kind === 'files' ? 440 : 320,
      height: kind === 'terminal' ? 280 : kind === 'files' ? 300 : 220,
      properties: {
        title: kind.toUpperCase(),
        cwd: '~/dev/commerce',
        agent: kind === 'terminal' ? 'Claude Code' : undefined,
        role: kind === 'terminal' ? 'Developer' : undefined
      }
    }
    addNode(newNode)
  }

  return (
    <div id="workspace">
      <ReactFlow
        nodes={reactFlowNodes}
        edges={reactFlowEdges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onConnect={onConnect}
        onNodeClick={(_, node) => setSelectedNodeId(node.id)}
        onPaneClick={() => setSelectedNodeId(null)}
        fitView
      >
        <Background color="#333840" gap={24} size={1} />
        <MiniMap
          style={{ background: '#111316dd', border: '1px solid var(--line)', borderRadius: 8 }}
          nodeColor={() => '#505762'}
        />
      </ReactFlow>

      {/* Floating Canvas Lower Toolbar */}
      <div className="canvas-toolbar">
        <button className="tool active" title="Ferramenta Seleção (V)">
          <MousePointer className="icon" />
        </button>

        <div className="tool-divider" />

        <button className="tool" onClick={() => handleAddNode('terminal')} title="Adicionar Terminal Node">
          <Terminal className="icon" />
          <span className="tip">Terminal</span>
        </button>

        <button className="tool" onClick={() => handleAddNode('note')} title="Adicionar Sticky Note">
          <FileText className="icon" />
          <span className="tip">Sticky Note</span>
        </button>

        <button className="tool" onClick={() => handleAddNode('files')} title="Adicionar Explorador de Ficheiros">
          <FolderTree className="icon" />
          <span className="tip">Files Tree</span>
        </button>

        <button className="tool" onClick={() => handleAddNode('browser')} title="Adicionar Browser Portal">
          <Globe className="icon" />
          <span className="tip">Browser Portal</span>
        </button>

        <button className="tool" onClick={() => handleAddNode('device')} title="Adicionar Device Portal">
          <Smartphone className="icon" />
          <span className="tip">Device Portal</span>
        </button>

        <button className="tool" onClick={() => handleAddNode('routine')} title="Adicionar Routine Node">
          <Clock className="icon" />
          <span className="tip">Routine Node</span>
        </button>
      </div>
    </div>
  )
}
