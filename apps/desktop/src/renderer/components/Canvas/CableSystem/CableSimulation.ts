import { Point, NodeRect } from './AnchorResolver';
import { routeCable, routeLength } from './CableRouter';
import { projectPointOutOfObstacles } from './CollisionSolver';

export interface CablePoint extends Point {
  px: number;
  py: number;
}

export interface Connection {
  a: string;
  b: string;
  active: boolean;
  disturbed?: number;
}

export class CableSimulation {
  points: CablePoint[] = [];
  rest: number = 0;
  targetRest: number = 0;
  lastA: Point = { x: 0, y: 0 };
  lastB: Point = { x: 0, y: 0 };
  lastDisturb: number = 0;
  activeUntil: number = 0;
  needsProjection: boolean = true;

  init(route: Point[], isTemporary: boolean = false) {
    const dist = routeLength(route);
    const steps = Math.max(4, Math.min(14, Math.round(dist / 28)));
    
    this.points = [];
    let routeIndex = 0;
    
    // Create points along the route
    for (let i = 0; i < steps; i++) {
      const u = i / (steps - 1);
      const targetDist = u * dist;
      
      let currentDist = 0;
      let p = route[route.length - 1]; // Default to end
      
      for (let j = 0; j < route.length - 1; j++) {
        const segDist = Math.hypot(route[j+1].x - route[j].x, route[j+1].y - route[j].y);
        if (currentDist + segDist >= targetDist || j === route.length - 2) {
          const segU = segDist === 0 ? 0 : (targetDist - currentDist) / segDist;
          const px = route[j].x + (route[j+1].x - route[j].x) * segU;
          const py = route[j].y + (route[j+1].y - route[j].y) * segU;
          
          let gravityShape = 0;
          if (j > 0 && j < route.length - 2) { // Middle segments
            gravityShape = 12 * 4 * u * (1 - u);
          }
          
          let swing = 0;
          if (isTemporary) {
            const time = performance.now();
            const amplitude = 3;
            swing = Math.sin(time / 125 + j * 1.7 + u * 5) * amplitude * Math.sin(Math.PI * u);
          }

          const normalX = segDist === 0 ? 0 : -(route[j+1].y - route[j].y) / segDist;
          const normalY = segDist === 0 ? 0 : (route[j+1].x - route[j].x) / segDist;

          p = { 
            x: px + normalX * swing, 
            y: py + gravityShape + normalY * swing
          };
          break;
        }
        currentDist += segDist;
      }
      
      this.points.push({ ...p, px: p.x, py: p.y });
    }
    
    this.targetRest = dist / (this.points.length - 1) * 1.015;
    this.rest = this.targetRest * (1.02 / 1.015);
    this.activeUntil = performance.now() + 1900;
  }

  simulate(obstacles: NodeRect[], route: Point[], start: Point, leadStart: Point, leadEnd: Point, end: Point, isActive: boolean) {
    const DAMPING = 0.92;
    const GRAVITY = 0.34;
    
    const moved = Math.hypot(start.x - this.lastA.x, start.y - this.lastA.y) + Math.hypot(end.x - this.lastB.x, end.y - this.lastB.y);
    const now = performance.now();
    
    if (moved > 0.2) {
      this.activeUntil = now + 1700;
    }
    this.lastA = start;
    this.lastB = end;

    this.targetRest = routeLength(route) / (this.points.length - 1) * 1.015;
    const rate = isActive ? 0.11 : 0.18;
    this.rest += (this.targetRest - this.rest) * rate;

    // Pin ends
    if (this.points.length >= 4) {
      const last = this.points.length - 1;
      this.points[0].x = start.x; this.points[0].y = start.y;
      this.points[1].x = leadStart.x; this.points[1].y = leadStart.y;
      this.points[last - 1].x = leadEnd.x; this.points[last - 1].y = leadEnd.y;
      this.points[last].x = end.x; this.points[last].y = end.y;
    }

    if (now > this.activeUntil) return; // Sleep

    // Verlet integration
    for (let i = 2; i < this.points.length - 2; i++) {
      const p = this.points[i];
      const vx = (p.x - p.px) * DAMPING;
      const vy = (p.y - p.py) * DAMPING;
      p.px = p.x;
      p.py = p.y;
      p.x += vx;
      p.y += vy + GRAVITY;
    }

    // Constraint solver
    const passes = this.needsProjection ? 36 : 12;
    this.needsProjection = false;

    let pushed = false;
    for (let pass = 0; pass < passes; pass++) {
      for (let i = 0; i < this.points.length - 1; i++) {
        const p = this.points[i];
        const q = this.points[i+1];
        
        const dx = q.x - p.x;
        const dy = q.y - p.y;
        const dist = Math.hypot(dx, dy);
        if (dist === 0) continue;
        
        const difference = (dist - this.rest) / dist;
        const adjustment = 0.5 * difference;
        
        if (i >= 2) {
          p.x += dx * adjustment;
          p.y += dy * adjustment;
        }
        if (i + 1 <= this.points.length - 3) {
          q.x -= dx * adjustment;
          q.y -= dy * adjustment;
        }
      }
      
      // Collision projection
      for (let i = 2; i < this.points.length - 2; i++) {
        if (projectPointOutOfObstacles(this.points[i], obstacles)) {
          pushed = true;
        }
      }
    }
    
    if (pushed) {
      this.activeUntil = now + 1900;
    }

    // Ensure pins are exact
    if (this.points.length >= 4) {
      const last = this.points.length - 1;
      this.points[0].x = start.x; this.points[0].y = start.y;
      this.points[1].x = leadStart.x; this.points[1].y = leadStart.y;
      this.points[last - 1].x = leadEnd.x; this.points[last - 1].y = leadEnd.y;
      this.points[last].x = end.x; this.points[last].y = end.y;
    }
  }

  generateSmoothPath(): string {
    if (this.points.length === 0) return '';
    let d = `M ${this.points[0].x} ${this.points[0].y} L ${this.points[1].x} ${this.points[1].y}`;
    
    for (let i = 1; i < this.points.length - 2; i++) {
      const current = this.points[i];
      const next = this.points[i+1];
      const midX = (current.x + next.x) / 2;
      const midY = (current.y + next.y) / 2;
      d += ` Q ${current.x} ${current.y} ${midX} ${midY}`;
    }
    
    const last = this.points.length - 1;
    d += ` Q ${this.points[last - 1].x} ${this.points[last - 1].y} ${this.points[last].x} ${this.points[last].y}`;
    return d;
  }
}
