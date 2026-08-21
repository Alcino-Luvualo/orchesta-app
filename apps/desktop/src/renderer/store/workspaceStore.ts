import { create } from 'zustand'
import { findNonOverlappingPosition } from '../../shared/canvasPlacement'

export type NodeKind = 'terminal' | 'note' | 'files' | 'browser' | 'text' | 'shape'

export interface NodeProperties {
  [key: string]: unknown
  title?: string
  content?: string
  path?: string
  url?: string
  cwd?: string
  agent?: string
  status?: string
  command?: string
  portalId?: string
  text?: string
  drawing?: boolean
  points?: Array<{ x: number; y: number }>
  shapeType?: 'rectangle' | 'rounded' | 'ellipse' | 'diamond' | 'triangle' | 'star' | 'heart' | 'line'
  fill?: string
  stroke?: string
  strokeWidth?: number
  fontSize?: number
  fontWeight?: number
  fontStyle?: 'normal' | 'italic'
  textAlign?: 'left' | 'center' | 'right'
  autoEdit?: boolean
  smartDrawing?: boolean
  name?: string
}

export interface CanvasComponentData {
  properties: NodeProperties
  width?: number
  height?: number
  selected?: boolean
  zIndex?: number
  focusModeActive?: boolean
  focused?: boolean
  interactive?: boolean
}

export interface CanvasNodeData {
  id: string
  kind: NodeKind
  x: number
  y: number
  width: number
  height: number
  zIndex?: number
  locked?: boolean
  collapsed?: boolean
  properties: NodeProperties
}

export interface CanvasEdgeData {
  id: string
  source: string
  target: string
  sourcePort?: string
  targetPort?: string
  label?: string
  permissions?: string[]
}

export interface Workspace {
  id: string
  name: string
  path: string
  icon?: string
  color?: string
  activeFloorId?: string
  createdAt?: string
  updatedAt?: string
}

export interface Floor {
  id: string
  workspaceId?: string
  name: string
  branch: string
  path: string
  isLanding?: boolean
}

export interface ViewportState {
  x: number
  y: number
  zoom: number
}

interface CanvasSnapshot {
  nodes: CanvasNodeData[]
  edges: CanvasEdgeData[]
}

type Screen = 'canvas' | 'home' | 'environments'

interface WorkspaceState {
  currentScreen: Screen
  theme: 'dark' | 'light'
  activeWorkspace: Workspace | null
  workspaces: Workspace[]
  floors: Floor[]
  activeFloor: Floor | null
  nodes: CanvasNodeData[]
  edges: CanvasEdgeData[]
  viewports: Record<string, ViewportState>
  history: CanvasSnapshot[]
  future: CanvasSnapshot[]
  selectedNodeId: string | null
  pendingTerminalRect: { x: number; y: number; width: number; height: number } | null
  pendingFilesRect: { x: number; y: number; width: number; height: number } | null
  isCommandPaletteOpen: boolean
  isRecruitModalOpen: boolean
  isFilesModalOpen: boolean
  isFloorModalOpen: boolean
  isWorkspaceModalOpen: boolean
  editingWorkspace: Workspace | null
  daemonError: string | null

  setScreen: (screen: Screen) => void
  toggleTheme: () => void
  setActiveWorkspace: (workspace: Workspace | null) => void
  setWorkspaces: (workspaces: Workspace[]) => void
  createWorkspace: (name?: string, path?: string, appearance?: { icon?: string; color?: string }) => Promise<Workspace | null>
  updateWorkspace: (workspace: Workspace) => Promise<Workspace>
  removeWorkspace: (workspaceId: string) => Promise<void>
  editWorkspace: (workspace: Workspace) => void
  setFloors: (floors: Floor[]) => void
  setActiveFloor: (floor: Floor | null) => void
  setNodes: (nodes: CanvasNodeData[]) => void
  addNode: (node: CanvasNodeData) => void
  updateNode: (id: string, partial: Partial<CanvasNodeData>) => void
  deleteNode: (id: string) => void
  setEdges: (edges: CanvasEdgeData[]) => void
  addEdge: (edge: CanvasEdgeData) => void
  deleteEdge: (id: string) => void
  setViewport: (key: string, viewport: ViewportState) => void
  commitHistory: () => void
  undo: () => void
  redo: () => void
  setSelectedNodeId: (id: string | null) => void
  setPendingTerminalRect: (rect: { x: number; y: number; width: number; height: number } | null) => void
  setPendingFilesRect: (rect: { x: number; y: number; width: number; height: number } | null) => void
  setCommandPaletteOpen: (open: boolean) => void
  setRecruitModalOpen: (open: boolean) => void
  setFilesModalOpen: (open: boolean) => void
  setFloorModalOpen: (open: boolean) => void
  setWorkspaceModalOpen: (open: boolean) => void
  setDaemonError: (error: string | null) => void
}

const initialNodePosition = (nodes: CanvasNodeData[], node: CanvasNodeData) =>
  findNonOverlappingPosition(nodes, node, 24)

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  currentScreen: 'home',
  theme: 'dark',
  activeWorkspace: null,
  workspaces: [],
  floors: [],
  activeFloor: null,
  nodes: [],
  edges: [],
  viewports: {},
  history: [],
  future: [],
  selectedNodeId: null,
  pendingTerminalRect: null,
  pendingFilesRect: null,
  isCommandPaletteOpen: false,
  isRecruitModalOpen: false,
  isFilesModalOpen: false,
  isFloorModalOpen: false,
  isWorkspaceModalOpen: false,
  editingWorkspace: null,
  daemonError: null,

  setScreen: (currentScreen) => set({ currentScreen }),
  toggleTheme: () => {
    const next = get().theme === 'dark' ? 'light' : 'dark'
    document.documentElement.setAttribute('data-theme', next)
    set({ theme: next })
  },
  setActiveWorkspace: (activeWorkspace) => set((state) => {
    const changed = state.activeWorkspace?.id !== activeWorkspace?.id
    return {
      activeWorkspace,
      currentScreen: activeWorkspace ? 'canvas' : 'home',
      selectedNodeId: null,
      history: [],
      future: [],
      ...(changed ? { floors: [], activeFloor: null, nodes: [], edges: [] } : {})
    }
  }),
  setWorkspaces: (workspaces) => set({ workspaces }),
  createWorkspace: async (name, workspacePath, appearance) => {
    const path = workspacePath?.trim()
    if (!path) return null
    const workspace: Workspace = {
      id: `ws_${crypto.randomUUID()}`,
      name: name?.trim() || path.split('/').filter(Boolean).pop() || 'Workspace',
      path,
      icon: appearance?.icon || 'folder-kanban',
      color: appearance?.color || '#5ba7ff'
    }
    const saved = await window.orchestra?.invoke('workspace.save', { ...workspace }) as { path?: unknown } | undefined
    if (typeof saved?.path === 'string' && saved.path) workspace.path = saved.path
    set((state) => ({
      workspaces: [...state.workspaces.filter((item) => item.id !== workspace.id), workspace],
      activeWorkspace: workspace,
      activeFloor: null,
      floors: [],
      nodes: [],
      edges: [],
      selectedNodeId: null,
      currentScreen: 'canvas'
    }))
    return workspace
  },
  updateWorkspace: async (workspace) => {
    const saved = await window.orchestra?.invoke('workspace.save', { ...workspace }) as { path?: unknown } | undefined
    const updated = {
      ...workspace,
      path: typeof saved?.path === 'string' && saved.path ? saved.path : workspace.path
    }
    set((state) => ({
      workspaces: state.workspaces.map((item) => item.id === updated.id ? updated : item),
      activeWorkspace: state.activeWorkspace?.id === updated.id ? updated : state.activeWorkspace
    }))
    return updated
  },
  removeWorkspace: async (workspaceId) => {
    const current = get()
    if (current.activeWorkspace?.id === workspaceId) {
      for (const node of current.nodes) {
        if (node.kind === 'terminal') window.orchestra?.invoke('terminal.kill', { sessionId: node.id }).catch(() => undefined)
        if (node.kind === 'browser') window.orchestra?.portal?.destroy(String(node.properties?.portalId || node.id)).catch(() => undefined)
      }
    }
    await window.orchestra?.invoke('workspace.remove', { id: workspaceId })
    set((state) => {
      const wasActive = state.activeWorkspace?.id === workspaceId
      return {
        workspaces: state.workspaces.filter((item) => item.id !== workspaceId),
        ...(wasActive ? {
          activeWorkspace: null,
          activeFloor: null,
          floors: [],
          nodes: [],
          edges: [],
          selectedNodeId: null,
          history: [],
          future: [],
          currentScreen: 'home' as Screen
        } : {})
      }
    })
  },
  editWorkspace: (editingWorkspace) => set({ editingWorkspace, isWorkspaceModalOpen: true }),
  setFloors: (floors) => set({ floors }),
  setActiveFloor: (activeFloor) => set({ activeFloor, history: [], future: [] }),
  setNodes: (nodes) => set({ nodes }),
  addNode: (node) => set((state) => ({
    history: [...state.history, { nodes: state.nodes, edges: state.edges }].slice(-100),
    future: [],
    // Ink, shapes and text are compositional canvas content and may overlap
    // deliberately. Card-like resources (terminals, notes, files, browsers)
    // start in free space so automatic/manual creation never covers a peer.
    nodes: [...state.nodes, node.kind === 'shape' || node.kind === 'text'
      ? { ...node, x: Math.round(node.x), y: Math.round(node.y) }
      : { ...node, ...initialNodePosition(state.nodes, node) }]
  })),
  updateNode: (id, partial) => set((state) => ({
    nodes: state.nodes.map((node) => node.id !== id
      ? node
      : { ...node, ...partial, properties: { ...node.properties, ...(partial.properties || {}) } })
  })),
  deleteNode: (id) => {
    const node = get().nodes.find((item) => item.id === id)
    // Canvas focus is local renderer state. Notify CanvasArea before removing
    // the node so a focused close exits focus atomically instead of leaving a
    // black canvas with a stale focus snapshot that can rehydrate the node.
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('orchestra:node-deleting', { detail: { nodeId: id, kind: node?.kind } }))
    }
    if (node?.kind === 'terminal') window.orchestra?.invoke('terminal.kill', { sessionId: id }).catch(() => undefined)
    if (node?.kind === 'browser') {
      const portalId = String(node.properties?.portalId || node.id)
      window.orchestra?.portal?.destroy(portalId).catch(() => undefined)
    }
    set((state) => ({
      history: [...state.history, { nodes: state.nodes, edges: state.edges }].slice(-100),
      future: [],
      nodes: state.nodes.filter((nodeItem) => nodeItem.id !== id),
      edges: state.edges.filter((edge) => edge.source !== id && edge.target !== id),
      selectedNodeId: state.selectedNodeId === id ? null : state.selectedNodeId
    }))
  },
  setEdges: (edges) => set({ edges }),
  addEdge: (edge) => set((state) => state.edges.some((item) => item.id === edge.id)
    ? state
    : { history: [...state.history, { nodes: state.nodes, edges: state.edges }].slice(-100), future: [], edges: [...state.edges, edge] }),
  deleteEdge: (id) => set((state) => ({
    history: [...state.history, { nodes: state.nodes, edges: state.edges }].slice(-100),
    future: [],
    edges: state.edges.filter((edge) => edge.id !== id)
  })),
  setViewport: (key, viewport) => set((state) => ({ viewports: { ...state.viewports, [key]: viewport } })),
  commitHistory: () => set((state) => {
    const last = state.history[state.history.length - 1]
    if (last && JSON.stringify(last.nodes) === JSON.stringify(state.nodes) && JSON.stringify(last.edges) === JSON.stringify(state.edges)) return state
    return { history: [...state.history, { nodes: state.nodes, edges: state.edges }].slice(-100), future: [] }
  }),
  undo: () => set((state) => {
    const previous = state.history[state.history.length - 1]
    if (!previous) return state
    return {
      nodes: previous.nodes,
      edges: previous.edges,
      history: state.history.slice(0, -1),
      future: [{ nodes: state.nodes, edges: state.edges }, ...state.future].slice(0, 100)
    }
  }),
  redo: () => set((state) => {
    const next = state.future[0]
    if (!next) return state
    return {
      nodes: next.nodes,
      edges: next.edges,
      history: [...state.history, { nodes: state.nodes, edges: state.edges }].slice(-100),
      future: state.future.slice(1)
    }
  }),
  setSelectedNodeId: (selectedNodeId) => set({ selectedNodeId }),
  setPendingTerminalRect: (pendingTerminalRect) => set({ pendingTerminalRect }),
  setPendingFilesRect: (pendingFilesRect) => set({ pendingFilesRect }),
  setCommandPaletteOpen: (isCommandPaletteOpen) => set({ isCommandPaletteOpen }),
  setRecruitModalOpen: (isRecruitModalOpen) => set({ isRecruitModalOpen }),
  setFilesModalOpen: (isFilesModalOpen) => set({ isFilesModalOpen }),
  setFloorModalOpen: (isFloorModalOpen) => set({ isFloorModalOpen }),
  setWorkspaceModalOpen: (isWorkspaceModalOpen) => set((state) => ({
    isWorkspaceModalOpen,
    editingWorkspace: isWorkspaceModalOpen ? state.editingWorkspace : null
  })),
  setDaemonError: (daemonError) => set({ daemonError })
}))
