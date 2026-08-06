import React, { useEffect, useState } from 'react'
import { BaseEdge, EdgeLabelRenderer, EdgeProps } from '@xyflow/react'
import { useWorkspaceStore } from '../../store/workspaceStore'

interface Point {
  x: number
  y: number
}

const segmentHitsRect = (a: Point, b: Point, r: { x: number; y: number; width: number; height: number }, gap = 16) => {
  const samples = 20
  const rx = r.x - gap
  const ry = r.y - gap
  const rw = r.width + gap * 2
  const rh = r.height + gap * 2

  for (let i = 1; i < samples; i++) {
    const u = i / samples
    const x = a.x + (b.x - a.x) * u
    const y = a.y + (b.y - a.y) * u
    if (x > rx && x < rx + rw && y > ry && y < ry + rh) return true
  }
  return false
}

function calculateCableRoute(
  start: Point,
  end: Point,
  obstacles: Array<{ x: number; y: number; width: number; height: number }>
): Point[] {
  const dist = Math.hypot(end.x - start.x, end.y - start.y)
  const leadSize = Math.min(18, Math.max(8, dist / 4))

  // Determine initial lead points
  const leadA = { x: start.x + (end.x >= start.x ? leadSize : -leadSize), y: start.y }
  const leadB = { x: end.x + (end.x >= start.x ? -leadSize : leadSize), y: end.y }
  const route: Point[] = [start, leadA, leadB, end]

  for (let pass = 0; pass < 4; pass++) {
    let changed = false
    for (const r of obstacles) {
      for (let i = 1; i < route.length - 2; i++) {
        const p = route[i]
        const q = route[i + 1]
        if (!segmentHitsRect(p, q, r)) continue

        const clearance = 16
        const top = r.y - clearance
        const bottom = r.y + r.height + clearance
        const y = Math.abs(p.y - top) + Math.abs(q.y - top) <= Math.abs(p.y - bottom) + Math.abs(q.y - bottom) ? top : bottom
        const leftToRight = q.x >= p.x
        route.splice(
          i + 1,
          0,
          { x: leftToRight ? r.x - clearance : r.x + r.width + clearance, y },
          { x: leftToRight ? r.x + r.width + clearance : r.x - clearance, y }
        )
        changed = true
        break
      }
      if (changed) break
    }
    if (!changed) break
  }
  return route
}

function calculateRopeGeometry(route: Point[], timeMs: number): { d: string; midX: number; midY: number } {
  const points: Point[] = []

  for (let s = 0; s < route.length - 1; s++) {
    const a = route[s]
    const b = route[s + 1]
    const dx = b.x - a.x
    const dy = b.y - a.y
    const dist = Math.hypot(dx, dy)
    const steps = Math.max(4, Math.min(14, Math.round(dist / 24)))

    for (let i = s ? 1 : 0; i <= steps; i++) {
      const u = i / steps
      const anchor = Math.sin(Math.PI * u)
      const isMiddle = s > 0 && s < route.length - 2
      // Catenary gravity droop sag (18px downward sag on middle segments, 10px on end segments)
      const gravity = (isMiddle ? 18 : 10) * 4 * u * (1 - u)
      // Subtle physical wave sway
      const swing = Math.sin(timeMs / 140 + s * 1.5 + u * 4) * 1.8 * anchor
      const normalX = dist ? -dy / dist : 0

      points.push({
        x: a.x + dx * u + normalX * swing,
        y: a.y + dy * u + gravity
      })
    }
  }

  if (points.length < 2) return { d: '', midX: (route[0]?.x || 0), midY: (route[0]?.y || 0) }

  let d = `M ${points[0].x.toFixed(1)} ${points[0].y.toFixed(1)}`
  for (let i = 1; i < points.length - 1; i++) {
    const midX = (points[i].x + points[i + 1].x) / 2
    const midY = (points[i].y + points[i + 1].y) / 2
    d += ` Q ${points[i].x.toFixed(1)} ${points[i].y.toFixed(1)} ${midX.toFixed(1)} ${midY.toFixed(1)}`
  }
  const last = points[points.length - 1]
  d += ` T ${last.x.toFixed(1)} ${last.y.toFixed(1)}`

  const centerIdx = Math.floor(points.length / 2)
  const centerPoint = points[centerIdx] || points[0]

  return { d, midX: centerPoint.x, midY: centerPoint.y }
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
  const canvasNodes = useWorkspaceStore((state) => state.nodes)

  useEffect(() => {
    let animId: number
    const animate = (timestamp: number) => {
      setTimeMs(timestamp)
      animId = requestAnimationFrame(animate)
    }
    animId = requestAnimationFrame(animate)
    return () => cancelAnimationFrame(animId)
  }, [])

  const obstacles = canvasNodes.filter((node) => node.id !== source && node.id !== target)
  const route = calculateCableRoute({ x: sourceX, y: sourceY }, { x: targetX, y: targetY }, obstacles)
  const { d: routedPath, midX, midY } = calculateRopeGeometry(route, timeMs)

  return (
    <>
      <BaseEdge id={`${id}-shadow`} path={routedPath} className="rope-edge-shadow" />
      <BaseEdge
        id={id}
        path={routedPath}
        className={`rope-edge ${selected ? 'selected' : ''}`}
      />
      <circle className="rope-anchor" cx={sourceX} cy={sourceY} r="4" />
      <circle className="rope-anchor" cx={targetX} cy={targetY} r="4" />
      {label && (
        <EdgeLabelRenderer>
          <span
            className="rope-label nodrag nopan"
            style={{ transform: `translate(-50%, -50%) translate(${midX}px, ${midY + 12}px)` }}
          >
            {String(label)}
          </span>
        </EdgeLabelRenderer>
      )}
    </>
  )
}
