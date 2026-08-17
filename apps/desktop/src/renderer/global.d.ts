export {}

declare global {
  interface Window {
    orchestra?: {
      invoke: (type: string, payload?: Record<string, unknown>) => Promise<unknown>
      detectTools?: () => Promise<Array<{ id: string; name: string; cmd: string; description: string; installed: boolean; path: string }>>
      chooseWorkspace?: () => Promise<string | null>
      filePath?: (file: File) => string
      openExternalUrl?: (url: string) => Promise<{ ok: boolean; url?: string }>
      portal?: {
        ensure: (portalId: string, url: string) => Promise<{
          portalId: string
          instanceId?: string
          url: string
          title?: string
          loading?: boolean
          history?: { canGoBack: boolean; canGoForward: boolean }
          canGoBack?: boolean
          canGoForward?: boolean
          error?: string | null
          viewport?: { width: number; height: number }
          logicalViewport?: { width: number; height: number }
          physicalBounds?: { x: number; y: number; width: number; height: number }
          canvasScale?: number
          generation?: number
          revision?: number
          state?: string
          lifecycle?: string
          firstFrame?: boolean
          visible?: boolean
        }>
        update?: (portalId: string, update: {
          instanceId?: string
          bounds: { x: number; y: number; width: number; height: number }
          visible: boolean
          mode: 'creating' | 'live' | 'transitioning' | 'snapshot' | 'hidden'
          generation: number
          revision: number
          canvasScale: number
          logicalViewport: { width: number; height: number }
          zIndex?: number
          focused?: boolean
          interactive?: boolean
        }) => Promise<unknown>
        suppress: (reason: string, suppressed: boolean) => Promise<unknown>
        freeze: (portalId: string, options?: { generation?: number; scale?: number; revision?: number }) => Promise<{ portalId: string; data?: string; url?: string; stale?: boolean; generation?: number; revision?: number }>
        resume: (portalId: string, bounds: { x: number; y: number; width: number; height: number }, options?: { generation?: number; scale?: number; revision?: number }) => Promise<unknown>
        setBounds: (portalId: string, bounds: { x: number; y: number; width: number; height: number }, visible: boolean, options?: { generation?: number; scale?: number; revision?: number }) => Promise<unknown>
        navigate: (portalId: string, url: string) => Promise<{ url: string }>
        action: (portalId: string, action: 'back' | 'forward' | 'reload' | 'stop') => Promise<unknown>
        destroy: (portalId: string) => Promise<unknown>
        openExternal: (portalId: string) => Promise<unknown>
        inspect: (portalId: string) => Promise<unknown>
        click: (portalId: string, selector: string) => Promise<unknown>
        type: (portalId: string, selector: string, text: string) => Promise<unknown>
        screenshot: (portalId: string) => Promise<string>
      }
      syncCanvasContext?: (contextSummary: unknown) => Promise<unknown>
      onEvent: (callback: (event: OrchestraEvent) => void) => () => void
    }
    windowControls?: {
      minimize: () => Promise<unknown>
      maximize: () => Promise<unknown>
      close: () => Promise<unknown>
      isMaximized: () => Promise<boolean>
    }
  }
}

export interface OrchestraEvent {
  type?: string
  eventId?: string
  payload?: Record<string, unknown>
}
