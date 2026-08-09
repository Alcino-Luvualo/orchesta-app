import React from 'react'
import { Handle, Position, NodeResizer } from '@xyflow/react'
import { CanvasComponentData, useWorkspaceStore } from '../../store/workspaceStore'

export const ShapeNode: React.FC<{ id: string; data: CanvasComponentData }> = ({ id, data }) => {
  const { updateNode, setSelectedNodeId, commitHistory } = useWorkspaceStore()
  const drawing = data.properties?.drawing === true
  const points = data.properties?.points
  return <div className={`canvas-shape-node ${drawing ? 'drawing' : ''}`} style={{ width: '100%', height: '100%' }} onClick={() => setSelectedNodeId(id)}>
    <NodeResizer
      isVisible={data.selected}
      minWidth={100}
      minHeight={80}
      handleClassName="nodrag nopan canvas-resize-handle"
      lineClassName="nodrag nopan canvas-resize-line"
      onResizeStart={commitHistory}
      onResize={(_, params) => updateNode(id, { width: params.width, height: params.height })}
    />
    <Handle type="target" position={Position.Left} className="port left" />
    <Handle type="source" position={Position.Right} className="port right" />
    {drawing ? <svg viewBox={`0 0 ${data.width || 220} ${data.height || 150}`} preserveAspectRatio="none" aria-label="Desenho livre"><polyline points={(points?.length ? points : [{ x: 12, y: 115 }, { x: 71, y: 72 }, { x: 120, y: 89 }, { x: 210, y: 70 }]).map((point) => `${point.x},${point.y}`).join(' ')} /></svg> : <span />}
  </div>
}
