export type ShellTokenKind =
  | 'command'
  | 'argument'
  | 'flag'
  | 'string'
  | 'variable'
  | 'operator'
  | 'comment'
  | 'path'
  | 'assignment'

export interface ShellToken {
  kind: ShellTokenKind
  from: number
  to: number
  text: string
}

export interface ShellDiagnostic {
  message: string
  from: number
  to: number
  severity: 'warning' | 'error'
}

export interface ShellAnalysis {
  tokens: ShellToken[]
  diagnostics: ShellDiagnostic[]
}

const OPERATORS = new Set(['|', '||', '&', '&&', ';', ';;', '>', '>>', '<', '<<', '(', ')'])

export function analyzeShellCommand(input: string): ShellAnalysis {
  const tokens: ShellToken[] = []
  const diagnostics: ShellDiagnostic[] = []
  let cursor = 0
  let commandPosition = true

  while (cursor < input.length) {
    const character = input[cursor]
    if (/\s/.test(character)) {
      cursor += 1
      continue
    }
    if (character === '#') {
      tokens.push({ kind: 'comment', from: cursor, to: input.length, text: input.slice(cursor) })
      break
    }

    const operator = [input.slice(cursor, cursor + 2), character].find((value) => OPERATORS.has(value))
    if (operator) {
      tokens.push({ kind: 'operator', from: cursor, to: cursor + operator.length, text: operator })
      cursor += operator.length
      commandPosition = operator === '|' || operator === '||' || operator === '&&' || operator === ';'
      continue
    }

    const from = cursor
    let quote: 'single' | 'double' | 'backtick' | null = null
    let escaped = false
    while (cursor < input.length) {
      const next = input[cursor]
      if (escaped) {
        escaped = false
        cursor += 1
        continue
      }
      if (next === '\\' && quote !== 'single') {
        escaped = true
        cursor += 1
        continue
      }
      if (quote) {
        if ((quote === 'single' && next === "'") || (quote === 'double' && next === '"') || (quote === 'backtick' && next === '`')) quote = null
        cursor += 1
        continue
      }
      if (next === "'") quote = 'single'
      else if (next === '"') quote = 'double'
      else if (next === '`') quote = 'backtick'
      else if (/\s/.test(next) || OPERATORS.has(next) || OPERATORS.has(input.slice(cursor, cursor + 2)) || next === '#') break
      cursor += 1
    }
    const text = input.slice(from, cursor)
    if (quote) {
      diagnostics.push({
        message: `Unclosed ${quote} quote`,
        from,
        to: cursor,
        severity: 'warning'
      })
    }
    if (!text) {
      cursor += 1
      continue
    }
    const kind = classifyToken(text, commandPosition)
    tokens.push({ kind, from, to: cursor, text })
    commandPosition = false
  }

  return { tokens, diagnostics }
}

function classifyToken(text: string, commandPosition: boolean): ShellTokenKind {
  if (/^['"`]/.test(text)) return 'string'
  if (/^\$[{A-Za-z_]/.test(text)) return 'variable'
  if (/^-{1,2}[A-Za-z]/.test(text)) return 'flag'
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(text)) return 'assignment'
  if (text.includes('/') || text.startsWith('~')) return 'path'
  if (commandPosition) return 'command'
  return 'argument'
}

export function fuzzyScore(query: string, candidate: string): number | null {
  const normalizedQuery = query.trim().toLowerCase()
  const normalizedCandidate = candidate.toLowerCase()
  if (!normalizedQuery) return 0
  let queryIndex = 0
  let score = 0
  let previous = -1
  for (let index = 0; index < normalizedCandidate.length && queryIndex < normalizedQuery.length; index += 1) {
    if (normalizedCandidate[index] !== normalizedQuery[queryIndex]) continue
    score += index === previous + 1 ? 4 : 1
    if (index === 0 || /[\s/_-]/.test(normalizedCandidate[index - 1])) score += 3
    previous = index
    queryIndex += 1
  }
  return queryIndex === normalizedQuery.length ? score - normalizedCandidate.length / 1000 : null
}

export function acceptSuggestionWord(suggestion: string, documentLength: number): string {
  const remainder = suggestion.slice(documentLength)
  const match = remainder.match(/^\s*\S+(?:\s+|$)/)
  return match?.[0] || remainder
}

export function runShellParserSelfCheck(): boolean {
  const incomplete = analyzeShellCommand("echo 'unfinished")
  return incomplete.tokens.length === 1 && incomplete.diagnostics.length === 1
}

