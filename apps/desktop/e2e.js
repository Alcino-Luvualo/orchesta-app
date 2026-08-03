const fs = require('fs')
const os = require('os')
const path = require('path')
const net = require('net')
const { spawn, spawnSync, execFileSync } = require('child_process')

const repositoryRoot = path.resolve(__dirname, '../..')
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-e2e-'))
const runtimeRoot = path.join(temporaryRoot, 'runtime')
const dataRoot = path.join(temporaryRoot, 'data')
const workspaceRoot = path.join(temporaryRoot, 'workspace')
const socketPath = path.join(runtimeRoot, 'orchestra', 'orchestra.sock')
fs.mkdirSync(workspaceRoot, { recursive: true })
execFileSync('git', ['-C', workspaceRoot, 'init', '-q'])
execFileSync('git', ['-C', workspaceRoot, 'config', 'user.email', 'e2e@orchestra.local'])
execFileSync('git', ['-C', workspaceRoot, 'config', 'user.name', 'Orchestra E2E'])
fs.writeFileSync(path.join(workspaceRoot, 'README.md'), 'initial\n')
execFileSync('git', ['-C', workspaceRoot, 'add', 'README.md'])
execFileSync('git', ['-C', workspaceRoot, 'commit', '-q', '-m', 'initial'])

const corePath = [
  path.join(repositoryRoot, 'target/debug/orchestra-core'),
  path.join(repositoryRoot, 'target/release/orchestra-core')
].find((candidate) => fs.existsSync(candidate))
if (!corePath) throw new Error('Build orchestra-core before running the Electron IPC E2E test')
const cliPath = [
  path.join(repositoryRoot, 'target/debug/orchestra'),
  path.join(repositoryRoot, 'target/release/orchestra')
].find((candidate) => fs.existsSync(candidate))
if (!cliPath) throw new Error('Build orchestra CLI before running the connected IPC E2E test')

const core = spawn(corePath, [], {
  cwd: repositoryRoot,
  env: { ...process.env, XDG_RUNTIME_DIR: runtimeRoot, XDG_DATA_HOME: dataRoot },
  stdio: 'ignore'
})

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function runCli(args, sessionId, token, options = {}) {
  const result = spawnSync(cliPath, args, {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      ORCHESTRA_SOCKET: socketPath,
      ORCHESTRA_SESSION_ID: sessionId,
      ORCHESTRA_TOKEN: token,
      ORCHESTRA_CONTEXT_DIR: path.join(workspaceRoot, '.orchestra', 'terminals', sessionId),
      ORCHESTRA_WORKSPACE_DIR: workspaceRoot
    },
    encoding: 'utf8',
    timeout: options.timeout ?? 10000,
    maxBuffer: 2 * 1024 * 1024
  })
  const output = `${result.stdout || ''}${result.stderr || ''}`
  if (options.expectFailure) {
    if (result.status === 0) throw new Error(`CLI unexpectedly succeeded: orchestra ${args.join(' ')}`)
    return output
  }
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`CLI failed (${result.status}): orchestra ${args.join(' ')}\n${output}`)
  return output
}

function stripTerminalControls(value) {
  return value
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\u001b\([^\r\n]/g, '')
    .replace(/\u001b./g, '')
}

function executableOnPath(name) {
  return (process.env.PATH || '').split(path.delimiter).some((directory) => {
    try { return fs.statSync(path.join(directory, name)).isFile() } catch { return false }
  })
}

async function waitForSocket() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (fs.existsSync(socketPath)) return
    await delay(50)
  }
  throw new Error(`Core socket was not created: ${socketPath}`)
}

function connect() {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath)
    let buffer = Buffer.alloc(0)
    const responses = new Map()
    const events = []
    const waiters = new Set()
    let client

    socket.on('connect', () => {
      client = {
      socket,
      events,
      waiters,
      lastRequest: null,
      call(type, payload = {}) {
        this.lastRequest = { type, payload, at: new Date().toISOString() }
        const requestId = `e2e_${Math.random().toString(36).slice(2)}`
        const wirePayload = type === 'system.hello' ? payload : { ...payload, clientToken: this.clientToken }
        const bytes = Buffer.from(JSON.stringify({ protocolVersion: 2, requestId, type, payload: wirePayload }))
        const frame = Buffer.allocUnsafe(bytes.length + 4)
        frame.writeUInt32BE(bytes.length, 0)
        bytes.copy(frame, 4)
        return new Promise((resolveCall, rejectCall) => {
          responses.set(requestId, { resolve: resolveCall, reject: rejectCall, type, payload })
          socket.write(frame)
          setTimeout(() => {
            if (responses.delete(requestId)) rejectCall(new Error(`Timed out: ${type}`))
          }, 5000)
        }).then((result) => {
          if (type === 'system.hello') this.clientToken = result.clientToken
          return result
        })
      },
      async close() {
        socket.destroy()
      }
      }
      resolve(client)
    })

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      while (buffer.length >= 4) {
        const length = buffer.readUInt32BE(0)
        if (buffer.length < length + 4) return
        const message = JSON.parse(buffer.subarray(4, length + 4).toString('utf8'))
        buffer = buffer.subarray(length + 4)
        if (message.requestId && responses.has(message.requestId)) {
          const pending = responses.get(message.requestId)
          responses.delete(message.requestId)
          if (message.ok) pending.resolve(message.result)
          else {
            const recentTerminalStates = pending.type.startsWith('terminal.')
              ? events
                .filter((event) => event.type === 'terminal.state' && event.payload?.sessionId === pending.payload.sessionId)
                .slice(-6)
                .map((event) => `${event.payload.mode}/${event.payload.session?.command_exit_code ?? '—'}`)
                .join(' -> ')
              : ''
            const context = recentTerminalStates ? ` [recent terminal states: ${recentTerminalStates}]` : ''
            const requestData = pending.type === 'terminal.execute' ? ` data=${JSON.stringify(String(pending.payload.data || '').slice(0, 80))}` : ''
            pending.reject(new Error(`${message.error || 'Core rejected request'} (request: ${pending.type}${requestData})${context}`))
          }
        } else if (message.type) {
          const eventIndex = events.length
          events.push(message)
          for (const waiter of [...waiters]) {
            if (eventIndex < waiter.fromIndex) continue
            try {
              if (!waiter.predicate(message)) continue
              waiters.delete(waiter)
              clearTimeout(waiter.timeout)
              waiter.resolve(message)
            } catch (error) {
              waiters.delete(waiter)
              clearTimeout(waiter.timeout)
              waiter.reject(error)
            }
          }
        }
      }
    })
    socket.on('error', (error) => {
      reject(error)
      for (const waiter of waiters) {
        clearTimeout(waiter.timeout)
        waiter.reject(error)
      }
      waiters.clear()
    })
  })
}

function waitForEvent(client, predicate, fromIndex = 0, timeoutMs = 15000) {
  const event = client.events.slice(fromIndex).find(predicate)
  if (event) return Promise.resolve(event)
  return new Promise((resolve, reject) => {
    const waiter = {
      fromIndex,
      predicate,
      resolve,
      reject,
      timeout: setTimeout(() => {
        client.waiters.delete(waiter)
        const requestData = ['terminal.execute', 'terminal.input'].includes(client.lastRequest?.type)
          ? ` data=${JSON.stringify(String(client.lastRequest.payload.data || '').slice(0, 120))}`
          : ''
        reject(new Error(`Timed out waiting for a core event (last request: ${client.lastRequest?.type || 'none'}${requestData}); received: ${client.events.map((item) => `${item.type}:${JSON.stringify({ mode: item.payload?.mode, exit: item.payload?.session?.command_exit_code, cwd: item.payload?.session?.cwd })}`).join(', ')}`))
      }, timeoutMs)
    }
    client.waiters.add(waiter)
  })
}

function waitForEventCount(client, predicate, count, fromIndex = 0, timeoutMs = 15000) {
  if (client.events.slice(fromIndex).filter(predicate).length >= count) return Promise.resolve()
  return waitForEvent(client, () => client.events.slice(fromIndex).filter(predicate).length >= count, fromIndex, timeoutMs).then(() => undefined)
}

function eventText(event) {
  return event.type === 'terminal.output'
    ? Buffer.from(event.payload.data, 'base64').toString('utf8')
    : ''
}

function waitForTerminalText(client, text, fromIndex = 0, timeoutMs = 15000) {
  const textSince = () => client.events.slice(fromIndex).map(eventText).join('')
  return waitForEvent(client, (event) => event.type === 'terminal.output' && textSince().includes(text), fromIndex, timeoutMs)
}

function isTerminalState(event, sessionId, mode) {
  return event.type === 'terminal.state' && event.payload?.sessionId === sessionId && event.payload?.mode === mode
}

function waitForPrompt(client, sessionId, fromIndex, exitCode, timeoutMs = 20000, cwd) {
  return waitForEvent(client, (event) => {
    if (!isTerminalState(event, sessionId, 'shell_prompt')) return false
    const session = event.payload?.session
    const exitMatches = Array.isArray(exitCode)
      ? exitCode.includes(session?.command_exit_code)
      : session?.command_exit_code === exitCode
    if (!exitMatches) return false
    return typeof cwd === 'string' ? session?.cwd === cwd : true
  }, fromIndex, timeoutMs)
}

let commandSequence = 0

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function completionStatus(client, fromIndex, marker) {
  const text = client.events.slice(fromIndex).map(eventText).join('')
  const match = text.match(new RegExp(`${escapeRegExp(marker)}:(-?\\d+)`))
  return match ? Number(match[1]) : undefined
}

function wrapCommandForCompletion(command, marker, statusVariable) {
  // Keep the command at the interactive shell level so `cd` persists. The
  // final subshell makes the shell's OSC 133;D exit code equal to the original
  // command's status after the marker has been emitted.
  return `${command}; ${statusVariable}=$?; printf '\\n${marker}:%s\\n' "$${statusVariable}"; (exit "$${statusVariable}")`
}

async function waitForCommandCompletion(client, sessionId, fromIndex, marker, expectedExitCode, timeoutMs) {
  const markerEvent = await waitForEvent(client, (event) => {
    if (event.type !== 'terminal.output' || event.payload?.sessionId !== sessionId) return false
    return completionStatus(client, fromIndex, marker) !== undefined
  }, fromIndex, timeoutMs)
  const observedExitCode = completionStatus(client, fromIndex, marker)
  if (observedExitCode === undefined) throw new Error(`Completion marker ${marker} was not parseable`)
  if (expectedExitCode !== undefined) {
    const expected = Array.isArray(expectedExitCode) ? expectedExitCode : [expectedExitCode]
    if (!expected.includes(observedExitCode)) {
      throw new Error(`Command ${marker} reported exit ${observedExitCode}; expected ${expected.join(' or ')}`)
    }
  }
  // The marker is the completion boundary for this exact command. Only accept
  // a shell_prompt state emitted after it, with the marker's exit status.
  return waitForPrompt(client, sessionId, client.events.indexOf(markerEvent), observedExitCode, timeoutMs)
}

async function executeRichFor(client, sessionId, token, command, options = {}) {
  const exitCode = Object.prototype.hasOwnProperty.call(options, 'exitCode') ? options.exitCode : 0
  const timeoutMs = options.timeoutMs ?? 20000
  const eventIndex = client.events.length
  const sequence = ++commandSequence
  const marker = `__ORCHESTRA_E2E_DONE_${sequence}_${Date.now()}`
  const statusVariable = `__orchestra_e2e_status_${sequence}`
  const wrappedCommand = wrapCommandForCompletion(command, marker, statusVariable)
  await client.call('terminal.execute', { sessionId, token, data: wrappedCommand })
  await waitForEvent(client, (event) => isTerminalState(event, sessionId, 'command_running'), eventIndex, timeoutMs)
  return {
    eventIndex,
    marker,
    prompt: () => waitForCommandCompletion(client, sessionId, eventIndex, marker, exitCode, timeoutMs)
  }
}

async function executeRich(client, token, command, options = {}) {
  return executeRichFor(client, 'e2e_terminal', token, command, options)
}

async function runInteractiveCheck(client, token, {
  label,
  command,
  ready,
  input,
  output,
  exit
}) {
  const eventIndex = client.events.length
  const textSince = () => client.events.slice(eventIndex).map(eventText).join('')
  const execution = await executeRich(client, token, command)
  await waitForEvent(client, (event) => event.type === 'terminal.output' && ready(textSince()), eventIndex, 20000)
  if (input) {
    await client.call('terminal.input', { sessionId: 'e2e_terminal', token, data: input })
    await waitForEvent(client, (event) => event.type === 'terminal.output' && output(textSince()), eventIndex, 20000)
  }
  await client.call('terminal.input', { sessionId: 'e2e_terminal', token, data: exit })
  await execution.prompt()
  return label
}

async function main() {
  await waitForSocket()
  const client = await connect()
  let terminalToken
  try {
    const mark = (label) => { if (process.env.ORCHESTRA_E2E_DEBUG) console.error(`[e2e] ${label}`) }
    mark('hello')
    const hello = await client.call('system.hello')
    if (hello.protocolVersion !== 2 || !hello.clientToken || !Array.isArray(hello.capabilities)) throw new Error('Invalid system.hello response')
    const interactiveTools = ['python3', 'node', 'nvim', 'vim', 'btop', 'less', 'nano', 'htop', 'fish', 'codex', 'claude', 'gemini', 'opencode']
    const detectedTools = interactiveTools.filter(executableOnPath)

    const workspaceId = 'e2e_workspace'
    await client.call('workspace.save', { id: workspaceId, name: 'E2E', path: workspaceRoot })
    await client.call('environments.save', { environment: { id: 'e2e-local', name: 'E2E local', kind: 'local', status: 'available', config: {} } })
    const environmentOutput = await client.call('environment.exec', { environmentId: 'e2e-local', argv: ['printf', 'e2e-environment\\n'] })
    if (!String(environmentOutput.stdout || '').includes('e2e-environment')) throw new Error('Environment execution bridge failed')
    await client.call('environments.delete', { id: 'e2e-local' })
    const initialGit = await client.call('git.status', { workspaceId, workspaceRoot, path: '.' })
    if (!initialGit.clean || !initialGit.branch) throw new Error('Git status did not read the real repository')
    const refs = await client.call('git.refs', { workspaceId, workspaceRoot, path: '.' })
    if (!Array.isArray(refs.refs) || !refs.refs.some((ref) => ref.kind === 'local')) throw new Error('Git refs did not return local branches')
    const branches = await client.call('git.branch.list', { workspaceId, workspaceRoot, path: '.' })
    if (!Array.isArray(branches.branches) || !branches.branches.length) throw new Error('Git branch list is empty')
    await client.call('git.branch.create', { workspaceId, workspaceRoot, path: '.', name: 'e2e-feature', checkout: true })
    await client.call('git.branch.checkout', { workspaceId, workspaceRoot, path: '.', name: initialGit.branch })
    await client.call('workspace.create_file', { workspaceId, workspaceRoot, path: 'hello.txt' })
    await client.call('workspace.write_file', { workspaceId, workspaceRoot, path: 'hello.txt', content: 'Olá, Orchestra\n' })
    const read = await client.call('workspace.read_file', { workspaceId, workspaceRoot, path: 'hello.txt' })
    if (read.content !== 'Olá, Orchestra\n') throw new Error('Workspace UTF-8 round trip failed')
    await client.call('git.stage', { workspaceId, workspaceRoot, file: 'hello.txt' })
    await client.call('git.commit', { workspaceId, workspaceRoot, path: '.', message: 'e2e file' })
    try {
      await client.call('workspace.read_file', { workspaceId, workspaceRoot, path: '../outside.txt' })
      throw new Error('Workspace path traversal was accepted')
    } catch (error) {
      if (!String(error.message).match(/outside|Path|workspace/i)) throw error
    }

    const terminal = await client.call('terminal.spawn', {
      sessionId: 'e2e_terminal',
      workspaceId,
      workspaceRoot,
      cwd: '.',
      cols: 100,
      rows: 30
    })
    terminalToken = terminal.token
    mark('initial spawned')
    await waitForEvent(client, (event) => event.type === 'terminal.output' && event.payload?.sessionId === 'e2e_terminal')
    const promptState = await waitForEvent(client, (event) => isTerminalState(event, 'e2e_terminal', 'shell_prompt'))
    if (promptState.payload.session?.cwd !== workspaceRoot) throw new Error('OSC 7 did not report the terminal working directory')

    // The documented bootstrap commands must work from the real PTY, not
    // only from a host-side IPC client. This is the path agents use when
    // they discover the connected canvas through the injected environment.
    const doctorFromPty = await executeRich(client, terminalToken, 'orchestra doctor')
    mark('doctor sent')
    await waitForTerminalText(client, 'contextDirExists', doctorFromPty.eventIndex)
    await doctorFromPty.prompt()
    const connectionsFromPty = await executeRich(client, terminalToken, 'orchestra connections')
    await waitForTerminalText(client, '[]', connectionsFromPty.eventIndex)
    await connectionsFromPty.prompt()
    const agentsFromPty = await executeRich(client, terminalToken, 'orchestra agents')
    mark('bootstrap cli done')
    await waitForTerminalText(client, 'e2e_terminal', agentsFromPty.eventIndex)
    await agentsFromPty.prompt()

    // Exercise the public screen/type/key/wait CLI contract against the live
    // PTY. Type deliberately omits Enter; the explicit key is the only
    // operation that submits the command.
    const cliTypeMarker = `cli-type-${Date.now()}`
    runCli(['terminal', 'type', 'e2e_terminal', `printf '${cliTypeMarker}'`], 'e2e_terminal', terminalToken)
    runCli(['terminal', 'key', 'e2e_terminal', 'enter'], 'e2e_terminal', terminalToken)
    const cliWait = runCli(['terminal', 'wait-for', 'e2e_terminal', cliTypeMarker, '--timeout-secs', '20'], 'e2e_terminal', terminalToken)
    if (!/"matched"\s*:\s*true/.test(cliWait)) throw new Error('CLI terminal wait-for did not observe the submitted command')
    const cliScreen = runCli(['terminal', 'screen', 'e2e_terminal', '--plain'], 'e2e_terminal', terminalToken)
    mark('host cli terminal done')
    if (!cliScreen.includes(cliTypeMarker)) throw new Error('CLI terminal screen did not return the current PTY text')

    // A wrong PTY token must be rejected and must never be echoed by the CLI
    // error path. This protects the terminal credential boundary used by the
    // connected-agent skill.
    const redactionProbe = 'e2e-super-secret-token'
    const rejected = runCli(['connections'], 'e2e_terminal', redactionProbe, { expectFailure: true })
    if (!/unauthorized/i.test(rejected) || rejected.includes(redactionProbe)) {
      throw new Error('CLI authentication failure was not safely rejected/redacted')
    }

    const detached = await client.call('terminal.detach', { sessionId: 'e2e_terminal', token: terminalToken })
    if (detached.status !== 'detached' || detached.state?.view?.attached !== false) throw new Error('Terminal detach did not mark the view detached')
    const reattached = await client.call('terminal.attach', { sessionId: 'e2e_terminal', token: terminalToken })
    if (!reattached.scrollback || reattached.state?.view?.attached !== true) throw new Error('Terminal reattach did not restore scrollback and view ownership')

    const pathCompletions = await client.call('terminal.complete', { sessionId: 'e2e_terminal', token: terminalToken, kind: 'path', value: '', cwd: workspaceRoot })
    if (!pathCompletions.items?.some((item) => item.label === 'README.md')) throw new Error('Path completion did not read the terminal CWD')
    const executableCompletions = await client.call('terminal.complete', { sessionId: 'e2e_terminal', token: terminalToken, kind: 'executable', value: 'pri', cwd: workspaceRoot })
    if (!executableCompletions.items?.some((item) => item.label === 'printf')) throw new Error('Executable completion did not return PATH commands')
    await client.call('terminal.resize', { sessionId: 'e2e_terminal', token: terminalToken, cols: 100, rows: 30 })

    // Resize while a long shell command is still being edited. This is the
    // PTY-side companion to the renderer editor test; no command is executed.
    const resizeEditEventIndex = client.events.length
    const resizeEditMarker = `resize-edit-${Date.now()}`
    await client.call('terminal.input', { sessionId: 'e2e_terminal', token: terminalToken, data: `printf '${resizeEditMarker}'` })
    await Promise.all(Array.from({ length: 80 }, (_, index) => client.call('terminal.resize', {
      sessionId: 'e2e_terminal',
      token: terminalToken,
      cols: 20 + (index % 120),
      rows: 4 + (index % 60)
    })))
    await waitForTerminalText(client, resizeEditMarker, resizeEditEventIndex)
    await client.call('terminal.input', { sessionId: 'e2e_terminal', token: terminalToken, data: '\u0003' })
    // Bash reports an interrupted editable line as 130; zsh's line editor
    // reports the redraw boundary as 0. Both are valid because no command ran.
    const resizeCancelExit = path.basename(process.env.ORCHESTRA_SHELL || '') === 'bash' ? [130] : [0]
    await waitForPrompt(client, 'e2e_terminal', resizeEditEventIndex, resizeCancelExit)

    const terminalEnvEventIndex = client.events.length
    const terminalEnv = await executeRich(client, terminalToken, "printf '%s|%s\\n' \"$TERM\" \"$COLORTERM\"")
    await waitForEvent(client, (event) => event.type === 'terminal.output' && Buffer.from(event.payload.data, 'base64').toString('utf8').includes('xterm-256color|truecolor'), terminalEnvEventIndex)
    await terminalEnv.prompt()
    const npmEnvironment = await executeRich(client, terminalToken, "if [ -n \"${npm_config_prefix-}\" ] || [ -n \"${NPM_CONFIG_PREFIX-}\" ]; then false; else true; fi")
    await npmEnvironment.prompt()
    const firstCommandEventIndex = client.events.length
    const firstCommand = await executeRich(client, terminalToken, "printf 'e2e-ação\\n'")
    const output = await waitForEvent(client, (event) => {
      if (event.type !== 'terminal.output' || event.payload?.sessionId !== 'e2e_terminal') return false
      const text = Buffer.from(event.payload.data, 'base64').toString('utf8')
      if (/\u001b\]133;|\u001b\]7;/.test(text)) throw new Error('Shell integration markers leaked into visible terminal output')
      return text.includes('e2e-ação')
    }, firstCommandEventIndex)
    if (!output) throw new Error('Terminal output was not delivered')
    const finishedState = await firstCommand.prompt()
    if (!finishedState) throw new Error('Shell integration did not report command completion')
    const firstCommandText = client.events
      .slice(firstCommandEventIndex)
      .filter((event) => event.type === 'terminal.output')
      .map((event) => Buffer.from(event.payload.data, 'base64').toString('utf8'))
      .join('')
    if (!firstCommandText.includes('e2e-ação')) throw new Error('Rich command output was not retained after echo reconciliation')

    const cdEventIndex = client.events.length
    const cd = await executeRich(client, terminalToken, 'cd /tmp')
    await waitForPrompt(client, 'e2e_terminal', cdEventIndex, 0, 20000, '/tmp')

    const multilineEventIndex = client.events.length
    const multiline = await executeRich(client, terminalToken, "printf 'line-one\\n'\nprintf 'line-two\\n'")
    await waitForEvent(client, (event) => {
      if (event.type !== 'terminal.output') return false
      return Buffer.from(event.payload.data, 'base64').toString('utf8').includes('line-two')
    }, multilineEventIndex)
    await multiline.prompt()

    const falseEventIndex = client.events.length
    const falseCommand = await executeRich(client, terminalToken, 'false', { exitCode: 1 })
    await falseCommand.prompt()

    const seqStressEventIndex = client.events.length
    const seqStress = await executeRich(client, terminalToken, 'seq 1 100000')
    await seqStress.prompt()
    const seqStressText = client.events.slice(seqStressEventIndex)
      .filter((event) => event.type === 'terminal.output')
      .map((event) => Buffer.from(event.payload.data, 'base64').toString('utf8'))
      .join('')
    const seqLines = stripTerminalControls(seqStressText).split(/\r?\n/).filter((line) => /^\d+$/.test(line.trim()))
    const seqNumbers = new Set(seqLines)
    const missingSeq = seqLines.length < 100000 ? Array.from({ length: 100000 }, (_, index) => String(index + 1)).find((value) => !seqNumbers.has(value)) : undefined
    if (seqLines.length < 100000 || !seqLines.includes('100000')) throw new Error(`seq 1 100000 output was truncated or corrupted (${seqLines.length} numeric lines; missing ${missingSeq || 'none'}; first ${seqLines.slice(0, 2).join(',')}; last ${seqLines.slice(-2).join(',')})`)

    const yesStressEventIndex = client.events.length
    const yesStress = await executeRich(client, terminalToken, 'yes | head -n 100000')
    await yesStress.prompt()
    const yesStressText = client.events.slice(yesStressEventIndex)
      .filter((event) => event.type === 'terminal.output')
      .map((event) => Buffer.from(event.payload.data, 'base64').toString('utf8'))
      .join('')
    const yesLines = stripTerminalControls(yesStressText).split(/\r?\n/).filter((line) => line.trim() === 'y')
    if (yesLines.length < 100000) throw new Error(`yes | head -n 100000 output was not delivered (${yesLines.length} lines)`)

    await Promise.all(Array.from({ length: 40 }, (_, index) => client.call('terminal.resize', {
      sessionId: 'e2e_terminal', token: terminalToken, cols: 40 + (index % 80), rows: 8 + (index % 24)
    })))
    const unicodeStressEventIndex = client.events.length
    const unicodeStress = await executeRich(client, terminalToken, "printf 'Olá 🌍 👩‍💻 你好\\n'")
    await waitForEvent(client, (event) => event.type === 'terminal.output' && Buffer.from(event.payload.data, 'base64').toString('utf8').includes('Olá 🌍 👩‍💻 你好'), unicodeStressEventIndex)
    await unicodeStress.prompt()

    const alternateScreenEventIndex = client.events.length
    const alternateScreen = await executeRich(client, terminalToken, "printf '\\033[?1049h'; printf 'alternate-screen\\n'; printf '\\033[?1049l'")
    await waitForEvent(client, (event) => event.type === 'terminal.output' && Buffer.from(event.payload.data, 'base64').toString('utf8').includes('alternate-screen'), alternateScreenEventIndex)
    await alternateScreen.prompt()

    if (executableOnPath('codex')) {
      const codexEventIndex = client.events.length
      const codex = await executeRich(client, terminalToken, 'codex --version')
      await waitForEvent(client, (event) => event.type === 'terminal.output' && /codex/i.test(stripTerminalControls(Buffer.from(event.payload.data, 'base64').toString('utf8'))), codexEventIndex)
      await codex.prompt()
    }

    const pasteEventIndex = client.events.length
    await client.call('terminal.input', {
      sessionId: 'e2e_terminal',
      token: terminalToken,
      data: "\u001b[200~sleep 0.5; printf 'paste-sentinel\\n'\u001b[201~"
    })
    await waitForTerminalText(client, 'paste-sentinel', pasteEventIndex)
    if (client.events.slice(pasteEventIndex).some((event) => isTerminalState(event, 'e2e_terminal', 'command_running'))) {
      throw new Error('Bracketed multiline paste executed before Enter')
    }
    await client.call('terminal.input', { sessionId: 'e2e_terminal', token: terminalToken, data: '\r' })
    await waitForEvent(client, (event) => isTerminalState(event, 'e2e_terminal', 'command_running'), pasteEventIndex)
    await waitForEvent(client, (event) => event.type === 'terminal.output' && Buffer.from(event.payload.data, 'base64').toString('utf8').includes('paste-sentinel'), pasteEventIndex)
    await waitForPrompt(client, 'e2e_terminal', pasteEventIndex, 0)

    // Exercise the non-bracketed-paste fallback used by the renderer when a
    // shell (or a shell line editor) has not enabled DECSET 2004. The one LF
    // is framed as a bracketed paste even in this state: readline accepts the
    // frame, while zle avoids the quoted-LF/accept-line ambiguity. Neither
    // command may start until the final ordinary Enter submits the buffer.
    // Turn the line editor's bracketed-paste integration off explicitly so
    // this probe exercises the same state that xterm reports as
    // `bracketedPasteMode === false` (rather than accidentally feeding the
    // fallback into a bracket-aware editor).
    const disableBracketedPaste = path.basename(process.env.ORCHESTRA_SHELL || '') === 'bash'
      ? "bind 'set enable-bracketed-paste off'; printf '\\033[?2004l'"
      // zle_bracketed_paste is an array parameter, not a zsh option. Clearing
      // the parameter makes this a real line-editor-off probe instead of
      // silently exercising zle's normal bracketed-paste path.
      : "zle_bracketed_paste=(); printf '\\033[?2004l'"
    const disableBracketedCommand = await executeRich(client, terminalToken, disableBracketedPaste)
    await disableBracketedCommand.prompt()

    const fallbackEventIndex = client.events.length
    // Keep the output sentinels out of the editable command text. zle redraws
    // that text several times before execution; using octal printf escapes
    // lets the transcript assertion select the real PTY output unambiguously.
    const fallbackOne = '\\146\\141\\154\\154\\142\\141\\143\\153\\055\\157\\156\\145\\n'
    const fallbackTwo = '\\146\\141\\154\\154\\142\\141\\143\\153\\055\\164\\167\\157\\n'
    const fallbackInput = `\u001b[200~printf '${fallbackOne}'\nprintf '${fallbackTwo}'\u001b[201~`
    await client.call('terminal.input', {
      sessionId: 'e2e_terminal',
      token: terminalToken,
      data: fallbackInput
    })
    await delay(120)
    if (client.events.slice(fallbackEventIndex).some((event) => isTerminalState(event, 'e2e_terminal', 'command_running'))) {
      throw new Error('Framed multiline fallback submitted before ordinary Enter')
    }
    await client.call('terminal.input', { sessionId: 'e2e_terminal', token: terminalToken, data: '\r' })
    await waitForEvent(client, (event) => isTerminalState(event, 'e2e_terminal', 'command_running'), fallbackEventIndex)
    await waitForTerminalText(client, 'fallback-one', fallbackEventIndex)
    await waitForTerminalText(client, 'fallback-two', fallbackEventIndex)
    const fallbackOutput = stripTerminalControls(client.events.slice(fallbackEventIndex).map(eventText).join('')).replace(/\r/g, '')
    const fallbackOneOutput = fallbackOutput.lastIndexOf('fallback-one')
    const fallbackTwoOutput = fallbackOutput.lastIndexOf('fallback-two')
    if (fallbackOneOutput < 0 || fallbackTwoOutput <= fallbackOneOutput || !/^fallback-one\nfallback-two\n/.test(fallbackOutput.slice(fallbackOneOutput))) {
      throw new Error('PTY/render transcript contains an extra blank line between one framed newline and shell output')
    }
    await waitForPrompt(client, 'e2e_terminal', fallbackEventIndex, 0)
    mark('multiline fallback done')

    const readEventIndex = client.events.length
    const readCommand = await executeRich(client, terminalToken, "printf 'Name: '; read -r name; printf 'hello-%s\\n' \"$name\"")
    // terminal.execute only confirms the handoff was accepted. Wait for the
    // command's own read prompt before delivering Ada; otherwise bash can
    // consume the input while still processing the shell line.
    await waitForTerminalText(client, 'Name:', readEventIndex)
    await client.call('terminal.input', { sessionId: 'e2e_terminal', token: terminalToken, data: 'Ada\r' })
    await waitForEvent(client, (event) => {
      if (event.type !== 'terminal.output') return false
      return Buffer.from(event.payload.data, 'base64').toString('utf8').includes('hello-Ada')
    }, readEventIndex)
    await readCommand.prompt()

    const interruptEventIndex = client.events.length
    const interruptReady = `interrupt-ready-${Date.now()}`
    const interruptReadyHex = Buffer.from(interruptReady, 'utf8').toString('hex')
    await executeRich(
      client,
      terminalToken,
      `python3 -c 'import time; print(bytes.fromhex("${interruptReadyHex}").decode(), flush=True); time.sleep(30)'`,
      { exitCode: undefined, timeoutMs: 40000 }
    )
    // Waiting for output produced by the foreground process removes the race
    // where Ctrl+C could arrive after the execute handoff but before `sleep`
    // had actually taken control of the PTY foreground process group.
    await waitForTerminalText(client, interruptReady, interruptEventIndex)
    await client.call('terminal.input', { sessionId: 'e2e_terminal', token: terminalToken, data: '\u0003' })
    await waitForEvent(client, (event) => {
      if (event.type !== 'terminal.state' || event.payload?.sessionId !== 'e2e_terminal') return false
      return typeof event.payload?.session?.command_exit_code === 'number' && event.payload.session.command_exit_code !== 0
    }, interruptEventIndex, 40000)
    await waitForEvent(
      client,
      (event) => isTerminalState(event, 'e2e_terminal', 'shell_prompt'),
      interruptEventIndex,
      40000
    )

    // Raw applications must receive distinguishable modified Enter bytes;
    // this PTY probe exercises the Ghostty modifyOtherKeys compatibility form
    // without depending on an app-specific allowlist.
    const modifiedEnterEventIndex = client.events.length
    const modifiedEnterCommand = await executeRich(client, terminalToken, "python3 -c 'import os; print(os.read(0,64).hex())'")
    const modifiedEnterBytes = '\u001b[27;5;13~\u001b[27;2;13~'
    const modifiedEnterHex = Buffer.from(modifiedEnterBytes, 'utf8').toString('hex')
    await client.call('terminal.input', { sessionId: 'e2e_terminal', token: terminalToken, data: `${modifiedEnterBytes}\n` })
    await waitForEvent(client, (event) => event.type === 'terminal.output' && Buffer.from(event.payload.data, 'base64').toString('utf8').includes(modifiedEnterHex), modifiedEnterEventIndex)
    await modifiedEnterCommand.prompt()

    const interactiveChecks = []
    if (executableOnPath('python3')) {
      interactiveChecks.push(await runInteractiveCheck(client, terminalToken, {
        label: 'python3-repl',
        command: 'python3 -q',
        ready: (text) => text.includes('>>>'),
        input: 'print("orchestra-python-repl")\r',
        output: (text) => text.includes('orchestra-python-repl'),
        exit: 'exit()\r'
      }))
    }
    if (executableOnPath('node')) {
      interactiveChecks.push(await runInteractiveCheck(client, terminalToken, {
        label: 'node-repl',
        command: 'node -i',
        ready: (text) => text.includes('Welcome to Node.js') || /(^|\n)> ?$/.test(text),
        input: 'console.log("orchestra-node-repl")\r',
        output: (text) => text.includes('orchestra-node-repl'),
        exit: '.exit\r'
      }))
    }
    const tui = ['nvim', 'vim', 'btop'].find(executableOnPath)
    if (tui) {
      const tuiConfig = tui === 'btop'
        ? { command: 'btop', exit: 'q' }
        : tui === 'nvim'
          ? { command: 'nvim --clean', exit: ':qa!\r' }
          : { command: 'vim -Nu NONE -n', exit: ':qa!\r' }
      interactiveChecks.push(await runInteractiveCheck(client, terminalToken, {
        label: `${tui}-alternate-screen`,
        command: tuiConfig.command,
        ready: (text) => text.includes('\u001b[?1049h') || text.includes('\u001b[?1h'),
        exit: tuiConfig.exit
      }))
    }
    if (!interactiveChecks.length) throw new Error('No supported REPL/TUI was available for interactive PTY validation')

    const attached = await client.call('terminal.attach', { sessionId: 'e2e_terminal' })
    if (!attached.scrollback) throw new Error('Terminal reattach did not return scrollback')
    await client.call('terminal.kill', { sessionId: 'e2e_terminal', token: terminalToken })
    terminalToken = null
    mark('initial killed')

    // Directly-created agents bypass the visible shell prompt. Verify that
    // this command-line spawn path still receives intact Ghostty-compatible
    // Ctrl+Enter and Shift+Enter key events. Direct launches start in the
    // legacy protocol and switch to Kitty CSI-u only after the child
    // negotiates it.
    const directSessionId = 'e2e_direct_input'
    const directToken = (await client.call('terminal.spawn', {
      sessionId: directSessionId,
      workspaceId,
      workspaceRoot,
      cwd: '.',
      cols: 80,
      rows: 24,
      command: "python3 -c 'import os; print(os.read(0,64).hex(), flush=True)'"
    })).token
    const directInputIndex = client.events.length
    const directModifiedEnter = '\u001b[27;5;13~\u001b[27;2;13~'
    await client.call('terminal.input', { sessionId: directSessionId, token: directToken, data: `${directModifiedEnter}\n` })
    const directModifiedEnterHex = Buffer.from(directModifiedEnter, 'utf8').toString('hex')
    await waitForEvent(client, (event) => {
      if (event.type !== 'terminal.output' || event.payload?.sessionId !== directSessionId) return false
      return eventText(event).includes(directModifiedEnterHex)
    }, directInputIndex)
    await client.call('terminal.kill', { sessionId: directSessionId, token: directToken }).catch(() => undefined)
    mark('direct modified enter delivered')

    const sourceNode = { id: 'e2e_source', kind: 'terminal', x: 0, y: 0, width: 320, height: 220, properties: {} }
    const targetNode = { id: 'e2e_target', kind: 'terminal', x: 400, y: 0, width: 320, height: 220, properties: {} }
    await client.call('canvas.node.save', { workspaceId, node: sourceNode })
    await client.call('canvas.node.save', { workspaceId, node: targetNode })
    await client.call('canvas.edge.save', { workspaceId, edge: { id: 'e2e_edge', source: 'e2e_source', target: 'e2e_target', permissions: ['send_prompt', 'receive_response'] } })
    let sourceToken
    let targetToken
    let visibleTargetToken
    let visibleTargetSessionId
    try {
      const sourceSpawnEventIndex = client.events.length
      sourceToken = (await client.call('terminal.spawn', { sessionId: 'e2e_source', workspaceId, workspaceRoot, cwd: '.', cols: 80, rows: 24 })).token
      targetToken = (await client.call('terminal.spawn', { sessionId: 'e2e_target', workspaceId, workspaceRoot, cwd: '.', cols: 80, rows: 24 })).token
      await waitForEvent(client, (event) => isTerminalState(event, 'e2e_source', 'shell_prompt'), sourceSpawnEventIndex)
      mark('source target spawned')

      // A connected agent must be able to use every browser operation that
      // the renderer exposes. This covers the complete authorization path in
      // core, independently of Electron's portal transport socket.
      const browserNode = { id: 'e2e_browser', kind: 'browser', x: 800, y: 0, width: 640, height: 420, properties: { portalId: 'e2e_browser', url: 'about:blank' } }
      await client.call('canvas.node.save', { workspaceId, node: browserNode })
      await client.call('canvas.edge.save', {
        workspaceId,
        edge: {
          id: 'e2e_browser_edge',
          // Deliberately use the reverse visual direction. This was the
          // production bug: browser -> terminal edges used to get generic
          // permissions even though their effective resource direction is
          // terminal -> browser.
          source: 'e2e_browser',
          target: 'e2e_source',
          permissions: ['read', 'write', 'share_context']
        }
      })
      for (const permission of ['inspect', 'navigate', 'control', 'screenshot']) {
        const authorization = await client.call('portal.authorize', {
          sessionId: 'e2e_source',
          token: sourceToken,
          portalId: 'e2e_browser',
          permission
        })
        if (!authorization.allowed || authorization.permission !== permission) {
          throw new Error(`Connected browser did not authorize ${permission}`)
        }
      }
      const browserConnections = await client.call('connection.list', { sessionId: 'e2e_source', token: sourceToken })
      const browserConnection = browserConnections.find((connection) => connection.nodeId === 'e2e_browser')
      if (!browserConnection || !browserConnection.permissions.includes('control')) {
        throw new Error('Connected browser permissions were not visible to the source agent')
      }
      mark('browser permissions authorized')

      // This is the authenticated canvas-visible spawn used by the CLI and
      // connected agents. Verify both halves of the operation: a live PTY,
      // the persisted node, and the access-control cable.
      const visible = await client.call('terminal.spawn.visible', {
        sessionId: 'e2e_source',
        token: sourceToken,
        cwd: '.',
        cols: 80,
        rows: 24,
        title: 'E2E visible terminal',
        agent: 'E2E visible agent',
        connectTo: 'self'
      })
      mark('visible spawned')
      visibleTargetSessionId = visible.sessionId
      visibleTargetToken = visible.token
      if (!visible.visible || !visibleTargetSessionId || !visibleTargetToken) throw new Error('terminal.spawn.visible did not return a live connected terminal')
      const visibleContext = await client.call('canvas.node.context', { sessionId: visibleTargetSessionId, token: visibleTargetToken })
      if (visibleContext.kind !== 'terminal' || visibleContext.workspaceId !== workspaceId) throw new Error('Visible terminal was not persisted in the selected workspace')
      const visibleEdges = await client.call('canvas.edge.list', { workspaceId })
      const visibleEdge = visibleEdges.find((edge) => edge.source === 'e2e_source' && edge.target === visibleTargetSessionId)
      if (!visibleEdge || !visibleEdge.permissions.includes('send_prompt')) throw new Error('Visible terminal connection/capabilities were not persisted')
      const sourceConnections = await client.call('connection.list', { sessionId: 'e2e_source', token: sourceToken })
      if (!sourceConnections.some((connection) => connection.nodeId === visibleTargetSessionId)) throw new Error('connection.list omitted the visible terminal')

      // Notes created through the authenticated bridge must be available
      // immediately, before any Electron context watcher has synchronized
      // connectedNotes.json into the PTY directory.
      const note = await client.call('note.create', {
        sessionId: 'e2e_source',
        token: sourceToken,
        title: 'E2E note',
        content: 'first',
        color: '#fff2a8'
      })
      mark('note created')
      const sourceAfterNoteCreate = await client.call('terminal.state', { sessionId: 'e2e_source', token: sourceToken })
      if (sourceAfterNoteCreate.process?.status !== 'running') throw new Error(`Source terminal exited during note.create: ${JSON.stringify(sourceAfterNoteCreate)}`)
      if (!note.noteId || !note.permissions.includes('read') || !note.permissions.includes('append')) throw new Error('Authenticated note.create did not return scoped permissions')
      const noteId = note.noteId
      const noteInitial = await client.call('note.read', { sessionId: 'e2e_source', token: sourceToken, noteId })
      if (noteInitial.content !== 'first') throw new Error('New note was not readable immediately')
      await client.call('note.write', { sessionId: 'e2e_source', token: sourceToken, noteId, content: 'second\nlinha' })
      const sourceAfterNoteWrite = await client.call('terminal.state', { sessionId: 'e2e_source', token: sourceToken })
      if (sourceAfterNoteWrite.process?.status !== 'running') throw new Error(`Source terminal exited during note.write: ${JSON.stringify(sourceAfterNoteWrite)}`)
      const noteAfterWrite = await client.call('note.read', { sessionId: 'e2e_source', token: sourceToken, noteId })
      if (noteAfterWrite.content !== 'second\nlinha') throw new Error('Note write was not immediately visible')
      await client.call('note.append', { sessionId: 'e2e_source', token: sourceToken, noteId, content: '\nthird' })
      const noteAfterAppend = await client.call('note.read', { sessionId: 'e2e_source', token: sourceToken, noteId })
      if (noteAfterAppend.content !== 'second\nlinha\nthird') throw new Error('Note append did not preserve canonical content')
      const sourceAfterNoteAppend = await client.call('terminal.state', { sessionId: 'e2e_source', token: sourceToken })
      if (sourceAfterNoteAppend.process?.status !== 'running') throw new Error(`Source terminal exited during note.append: ${JSON.stringify(sourceAfterNoteAppend)}`)
      await delay(200)
      const sourceAfterNoteSettled = await client.call('terminal.state', { sessionId: 'e2e_source', token: sourceToken })
      if (sourceAfterNoteSettled.process?.status !== 'running') throw new Error(`Source terminal exited after note flow: ${JSON.stringify(sourceAfterNoteSettled)}`)

      // The documented nested CLI form must use the same authenticated path.
      const sourceBeforeCli = await client.call('terminal.screen', { sessionId: 'e2e_source', token: sourceToken })
      if (!sourceBeforeCli.sessionId) throw new Error('Source terminal disappeared before CLI note create')
      const cliNoteCommand = await executeRichFor(client, 'e2e_source', sourceToken, 'orchestra note create --title "CLI E2E" --content "cli-content"')
      mark('cli note sent')
      await waitForTerminalText(client, 'noteId', cliNoteCommand.eventIndex)
      await cliNoteCommand.prompt()
      const cliOutput = client.events.slice(cliNoteCommand.eventIndex)
        .filter((event) => event.type === 'terminal.output')
        .map((event) => Buffer.from(event.payload.data, 'base64').toString('utf8'))
        .join('')
      const cliNoteId = cliOutput.match(/"noteId"\s*:\s*"([^"]+)"/)?.[1]
      if (!cliNoteId) throw new Error('CLI note create did not return a noteId')
      const cliNoteRead = runCli(['note-read', cliNoteId], 'e2e_source', sourceToken)
      if (!cliNoteRead.includes('cli-content')) throw new Error('CLI note-read could not read a note immediately after CLI create')

      const requestId = 'e2e_cancel_request'
      const cancellationEventIndex = client.events.length
      const pendingAsk = client.call('agent.ask', { sessionId: 'e2e_source', token: sourceToken, agent: 'e2e_target', message: 'sleep 5', wait: true, timeoutSecs: 20, requestId })
      mark('ask sent')
      await waitForEvent(client, (event) => event.type === 'agent.request.progress' && event.payload?.requestId === requestId && ['delivering', 'generating'].includes(event.payload?.status), cancellationEventIndex)
      await client.call('agent.request.cancel', { sessionId: 'e2e_source', token: sourceToken, requestId })
      const cancelled = await pendingAsk
      if (cancelled.status !== 'cancelled') throw new Error(`Agent cancellation returned ${cancelled.status}`)
      const history = await client.call('agent.request-audit.list', { sessionId: 'e2e_source', token: sourceToken, limit: 50 })
      if (!history.some((entry) => entry.id === requestId && entry.status === 'cancelled')) throw new Error('Scoped request history omitted the cancelled request')
      const cliHistory = runCli(['request-history'], 'e2e_source', sourceToken)
      if (!cliHistory.includes(requestId)) throw new Error('CLI request-history omitted the authenticated request')
    } finally {
      if (sourceToken) await client.call('terminal.kill', { sessionId: 'e2e_source', token: sourceToken }).catch(() => undefined)
      if (targetToken) await client.call('terminal.kill', { sessionId: 'e2e_target', token: targetToken }).catch(() => undefined)
      if (visibleTargetToken && visibleTargetSessionId) await client.call('terminal.kill', { sessionId: visibleTargetSessionId, token: visibleTargetToken }).catch(() => undefined)
    }
    console.log(JSON.stringify({ ok: true, protocol: hello.protocolVersion, shell: process.env.ORCHESTRA_SHELL || process.env.SHELL || 'auto', detectedTools, interactiveChecks, terminal: 'spawn-input-detach-reattach-kill', workspace: 'secure-utf8-atomic' }))
  } finally {
    if (terminalToken) {
      try {
        const cleanup = await connect()
        cleanup.clientToken = (await cleanup.call('system.hello')).clientToken
        await cleanup.call('terminal.kill', { sessionId: 'e2e_terminal', token: terminalToken })
        await cleanup.close()
      } catch { /* the daemon is being stopped below */ }
    }
    await client.close()
    core.kill('SIGTERM')
    await delay(100)
    fs.rmSync(temporaryRoot, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error.stack || error)
  core.kill('SIGTERM')
  fs.rmSync(temporaryRoot, { recursive: true, force: true })
  process.exitCode = 1
})
