import { create } from 'zustand'

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
  daemonError: string | null

  setScreen: (screen: Screen) => void
  toggleTheme: () => void
  setActiveWorkspace: (workspace: Workspace | null) => void
  setWorkspaces: (workspaces: Workspace[]) => void
  createWorkspace: (name?: string, path?: string) => Workspace | null
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
  setDaemonError: (error: string | null) => void
}

const initialNodePosition = (nodes: CanvasNodeData[], node: CanvasNodeData) => {
  let x = Math.round(node.x)
  let y = Math.round(node.y)
  const collides = (left: number, top: number) => nodes.some((other) => !(
    left + node.width + 14 <= other.x ||
    left >= other.x + other.width + 14 ||
    top + node.height + 14 <= other.y ||
    top >= other.y + other.height + 14
  ))
  if (!collides(x, y)) return { x, y }
  for (let radius = 16; radius <= 480; radius += 16) {
    for (let angle = 0; angle < Math.PI * 2; angle += Math.PI / 8) {
      const candidateX = Math.round(node.x + Math.cos(angle) * radius)
      const candidateY = Math.round(node.y + Math.sin(angle) * radius)
      if (!collides(candidateX, candidateY)) return { x: candidateX, y: candidateY }
    }
  }
  return { x, y }
}

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
  daemonError: null,

  setScreen: (currentScreen) => set({ currentScreen }),
  toggleTheme: () => {
    const next = get().theme === 'dark' ? 'light' : 'dark'
    document.documentElement.setAttribute('data-theme', next)
    set({ theme: next })
  },
  setActiveWorkspace: (activeWorkspace) => set({ activeWorkspace, currentScreen: activeWorkspace ? 'canvas' : 'home', selectedNodeId: null, history: [], future: [] }),
  setWorkspaces: (workspaces) => set({ workspaces }),
  createWorkspace: (name, workspacePath) => {
    const path = workspacePath?.trim()
    if (!path) return null
    const workspace: Workspace = {
      id: `ws_${crypto.randomUUID()}`,
      name: name?.trim() || path.split('/').filter(Boolean).pop() || 'Workspace',
      path
    }
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
    window.orchestra?.invoke('workspace.save', { ...workspace }).catch(() => undefined)
    return workspace
  },
  setFloors: (floors) => set({ floors }),
  setActiveFloor: (activeFloor) => set({ activeFloor, history: [], future: [] }),
  setNodes: (nodes) => set({ nodes }),
  addNode: (node) => set((state) => ({
    history: [...state.history, { nodes: state.nodes, edges: state.edges }].slice(-100),
    future: [],
    nodes: [...state.nodes, { ...node, ...initialNodePosition(state.nodes, node) }]
  })),
  updateNode: (id, partial) => set((state) => ({
    nodes: state.nodes.map((node) => node.id !== id
      ? node
      : { ...node, ...partial, properties: { ...node.properties, ...(partial.properties || {}) } })
  })),
  deleteNode: (id) => {
    const node = get().nodes.find((item) => item.id === id)
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
  setDaemonError: (daemonError) => set({ daemonError })
}))
