#!/usr/bin/env node

/**
 * Small Electron-only browser portal harness. It deliberately loads a local
 * fixture instead of Orchestra Desktop, so responsive layout and portal
 * motion can be checked even when the app/core/CLI are unavailable.
 *
 * Run with:
 *   apps/desktop/node_modules/electron/dist/electron apps/desktop/portal-responsive-harness.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { app, BrowserWindow, WebContentsView } from 'electron'

const fixturePath = path.resolve(new URL('./test-fixtures/responsive-portal.html', import.meta.url).pathname)
const logicalWidths = [390, 768, 1440]
const zoomFactors = [0.25, 0.43, 1, 2]
const height = 640

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function evaluate(webContents, expression) {
  return webContents.executeJavaScript(expression, true)
}

async function run() {
  if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    console.log(JSON.stringify({ ok: true, skipped: true, reason: 'No Linux display available' }))
    return
  }
  assert(fs.existsSync(fixturePath), `missing fixture: ${fixturePath}`)
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-portal-harness-'))
  app.setPath('userData', userData)

  const window = new BrowserWindow({
    show: false,
    useContentSize: true,
    width: logicalWidths[0],
    height,
    webPreferences: { sandbox: false, contextIsolation: false, offscreen: true }
  })
  const portalView = new WebContentsView({
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, offscreen: true }
  })
  window.contentView.addChildView(portalView)
  portalView.setVisible(true)
  try {
    await window.loadURL('about:blank')
    await portalView.webContents.loadURL(pathToFileURL(fixturePath).href)
    const results = []
    for (const zoom of zoomFactors) {
      for (const logicalWidth of logicalWidths) {
        // Match the physical content size to the requested logical viewport.
        // Chromium's page zoom should then preserve the logical innerWidth.
        window.setContentSize(Math.round(logicalWidth * zoom), height)
        portalView.setBounds({ x: 0, y: 0, width: Math.round(logicalWidth * zoom), height })
        portalView.webContents.setZoomFactor(zoom)
        await sleep(80)
        const viewport = await evaluate(portalView.webContents, 'window.portalFixture.readViewport()')
        const tolerance = Math.max(3, logicalWidth * 0.025)
        assert(Math.abs(viewport.innerWidth - logicalWidth) <= tolerance,
          `innerWidth ${viewport.innerWidth} drifted from ${logicalWidth} at zoom ${zoom}`)
        assert(viewport.innerHeight > 0 && viewport.visualScale > 0,
          `invalid visual viewport at width ${logicalWidth} / zoom ${zoom}`)
        const frame = await portalView.webContents.capturePage()
        const frameSize = frame.getSize()
        const physicalWidth = Math.round(logicalWidth * zoom)
        assert(!frame.isEmpty() && frameSize.width > 0 && frameSize.height > 0,
          `native WebContentsView produced an empty frame at width ${logicalWidth} / zoom ${zoom}`)
        assert(Math.abs(frameSize.width - physicalWidth) <= 2,
          `snapshot width ${frameSize.width} drifted from native surface ${physicalWidth} at logical width ${logicalWidth} / zoom ${zoom}`)
        results.push({ zoom, requestedWidth: logicalWidth, frameWidth: frameSize.width, ...viewport })
      }
    }

    const created = await evaluate(portalView.webContents, 'window.portalFixture.create()')
    assert(created.created === true && created.lifecycle === 'live', 'portal creation snapshot is not live')
    const before = await evaluate(portalView.webContents, 'window.portalFixture.snapshot()')
    const moved = await evaluate(portalView.webContents, 'window.portalFixture.drag(37, 19)')
    const after = await evaluate(portalView.webContents, 'window.portalFixture.snapshot()')
    assert(moved.x === before.x + 37 && moved.y === before.y + 19, 'drag did not update portal position')
    assert(moved.generation > before.generation && moved.revision > before.revision, 'drag did not advance motion/revision state')
    assert(after.x === moved.x && after.y === moved.y && after.viewport.innerWidth > 0, 'snapshot lost moved portal state')
    console.log(JSON.stringify({ ok: true, fixture: path.basename(fixturePath), viewports: results, motion: { before, after } }))
  } finally {
    try { window.contentView.removeChildView(portalView) } catch { /* best effort */ }
    try { portalView.webContents.close() } catch { /* best effort */ }
    window.destroy()
    try { fs.rmSync(userData, { recursive: true, force: true }) } catch { /* best effort */ }
  }
}

app.whenReady().then(async () => {
  try {
    await run()
    app.exit(0)
  } catch (error) {
    console.error(error instanceof Error ? error.stack || error.message : String(error))
    app.exit(1)
  }
})
