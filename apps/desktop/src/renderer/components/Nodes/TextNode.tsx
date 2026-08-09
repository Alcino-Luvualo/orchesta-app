import React from 'react'
import { Handle, Position, NodeResizer } from '@xyflow/react'
import { CanvasComponentData, useWorkspaceStore } from '../../store/workspaceStore'

export const TextNode: React.FC<{ id: string; data: CanvasComponentData }> = ({ id, data }) => {
  const { updateNode, setSelectedNodeId, commitHistory } = useWorkspaceStore()
  const properties = data.properties || {}
  return <div className="canvas-text-node" style={{ width: '100%', height: '100%' }} onClick={() => setSelectedNodeId(id)}>
    <NodeResizer
      isVisible={data.selected}
      minWidth={140}
      minHeight={60}
      handleClassName="nodrag nopan canvas-resize-handle"
      lineClassName="nodrag nopan canvas-resize-line"
      onResizeStart={commitHistory}
      onResize={(_, params) => updateNode(id, { width: params.width, height: params.height })}
    />
    <Handle type="target" position={Position.Left} className="port left" />
    <Handle type="source" position={Position.Right} className="port right" />
    <textarea className="nodrag" value={properties.text || 'Escreve aqui…'} aria-label="Texto livre" onChange={(event) => updateNode(id, { properties: { ...properties, text: event.target.value } })} />
  </div>
}
