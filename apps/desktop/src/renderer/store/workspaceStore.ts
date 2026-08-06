import { create } from 'zustand'

export interface CanvasNodeData {
  id: string
  kind: 'terminal' | 'note' | 'files' | 'browser' | 'device' | 'routine' | 'text' | 'shape'
  x: number
  y: number
  width: number
  height: number
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
  currentScreen: 'canvas' | 'home' | 'environments' | 'settings' | 'routines'
  theme: 'dark' | 'light'
  activeWorkspace: Workspace | null
  workspaces: Workspace[]
  floors: Floor[]
  activeFloor: Floor | null
  nodes: CanvasNodeData[]
  edges: CanvasEdgeData[]
  selectedNodeId: string | null
  isInspectorOpen: boolean
  isCommandPaletteOpen: boolean
  isRecruitModalOpen: boolean
  isFloorModalOpen: boolean

  // Actions
  setScreen: (screen: 'canvas' | 'home' | 'environments' | 'settings' | 'routines') => void
  toggleTheme: () => void
  setActiveWorkspace: (ws: Workspace) => void
  setWorkspaces: (ws: Workspace[]) => void
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
      x: 80,
      y: 100,
      width: 480,
      height: 280,
      properties: {
        title: 'Claude Code',
        agent: 'Claude Code',
        role: 'Lead Developer',
        roleColor: '#c8f169',
        cwd: '~/dev/commerce',
        status: 'running'
      }
    },
    {
      id: 'note_tasks',
      kind: 'note',
      x: 600,
      y: 100,
      width: 320,
      height: 260,
      properties: {
        title: 'Especificação Auth',
        content: '# Tarefas de Autenticação\n\n- [x] Criar schema OAuth2\n- [ ] Implementar JWT refresh token\n- [ ] Testar rotas com Playwright\n\n> Agentes conectados têm permissão de leitura neste documento.'
      }
    },
    {
      id: 'files_tree',
      kind: 'files',
      x: 80,
      y: 420,
      width: 440,
      height: 300,
      properties: {
        title: 'Estrutura do Projeto',
        path: '/home/user/dev/commerce'
      }
    },
    {
      id: 'browser_portal',
      kind: 'browser',
      x: 560,
      y: 400,
      width: 400,
      height: 280,
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
  setFloors: (floors) => set({ floors }),
  setActiveFloor: (floor) => set({ activeFloor: floor }),
  setNodes: (nodes) => set({ nodes }),
  addNode: (node) => set((state) => ({ nodes: [...state.nodes, node] })),
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
  setSelectedNodeId: (id) => set({ selectedNodeId: id, isInspectorOpen: id !== null }),
  toggleInspector: () => set((state) => ({ isInspectorOpen: !state.isInspectorOpen })),
  setCommandPaletteOpen: (open) => set({ isCommandPaletteOpen: open }),
  setRecruitModalOpen: (open) => set({ isRecruitModalOpen: open }),
  setFloorModalOpen: (open) => set({ isFloorModalOpen: open })
}))
