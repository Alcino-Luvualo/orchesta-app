import React, { useMemo, useRef, useState } from 'react'
import { ArrowUpRight, Circle, Copy, Highlighter, Pen, Redo2, Square, Trash2, Type, Undo2, X } from 'lucide-react'

type Point = { x: number; y: number }
type Tool = 'pen' | 'highlight' | 'rect' | 'ellipse' | 'arrow' | 'text'
type Mark = {
  id: string
  tool: Tool
  color: string
  width: number
  points: Point[]
  text?: string
}

type BrowserMarkupOverlayProps = {
  screenshot: string
  pageTitle: string
  onClose: () => void
  onCopy: (dataUrl: string) => Promise<unknown>
}

const TOOLS: Array<{ id: Tool; label: string; icon: React.ComponentType<{ className?: string }> }> = [
  { id: 'pen', label: 'Caneta', icon: Pen },
  { id: 'highlight', label: 'Marcador', icon: Highlighter },
  { id: 'arrow', label: 'Seta', icon: ArrowUpRight },
  { id: 'rect', label: 'Retângulo', icon: Square },
  { id: 'ellipse', label: 'Elipse', icon: Circle },
  { id: 'text', label: 'Texto', icon: Type },
]

function pathFor(points: Point[]): string {
  if (!points.length) return ''
  return points.reduce((path, point, index) => `${path}${index === 0 ? 'M' : ' L'} ${point.x} ${point.y}`, '')
}

function arrowHead(start: Point, end: Point, size: number): string {
  const angle = Math.atan2(end.y - start.y, end.x - start.x)
  const left = { x: end.x - Math.cos(angle - Math.PI / 6) * size, y: end.y - Math.sin(angle - Math.PI / 6) * size }
  const right = { x: end.x - Math.cos(angle + Math.PI / 6) * size, y: end.y - Math.sin(angle + Math.PI / 6) * size }
  return `${end.x},${end.y} ${left.x},${left.y} ${right.x},${right.y}`
}

export const BrowserMarkupOverlay: React.FC<BrowserMarkupOverlayProps> = ({ screenshot, pageTitle, onClose, onCopy }) => {
  const svgRef = useRef<SVGSVGElement>(null)
  const [tool, setTool] = useState<Tool>('pen')
  const [color, setColor] = useState('#ef4444')
  const [width, setWidth] = useState(4)
  const [textValue, setTextValue] = useState('Nota')
  const [size, setSize] = useState({ width: 1280, height: 720 })
  const [marks, setMarks] = useState<Mark[]>([])
  const [redo, setRedo] = useState<Mark[]>([])
  const [draft, setDraft] = useState<Mark | null>(null)
  const [copyState, setCopyState] = useState<'idle' | 'copying' | 'copied' | 'error'>('idle')

  const visibleMarks = useMemo(() => draft ? [...marks, draft] : marks, [draft, marks])
  const pointFromEvent = (event: React.PointerEvent<SVGSVGElement>): Point => {
    const rect = event.currentTarget.getBoundingClientRect()
    return {
      x: Math.max(0, Math.min(size.width, (event.clientX - rect.left) * size.width / Math.max(1, rect.width))),
      y: Math.max(0, Math.min(size.height, (event.clientY - rect.top) * size.height / Math.max(1, rect.height)))
    }
  }
  const start = (event: React.PointerEvent<SVGSVGElement>) => {
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    const point = pointFromEvent(event)
    const mark: Mark = { id: crypto.randomUUID(), tool, color, width, points: [point], text: tool === 'text' ? textValue.trim() || 'Nota' : undefined }
    if (tool === 'text') {
      setMarks((current) => [...current, mark])
      setRedo([])
      return
    }
    setDraft(mark)
  }
  const move = (event: React.PointerEvent<SVGSVGElement>) => {
    if (!draft || !event.currentTarget.hasPointerCapture(event.pointerId)) return
    const point = pointFromEvent(event)
    setDraft((current) => current ? { ...current, points: current.tool === 'pen' || current.tool === 'highlight' ? [...current.points, point] : [current.points[0], point] } : null)
  }
  const finish = (event: React.PointerEvent<SVGSVGElement>) => {
    if (!draft) return
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    const completed = draft.points.length === 1 ? { ...draft, points: [...draft.points, pointFromEvent(event)] } : draft
    setMarks((current) => [...current, completed])
    setDraft(null)
    setRedo([])
  }

  const renderMark = (mark: Mark) => {
    const startPoint = mark.points[0]
    const endPoint = mark.points[mark.points.length - 1] || startPoint
    if (!startPoint) return null
    if (mark.tool === 'pen' || mark.tool === 'highlight') return <path key={mark.id} d={pathFor(mark.points)} fill="none" stroke={mark.color} strokeWidth={mark.tool === 'highlight' ? mark.width * 5 : mark.width} strokeOpacity={mark.tool === 'highlight' ? .28 : 1} strokeLinecap="round" strokeLinejoin="round" />
    if (mark.tool === 'rect') return <rect key={mark.id} x={Math.min(startPoint.x, endPoint.x)} y={Math.min(startPoint.y, endPoint.y)} width={Math.abs(endPoint.x - startPoint.x)} height={Math.abs(endPoint.y - startPoint.y)} fill="transparent" stroke={mark.color} strokeWidth={mark.width} rx={4} />
    if (mark.tool === 'ellipse') return <ellipse key={mark.id} cx={(startPoint.x + endPoint.x) / 2} cy={(startPoint.y + endPoint.y) / 2} rx={Math.abs(endPoint.x - startPoint.x) / 2} ry={Math.abs(endPoint.y - startPoint.y) / 2} fill="transparent" stroke={mark.color} strokeWidth={mark.width} />
    if (mark.tool === 'arrow') return <g key={mark.id} fill={mark.color} stroke={mark.color} strokeWidth={mark.width} strokeLinecap="round"><line x1={startPoint.x} y1={startPoint.y} x2={endPoint.x} y2={endPoint.y} /><polygon points={arrowHead(startPoint, endPoint, Math.max(12, mark.width * 4))} stroke="none" /></g>
    return <text key={mark.id} x={startPoint.x} y={startPoint.y} fill={mark.color} fontSize={Math.max(16, mark.width * 5)} fontWeight="700" fontFamily="ui-sans-serif, system-ui" paintOrder="stroke" stroke="white" strokeWidth={Math.max(2, mark.width / 2)}>{mark.text}</text>
  }

  const copyMarkup = async () => {
    const svg = svgRef.current
    if (!svg) return
    setCopyState('copying')
    try {
      const base = new Image()
      base.src = screenshot
      await base.decode()
      const overlay = svg.cloneNode(true) as SVGSVGElement
      overlay.querySelectorAll('[data-interaction-layer]').forEach((node) => node.remove())
      overlay.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
      overlay.setAttribute('width', String(size.width))
      overlay.setAttribute('height', String(size.height))
      const blobUrl = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(overlay)], { type: 'image/svg+xml' }))
      try {
        const drawing = new Image()
        drawing.src = blobUrl
        await drawing.decode()
        const canvas = document.createElement('canvas')
        canvas.width = size.width
        canvas.height = size.height
        const context = canvas.getContext('2d')
        if (!context) throw new Error('Canvas indisponível')
        context.drawImage(base, 0, 0, size.width, size.height)
        context.drawImage(drawing, 0, 0, size.width, size.height)
        await onCopy(canvas.toDataURL('image/png'))
      } finally {
        URL.revokeObjectURL(blobUrl)
      }
      setCopyState('copied')
      window.setTimeout(() => setCopyState('idle'), 1800)
    } catch {
      setCopyState('error')
    }
  }

  return <div className="browser-markup-layer nodrag nopan nowheel" onPointerDown={(event) => event.stopPropagation()}>
    <div className="browser-markup-toolbar">
      <strong>Anotar screenshot</strong>
      <div className="browser-markup-tools" role="toolbar" aria-label="Ferramentas de anotação">
        {TOOLS.map((item) => <button type="button" key={item.id} className={tool === item.id ? 'active' : ''} title={item.label} aria-label={item.label} onClick={() => setTool(item.id)}><item.icon className="icon" /></button>)}
      </div>
      <label className="browser-markup-color" title="Cor"><input type="color" value={color} onChange={(event) => setColor(event.target.value)} /></label>
      <label className="browser-markup-width" title="Espessura"><input type="range" min="2" max="12" value={width} onChange={(event) => setWidth(Number(event.target.value))} /><span>{width}px</span></label>
      {tool === 'text' && <input className="browser-markup-text" value={textValue} maxLength={80} onChange={(event) => setTextValue(event.target.value)} aria-label="Texto da anotação" />}
      <button type="button" title="Desfazer" aria-label="Desfazer" disabled={!marks.length} onClick={() => setMarks((current) => { const last = current[current.length - 1]; if (last) setRedo((items) => [...items, last]); return current.slice(0, -1) })}><Undo2 className="icon" /></button>
      <button type="button" title="Refazer" aria-label="Refazer" disabled={!redo.length} onClick={() => setRedo((current) => { const last = current[current.length - 1]; if (last) setMarks((items) => [...items, last]); return current.slice(0, -1) })}><Redo2 className="icon" /></button>
      <button type="button" title="Limpar" aria-label="Limpar" disabled={!marks.length} onClick={() => { setMarks([]); setRedo([]) }}><Trash2 className="icon" /></button>
      <button type="button" className="browser-markup-copy" disabled={copyState === 'copying'} onClick={() => void copyMarkup()}><Copy className="icon" />{copyState === 'copying' ? 'A copiar…' : copyState === 'copied' ? 'Copiado' : copyState === 'error' ? 'Tentar novamente' : 'Copiar imagem'}</button>
      <button type="button" title="Fechar" aria-label="Fechar anotação" onClick={onClose}><X className="icon" /></button>
    </div>
    <div className="browser-markup-stage">
      <img src={screenshot} alt={`Screenshot de ${pageTitle}`} onLoad={(event) => setSize({ width: event.currentTarget.naturalWidth || 1280, height: event.currentTarget.naturalHeight || 720 })} />
      <svg ref={svgRef} viewBox={`0 0 ${size.width} ${size.height}`} preserveAspectRatio="none" onPointerDown={start} onPointerMove={move} onPointerUp={finish} onPointerCancel={finish}>
        {visibleMarks.map(renderMark)}
        <rect data-interaction-layer x="0" y="0" width={size.width} height={size.height} fill="transparent" />
      </svg>
    </div>
  </div>
}
