export type CanvasViewport = {
  x: number
  y: number
  zoom: number
}

export type CanvasPoint = {
  x: number
  y: number
}

/** Convert a window/content-view point to ReactFlow renderer coordinates. */
export const getCanvasPinchAnchor = (
  screenPoint: CanvasPoint,
  surfaceRect: Pick<DOMRect, 'left' | 'top'> | { left: number; top: number }
): CanvasPoint => ({
  x: screenPoint.x - surfaceRect.left,
  y: screenPoint.y - surfaceRect.top
})

export type CanvasPinchInput = {
  ctrlKey?: boolean
  metaKey?: boolean
  altKey?: boolean
  deltaX?: number
  deltaY?: number
  deltaMode?: number
}

export type CanvasBoardWheelGesture = 'vertical-zoom' | 'horizontal-pan' | 'none'

/**
 * Classify an unmodified two-finger board gesture.
 *
 * Chromium exposes trackpad scrolling as a plain `wheel` event (there is no
 * touch-count on WheelEvent).  Axis locking keeps a diagonal packet from
 * applying zoom and pan at the same time: the dominant axis owns the
 * gesture.  Modifier wheels are handled by the real pinch path below, while
 * blocked surfaces (nodes/editors, portals and controls) keep their own
 * scrolling behavior.
 */
export const getCanvasBoardWheelGesture = (
  event: CanvasPinchInput,
  options: { blocked?: boolean } = {}
): CanvasBoardWheelGesture => {
  if (options.blocked || event.ctrlKey || event.metaKey || event.altKey) return 'none'
  const deltaX = Number.isFinite(event.deltaX) ? Number(event.deltaX) : 0
  const deltaY = Number.isFinite(event.deltaY) ? Number(event.deltaY) : 0
  if (deltaX === 0 && deltaY === 0) return 'none'
  if (Math.abs(deltaX) > Math.abs(deltaY)) return 'horizontal-pan'
  return deltaY === 0 ? 'none' : 'vertical-zoom'
}

export const CANVAS_MIN_ZOOM = 0.08
export const CANVAS_MAX_ZOOM = 4

/**
 * Chromium reports a trackpad pinch as a wheel event with a modifier key.
 * Keep this predicate deliberately narrow: a plain wheel must remain an
 * ordinary canvas scroll/zoom, and Alt+wheel belongs to the platform/browser.
 * The same shape is used for Electron's native portal `input-event` bridge.
 */
export const isCanvasPinchWheelEvent = (event: CanvasPinchInput) => (
  Boolean(event.ctrlKey || event.metaKey) &&
  !event.altKey &&
  ((Number.isFinite(event.deltaY) && event.deltaY !== 0) ||
    (Number.isFinite(event.deltaX) && event.deltaX !== 0))
)

export const clampCanvasZoom = (zoom: number) => {
  const finiteZoom = Number.isFinite(zoom) ? zoom : 1
  return Math.min(CANVAS_MAX_ZOOM, Math.max(CANVAS_MIN_ZOOM, finiteZoom))
}

/** Matches React Flow's wheel delta normalization for Chromium/Firefox. */
export const canvasPinchZoomFactor = (
  event: Pick<CanvasPinchInput, 'ctrlKey' | 'metaKey' | 'deltaY' | 'deltaMode'>,
  isMacOS: boolean
) => {
  const deltaScale = event.deltaMode === 1 ? 0.05 : event.deltaMode ? 1 : 0.002
  const platformScale = event.ctrlKey && isMacOS ? 10 : 1
  const deltaY = Number.isFinite(event.deltaY) ? Number(event.deltaY) : 0
  const rawFactor = Math.pow(2, -deltaY * deltaScale * platformScale)
  // A compositor can occasionally coalesce a large Linux wheel packet. Cap
  // one packet so a single outlier cannot jump across most of the canvas.
  // Multiple packets in the same gesture still reach the full range smoothly.
  return Math.min(2, Math.max(0.5, Number.isFinite(rawFactor) ? rawFactor : 1))
}

export const canvasPinchGestureFactor = (value: unknown) => {
  const factor = Number(value)
  if (!Number.isFinite(factor) || factor <= 0) return 1
  return Math.min(2, Math.max(0.5, factor))
}

/**
 * Apply the translational part of a two-finger gesture in screen pixels.
 * Horizontal trackpad movement is intentionally independent from zoom; the
 * caller can leave `panY` at zero for vertical wheel packets so scrolling a
 * browser/terminal never shifts the board or duplicates its overlays.
 */
export const getCanvasPinchPanViewport = (
  viewport: CanvasViewport,
  panX: number = 0,
  panY: number = 0
): CanvasViewport => ({
  x: viewport.x - (Number.isFinite(panX) ? panX : 0),
  y: viewport.y - (Number.isFinite(panY) ? panY : 0),
  zoom: viewport.zoom
})

/**
 * Returns a viewport whose screen-space point remains fixed while zooming.
 * `anchor` is relative to the React Flow renderer (not the window).
 */
export const getCanvasPinchViewport = (
  viewport: CanvasViewport,
  anchor: CanvasPoint,
  zoomFactor: number
): CanvasViewport => {
  const currentZoom = Number.isFinite(viewport.zoom) && viewport.zoom > 0 ? viewport.zoom : 1
  const nextZoom = clampCanvasZoom(currentZoom * zoomFactor)
  const scale = nextZoom / currentZoom

  return {
    x: anchor.x - (anchor.x - viewport.x) * scale,
    y: anchor.y - (anchor.y - viewport.y) * scale,
    zoom: nextZoom,
  }
}
