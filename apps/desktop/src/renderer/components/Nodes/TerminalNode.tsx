import React, { useEffect, useRef, useState } from 'react'
import { Handle, Position } from '@xyflow/react'
import { Maximize2, Minimize2, X } from 'lucide-react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { useWorkspaceStore } from '../../store/workspaceStore'

export const TerminalNode: React.FC<{ id: string; data: any }> = ({ id, data }) => {
  const terminalRef = useRef<HTMLDivElement>(null)
  const xtermInstance = useRef<Terminal | null>(null)
  const fitAddonInstance = useRef<FitAddon | null>(null)
  const resizeObserverRef = useRef<ResizeObserver | null>(null)
  const [isLifted, setIsLifted] = useState(false)
  const { deleteNode, setSelectedNodeId, theme } = useWorkspaceStore()

  const props = data.properties || {}
  const agent = props.agent || 'Claude Code'
  const role = props.role || 'Lead Developer'
  const roleColor = props.roleColor || '#c8f169'
  const cwd = props.cwd || '~/dev/project'
  const status = props.status || 'running'

  useEffect(() => {
    if (!terminalRef.current) return

    const term = new Terminal({
      theme: theme === 'light' ? {
        background: '#f7f8f5', foreground: '#273029', cursor: '#718d27', selectionBackground: 'rgba(130, 169, 28, .22)'
      } : {
        background: '#0c0e10', foreground: '#b8c1ba', cursor: '#c8f169', selectionBackground: 'rgba(200, 241, 105, .3)'
      },
      fontFamily: 'JetBrains Mono, monospace',
      fontSize: 11,
      cursorBlink: true,
      cols: 60,
      rows: 14
    })

    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    term.open(terminalRef.current)

    let lastWidth = 0
    let lastHeight = 0
    let lastSize = ''
    const fitTerminal = () => {
      if (!terminalRef.current) return
      const width = terminalRef.current.clientWidth
      const height = terminalRef.current.clientHeight
      if (Math.abs(width - lastWidth) <= 2 && Math.abs(height - lastHeight) <= 2) return
      lastWidth = width
      lastHeight = height
      try {
        fitAddon.fit()
        const size = `${term.cols}x${term.rows}`
        if (size !== lastSize && window.orchestra?.invoke) {
          lastSize = size
          window.orchestra.invoke('terminal.resize', { sessionId: id, cols: term.cols, rows: term.rows }).catch(() => undefined)
        }
      } catch (_) {}
    }

    // Delay initial fit to ensure DOM is laid out
    requestAnimationFrame(() => {
      fitTerminal()
    })

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

    // Initial greeting / prompt
    term.writeln(`\x1b[32m[Orchestra PTY · zsh]\x1b[0m Started session \x1b[1m${id}\x1b[0m`)
    term.writeln(`Agent: \x1b[38;2;200;241;105m${agent}\x1b[0m | Role: \x1b[36m${role}\x1b[0m`)
    term.writeln(`Working Directory: ${cwd}`)
    term.writeln('')

    // Spawn real PTY session over Electron IPC
    if (window.orchestra?.invoke) {
      window.orchestra.invoke('terminal.spawn', {
        sessionId: id,
        // Do not send shell-style paths such as ~/dev/project to Rust: CommandBuilder
        // does not expand a tilde, so the shell should inherit a valid working directory.
        cwd: cwd.startsWith('/') && !cwd.startsWith('/home/user/') ? cwd : undefined,
        cols: 60,
        rows: 14
      }).catch(err => console.error('Failed to spawn PTY:', err))

      // Listen for PTY output events
      const unsubscribe = window.orchestra.onEvent((evt: any) => {
        if (evt.type === 'terminal.output' && evt.payload?.sessionId === id) {
          term.write(evt.payload.data)
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
        unsubscribe()
        observer.disconnect()
        resizeObserverRef.current = null
        // Kill the PTY session on cleanup
        window.orchestra.invoke('terminal.kill', { sessionId: id }).catch(() => {})
        term.dispose()
      }
    } else {
      // Demo fallback if electron IPC not loaded yet
      term.write(`user@orchestra:${cwd}$ `)
      term.onData((text) => {
        if (text === '\r') {
          term.write('\r\nuser@orchestra:' + cwd + '$ ')
        } else {
          term.write(text)
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
    if (!xtermInstance.current) return
    xtermInstance.current.options.theme = theme === 'light'
      ? { background: '#f7f8f5', foreground: '#273029', cursor: '#718d27', selectionBackground: 'rgba(130, 169, 28, .22)' }
      : { background: '#0c0e10', foreground: '#b8c1ba', cursor: '#c8f169', selectionBackground: 'rgba(200, 241, 105, .3)' }
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
      <Handle type="target" position={Position.Left} className="port left" />
      <Handle type="source" position={Position.Right} className="port right" />

      <div className="mac-terminal">
        <div className="mac-chrome">
          <span className="mac-dot red" />
          <span className="mac-dot yellow" />
          <span className="mac-dot green" />
          <div className="mac-title">
            <strong>{agent}</strong><span>— {role} · zsh</span>
          </div>
          <span className={`status ${status === 'running' ? '' : 'wait'}`} title={status} />
          <button className="icon-btn mac-action" onClick={(event) => { event.stopPropagation(); setIsLifted(!isLifted) }} title="Focar terminal">
          {isLifted ? <Minimize2 className="icon" /> : <Maximize2 className="icon" />}
          </button>
          <button className="icon-btn mac-action" onClick={(event) => { event.stopPropagation(); deleteNode(id) }} title="Fechar terminal"><X className="icon" /></button>
        </div>
        <div className="terminal-body" ref={terminalRef} />
        <div className="node-foot terminal-foot">
          <span style={{ color: roleColor, fontWeight: 600 }}>● {role}</span>
          <span>Local · {cwd}</span>
          <span>{status}</span>
        </div>
      </div>
    </div>
  )
}
