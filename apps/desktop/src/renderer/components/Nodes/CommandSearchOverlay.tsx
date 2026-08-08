import React, { useEffect, useMemo, useRef, useState } from 'react'
import { CommandHistoryEntry } from './commandHistory'
import { fuzzyScore } from './shellCommandParser'

interface CommandSearchOverlayProps {
  entries: CommandHistoryEntry[]
  onSelect: (entry: CommandHistoryEntry) => void
  onClose: () => void
}

export const CommandSearchOverlay: React.FC<CommandSearchOverlayProps> = ({ entries, onSelect, onClose }) => {
  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => inputRef.current?.focus(), [])
  const results = useMemo(() => entries
    .map((entry, index) => ({ entry, score: fuzzyScore(query, entry.command), index }))
    .filter((item): item is { entry: CommandHistoryEntry; score: number; index: number } => item.score !== null)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, 30), [entries, query])

  return <div className="command-search-overlay nodrag nopan" onMouseDown={(event) => event.stopPropagation()}>
    <div className="command-search-header">
      <span>Command Search</span>
      <button type="button" onClick={onClose} aria-label="Close command search">Esc</button>
    </div>
    <input ref={inputRef} value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => {
      if (event.key === 'Escape') { event.preventDefault(); onClose() }
      if (event.key === 'Enter' && results[0]) { event.preventDefault(); onSelect(results[0].entry) }
    }} placeholder="Search history…" aria-label="Search terminal history" />
    <div className="command-search-results">
      {results.map(({ entry }) => <button type="button" key={entry.id} onClick={() => onSelect(entry)}>
        <code>{entry.command}</code>
        <small>{entry.cwd} · {entry.exitCode === undefined ? 'running' : `exit ${entry.exitCode}`}</small>
      </button>)}
      {!results.length && <span className="command-search-empty">No matching commands</span>}
    </div>
  </div>
}
