import React, { useEffect, useRef } from 'react'

interface TerminalSearchOverlayProps {
  query: string
  found: boolean | null
  onQueryChange: (value: string) => void
  onNext: () => void
  onPrevious: () => void
  onClose: () => void
}

/** Small Ghostty-style search bar for the native xterm scrollback buffer. */
export const TerminalSearchOverlay: React.FC<TerminalSearchOverlayProps> = ({
  query,
  found,
  onQueryChange,
  onNext,
  onPrevious,
  onClose
}) => {
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  return (
    <div className="terminal-search-overlay nodrag nopan" onMouseDown={(event) => event.stopPropagation()}>
      <span className="terminal-search-label">Search terminal</span>
      <input
        ref={inputRef}
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') { event.preventDefault(); onClose() }
          if (event.key === 'Enter') { event.preventDefault(); event.shiftKey ? onPrevious() : onNext() }
        }}
        placeholder="Find in scrollback…"
        aria-label="Search terminal output"
      />
      <span className={`terminal-search-status ${found === false ? 'empty' : ''}`} aria-live="polite">
        {found === false ? 'No match' : query ? 'Match' : ''}
      </span>
      <button type="button" onClick={onPrevious} aria-label="Previous match" title="Previous match">↑</button>
      <button type="button" onClick={onNext} aria-label="Next match" title="Next match">↓</button>
      <button type="button" onClick={onClose} aria-label="Close terminal search" title="Close">Esc</button>
    </div>
  )
}
