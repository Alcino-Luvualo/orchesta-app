export interface Viewport {
  panX: number;
  panY: number;
  zoom: number;
}

export const ZOOM_SENSITIVITY = 0.002;
export const MIN_ZOOM = 0.15;
export const MAX_ZOOM = 3.0;

export function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}
