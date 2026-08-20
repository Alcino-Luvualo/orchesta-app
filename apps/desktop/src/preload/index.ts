import { contextBridge, ipcRenderer, webUtils } from 'electron'

type BridgeEvent = { type?: string; eventId?: string; payload?: Record<string, unknown> }
type BridgePayload = Record<string, unknown>
type PortalMotionOptions = { generation?: number; scale?: number; revision?: number }
type PortalPresentationUpdate = {
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
}

contextBridge.exposeInMainWorld('orchestra', {
  invoke: (type: string, payload: BridgePayload = {}) => ipcRenderer.invoke('orchestra:invoke', { type, payload }),
  detectTools: () => ipcRenderer.invoke('system:detect-tools'),
  chooseWorkspace: () => ipcRenderer.invoke('workspace:choose'),
  filePath: (file: File) => webUtils.getPathForFile(file),
  openExternalUrl: (url: string) => ipcRenderer.invoke('terminal:open-external', { url }),
  portal: {
    ensure: (portalId: string, url: string) => ipcRenderer.invoke('portal:ensure', { portalId, url }),
    update: (portalId: string, update: PortalPresentationUpdate) => ipcRenderer.invoke('portal:update', { portalId, ...update }),
    suppress: (reason: string, suppressed: boolean) => ipcRenderer.invoke('portal:suppress', { reason, suppressed }),
    freeze: (portalId: string, options: PortalMotionOptions = {}) => ipcRenderer.invoke('portal:freeze', { portalId, ...options }),
    resume: (portalId: string, bounds: { x: number; y: number; width: number; height: number }, options: PortalMotionOptions = {}) => ipcRenderer.invoke('portal:resume', { portalId, bounds, ...options }),
    setBounds: (portalId: string, bounds: { x: number; y: number; width: number; height: number }, visible: boolean, options: PortalMotionOptions = {}) => ipcRenderer.invoke('portal:bounds', { portalId, bounds, visible, ...options }),
    navigate: (portalId: string, url: string) => ipcRenderer.invoke('portal:navigate', { portalId, url }),
    action: (portalId: string, action: 'back' | 'forward' | 'reload' | 'stop') => ipcRenderer.invoke('portal:action', { portalId, action }),
    destroy: (portalId: string) => ipcRenderer.invoke('portal:destroy', { portalId }),
    openExternal: (portalId: string) => ipcRenderer.invoke('portal:open-external', { portalId }),
    inspect: (portalId: string) => ipcRenderer.invoke('portal:inspect', { portalId }),
    grab: (portalId: string) => ipcRenderer.invoke('portal:grab', { portalId }),
    cancelGrab: (portalId: string) => ipcRenderer.invoke('portal:grab-cancel', { portalId }),
    click: (portalId: string, selector: string) => ipcRenderer.invoke('portal:click', { portalId, selector }),
    type: (portalId: string, selector: string, text: string) => ipcRenderer.invoke('portal:type', { portalId, selector, text }),
    screenshot: (portalId: string) => ipcRenderer.invoke('portal:screenshot', { portalId }),
    copyImage: (dataUrl: string) => ipcRenderer.invoke('clipboard:write-image', { dataUrl })
  },
  relayTerminal: (fromSessionId: string, toSessionId: string, message: string) =>
    ipcRenderer.invoke('terminal:relay', { fromSessionId, toSessionId, message }),
  syncCanvasContext: (contextSummary: unknown) =>
    ipcRenderer.invoke('canvas:context:sync', { contextSummary }),
  onEvent: (callback: (event: BridgeEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: BridgeEvent) => callback(data)
    ipcRenderer.on('orchestra:event', handler)
    return () => {
      ipcRenderer.removeListener('orchestra:event', handler)
    }
  }
})

// Expose window controls for frameless window on Linux
contextBridge.exposeInMainWorld('windowControls', {
  minimize: () => ipcRenderer.invoke('window:minimize'),
  maximize: () => ipcRenderer.invoke('window:maximize'),
  close: () => ipcRenderer.invoke('window:close'),
  isMaximized: () => ipcRenderer.invoke('window:isMaximized')
})
