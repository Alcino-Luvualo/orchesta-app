import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Handle, Position, NodeResizer } from '@xyflow/react'
import { CanvasComponentData, useWorkspaceStore } from '../../store/workspaceStore'

export const TextNode: React.FC<{ id: string; data: CanvasComponentData }> = ({ id, data }) => {
  const { updateNode, setSelectedNodeId, commitHistory } = useWorkspaceStore()
  const properties = data.properties || {}
  const [editing, setEditing] = useState(properties.autoEdit === true)
  const editorRef = useRef<HTMLTextAreaElement>(null)

  const beginEditing = useCallback(() => {
    if (!editing) commitHistory()
    setSelectedNodeId(id)
    setEditing(true)
  }, [commitHistory, editing, id, setSelectedNodeId])

  useEffect(() => {
    const onEditNode = (event: Event) => {
      if ((event as CustomEvent<{ nodeId?: string }>).detail?.nodeId === id) beginEditing()
    }
    window.addEventListener('orchestra:edit-node', onEditNode)
    return () => window.removeEventListener('orchestra:edit-node', onEditNode)
  }, [beginEditing, id])

  useEffect(() => {
    if (!editing) return
    editorRef.current?.focus()
    if (properties.autoEdit) {
      editorRef.current?.select()
      updateNode(id, { properties: { autoEdit: false } })
    }
  }, [editing, id, properties.autoEdit, updateNode])

  const fontSize = Number(properties.fontSize) || 18
  return <div className={`canvas-text-node ${editing ? 'editing' : ''}`} style={{ width: '100%', height: '100%' }} onClick={() => setSelectedNodeId(id)}>
    <NodeResizer
      isVisible={data.selected && !editing}
      minWidth={80}
      minHeight={34}
      handleClassName="nodrag nopan canvas-resize-handle"
      lineClassName="nodrag nopan canvas-resize-line"
      onResizeStart={commitHistory}
      onResize={(_, params) => updateNode(id, { x: params.x, y: params.y, width: params.width, height: params.height })}
    />
    <Handle type="target" position={Position.Left} className="port left" />
    <Handle type="source" position={Position.Right} className="port right" />
    <textarea
      ref={editorRef}
      className={editing ? 'nodrag nowheel' : ''}
      value={String(properties.text || '')}
      readOnly={!editing}
      aria-label="Texto livre"
      placeholder={editing ? 'Escreve algo…' : ''}
      style={{
        color: String(properties.color || 'var(--text)'),
        fontSize,
        fontWeight: Number(properties.fontWeight) || 500,
        fontStyle: properties.fontStyle === 'italic' ? 'italic' : 'normal',
        textAlign: properties.textAlign || 'left',
      }}
      onDoubleClick={(event) => { event.stopPropagation(); beginEditing() }}
      onPointerDown={(event) => { if (editing) event.stopPropagation() }}
      onChange={(event) => {
        const text = event.target.value
        updateNode(id, {
          properties: { text },
          height: Math.max(data.height || 42, Math.min(420, event.target.scrollHeight + 4)),
        })
      }}
      onBlur={() => setEditing(false)}
      onKeyDown={(event) => {
        if (event.key === 'Escape' || (event.key === 'Enter' && (event.metaKey || event.ctrlKey))) {
          event.preventDefault()
          editorRef.current?.blur()
        }
      }}
    />
  </div>
}
