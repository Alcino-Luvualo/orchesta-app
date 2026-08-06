import React from 'react'
import { Handle, Position } from '@xyflow/react'
import { Smartphone, X, ShieldAlert } from 'lucide-react'
import { useWorkspaceStore } from '../../store/workspaceStore'

export const DeviceNode: React.FC<{ id: string; data: any }> = ({ id, data }) => {
  const props = data.properties || {}
  const deviceType = props.deviceType || 'android' // 'android' | 'ios'
  const { deleteNode, setSelectedNodeId } = useWorkspaceStore()

  return (
    <div
      className="node"
      data-kind="device"
      style={{
        width: data.width || 260,
        height: data.height || 360,
        minWidth: 200,
        minHeight: 280
      }}
      onClick={() => setSelectedNodeId(id)}
    >
      <Handle type="target" position={Position.Left} className="port left" />
      <Handle type="source" position={Position.Right} className="port right" />

      <div className="node-head">
        <div className="node-icon">
          <Smartphone className="icon" />
        </div>
        <div className="node-title">
          <strong>Device Portal</strong>
          <span>{deviceType === 'ios' ? 'iOS Remote Runner' : 'Android ADB Emulator'}</span>
        </div>
        <button className="icon-btn" onClick={() => deleteNode(id)}>
          <X className="icon" />
        </button>
      </div>

      <div className="device-shell" style={{ padding: 10, textAlign: 'center' }}>
        {/* Mandated Badge */}
        <div
          style={{
            fontSize: 9,
            padding: '3px 8px',
            borderRadius: 999,
            background: deviceType === 'ios' ? 'rgba(169, 137, 245, 0.18)' : 'var(--primary-muted)',
            color: deviceType === 'ios' ? 'var(--purple)' : 'var(--primary)',
            border: '1px solid currentColor',
            marginBottom: 8,
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4
          }}
        >
          {deviceType === 'ios' ? 'Remote iOS · Mac runner required' : 'Android · Local ADB emulator'}
        </div>

        <div className="phone-frame" style={{ width: 140, height: 230, margin: 'auto', border: '6px solid var(--text)', borderRadius: 24, padding: 8, background: '#0b0c0e' }}>
          <div className="phone-notch" style={{ width: 44, height: 8, background: 'var(--text)', borderRadius: 4, margin: '0 auto 12px' }} />
          <div style={{ fontSize: 9, color: 'var(--muted)', marginTop: 40 }}>
            {deviceType === 'ios' ? (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
                <ShieldAlert className="icon" style={{ color: 'var(--warn)' }} />
                <span>Requer Mac Runner remoto na rede</span>
              </div>
            ) : (
              <div>ADB Conectado (127.0.0.1:5555)</div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
