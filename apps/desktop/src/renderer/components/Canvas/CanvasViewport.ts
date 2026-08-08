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

export class CanvasViewportManager {
  public viewport: Viewport = { panX: 0, panY: 0, zoom: 1 };
  private worldElement: HTMLElement | null = null;
  public workspaceElement: HTMLElement | null = null;
  private viewportFrame: number | null = null;
  private onZoomChangeCallback: ((zoom: number) => void) | null = null;
  private onSyncCallback: ((vp: Viewport) => void) | null = null;

  public init(
    workspace: HTMLElement,
    onZoomChange: (z: number) => void,
    onSync: (vp: Viewport) => void
  ) {
    this.workspaceElement = workspace;
    this.onZoomChangeCallback = onZoomChange;
    this.onSyncCallback = onSync;
  }

  public setWorldElement(world: HTMLElement) {
    this.worldElement = world;
    this.worldElement.id = 'world'; // Assign ID for the DOM as requested
    this.scheduleViewportUpdate();
  }

  public getViewport() {
    return this.viewport;
  }

  public setViewport(panX: number, panY: number, zoom: number) {
    this.viewport.panX = panX;
    this.viewport.panY = panY;
    this.viewport.zoom = clamp(zoom, MIN_ZOOM, MAX_ZOOM);
    this.scheduleViewportUpdate();
    this.syncPersistentState();
  }

  public scheduleViewportUpdate() {
    if (this.viewportFrame) return;

    this.viewportFrame = requestAnimationFrame(() => {
      this.applyViewport();
      this.viewportFrame = null;
    });
  }

  private applyViewport() {
    if (!this.worldElement) return;

    this.worldElement.style.transform = `translate(${this.viewport.panX}px, ${this.viewport.panY}px) scale(${this.viewport.zoom})`;
    
    if (this.onZoomChangeCallback) {
      this.onZoomChangeCallback(this.viewport.zoom);
    }
  }

  private syncTimer: number | null = null;

  public syncPersistentState(immediate = false) {
    if (this.syncTimer) {
      clearTimeout(this.syncTimer);
    }
    if (immediate) {
      if (this.onSyncCallback) this.onSyncCallback(this.viewport);
      return;
    }
    this.syncTimer = window.setTimeout(() => {
      if (this.onSyncCallback) {
        this.onSyncCallback(this.viewport);
      }
    }, 100);
  }

  public screenToWorld(clientX: number, clientY: number) {
    if (!this.workspaceElement) return { x: 0, y: 0 };
    const rect = this.workspaceElement.getBoundingClientRect();
    const screenX = clientX - rect.left;
    const screenY = clientY - rect.top;

    return {
      x: (screenX - this.viewport.panX) / this.viewport.zoom,
      y: (screenY - this.viewport.panY) / this.viewport.zoom
    };
  }

  public worldToScreen(worldX: number, worldY: number) {
    if (!this.workspaceElement) return { x: 0, y: 0 };
    const rect = this.workspaceElement.getBoundingClientRect();
    
    const screenX = worldX * this.viewport.zoom + this.viewport.panX;
    const screenY = worldY * this.viewport.zoom + this.viewport.panY;
    
    return {
      x: screenX + rect.left,
      y: screenY + rect.top
    };
  }

  public zoomAtScreenPoint(screenX: number, screenY: number, newZoom: number) {
    const worldX = (screenX - this.viewport.panX) / this.viewport.zoom;
    const worldY = (screenY - this.viewport.panY) / this.viewport.zoom;

    const clampedZoom = clamp(newZoom, MIN_ZOOM, MAX_ZOOM);

    this.viewport.panX = screenX - worldX * clampedZoom;
    this.viewport.panY = screenY - worldY * clampedZoom;
    this.viewport.zoom = clampedZoom;

    this.scheduleViewportUpdate();
    this.syncPersistentState();
  }

  public handlePinchZoom(event: WheelEvent) {
    if (!this.workspaceElement) return;

    const rect = this.workspaceElement.getBoundingClientRect();
    const screenX = event.clientX - rect.left;
    const screenY = event.clientY - rect.top;

    const factor = Math.exp(-event.deltaY * ZOOM_SENSITIVITY);
    this.zoomAtScreenPoint(screenX, screenY, this.viewport.zoom * factor);
  }

  public handleTrackpadPan(event: WheelEvent) {
    // Normal wheel scroll maps directly to panX and panY
    let dx = event.deltaX;
    let dy = event.deltaY;

    if (event.deltaMode === 1) {
      dx *= 24; // Lines
      dy *= 24;
    } else if (event.deltaMode === 2) {
      dx *= window.innerHeight * 0.8; // Pages
      dy *= window.innerHeight * 0.8;
    }

    this.viewport.panX -= dx;
    this.viewport.panY -= dy;
    this.scheduleViewportUpdate();
    this.syncPersistentState();
  }

  public handleWheel = (event: WheelEvent) => {
    // Check if the scroll should be consumed by an internal scrollable element
    if (this.shouldAllowNativeScroll(event.target as HTMLElement, event)) {
      return;
    }

    event.preventDefault();

    if (event.ctrlKey) {
      this.handlePinchZoom(event);
      return;
    }

    this.handleTrackpadPan(event);
  };

  private shouldAllowNativeScroll(target: HTMLElement, event: WheelEvent): boolean {
    let el: HTMLElement | null = target;
    while (el && el !== this.workspaceElement) {
      const style = window.getComputedStyle(el);
      const overflowY = style.overflowY;
      const overflowX = style.overflowX;

      const canScrollY = (overflowY === 'auto' || overflowY === 'scroll') && el.scrollHeight > el.clientHeight;
      const canScrollX = (overflowX === 'auto' || overflowX === 'scroll') && el.scrollWidth > el.clientWidth;

      if (canScrollY || canScrollX) {
        const isScrollingDown = event.deltaY > 0;
        const isScrollingUp = event.deltaY < 0;
        const isScrollingRight = event.deltaX > 0;
        const isScrollingLeft = event.deltaX < 0;

        const atBottom = el.scrollHeight - el.scrollTop <= el.clientHeight + 1;
        const atTop = el.scrollTop <= 0;
        const atRight = el.scrollWidth - el.scrollLeft <= el.clientWidth + 1;
        const atLeft = el.scrollLeft <= 0;

        let allowed = false;

        if (canScrollY && event.deltaY !== 0) {
          if ((isScrollingDown && !atBottom) || (isScrollingUp && !atTop)) {
            allowed = true;
          }
        }
        
        if (canScrollX && event.deltaX !== 0) {
          if ((isScrollingRight && !atRight) || (isScrollingLeft && !atLeft)) {
            allowed = true;
          }
        }

        if (allowed) {
           return true;
        }
      }
      el = el.parentElement;
    }
    return false;
  }

  // Button actions
  public handleZoomIn() {
    if (!this.workspaceElement) return;
    const rect = this.workspaceElement.getBoundingClientRect();
    this.zoomAtScreenPoint(rect.width / 2, rect.height / 2, this.viewport.zoom + 0.1);
  }

  public handleZoomOut() {
    if (!this.workspaceElement) return;
    const rect = this.workspaceElement.getBoundingClientRect();
    this.zoomAtScreenPoint(rect.width / 2, rect.height / 2, this.viewport.zoom - 0.1);
  }

  public fitView(nodes: { x: number; y: number; width?: number; height?: number }[]) {
    if (!this.workspaceElement || nodes.length === 0) return;

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (const node of nodes) {
      if (node.x < minX) minX = node.x;
      if (node.y < minY) minY = node.y;
      if (node.x + (node.width || 300) > maxX) maxX = node.x + (node.width || 300);
      if (node.y + (node.height || 200) > maxY) maxY = node.y + (node.height || 200);
    }

    const contentWidth = maxX - minX;
    const contentHeight = maxY - minY;
    
    // Add 18% padding
    const paddedContentWidth = contentWidth * 1.36;
    const paddedContentHeight = contentHeight * 1.36;

    const rect = this.workspaceElement.getBoundingClientRect();
    
    const zoomX = rect.width / paddedContentWidth;
    const zoomY = rect.height / paddedContentHeight;

    const newZoom = clamp(Math.min(zoomX, zoomY), MIN_ZOOM, 1);

    this.viewport.zoom = newZoom;
    
    // Center bounding box
    const contentCenterX = minX + contentWidth / 2;
    const contentCenterY = minY + contentHeight / 2;

    this.viewport.panX = rect.width / 2 - contentCenterX * newZoom;
    this.viewport.panY = rect.height / 2 - contentCenterY * newZoom;

    this.scheduleViewportUpdate();
    this.syncPersistentState(true); // Sync immediately for fitView
  }
}

export const viewportManager = new CanvasViewportManager();
