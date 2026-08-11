export type TerminalPermission = 'ask' | 'allow' | 'deny'

export interface TerminalSecuritySettings {
  clipboardRead: TerminalPermission
  clipboardWrite: TerminalPermission
  copyOnSelect: boolean
  notifications: 'never' | 'when-unfocused' | 'always'
  notificationThresholdMs: number
}

export interface Osc52Request {
  selection: string
  encoded: string
  query: boolean
  text?: string
}

export interface TerminalFileReference {
  text: string
  path: string
  line: number
  column?: number
  start: number
  end: number
}

const DEFAULT_SECURITY_SETTINGS: TerminalSecuritySettings = {
  // Programs must not read or overwrite the host clipboard without an
  // explicit decision. User-triggered copy/paste remains independent.
  clipboardRead: 'ask',
  clipboardWrite: 'ask',
  copyOnSelect: false,
  notifications: 'when-unfocused',
  notificationThresholdMs: 5000
}

type SettingsStorage = {
  getItem?: (key: string) => string | null
  setItem?: (key: string, value: string) => void
}

function permission(value: unknown, fallback: TerminalPermission): TerminalPermission {
  return value === 'allow' || value === 'deny' || value === 'ask' ? value : fallback
}

export function readTerminalSecuritySettings(storage?: SettingsStorage): TerminalSecuritySettings {
  try {
    const source = storage || (typeof window !== 'undefined' ? window.localStorage : undefined)
    if (!source) return { ...DEFAULT_SECURITY_SETTINGS }
    const raw = source.getItem?.('terminal.security')
    const parsed = raw ? JSON.parse(raw) as Record<string, unknown> : {}
    return {
      clipboardRead: permission(parsed.clipboardRead, DEFAULT_SECURITY_SETTINGS.clipboardRead),
      clipboardWrite: permission(parsed.clipboardWrite, DEFAULT_SECURITY_SETTINGS.clipboardWrite),
      copyOnSelect: parsed.copyOnSelect === true,
      notifications: parsed.notifications === 'always' || parsed.notifications === 'never' ? parsed.notifications : DEFAULT_SECURITY_SETTINGS.notifications,
      notificationThresholdMs: typeof parsed.notificationThresholdMs === 'number'
        ? Math.max(1000, Math.min(60_000, Math.floor(parsed.notificationThresholdMs)))
        : DEFAULT_SECURITY_SETTINGS.notificationThresholdMs
    }
  } catch {
    return { ...DEFAULT_SECURITY_SETTINGS }
  }
}

export function writeTerminalSecuritySettings(settings: Partial<TerminalSecuritySettings>, storage?: SettingsStorage): void {
  try {
    const target = storage || (typeof window !== 'undefined' ? window.localStorage : undefined)
    if (!target) return
    const current = readTerminalSecuritySettings(target)
    target.setItem?.('terminal.security', JSON.stringify({ ...current, ...settings }))
  } catch {
    // Restricted storage should not break terminal input/output.
  }
}

export function parseOsc52(data: string): Osc52Request | null {
  const separator = data.indexOf(';')
  if (separator <= 0) return null
  const selection = data.slice(0, separator)
  const encoded = data.slice(separator + 1)
  if (!/^[cps0-9]*$/i.test(selection) || encoded.length > 4 * 1024 * 1024) return null
  if (encoded === '?') return { selection, encoded, query: true }
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 === 1) return null
  try {
    const binary = atob(encoded)
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
    return { selection, encoded, query: false, text: new TextDecoder().decode(bytes) }
  } catch {
    return null
  }
}

export function encodeOsc52Text(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
  }
  return btoa(binary)
}

export function osc52Response(selection: string, text: string): string {
  return `\u001b]52;${selection || 'c'};${encodeOsc52Text(text)}\u001b\\`
}

export function sanitizeTerminalUrl(value: string): string | null {
  try {
    const url = new URL(value.trim())
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) return null
    return url.toString()
  } catch {
    return null
  }
}

const fileReferencePattern = /(^|[\s("'`])((?:~\/|\/|\.\/|\.\.\/)?(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+):(\d+)(?::(\d+))?/g

export function detectTerminalFileReferences(line: string): TerminalFileReference[] {
  const references: TerminalFileReference[] = []
  fileReferencePattern.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = fileReferencePattern.exec(line))) {
    const path = match[2]
    if (!path.includes('/') && !/[._-]/.test(path)) continue
    const text = `${path}:${match[3]}${match[4] ? `:${match[4]}` : ''}`
    const start = match.index + match[1].length
    references.push({
      text,
      path,
      line: Number(match[3]),
      column: match[4] ? Number(match[4]) : undefined,
      start,
      end: start + text.length
    })
  }
  return references
}
