export interface NodeRect {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

export function getCenter(rect: NodeRect): Point {
  return {
    x: rect.x + rect.width / 2,
    y: rect.y + rect.height / 2,
  };
}

export function getAnchorOnRect(rect: NodeRect, target: Point): { anchor: Point; edge: 'left' | 'right' | 'top' | 'bottom' } {
  const centerX = rect.x + rect.width / 2;
  const centerY = rect.y + rect.height / 2;

  const dx = target.x - centerX;
  const dy = target.y - centerY;

  const scaledX = Math.abs(dx) / (rect.width / 2);
  const scaledY = Math.abs(dy) / (rect.height / 2);

  let edge: 'left' | 'right' | 'top' | 'bottom';
  if (scaledX >= scaledY) {
    edge = dx > 0 ? 'right' : 'left';
  } else {
    edge = dy > 0 ? 'bottom' : 'top';
  }

  let x = centerX;
  let y = centerY;
  const padding = 12;

  if (edge === 'left') {
    x = rect.x;
    const slope = dy / Math.abs(dx);
    y = centerY + slope * (rect.width / 2);
  } else if (edge === 'right') {
    x = rect.x + rect.width;
    const slope = dy / Math.abs(dx);
    y = centerY + slope * (rect.width / 2);
  } else if (edge === 'top') {
    y = rect.y;
    const slope = dx / Math.abs(dy);
    x = centerX + slope * (rect.height / 2);
  } else if (edge === 'bottom') {
    y = rect.y + rect.height;
    const slope = dx / Math.abs(dy);
    x = centerX + slope * (rect.height / 2);
  }

  // Clamp to avoid corners
  x = Math.max(rect.x + padding, Math.min(rect.x + rect.width - padding, x));
  y = Math.max(rect.y + padding, Math.min(rect.y + rect.height - padding, y));

  return { anchor: { x, y }, edge };
}

export function pairedAnchors(nodeA: NodeRect, nodeB: NodeRect) {
  const centerA = getCenter(nodeA);
  const centerB = getCenter(nodeB);

  const aRes = getAnchorOnRect(nodeA, centerB);
  const bRes = getAnchorOnRect(nodeB, centerA);

  const start = aRes.anchor;
  const end = bRes.anchor;

  const dist = Math.hypot(end.x - start.x, end.y - start.y);
  const leadSize = Math.min(9, Math.max(0.75, dist / 3));

  const getLead = (anchor: Point, edge: string, size: number) => {
    switch (edge) {
      case 'left': return { x: anchor.x - size, y: anchor.y };
      case 'right': return { x: anchor.x + size, y: anchor.y };
      case 'top': return { x: anchor.x, y: anchor.y - size };
      case 'bottom': return { x: anchor.x, y: anchor.y + size };
      default: return anchor;
    }
  };

  const leadStart = getLead(start, aRes.edge, leadSize);
  const leadEnd = getLead(end, bRes.edge, leadSize);

  return { start, end, leadStart, leadEnd };
}
