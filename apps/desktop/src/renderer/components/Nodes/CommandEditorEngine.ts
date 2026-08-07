import { autocompletion, closeBrackets, closeBracketsKeymap, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { shellLanguage } from './shellLanguage.ts'
import { acceptSuggestionWord } from './shellCommandParser.ts'
import { EditorState } from '@codemirror/state'
import { drawSelection, EditorView, keymap } from '@codemirror/view'

export interface CommandEditorCallbacks {
  onChange?: (document: string) => void
  onExecute?: (document: string) => void
  onClearTerminal?: () => void
  onSendInput?: (data: string) => void
  onHistorySearch?: () => void
  getSuggestion?: (document: string) => string
  provideCompletions?: (context: CompletionContext) => Promise<CompletionResult | null>
}

export interface CommandEditorEngine {
  mount(parent: HTMLElement): void
  destroy(): void
  focus(): void
  getDocument(): string
  setDocument(document: string): void
  updateCallbacks(callbacks: CommandEditorCallbacks): void
}

const insertNewline = (view: EditorView): boolean => {
  const selection = view.state.selection.main
  const edit = applyCommandEditorEdit(view.state.doc.toString(), selection.from, selection.to, '\n')
  view.dispatch({
    changes: { from: selection.from, to: selection.to, insert: edit.document.slice(selection.from, edit.cursor) },
    selection: { anchor: edit.cursor }
  })
  return true
}

/**
 * The editor uses UTF-16 offsets, matching CodeMirror's document positions.
 * Keeping this small edit primitive exported makes multiline/click-to-edit
 * behavior testable without pretending a headless Node process is an Electron
 * browser. The mounted CodeMirror editor still owns the real selection and
 * rendering path.
 */
export function applyCommandEditorEdit(
  document: string,
  from: number,
  to: number,
  insert: string
): { document: string; cursor: number } {
  const start = Math.max(0, Math.min(from, document.length))
  const end = Math.max(start, Math.min(to, document.length))
  return {
    document: document.slice(0, start) + insert + document.slice(end),
    cursor: start + insert.length
  }
}

export function createCommandEditorEngine(
  initialDocument: string,
  initialCallbacks: CommandEditorCallbacks = {}
): CommandEditorEngine {
  let view: EditorView | null = null
  let callbacks = initialCallbacks

  const execute = (editorView: EditorView): boolean => {
    const document = editorView.state.doc.toString()
    if (!callbacks.onExecute) return false
    callbacks.onExecute(document)
    return true
  }

  const clearEditor = (editorView: EditorView): boolean => {
    if (!editorView.state.selection.main.empty) return false
    if (!editorView.state.doc.length) return true
    editorView.dispatch({ changes: { from: 0, to: editorView.state.doc.length } })
    return true
  }

  const deleteOrSendEof = (editorView: EditorView): boolean => {
    const selection = editorView.state.selection.main
    if (selection.from !== selection.to) {
      editorView.dispatch({ changes: { from: selection.from, to: selection.to } })
      return true
    }
    if (selection.head < editorView.state.doc.length) {
      editorView.dispatch({ changes: { from: selection.head, to: selection.head + 1 } })
      return true
    }
    callbacks.onSendInput?.('\u0004')
    return true
  }

  const acceptSuggestion = (editorView: EditorView, wordOnly = false): boolean => {
    const selection = editorView.state.selection.main
    const document = editorView.state.doc.toString()
    if (!selection.empty || selection.head !== document.length) return false
    const suggestion = callbacks.getSuggestion?.(document) || ''
    if (!suggestion.startsWith(document) || suggestion.length === document.length) return false
    const insert = wordOnly ? acceptSuggestionWord(suggestion, document.length) : suggestion.slice(document.length)
    editorView.dispatch({ changes: { from: document.length, insert } })
    return true
  }

  return {
    mount(parent) {
      if (view) return
      view = new EditorView({
        state: EditorState.create({
          doc: initialDocument,
          extensions: [
            EditorState.allowMultipleSelections.of(true),
            history(),
            closeBrackets(),
            shellLanguage,
            ...(callbacks.provideCompletions ? [autocompletion({ override: [callbacks.provideCompletions] })] : []),
            drawSelection(),
            EditorView.lineWrapping,
            EditorView.editable.of(true),
            EditorView.contentAttributes.of({
              'aria-label': 'Command editor',
              'aria-multiline': 'true',
              spellcheck: 'false'
            }),
            EditorView.updateListener.of((update) => {
              if (update.docChanged) callbacks.onChange?.(update.state.doc.toString())
            }),
            EditorView.theme({
              '&': { height: '100%', minHeight: '42px' },
              '.cm-scroller': { overflow: 'auto', fontFamily: 'var(--mono)', fontSize: '13px', lineHeight: '1.45' },
              '.cm-content': { padding: '10px 12px', minHeight: '22px', caretColor: 'var(--primary)' },
              '.cm-line': { padding: '0' },
              '.cm-gutters': { display: 'none' },
              '&.cm-focused': { outline: 'none' },
              '.cm-selectionBackground, ::selection': { backgroundColor: 'rgba(200, 241, 105, .22)' },
              '.cm-cursor': { borderLeftColor: 'var(--primary)', borderLeftWidth: '2px' }
            }),
            keymap.of([
              { key: 'Mod-r', run: () => { callbacks.onHistorySearch?.(); return true } },
              { key: 'Mod-c', run: clearEditor },
              { key: 'Mod-d', run: deleteOrSendEof },
              { key: 'Mod-l', run: () => { callbacks.onClearTerminal?.(); return true } },
              { key: 'Ctrl-ArrowRight', run: (editorView) => acceptSuggestion(editorView, true) },
              { key: 'Mod-ArrowRight', run: (editorView) => acceptSuggestion(editorView, true) },
              { key: 'ArrowRight', run: (editorView) => acceptSuggestion(editorView) },
              { key: 'End', run: (editorView) => acceptSuggestion(editorView) },
              { key: 'Shift-Enter', run: insertNewline },
              { key: 'Ctrl-Enter', run: insertNewline },
              { key: 'Alt-Enter', run: insertNewline },
              { key: 'Enter', run: execute },
              ...closeBracketsKeymap,
              ...defaultKeymap,
              ...historyKeymap,
              indentWithTab
            ])
          ]
        }),
        parent
      })
      view.focus()
    },
    destroy() {
      view?.destroy()
      view = null
    },
    focus() {
      view?.focus()
    },
    getDocument() {
      return view?.state.doc.toString() || ''
    },
    setDocument(document) {
      if (!view || view.state.doc.toString() === document) return
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: document } })
    },
    updateCallbacks(nextCallbacks) {
      callbacks = nextCallbacks
    }
  }
}
