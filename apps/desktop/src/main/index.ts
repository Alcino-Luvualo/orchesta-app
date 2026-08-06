import { app, BrowserWindow, ipcMain } from 'electron'
import path from 'path'
import net from 'net'
import { spawn, ChildProcess } from 'child_process'
import fs from 'fs'

let mainWindow: BrowserWindow | null = null
let coreProcess: ChildProcess | null = null
let socketClient: net.Socket | null = null
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
      binPath = path.join(process.resourcesPath, 'bin/orchestra-core')
    }
    if (fs.existsSync(binPath)) {
      coreProcess = spawn(binPath, [], {
        detached: true,
        stdio: 'inherit'
      })
      coreProcess.unref()
    } else {
      console.warn('orchestra-core binary not found at', binPath)
    }
  }
}

function connectToSocket(retryCount = 0) {
  const sockPath = getSocketPath()
  if (!fs.existsSync(sockPath)) {
    if (retryCount < 20) {
      setTimeout(() => connectToSocket(retryCount + 1), 300)
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
    console.error('Socket client error:', err)
    socketClient = null
    if (retryCount < 20) {
      setTimeout(() => connectToSocket(retryCount + 1), 1000)
    }
  })

  socketClient.on('close', () => {
    console.log('Socket client connection closed')
    socketClient = null
  })
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    backgroundColor: '#0b0c0e',
    titleBarStyle: 'hidden',
    trafficLightPosition: { x: 12, y: 12 },
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL)
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  ensureCoreDaemonRunning()
  connectToSocket()

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
  if (process.platform !== 'darwin') app.quit()
})
