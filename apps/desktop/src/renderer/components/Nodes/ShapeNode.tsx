import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Handle, Position, NodeResizer } from '@xyflow/react'
import { CanvasComponentData, useWorkspaceStore } from '../../store/workspaceStore'
import { smoothDrawingPath } from '../Canvas/smartDrawing'

type ShapeType = 'rectangle' | 'rounded' | 'ellipse' | 'diamond' | 'triangle' | 'star' | 'heart' | 'line'

function starPoints(width: number, height: number, inset: number): string {
  const centerX = width / 2
  const centerY = height / 2
  const outerX = Math.max(1, width / 2 - inset)
  const outerY = Math.max(1, height / 2 - inset)
  return Array.from({ length: 10 }, (_, index) => {
    const angle = -Math.PI / 2 + index * Math.PI / 5
    const radius = index % 2 === 0 ? 1 : .42
    return `${centerX + Math.cos(angle) * outerX * radius},${centerY + Math.sin(angle) * outerY * radius}`
  }).join(' ')
}

export const ShapeNode: React.FC<{ id: string; data: CanvasComponentData }> = ({ id, data }) => {
  const { updateNode, setSelectedNodeId, commitHistory } = useWorkspaceStore()
  const properties = data.properties || {}
  const drawing = properties.drawing === true
  const shapeType = (properties.shapeType || 'rounded') as ShapeType
  const points = Array.isArray(properties.points) ? properties.points : []
  const [editing, setEditing] = useState(properties.autoEdit === true)
  const editorRef = useRef<HTMLTextAreaElement>(null)
  const width = data.width || 200
  const height = data.height || 140
  const stroke = String(properties.stroke || 'var(--primary)')
  const fill = String(properties.fill || 'rgba(200, 241, 105, .1)')
  const strokeWidth = Number(properties.strokeWidth) || (drawing ? 3 : 2)

  const beginEditing = useCallback(() => {
    if (drawing || shapeType === 'line') return
    if (!editing) commitHistory()
    setSelectedNodeId(id)
    setEditing(true)
  }, [commitHistory, drawing, editing, id, setSelectedNodeId, shapeType])

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

  const linePoints = points.length >= 2 ? points : [{ x: 8, y: height / 2 }, { x: width - 8, y: height / 2 }]
  return <div className={`canvas-shape-node ${drawing ? 'drawing' : ''} shape-${shapeType} ${editing ? 'editing' : ''}`} style={{ width: '100%', height: '100%', minWidth: drawing || shapeType === 'line' ? 16 : 70, minHeight: drawing || shapeType === 'line' ? 16 : 52 }} onClick={() => setSelectedNodeId(id)}>
    <NodeResizer
      isVisible={data.selected && !editing}
      minWidth={drawing || shapeType === 'line' ? 16 : 70}
      minHeight={drawing || shapeType === 'line' ? 16 : 52}
      handleClassName="nodrag nopan canvas-resize-handle"
      lineClassName="nodrag nopan canvas-resize-line"
      onResizeStart={commitHistory}
      onResize={(_, params) => updateNode(id, { x: params.x, y: params.y, width: params.width, height: params.height })}
    />
    <Handle type="target" position={Position.Left} className="port left" />
    <Handle type="source" position={Position.Right} className="port right" />
    <svg className="canvas-shape-svg" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-label={drawing ? 'Desenho livre' : `Forma ${shapeType}`}>
      {drawing && <path d={smoothDrawingPath(points)} fill="none" stroke={stroke} strokeWidth={strokeWidth} />}
      {!drawing && shapeType === 'rectangle' && <rect x={strokeWidth} y={strokeWidth} width={Math.max(0, width - strokeWidth * 2)} height={Math.max(0, height - strokeWidth * 2)} rx="1" fill={fill} stroke={stroke} strokeWidth={strokeWidth} />}
      {!drawing && shapeType === 'rounded' && <rect x={strokeWidth} y={strokeWidth} width={Math.max(0, width - strokeWidth * 2)} height={Math.max(0, height - strokeWidth * 2)} rx={Math.min(18, height * .14)} fill={fill} stroke={stroke} strokeWidth={strokeWidth} />}
      {!drawing && shapeType === 'ellipse' && <ellipse cx={width / 2} cy={height / 2} rx={Math.max(0, width / 2 - strokeWidth)} ry={Math.max(0, height / 2 - strokeWidth)} fill={fill} stroke={stroke} strokeWidth={strokeWidth} />}
      {!drawing && shapeType === 'diamond' && <polygon points={`${width / 2},${strokeWidth} ${width - strokeWidth},${height / 2} ${width / 2},${height - strokeWidth} ${strokeWidth},${height / 2}`} fill={fill} stroke={stroke} strokeWidth={strokeWidth} />}
      {!drawing && shapeType === 'triangle' && <polygon points={`${width / 2},${strokeWidth} ${width - strokeWidth},${height - strokeWidth} ${strokeWidth},${height - strokeWidth}`} fill={fill} stroke={stroke} strokeWidth={strokeWidth} />}
      {!drawing && shapeType === 'star' && <polygon points={starPoints(width, height, strokeWidth)} fill={fill} stroke={stroke} strokeWidth={strokeWidth} strokeLinejoin="round" />}
      {!drawing && shapeType === 'heart' && <path d={`M ${width / 2} ${height - strokeWidth} C ${width * .12} ${height * .68}, ${strokeWidth} ${height * .42}, ${width * .23} ${height * .23} C ${width * .36} ${height * .1}, ${width * .5} ${height * .2}, ${width * .5} ${height * .34} C ${width * .5} ${height * .2}, ${width * .64} ${height * .1}, ${width * .77} ${height * .23} C ${width - strokeWidth} ${height * .42}, ${width * .88} ${height * .68}, ${width / 2} ${height - strokeWidth} Z`} fill={fill} stroke={stroke} strokeWidth={strokeWidth} strokeLinejoin="round" />}
      {!drawing && shapeType === 'line' && <path d={smoothDrawingPath(linePoints)} fill="none" stroke={stroke} strokeWidth={strokeWidth} />}
    </svg>
    {!drawing && shapeType !== 'line' && <textarea
      ref={editorRef}
      className={`canvas-shape-label ${editing ? 'nodrag nowheel' : ''}`}
      value={String(properties.text || '')}
      readOnly={!editing}
      aria-label="Texto da forma"
      placeholder={editing ? 'Escreve algo…' : ''}
      style={{
        color: String(properties.color || 'var(--text)'),
        fontSize: Number(properties.fontSize) || 14,
        fontWeight: Number(properties.fontWeight) || 600,
        fontStyle: properties.fontStyle === 'italic' ? 'italic' : 'normal',
        textAlign: properties.textAlign || 'center',
      }}
      onDoubleClick={(event) => { event.stopPropagation(); beginEditing() }}
      onPointerDown={(event) => { if (editing) event.stopPropagation() }}
      onChange={(event) => updateNode(id, { properties: { text: event.target.value } })}
      onBlur={() => setEditing(false)}
      onKeyDown={(event) => {
        if (event.key === 'Escape' || (event.key === 'Enter' && (event.metaKey || event.ctrlKey))) {
          event.preventDefault()
          editorRef.current?.blur()
        }
      }}
    />}
    {properties.smartDrawing && <span className="smart-drawing-badge">SMART</span>}
  </div>
}
