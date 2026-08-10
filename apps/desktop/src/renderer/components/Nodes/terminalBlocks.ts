export type TerminalBlockState = 'pending' | 'running' | 'success' | 'error' | 'interrupted'

export interface TerminalOutputBuffer {
  chunks: string[]
  byteLength: number
}

export interface TerminalBlock {
  id: string
  sessionId: string
  command: string
  cwd: string
  startedAt: number
  finishedAt?: number
  durationMs?: number
  exitCode?: number
  state: TerminalBlockState
  output: TerminalOutputBuffer
  interactive?: boolean
}

export interface StartBlockOptions {
  command: string
  cwd: string
  interactive?: boolean
}

function createId(): string {
  try {
    return `block-${crypto.randomUUID()}`
  } catch {
    return `block-${Date.now()}-${Math.random().toString(36).slice(2)}`
  }
}

export class TerminalBlockStore {
  private blocksValue: TerminalBlock[] = []
  private activeBlockId: string | null = null
  private readonly maxBlocks: number

  constructor(maxBlocks = 2000) {
    this.maxBlocks = Math.max(1, Math.floor(maxBlocks))
  }

  get blocks(): TerminalBlock[] {
    return this.blocksValue.map((block) => ({ ...block, output: { ...block.output, chunks: [...block.output.chunks] } }))
  }

  begin(sessionId: string, options: StartBlockOptions): TerminalBlock {
    const block: TerminalBlock = {
      id: createId(),
      sessionId,
      command: options.command,
      cwd: options.cwd,
      startedAt: Date.now(),
      state: 'pending',
      output: { chunks: [], byteLength: 0 },
      interactive: options.interactive
    }
    this.blocksValue = [...this.blocksValue, block]
    if (this.blocksValue.length > this.maxBlocks) this.blocksValue = this.blocksValue.slice(-this.maxBlocks)
    this.activeBlockId = block.id
    return block
  }

  markRunning(): void {
    const block = this.active()
    if (block && block.state === 'pending') block.state = 'running'
  }

  appendOutput(sessionId: string, base64: string): void {
    const block = this.active()
    if (!block || block.sessionId !== sessionId || !base64) return
    block.output.chunks.push(base64)
    try {
      block.output.byteLength += atob(base64).length
    } catch {
      block.output.byteLength += base64.length
    }
    if (block.state === 'pending') block.state = 'running'
  }

  finish(exitCode: number | undefined, finishedAt = Date.now()): TerminalBlock | undefined {
    const block = this.active()
    if (!block) return undefined
    block.finishedAt = finishedAt
    block.durationMs = Math.max(0, finishedAt - block.startedAt)
    block.exitCode = exitCode
    block.state = exitCode === 0
      ? 'success'
      : exitCode === 130 || exitCode === 137
        ? 'interrupted'
        : 'error'
    this.activeBlockId = null
    return block
  }

  remove(id: string): void {
    this.blocksValue = this.blocksValue.filter((block) => block.id !== id)
    if (this.activeBlockId === id) this.activeBlockId = null
  }

  active(): TerminalBlock | undefined {
    return this.blocksValue.find((block) => block.id === this.activeBlockId)
  }
}

export function terminalBlockOutputText(block: TerminalBlock): string {
  return block.output.chunks.map((chunk) => {
    try {
      return new TextDecoder().decode(Uint8Array.from(atob(chunk), (character) => character.charCodeAt(0)))
    } catch {
      return ''
    }
  }).join('')
}
