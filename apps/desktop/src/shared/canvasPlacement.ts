export type CanvasRect = { x: number; y: number; width: number; height: number }

const finite = (value: unknown, fallback: number) => {
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : fallback
}

export function rectanglesOverlap(left: CanvasRect, right: CanvasRect, margin = 24): boolean {
  return !(
    left.x + left.width + margin <= right.x ||
    left.x >= right.x + right.width + margin ||
    left.y + left.height + margin <= right.y ||
    left.y >= right.y + right.height + margin
  )
}

/** Deterministically place a node in a free rectangle near its requested point. */
export function findNonOverlappingPosition(
  nodes: Array<Partial<CanvasRect>>,
  requested: CanvasRect,
  margin = 24
): { x: number; y: number } {
  const normalized = nodes.map((node) => ({
    x: finite(node.x, 0),
    y: finite(node.y, 0),
    width: Math.max(1, finite(node.width, 300)),
    height: Math.max(1, finite(node.height, 200))
  }))
  const origin = {
    x: Math.round(finite(requested.x, 0)),
    y: Math.round(finite(requested.y, 0)),
    width: Math.max(1, finite(requested.width, 300)),
    height: Math.max(1, finite(requested.height, 200))
  }
  const free = (x: number, y: number) => !normalized.some((node) => rectanglesOverlap({ ...origin, x, y }, node, margin))
  if (free(origin.x, origin.y)) return { x: origin.x, y: origin.y }

  const nearest = [...normalized].sort((left, right) =>
    Math.hypot(left.x - origin.x, left.y - origin.y) - Math.hypot(right.x - origin.x, right.y - origin.y))
  for (const node of nearest) {
    const candidates = [
      { x: node.x + node.width + margin, y: origin.y },
      { x: node.x - origin.width - margin, y: origin.y },
      { x: origin.x, y: node.y + node.height + margin },
      { x: origin.x, y: node.y - origin.height - margin }
    ]
    const candidate = candidates.find((position) => free(Math.round(position.x), Math.round(position.y)))
    if (candidate) return { x: Math.round(candidate.x), y: Math.round(candidate.y) }
  }

  const stepX = Math.max(48, origin.width + margin)
  const stepY = Math.max(48, origin.height + margin)
  const maxRing = Math.max(16, Math.ceil(Math.sqrt(normalized.length + 1)) + 8)
  for (let ring = 1; ring <= maxRing; ring += 1) {
    for (let column = -ring; column <= ring; column += 1) {
      for (const row of [-ring, ring]) {
        const x = Math.round(origin.x + column * stepX)
        const y = Math.round(origin.y + row * stepY)
        if (free(x, y)) return { x, y }
      }
    }
    for (let row = -ring + 1; row < ring; row += 1) {
      for (const column of [-ring, ring]) {
        const x = Math.round(origin.x + column * stepX)
        const y = Math.round(origin.y + row * stepY)
        if (free(x, y)) return { x, y }
      }
    }
  }

  const rightEdge = normalized.reduce((maximum, node) => Math.max(maximum, node.x + node.width), origin.x)
  return { x: Math.ceil(rightEdge + margin), y: origin.y }
}
