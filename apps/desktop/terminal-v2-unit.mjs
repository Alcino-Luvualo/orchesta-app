import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { Terminal } = require('@xterm/xterm')

import { applyCommandEditorEdit } from './src/renderer/components/Nodes/CommandEditorEngine.ts'
import {
  TerminalBlockStore,
  terminalBlockOutputText
} from './src/renderer/components/Nodes/terminalBlocks.ts'
import { VirtualBlockIndex } from './src/renderer/components/Nodes/virtualBlockIndex.ts'
import {
  analyzeShellCommand,
  fuzzyScore
} from './src/renderer/components/Nodes/shellCommandParser.ts'
import {
  isDirectInteractiveTerminalCommand,
  DEFAULT_TERMINAL_KEYBOARD_PROTOCOL,
  isMultilineEnter,
  isNativeEnterData,
  modifiedEnterSequence,
  multilineEnterSequence,
  shellMultilineEnterSequence,
  multilineEnterPayload,
  terminalPastePayload
} from './src/renderer/components/Nodes/terminalInput.ts'
import {
  getTerminalTransformScale,
  isIdentityTerminalScale,
  mapTerminalPointerToLayout
} from './src/renderer/components/Nodes/terminalGeometry.ts'
import { applyCanvasNodeChanges } from './src/renderer/components/Canvas/canvasNodeChanges.ts'

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function base64(value) {
  return Buffer.from(value, 'utf8').toString('base64')
}

function testMultilineEditorDocument() {
  const command = 'npm install react-router-dom'
  const insertionPoint = command.indexOf('router')
  const edited = applyCommandEditorEdit(command, insertionPoint, insertionPoint, 'awesome-')
  assert(edited.document === 'npm install react-awesome-router-dom', 'editor click-to-edit insertion changed the wrong range')
  assert(edited.cursor === insertionPoint + 'awesome-'.length, 'editor cursor did not follow inserted text')

  const multiline = applyCommandEditorEdit(edited.document, edited.cursor, edited.cursor, '\nprintf "linha-ação 🌍"')
  assert(multiline.document === 'npm install react-awesome-\nprintf "linha-ação 🌍"router-dom', 'editor multiline insertion corrupted the document')
  assert(multiline.document.includes('\n') && multiline.document.includes('ação 🌍'), 'editor multiline Unicode content was lost')

  const replacement = applyCommandEditorEdit(multiline.document, 0, 3, 'printf')
  assert(replacement.document.startsWith('printf install'), 'editor selection replacement failed')
}

function testBlocks() {
  const store = new TerminalBlockStore(2)
  const first = store.begin('unit-session', { command: 'printf one', cwd: '/tmp' })
  store.markRunning()
  store.appendOutput('unit-session', base64('one\n'))
  const finished = store.finish(0, first.startedAt + 25)
  assert(finished?.state === 'success', 'successful block did not finish as success')
  assert(finished?.durationMs === 25, 'block duration metadata is incorrect')
  assert(finished && terminalBlockOutputText(finished) === 'one\n', 'block output decoding lost bytes')

  store.begin('unit-session', { command: 'false', cwd: '/tmp' })
  store.appendOutput('unit-session', base64('erro\n'))
  const interrupted = store.finish(130)
  assert(interrupted?.state === 'interrupted', 'Ctrl+C exit code was not classified as interrupted')

  store.begin('unit-session', { command: 'printf three', cwd: '/tmp' })
  assert(store.blocks.length === 2, 'block retention cap did not remove the oldest block')
  assert(!store.blocks.some((block) => block.id === first.id), 'oldest block escaped retention cap')
}

function testVirtualBlocks() {
  const index = new VirtualBlockIndex(40)
  index.resize(1000)
  assert(index.totalHeight() === 40_000, 'virtual block index initial height is incorrect')
  assert(index.setHeight(400, 200), 'virtual block index rejected a real row growth')
  assert(index.indexAt(index.offsetOf(400) + 1) === 400, 'virtual block index offset lookup skipped the grown row')
  const range = index.visibleRange(index.offsetOf(400), 120, 2)
  assert(range.start <= 400 && range.end > 400, 'virtual block visible range omitted the anchor row')
}

function testParser() {
  const analysis = analyzeShellCommand("NODE_ENV=production printf '%s' \"Olá\" | grep --color=auto")
  assert(analysis.diagnostics.length === 0, 'shell parser reported a false diagnostic for valid Unicode syntax')
  assert(analysis.tokens.some((token) => token.kind === 'assignment'), 'shell parser missed environment assignment')
  assert(analysis.tokens.some((token) => token.kind === 'operator' && token.text === '|'), 'shell parser missed pipeline operator')
  assert(fuzzyScore('gco', 'git checkout') !== null, 'completion fuzzy ranking rejected a valid candidate')
}

function testNativeTerminalMultilineKeys() {
  assert(DEFAULT_TERMINAL_KEYBOARD_PROTOCOL === 'modify_other_keys', 'terminal keyboard protocol did not start in Ghostty compatibility mode')
  assert(isMultilineEnter({ key: 'Enter', code: 'Enter', shiftKey: true, ctrlKey: false, isComposing: false }), 'Shift+Enter was not recognized as multiline input')
  assert(isMultilineEnter({ key: 'Enter', code: 'Enter', shiftKey: false, ctrlKey: true, isComposing: false }), 'Ctrl+Enter was not recognized as multiline input')
  assert(isMultilineEnter({ key: 'Unidentified', code: 'NumpadEnter', shiftKey: false, ctrlKey: true, isComposing: false }), 'Numpad Ctrl+Enter was not recognized')
  assert(!isMultilineEnter({ key: 'Enter', code: 'Enter', shiftKey: false, ctrlKey: false, isComposing: false }), 'plain Enter was incorrectly classified as multiline input')
  assert(isNativeEnterData('\r') && isNativeEnterData('\n'), 'native Enter bytes were not recognized')
  assert(!isNativeEnterData('\u001b[27;5;13~'), 'modified Enter was mistaken for native input')
  assert(multilineEnterSequence(true) === '\u001b[200~\n\u001b[201~', 'bracketed multiline sequence changed')
  assert(multilineEnterSequence(false) === '\u0016\n', 'readline quoted-insert fallback changed')
  assert(shellMultilineEnterSequence(true) === '\u001b[200~\n\u001b[201~', 'bracketed shell multiline sequence changed')
  assert(shellMultilineEnterSequence(false) === '\u001b[200~\n\u001b[201~', 'shell fallback did not use one framed newline')
  const ctrlEnter = { key: 'Enter', code: 'Enter', shiftKey: false, ctrlKey: true, isComposing: false }
  const shiftEnter = { key: 'Enter', code: 'Enter', shiftKey: true, ctrlKey: false, isComposing: false }
  assert(modifiedEnterSequence(ctrlEnter, 'modify_other_keys') === '\u001b[27;5;13~', 'Ghostty modifyOtherKeys Ctrl+Enter bytes changed')
  assert(modifiedEnterSequence(shiftEnter, 'modify_other_keys') === '\u001b[27;2;13~', 'Ghostty modifyOtherKeys Shift+Enter bytes changed')
  assert(modifiedEnterSequence(ctrlEnter, 'kitty') === '\u001b[13;5u', 'Kitty CSI-u Ctrl+Enter bytes changed')
  assert(modifiedEnterSequence(shiftEnter, 'kitty') === '\u001b[13;2u', 'Kitty CSI-u Shift+Enter bytes changed')
  assert(multilineEnterPayload(ctrlEnter, 'shell', true, 'modify_other_keys') === '\u001b[200~\n\u001b[201~', 'shell Ctrl+Enter did not resolve to one bracketed payload')
  assert(multilineEnterPayload(ctrlEnter, 'shell', false, 'modify_other_keys') === '\u001b[200~\n\u001b[201~', 'shell Ctrl+Enter fallback did not resolve to one framed payload')
  assert(multilineEnterPayload(ctrlEnter, 'interactive', false, 'modify_other_keys') === '\u001b[27;5;13~', 'interactive Ctrl+Enter did not resolve to one modified payload')
  assert(multilineEnterPayload(shiftEnter, 'interactive', false, 'kitty') === '\u001b[13;2u', 'interactive Shift+Enter did not resolve to one Kitty payload')
  assert(multilineEnterPayload({ ...ctrlEnter, isComposing: true }, 'interactive', false, 'kitty') === null, 'composing Enter was incorrectly delivered')
  assert(isDirectInteractiveTerminalCommand('codex'), 'direct Codex launch was not classified as interactive')
  assert(isDirectInteractiveTerminalCommand('claude'), 'direct Claude launch was not classified as interactive')
  assert(isDirectInteractiveTerminalCommand('gemini'), 'direct Gemini launch was not classified as interactive')
  assert(isDirectInteractiveTerminalCommand('agy'), 'direct Antigravity launch was not classified as interactive')
  assert(isDirectInteractiveTerminalCommand('antigravity'), 'direct Antigravity alias was not classified as interactive')
  assert(isDirectInteractiveTerminalCommand('cursor-agent'), 'direct Cursor CLI launch was not classified as interactive')
  assert(isDirectInteractiveTerminalCommand('cursor'), 'direct Cursor CLI alias was not classified as interactive')
  assert(isDirectInteractiveTerminalCommand('env ORCHESTRA=1 claude --continue'), 'wrapped direct agent launch was not classified as interactive')
  assert(isDirectInteractiveTerminalCommand('/usr/local/bin/opencode'), 'absolute OpenCode launch was not classified as interactive')
  assert(isDirectInteractiveTerminalCommand('opencode'), 'direct OpenCode launch was not classified as interactive')
  assert(!isDirectInteractiveTerminalCommand('zsh'), 'direct shell launch was incorrectly classified as interactive')
  assert(!isDirectInteractiveTerminalCommand('env FOO=1 bash -i'), 'wrapped shell launch was incorrectly classified as interactive')
}

function testTerminalPasteContract() {
  const rich = 'ação 🌍\r\n\r\n\tlinha\rESC-like: [200~inside[201~'
  const normalized = 'ação 🌍\n\n\tlinha\nESC-like: [200~inside[201~'
  assert(terminalPastePayload(rich, false) === normalized, 'plain paste lost Unicode, tabs, blank lines or escape-like content')
  assert(
    terminalPastePayload(rich, true) === `[200~${normalized}[201~`,
    'bracketed paste did not add exactly one outer frame'
  )
  assert(!terminalPastePayload('no-submit', false).endsWith('\r'), 'plain paste appended Enter')
  assert(!terminalPastePayload('no-submit', true).endsWith('\r'), 'bracketed paste appended Enter')

  for (const bytes of [1024, 64 * 1024, 256 * 1024]) {
    const input = 'x'.repeat(bytes)
    assert(terminalPastePayload(input, false) === input, `plain ${bytes}-byte paste changed content`)
    const framed = terminalPastePayload(input, true)
    assert(framed.slice(6, -6) === input, `bracketed ${bytes}-byte paste duplicated or truncated content`)
    assert(framed.length === input.length + 12, `bracketed ${bytes}-byte paste applied more than one frame`)
  }
}

function writeTerminal(term, data) {
  return new Promise((resolve) => term.write(data, resolve))
}

async function testTerminalMultilineRender() {
  const term = new Terminal({ cols: 100, rows: 8 })
  try {
    // This is the redraw shape emitted by both bash and zle after the framed
    // one-LF payload. CR/LF is deliberately kept as returned by the PTY so
    // this catches a renderer-only extra-row regression, not just byte math.
    await writeTerminal(term, "\u001b[7mprintf 'one\\n'\u001b[27m\r\n\r\u001b[7mprintf 'two\\n'\u001b[27m\u001b[K")
    const first = term.buffer.active.getLine(0)?.translateToString(true) || ''
    const second = term.buffer.active.getLine(1)?.translateToString(true) || ''
    const third = term.buffer.active.getLine(2)?.translateToString(true) || ''
    assert(first === "printf 'one\\n'", 'xterm redraw changed the first multiline command row')
    assert(second === "printf 'two\\n'", 'xterm redraw changed the second multiline command row')
    assert(third === '', 'xterm rendered an extra blank row for one framed newline')

    await writeTerminal(term, '\r\none\r\ntwo\r\nPROMPT>')
    const rendered = Array.from({ length: 8 }, (_, index) => term.buffer.active.getLine(index)?.translateToString(true) || '')
    assert(rendered.includes('one') && rendered.includes('two'), 'xterm lost shell output after ordinary Enter')
    const oneIndex = rendered.indexOf('one')
    const twoIndex = rendered.indexOf('two')
    assert(twoIndex === oneIndex + 1, 'xterm inserted a blank visual row between shell outputs')
  } finally {
    term.dispose()
  }
}

function testTerminalPointerTransformCompensation() {
  const scale = getTerminalTransformScale(
    { left: 100, top: 80, width: 960, height: 480 },
    { width: 800, height: 400 }
  )
  assert(scale.x === 1.2 && scale.y === 1.2, 'terminal transform scale was not derived from painted/layout dimensions')
  assert(!isIdentityTerminalScale(scale), 'non-identity terminal transform was mistaken for identity')
  const mapped = mapTerminalPointerToLayout({ clientX: 340, clientY: 320 }, { left: 100, top: 80, width: 960, height: 480 }, scale)
  assert(mapped.clientX === 300 && mapped.clientY === 280, 'painted terminal pointer was not mapped back to xterm CSS space')
  assert(isIdentityTerminalScale(getTerminalTransformScale({ left: 0, top: 0, width: 800, height: 400 }, { width: 800, height: 400 })), 'identity terminal transform was not recognized')

  // ReactFlow's supported range and high-DPR fractional layout both need to
  // preserve the same cell-relative point. These are painted CSS pixels; DPR
  // must not be multiplied a second time by the terminal pointer bridge.
  for (const factor of [0.08, 0.125, 0.5, 1, 2, 3.5, 4]) {
    const layout = { width: 803.25, height: 401.5 }
    const visual = { left: 17.375, top: 29.625, width: layout.width * factor, height: layout.height * factor }
    const derived = getTerminalTransformScale(visual, layout)
    const painted = { clientX: visual.left + visual.width * 0.37, clientY: visual.top + visual.height * 0.61 }
    const mappedPoint = mapTerminalPointerToLayout(painted, visual, derived)
    assert(Math.abs(mappedPoint.clientX - (visual.left + layout.width * 0.37)) < 1e-9, `terminal x pointer drifted at scale ${factor}`)
    assert(Math.abs(mappedPoint.clientY - (visual.top + layout.height * 0.61)) < 1e-9, `terminal y pointer drifted at scale ${factor}`)
  }
}

function testControlledCanvasNodeChanges() {
  const nodes = [
    { id: 'agent', kind: 'terminal', x: 0, y: 0, width: 420, height: 250, properties: {} },
    { id: 'note', kind: 'note', x: 700, y: 20, width: 300, height: 200, properties: {} }
  ]
  const result = applyCanvasNodeChanges([
    { id: 'agent', type: 'dimensions', dimensions: { width: 424, height: 252 } },
    { id: 'agent', type: 'position', position: { x: 120, y: 80 }, dragging: true },
    { id: 'agent', type: 'select', selected: true },
    { id: 'note', type: 'remove' }
  ], nodes, new Map(), null)

  assert(result.positionChanged, 'controlled canvas position change was ignored')
  assert(result.nodes[0].x === 120 && result.nodes[0].y === 80, 'controlled canvas position was not applied')
  assert(result.measurements.get('agent')?.width === 424 && result.measurements.get('agent')?.height === 252, 'React Flow dimensions were not retained in runtime state')
  assert(result.selectedNodeId === 'agent' && result.removedNodeIds[0] === 'note', 'controlled canvas selection/removal changes were ignored')
  assert(!('measured' in result.nodes[0]), 'transient React Flow measurement leaked into the persisted domain node')
  assert(nodes[0].x === 0 && nodes[0].y === 0, 'controlled canvas change mutated the domain input')
}

testMultilineEditorDocument()
testBlocks()
testVirtualBlocks()
testParser()
testNativeTerminalMultilineKeys()
testTerminalPasteContract()
await testTerminalMultilineRender()
testTerminalPointerTransformCompensation()
testControlledCanvasNodeChanges()
console.log(JSON.stringify({ ok: true, suite: 'terminal-v2-unit', cases: 9 }))
