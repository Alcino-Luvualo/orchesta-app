import React, { useEffect, useRef } from 'react';
import { useWorkspaceStore } from '../../../store/workspaceStore';
import { NodeRect, pairedAnchors, getAnchorOnRect, Point } from './AnchorResolver';
import { routeCable } from './CableRouter';
import { CableSimulation } from './CableSimulation';

export const CableSystem: React.FC<{
  connectMode: boolean;
  connectionSourceId: string | null;
  connectionPointer: Point | null;
  connectionHoverId: string | null;
  selectedEdgeId: string | null;
  onEdgeClick: (id: string) => void;
}> = ({ connectMode, connectionSourceId, connectionPointer, connectionHoverId, selectedEdgeId, onEdgeClick }) => {
  const svgRef = useRef<SVGSVGElement>(null);
  const simsRef = useRef<Map<string, CableSimulation>>(new Map());
  const tempSimRef = useRef<CableSimulation | null>(null);
  // Store the callback in a ref so the RAF loop does not need to be torn down
  // and recreated every time CanvasArea re-renders (which happens at 60fps
  // during a drag), because that causes cables to blink on every frame.
  const onEdgeClickRef = useRef(onEdgeClick);
  onEdgeClickRef.current = onEdgeClick;
  // Count consecutive frames where a node's DOM element is missing. A brief
  // absence during React reconciliation is normal; only remove the cable after
  // several consecutive misses so cables don't flash during a drag.
  const missingNodeFramesRef = useRef<Map<string, number>>(new Map());

  const readRenderedObstacles = (svg: SVGSVGElement, svgRect: DOMRect): NodeRect[] => {
    const persistedNodes = useWorkspaceStore.getState().nodes
    const renderableNodeIds = new Set(persistedNodes
      .filter((node) => !['device', 'routine'].includes(String(node.kind)))
      .map((node) => node.id))
    const flowRoot = svg.closest('.react-flow')
    const domNodesById = new Map(Array.from(flowRoot?.querySelectorAll<HTMLElement>('.react-flow__node') || [])
      .map((element) => [element.dataset.id || '', element]))

    return persistedNodes.flatMap((node) => {
      if (!renderableNodeIds.has(node.id)) return []
      // This layer is outside React Flow's transformed viewport. Reading the
      // rendered rectangle keeps cables in the same screen coordinate space as
      // the card during pan, zoom, drag and resize. A persisted coordinate is
      // deliberately not a fallback: if React Flow did not render the card,
      // drawing its cable would leave a floating endpoint on the canvas.
      const domNode = domNodesById.get(node.id)
      if (!domNode || !domNode.isConnected) return []
      const style = window.getComputedStyle(domNode)
      if (style.display === 'none' || style.visibility === 'hidden') return []
      const rect = domNode?.getBoundingClientRect()
      if (rect && rect.width > 0 && rect.height > 0) {
        return [{
          id: node.id,
          x: rect.left - svgRect.left,
          y: rect.top - svgRect.top,
          width: rect.width,
          height: rect.height,
        }]
      }
      return []
    })
  }

  useEffect(() => {
    let animationFrameId: number;

    const renderRopes = (time: number) => {
      if (!svgRef.current) return;
      
      const svg = svgRef.current;
      const edges = useWorkspaceStore.getState().edges;
      const svgRect = svg.getBoundingClientRect();
      const obstacles = readRenderedObstacles(svg, svgRect);

      // Render regular connections
      const renderedEdges = new Set<string>();
      
      edges.forEach(edge => {
        const source = obstacles.find(n => n.id === edge.source);
        const target = obstacles.find(n => n.id === edge.target);
        
        if (!source || !target) {
          // An edge can remain persisted while a legacy/filtered node is not
          // rendered, or during a brief React Flow reconciliation frame. Count
          // consecutive misses: a single absent frame during drag or React
          // reconciliation is normal — only destroy the cable after 8 frames
          // (~133ms) of continuous absence so cables don't blink during drags.
          const prev = missingNodeFramesRef.current.get(edge.id) ?? 0;
          const next = prev + 1;
          missingNodeFramesRef.current.set(edge.id, next);
          if (next >= 8) {
            simsRef.current.delete(edge.id);
            missingNodeFramesRef.current.delete(edge.id);
            svg.querySelector(`#cable-g-${edge.id}`)?.remove();
          }
          return;
        }
        // Node found — reset the missing-frame counter.
        missingNodeFramesRef.current.delete(edge.id);
        renderedEdges.add(edge.id);
        
        const { start, end, leadStart, leadEnd } = pairedAnchors(source, target);
        const route = routeCable(start, leadStart, leadEnd, end, obstacles.filter(o => o.id !== source.id && o.id !== target.id));
        
        let sim = simsRef.current.get(edge.id);
        if (!sim) {
          sim = new CableSimulation();
          sim.init(route);
          simsRef.current.set(edge.id, sim);
        }
        
        const isActive = true; // For now
        sim.simulate(obstacles, route, start, leadStart, leadEnd, end, isActive);
        
        const pathData = sim.generateSmoothPath();
        
        // Update DOM
        const gId = `cable-g-${edge.id}`;
        const container = svg.querySelector('#cable-container');
        if (!container) return;
        
        let g = container.querySelector(`#${gId}`);
        if (!g) {
          g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
          g.id = gId;
          
          const shadow = document.createElementNS('http://www.w3.org/2000/svg', 'path');
          shadow.setAttribute('class', 'rope-shadow');
          
          const hit = document.createElementNS('http://www.w3.org/2000/svg', 'path');
          hit.setAttribute('class', 'wire-hit');
          hit.style.pointerEvents = 'stroke';
          hit.style.cursor = 'pointer';
          // Use the ref so this listener always calls the latest handler without
          // requiring the effect to be recreated (which would blink the cable).
          const edgeId = edge.id;
          hit.addEventListener('click', (e) => {
            e.stopPropagation();
            onEdgeClickRef.current(edgeId);
          });
          
          const wire = document.createElementNS('http://www.w3.org/2000/svg', 'path');
          wire.setAttribute('class', 'wire');
          
          const anchorA = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
          anchorA.setAttribute('class', 'rope-anchor');
          anchorA.setAttribute('r', '4');
          
          const anchorB = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
          anchorB.setAttribute('class', 'rope-anchor');
          anchorB.setAttribute('r', '4');
          
          g.appendChild(shadow);
          g.appendChild(hit);
          g.appendChild(wire);
          g.appendChild(anchorA);
          g.appendChild(anchorB);
          
          container.appendChild(g);
        }
        
        // Offset for the SVG layer (-2000, -2000) -> so we need to add 2000 to coords, 
        // OR we can just use SVG viewBox / transform to handle it!
        // Actually, if SVG is absolute and left -2000, we can just translate the G.
        
        const shadow = g.children[0] as SVGPathElement;
        const hit = g.children[1] as SVGPathElement;
        const wire = g.children[2] as SVGPathElement;
        const anchorA = g.children[3] as SVGCircleElement;
        const anchorB = g.children[4] as SVGCircleElement;
        
        shadow.setAttribute('d', pathData);
        hit.setAttribute('d', pathData);
        wire.setAttribute('d', pathData);
        
        if (selectedEdgeId === edge.id) {
          wire.classList.add('selected');
        } else {
          wire.classList.remove('selected');
        }
        
        anchorA.setAttribute('cx', start.x.toString());
        anchorA.setAttribute('cy', start.y.toString());
        anchorB.setAttribute('cx', end.x.toString());
        anchorB.setAttribute('cy', end.y.toString());
      });
      
      // Cleanup old edges
      for (const [id, sim] of simsRef.current.entries()) {
        if (!renderedEdges.has(id)) {
          simsRef.current.delete(id);
          const g = svg.querySelector(`#cable-g-${id}`);
          if (g) g.remove();
        }
      }

      // Render temporary connection if connecting
      let temporaryCableRendered = false;
      if (connectMode && connectionSourceId && connectionPointer) {
        const source = obstacles.find(n => n.id === connectionSourceId);
        if (source) {
          temporaryCableRendered = true;
          let endPoint = connectionPointer;
          let targetObs = obstacles.find(n => n.id === connectionHoverId);
          
          let endAnchor: Point;
          let bEdge = 'left';
          
          if (targetObs) {
            const res = getAnchorOnRect(targetObs, { x: source.x + source.width/2, y: source.y + source.height/2 });
            endAnchor = res.anchor;
            bEdge = res.edge;
          } else {
            // flowToScreen / screenToFlow: connectionPointer is in SCREEN space or FLOW space?
            // In CanvasArea, connectionPointer is screen space. We need to convert to flow space.
            endAnchor = {
              x: connectionPointer.x - svgRect.left,
              y: connectionPointer.y - svgRect.top,
            };
          }

          const aRes = getAnchorOnRect(source, endAnchor);
          const start = aRes.anchor;
          
          const getLead = (anchor: Point, edge: string, size: number) => {
            switch (edge) {
              case 'left': return { x: anchor.x - size, y: anchor.y };
              case 'right': return { x: anchor.x + size, y: anchor.y };
              case 'top': return { x: anchor.x, y: anchor.y - size };
              case 'bottom': return { x: anchor.x, y: anchor.y + size };
              default: return anchor;
            }
          };

          const leadSize = 9;
          const leadStart = getLead(start, aRes.edge, leadSize);
          const leadEnd = targetObs ? getLead(endAnchor, bEdge, leadSize) : endAnchor;

          const route = [start, leadStart, leadEnd, endAnchor];
          let sim = tempSimRef.current;
          if (!sim) {
            sim = new CableSimulation();
            sim.init(route, true);
            tempSimRef.current = sim;
          }
          
          sim.simulate(obstacles, route, start, leadStart, leadEnd, endAnchor, true);
          const pathData = sim.generateSmoothPath();
          
          const gId = `cable-g-temp`;
          const container = svg.querySelector('#cable-container');
          if (!container) return;
          
          let g = container.querySelector(`#${gId}`);
          if (!g) {
            g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
            g.id = gId;
            const shadow = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            shadow.setAttribute('class', 'rope-shadow');
            const wire = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            wire.setAttribute('class', 'wire pending-wire');
            
            const anchorA = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
            anchorA.setAttribute('class', 'rope-anchor');
            anchorA.setAttribute('r', '4');
            const anchorB = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
            anchorB.setAttribute('class', 'rope-anchor');
            anchorB.setAttribute('r', '4');
            
            g.appendChild(shadow);
            g.appendChild(wire);
            g.appendChild(anchorA);
            g.appendChild(anchorB);
            container.appendChild(g);
          }
          
          const shadow = g.children[0] as SVGPathElement;
          const wire = g.children[1] as SVGPathElement;
          const anchorA = g.children[2] as SVGCircleElement;
          const anchorB = g.children[3] as SVGCircleElement;
          
          shadow.setAttribute('d', pathData);
          wire.setAttribute('d', pathData);
          anchorA.setAttribute('cx', start.x.toString());
          anchorA.setAttribute('cy', start.y.toString());
          anchorB.setAttribute('cx', endAnchor.x.toString());
          anchorB.setAttribute('cy', endAnchor.y.toString());
        }
      }
      if (!temporaryCableRendered) {
        if (tempSimRef.current) {
          tempSimRef.current = null;
          const g = svg.querySelector(`#cable-g-temp`);
          if (g) g.remove();
        }
      }

      animationFrameId = requestAnimationFrame(renderRopes);
    };

    animationFrameId = requestAnimationFrame(renderRopes);

    return () => {
      cancelAnimationFrame(animationFrameId);
    };
  }, [connectMode, connectionSourceId, connectionPointer, connectionHoverId, selectedEdgeId]);

  return (
    <div style={{
      position: 'absolute',
      left: 0,
      top: 0,
      width: '100%',
      height: '100%',
      pointerEvents: 'none',
      zIndex: 1,
      overflow: 'visible'
    }}>
      <svg
        ref={svgRef}
        className="wire-layer"
        style={{
          width: '100%',
          height: '100%',
          overflow: 'visible',
          pointerEvents: 'none',
        }}
      >
        <g id="cable-transform-group">
          <g id="cable-container">
            {/* Dynamically populated by RAF in screen coordinates. */}
          </g>
        </g>
      </svg>
    </div>
  );
};
