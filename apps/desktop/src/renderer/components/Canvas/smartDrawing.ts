export type DrawingPoint = { x: number; y: number }
export type SmartDrawingKind = 'freehand' | 'line' | 'rectangle' | 'ellipse'

export type SmartDrawingResult = {
  kind: SmartDrawingKind
  points: DrawingPoint[]
  bounds: { minX: number; minY: number; maxX: number; maxY: number; width: number; height: number }
}

const distance = (a: DrawingPoint, b: DrawingPoint) => Math.hypot(b.x - a.x, b.y - a.y)

function pointLineDistance(point: DrawingPoint, start: DrawingPoint, end: DrawingPoint) {
  const length = distance(start, end)
  if (length === 0) return distance(point, start)
  return Math.abs((end.y - start.y) * point.x - (end.x - start.x) * point.y + end.x * start.y - end.y * start.x) / length
}

export function drawingBounds(points: DrawingPoint[]) {
  const xs = points.map((point) => point.x)
  const ys = points.map((point) => point.y)
  const minX = xs.length ? Math.min(...xs) : 0
  const minY = ys.length ? Math.min(...ys) : 0
  const maxX = xs.length ? Math.max(...xs) : minX
  const maxY = ys.length ? Math.max(...ys) : minY
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY }
}

/** Ramer–Douglas–Peucker keeps intentional corners while discarding mouse
 * jitter and the very dense points produced by a trackpad. */
export function simplifyDrawing(points: DrawingPoint[], tolerance = 1.8): DrawingPoint[] {
  if (points.length <= 2) return [...points]
  let furthest = 0
  let furthestDistance = 0
  for (let index = 1; index < points.length - 1; index += 1) {
    const candidate = pointLineDistance(points[index], points[0], points[points.length - 1])
    if (candidate > furthestDistance) {
      furthest = index
      furthestDistance = candidate
    }
  }
  if (furthestDistance <= tolerance) return [points[0], points[points.length - 1]]
  const left = simplifyDrawing(points.slice(0, furthest + 1), tolerance)
  const right = simplifyDrawing(points.slice(furthest), tolerance)
  return [...left.slice(0, -1), ...right]
}

export function smoothDrawingPath(points: DrawingPoint[]): string {
  if (!points.length) return ''
  if (points.length === 1) return `M ${points[0].x} ${points[0].y} l .01 .01`
  if (points.length === 2) return `M ${points[0].x} ${points[0].y} L ${points[1].x} ${points[1].y}`
  let path = `M ${points[0].x} ${points[0].y}`
  for (let index = 1; index < points.length - 1; index += 1) {
    const midpoint = {
      x: (points[index].x + points[index + 1].x) / 2,
      y: (points[index].y + points[index + 1].y) / 2,
    }
    path += ` Q ${points[index].x} ${points[index].y} ${midpoint.x} ${midpoint.y}`
  }
  const last = points[points.length - 1]
  return `${path} L ${last.x} ${last.y}`
}

export function recognizeDrawing(input: DrawingPoint[]): SmartDrawingResult {
  const sampled = input.filter((point, index) => index === 0 || distance(point, input[index - 1]) >= 1.5)
  const points = sampled.length ? sampled : input
  const bounds = drawingBounds(points)
  if (points.length < 2) return { kind: 'freehand', points, bounds }

  const start = points[0]
  const end = points[points.length - 1]
  const diagonal = Math.hypot(bounds.width, bounds.height)
  const directDistance = distance(start, end)
  const maxDeviation = Math.max(...points.map((point) => pointLineDistance(point, start, end)))
  if (directDistance >= 24 && maxDeviation <= Math.max(3.5, directDistance * 0.055)) {
    return { kind: 'line', points: [start, end], bounds }
  }

  const closed = points.length >= 8 && distance(start, end) <= Math.max(16, diagonal * 0.18)
  if (closed && bounds.width >= 24 && bounds.height >= 24) {
    const centerX = (bounds.minX + bounds.maxX) / 2
    const centerY = (bounds.minY + bounds.maxY) / 2
    const radiusX = Math.max(1, bounds.width / 2)
    const radiusY = Math.max(1, bounds.height / 2)
    const radialErrors = points.map((point) => Math.abs(Math.hypot((point.x - centerX) / radiusX, (point.y - centerY) / radiusY) - 1))
    const ellipseError = radialErrors.reduce((total, value) => total + value, 0) / radialErrors.length
    return { kind: ellipseError < 0.12 ? 'ellipse' : 'rectangle', points, bounds }
  }

  const tolerance = Math.max(1.4, diagonal * 0.012)
  return { kind: 'freehand', points: simplifyDrawing(points, tolerance), bounds }
}
