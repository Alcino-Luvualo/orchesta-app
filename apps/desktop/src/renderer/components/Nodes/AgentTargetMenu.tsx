import React, { useEffect, useRef, useState } from 'react'
import { Bot, ChevronDown, Circle } from 'lucide-react'
import { connectedAgentTargets, AgentTarget } from './agentContext'
import { useWorkspaceStore } from '../../store/workspaceStore'

type AgentTargetMenuProps = {
  label?: string
  disabled?: boolean
  connectedToNodeId?: string
  initiallyOpen?: boolean
  onSelect: (agent: AgentTarget) => void
}

export const AgentTargetMenu: React.FC<AgentTargetMenuProps> = ({ label = 'Adicionar ao agente', disabled, connectedToNodeId, initiallyOpen = false, onSelect }) => {
  const [open, setOpen] = useState(initiallyOpen)
  const rootRef = useRef<HTMLDivElement>(null)
  const nodes = useWorkspaceStore((state) => state.nodes)
  const edges = useWorkspaceStore((state) => state.edges)
  const agents = connectedAgentTargets(nodes, edges, connectedToNodeId)

  useEffect(() => {
    if (!open) return
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    window.addEventListener('pointerdown', close, true)
    return () => window.removeEventListener('pointerdown', close, true)
  }, [open])

  return (
    <div ref={rootRef} className="agent-target-menu nodrag nopan">
      <button
        type="button"
        className="compact-action agent-target-trigger"
        disabled={disabled}
        aria-expanded={open}
        onClick={(event) => { event.stopPropagation(); setOpen((value) => !value) }}
      >
        <Bot className="icon" />{label}<ChevronDown className="icon agent-target-chevron" />
      </button>
      {open && <div className="agent-target-popover" role="menu" onPointerDown={(event) => event.stopPropagation()}>
        <div className="agent-target-heading">Agentes conectados</div>
        {agents.length === 0
          ? <div className="agent-target-empty">{connectedToNodeId ? 'Liga este browser a um agente no canvas para poderes enviar.' : 'Nenhum agente ativo no canvas.'}</div>
          : agents.map((agent) => (
            <button type="button" role="menuitem" key={agent.id} onClick={() => { onSelect(agent); setOpen(false) }}>
              <span className="agent-target-avatar"><Bot className="icon" /></span>
              <span><strong>{agent.name}</strong><small>{agent.status}</small></span>
              <Circle className={`agent-target-status ${agent.status === 'running' ? 'online' : ''}`} />
            </button>
          ))}
      </div>}
    </div>
  )
}
