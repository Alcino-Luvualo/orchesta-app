import { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete'
import { CommandHistoryEntry } from './commandHistory'

export interface CompletionItem {
  label: string
  type?: Completion['type']
  detail?: string
  apply?: string
}

export interface CompletionContextData {
  document: string
  from: number
  to: number
  token: string
  cwd: string
}

export interface CompletionProvider {
  readonly id: string
  canHandle(context: CompletionContextData): boolean
  provide(context: CompletionContextData, signal: AbortSignal): Promise<CompletionItem[]>
}

export type CompletionQuery = (kind: string, context: CompletionContextData, signal: AbortSignal) => Promise<CompletionItem[]>

export class CompletionController {
  private sequence = 0
  private activeController: AbortController | null = null

  constructor(private readonly providers: CompletionProvider[]) {}

  async provide(context: CompletionContext, cwd: string): Promise<CompletionResult | null> {
    if (context.explicit === false && !context.matchBefore(/[^\s]*/)?.[0]) return null
    const word = context.matchBefore(/[^\s|;&]*/)
    const from = word?.from ?? context.pos
    const token = word?.text ?? ''
    const data: CompletionContextData = {
      document: context.state.doc.toString(),
      from,
      to: context.pos,
      token,
      cwd
    }
    const requestSequence = ++this.sequence
    this.activeController?.abort()
    const controller = new AbortController()
    this.activeController = controller
    const items: CompletionItem[] = []
    try {
      const results = await Promise.all(this.providers
        .filter((provider) => provider.canHandle(data))
        .map((provider) => provider.provide(data, controller.signal)))
      if (controller.signal.aborted || requestSequence !== this.sequence) return null
      const seen = new Set<string>()
      results.flat().forEach((item) => {
        if (!seen.has(item.label)) {
          seen.add(item.label)
          items.push(item)
        }
      })
      return items.length ? { from, options: items } : null
    } catch (error) {
      if (controller.signal.aborted || requestSequence !== this.sequence) return null
      throw error
    }
  }
}

export class HistoryCompletionProvider implements CompletionProvider {
  readonly id = 'history'
  constructor(private readonly entries: () => CommandHistoryEntry[]) {}

  canHandle(context: CompletionContextData): boolean {
    return context.document.trim().length > 0
  }

  async provide(context: CompletionContextData, signal: AbortSignal): Promise<CompletionItem[]> {
    if (signal.aborted) return []
    const seen = new Set<string>()
    return this.entries()
      .filter((entry) => entry.command.startsWith(context.document) && entry.command !== context.document)
      .filter((entry) => !seen.has(entry.command) && Boolean(seen.add(entry.command)))
      .slice(0, 20)
      .map((entry) => ({ label: entry.command, type: 'text', detail: `history · ${entry.cwd}` }))
  }
}

export class QueryCompletionProvider implements CompletionProvider {
  constructor(
    readonly id: string,
    private readonly kind: string,
    private readonly query: CompletionQuery,
    private readonly predicate?: (context: CompletionContextData) => boolean
  ) {}

  canHandle(context: CompletionContextData): boolean {
    return this.predicate?.(context) ?? (context.document.trim().length > 0 || this.kind === 'path')
  }

  provide(context: CompletionContextData, signal: AbortSignal): Promise<CompletionItem[]> {
    return this.query(this.kind, context, signal)
  }
}

export function completionResultForItems(items: CompletionItem[], from: number): CompletionResult | null {
  return items.length ? { from, options: items } : null
}
