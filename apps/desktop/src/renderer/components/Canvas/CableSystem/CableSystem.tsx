import React, { useEffect, useRef } from 'react';
import { useReactFlow, useStoreApi } from '@xyflow/react';
import { viewportManager } from '../CanvasViewport';
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
  const storeNodes = useWorkspaceStore(s => s.nodes);
  const storeEdges = useWorkspaceStore(s => s.edges);
  const flow = useReactFlow();
  
  const svgRef = useRef<SVGSVGElement>(null);
  const simsRef = useRef<Map<string, CableSimulation>>(new Map());
  const tempSimRef = useRef<CableSimulation | null>(null);
  
  const store = useStoreApi();

  useEffect(() => {
    let animationFrameId: number;

    const renderRopes = (time: number) => {
      if (!svgRef.current) return;
      
      const svg = svgRef.current;
      const nodes = useWorkspaceStore.getState().nodes;
      const edges = useWorkspaceStore.getState().edges;
      
      const obstacles = nodes.map(n => ({
        id: n.id,
        x: n.x,
        y: n.y,
        width: n.width || 300,
        height: n.height || 200,
      }));
      
      const vp = viewportManager.viewport;
      const transformGroup = svg.querySelector('#cable-transform-group');
      if (transformGroup) {
        transformGroup.setAttribute('transform', `translate(${vp.panX}, ${vp.panY}) scale(${vp.zoom})`);
      }

      // Render regular connections
      const currentEdges = new Set<string>();
      
      edges.forEach(edge => {
        currentEdges.add(edge.id);
        const source = obstacles.find(n => n.id === edge.source);
        const target = obstacles.find(n => n.id === edge.target);
        
        if (!source || !target) return;
        
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
          hit.addEventListener('click', (e) => {
            e.stopPropagation();
            onEdgeClick(edge.id);
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
        if (!currentEdges.has(id)) {
          simsRef.current.delete(id);
          const g = svg.querySelector(`#cable-g-${id}`);
          if (g) g.remove();
        }
      }

      // Render temporary connection if connecting
      if (connectMode && connectionSourceId && connectionPointer) {
        const source = obstacles.find(n => n.id === connectionSourceId);
        if (source) {
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
            endAnchor = flow.screenToFlowPosition(connectionPointer);
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
      } else {
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
  }, [flow, connectMode, connectionSourceId, connectionPointer, connectionHoverId, selectedEdgeId, onEdgeClick]);

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
        <defs>
          <mask id="nodes-mask">
            <rect x="-10000" y="-10000" width="20000" height="20000" fill="white" />
            {storeNodes.map(n => (
              <rect key={n.id} x={n.x} y={n.y} width={n.width || 300} height={n.height || 200} rx="12" fill="black" />
            ))}
          </mask>
        </defs>
        <g id="cable-transform-group">
          <g id="cable-container" mask="url(#nodes-mask)">
            {/* Dynamically populated by RAF */}
          </g>
        </g>
      </svg>
    </div>
  );
};
