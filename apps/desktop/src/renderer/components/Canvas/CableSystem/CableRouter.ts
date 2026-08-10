import { Point, NodeRect } from './AnchorResolver';

const SPATIAL_GAP = 3;

function rectsIntersect(
  x1: number, y1: number, x2: number, y2: number,
  rx: number, ry: number, rw: number, rh: number
): boolean {
  // Line-rect intersection by sampling points (as requested in spec: "amostrando aproximadamente 20 pontos")
  const dist = Math.hypot(x2 - x1, y2 - y1);
  if (dist === 0) return false;
  
  const steps = 20;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const px = x1 + (x2 - x1) * t;
    const py = y1 + (y2 - y1) * t;
    
    if (px >= rx && px <= rx + rw && py >= ry && py <= ry + rh) {
      return true;
    }
  }
  return false;
}

export function routeCable(
  start: Point, leadStart: Point, leadEnd: Point, end: Point,
  obstacles: NodeRect[]
): Point[] {
  let route = [start, leadStart, leadEnd, end];
  
  const expandedObstacles = obstacles.map(obs => ({
    x: obs.x - SPATIAL_GAP,
    y: obs.y - SPATIAL_GAP,
    width: obs.width + SPATIAL_GAP * 2,
    height: obs.height + SPATIAL_GAP * 2
  }));

  for (let pass = 0; pass < 5; pass++) {
    let collisionFound = false;
    let newRoute = [route[0]];

    for (let i = 0; i < route.length - 1; i++) {
      const p1 = route[i];
      const p2 = route[i + 1];
      
      let collidedObs = null;
      for (const obs of expandedObstacles) {
        if (rectsIntersect(p1.x, p1.y, p2.x, p2.y, obs.x, obs.y, obs.width, obs.height)) {
          collidedObs = obs;
          break;
        }
      }

      if (collidedObs) {
        collisionFound = true;
        const dx = Math.abs(p2.x - p1.x);
        const dy = Math.abs(p2.y - p1.y);
        
        // If mostly horizontal, route above/below. If mostly vertical, route left/right.
        // Choose the shortest detour.
        let wp1: Point, wp2: Point;
        
        const midX = (p1.x + p2.x) / 2;
        const midY = (p1.y + p2.y) / 2;
        
        if (dx > dy) {
          // Horizontal line: route top or bottom
          const topDist = Math.abs(midY - collidedObs.y);
          const botDist = Math.abs(midY - (collidedObs.y + collidedObs.height));
          const y = topDist < botDist ? collidedObs.y : collidedObs.y + collidedObs.height;
          
          wp1 = { x: p1.x, y };
          wp2 = { x: p2.x, y };
        } else {
          // Vertical line: route left or right
          const leftDist = Math.abs(midX - collidedObs.x);
          const rightDist = Math.abs(midX - (collidedObs.x + collidedObs.width));
          const x = leftDist < rightDist ? collidedObs.x : collidedObs.x + collidedObs.width;
          
          wp1 = { x, y: p1.y };
          wp2 = { x, y: p2.y };
        }
        
        newRoute.push(wp1, wp2, p2);
      } else {
        newRoute.push(p2);
      }
    }
    
    route = newRoute;
    if (!collisionFound) break;
  }
  
  return route;
}

export function routeLength(route: Point[]): number {
  let len = 0;
  for (let i = 0; i < route.length - 1; i++) {
    len += Math.hypot(route[i+1].x - route[i].x, route[i+1].y - route[i].y);
  }
  return len;
}
