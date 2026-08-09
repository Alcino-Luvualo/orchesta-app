import { fuzzyScore } from './shellCommandParser'

export interface CommandHistoryEntry {
  id: string
  command: string
  cwd: string
  shell: string
  startedAt: number
  finishedAt?: number
  durationMs?: number
  exitCode?: number
  sessionId: string
  terminalId: string
  workspaceId?: string
}

const MAX_ENTRIES = 500

function createId(): string {
  try {
    return crypto.randomUUID()
  } catch {
    return `history-${Date.now()}-${Math.random().toString(36).slice(2)}`
  }
}

function storageKey(sessionId: string): string {
  return `orchestra.terminal.history.${sessionId}`
}

export class CommandHistoryStore {
  private entriesValue: CommandHistoryEntry[]

  constructor(private readonly sessionId: string, private readonly terminalId = sessionId) {
    this.entriesValue = this.load()
  }

  get entries(): CommandHistoryEntry[] {
    return [...this.entriesValue]
  }

  start(command: string, metadata: { cwd: string; shell?: string; workspaceId?: string }): CommandHistoryEntry {
    const entry: CommandHistoryEntry = {
      id: createId(),
      command,
      cwd: metadata.cwd,
      shell: metadata.shell || 'unknown',
      startedAt: Date.now(),
      sessionId: this.sessionId,
      terminalId: this.terminalId,
      workspaceId: metadata.workspaceId
    }
    this.entriesValue = [entry, ...this.entriesValue].slice(0, MAX_ENTRIES)
    this.persist()
    return entry
  }

  finish(id: string, exitCode: number | undefined, finishedAt = Date.now()): void {
    this.entriesValue = this.entriesValue.map((entry) => entry.id === id
      ? { ...entry, finishedAt, durationMs: Math.max(0, finishedAt - entry.startedAt), exitCode }
      : entry)
    this.persist()
  }

  remove(id: string): void {
    this.entriesValue = this.entriesValue.filter((entry) => entry.id !== id)
    this.persist()
  }

  search(query: string, limit = 50): CommandHistoryEntry[] {
    return this.entriesValue
      .map((entry, index) => ({ entry, score: fuzzyScore(query, entry.command), index }))
      .filter((item): item is { entry: CommandHistoryEntry; score: number; index: number } => item.score !== null)
      .sort((left, right) => right.score - left.score || left.index - right.index)
      .slice(0, limit)
      .map((item) => item.entry)
  }

  suggestion(document: string): string {
    if (!document.trim()) return ''
    return this.entriesValue.find((entry) => entry.command.startsWith(document) && entry.command !== document)?.command || ''
  }

  private load(): CommandHistoryEntry[] {
    try {
      const raw = window.localStorage.getItem(storageKey(this.sessionId))
      const parsed = raw ? JSON.parse(raw) as unknown : []
      if (!Array.isArray(parsed)) return []
      return parsed.filter((entry): entry is CommandHistoryEntry => Boolean(entry && typeof entry === 'object' && typeof (entry as CommandHistoryEntry).command === 'string'))
    } catch {
      return []
    }
  }

  private persist(): void {
    try {
      window.localStorage.setItem(storageKey(this.sessionId), JSON.stringify(this.entriesValue))
    } catch {
      // Storage can be disabled in hardened/private renderer contexts; the
      // in-memory session history remains usable.
    }
  }
}
