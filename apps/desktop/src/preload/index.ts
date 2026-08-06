import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('orchestra', {
  invoke: (type: string, payload: any) => ipcRenderer.invoke('orchestra:invoke', { type, payload }),
  onEvent: (callback: (event: any) => void) => {
    const handler = (_: any, data: any) => callback(data)
    ipcRenderer.on('orchestra:event', handler)
    return () => {
      ipcRenderer.removeListener('orchestra:event', handler)
    }
  }
})
