import React, { useEffect, useMemo, useRef, useState } from 'react'
import { TerminalBlock, terminalBlockOutputText } from './terminalBlocks'
import { VirtualBlockIndex } from './virtualBlockIndex'

interface TerminalBlockListProps {
  blocks: TerminalBlock[]
  onReinput: (command: string) => void
  onRerun?: (command: string) => void
}

function copy(value: string): void {
  navigator.clipboard?.writeText(value).catch(() => undefined)
}

function createLineMatcher(query: string): ((line: string) => boolean) | null {
  const trimmed = query.trim()
  if (!trimmed) return null
  const regexMatch = trimmed.match(/^\/(.+)\/([imsu]*)$/)
  if (regexMatch && regexMatch[1].length <= 160) {
    try {
      const expression = new RegExp(regexMatch[1], regexMatch[2])
      return (line) => expression.test(line)
    } catch {
      // A malformed expression falls back to a literal search.
    }
  }
  const literal = trimmed.toLocaleLowerCase()
  return (line) => line.toLocaleLowerCase().includes(literal)
}

function filteredOutput(block: TerminalBlock, matcher: ((line: string) => boolean) | null): string {
  const output = terminalBlockOutputText(block)
  if (!matcher) return output
  return output.split(/\r?\n/).filter(matcher).join('\n')
}

export const TerminalBlockList: React.FC<TerminalBlockListProps> = ({ blocks, onReinput, onRerun }) => {
  const [selected, setSelected] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [bookmarked, setBookmarked] = useState<Set<string>>(new Set())
  const [filter, setFilter] = useState('')
  const [viewport, setViewport] = useState({ top: 0, height: 320 })
  const scrollRef = useRef<HTMLDivElement>(null)
  const rowRefs = useRef(new Map<number, HTMLElement>())
  const frameRef = useRef<number | null>(null)
  const indexRef = useRef(new VirtualBlockIndex())
  const indexedIdsRef = useRef<string[]>([])
  const lineMatcher = useMemo(() => createLineMatcher(filter), [filter])
  const visibleBlocks = useMemo(() => {
    if (!lineMatcher) return blocks
    const query = filter.trim().toLocaleLowerCase()
    return blocks.filter((block) => block.command.toLocaleLowerCase().includes(query) || filteredOutput(block, lineMatcher).length > 0)
  }, [blocks, filter, lineMatcher])
  const visibleIds = visibleBlocks.map((block) => block.id).join('|')
  if (indexedIdsRef.current.join('|') !== visibleIds) {
    indexedIdsRef.current = visibleBlocks.map((block) => block.id)
    indexRef.current.resize(visibleBlocks.length)
  }
  const range = indexRef.current.visibleRange(viewport.top, viewport.height)
  const stickyIndex = visibleBlocks.length ? indexRef.current.indexAt(viewport.top) : 0
  const stickyBlock = visibleBlocks[stickyIndex]

  useEffect(() => {
    const element = scrollRef.current
    if (!element) return
    const update = () => setViewport({ top: element.scrollTop, height: element.clientHeight })
    update()
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const observers: ResizeObserver[] = []
    rowRefs.current.forEach((element, index) => {
      const observer = new ResizeObserver((entries) => {
        if (!entries[0]) return
        const scrollElement = scrollRef.current
        const anchorIndex = scrollElement ? indexRef.current.indexAt(scrollElement.scrollTop) : 0
        const previousHeight = indexRef.current.heightAt(index)
        const nextHeight = Math.max(32, Math.ceil(entries[0].contentRect.height))
        if (indexRef.current.setHeight(index, nextHeight)) {
          if (scrollElement && index < anchorIndex) scrollElement.scrollTop += nextHeight - previousHeight
          setViewport((current) => ({ ...current }))
        }
      })
      observer.observe(element)
      observers.push(observer)
    })
    return () => observers.forEach((observer) => observer.disconnect())
  }, [range.start, range.end, visibleBlocks.length, expanded, filter])

  if (!blocks.length && !filter) return null

  const renderBlock = (block: TerminalBlock, index: number) => {
    const isExpanded = expanded.has(block.id)
    const output = terminalBlockOutputText(block)
    const visibleOutput = filteredOutput(block, lineMatcher)
    return <article ref={(element) => { if (element) rowRefs.current.set(index, element); else rowRefs.current.delete(index) }} key={block.id} className={`terminal-block terminal-block-${block.state} ${selected === block.id ? 'selected' : ''}`} onClick={() => setSelected(block.id)}>
      <header className="terminal-block-header">
        <span className="terminal-block-cwd">{block.cwd}</span>
        <span className="terminal-block-status">{block.state}{block.exitCode === undefined ? '' : ` · ${block.exitCode}`}</span>
      </header>
      <code className="terminal-block-command">$ {block.command || ' '}</code>
      {isExpanded && visibleOutput && <pre className="terminal-block-output">{visibleOutput}</pre>}
      <footer className="terminal-block-actions">
        <button type="button" onClick={(event) => { event.stopPropagation(); onReinput(block.command) }}>Re-input</button>
        {onRerun && <button type="button" onClick={(event) => { event.stopPropagation(); onRerun(block.command) }}>Re-run</button>}
        <button type="button" onClick={(event) => { event.stopPropagation(); copy(block.command) }}>Copy command</button>
        <button type="button" onClick={(event) => { event.stopPropagation(); copy(output) }}>Copy output</button>
        <button type="button" onClick={(event) => { event.stopPropagation(); setBookmarked((current) => { const next = new Set(current); if (next.has(block.id)) next.delete(block.id); else next.add(block.id); return next }) }}>{bookmarked.has(block.id) ? '★' : 'Bookmark'}</button>
        <button type="button" onClick={(event) => { event.stopPropagation(); setExpanded((current) => { const next = new Set(current); if (next.has(block.id)) next.delete(block.id); else next.add(block.id); return next }) }}>{isExpanded ? 'Collapse' : 'Output'}</button>
      </footer>
    </article>
  }

  return <div className="terminal-block-list nodrag nopan" ref={scrollRef} aria-label="Terminal command blocks" onScroll={() => {
    if (frameRef.current !== null) return
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null
      if (scrollRef.current) setViewport({ top: scrollRef.current.scrollTop, height: scrollRef.current.clientHeight })
    })
  }}>
    <div className="terminal-block-toolbar">
      <span>Blocks · {visibleBlocks.length}/{blocks.length}</span>
      <input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Filter output…" aria-label="Filter terminal blocks" />
    </div>
    {stickyBlock && <div className="terminal-block-sticky" onClick={() => scrollRef.current?.scrollTo({ top: indexRef.current.offsetOf(stickyIndex), behavior: 'smooth' })}>$ {stickyBlock.command} · {stickyBlock.state}</div>}
    {!visibleBlocks.length
      ? <div className="terminal-block-list-empty nodrag">No matching blocks</div>
      : <div className="terminal-block-virtual-spacer" style={{ height: indexRef.current.totalHeight() }}>
          {visibleBlocks.slice(range.start, range.end).map((block, offset) => {
            const index = range.start + offset
            return <div key={block.id} className="terminal-block-virtual-row" style={{ transform: `translateY(${indexRef.current.offsetOf(index)}px)` }}>{renderBlock(block, index)}</div>
          })}
        </div>}
  </div>
}
