import React, { useEffect, useRef, useState } from 'react'
import { Handle, Position, NodeResizer } from '@xyflow/react'
import { ArrowLeft, ArrowRight, Check, Copy, MousePointer2, PenTool, RefreshCw, Search, SquareArrowOutUpRight, X } from 'lucide-react'
import { CanvasComponentData, useWorkspaceStore } from '../../store/workspaceStore'
import { getPortalGeometry, PortalBounds, PortalGeometry, PortalViewport } from '../../../shared/browserPortalGeometry'
import { BrowserMarkupOverlay } from './BrowserMarkupOverlay'
import { AgentTargetMenu } from './AgentTargetMenu'
import { addContextToAgent } from './agentContext'

type PortalPresentationMode = 'creating' | 'live' | 'transitioning' | 'snapshot' | 'hidden'

type PortalPresentationUpdate = {
  instanceId?: string
  bounds: PortalBounds
  visible: boolean
  mode: PortalPresentationMode
  generation: number
  revision: number
  canvasScale: number
  logicalViewport: { width: number; height: number }
  zIndex?: number
  focused?: boolean
  interactive?: boolean
}

type PortalGrabResult = Awaited<ReturnType<NonNullable<NonNullable<Window['orchestra']>['portal']>['grab']>>

const hiddenPortalBounds: PortalBounds = { x: 0, y: 0, width: 1, height: 1 }

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object'
}

function asFinite(value: unknown, fallback: number): number {
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : fallback
}

function presentationData(value: unknown): string | null {
  if (!isRecord(value)) return null
  const data = typeof value.data === 'string' ? value.data : value.snapshot
  return typeof data === 'string' && data.length > 0 ? data : null
}

/**
 * Browser portals are native WebContentsViews. They are composited above the
 * renderer and therefore cannot follow a CSS transform or be clipped by the
 * ReactFlow node automatically. This component keeps a single, latest-only
 * presentation stream for the native view and a DOM snapshot fallback for
 * transitions/clipping, so a move/focus/resize never exposes a stale white
 * rectangle over the canvas.
 */
export const BrowserNode: React.FC<{ id: string; data: CanvasComponentData }> = ({ id, data }) => {
  const props = data.properties || {}
  const propsRef = useRef(props)
  propsRef.current = props
  const dataRef = useRef(data)
  dataRef.current = data
  const portalId = String(props.portalId || id)
  // Use the Google homepage for a useful first paint. Existing blank portal
  // records are upgraded too, so a new portal never starts as a black tab.
  const initialUrl = String(props.url && props.url !== 'about:blank' ? props.url : 'https://www.google.com')
  const [address, setAddress] = useState(initialUrl)
  const [currentUrl, setCurrentUrl] = useState(initialUrl)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [canGoBack, setCanGoBack] = useState(false)
  const [canGoForward, setCanGoForward] = useState(false)
  const [snapshot, setSnapshot] = useState<string | null>(null)
  const [presentation, setPresentation] = useState<PortalPresentationMode>('creating')
  const [markupScreenshot, setMarkupScreenshot] = useState<string | null>(null)
  const [grabResult, setGrabResult] = useState<PortalGrabResult>(null)
  const [isGrabbing, setIsGrabbing] = useState(false)
  const [toolStatus, setToolStatus] = useState('')
  const contentRef = useRef<HTMLDivElement>(null)
  const motionRef = useRef(false)
  const settlingRef = useRef(false)
  const motionReasonsRef = useRef<Set<string>>(new Set())
  const motionWatchdogsRef = useRef<Map<string, number>>(new Map())
  const settleTimerRef = useRef<number | null>(null)
  const disposedRef = useRef(false)
  const motionGenerationRef = useRef(0)
  const portalRevisionRef = useRef(0)
  const portalInstanceRef = useRef('')
  const boundsRafRef = useRef<number | null>(null)
  const lastBoundsKeyRef = useRef('')
  const snapshotRef = useRef<string | null>(null)
  const frozenScaleRef = useRef<number | null>(null)
  const refreshPresentationRef = useRef<() => void>(() => undefined)
  const overlayModeRef = useRef(false)
  const grabAttemptRef = useRef(0)
  const { updateNode, deleteNode, setSelectedNodeId, commitHistory } = useWorkspaceStore()

  const setSnapshotValue = (value: string | null) => {
    snapshotRef.current = value
    setSnapshot(value)
  }

  const setPresentationValue = (value: PortalPresentationMode) => {
    setPresentation(value)
  }

  useEffect(() => {
    updateNode(id, { properties: { ...propsRef.current, portalId } })
    const portal = window.orchestra?.portal
    if (!portal) return

    disposedRef.current = false
    let disposed = false
    let nextRequestId = 0
    let latestRequestId = 0
    let pendingUpdate: (PortalPresentationUpdate & { requestId: number }) | null = null
    let updateInFlight: Promise<unknown> | null = null
    let portalReady = false

    const getViewport = (): PortalViewport => {
      // Both getBoundingClientRect() and WebContentsView bounds are expressed
      // in logical content pixels. Never use outer window/screen coordinates.
      const documentWidth = typeof document !== 'undefined' ? document.documentElement?.clientWidth || 0 : 0
      const documentHeight = typeof document !== 'undefined' ? document.documentElement?.clientHeight || 0 : 0
      const width = Math.max(1, Math.floor(documentWidth || window.innerWidth || 1))
      const height = Math.max(1, Math.floor(documentHeight || window.innerHeight || 1))
      return { left: 0, top: 0, width, height }
    }

    const getLogicalViewport = () => {
      const element = contentRef.current
      return {
        width: Math.max(1, Math.floor(element?.offsetWidth || element?.clientWidth || 1)),
        height: Math.max(1, Math.floor(element?.offsetHeight || element?.clientHeight || 1))
      }
    }

    const readGeometry = (): PortalGeometry => {
      const element = contentRef.current
      if (!element) {
        const fallback = getPortalGeometry({ left: 0, top: 0, right: 0, bottom: 0 }, getViewport(), 1, 1)
        fallback.bounds = hiddenPortalBounds
        fallback.visible = false
        return fallback
      }
      const rect = element.getBoundingClientRect()
      const geometry = getPortalGeometry(
        { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
        getViewport(),
        element.offsetWidth || element.clientWidth || rect.width,
        element.offsetHeight || element.clientHeight || rect.height
      )
      return geometry
    }

    const currentGeneration = () => motionGenerationRef.current

    const adoptTokens = (value: unknown) => {
      if (!isRecord(value)) return
      if (typeof value.instanceId === 'string' && value.instanceId) portalInstanceRef.current = value.instanceId
      if (typeof value.generation === 'number' && Number.isFinite(value.generation)) {
        motionGenerationRef.current = Math.max(motionGenerationRef.current, Math.floor(value.generation))
      }
      if (typeof value.revision === 'number' && Number.isFinite(value.revision)) {
        portalRevisionRef.current = Math.max(portalRevisionRef.current, Math.floor(value.revision))
      }
    }

    const applyPresentationResult = (request: PortalPresentationUpdate, result: unknown) => {
      adoptTokens(result)
      const data = presentationData(result)
      if (data) setSnapshotValue(data)
      const resultRecord = isRecord(result) ? result : null
      if (resultRecord?.stale === true) return
      const resultVisible = resultRecord?.visible
      if ((request.mode === 'live' || request.mode === 'transitioning') && resultVisible === false) {
        setPresentationValue(snapshotRef.current ? 'snapshot' : 'hidden')
      } else if (request.mode === 'live' && resultVisible !== false) {
        // Keep the last accepted frame as a cache. It is not rendered while
        // live, but retaining it lets the next motion/focus transition paint
        // immediately instead of exposing the placeholder.
        setPresentationValue('live')
      } else if (request.mode === 'hidden') {
        setPresentationValue('hidden')
      } else if (request.mode === 'snapshot') {
        setPresentationValue(snapshotRef.current ? 'snapshot' : 'hidden')
      } else if (data) {
        setPresentationValue('snapshot')
      } else if (request.mode === 'creating') {
        setPresentationValue('creating')
      } else if (request.mode === 'transitioning') {
        setPresentationValue(snapshotRef.current ? 'snapshot' : 'transitioning')
      }
    }

    const sendDirect = async (request: PortalPresentationUpdate): Promise<unknown> => {
      if (typeof portal.update === 'function') {
        try {
          return await portal.update(portalId, request)
        } catch {
          // Older desktop builds do not have portal.update yet. Keep the
          // renderer compatible while the matching main process reconnects.
        }
      }
      return portal.setBounds(portalId, request.bounds, request.visible, {
        generation: request.generation,
        scale: request.canvasScale,
        revision: request.revision
      })
    }

    const flushUpdates = () => {
      if (disposed || disposedRef.current || updateInFlight || !pendingUpdate) return
      const request = pendingUpdate
      pendingUpdate = null
      updateInFlight = sendDirect(request)
      updateInFlight.then((result) => {
        // A response from an older frame must not replace the current DOM
        // state. Token adoption is still safe; presentation is latest-only.
        adoptTokens(result)
        if (request.requestId !== latestRequestId) return
        if (isRecord(result) && result.stale === true) {
          lastBoundsKeyRef.current = ''
          pendingUpdate = { ...request, revision: ++portalRevisionRef.current, requestId: ++nextRequestId }
          latestRequestId = pendingUpdate.requestId
          return
        }
        applyPresentationResult(request, result)
      }).catch((reason) => {
        if (request.requestId !== latestRequestId || disposed || disposedRef.current) return
        // A failed optional presentation bridge falls back to setBounds inside
        // sendDirect. Only surface a real failure after that fallback fails.
        setError(reason instanceof Error ? reason.message : 'Portal indisponível')
        if (request.mode === 'hidden') setPresentationValue('hidden')
      }).finally(() => {
        updateInFlight = null
        if (!disposed && !disposedRef.current && pendingUpdate) flushUpdates()
      })
    }

    const queueUpdate = (request: PortalPresentationUpdate) => {
      if (disposed || disposedRef.current) return
      const requestId = ++nextRequestId
      latestRequestId = requestId
      pendingUpdate = { ...request, requestId }
      flushUpdates()
    }

    const queueGeometry = (mode: PortalPresentationMode, forceVisible = mode === 'live' || mode === 'transitioning') => {
      const geometry = readGeometry()
      const logicalViewport = getLogicalViewport()
      const visible = Boolean(forceVisible && geometry.visible)
      const currentData = dataRef.current
      const nativeAllowed = currentData.interactive !== false && (!currentData.focusModeActive || Boolean(currentData.focused))
      const requestedMode: PortalPresentationMode = overlayModeRef.current ? 'snapshot' : mode
      const effectiveMode: PortalPresentationMode = nativeAllowed
        ? requestedMode
        : snapshotRef.current
          ? 'snapshot'
          : 'hidden'
      const request: PortalPresentationUpdate = {
        instanceId: portalInstanceRef.current || undefined,
        bounds: geometry.bounds || hiddenPortalBounds,
        visible: Boolean(nativeAllowed && visible && effectiveMode !== 'snapshot' && effectiveMode !== 'hidden'),
        mode: effectiveMode,
        generation: currentGeneration(),
        revision: ++portalRevisionRef.current,
        // During canvas motion (pan/zoom/drag) freeze the scale so Chromium
        // does not call setZoomFactor() on every frame, which would force a
        // visible page re-layout. The real scale is applied when motion ends.
        canvasScale: asFinite(motionRef.current && frozenScaleRef.current !== null ? frozenScaleRef.current : geometry.scale, 1),
        logicalViewport,
        zIndex: typeof currentData.zIndex === 'number' && Number.isFinite(currentData.zIndex) ? currentData.zIndex : undefined,
        focused: !currentData.focusModeActive || Boolean(currentData.focused),
        interactive: currentData.interactive !== false
      }
      const boundsKey = [
        request.generation,
        request.visible ? 1 : 0,
        request.mode,
        request.bounds.x,
        request.bounds.y,
        request.bounds.width,
        request.bounds.height,
        request.canvasScale.toFixed(4),
        request.logicalViewport.width,
        request.logicalViewport.height,
        request.zIndex ?? '',
        request.focused ? 1 : 0
      ].join(':')
      if (lastBoundsKeyRef.current === boundsKey) return
      lastBoundsKeyRef.current = boundsKey
      queueUpdate(request)
    }

    const scheduleBoundsSync = (modeOrEvent?: PortalPresentationMode | Event, forceVisible?: boolean) => {
      const explicitlyRequestedMode = typeof modeOrEvent === 'string' ? modeOrEvent : undefined
      if ((motionRef.current || settlingRef.current) && !explicitlyRequestedMode) return
      if (disposed || disposedRef.current || boundsRafRef.current !== null) return
      boundsRafRef.current = window.requestAnimationFrame(() => {
        boundsRafRef.current = null
        if (disposed || disposedRef.current || !portalReady) return
        let nextMode: PortalPresentationMode = explicitlyRequestedMode || 'live'
        // Ready/loading/resize observers can fire while a gesture owns the
        // portal. They must not reveal the native surface before final bounds
        // and zoom have settled.
        if ((motionRef.current || settlingRef.current) && nextMode === 'live') nextMode = 'transitioning'
        queueGeometry(nextMode, forceVisible ?? (nextMode === 'live' || nextMode === 'transitioning'))
      })
    }

    refreshPresentationRef.current = () => {
      lastBoundsKeyRef.current = ''
      scheduleBoundsSync()
    }

    const setMotion = (active: boolean) => {
      if (active) {
        if (motionRef.current) return
        if (settleTimerRef.current !== null) window.clearTimeout(settleTimerRef.current)
        settleTimerRef.current = null
        settlingRef.current = false
        motionRef.current = true
        motionGenerationRef.current += 1
        // Freeze the current Chromium zoom factor so setZoomFactor() is NOT
        // called on every frame while the canvas is panning/zooming. The
        // native child itself is repositioned on every motion heartbeat, so
        // the actual page and its card never separate during a drag.
        if (frozenScaleRef.current === null) {
          const geometry = readGeometry()
          frozenScaleRef.current = asFinite(geometry.scale, 1)
        }
        if (boundsRafRef.current !== null) window.cancelAnimationFrame(boundsRafRef.current)
        boundsRafRef.current = null
        setPresentationValue(snapshotRef.current ? 'snapshot' : 'transitioning')
        lastBoundsKeyRef.current = ''
        scheduleBoundsSync('transitioning', true)
        return
      }
      if (!motionRef.current) {
        return
      }
      motionRef.current = false
      settlingRef.current = true
      // Apply the final bounds and zoom before returning to the normal live
      // presentation. Keeping the native view visible avoids a stale detached
      // page or a placeholder after a drag.
      frozenScaleRef.current = null
      if (boundsRafRef.current !== null) window.cancelAnimationFrame(boundsRafRef.current)
      boundsRafRef.current = null
      lastBoundsKeyRef.current = ''
      scheduleBoundsSync('transitioning', true)
      settleTimerRef.current = window.setTimeout(() => {
        settleTimerRef.current = null
        if (disposed || disposedRef.current || motionRef.current) return
        settlingRef.current = false
        lastBoundsKeyRef.current = ''
        scheduleBoundsSync('live', true)
      }, 72)
    }

    portal.ensure(portalId, initialUrl).then((result) => {
      if (disposed || disposedRef.current) return
      portalReady = true
      adoptTokens(result)
      setError(null)
      if (isRecord(result) && typeof result.url === 'string') {
        setCurrentUrl(result.url)
        setAddress(result.url)
      }
      if (isRecord(result)) {
        if (typeof result.loading === 'boolean') setLoading(result.loading)
        if (typeof result.canGoBack === 'boolean') setCanGoBack(result.canGoBack)
        if (typeof result.canGoForward === 'boolean') setCanGoForward(result.canGoForward)
        if (typeof result.error === 'string' && result.error) setError(result.error)
      }
      lastBoundsKeyRef.current = ''
      // Mark the real bounds as desired-visible before the first capture. The
      // main process warms the native view outside the window until Chromium
      // paints; visible=false created a cycle where capture and visibility
      // waited on one another forever.
      queueGeometry('creating', true)
      scheduleBoundsSync()
    }).catch((reason) => {
      if (disposed || disposedRef.current) return
      setPresentationValue('hidden')
      setError(reason instanceof Error ? reason.message : 'Portal indisponível')
    })

    const cachePortalSnapshot = () => {
      if (disposed || disposedRef.current || typeof portal.screenshot !== 'function') return
      portal.screenshot(portalId).then((value) => {
        if (disposed || disposedRef.current || typeof value !== 'string' || value.length === 0) return
        // A ready/did-stop event refreshes the cache only. Keep the native
        // presentation mode untouched so a live page never flickers to a DOM
        // image just because Chromium finished loading.
        setSnapshotValue(value)
      }).catch(() => undefined)
    }

    const onCanvasMotion = (event: Event) => {
      const detail = (event as CustomEvent<{ active?: boolean; reason?: unknown }>).detail
      const reason = String(detail?.reason || 'canvas')
      const watchdogs = motionWatchdogsRef.current
      const clearWatchdog = () => {
        const timer = watchdogs.get(reason)
        if (timer !== undefined) window.clearTimeout(timer)
        watchdogs.delete(reason)
      }
      if (detail?.active) {
        motionReasonsRef.current.add(reason)
        clearWatchdog()
        watchdogs.set(reason, window.setTimeout(() => {
          watchdogs.delete(reason)
          motionReasonsRef.current.delete(reason)
          setMotion(motionReasonsRef.current.size > 0)
        }, 120))
      } else {
        clearWatchdog()
        motionReasonsRef.current.delete(reason)
      }
      const motionActive = motionReasonsRef.current.size > 0
      setMotion(motionActive)
      // onNodeDrag/onMove are heartbeats. Publish the current DOM rectangle
      // for every heartbeat once motion is active; a single start packet
      // would leave the native child at the first drag position.
      if (motionActive && motionRef.current) scheduleBoundsSync('transitioning', true)
    }
    window.addEventListener('orchestra:canvas-motion', onCanvasMotion)

    const unsubscribe = window.orchestra?.onEvent((event) => {
      const payload = event.payload || {}
      if (payload.portalId !== portalId) return
      if (typeof payload.instanceId === 'string' && portalInstanceRef.current && payload.instanceId !== portalInstanceRef.current) return
      if (event.type === 'portal:navigation' && typeof payload.url === 'string') {
        setError(null)
        setCurrentUrl(payload.url)
        setAddress(payload.url)
        setCanGoBack(Boolean(payload.canGoBack))
        setCanGoForward(Boolean(payload.canGoForward))
        updateNode(id, { properties: { ...propsRef.current, portalId, url: payload.url } })
      } else if (event.type === 'portal:loading') {
        setLoading(Boolean(payload.loading))
        if (payload.loading) {
          setError(null)
          // Keep the native view live during page loading. Chromium handles
          // its own loading state natively; hiding the view behind a stale
          // snapshot caused a visible flash on every navigation.
        } else {
          cachePortalSnapshot()
          const state = String(payload.state || '')
          if (state === 'error' || state === 'crashed') {
            setPresentationValue(snapshotRef.current ? 'snapshot' : 'hidden')
          } else scheduleBoundsSync('live')
        }
      } else if (event.type === 'portal:ready' || event.type === 'portal:did-stop-loading') {
        setLoading(false)
        const state = String(payload.state || '')
        if (state !== 'error' && state !== 'crashed') setError(null)
        cachePortalSnapshot()
        if (state === 'error' || state === 'crashed') setPresentationValue(snapshotRef.current ? 'snapshot' : 'hidden')
        else scheduleBoundsSync('live')
      } else if (event.type === 'portal:error') {
        setError(String(payload.errorDescription || payload.error || 'Falha ao carregar o portal'))
        setLoading(false)
      } else if (event.type === 'portal:crash' || event.type === 'portal:crashed') {
        setLoading(false)
        setPresentationValue(snapshotRef.current ? 'snapshot' : 'hidden')
        setError('O processo do portal terminou; recarrega para tentar novamente.')
      } else if (event.type === 'portal:unresponsive') {
        setError('O portal está temporariamente sem resposta.')
      } else if (event.type === 'portal:presentation' || event.type === 'portal:snapshot' || event.type === 'portal:state') {
        adoptTokens(payload)
        const data = presentationData(payload)
        if (data) {
          setSnapshotValue(data)
          setPresentationValue('snapshot')
        } else if (payload.mode === 'live') {
          setPresentationValue('live')
        } else if (payload.mode === 'hidden') {
          setPresentationValue('hidden')
        }
      }
    })

    const observer = typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(() => scheduleBoundsSync())
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
      pendingUpdate = null
      motionReasonsRef.current.clear()
      for (const timer of motionWatchdogsRef.current.values()) window.clearTimeout(timer)
      motionWatchdogsRef.current.clear()
      motionRef.current = false
      settlingRef.current = false
      if (settleTimerRef.current !== null) window.clearTimeout(settleTimerRef.current)
      settleTimerRef.current = null
      refreshPresentationRef.current = () => undefined
      if (boundsRafRef.current !== null) window.cancelAnimationFrame(boundsRafRef.current)
      boundsRafRef.current = null
      observer?.disconnect()
      window.removeEventListener('resize', scheduleBoundsSync)
      window.removeEventListener('scroll', scheduleBoundsSync, true)
      viewport?.removeEventListener('resize', scheduleBoundsSync)
      viewport?.removeEventListener('scroll', scheduleBoundsSync)
      window.removeEventListener('orchestra:canvas-motion', onCanvasMotion)
      unsubscribe?.()
      // Advance both monotonic tokens before cleanup so an older in-flight
      // live update cannot resurrect a portal after this node is removed.
      const cleanupGeneration = ++motionGenerationRef.current
      const cleanupRevision = ++portalRevisionRef.current
      const cleanup: PortalPresentationUpdate = {
        instanceId: portalInstanceRef.current || undefined,
        bounds: hiddenPortalBounds,
        visible: false,
        mode: 'hidden',
        generation: cleanupGeneration,
        revision: cleanupRevision,
        canvasScale: 1,
        logicalViewport: getLogicalViewport(),
        focused: false,
        interactive: false
      }
      void sendDirect(cleanup).catch(() => undefined)
    }
  }, [id, portalId])

  // Focus mode and node interactivity are controlled by CanvasArea. Refresh
  // the native child immediately when those flags change without remounting
  // the portal (which would otherwise reset the loaded page).
  useEffect(() => {
    refreshPresentationRef.current()
  }, [data.focusModeActive, data.focused, data.interactive, data.zIndex, data.selected])

  const handleNavigate = (event?: React.FormEvent) => {
    event?.preventDefault()
    const value = address.trim()
    if (!value || !window.orchestra?.portal) return
    setError(null)
    setLoading(true)
    window.orchestra.portal.navigate(portalId, value).catch((reason) => {
      setLoading(false)
      setError(reason instanceof Error ? reason.message : 'Falha ao navegar')
    })
  }

  const action = (name: 'back' | 'forward' | 'reload' | 'stop') => {
    setError(null)
    window.orchestra?.portal?.action(portalId, name).catch((reason) => setError(reason instanceof Error ? reason.message : 'Falha ao operar o portal'))
  }

  const setOverlayMode = (active: boolean) => {
    overlayModeRef.current = active
    lastBoundsKeyRef.current = ''
    if (active) setPresentationValue(snapshotRef.current ? 'snapshot' : 'hidden')
    refreshPresentationRef.current()
  }

  const startGrab = async () => {
    const portal = window.orchestra?.portal
    if (!portal) return
    if (isGrabbing) {
      grabAttemptRef.current += 1
      setIsGrabbing(false)
      setToolStatus('Seleção cancelada')
      await portal.cancelGrab(portalId).catch(() => undefined)
      return
    }
    const attempt = ++grabAttemptRef.current
    setIsGrabbing(true)
    setError(null)
    // A previous screenshot/markup session leaves the native guest frozen
    // behind the renderer overlay. Always restore the live page before the
    // picker is installed, including on the very first use.
    setSelectedNodeId(id)
    setMarkupScreenshot(null)
    setGrabResult(null)
    setOverlayMode(false)
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()))
    if (attempt !== grabAttemptRef.current) return
    setToolStatus('Seleciona um ou mais elementos · escreve o comentário · Esc cancela')
    try {
      const result = await portal.grab(portalId)
      if (attempt !== grabAttemptRef.current) return
      if (!result) { setToolStatus('Seleção cancelada'); return }
      setGrabResult(result)
      const pageSnapshot = await portal.screenshot(portalId)
      if (pageSnapshot) setSnapshotValue(pageSnapshot)
      setOverlayMode(true)
      setToolStatus(`${result.targets?.length || 1} ${result.targets?.length === 1 ? 'elemento capturado' : 'elementos capturados'}`)
    } catch (reason) {
      if (attempt !== grabAttemptRef.current) return
      setToolStatus('')
      setError(reason instanceof Error ? reason.message : 'Não foi possível selecionar o elemento')
    } finally {
      if (attempt === grabAttemptRef.current) setIsGrabbing(false)
    }
  }

  useEffect(() => () => {
    grabAttemptRef.current += 1
    void window.orchestra?.portal?.cancelGrab(portalId).catch(() => undefined)
  }, [portalId])

  const startMarkup = async () => {
    const portal = window.orchestra?.portal
    if (!portal) return
    setError(null)
    setToolStatus('A capturar screenshot…')
    try {
      const image = await portal.screenshot(portalId)
      if (!image) throw new Error('A página ainda não tem uma imagem pronta')
      setSnapshotValue(image)
      setMarkupScreenshot(image)
      setOverlayMode(true)
      setToolStatus('')
    } catch (reason) {
      setToolStatus('')
      setError(reason instanceof Error ? reason.message : 'Não foi possível capturar a página')
    }
  }

  const closeOverlay = () => {
    setMarkupScreenshot(null)
    setGrabResult(null)
    setToolStatus('')
    setOverlayMode(false)
  }

  const grabTargets = grabResult ? (grabResult.targets?.length ? grabResult.targets : [grabResult.target]) : []
  const grabContextText = grabResult ? [
    `Page: ${grabResult.page.title || grabResult.page.url}`,
    `URL: ${grabResult.page.url}`,
    grabResult.comment ? `User comment:\n${grabResult.comment}` : '',
    ...grabTargets.map((target, index) => [
      `Element ${index + 1}: ${target.selector}`,
      `Role: ${target.role}${target.accessibleName ? ` (${target.accessibleName})` : ''}`,
      target.text ? `Text: ${target.text}` : '',
      `Bounds: ${Math.round(target.rect.x)},${Math.round(target.rect.y)} ${Math.round(target.rect.width)}×${Math.round(target.rect.height)}`,
      `Attributes: ${JSON.stringify(target.attributes)}`,
      `Styles: ${JSON.stringify(target.styles)}`
    ].filter(Boolean).join('\n'))
  ].filter(Boolean).join('\n\n') : ''

  return (
    <div
      className="node"
      data-kind="browser"
      data-portal-presentation={presentation}
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
          updateNode(id, { x: params.x, y: params.y, width: params.width, height: params.height })
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
          <button type="button" className="icon-btn chrome-nav" title={loading ? 'Parar' : 'Recarregar'} onClick={() => action(loading ? 'stop' : 'reload')}>{loading ? <X className="icon" /> : <RefreshCw className="icon" />}</button>
          <div className={`chrome-address ${loading ? 'chrome-address-loading' : ''}`}>
            <Search className="icon" />
            <input type="text" value={address} onChange={(event) => setAddress(event.target.value)} placeholder="Pesquisar ou digitar URL..." />
          </div>
          <button type="button" className={`icon-btn chrome-nav ${isGrabbing ? 'active' : ''}`} title={isGrabbing ? 'Cancelar seleção de elemento' : 'Selecionar elemento da página'} aria-label={isGrabbing ? 'Cancelar seleção de elemento' : 'Selecionar elemento da página'} aria-pressed={isGrabbing} onClick={() => void startGrab()}><MousePointer2 className="icon" /></button>
          <button type="button" className="icon-btn chrome-nav" title="Desenhar na screenshot" aria-label="Desenhar na screenshot" onClick={() => void startMarkup()}><PenTool className="icon" /></button>
          <button type="button" className="icon-btn chrome-nav" title="Abrir no navegador do sistema" onClick={() => window.orchestra?.portal?.openExternal(portalId).catch(() => undefined)}><SquareArrowOutUpRight className="icon" /></button>
          <button type="button" className="icon-btn chrome-nav" onClick={(event) => { event.stopPropagation(); deleteNode(id); window.orchestra?.portal?.destroy(portalId).catch(() => undefined) }} title="Fechar portal"><X className="icon" /></button>
        </form>
        {loading && <div className="chrome-loading-bar"><div className="chrome-loading-progress" /></div>}

        <div ref={contentRef} className={`chrome-content nodrag nowheel portal-state-${presentation}`} onMouseDown={(event) => event.stopPropagation()}>
          {snapshot && presentation === 'snapshot' ? <img className="portal-snapshot" src={snapshot} alt="Pré-visualização do portal durante o movimento" /> : <div className="portal-placeholder">
            {error ? <><b>Portal com erro</b><span>{error}</span></> : <><span>{currentUrl}</span><small>{loading ? 'A carregar…' : presentation === 'creating' ? 'A preparar o portal…' : 'Portal Chromium isolado'}</small></>}
          </div>}
          {error && snapshot && presentation === 'snapshot' && <div className="portal-error-overlay"><b>Portal com erro</b><span>{error}</span></div>}
          {markupScreenshot && <BrowserMarkupOverlay
            screenshot={markupScreenshot}
            pageTitle={currentUrl}
            onClose={closeOverlay}
            onCopy={(dataUrl) => window.orchestra?.portal?.copyImage(dataUrl) || Promise.reject(new Error('Clipboard indisponível'))}
          />}
        </div>

        <div className="node-foot chrome-foot">
          {grabResult ? <div className="browser-grab-summary nodrag nopan">
            <span className="browser-grab-check"><Check className="icon" /></span>
            {grabResult.screenshot && <img className="browser-grab-thumb" src={grabResult.screenshot.dataUrl} alt="Elemento selecionado" />}
            <span className="browser-grab-copy"><strong>{grabResult.target.accessibleName || grabResult.target.tagName}{grabTargets.length > 1 ? ` +${grabTargets.length - 1}` : ''}</strong><small title={grabTargets.map((target) => target.selector).join(', ')}>{grabResult.comment || grabResult.target.selector}</small></span>
            <button type="button" className="compact-action" onClick={() => { void navigator.clipboard?.writeText(grabContextText); setToolStatus('Contexto copiado') }}><Copy className="icon" />Copiar</button>
            <AgentTargetMenu label="Enviar" connectedToNodeId={id} initiallyOpen onSelect={(agent) => {
              addContextToAgent(agent.id, {
                id: `browser:${portalId}:${grabTargets.length}:${grabResult.target.selector}`,
                kind: 'browser',
                title: `${grabResult.target.accessibleName || grabResult.target.tagName}${grabTargets.length > 1 ? ` +${grabTargets.length - 1}` : ''}`,
                reference: `[browser:${portalId} ${grabTargets.map((target) => target.selector).join(', ')}]`,
                content: grabContextText,
                metadata: { portalId, url: grabResult.page.url, selectors: grabTargets.map((target) => target.selector), comment: grabResult.comment, screenshot: grabResult.screenshot }
              }, true)
              setToolStatus(`Contexto adicionado a ${agent.name}`)
            }} />
            <button type="button" className="icon-btn" title="Fechar captura" aria-label="Fechar captura" onClick={closeOverlay}><X className="icon" /></button>
          </div> : <>
            <span className="chrome-foot-url" title={currentUrl}>{toolStatus || (loading ? 'A carregar…' : error ? 'Erro no portal' : currentUrl)}</span>
            <span className="chrome-foot-status">{loading ? 'A sincronizar' : presentation === 'snapshot' ? 'Pausa' : 'Chromium'}</span>
          </>}
        </div>
      </div>
    </div>
  )
}
