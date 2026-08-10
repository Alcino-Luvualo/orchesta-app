import React, { useEffect, useRef, useState } from 'react'
import { Handle, Position, NodeResizer } from '@xyflow/react'
import { Maximize2, Minimize2, X } from 'lucide-react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { useWorkspaceStore } from '../../store/workspaceStore'

export const TerminalNode: React.FC<{ id: string; data: any }> = ({ id, data }) => {
  const terminalRef = useRef<HTMLDivElement>(null)
  const xtermInstance = useRef<Terminal | null>(null)
  const fitAddonInstance = useRef<FitAddon | null>(null)
  const resizeObserverRef = useRef<ResizeObserver | null>(null)
  const isInitialThemeRef = useRef(true)
  const [isLifted, setIsLifted] = useState(false)
  const { updateNode, deleteNode, setSelectedNodeId, theme } = useWorkspaceStore()

  const props = data.properties || {}
  const agent = props.agent || 'Terminal'
  const role = props.role || ''
  const roleColor = props.roleColor || '#c8f169'
  const cwd = props.cwd || '~/dev/project'
  const status = props.status || 'running'

  useEffect(() => {
    if (!terminalRef.current) return

    const term = new Terminal({
      theme: theme === 'light' ? {
        background: '#f7f8f5', foreground: '#273029', cursor: '#718d27', selectionBackground: 'rgba(130, 169, 28, .22)',
        black: '#f7f8f5', white: '#273029', brightWhite: '#1a1f1b', brightBlack: '#a0a6ad',
        green: '#4b6e22', brightGreen: '#66942e', cyan: '#217075', brightCyan: '#2d99a0',
        blue: '#2f5b99', brightBlue: '#427cd1', yellow: '#8f7b1b', brightYellow: '#b39a22'
      } : {
        background: '#0c0e10', foreground: '#d4dcd6', cursor: '#c8f169', selectionBackground: 'rgba(200, 241, 105, .22)', selectionForeground: '#ffffff'
      },
      fontFamily: 'JetBrains Mono, monospace',
      fontSize: 11,
      cursorBlink: true,
      cols: 60,
      rows: 14,
      rightClickSelectsWord: false
    })

    term.open(terminalRef.current)
    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)

    let lastWidth = 0
    let lastHeight = 0
    let lastSize = ''
    const fitTerminal = () => {
      if (!terminalRef.current) return
      const width = terminalRef.current.clientWidth
      const height = terminalRef.current.clientHeight
      if (width < 30 || height < 30) return
      if (Math.abs(width - lastWidth) <= 2 && Math.abs(height - lastHeight) <= 2) return
      try {
        const core = (term as any)._core
        if (core?._charSizeService?.hasValidSize) {
          fitAddon.fit()
          lastWidth = width
          lastHeight = height
          const size = `${term.cols}x${term.rows}`
          if (size !== lastSize && window.orchestra?.invoke) {
            lastSize = size
            window.orchestra.invoke('terminal.resize', { sessionId: id, cols: term.cols, rows: term.rows }).catch(() => undefined)
          }
        }
      } catch (_) {}
    }

    // Delay initial fit to ensure DOM layout and xterm renderService dimensions are ready
    const initTimer = setTimeout(() => {
      fitTerminal()
    }, 250)

    xtermInstance.current = term
    fitAddonInstance.current = fitAddon

    // Watch for container resize and re-fit terminal
    const observer = new ResizeObserver(() => {
      requestAnimationFrame(() => {
        fitTerminal()
      })
    })
    observer.observe(terminalRef.current)
    resizeObserverRef.current = observer

    const safeWrite = (data: string) => {
      if (!data) return
      try {
        const core = (term as any)._core
        if (core?._charSizeService?.hasValidSize) {
          term.write(data)
        } else {
          setTimeout(() => safeWrite(data), 100)
        }
      } catch (_) {}
    }

    // Spawn real PTY session over Electron IPC
    if (window.orchestra?.invoke) {
      const env = {
        ORCHESTRA: '1',
        ORCHESTRA_SESSION_ID: id
      }
      window.orchestra.invoke('terminal.spawn', {
        sessionId: id,
        cwd: cwd.startsWith('/') && !cwd.startsWith('/home/user/') ? cwd : undefined,
        cols: 60,
        rows: 14,
        env
      }).then(() => {
        const cmd = props.command || (agent && agent !== 'Terminal' && agent !== 'Shell zsh' ? agent.toLowerCase().replace(/\s+/g, '') : undefined)
        if (cmd && cmd !== 'zsh' && cmd !== 'bash') {
          setTimeout(() => {
            window.orchestra?.invoke('terminal.input', {
              sessionId: id,
              data: `${cmd}\r`
            }).catch(() => {})
          }, 350)
        }
      }).catch(err => console.error('Failed to spawn PTY:', err))

      // Listen for PTY output events
      const unsubscribe = window.orchestra.onEvent((evt: any) => {
        if (evt.type === 'terminal.output' && evt.payload?.sessionId === id) {
          safeWrite(evt.payload.data)
        }
      })

      // Send terminal input to PTY
      term.onData((text) => {
        window.orchestra.invoke('terminal.input', {
          sessionId: id,
          data: text
        })
      })

      return () => {
        clearTimeout(initTimer)
        unsubscribe()
        observer.disconnect()
        resizeObserverRef.current = null
        // Kill the PTY session on cleanup
        window.orchestra.invoke('terminal.kill', { sessionId: id }).catch(() => {})
        term.dispose()
      }
    } else {
      // Demo fallback if electron IPC not loaded yet
      safeWrite(`user@orchestra:${cwd}$ `)
      term.onData((text) => {
        if (text === '\r') {
          safeWrite('\r\nuser@orchestra:' + cwd + '$ ')
        } else {
          safeWrite(text)
        }
      })
      return () => {
        observer.disconnect()
        resizeObserverRef.current = null
        term.dispose()
      }
    }
  }, [id])

  useEffect(() => {
    if (isInitialThemeRef.current) {
      isInitialThemeRef.current = false
      return
    }
    if (!xtermInstance.current) return
    try {
      xtermInstance.current.options.theme = theme === 'light'
        ? { 
            background: '#f7f8f5', 
            foreground: '#273029', 
            cursor: '#718d27', 
            selectionBackground: 'rgba(130, 169, 28, .22)',
            black: '#f7f8f5',
            white: '#273029',
            brightWhite: '#1a1f1b',
            brightBlack: '#a0a6ad',
            green: '#4b6e22',
            brightGreen: '#66942e',
            cyan: '#217075',
            brightCyan: '#2d99a0',
            blue: '#2f5b99',
            brightBlue: '#427cd1',
            yellow: '#8f7b1b',
            brightYellow: '#b39a22'
          }
        : { background: '#0c0e10', foreground: '#d4dcd6', cursor: '#c8f169', selectionBackground: 'rgba(200, 241, 105, .22)', selectionForeground: '#ffffff' }
    } catch (_) {}
  }, [theme])

  // Re-fit terminal when lifted/collapsed
  useEffect(() => {
    if (fitAddonInstance.current) {
      // Give DOM time to resize
      const timer = setTimeout(() => {
        try { fitAddonInstance.current?.fit() } catch (_) {}
      }, 100)
      return () => clearTimeout(timer)
    }
  }, [isLifted])

  return (
    <div
      className={`node ${isLifted ? 'lifted' : ''}`}
      style={{
        width: '100%',
        height: '100%',
        minWidth: 320,
        minHeight: 220
      }}
      onClick={() => setSelectedNodeId(id)}
    >
      <NodeResizer
        isVisible={data.selected}
        minWidth={320}
        minHeight={220}
        handleClassName="nodrag nopan canvas-resize-handle"
        lineClassName="nodrag nopan canvas-resize-line"
        onResize={(_, params) => updateNode(id, { width: params.width, height: params.height })}
      />
      <Handle type="target" position={Position.Left} className="port left" />
      <Handle type="source" position={Position.Right} className="port right" />

      <div className="mac-terminal">
        <div className="mac-chrome">
          <span className="mac-dot red" />
          <span className="mac-dot yellow" />
          <span className="mac-dot green" />
          <div className="mac-title">
            <strong>{agent}</strong>{role ? <span>— {role} · zsh</span> : <span>· zsh</span>}
          </div>
          <span className={`status ${status === 'running' ? '' : 'wait'}`} title={status} />
          <button className="icon-btn mac-action" onClick={(event) => { event.stopPropagation(); setIsLifted(!isLifted) }} title="Focar terminal">
          {isLifted ? <Minimize2 className="icon" /> : <Maximize2 className="icon" />}
          </button>
          <button className="icon-btn mac-action" onClick={(event) => { event.stopPropagation(); deleteNode(id) }} title="Fechar terminal"><X className="icon" /></button>
        </div>
        <div className="terminal-body nodrag nowheel" ref={terminalRef} onMouseDown={(e) => e.stopPropagation()} />
        <div className="node-foot terminal-foot">
          {role && <span style={{ color: roleColor, fontWeight: 600 }}>● {role}</span>}
          <span>Local · {cwd}</span>
          <span>{status}</span>
        </div>
      </div>
    </div>
  )
}
