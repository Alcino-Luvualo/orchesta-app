import { app, BrowserWindow, ipcMain, screen, session } from 'electron'
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

let activeWatcher: fs.FSWatcher | null = null
let activeWatcherPath: string | null = null
let lastSyncedJsonString: string = ''

function setupOrchestraWatcher(orchestraDir: string) {
  if (activeWatcherPath === orchestraDir) return
  if (activeWatcher) {
    activeWatcher.close()
    activeWatcher = null
  }
  activeWatcherPath = orchestraDir

  try {
    activeWatcher = fs.watch(orchestraDir, { recursive: true }, (_eventType, filename) => {
      if (!filename) return
      if (filename.includes('canvas_context.json')) {
        try {
          const filePath = path.join(orchestraDir, 'canvas_context.json')
          if (!fs.existsSync(filePath)) return
          const raw = fs.readFileSync(filePath, 'utf-8')
          if (raw === lastSyncedJsonString) return

          const parsed = JSON.parse(raw)
          lastSyncedJsonString = raw

          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('orchestra:event', {
              type: 'orchestra:canvas-external-update',
              payload: parsed
            })
          }
        } catch (err) {
          console.error('Failed to process watched canvas_context.json:', err)
        }
      }
    })
  } catch (err) {
    console.error('Failed to setup fs.watch on .orchestra:', err)
  }
}



if (process.env.VITE_DEV_SERVER_URL) {
  // Development-only inspection port; never enabled in packaged builds.
  app.commandLine.appendSwitch('remote-debugging-port', '9231')
}

function getSocketPath(): string {
  const runtimeDir = process.env.XDG_RUNTIME_DIR
  if (runtimeDir) {
    return path.join(runtimeDir, 'orchestra', 'orchestra.sock')
  }
  return '/tmp/orchestra.sock'
}

function ensureCoreDaemonRunning(forceSpawn = false) {
  const sockPath = getSocketPath()
  if (forceSpawn || !fs.existsSync(sockPath)) {
    console.log('Orchestra core socket not found. Spawning orchestra-core daemon...')
    const devCandidates = [
      // Vite Electron emits main.js to apps/desktop/dist-electron.
      path.resolve(__dirname, '../../../target/release/orchestra-core'),
      path.resolve(process.cwd(), '../../target/release/orchestra-core')
    ]
    let binPath = devCandidates.find((candidate) => fs.existsSync(candidate)) || path.join(process.resourcesPath || '', 'bin/orchestra-core')
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
    if ((err as NodeJS.ErrnoException).code === 'ECONNREFUSED') {
      // A stale Unix-socket file can survive an unclean shutdown. Start a new
      // core instance instead of leaving the renderer permanently in fallback.
      ensureCoreDaemonRunning(true)
    }
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
      sandbox: false,
      webviewTag: true
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

  mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    console.log(`[Renderer Console] [level ${level}] ${message} (${sourceId}:${line})`)
  })

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    console.error(`[Renderer Failed Load] Code: ${errorCode}, Desc: ${errorDescription}, URL: ${validatedURL}`)
  })

  // Prevent unhandled errors from crashing the app
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error('Renderer process gone:', details.reason, details.exitCode)
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
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const responseHeaders = { ...details.responseHeaders }
    delete responseHeaders['x-frame-options']
    delete responseHeaders['X-Frame-Options']
    delete responseHeaders['content-security-policy']
    delete responseHeaders['Content-Security-Policy']
    callback({ cancel: false, responseHeaders })
  })

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

  ipcMain.handle('system:detect-tools', async () => {
    const tools = [
      { id: 'claude', name: 'Claude Code', cmd: 'claude', description: 'Anthropic Agentic Coding CLI' },
      { id: 'agy', name: 'Antigravity CLI', cmd: 'agy', description: 'Google Antigravity Agent Runtime' },
      { id: 'codex', name: 'Codex CLI', cmd: 'codex', description: 'OpenAI Codex Terminal' },
      { id: 'opencode', name: 'OpenCode', cmd: 'opencode', description: 'Open-source Multi-Agent Engine' },
      { id: 'zsh', name: 'Zsh Shell', cmd: 'zsh', description: 'Standard System Shell' },
      { id: 'bash', name: 'Bash Shell', cmd: 'bash', description: 'GNU Bash Terminal Shell' }
    ]

    const pathEnv = process.env.PATH || ''
    const userHome = process.env.HOME || '/home/alcinoo'
    const extraPaths = [
      path.join(userHome, '.local/bin'),
      path.join(userHome, '.nvm/versions/node/v26.7.0/bin'),
      '/usr/local/bin',
      '/usr/bin',
      '/bin'
    ]
    const searchDirs = [...new Set([...pathEnv.split(path.delimiter), ...extraPaths])]

    return tools.map((t) => {
      let installed = false
      let binPath = ''
      for (const dir of searchDirs) {
        if (!dir) continue
        const candidate = path.join(dir, t.cmd)
        if (fs.existsSync(candidate)) {
          installed = true
          binPath = candidate
          break
        }
      }
      return { ...t, installed, path: binPath }
    })
  })

  ipcMain.handle('terminal:relay', async (_, { fromSessionId, toSessionId, message }) => {
    if (socketClient && !socketClient.destroyed) {
      const requestId = 'req_' + Math.random().toString(36).substring(2, 10)
      const msg = JSON.stringify({
        protocolVersion: 1,
        requestId,
        type: 'terminal.input',
        payload: { sessionId: toSessionId, data: `${message}\r` }
      })
      const msgBuf = Buffer.from(msg, 'utf-8')
      const lenBuf = Buffer.alloc(4)
      socketClient.write(Buffer.concat([lenBuf, msgBuf]))
      return { ok: true }
    }
    return { ok: false, error: 'Socket disconnected' }
  })

  ipcMain.handle('canvas:context:sync', async (_, { contextSummary, cwd }) => {
    try {
      const terminals = Array.isArray(contextSummary) ? contextSummary : [contextSummary]

      const userHome = process.env.HOME || '/home/alcinoo'
      const payloadCwd = cwd || (terminals.length > 0 ? terminals[0].cwd : null)
      let projectDir = userHome
      if (payloadCwd) {
        projectDir = payloadCwd.startsWith('~/') ? path.join(userHome, payloadCwd.slice(2)) : payloadCwd
      } else {
        projectDir = process.cwd()
      }

      const orchestraDir = path.join(projectDir, '.orchestra')
      if (!fs.existsSync(orchestraDir)) {
        fs.mkdirSync(orchestraDir, { recursive: true })
      }

      const jsonStr = JSON.stringify({ terminals, updatedAt: new Date().toISOString() }, null, 2)
      lastSyncedJsonString = jsonStr

      // Write unified canvas_context.json
      fs.writeFileSync(
        path.join(orchestraDir, 'canvas_context.json'),
        jsonStr,
        'utf-8'
      )

      setupOrchestraWatcher(orchestraDir)


      // Collect ALL connected notes from ALL terminals
      const allNotes: any[] = []
      const allBrowsers: any[] = []
      const allPeers: any[] = []

      for (const term of terminals) {
        // Per-terminal directory
        const termDir = path.join(orchestraDir, 'terminals', term.sessionId)
        if (!fs.existsSync(termDir)) {
          fs.mkdirSync(termDir, { recursive: true })
        }
        fs.writeFileSync(
          path.join(termDir, 'context.json'),
          JSON.stringify(term, null, 2),
          'utf-8'
        )

        // Per-terminal notes.md
        const notes = term.connectedNotes || []
        let notesMd = `# Notas Conectadas ao Terminal: ${term.agent}\n\n`
        if (notes.length > 0) {
          notes.forEach((n: any) => {
            notesMd += `## ${n.title || 'Nota'}\n${n.content || ''}\n\n`
            allNotes.push({ ...n, fromAgent: term.agent })
          })
        } else {
          notesMd += `*Nenhuma nota conectada.*\n`
        }
        fs.writeFileSync(path.join(termDir, 'connected_notes.md'), notesMd, 'utf-8')

        // Collect browsers and peers
        ;(term.connectedBrowsers || []).forEach((b: any) => allBrowsers.push({ ...b, fromAgent: term.agent }))
        ;(term.connectedPeerAgents || []).forEach((p: any) => allPeers.push({ ...p, fromAgent: term.agent }))
      }

      // Write unified connected_notes.md
      let unifiedMd = `# Orchestra Canvas - Contexto Conectado\n\n`
      if (allNotes.length > 0) {
        allNotes.forEach((n: any) => {
          unifiedMd += `## Nota: ${n.title || 'Nota'} (conectada a ${n.fromAgent})\n${n.content || ''}\n\n`
        })
      } else {
        unifiedMd += `*Nenhuma nota conectada a nenhum terminal no momento.*\n`
      }
      fs.writeFileSync(path.join(orchestraDir, 'connected_notes.md'), unifiedMd, 'utf-8')

      return { ok: true }
    } catch (err) {
      console.error('Failed to sync canvas context:', err)
      return { ok: false, error: (err as Error).message }
    }
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
