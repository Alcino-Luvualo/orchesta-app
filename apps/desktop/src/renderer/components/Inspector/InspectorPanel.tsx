import React from 'react'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { X, Shield, Terminal, Cpu, Folder, GitBranch, Activity, Lock } from 'lucide-react'

export const InspectorPanel: React.FC = () => {
  const { selectedNodeId, nodes, edges, isInspectorOpen, toggleInspector, updateNode } = useWorkspaceStore()

  if (!isInspectorOpen || !selectedNodeId) return null

  const node = nodes.find((n) => n.id === selectedNodeId)
  if (!node) return null

  const props = node.properties || {}
  const connectedEdges = edges.filter((e) => e.source === node.id || e.target === node.id)

  return (
    <div className="inspector">
      <div className="inspector-head">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Terminal className="icon" style={{ color: 'var(--primary)' }} />
          <span>Inspector Contextual</span>
        </div>
        <button className="icon-btn" onClick={toggleInspector}>
          <X className="icon" />
        </button>
      </div>

      <div style={{ fontSize: 11, marginBottom: 16 }}>
        <b style={{ display: 'block', fontSize: 13, color: 'var(--text)' }}>{props.title || node.id}</b>
        <span style={{ color: 'var(--dim)', font: '9px var(--mono)' }}>Kind: {node.kind} · ID: {node.id}</span>
      </div>

      <div className="field">
        <label>Agente Atribuído</label>
        <input
          className="input"
          value={props.agent || 'Sem Agente'}
          onChange={(e) => updateNode(node.id, { properties: { agent: e.target.value } })}
        />
      </div>

      <div className="field">
        <label>Role</label>
        <select
          className="select"
          value={props.role || 'Lead Developer'}
          onChange={(e) => updateNode(node.id, { properties: { role: e.target.value } })}
        >
          <option value="Lead Developer">Lead Developer</option>
          <option value="Frontend Architect">Frontend Architect</option>
          <option value="Backend & Core Engineer">Backend & Core Engineer</option>
          <option value="Code Reviewer">Code Reviewer</option>
        </select>
      </div>

      <div className="field">
        <label>Diretório de Trabalho (CWD)</label>
        <input
          className="input"
          value={props.cwd || '~/dev/project'}
          onChange={(e) => updateNode(node.id, { properties: { cwd: e.target.value } })}
        />
      </div>

      <div className="field" style={{ marginTop: 16 }}>
        <label>Conexões Ativas ({connectedEdges.length})</label>
        {connectedEdges.length === 0 ? (
          <div style={{ fontSize: 9, color: 'var(--dim)' }}>Nenhum cabo conectado a este node.</div>
        ) : (
          connectedEdges.map((edge) => (
            <div key={edge.id} style={{ fontSize: 9, background: 'var(--panel2)', padding: 6, borderRadius: 5, marginBottom: 4 }}>
              {edge.source === node.id ? `➔ Conectado a ${edge.target}` : `⬅ Recebe de ${edge.source}`}
            </div>
          ))
        )}
      </div>

      <div className="field" style={{ marginTop: 16 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <Shield className="icon" style={{ width: 12, height: 12, color: 'var(--success)' }} /> Permissões de Segurança
        </label>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 4 }}>
          {['leitura', 'escrita', 'execucao', 'git'].map((perm) => (
            <span key={perm} style={{ fontSize: 8, background: 'var(--primary-muted)', color: 'var(--primary)', padding: '2px 6px', borderRadius: 4 }}>
              ✓ {perm}
            </span>
          ))}
        </div>
      </div>

      <div className="field" style={{ marginTop: 16 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <Activity className="icon" style={{ width: 12, height: 12 }} /> Atividade Recente
        </label>
        <div style={{ fontSize: 9, color: 'var(--muted)', marginTop: 4 }}>
          <div>10:42 — PTY sessão iniciada</div>
          <div>10:43 — Ficheiros lidos via IPC</div>
        </div>
      </div>
    </div>
  )
}
