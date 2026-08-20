export type TerminalKeyLike = Pick<KeyboardEvent, 'key' | 'code' | 'shiftKey' | 'ctrlKey' | 'isComposing'>

export type TerminalKeyboardProtocol = 'kitty' | 'modify_other_keys'
export type TerminalEnterOwner = 'shell' | 'interactive'

// Ghostty starts in the compatibility encoding and changes protocol only
// after the child explicitly negotiates Kitty keyboard reporting.
export const DEFAULT_TERMINAL_KEYBOARD_PROTOCOL: TerminalKeyboardProtocol = 'modify_other_keys'
export const BRACKETED_PASTE_START = '\u001b[200~'
export const BRACKETED_PASTE_END = '\u001b[201~'

const SHELL_COMMANDS = new Set([
  'ash', 'bash', 'cmd', 'dash', 'elvish', 'fish', 'ksh', 'nu', 'powershell',
  'pwsh', 'sh', 'tcsh', 'xonsh', 'zsh'
])

/**
 * A node can launch a process directly instead of first presenting a shell
 * prompt. Until shell OSC markers arrive, that session is still an
 * interactive program for keyboard purposes. Treat wrappers and environment
 * assignments as transparent so `env FOO=1 codex` gets the same behavior as
 * `codex`.
 */
export function isDirectInteractiveTerminalCommand(command: string): boolean {
  const tokens = command.trim().split(/\s+/).filter(Boolean)
  if (!tokens.length) return false

  let index = 0
  while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index])) index += 1
  while (index < tokens.length && (tokens[index] === 'env' || tokens[index] === 'command' || tokens[index] === 'exec')) {
    index += 1
    while (index < tokens.length && /^(?:[A-Za-z_][A-Za-z0-9_]*=)/.test(tokens[index])) index += 1
  }
  const executable = tokens[index]?.split(/[\\/]/).pop()?.toLowerCase()
  return Boolean(executable && !SHELL_COMMANDS.has(executable))
}

/** Ctrl+Enter and Shift+Enter are explicit multiline affordances. */
export function isMultilineEnter(event: TerminalKeyLike): boolean {
  const enter = event.key === 'Enter' || event.code === 'Enter' || event.code === 'NumpadEnter'
  return enter && (event.ctrlKey || event.shiftKey)
}

/** Native Enter data forms xterm may emit for an unmodified Enter key. */
export function isNativeEnterData(data: string): boolean {
  return data === '\r' || data === '\n' || data === '\r\n'
}

/**
 * Produce the one and only payload for a clipboard paste. Clipboard CRLF/CR
 * is normalized to the PTY's LF contract; every other character, including
 * tabs, Unicode, blank lines and escape-like text, is preserved verbatim.
 * A paste never appends Enter. When the child advertises DECSET 2004, exactly
 * one bracketed-paste frame is added here rather than by xterm and the caller.
 */
export function terminalPastePayload(text: string, bracketedPaste: boolean): string {
  if (!text) return ''
  const normalized = text.replace(/\r\n?/g, '\n')
  return bracketedPaste
    ? `${BRACKETED_PASTE_START}${normalized}${BRACKETED_PASTE_END}`
    : normalized
}

/** Quote one filesystem path as a single POSIX-shell word without submitting it. */
export function shellQuotePath(path: string): string {
  if (!path) return "''"
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(path)) return path
  return `'${path.replace(/'/g, `'"'"'`)}'`
}

/** Keep a newline in the active line editor without submitting it. */
export function multilineEnterSequence(bracketedPaste: boolean): string {
  return bracketedPaste ? `${BRACKETED_PASTE_START}\n${BRACKETED_PASTE_END}` : '\u0016\n'
}

/**
 * Keep a newline in a shell line editor when DECSET 2004 is not currently
 * reported by xterm. The quoted-insert fallback (`Ctrl+V`, `LF`) is accepted
 * by readline, but zle treats a quoted LF as an accept-line in some modes.
 * Framing the one newline as a bracketed paste is app-agnostic across the
 * supported shells, even when the shell has temporarily disabled the mode or
 * its mode report raced the key event. The frame is sent as one PTY write.
 */
export function shellMultilineEnterSequence(bracketedPaste: boolean): string {
  return bracketedPaste
    ? multilineEnterSequence(true)
    : `${BRACKETED_PASTE_START}\n${BRACKETED_PASTE_END}`
}

/**
 * Encode a modified Enter for a raw program. Kitty CSI-u uses the key code
 * followed by a modifier value; xterm/Ghostty modifyOtherKeys uses the
 * compatibility CSI 27 form. Modifier values are the protocol's 1-based
 * values (base 1 + Shift 1 + Alt 2 + Ctrl 4 + Super 8).
 *
 * The caller chooses the protocol from terminal negotiation, never from a
 * process-name allowlist. Both sequences are one complete key event and must
 * be sent as one PTY input payload.
 */
export function modifiedEnterSequence(event: TerminalKeyLike, protocol: TerminalKeyboardProtocol): string {
  const modifier = 1 + (event.shiftKey ? 1 : 0) + (event.ctrlKey ? 4 : 0)
  return protocol === 'kitty'
    ? `\u001b[13;${modifier}u`
    : `\u001b[27;${modifier};13~`
}

/** Resolve one complete modified-Enter payload before it reaches the PTY. */
export function multilineEnterPayload(
  event: TerminalKeyLike,
  owner: TerminalEnterOwner,
  bracketedPaste: boolean,
  protocol: TerminalKeyboardProtocol
): string | null {
  if (event.isComposing || !isMultilineEnter(event)) return null
  return owner === 'shell'
    ? shellMultilineEnterSequence(bracketedPaste)
    : modifiedEnterSequence(event, protocol)
}
