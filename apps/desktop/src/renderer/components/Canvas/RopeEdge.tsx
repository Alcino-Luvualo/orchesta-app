import React from 'react'
import { BaseEdge, EdgeLabelRenderer, EdgeProps, getBezierPath } from '@xyflow/react'
import { useWorkspaceStore } from '../../store/workspaceStore'

const segmentCrossesRect = (x1: number, y1: number, x2: number, y2: number, rect: { x: number; y: number; width: number; height: number }) => {
  const samples = 32
  for (let index = 1; index < samples; index += 1) {
    const ratio = index / samples
    const x = x1 + (x2 - x1) * ratio
    const y = y1 + (y2 - y1) * ratio
    if (x > rect.x - 3 && x < rect.x + rect.width + 3 && y > rect.y - 3 && y < rect.y + rect.height + 3) return true
  }
  return false
}

/**
 * A deliberately quiet cable edge. React Flow keeps it attached while nodes
 * move; the asymmetric control points add the small gravity-like sag used by
 * the Orchestra canvas instead of a diagramming-arrow appearance.
 */
export const RopeEdge: React.FC<EdgeProps> = ({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  source,
  target,
  selected,
  label,
  markerEnd
}) => {
  const canvasNodes = useWorkspaceStore((state) => state.nodes)
  const obstructedBy = canvasNodes.find((node) => node.id !== source && node.id !== target && segmentCrossesRect(sourceX, sourceY, targetX, targetY, node))
  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    curvature: 0.32
  })
  const routedPath = obstructedBy
    ? (() => {
        const clearance = 7
        const routeY = Math.abs(sourceY - (obstructedBy.y - clearance)) < Math.abs(sourceY - (obstructedBy.y + obstructedBy.height + clearance))
          ? obstructedBy.y - clearance
          : obstructedBy.y + obstructedBy.height + clearance
        const spread = Math.max(28, Math.abs(targetX - sourceX) * .22)
        return `M ${sourceX} ${sourceY} C ${sourceX + spread} ${sourceY}, ${sourceX + spread} ${routeY}, ${(sourceX + targetX) / 2} ${routeY} S ${targetX - spread} ${targetY}, ${targetX} ${targetY}`
      })()
    : path

  return (
    <>
      <BaseEdge id={`${id}-shadow`} path={routedPath} className="rope-edge-shadow" />
      <BaseEdge
        id={id}
        path={routedPath}
        markerEnd={markerEnd}
        className={`rope-edge ${selected ? 'selected' : ''}`}
      />
      <circle className="rope-anchor" cx={sourceX} cy={sourceY} r="4" />
      <circle className="rope-anchor" cx={targetX} cy={targetY} r="4" />
      {label && (
        <EdgeLabelRenderer>
          <span
            className="rope-label nodrag nopan"
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY + 12}px)` }}
          >
            {String(label)}
          </span>
        </EdgeLabelRenderer>
      )}
    </>
  )
}
