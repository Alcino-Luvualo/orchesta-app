import React, { useEffect, useMemo, useRef, useState } from 'react'
import { EditorContent, useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Image from '@tiptap/extension-image'
import Link from '@tiptap/extension-link'
import Placeholder from '@tiptap/extension-placeholder'
import TaskItem from '@tiptap/extension-task-item'
import TaskList from '@tiptap/extension-task-list'
import { Handle, NodeResizer, Position } from '@xyflow/react'
import { Bold, CheckSquare, Code2, Eye, Italic, List, ListOrdered, Palette, Quote, X } from 'lucide-react'
import { marked } from 'marked'
import { CanvasComponentData, useWorkspaceStore } from '../../store/workspaceStore'
import { sanitizeMarkdownHtml } from '../../utils/sanitizeMarkdownHtml'

type JsonNode = { type?: string; text?: string; attrs?: Record<string, unknown>; marks?: Array<{ type: string; attrs?: Record<string, unknown> }>; content?: JsonNode[] }

const NOTE_COLORS = ['#fff2a8', '#ffd2cf', '#ffd9a8', '#ccefc9', '#cce8ff', '#ded4ff', '#f4d2ed']
// GFM needs something after `[ ]` to keep an empty task item a task item.
// This character survives trim/save cycles but is removed again before the
// document reaches TipTap, so it never becomes part of the text the user edits.
const EMPTY_TASK_PLACEHOLDER = '\u200B'

type EditorStateLike = {
  selection: {
    from: number
    to: number
    $from: { depth: number; node: (depth: number) => { type: { name: string }; attrs: Record<string, unknown> } }
  }
  doc: {
    nodesBetween: (from: number, to: number, visit: (node: { type: { name: string }; attrs: Record<string, unknown> }) => boolean | void) => void
  }
}

function normalizeNoteColor(value: unknown): string {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value : '#fff2a8'
}

function noteInk(color: string): { ink: string; muted: string } {
  const rgb = [color.slice(1, 3), color.slice(3, 5), color.slice(5, 7)].map((part) => Number.parseInt(part, 16) / 255)
  const luminance = rgb.reduce((total, value, index) => total + value * [0.2126, 0.7152, 0.0722][index], 0)
  return luminance > .57
    ? { ink: '#302c2a', muted: 'rgba(48,44,42,.62)' }
    : { ink: '#fbfaf5', muted: 'rgba(251,250,245,.68)' }
}

function inlineMarkdown(nodes: JsonNode[] = []): string {
  return nodes.map((node) => {
    if (node.type === 'hardBreak') return '\n'
    if (node.type !== 'text') return blockMarkdown(node)
    let text = node.text || ''
    for (const mark of node.marks || []) {
      if (mark.type === 'bold') text = `**${text}**`
      else if (mark.type === 'italic') text = `*${text}*`
      else if (mark.type === 'strike') text = `~~${text}~~`
      else if (mark.type === 'code') text = `\`${text}\``
      else if (mark.type === 'link' && typeof mark.attrs?.href === 'string') text = `[${text}](${mark.attrs.href})`
    }
    return text
  }).join('')
}

function taskItemMarkdown(item: JsonNode): string {
  const text = inlineMarkdown(item.content?.[0]?.content || item.content || []).replaceAll(EMPTY_TASK_PLACEHOLDER, '')
  return `- [${item.attrs?.checked ? 'x' : ' '}] ${text || EMPTY_TASK_PLACEHOLDER}`
}

function blockMarkdown(node: JsonNode): string {
  const content = node.content || []
  switch (node.type) {
    case 'paragraph': return inlineMarkdown(content)
    case 'heading': return `${'#'.repeat(Math.max(1, Math.min(6, Number(node.attrs?.level) || 1)))} ${inlineMarkdown(content)}`
    case 'blockquote': return blockMarkdown(content[0] || { type: 'paragraph' }).split('\n').map((line) => `> ${line}`).join('\n')
    case 'bulletList': return content.map((item) => `- ${inlineMarkdown(item.content?.[0]?.content || item.content || [])}`).join('\n')
    case 'orderedList': return content.map((item, index) => `${index + 1}. ${inlineMarkdown(item.content?.[0]?.content || item.content || [])}`).join('\n')
    case 'taskList': return content.map(taskItemMarkdown).join('\n')
    case 'codeBlock': return `\`\`\`${typeof node.attrs?.language === 'string' ? node.attrs.language : ''}\n${content.map((child) => child.text || '').join('')}\n\`\`\``
    case 'horizontalRule': return '---'
    case 'image': return typeof node.attrs?.src === 'string' ? `![${String(node.attrs.alt || '')}](${node.attrs.src})` : ''
    default: return inlineMarkdown(content)
  }
}

function markdownFromDocument(document: { content?: JsonNode[] }): string {
  return (document.content || []).map(blockMarkdown).filter(Boolean).join('\n\n').trimEnd()
}

function markdownAsHtml(content: string): string {
  try {
    // Accept the compact Maestri-style notation with or without a Markdown
    // bullet. Canonical persistence still uses `- [ ]` / `- [x]`.
    const normalized = content.replace(/^([ \t]*)(?:[-*+][ \t]+)?\[[ \t]*([xX]?)[ \t]*\](?:[ \t]+(.*))?$/gm, (_match, indent, checked, text = '') => `${indent}- [${checked ? 'x' : ' '}] ${text || EMPTY_TASK_PLACEHOLDER}`)
    const parsed = new DOMParser().parseFromString(marked.parse(normalized) as string, 'text/html')
    parsed.querySelectorAll('li').forEach((item) => {
      const checkbox = Array.from(item.children).find((child) => child instanceof HTMLInputElement && child.type === 'checkbox') as HTMLInputElement | undefined
      if (!checkbox) return
      item.dataset.type = 'taskItem'
      item.dataset.checked = checkbox.checked ? 'true' : 'false'
      item.parentElement?.setAttribute('data-type', 'taskList')
      checkbox.remove()
      const removePlaceholder = (node: Node) => {
        Array.from(node.childNodes).forEach((child) => {
          if (child.nodeType === Node.TEXT_NODE) child.textContent = (child.textContent || '').replaceAll(EMPTY_TASK_PLACEHOLDER, '')
          else removePlaceholder(child)
        })
      }
      removePlaceholder(item)
      const paragraph = parsed.createElement('p')
      const inlineNodes = Array.from(item.childNodes).filter((child) => !(child instanceof HTMLElement && /^(UL|OL)$/.test(child.tagName)))
      inlineNodes.forEach((child) => paragraph.appendChild(child))
      item.insertBefore(paragraph, item.firstChild)
    })
    return sanitizeMarkdownHtml(parsed.body.innerHTML)
  } catch { return '' }
}

function selectionTouchesCheckedTask(state: EditorStateLike): boolean {
  for (let depth = state.selection.$from.depth; depth >= 0; depth -= 1) {
    const node = state.selection.$from.node(depth)
    if (node.type.name === 'taskItem' && node.attrs.checked === true) return true
  }

  if (state.selection.from === state.selection.to) return false
  let touchesCheckedTask = false
  state.doc.nodesBetween(state.selection.from, state.selection.to, (node) => {
    if (node.type.name !== 'taskItem' || node.attrs.checked !== true) return
    touchesCheckedTask = true
    return false
  })
  return touchesCheckedTask
}

export const NoteNode: React.FC<{ id: string; data: CanvasComponentData }> = ({ id, data }) => {
  const { updateNode, deleteNode, setSelectedNodeId, commitHistory } = useWorkspaceStore()
  const props = data.properties || {}
  const title = String(props.title || 'Nota')
  const content = String(props.content || '')
  const color = normalizeNoteColor(props.color)
  const colors = noteInk(color)
  const lastLocalMarkdown = useRef(content)
  const colorMenuRef = useRef<HTMLDivElement>(null)
  const [saveState, setSaveState] = useState<'saving' | 'saved'>('saved')
  // Recompute the seed when React Flow reuses this component for another note;
  // the editor effect below handles live external updates without remounting
  // on every keystroke.
  const initialContent = useMemo(() => markdownAsHtml(content), [content])
  const [isEditing, setIsEditing] = useState(false)
  const [colorMenuOpen, setColorMenuOpen] = useState(false)

  const editor = useEditor({
    extensions: [
      // StarterKit v3 bundles Link. Disable that instance so the configured
      // extension below is the only link extension in the editor (otherwise
      // every note mount logs a duplicate-extension warning).
      StarterKit.configure({ link: false }),
      Image.configure({ allowBase64: true }),
      Link.configure({ openOnClick: false, protocols: ['http', 'https'] }),
      Placeholder.configure({ placeholder: 'Escreve, usa / para blocos…' }),
      TaskList,
      TaskItem.configure({ nested: true })
    ],
    content: initialContent,
    editorProps: {
      attributes: { class: 'tiptap note-editor', spellcheck: 'true', 'aria-label': 'Conteúdo da nota', 'aria-multiline': 'true' },
      handleDOMEvents: {
        // Do not mutate ProseMirror's contenteditable DOM to lock a completed
        // task. Its own DOM observer repairs that mutation, which can create a
        // render/mutation feedback loop and freeze the whole Electron window.
        // Blocking beforeinput keeps IME, dictation and context-menu edits out
        // while the checkbox itself remains clickable for unlocking the task.
        beforeinput: (view, event) => {
          if (!selectionTouchesCheckedTask(view.state)) return false
          event.preventDefault()
          return true
        }
      },
      handleKeyDown: (view, event) => {
        if (!selectionTouchesCheckedTask(view.state)) return false
        if (event.target instanceof HTMLInputElement && event.target.type === 'checkbox') return false

        const key = event.key.toLowerCase()
        const navigationKeys = ['arrowleft', 'arrowright', 'arrowup', 'arrowdown', 'home', 'end', 'pageup', 'pagedown', 'escape']
        if (navigationKeys.includes(key)) return false
        if ((event.metaKey || event.ctrlKey) && ['a', 'c', 'f'].includes(key)) return false
        event.preventDefault()
        return true
      },
      handleTextInput: (view) => selectionTouchesCheckedTask(view.state),
      handlePaste: (view, event) => {
        if (selectionTouchesCheckedTask(view.state)) return true
        const imageFile = Array.from(event.clipboardData?.items || [])
          .find((item) => item.kind === 'file' && item.type.startsWith('image/'))
          ?.getAsFile()
        if (!imageFile) return false

        event.preventDefault()
        const reader = new FileReader()
        reader.addEventListener('load', () => {
          const src = typeof reader.result === 'string' ? reader.result : ''
          const imageType = view.state.schema.nodes.image
          if (!src.startsWith('data:image/') || !imageType || view.isDestroyed) return
          const image = imageType.create({ src, alt: imageFile.name || 'Imagem colada' })
          view.dispatch(view.state.tr.replaceSelectionWith(image).scrollIntoView())
        }, { once: true })
        reader.readAsDataURL(imageFile)
        return true
      },
      handleDrop: (view) => selectionTouchesCheckedTask(view.state)
    },
    onUpdate: ({ editor: current }) => {
      const markdown = markdownFromDocument(current.getJSON() as { content?: JsonNode[] })
      lastLocalMarkdown.current = markdown
      setSaveState('saving')
      updateNode(id, { properties: { content: markdown } })
    }
  }, [id, updateNode])

  // Apply edits arriving from the Rust-connected note file without replacing
  // content that this editor has just emitted locally.
  useEffect(() => {
    if (!editor || isEditing || content === lastLocalMarkdown.current) return
    lastLocalMarkdown.current = content
    editor.commands.setContent(markdownAsHtml(content), { emitUpdate: false })
  }, [content, editor, isEditing])

  const finishEditing = () => {
    if (editor && !editor.isDestroyed) {
      const markdown = markdownFromDocument(editor.getJSON() as { content?: JsonNode[] })
      lastLocalMarkdown.current = markdown
      // Reassert the editor's value. An agent/file watcher may have updated
      // the Zustand node while the user was typing; focused local input owns
      // that conflict and is flushed before external updates are accepted.
      updateNode(id, { properties: { content: markdown } })
    }
    setIsEditing(false)
  }

  useEffect(() => {
    if (saveState !== 'saving') return
    const timer = window.setTimeout(() => setSaveState('saved'), 450)
    return () => window.clearTimeout(timer)
  }, [content, saveState])

  useEffect(() => {
    const receiveAction = (event: Event) => {
      const detail = (event as CustomEvent<{ command?: string; nodeId?: string }>).detail
      if (!editor || detail?.nodeId !== id) return
      if (detail.command === 'bold') editor.chain().focus().toggleBold().run()
      else if (detail.command === 'italic') editor.chain().focus().toggleItalic().run()
      else if (detail.command === 'list') editor.chain().focus().toggleBulletList().run()
      else if (detail.command === 'check') editor.chain().focus().toggleTaskList().run()
    }
    window.addEventListener('orchestra:note-action', receiveAction)
    return () => window.removeEventListener('orchestra:note-action', receiveAction)
  }, [editor, id])

  useEffect(() => {
    if (!colorMenuOpen) return
    const close = (event: PointerEvent) => {
      if (!colorMenuRef.current?.contains(event.target as Node)) setColorMenuOpen(false)
    }
    window.addEventListener('pointerdown', close, true)
    return () => window.removeEventListener('pointerdown', close, true)
  }, [colorMenuOpen])

  const setNoteColor = (nextColor: string, recordHistory = true) => {
    if (recordHistory) commitHistory()
    updateNode(id, { properties: { color: normalizeNoteColor(nextColor) } })
  }

  return (
    <div className={`node note-node ${isEditing ? 'note-editor-focused' : ''}`} data-kind="note" data-editor-focused={isEditing ? 'true' : undefined} style={{ width: '100%', height: '100%', minWidth: 220, minHeight: 180, background: color, '--note-paper': color, '--note-ink': colors.ink, '--note-muted': colors.muted } as React.CSSProperties} onClick={() => setSelectedNodeId(id)}>
      {/* Resize controls are intentionally paused while the ProseMirror surface has focus.
          React Flow's line affordance otherwise paints across the sticky note during typing. */}
      <NodeResizer isVisible={Boolean(data.selected && !isEditing)} minWidth={220} minHeight={180} handleClassName="nodrag nopan canvas-resize-handle note-resize-handle" lineClassName="nodrag nopan canvas-resize-line note-resize-line" onResizeStart={commitHistory} onResize={(_, params) => updateNode(id, { width: params.width, height: params.height })} />
      <Handle type="target" position={Position.Left} className="port left" />
      <Handle type="source" position={Position.Right} className="port right" />
      <div className="sticky-note-head">
        <span className="sticky-note-title">{title}</span>
        <span className="note-format-hint" aria-hidden="true"><Bold className="icon" /> Markdown · blocos</span>
        <button type="button" className="icon-btn" aria-label="Lista com marcadores" onClick={(event) => { event.stopPropagation(); editor?.chain().focus().toggleBulletList().run() }} title="Lista"><List className="icon" /></button>
        <button type="button" className="icon-btn" aria-label="Lista numerada" onClick={(event) => { event.stopPropagation(); editor?.chain().focus().toggleOrderedList().run() }} title="Lista numerada"><ListOrdered className="icon" /></button>
        <button type="button" className={`icon-btn ${editor?.isActive('taskList') ? 'active' : ''}`} aria-label="Checklist" onClick={(event) => { event.stopPropagation(); editor?.chain().focus().toggleTaskList().run() }} title="Checklist [ ]"><CheckSquare className="icon" /></button>
        <button type="button" className="icon-btn" aria-label="Citação" onClick={(event) => { event.stopPropagation(); editor?.chain().focus().toggleBlockquote().run() }} title="Citação"><Quote className="icon" /></button>
        <button type="button" className="icon-btn" aria-label="Bloco de código" onClick={(event) => { event.stopPropagation(); editor?.chain().focus().toggleCodeBlock().run() }} title="Código"><Code2 className="icon" /></button>
        <button type="button" className="icon-btn" aria-label="Negrito" onClick={(event) => { event.stopPropagation(); editor?.chain().focus().toggleBold().run() }} title="Negrito"><Bold className="icon" /></button>
        <button type="button" className="icon-btn" aria-label="Itálico" onClick={(event) => { event.stopPropagation(); editor?.chain().focus().toggleItalic().run() }} title="Itálico"><Italic className="icon" /></button>
        <div ref={colorMenuRef} className="note-color-menu-wrap nodrag nopan">
          <button type="button" className="icon-btn note-color-trigger" aria-label="Cor da nota" aria-expanded={colorMenuOpen} onClick={(event) => { event.stopPropagation(); setColorMenuOpen((open) => !open) }} title="Cor da nota"><Palette className="icon" /><span style={{ background: color }} /></button>
          {colorMenuOpen && <div className="note-color-menu" role="menu" aria-label="Escolher cor da nota" onPointerDown={(event) => event.stopPropagation()}>
            {NOTE_COLORS.map((option) => <button type="button" role="menuitemradio" aria-checked={color === option} className={color === option ? 'selected' : ''} key={option} style={{ background: option }} title={option} onClick={() => { setNoteColor(option); setColorMenuOpen(false) }} />)}
            <label className="note-color-custom" title="Cor personalizada"><Palette className="icon" /><input type="color" value={color} onPointerDown={() => commitHistory()} onChange={(event) => setNoteColor(event.target.value, false)} /></label>
          </div>}
        </div>
        <button type="button" className="icon-btn" aria-label="Eliminar nota" onClick={(event) => { event.stopPropagation(); deleteNode(id) }} title="Eliminar nota"><X className="icon" /></button>
      </div>
      <div
        className={`markdown-note note-editor-shell nodrag nowheel ${isEditing ? 'is-editing' : ''}`}
        onPointerDown={(event) => { event.stopPropagation(); setSelectedNodeId(id) }}
        onFocusCapture={() => { setIsEditing(true); setSelectedNodeId(id) }}
        onBlurCapture={(event) => {
          const nextTarget = event.relatedTarget
          if (!(nextTarget instanceof Node) || !event.currentTarget.contains(nextTarget)) finishEditing()
        }}
      >
        <EditorContent editor={editor} />
      </div>
      <div className="note-footer" aria-live="polite"><Eye className="icon" aria-hidden="true" /> {saveState === 'saving' ? 'A guardar…' : 'Guardado'} · Markdown canónico</div>
    </div>
  )
}
