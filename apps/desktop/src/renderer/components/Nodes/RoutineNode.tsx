import React from 'react'
import { Handle, Position } from '@xyflow/react'
import { Clock, Play, CheckCircle, X } from 'lucide-react'
import { useWorkspaceStore } from '../../store/workspaceStore'

export const RoutineNode: React.FC<{ id: string; data: any }> = ({ id, data }) => {
  const props = data.properties || {}
  const name = props.name || 'Routine Diária'
  const cron = props.schedule_cron || '0 9 * * *'
  const targetAgent = props.target_agent || 'Claude Code'
  const prompt = props.prompt || 'Executar testes e gerar relatório de cobertura'
  const { deleteNode, setSelectedNodeId } = useWorkspaceStore()

  const handleRunNow = (e: React.MouseEvent) => {
    e.stopPropagation()
    alert(`Rotina "${name}" disparada para ${targetAgent}!`)
  }

  return (
    <div
      className="node"
      data-kind="routine"
      style={{
        width: data.width || 320,
        height: data.height || 220,
        minWidth: 240,
        minHeight: 160
      }}
      onClick={() => setSelectedNodeId(id)}
    >
      <Handle type="target" position={Position.Left} className="port left" />
      <Handle type="source" position={Position.Right} className="port right" />

      <div className="node-head">
        <div className="node-icon" style={{ color: 'var(--info)', background: 'rgba(116, 167, 245, 0.14)' }}>
          <Clock className="icon" />
        </div>
        <div className="node-title">
          <strong>{name}</strong>
          <span>Cron: {cron}</span>
        </div>

        <button className="icon-btn" onClick={() => deleteNode(id)}>
          <X className="icon" />
        </button>
      </div>

      <div style={{ padding: 12, fontSize: 10 }}>
        <div style={{ color: 'var(--dim)', marginBottom: 4 }}>Agente Alvo: <b style={{ color: 'var(--text)' }}>{targetAgent}</b></div>
        <div style={{ background: 'var(--panel2)', padding: 8, borderRadius: 6, font: '9px/1.4 var(--mono)', color: 'var(--muted)', marginBottom: 10 }}>
          "{prompt}"
        </div>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontSize: 9, color: 'var(--success)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <CheckCircle className="icon" style={{ width: 11, height: 11 }} /> Ativa
          </span>

          <button className="btn primary" style={{ height: 26, fontSize: 9, padding: '0 10px' }} onClick={handleRunNow}>
            <Play className="icon" style={{ width: 11, height: 11 }} /> Executar Agora
          </button>
        </div>
      </div>
    </div>
  )
}
