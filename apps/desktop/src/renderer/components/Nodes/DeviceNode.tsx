import React from 'react'
import { Handle, Position, NodeResizer } from '@xyflow/react'
import { X } from 'lucide-react'
import { useWorkspaceStore } from '../../store/workspaceStore'

export const DeviceNode: React.FC<{ id: string; data: any }> = ({ id, data }) => {
  const { updateNode, deleteNode, setSelectedNodeId } = useWorkspaceStore()
  const width = data.width || 250
  const height = data.height || 510
  const scale = Math.max(.62, Math.min(1.25, Math.min(width / 235, height / 500)))

  return <div className="device-node" style={{ width: '100%', height: '100%', minWidth: 180, minHeight: 330 }} onClick={() => setSelectedNodeId(id)}>
    <NodeResizer
      isVisible={data.selected}
      minWidth={180}
      minHeight={330}
      onResize={(_, params) => updateNode(id, { width: params.width, height: params.height })}
    />
    <Handle type="target" position={Position.Left} className="port left" />
    <Handle type="source" position={Position.Right} className="port right" />
    <button className="device-close nodrag" onClick={(event) => { event.stopPropagation(); deleteNode(id) }} title="Fechar device"><X className="icon" /></button>
    <div className="device-stage">
      <div className="iphone-14-pro-max" style={{ transform: `scale(${scale})` }} aria-label="iPhone 14 Pro Max">
        <div className="iphone-side iphone-silent" /><div className="iphone-side iphone-volume-up" /><div className="iphone-side iphone-volume-down" /><div className="iphone-side iphone-power" />
        <div className="iphone-screen">
          <div className="dynamic-island" />
          <div className="iphone-status"><span>9:41</span><span>▮▮▮ ᯤ</span></div>
          <main className="iphone-app">
            <span className="iphone-eyebrow">Orchestra Preview</span>
            <h3>Good morning</h3>
            <p>Your workspace is ready to test.</p>
            <div className="iphone-card"><span>Authentication</span><b>3 checks passed</b><i /></div>
            <button>Open canvas</button>
          </main>
          <div className="iphone-home" />
        </div>
      </div>
    </div>
  </div>
}
