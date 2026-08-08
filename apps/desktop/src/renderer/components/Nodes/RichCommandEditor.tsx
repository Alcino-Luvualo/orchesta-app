import React, { useCallback, useEffect, useRef, useState } from 'react'
import { CommandEditorCallbacks, createCommandEditorEngine } from './CommandEditorEngine'

export interface RichCommandEditorProps extends CommandEditorCallbacks {
  initialDocument?: string
  onFocus?: () => void
}

export const RichCommandEditor: React.FC<RichCommandEditorProps> = ({
  initialDocument = '',
  onChange,
  onExecute,
  onClearTerminal,
  onSendInput,
  onFocus,
  onHistorySearch,
  getSuggestion,
  provideCompletions
}) => {
  const hostRef = useRef<HTMLDivElement>(null)
  const engineRef = useRef<ReturnType<typeof createCommandEditorEngine> | null>(null)
  const [document, setDocument] = useState(initialDocument)
  const handleChange = useCallback((nextDocument: string) => {
    setDocument(nextDocument)
    onChange?.(nextDocument)
  }, [onChange])
  const callbacksRef = useRef<CommandEditorCallbacks>({ onChange: handleChange, onExecute, onHistorySearch, getSuggestion })
  callbacksRef.current = { onChange: handleChange, onExecute, onClearTerminal, onSendInput, onHistorySearch, getSuggestion, provideCompletions }

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const engine = createCommandEditorEngine(initialDocument, callbacksRef.current)
    engine.mount(host)
    engineRef.current = engine
    const focusFrame = requestAnimationFrame(() => {
      engine.focus()
      onFocus?.()
    })
    return () => {
      cancelAnimationFrame(focusFrame)
      engine.destroy()
      engineRef.current = null
    }
  }, [initialDocument, onFocus])

  useEffect(() => {
    engineRef.current?.updateCallbacks({ onChange: handleChange, onExecute, onClearTerminal, onSendInput, onHistorySearch, getSuggestion, provideCompletions })
  }, [getSuggestion, handleChange, onClearTerminal, onExecute, onHistorySearch, onSendInput, provideCompletions])

  const suggestion = getSuggestion?.(document) || ''
  const ghostText = suggestion.startsWith(document) ? suggestion.slice(document.length) : ''
  return <div className="rich-command-editor nodrag nopan" onMouseDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()} onContextMenu={(event) => event.stopPropagation()}>
    <div className="rich-command-editor-host" ref={hostRef} />
    {ghostText && <div className="rich-command-ghost" aria-hidden="true">{ghostText}</div>}
  </div>
}
