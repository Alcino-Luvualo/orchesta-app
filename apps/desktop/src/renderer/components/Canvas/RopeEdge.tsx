import React, { useEffect, useState } from 'react'
import { BaseEdge, EdgeLabelRenderer, EdgeProps } from '@xyflow/react'
import { useWorkspaceStore } from '../../store/workspaceStore'

interface Point {
  x: number
  y: number
}

interface NodeBox {
  x: number
  y: number
  w: number
  h: number
  cx: number
  cy: number
}

const SPATIAL_GAP = 12

function getNodeBox(node: { x: number; y: number; width: number; height: number }): NodeBox {
  return {
    x: node.x,
    y: node.y,
    w: node.width,
    h: node.height,
    cx: node.x + node.width / 2,
    cy: node.y + node.height / 2
  }
}

function anchorToward(box: NodeBox, target: Point): Point {
  const dx = target.x - box.cx
  const dy = target.y - box.cy
  const scaledX = Math.abs(dx) / (box.w / 2 || 1)
  const scaledY = Math.abs(dy) / (box.h / 2 || 1)

  if (scaledX >= scaledY) {
    return {
      x: dx >= 0 ? box.x + box.w : box.x,
      y: Math.max(box.y + 12, Math.min(box.y + box.h - 12, box.cy + dy / (scaledX || 1)))
    }
  }
  return {
    x: Math.max(box.x + 12, Math.min(box.x + box.w - 12, box.cx + dx / (scaledY || 1))),
    y: dy >= 0 ? box.y + box.h : box.y
  }
}

function outwardPoint(box: NodeBox, p: Point, d = 16): Point {
  const eps = 3
  if (Math.abs(p.x - box.x) < eps) return { x: p.x - d, y: p.y }
  if (Math.abs(p.x - (box.x + box.w)) < eps) return { x: p.x + d, y: p.y }
  if (Math.abs(p.y - box.y) < eps) return { x: p.x, y: p.y - d }
  return { x: p.x, y: p.y + d }
}

function segmentHitsRect(a: Point, b: Point, r: { x: number; y: number; w: number; h: number }): boolean {
  for (let i = 1; i < 20; i++) {
    const u = i / 20
    const x = a.x + (b.x - a.x) * u
    const y = a.y + (b.y - a.y) * u
    if (x > r.x && x < r.x + r.w && y > r.y && y < r.y + r.h) return true
  }
  return false
}

function cableRoute(
  boxA: NodeBox,
  boxB: NodeBox,
  start: Point,
  end: Point,
  allObstacles: Array<{ x: number; y: number; w: number; h: number }>
): Point[] {
  const anchorDistance = Math.hypot(end.x - start.x, end.y - start.y)
  const leadSize = Math.min(9, Math.max(0.75, anchorDistance / 3))
  const leadA = outwardPoint(boxA, start, leadSize)
  const leadB = outwardPoint(boxB, end, leadSize)
  const route = [start, leadA, leadB, end]

  for (let pass = 0; pass < 5; pass++) {
    let changed = false
    for (const r of allObstacles) {
      for (let i = 1; i < route.length - 2; i++) {
        const p = route[i]
        const q = route[i + 1]
        if (!segmentHitsRect(p, q, r)) continue

        const clearance = 2
        const horizontal = Math.abs(q.x - p.x) >= Math.abs(q.y - p.y)
        if (horizontal) {
          const top = r.y - clearance
          const bottom = r.y + r.h + clearance
          const y = Math.abs(p.y - top) + Math.abs(q.y - top) <= Math.abs(p.y - bottom) + Math.abs(q.y - bottom) ? top : bottom
          const leftToRight = q.x >= p.x
          route.splice(
            i + 1,
            0,
            { x: leftToRight ? r.x - clearance : r.x + r.w + clearance, y },
            { x: leftToRight ? r.x + r.w + clearance : r.x - clearance, y }
          )
        } else {
          const left = r.x - clearance
          const right = r.x + r.w + clearance
          const x = Math.abs(p.x - left) + Math.abs(q.x - left) <= Math.abs(p.x - right) + Math.abs(q.x - right) ? left : right
          const topToBottom = q.y >= p.y
          route.splice(
            i + 1,
            0,
            { x, y: topToBottom ? r.y - clearance : r.y + r.h + clearance },
            { x, y: topToBottom ? r.y + r.h + clearance : r.y - clearance }
          )
        }
        changed = true
        break
      }
      if (changed) break
    }
    if (!changed) break
  }
  return route
}

function ropeGeometry(route: Point[], timeMs: number, amplitude = 1.2): { d: string; points: Point[] } {
  const points: Point[] = []

  for (let s = 0; s < route.length - 1; s++) {
    const a = route[s]
    const b = route[s + 1]
    const dx = b.x - a.x
    const dy = b.y - a.y
    const dist = Math.hypot(dx, dy)
    const steps = Math.max(4, Math.min(14, Math.round(dist / 28)))

    for (let i = s ? 1 : 0; i <= steps; i++) {
      const u = i / steps
      const anchor = Math.sin(Math.PI * u)
      const middleSegment = s > 0 && s < route.length - 2
      const gravity = (middleSegment ? 12 : 4) * 4 * u * (1 - u)
      const swing = Math.sin(timeMs / 125 + s * 1.7 + u * 5) * amplitude * anchor
      const normalX = dist ? -dy / dist : 0
      const normalY = dist ? dx / dist : 1

      points.push({
        x: a.x + dx * u + normalX * swing,
        y: a.y + dy * u + gravity + normalY * swing * 0.18
      })
    }
  }

  if (points.length < 2) return { d: '', points }

  let d = `M ${points[0].x.toFixed(1)},${points[0].y.toFixed(1)}`
  for (let i = 1; i < points.length - 1; i++) {
    const midX = (points[i].x + points[i + 1].x) / 2
    const midY = (points[i].y + points[i + 1].y) / 2
    d += ` Q ${points[i].x.toFixed(1)},${points[i].y.toFixed(1)} ${midX.toFixed(1)},${midY.toFixed(1)}`
  }
  const last = points[points.length - 1]
  d += ` T ${last.x.toFixed(1)},${last.y.toFixed(1)}`

  return { d, points }
}

export const RopeEdge: React.FC<EdgeProps> = ({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  source,
  target,
  selected,
  label
}) => {
  const [timeMs, setTimeMs] = useState(0)
  const storeNodes = useWorkspaceStore((state) => state.nodes)

  useEffect(() => {
    let animId: number
    const animate = (t: number) => {
      setTimeMs(t)
      animId = requestAnimationFrame(animate)
    }
    animId = requestAnimationFrame(animate)
    return () => cancelAnimationFrame(animId)
  }, [])

  const sourceNode = storeNodes.find((n) => n.id === source)
  const targetNode = storeNodes.find((n) => n.id === target)

  const boxA = sourceNode ? getNodeBox(sourceNode) : { x: sourceX - 10, y: sourceY - 10, w: 20, h: 20, cx: sourceX, cy: sourceY }
  const boxB = targetNode ? getNodeBox(targetNode) : { x: targetX - 10, y: targetY - 10, w: 20, h: 20, cx: targetX, cy: targetY }

  const startAnchor = anchorToward(boxA, { x: boxB.cx, y: boxB.cy })
  const endAnchor = anchorToward(boxB, { x: boxA.cx, y: boxA.cy })

  const obstacles = storeNodes
    .filter((n) => n.id !== source && n.id !== target)
    .map((n) => {
      const q = getNodeBox(n)
      return { x: q.x - SPATIAL_GAP, y: q.y - SPATIAL_GAP, w: q.w + SPATIAL_GAP * 2, h: q.h + SPATIAL_GAP * 2 }
    })

  const route = cableRoute(boxA, boxB, startAnchor, endAnchor, obstacles)
  const { d: routedPath, points } = ropeGeometry(route, timeMs, 1.2)

  const midPoint = points[Math.floor(points.length / 2)] || startAnchor

  return (
    <>
      <BaseEdge id={`${id}-shadow`} path={routedPath} className="rope-edge-shadow" />
      <BaseEdge
        id={id}
        path={routedPath}
        className={`rope-edge ${selected ? 'selected' : ''}`}
      />
      <circle className="rope-anchor" cx={startAnchor.x} cy={startAnchor.y} r="4" />
      <circle className="rope-anchor" cx={endAnchor.x} cy={endAnchor.y} r="4" />
      {label && (
        <EdgeLabelRenderer>
          <span
            className="rope-label nodrag nopan"
            style={{ transform: `translate(-50%, -50%) translate(${midPoint.x}px, ${midPoint.y + 12}px)` }}
          >
            {String(label)}
          </span>
        </EdgeLabelRenderer>
      )}
    </>
  )
}
