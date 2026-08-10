import { Point, NodeRect } from './AnchorResolver';

const SPATIAL_GAP = 3;
const CABLE_VISUAL_RADIUS = 1;
const TOTAL_GAP = SPATIAL_GAP + CABLE_VISUAL_RADIUS;

export function projectPointOutOfObstacles(point: Point, obstacles: NodeRect[]): boolean {
  let projected = false;
  
  for (const obs of obstacles) {
    const rx = obs.x - TOTAL_GAP;
    const ry = obs.y - TOTAL_GAP;
    const rw = obs.width + TOTAL_GAP * 2;
    const rh = obs.height + TOTAL_GAP * 2;
    
    if (point.x > rx && point.x < rx + rw && point.y > ry && point.y < ry + rh) {
      projected = true;
      const left = point.x - rx;
      const right = (rx + rw) - point.x;
      const top = point.y - ry;
      const bottom = (ry + rh) - point.y;
      
      const min = Math.min(left, right, top, bottom);
      
      if (min === left) {
        point.x = rx;
      } else if (min === right) {
        point.x = rx + rw;
      } else if (min === top) {
        point.y = ry;
      } else if (min === bottom) {
        point.y = ry + rh;
      }
    }
  }
  
  return projected;
}
