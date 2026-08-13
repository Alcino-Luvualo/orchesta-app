/**
 * Geometry shared by the renderer and the Electron main process for native
 * browser portals.
 *
 * A WebContentsView is not clipped by the DOM element that represents a node.
 * Always intersect the requested rectangle with the renderer/content viewport
 * before handing it to the native view.  A partially visible rectangle is
 * deliberately marked as not visible: showing an intersected native page can
 * still expose a different layout than the DOM snapshot and is the source of
 * the large white portal that used to appear while panning the canvas.
 */

export interface PortalRect {
  left: number
  top: number
  right: number
  bottom: number
}

export interface PortalViewport {
  left: number
  top: number
  width: number
  height: number
}

export interface PortalBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface PortalGeometry {
  bounds: PortalBounds
  visible: boolean
  fullyVisible: boolean
  clipped: boolean
  hasIntersection: boolean
  scale: number
}

export const PORTAL_MIN_SCALE = 0.25
export const PORTAL_MAX_SCALE = 5

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function positive(value: unknown): value is number {
  return finite(value) && value > 0
}

function safeViewport(viewport: PortalViewport): PortalRect | null {
  if (!viewport || !finite(viewport.left) || !finite(viewport.top) || !positive(viewport.width) || !positive(viewport.height)) {
    return null
  }
  return {
    left: viewport.left,
    top: viewport.top,
    right: viewport.left + viewport.width,
    bottom: viewport.top + viewport.height
  }
}

function safeRect(rect: PortalRect): PortalRect | null {
  if (!rect || !finite(rect.left) || !finite(rect.top) || !finite(rect.right) || !finite(rect.bottom)) return null
  if (rect.right <= rect.left || rect.bottom <= rect.top) return null
  return rect
}

/** Return the visible intersection without ever extending the input rect. */
export function intersectPortalRect(rect: PortalRect, viewport: PortalViewport): PortalRect | null {
  const source = safeRect(rect)
  const target = safeViewport(viewport)
  if (!source || !target) return null
  const left = Math.max(source.left, target.left)
  const top = Math.max(source.top, target.top)
  const right = Math.min(source.right, target.right)
  const bottom = Math.min(source.bottom, target.bottom)
  if (right <= left || bottom <= top) return null
  return { left, top, right, bottom }
}

/**
 * Keep the value in the range supported by Chromium.  A canvas zoom should
 * never turn into an invalid/near-zero WebContentsView zoom factor.
 */
export function clampPortalScale(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric) || numeric <= 0) return 1
  return Math.min(PORTAL_MAX_SCALE, Math.max(PORTAL_MIN_SCALE, numeric))
}

/**
 * Derive the ReactFlow transform scale from a DOM rect and its untransformed
 * layout size. ReactFlow applies one uniform scale, but tolerate fractional
 * measurements and tiny non-uniform differences from borders/rounding.
 */
export function computePortalScale(
  rect: Pick<DOMRect, 'width' | 'height'> | { width: number; height: number },
  layoutWidth: unknown,
  layoutHeight: unknown
): number {
  const width = Number(layoutWidth)
  const height = Number(layoutHeight)
  if (!positive(width) || !positive(height) || !positive(rect?.width) || !positive(rect?.height)) return 1
  const scaleX = rect.width / width
  const scaleY = rect.height / height
  if (!finite(scaleX) || !finite(scaleY) || scaleX <= 0 || scaleY <= 0) return 1
  // The transform is uniform. Averaging is more stable than picking one axis
  // when a one-pixel border rounds differently in each direction.
  return clampPortalScale((scaleX + scaleY) / 2)
}

function roundedBounds(rect: PortalRect): PortalBounds {
  // Floor the origin and ceil the far edge. This preserves every visible pixel
  // while keeping the resulting rectangle inside the already-intersected rect.
  const x = Math.floor(rect.left)
  const y = Math.floor(rect.top)
  const right = Math.ceil(rect.right)
  const bottom = Math.ceil(rect.bottom)
  return {
    x,
    y,
    width: Math.max(1, right - x),
    height: Math.max(1, bottom - y)
  }
}

function emptyBounds(viewport: PortalViewport): PortalBounds {
  const left = finite(viewport?.left) ? Math.floor(viewport.left) : 0
  const top = finite(viewport?.top) ? Math.floor(viewport.top) : 0
  return { x: left, y: top, width: 1, height: 1 }
}

/**
 * Produce safe native-view geometry. `visible` is true only for a rectangle
 * fully inside the viewport; clipped/outside nodes get a small intersection
 * or a 1x1 hidden target and should be represented by the DOM snapshot.
 */
export function getPortalGeometry(
  rect: PortalRect,
  viewport: PortalViewport,
  layoutWidth?: unknown,
  layoutHeight?: unknown
): PortalGeometry {
  const source = safeRect(rect)
  const target = safeViewport(viewport)
  const intersection = source && target ? intersectPortalRect(source, viewport) : null
  const fullyVisible = Boolean(source && target
    && source.left >= target.left
    && source.top >= target.top
    && source.right <= target.right
    && source.bottom <= target.bottom)
  const hasIntersection = Boolean(intersection)
  const clipped = hasIntersection && !fullyVisible
  const scale = computePortalScale({
    width: rect ? rect.right - rect.left : 0,
    height: rect ? rect.bottom - rect.top : 0
  }, layoutWidth, layoutHeight)

  return {
    bounds: intersection ? roundedBounds(intersection) : emptyBounds(viewport),
    visible: fullyVisible && hasIntersection,
    fullyVisible,
    clipped,
    hasIntersection,
    scale
  }
}
