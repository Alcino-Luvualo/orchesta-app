import React from 'react'
import { Handle, Position } from '@xyflow/react'
import { useWorkspaceStore } from '../../store/workspaceStore'

export const TextNode: React.FC<{ id: string; data: any }> = ({ id, data }) => {
  const { updateNode, setSelectedNodeId } = useWorkspaceStore()
  const properties = data.properties || {}
  return <div className="canvas-text-node" style={{ width: data.width || 260, height: data.height || 120 }} onClick={() => setSelectedNodeId(id)}>
    <Handle type="target" position={Position.Left} className="port left" />
    <Handle type="source" position={Position.Right} className="port right" />
    <textarea className="nodrag" value={properties.text || 'Escreve aqui…'} aria-label="Texto livre" onChange={(event) => updateNode(id, { properties: { ...properties, text: event.target.value } })} />
  </div>
}
