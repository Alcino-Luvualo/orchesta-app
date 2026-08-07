import React, { useEffect, useRef, useState } from 'react'
import { Handle, Position, NodeResizer } from '@xyflow/react'
import { ArrowLeft, ArrowRight, MoreVertical, RefreshCw, Search, SquareArrowOutUpRight, X } from 'lucide-react'
import { CanvasComponentData, useWorkspaceStore } from '../../store/workspaceStore'
import { getPortalGeometry, PortalBounds, PortalGeometry } from '../../../shared/browserPortalGeometry'

type PortalMotionOptions = { generation?: number; scale?: number; revision?: number }

const hiddenPortalBounds: PortalBounds = { x: 0, y: 0, width: 1, height: 1 }

/**
 * Browser portals are native WebContentsViews. They are composited above the
 * renderer and therefore cannot follow a CSS transform or be clipped by the
 * ReactFlow node automatically. This component owns the small bridge that
 * keeps the native view safe while the canvas moves and gives the DOM a
 * snapshot fallback whenever the view cannot be shown faithfully.
 */
export const BrowserNode: React.FC<{ id: string; data: CanvasComponentData }> = ({ id, data }) => {
  const props = data.properties || {}
  // Navigation is emitted by the native portal asynchronously. Always merge
  // that live URL into the latest node properties; the effect below is
  // intentionally keyed only by portal identity so a URL event cannot remount
  // the view and reset the user's page.
  const propsRef = useRef(props)
  propsRef.current = props
  const portalId = String(props.portalId || id)
  const initialUrl = String(props.url || 'about:blank')
  const [address, setAddress] = useState(initialUrl)
  const [currentUrl, setCurrentUrl] = useState(initialUrl)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [canGoBack, setCanGoBack] = useState(false)
  const [canGoForward, setCanGoForward] = useState(false)
  const [snapshot, setSnapshot] = useState<string | null>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const motionRef = useRef(false)
  const motionReasonsRef = useRef<Set<string>>(new Set())
  const motionWatchdogsRef = useRef<Map<string, number>>(new Map())
  const disposedRef = useRef(false)
  const frozenRef = useRef(false)
  const freezeInFlightRef = useRef<Promise<{ portalId?: string; data?: string; url?: string; stale?: boolean; generation?: number; revision?: number }> | null>(null)
  const frozenGenerationRef = useRef(0)
  const motionGenerationRef = useRef(0)
  const portalRevisionRef = useRef(0)
  const boundsRafRef = useRef<number | null>(null)
  const settleRafRef = useRef<number | null>(null)
  const lastBoundsKeyRef = useRef('')
  const lastGeometryRef = useRef<PortalGeometry | null>(null)
  const { updateNode, deleteNode, setSelectedNodeId, commitHistory } = useWorkspaceStore()

  useEffect(() => {
    updateNode(id, { properties: { ...propsRef.current, portalId } })
    const portal = window.orchestra?.portal
    if (!portal) return

    disposedRef.current = false
    let disposed = false

    const getViewport = () => {
      // getBoundingClientRect() is relative to the renderer's content
      // viewport, which is also the coordinate space of contentView children.
      // Do not use screen coordinates or BrowserWindow outer bounds here.
      const documentWidth = typeof document !== 'undefined' ? document.documentElement?.clientWidth || 0 : 0
      const documentHeight = typeof document !== 'undefined' ? document.documentElement?.clientHeight || 0 : 0
      const width = Math.max(1, Math.floor(documentWidth || window.innerWidth || 1))
      const height = Math.max(1, Math.floor(documentHeight || window.innerHeight || 1))
      return { left: 0, top: 0, width, height }
    }

    const readGeometry = (): PortalGeometry => {
      const element = contentRef.current
      if (!element) {
        const fallback = getPortalGeometry(
          { left: 0, top: 0, right: 0, bottom: 0 },
          getViewport(),
          1,
          1
        )
        fallback.bounds = hiddenPortalBounds
        fallback.visible = false
        lastGeometryRef.current = fallback
        return fallback
      }
      const rect = element.getBoundingClientRect()
      const geometry = getPortalGeometry(
        { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
        getViewport(),
        element.offsetWidth || element.clientWidth || rect.width,
        element.offsetHeight || element.clientHeight || rect.height
      )
      lastGeometryRef.current = geometry
      return geometry
    }

    const currentGeneration = () => motionGenerationRef.current

    const sendBounds = (geometry: PortalGeometry, visible: boolean, generation = currentGeneration()) => {
      if (disposed || disposedRef.current) return
      const bounds = geometry.bounds || hiddenPortalBounds
      const safeVisible = Boolean(visible && geometry.visible)
      const key = [
        generation,
        safeVisible ? 1 : 0,
        bounds.x,
        bounds.y,
        bounds.width,
        bounds.height,
        geometry.scale.toFixed(4)
      ].join(':')
      if (lastBoundsKeyRef.current === key) return
      lastBoundsKeyRef.current = key
      const revision = ++portalRevisionRef.current
      void portal.setBounds(portalId, bounds, safeVisible, {
        generation,
        scale: geometry.scale,
        revision
      }).then((result) => {
        if (!result || typeof result !== 'object') return
        const response = result as { stale?: unknown; generation?: unknown; revision?: unknown }
        if (typeof response.generation === 'number' && Number.isFinite(response.generation)) {
          motionGenerationRef.current = Math.max(motionGenerationRef.current, Math.floor(response.generation))
        }
        if (typeof response.revision === 'number' && Number.isFinite(response.revision)) {
          portalRevisionRef.current = Math.max(portalRevisionRef.current, Math.floor(response.revision))
        }
        if (response.stale === true) {
          // An older renderer remount or control client may have advanced the
          // main-side revision. Retry from the adopted token instead of
          // leaving this portal permanently hidden.
          lastBoundsKeyRef.current = ''
          if (!disposed && !disposedRef.current && !motionRef.current && !frozenRef.current && !freezeInFlightRef.current) {
            scheduleBoundsSync()
          }
        }
      }).catch(() => undefined)
    }

    const hideNative = (generation = currentGeneration()) => {
      const geometry = lastGeometryRef.current || readGeometry()
      sendBounds(geometry, false, generation)
    }

    const scheduleBoundsSync = () => {
      if (disposed || disposedRef.current || motionRef.current || frozenRef.current || freezeInFlightRef.current) return
      if (boundsRafRef.current !== null) return
      boundsRafRef.current = window.requestAnimationFrame(() => {
        boundsRafRef.current = null
        if (disposed || disposedRef.current || motionRef.current || frozenRef.current || freezeInFlightRef.current) return
        const geometry = readGeometry()
        // A partially clipped native view is never visible. The intersection
        // is still sent so the main process cannot retain an oversized stale
        // rectangle, but the DOM placeholder/snapshot remains on top.
        sendBounds(geometry, true)
      })
    }

    const nextAnimationFrame = () => new Promise<void>((resolve) => {
      window.requestAnimationFrame(() => resolve())
    })

    const startFreeze = (generation: number) => {
      if (disposed || disposedRef.current || !motionRef.current || frozenRef.current || freezeInFlightRef.current) return
      const revision = ++portalRevisionRef.current
      const request = portal.freeze(portalId, { generation, revision })
      freezeInFlightRef.current = request
      let staleFreeze = false
      request.then((result) => {
        if (typeof result?.generation === 'number' && Number.isFinite(result.generation)) {
          // An external control request can advance the main-side token while
          // this capture is in flight. Adopt it so the next freeze/resume is
          // not permanently rejected as stale after a portal remount.
          motionGenerationRef.current = Math.max(motionGenerationRef.current, Math.floor(result.generation))
        }
        if (typeof result?.revision === 'number' && Number.isFinite(result.revision)) {
          portalRevisionRef.current = Math.max(portalRevisionRef.current, Math.floor(result.revision))
        }
      if (disposed || disposedRef.current || !motionRef.current) return
        staleFreeze = result?.stale === true
        if (result && typeof result.data === 'string' && result.data.length > 0 && !staleFreeze) {
          setSnapshot(result.data)
          frozenRef.current = true
          frozenGenerationRef.current = generation
          return
        }
        // The main process may have rejected this request because an older
        // resume won the race. Retry once with the currently active token.
      }).catch(() => {
        // Keep the placeholder visible if capture fails; never reveal the
        // native page during motion without a current, safe bounds update.
      }).finally(() => {
        if (freezeInFlightRef.current === request) freezeInFlightRef.current = null
        if (motionRef.current && !frozenRef.current && (generation !== currentGeneration() || staleFreeze)) {
          window.requestAnimationFrame(() => startFreeze(currentGeneration()))
        }
      })
    }

    const scheduleResume = (generation: number) => {
      if (settleRafRef.current !== null) window.cancelAnimationFrame(settleRafRef.current)
      // Two frames let ReactFlow finish the transform/layout commit before a
      // native view is shown. This avoids the one-frame detached duplicate.
      settleRafRef.current = window.requestAnimationFrame(() => {
        settleRafRef.current = window.requestAnimationFrame(async () => {
          settleRafRef.current = null
          const inFlight = freezeInFlightRef.current
          if (inFlight) await inFlight.catch(() => undefined)
          await nextAnimationFrame()
          if (disposed || disposedRef.current || motionRef.current || generation !== currentGeneration()) return

          const geometry = readGeometry()
          if (!geometry.visible) {
            sendBounds(geometry, false, generation)
            frozenRef.current = false
            setSnapshot(null)
            return
          }

          // A resume is tied to the same generation that ended the motion.
          // The main process ignores it if a newer motion has already begun.
          let resumeResult: unknown
          try {
            resumeResult = await portal.resume(portalId, geometry.bounds, {
              generation,
              scale: geometry.scale,
              revision: ++portalRevisionRef.current
            })
          } catch {
            return
          }
          if (resumeResult && typeof resumeResult === 'object') {
            const response = resumeResult as { stale?: unknown; generation?: unknown; revision?: unknown }
            if (typeof response.generation === 'number' && Number.isFinite(response.generation)) {
              motionGenerationRef.current = Math.max(motionGenerationRef.current, Math.floor(response.generation))
            }
            if (typeof response.revision === 'number' && Number.isFinite(response.revision)) {
              portalRevisionRef.current = Math.max(portalRevisionRef.current, Math.floor(response.revision))
            }
            if (response.stale === true) {
              lastBoundsKeyRef.current = ''
              if (!disposed && !disposedRef.current && !motionRef.current) scheduleResume(currentGeneration())
              return
            }
          }
          if (disposed || disposedRef.current || motionRef.current || generation !== currentGeneration()) {
            hideNative(currentGeneration())
            return
          }
          frozenRef.current = false
          frozenGenerationRef.current = 0
          setSnapshot(null)
          lastBoundsKeyRef.current = ''
          scheduleBoundsSync()
        })
      })
    }

    const setMotion = (active: boolean) => {
      if (active) {
        if (!motionRef.current) {
          motionRef.current = true
          motionGenerationRef.current += 1
          // Freeze first so the main process captures the current node-sized
          // surface, then hide it immediately. Reversing these IPC calls
          // captures the 1x1 safety bounds instead of a useful snapshot.
          startFreeze(currentGeneration())
          hideNative(currentGeneration())
        }
        return
      }

      if (!motionRef.current && !frozenRef.current && !freezeInFlightRef.current) return
      motionRef.current = false
      motionGenerationRef.current += 1
      scheduleResume(currentGeneration())
    }

    portal.ensure(portalId, initialUrl).then((result) => {
      if (disposed || disposedRef.current) return
      if (typeof result?.generation === 'number' && Number.isFinite(result.generation)) {
        // A portal record can survive a renderer/node remount. Continue from
        // the main-process token instead of replaying generation 1 forever.
        motionGenerationRef.current = Math.max(motionGenerationRef.current, Math.floor(result.generation))
      }
      if (typeof result?.revision === 'number' && Number.isFinite(result.revision)) {
        portalRevisionRef.current = Math.max(portalRevisionRef.current, Math.floor(result.revision))
      }
      if (result?.url) {
        setCurrentUrl(result.url)
        setAddress(result.url)
      }
      lastBoundsKeyRef.current = ''
      scheduleBoundsSync()
    }).catch((reason) => {
      if (!disposed && !disposedRef.current) setError(reason instanceof Error ? reason.message : 'Portal indisponível')
    })

    const onCanvasMotion = (event: Event) => {
      const detail = (event as CustomEvent<{ active?: boolean }>).detail
      const reason = String((detail as { reason?: unknown } | undefined)?.reason || 'canvas')
      const watchdogs = motionWatchdogsRef.current
      const clearWatchdog = () => {
        const timer = watchdogs.get(reason)
        if (timer !== undefined) window.clearTimeout(timer)
        watchdogs.delete(reason)
      }
      if (detail?.active) {
        motionReasonsRef.current.add(reason)
        // ReactFlow normally emits a matching move-end event. If a native
        // portal or an interrupted gesture steals that event, do not leave
        // every browser frozen forever; active move packets re-arm this lease.
        clearWatchdog()
        watchdogs.set(reason, window.setTimeout(() => {
          watchdogs.delete(reason)
          motionReasonsRef.current.delete(reason)
          setMotion(motionReasonsRef.current.size > 0)
        }, 900))
      } else {
        clearWatchdog()
        motionReasonsRef.current.delete(reason)
      }
      setMotion(motionReasonsRef.current.size > 0)
    }
    window.addEventListener('orchestra:canvas-motion', onCanvasMotion)

    const unsubscribe = window.orchestra?.onEvent((event) => {
      const payload = event.payload || {}
      if (payload.portalId !== portalId) return
      if (event.type === 'portal:navigation' && typeof payload.url === 'string') {
        setCurrentUrl(payload.url)
        setAddress(payload.url)
        setCanGoBack(Boolean(payload.canGoBack))
        setCanGoForward(Boolean(payload.canGoForward))
        updateNode(id, { properties: { ...propsRef.current, portalId, url: payload.url } })
      } else if (event.type === 'portal:loading') {
        setLoading(Boolean(payload.loading))
      } else if (event.type === 'portal:error') {
        setError(String(payload.errorDescription || payload.error || 'Falha ao carregar o portal'))
      }
    })

    const observer = typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(scheduleBoundsSync)
      : null
    if (contentRef.current) observer?.observe(contentRef.current)
    window.addEventListener('resize', scheduleBoundsSync)
    window.addEventListener('scroll', scheduleBoundsSync, true)
    const viewport = window.visualViewport
    viewport?.addEventListener('resize', scheduleBoundsSync)
    viewport?.addEventListener('scroll', scheduleBoundsSync)

    return () => {
      disposed = true
      disposedRef.current = true
      motionReasonsRef.current.clear()
      for (const timer of motionWatchdogsRef.current.values()) window.clearTimeout(timer)
      motionWatchdogsRef.current.clear()
      motionRef.current = false
      if (boundsRafRef.current !== null) window.cancelAnimationFrame(boundsRafRef.current)
      if (settleRafRef.current !== null) window.cancelAnimationFrame(settleRafRef.current)
      boundsRafRef.current = null
      settleRafRef.current = null
      observer?.disconnect()
      window.removeEventListener('resize', scheduleBoundsSync)
      window.removeEventListener('scroll', scheduleBoundsSync, true)
      viewport?.removeEventListener('resize', scheduleBoundsSync)
      viewport?.removeEventListener('scroll', scheduleBoundsSync)
      window.removeEventListener('orchestra:canvas-motion', onCanvasMotion)
      unsubscribe?.()
      // The generation is intentionally advanced before the cleanup request;
      // any in-flight resume from this node becomes stale in the main process.
      motionGenerationRef.current += 1
      void portal.setBounds(portalId, hiddenPortalBounds, false, {
        generation: currentGeneration(),
        scale: 1,
        revision: ++portalRevisionRef.current
      }).catch(() => undefined)
    }
  }, [id, portalId])

  const handleNavigate = (event?: React.FormEvent) => {
    event?.preventDefault()
    const value = address.trim()
    if (!value || !window.orchestra?.portal) return
    setError(null)
    window.orchestra.portal.navigate(portalId, value).catch((reason) => setError(reason instanceof Error ? reason.message : 'Falha ao navegar'))
  }

  const action = (name: 'back' | 'forward' | 'reload' | 'stop') => {
    window.orchestra?.portal?.action(portalId, name).catch(() => undefined)
  }

  return (
    <div
      className="node"
      data-kind="browser"
      style={{ width: '100%', height: '100%', minWidth: 300, minHeight: 200 }}
      onClick={() => setSelectedNodeId(id)}
    >
      <NodeResizer
        isVisible={data.selected}
        minWidth={300}
        minHeight={200}
        handleClassName="nodrag nopan canvas-resize-handle"
        lineClassName="nodrag nopan canvas-resize-line"
        onResizeStart={() => {
          commitHistory()
          window.dispatchEvent(new CustomEvent('orchestra:canvas-motion', { detail: { active: true, reason: 'resize' } }))
        }}
        onResize={(_, params) => {
          updateNode(id, { width: params.width, height: params.height })
          window.dispatchEvent(new CustomEvent('orchestra:canvas-motion', { detail: { active: true, reason: 'resize' } }))
        }}
        onResizeEnd={() => window.dispatchEvent(new CustomEvent('orchestra:canvas-motion', { detail: { active: false, reason: 'resize' } }))}
      />
      <Handle type="target" position={Position.Left} className="port left" />
      <Handle type="source" position={Position.Right} className="port right" />

      <div className="chrome-shell">
        <form className="chrome-toolbar" onSubmit={handleNavigate}>
          <span className="mac-dot red" /><span className="mac-dot yellow" /><span className="mac-dot green" />
          <span className="chrome-divider" />
          <button type="button" className="icon-btn chrome-nav" title="Voltar" disabled={!canGoBack} onClick={() => action('back')}><ArrowLeft className="icon" /></button>
          <button type="button" className="icon-btn chrome-nav" title="Avançar" disabled={!canGoForward} onClick={() => action('forward')}><ArrowRight className="icon" /></button>
          <button type="button" className="icon-btn chrome-nav" title={loading ? 'Parar' : 'Recarregar'} onClick={() => action(loading ? 'stop' : 'reload')}><RefreshCw className="icon" /></button>
          <div className="chrome-address">
            <Search className="icon" />
            <input type="text" value={address} onChange={(event) => setAddress(event.target.value)} placeholder="Pesquisar ou digitar URL..." />
          </div>
          <button type="button" className="icon-btn chrome-nav" title="Abrir no navegador do sistema" onClick={() => window.orchestra?.portal?.openExternal(portalId).catch(() => undefined)}><SquareArrowOutUpRight className="icon" /></button>
          <button type="button" className="icon-btn chrome-nav" title="Mais"><MoreVertical className="icon" /></button>
          <button type="button" className="icon-btn chrome-nav" onClick={(event) => { event.stopPropagation(); deleteNode(id); window.orchestra?.portal?.destroy(portalId).catch(() => undefined) }} title="Fechar portal"><X className="icon" /></button>
        </form>

        <div ref={contentRef} className="chrome-content nodrag nowheel" onMouseDown={(event) => event.stopPropagation()}>
          {snapshot ? <img className="portal-snapshot" src={snapshot} alt="Pré-visualização do portal durante o movimento" /> : <div className="portal-placeholder">
            {error ? <><b>Portal com erro</b><span>{error}</span></> : <><span>{currentUrl}</span><small>{loading ? 'A carregar…' : 'Portal Chromium isolado'}</small></>}
          </div>}
        </div>
      </div>
    </div>
  )
}
