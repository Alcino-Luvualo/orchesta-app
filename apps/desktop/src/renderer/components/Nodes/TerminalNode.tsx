import React, { useEffect, useRef, useState } from 'react'
import { Handle, Position } from '@xyflow/react'
import { Terminal as TerminalIcon, Maximize2, Minimize2, X } from 'lucide-react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { useWorkspaceStore } from '../../store/workspaceStore'

export const TerminalNode: React.FC<{ id: string; data: any }> = ({ id, data }) => {
  const terminalRef = useRef<HTMLDivElement>(null)
  const xtermInstance = useRef<Terminal | null>(null)
  const fitAddonInstance = useRef<FitAddon | null>(null)
  const resizeObserverRef = useRef<ResizeObserver | null>(null)
  const [isLifted, setIsLifted] = useState(false)
  const { deleteNode, setSelectedNodeId } = useWorkspaceStore()

  const props = data.properties || {}
  const agent = props.agent || 'Claude Code'
  const role = props.role || 'Lead Developer'
  const roleColor = props.roleColor || '#c8f169'
  const cwd = props.cwd || '~/dev/project'
  const status = props.status || 'running'

  useEffect(() => {
    if (!terminalRef.current) return

    const term = new Terminal({
      theme: {
        background: '#0c0e10',
        foreground: '#aeb7af',
        cursor: '#c8f169',
        selectionBackground: 'rgba(200, 241, 105, 0.3)'
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

    // Delay initial fit to ensure DOM is laid out
    requestAnimationFrame(() => {
      try { fitAddon.fit() } catch (_) {}
    })

    xtermInstance.current = term
    fitAddonInstance.current = fitAddon

    // Watch for container resize and re-fit terminal
    const observer = new ResizeObserver(() => {
      requestAnimationFrame(() => {
        try { fitAddon.fit() } catch (_) {}
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
        cwd: cwd === '~/dev/project' ? undefined : cwd,
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
        width: isLifted ? 800 : (data.width || 480),
        height: isLifted ? 520 : (data.height || 280),
        minWidth: 320,
        minHeight: 220
      }}
      onClick={() => setSelectedNodeId(id)}
    >
      <Handle type="target" position={Position.Left} className="port left" />
      <Handle type="source" position={Position.Right} className="port right" />

      {/* Terminal Title Bar */}
      <div className="node-head">
        <div className="node-icon" style={{ color: roleColor, background: 'rgba(200,241,105,0.12)' }}>
          <TerminalIcon className="icon" />
        </div>
        <div className="node-title">
          <strong>{agent}</strong>
          <span>{role} · {cwd}</span>
        </div>

        <div className={`status ${status === 'running' ? '' : 'wait'}`} title={status} />

        <button className="icon-btn" onClick={() => setIsLifted(!isLifted)} title="Focus / Lift Node">
          {isLifted ? <Minimize2 className="icon" /> : <Maximize2 className="icon" />}
        </button>

        <button className="icon-btn" onClick={() => deleteNode(id)} title="Fechar Terminal">
          <X className="icon" />
        </button>
      </div>

      {/* xterm Container */}
      <div className="terminal-body" ref={terminalRef} style={{ height: 'calc(100% - 66px)' }} />

      {/* Terminal Permanent Identity Status Bar */}
      <div className="node-foot">
        <span style={{ color: roleColor, fontWeight: 600 }}>● {role}</span>
        <span>Local · {cwd}</span>
        <span>{status}</span>
      </div>
    </div>
  )
}
