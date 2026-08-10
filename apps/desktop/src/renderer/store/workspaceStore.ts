import { create } from 'zustand'

export interface CanvasNodeData {
  id: string
  kind: 'terminal' | 'note' | 'files' | 'browser' | 'device' | 'text' | 'shape'
  x: number
  y: number
  width: number
  height: number
  zIndex?: number
  locked?: boolean
  properties: Record<string, any>
}

export interface CanvasEdgeData {
  id: string
  source: string
  target: string
  label?: string
}

export interface Workspace {
  id: string
  name: string
  path: string
  activeFloorId?: string
}

export interface Floor {
  id: string
  name: string
  branch: string
  path: string
  isLanding?: boolean
}

interface WorkspaceState {
  currentScreen: 'canvas' | 'home' | 'environments' | 'settings'
  theme: 'dark' | 'light'
  activeWorkspace: Workspace | null
  workspaces: Workspace[]
  floors: Floor[]
  activeFloor: Floor | null
  nodes: CanvasNodeData[]
  edges: CanvasEdgeData[]
  selectedNodeId: string | null
  pendingTerminalRect: { x: number; y: number; width: number; height: number } | null
  isInspectorOpen: boolean
  isCommandPaletteOpen: boolean
  isRecruitModalOpen: boolean
  isFloorModalOpen: boolean

  // Actions
  setScreen: (screen: 'canvas' | 'home' | 'environments' | 'settings') => void
  toggleTheme: () => void
  setActiveWorkspace: (ws: Workspace) => void
  setWorkspaces: (ws: Workspace[]) => void
  createWorkspace: (name?: string) => Workspace
  setFloors: (floors: Floor[]) => void
  setActiveFloor: (floor: Floor) => void
  setNodes: (nodes: CanvasNodeData[]) => void
  addNode: (node: CanvasNodeData) => void
  updateNode: (id: string, partial: Partial<CanvasNodeData>) => void
  deleteNode: (id: string) => void
  setEdges: (edges: CanvasEdgeData[]) => void
  addEdge: (edge: CanvasEdgeData) => void
  deleteEdge: (id: string) => void
  setSelectedNodeId: (id: string | null) => void
  setPendingTerminalRect: (rect: { x: number; y: number; width: number; height: number } | null) => void
  toggleInspector: () => void
  setCommandPaletteOpen: (open: boolean) => void
  setRecruitModalOpen: (open: boolean) => void
  setFloorModalOpen: (open: boolean) => void
}

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  currentScreen: 'canvas',
  theme: 'dark',
  activeWorkspace: { id: 'ws_commerce', name: 'commerce-app', path: '/home/user/dev/commerce' },
  workspaces: [
    { id: 'ws_commerce', name: 'commerce-app', path: '/home/user/dev/commerce' },
    { id: 'ws_orchestra', name: 'orchestra-core', path: '/home/user/dev/orchestra' }
  ],
  floors: [
    { id: 'fl_main', name: 'Main Ground', branch: 'main', path: '/home/user/dev/commerce', isLanding: true },
    { id: 'fl_auth', name: 'Auth Refactor', branch: 'feature/authentication', path: '/home/user/dev/commerce/.floors/auth' }
  ],
  activeFloor: { id: 'fl_main', name: 'Main Ground', branch: 'main', path: '/home/user/dev/commerce', isLanding: true },
  nodes: [
    {
      id: 'term_lead',
      kind: 'terminal',
      x: 60,
      y: 70,
      width: 420,
      height: 250,
      properties: {
        title: 'Claude Code',
        agent: 'Claude Code',
        role: '',
        roleColor: '#c8f169',
        cwd: '~/dev/commerce',
        status: 'running'
      }
    },
    {
      id: 'note_tasks',
      kind: 'note',
      x: 520,
      y: 70,
      width: 280,
      height: 230,
      properties: {
        title: 'Especificação Auth',
        content: '# Tarefas de Autenticação\n\n- [x] Criar schema OAuth2\n- [ ] Implementar JWT refresh token\n- [ ] Testar rotas com Playwright\n\n> Agentes conectados têm permissão de leitura neste documento.'
      }
    },
    {
      id: 'files_tree',
      kind: 'files',
      x: 850,
      y: 65,
      width: 380,
      height: 300,
      properties: {
        title: 'Estrutura do Projeto',
        path: '/home/user/dev/commerce'
      }
    },
    {
      id: 'browser_portal',
      kind: 'browser',
      x: 770,
      y: 410,
      width: 360,
      height: 260,
      properties: {
        title: 'Localhost Preview',
        url: 'http://localhost:3000'
      }
    }
  ],
  edges: [
    { id: 'e1', source: 'term_lead', target: 'note_tasks', label: 'context' },
    { id: 'e2', source: 'term_lead', target: 'files_tree', label: 'workspace' }
  ],
  selectedNodeId: null,
  isInspectorOpen: false,
  isCommandPaletteOpen: false,
  isRecruitModalOpen: false,
  isFloorModalOpen: false,

  setScreen: (screen) => set({ currentScreen: screen }),
  toggleTheme: () => {
    const next = get().theme === 'dark' ? 'light' : 'dark'
    document.documentElement.setAttribute('data-theme', next)
    set({ theme: next })
  },
  setActiveWorkspace: (ws) => set({ activeWorkspace: ws }),
  setWorkspaces: (ws) => set({ workspaces: ws }),
  createWorkspace: (name) => {
    const index = get().workspaces.length + 1
    const workspace: Workspace = {
      id: `ws_${Date.now()}`,
      name: name?.trim() || `Workspace ${index}`,
      path: `/home/user/dev/workspace-${index}`
    }
    set((state) => ({ workspaces: [...state.workspaces, workspace], activeWorkspace: workspace, currentScreen: 'canvas', nodes: [], edges: [], selectedNodeId: null }))
    return workspace
  },
  setFloors: (floors) => set({ floors }),
  setActiveFloor: (floor) => set({ activeFloor: floor }),
  setNodes: (nodes) => set({ nodes }),
  addNode: (node) =>
    set((state) => {
      let targetX = Math.round(node.x)
      let targetY = Math.round(node.y)

      const rectsTouch = (
        r1: { x: number; y: number; width: number; height: number },
        r2: { x: number; y: number; width: number; height: number },
        gap = 14
      ) => {
        return !(
          r1.x + r1.width + gap <= r2.x ||
          r1.x >= r2.x + r2.width + gap ||
          r1.y + r1.height + gap <= r2.y ||
          r1.y >= r2.y + r2.height + gap
        )
      }

      const candidate = { ...node, x: targetX, y: targetY }
      let hasOverlap = state.nodes.some((other) => rectsTouch(candidate, other))

      if (hasOverlap) {
        for (let radius = 12; radius <= 480; radius += 12) {
          for (let angle = 0; angle < Math.PI * 2; angle += Math.PI / 8) {
            const nx = Math.round(node.x + Math.cos(angle) * radius)
            const ny = Math.round(node.y + Math.sin(angle) * radius)
            const testCand = { ...node, x: nx, y: ny }
            if (!state.nodes.some((other) => rectsTouch(testCand, other))) {
              targetX = nx
              targetY = ny
              hasOverlap = false
              break
            }
          }
          if (!hasOverlap) break
        }
      }

      return { nodes: [...state.nodes, { ...node, x: targetX, y: targetY }] }
    }),
  updateNode: (id, partial) =>
    set((state) => ({
      nodes: state.nodes.map((n) => (n.id === id ? { ...n, ...partial, properties: { ...n.properties, ...partial.properties } } : n))
    })),
  deleteNode: (id) =>
    set((state) => ({
      nodes: state.nodes.filter((n) => n.id !== id),
      edges: state.edges.filter((e) => e.source !== id && e.target !== id),
      selectedNodeId: state.selectedNodeId === id ? null : state.selectedNodeId
    })),
  setEdges: (edges) => set({ edges }),
  addEdge: (edge) => set((state) => ({ edges: [...state.edges, edge] })),
  deleteEdge: (id) => set((state) => ({ edges: state.edges.filter((e) => e.id !== id) })),
  pendingTerminalRect: null,
  setPendingTerminalRect: (rect) => set({ pendingTerminalRect: rect }),
  setSelectedNodeId: (id) => set({ selectedNodeId: id, isInspectorOpen: id !== null }),
  toggleInspector: () => set((state) => ({ isInspectorOpen: !state.isInspectorOpen })),
  setCommandPaletteOpen: (open) => set({ isCommandPaletteOpen: open }),
  setRecruitModalOpen: (open) => set({ isRecruitModalOpen: open }),
  setFloorModalOpen: (open) => set({ isFloorModalOpen: open })
}))
