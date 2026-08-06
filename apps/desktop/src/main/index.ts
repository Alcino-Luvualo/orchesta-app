import { app, BrowserWindow, ipcMain, screen } from 'electron'
import path from 'path'
import net from 'net'
import { spawn, ChildProcess } from 'child_process'
import fs from 'fs'

let mainWindow: BrowserWindow | null = null
let coreProcess: ChildProcess | null = null
let socketClient: net.Socket | null = null
let socketRetryTimer: ReturnType<typeof setTimeout> | null = null
const MAX_SOCKET_RETRIES = 10
const pendingRequests = new Map<string, { resolve: (val: any) => void; reject: (err: any) => void }>()

function getSocketPath(): string {
  const runtimeDir = process.env.XDG_RUNTIME_DIR
  if (runtimeDir) {
    return path.join(runtimeDir, 'orchestra', 'orchestra.sock')
  }
  return '/tmp/orchestra.sock'
}

function ensureCoreDaemonRunning() {
  const sockPath = getSocketPath()
  if (!fs.existsSync(sockPath)) {
    console.log('Orchestra core socket not found. Spawning orchestra-core daemon...')
    let binPath = path.join(__dirname, '../../target/release/orchestra-core')
    if (!fs.existsSync(binPath)) {
      binPath = path.join(process.resourcesPath || '', 'bin/orchestra-core')
    }
    if (fs.existsSync(binPath)) {
      coreProcess = spawn(binPath, [], {
        detached: true,
        stdio: 'ignore'
      })
      coreProcess.unref()
    } else {
      console.warn('orchestra-core binary not found at', binPath)
    }
  }
}

function connectToSocket(retryCount = 0) {
  if (retryCount >= MAX_SOCKET_RETRIES) {
    console.log('Max socket retry attempts reached. Orchestra core daemon not available.')
    return
  }

  const sockPath = getSocketPath()
  if (!fs.existsSync(sockPath)) {
    if (retryCount < MAX_SOCKET_RETRIES) {
      socketRetryTimer = setTimeout(() => connectToSocket(retryCount + 1), 500)
    }
    return
  }

  socketClient = net.createConnection(sockPath, () => {
    console.log('Connected to Orchestra Core daemon unix socket!')
  })

  let buffer = Buffer.alloc(0)

  socketClient.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk])
    while (buffer.length >= 4) {
      const len = buffer.readUInt32BE(0)
      if (buffer.length < 4 + len) break

      const msgBuf = buffer.subarray(4, 4 + len)
      buffer = buffer.subarray(4 + len)

      try {
        const msg = JSON.parse(msgBuf.toString('utf-8'))
        if (msg.requestId) {
          const pending = pendingRequests.get(msg.requestId)
          if (pending) {
            if (msg.ok) {
              pending.resolve(msg.result)
            } else {
              pending.reject(new Error(msg.error || 'Request failed'))
            }
            pendingRequests.delete(msg.requestId)
          }
        } else if (msg.type || msg.eventId) {
          // Event push from core daemon
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('orchestra:event', msg)
          }
        }
      } catch (err) {
        console.error('Error parsing IPC JSON message:', err)
      }
    }
  })

  socketClient.on('error', (err) => {
    console.error('Socket client error:', (err as Error).message)
    socketClient = null
    // Only retry a few times, don't flood
    if (retryCount < MAX_SOCKET_RETRIES) {
      socketRetryTimer = setTimeout(() => connectToSocket(retryCount + 1), 2000)
    }
  })

  socketClient.on('close', () => {
    console.log('Socket client connection closed')
    socketClient = null
  })
}

function getIconPath(): string | undefined {
  // In development
  const devIcon = path.join(__dirname, '../resources/icon.png')
  if (fs.existsSync(devIcon)) return devIcon

  // In packaged app
  try {
    const prodIcon = path.join(process.resourcesPath || '', 'icon.png')
    if (fs.existsSync(prodIcon)) return prodIcon
  } catch (_) {}

  return undefined
}

function createWindow() {
  const isLinux = process.platform === 'linux'

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    backgroundColor: '#0b0c0e',
    icon: getIconPath(),
    // On Linux, 'hidden' titleBarStyle causes fullscreen crashes.
    // Use frameless + custom titlebar instead on Linux, standard on other platforms.
    frame: !isLinux,
    titleBarStyle: isLinux ? undefined : 'hidden',
    trafficLightPosition: isLinux ? undefined : { x: 12, y: 12 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  // Handle fullscreen transitions gracefully
  mainWindow.on('enter-full-screen', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('orchestra:event', { type: 'window.fullscreen', payload: { isFullscreen: true } })
    }
  })

  mainWindow.on('leave-full-screen', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('orchestra:event', { type: 'window.fullscreen', payload: { isFullscreen: false } })
    }
  })

  // Prevent unhandled errors from crashing the app
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error('Renderer process gone:', details.reason)
    if (details.reason !== 'clean-exit') {
      // Recreate the window
      createWindow()
    }
  })

  mainWindow.webContents.on('unresponsive', () => {
    console.warn('Window became unresponsive')
  })

  mainWindow.webContents.on('responsive', () => {
    console.log('Window became responsive again')
  })

  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL)
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'))
  }
}

app.whenReady().then(() => {
  ensureCoreDaemonRunning()
  connectToSocket()

  // Window control IPC handlers for frameless window on Linux
  ipcMain.handle('window:minimize', () => {
    mainWindow?.minimize()
  })

  ipcMain.handle('window:maximize', () => {
    if (mainWindow?.isMaximized()) {
      mainWindow.unmaximize()
    } else {
      mainWindow?.maximize()
    }
  })

  ipcMain.handle('window:close', () => {
    mainWindow?.close()
  })

  ipcMain.handle('window:isMaximized', () => {
    return mainWindow?.isMaximized() ?? false
  })

  ipcMain.handle('window:toggleFullscreen', () => {
    if (mainWindow) {
      mainWindow.setFullScreen(!mainWindow.isFullScreen())
    }
  })

  ipcMain.handle('orchestra:invoke', async (_, { type, payload }) => {
    return new Promise((resolve, reject) => {
      if (!socketClient || socketClient.destroyed) {
        // Local fallback if socket not yet connected
        if (type === 'workspace.list') return resolve([])
        if (type === 'canvas.node.list') return resolve([])
        if (type === 'canvas.edge.list') return resolve([])
        if (type === 'roles.list') return resolve([])
        return resolve({ fallback: true })
      }

      const requestId = 'req_' + Math.random().toString(36).substring(2, 10)
      pendingRequests.set(requestId, { resolve, reject })

      // Set a timeout so pending requests don't hang forever
      setTimeout(() => {
        if (pendingRequests.has(requestId)) {
          pendingRequests.delete(requestId)
          reject(new Error('Request timed out'))
        }
      }, 10000)

      const msg = JSON.stringify({
        protocolVersion: 1,
        requestId,
        type,
        payload
      })

      const msgBuf = Buffer.from(msg, 'utf-8')
      const lenBuf = Buffer.alloc(4)
      lenBuf.writeUInt32BE(msgBuf.length, 0)

      socketClient.write(Buffer.concat([lenBuf, msgBuf]), (err) => {
        if (err) {
          pendingRequests.delete(requestId)
          reject(err)
        }
      })
    })
  })

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  // Clear socket retry timer
  if (socketRetryTimer) {
    clearTimeout(socketRetryTimer)
    socketRetryTimer = null
  }
  if (process.platform !== 'darwin') app.quit()
})

// Catch unhandled errors at the process level
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception in main process:', err)
})

process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection in main process:', err)
})
