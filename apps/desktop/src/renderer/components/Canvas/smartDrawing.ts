export type DrawingPoint = { x: number; y: number }
export type SmartDrawingKind = 'freehand' | 'line' | 'rectangle' | 'ellipse' | 'diamond' | 'triangle' | 'star' | 'heart'

export type SmartDrawingResult = {
  kind: SmartDrawingKind
  points: DrawingPoint[]
  bounds: { minX: number; minY: number; maxX: number; maxY: number; width: number; height: number }
  confidence?: number
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

/** Ramer–Douglas–Peucker keeps intentional corners while discarding jitter. */
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

function normalizeContour(points: DrawingPoint[]): DrawingPoint[] {
  const bounds = drawingBounds(points)
  const width = Math.max(1, bounds.width)
  const height = Math.max(1, bounds.height)
  return points.map((point) => ({
    x: (point.x - bounds.minX) / width,
    y: (point.y - bounds.minY) / height
  }))
}

function resampleClosedContour(input: DrawingPoint[], count = 64): DrawingPoint[] {
  if (input.length < 2) return [...input]
  const points = [...input]
  if (distance(points[0], points[points.length - 1]) > 0.0001) points.push(points[0])
  const segmentLengths: number[] = []
  let total = 0
  for (let index = 1; index < points.length; index += 1) {
    const length = distance(points[index - 1], points[index])
    segmentLengths.push(length)
    total += length
  }
  if (total <= 0.0001) return Array.from({ length: count }, () => ({ ...points[0] }))
  const result: DrawingPoint[] = []
  let segment = 0
  let segmentStart = 0
  for (let sample = 0; sample < count; sample += 1) {
    const target = total * sample / count
    while (segment < segmentLengths.length - 1 && segmentStart + segmentLengths[segment] < target) {
      segmentStart += segmentLengths[segment]
      segment += 1
    }
    const length = Math.max(0.0001, segmentLengths[segment])
    const ratio = Math.max(0, Math.min(1, (target - segmentStart) / length))
    result.push({
      x: points[segment].x + (points[segment + 1].x - points[segment].x) * ratio,
      y: points[segment].y + (points[segment + 1].y - points[segment].y) * ratio
    })
  }
  return result
}

const polygon = (vertices: DrawingPoint[]) => resampleClosedContour(vertices, 64)

const CONTOUR_TEMPLATES = ([
  {
    kind: 'ellipse',
    points: Array.from({ length: 64 }, (_, index) => {
      const angle = Math.PI * 2 * index / 64
      return { x: .5 + Math.cos(angle) * .5, y: .5 + Math.sin(angle) * .5 }
    }),
    threshold: .105
  },
  { kind: 'rectangle', points: polygon([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }]), threshold: .105 },
  { kind: 'diamond', points: polygon([{ x: .5, y: 0 }, { x: 1, y: .5 }, { x: .5, y: 1 }, { x: 0, y: .5 }]), threshold: .105 },
  { kind: 'triangle', points: polygon([{ x: .5, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }]), threshold: .115 },
  {
    kind: 'star',
    points: polygon(Array.from({ length: 10 }, (_, index) => {
      const angle = -Math.PI / 2 + index * Math.PI / 5
      const radius = index % 2 === 0 ? .5 : .21
      return { x: .5 + Math.cos(angle) * radius, y: .5 + Math.sin(angle) * radius }
    })),
    threshold: .13
  },
  {
    kind: 'heart',
    points: resampleClosedContour(Array.from({ length: 96 }, (_, index) => {
      const angle = Math.PI * 2 * index / 96
      return {
        x: 16 * Math.sin(angle) ** 3,
        y: -(13 * Math.cos(angle) - 5 * Math.cos(2 * angle) - 2 * Math.cos(3 * angle) - Math.cos(4 * angle))
      }
    }), 64),
    threshold: .13
  }
] satisfies Array<{ kind: Exclude<SmartDrawingKind, 'freehand' | 'line'>; points: DrawingPoint[]; threshold: number }>)
  .map((template) => ({ ...template, points: resampleClosedContour(normalizeContour(template.points), 64) }))

function contourDistance(left: DrawingPoint[], right: DrawingPoint[]): number {
  let best = Number.POSITIVE_INFINITY
  const length = Math.min(left.length, right.length)
  for (const reverse of [false, true]) {
    for (let shift = 0; shift < length; shift += 1) {
      let sum = 0
      for (let index = 0; index < length; index += 1) {
        const rightIndex = reverse ? (shift - index + length * 2) % length : (shift + index) % length
        sum += distance(left[index], right[rightIndex])
      }
      best = Math.min(best, sum / length)
    }
  }
  return best
}

function recognizeClosedContour(points: DrawingPoint[]): { kind: SmartDrawingKind; confidence: number } | null {
  // Normalize before resampling so a wide rectangle and a square template
  // traverse equivalent contour fractions. Resampling raw physical lengths
  // biased the score toward a circle whenever width and height differed.
  const contour = resampleClosedContour(normalizeContour(points), 64)
  const ranked = CONTOUR_TEMPLATES
    .map((template) => ({ ...template, score: contourDistance(contour, template.points) }))
    .sort((left, right) => left.score - right.score)
  const best = ranked[0]
  const runnerUp = ranked[1]
  if (!best || best.score > best.threshold) return null
  if (runnerUp && runnerUp.score - best.score < .012 && best.score > .055) return null
  return { kind: best.kind, confidence: Math.max(0, Math.min(1, 1 - best.score / best.threshold)) }
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
    return { kind: 'line', points: [start, end], bounds, confidence: 1 - maxDeviation / Math.max(3.5, directDistance * .055) }
  }

  const closed = points.length >= 8 && distance(start, end) <= Math.max(18, diagonal * 0.22)
  if (closed && bounds.width >= 24 && bounds.height >= 24) {
    const recognized = recognizeClosedContour(points)
    if (recognized) return { ...recognized, points, bounds }
  }

  const tolerance = Math.max(1.4, diagonal * 0.012)
  return { kind: 'freehand', points: simplifyDrawing(points, tolerance), bounds }
}
