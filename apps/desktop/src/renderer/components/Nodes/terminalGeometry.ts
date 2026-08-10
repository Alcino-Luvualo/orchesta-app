/**
 * React Flow scales its node subtree with a CSS transform. xterm.js keeps its
 * character metrics in the node's unscaled CSS coordinate space, while
 * `getBoundingClientRect()` reports the transformed (painted) rectangle. The
 * two spaces must be bridged before xterm converts a pointer to a cell.
 */

export interface TerminalVisualRect {
  left: number
  top: number
  width: number
  height: number
}

export interface TerminalLayoutSize {
  width: number
  height: number
}

export interface TerminalPointer {
  clientX: number
  clientY: number
}

export interface TerminalTransformScale {
  x: number
  y: number
}

const MIN_SCALE = 0.01
const MAX_SCALE = 100

function finitePositive(value: number): number | null {
  return Number.isFinite(value) && value > 0 ? value : null
}

function clampScale(value: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, value))
}

/** Derive the effective CSS transform scale without consulting device pixels. */
export function getTerminalTransformScale(
  visual: TerminalVisualRect,
  layout: TerminalLayoutSize
): TerminalTransformScale {
  const layoutWidth = finitePositive(layout.width)
  const layoutHeight = finitePositive(layout.height)
  const visualWidth = finitePositive(visual.width)
  const visualHeight = finitePositive(visual.height)
  return {
    x: layoutWidth && visualWidth ? clampScale(visualWidth / layoutWidth) : 1,
    y: layoutHeight && visualHeight ? clampScale(visualHeight / layoutHeight) : 1
  }
}

/**
 * Convert a painted viewport point into the unscaled CSS point xterm expects.
 * Keeping the returned point in client coordinates means xterm can continue
 * to apply its normal padding and cell rounding logic.
 */
export function mapTerminalPointerToLayout(
  pointer: TerminalPointer,
  visual: TerminalVisualRect,
  scale: TerminalTransformScale
): TerminalPointer {
  const scaleX = Number.isFinite(scale.x) && scale.x > 0 ? scale.x : 1
  const scaleY = Number.isFinite(scale.y) && scale.y > 0 ? scale.y : 1
  return {
    clientX: visual.left + (pointer.clientX - visual.left) / scaleX,
    clientY: visual.top + (pointer.clientY - visual.top) / scaleY
  }
}

export function isIdentityTerminalScale(scale: TerminalTransformScale, epsilon = 0.001): boolean {
  return Math.abs(scale.x - 1) <= epsilon && Math.abs(scale.y - 1) <= epsilon
}
