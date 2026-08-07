import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('orchestra', {
  invoke: (type: string, payload: any) => ipcRenderer.invoke('orchestra:invoke', { type, payload }),
  detectTools: () => ipcRenderer.invoke('system:detect-tools'),
  relayTerminal: (fromSessionId: string, toSessionId: string, message: string) =>
    ipcRenderer.invoke('terminal:relay', { fromSessionId, toSessionId, message }),
  onEvent: (callback: (event: any) => void) => {
    const handler = (_: any, data: any) => callback(data)
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
  isMaximized: () => ipcRenderer.invoke('window:isMaximized'),
  toggleFullscreen: () => ipcRenderer.invoke('window:toggleFullscreen')
})
