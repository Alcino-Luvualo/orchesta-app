import { StreamLanguage, StringStream } from '@codemirror/language'

interface ShellStreamState {
  quote: 'single' | 'double' | 'backtick' | null
}

function consumeQuoted(stream: StringStream, state: ShellStreamState, quote: 'single' | 'double' | 'backtick'): string {
  const closing = quote === 'single' ? "'" : quote === 'double' ? '"' : '`'
  let escaped = false
  while (!stream.eol()) {
    const character = stream.next()
    if (escaped) {
      escaped = false
      continue
    }
    if (character === '\\' && quote !== 'single') {
      escaped = true
      continue
    }
    if (character === closing) {
      state.quote = null
      break
    }
  }
  return 'string'
}

export const shellLanguage = StreamLanguage.define<ShellStreamState>({
  name: 'orchestra-shell',
  startState: () => ({ quote: null }),
  token(stream, state) {
    if (state.quote) return consumeQuoted(stream, state, state.quote)
    if (stream.eatSpace()) return null
    if (stream.match(/^#.*/)) return 'comment'
    const first = stream.peek()
    if (first === "'" || first === '"' || first === '`') {
      state.quote = first === "'" ? 'single' : first === '"' ? 'double' : 'backtick'
      stream.next()
      return consumeQuoted(stream, state, state.quote)
    }
    if (stream.match(/^(?:&&|\|\||>>|<<|[|;&()<>])/)) return 'operator'
    if (stream.match(/^\$[{A-Za-z_][A-Za-z0-9_}]*/)) return 'variableName'
    if (stream.match(/^-{1,2}[A-Za-z][A-Za-z0-9_-]*/)) return 'keyword'
    if (stream.sol() && stream.match(/^[A-Za-z_][A-Za-z0-9_]*=/)) return 'propertyName'
    if (stream.match(/^(?:[A-Za-z_][A-Za-z0-9_.-]*\/|~\/|\.\/|\.\.\/)/)) {
      stream.eatWhile(/[A-Za-z0-9_./-]/)
      return 'string'
    }
    stream.eatWhile(/[^\s|;&()<>]/)
    return 'variableName'
  }
})
