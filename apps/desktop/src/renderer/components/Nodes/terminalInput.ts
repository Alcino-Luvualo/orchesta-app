export type TerminalKeyLike = Pick<KeyboardEvent, 'key' | 'code' | 'shiftKey' | 'ctrlKey' | 'isComposing'>

export type TerminalKeyboardProtocol = 'kitty' | 'modify_other_keys'
export type TerminalEnterOwner = 'shell' | 'interactive'

// Ghostty starts in the compatibility encoding and changes protocol only
// after the child explicitly negotiates Kitty keyboard reporting.
export const DEFAULT_TERMINAL_KEYBOARD_PROTOCOL: TerminalKeyboardProtocol = 'modify_other_keys'

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

/** Keep a newline in the active line editor without submitting it. */
export function multilineEnterSequence(bracketedPaste: boolean): string {
  return bracketedPaste ? '\u001b[200~\n\u001b[201~' : '\u0016\n'
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
    : '\u001b[200~\n\u001b[201~'
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
