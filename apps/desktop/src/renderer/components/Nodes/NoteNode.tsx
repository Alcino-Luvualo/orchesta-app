import React, { useEffect, useMemo, useRef, useState } from 'react'
import { EditorContent, useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Link from '@tiptap/extension-link'
import Placeholder from '@tiptap/extension-placeholder'
import TaskItem from '@tiptap/extension-task-item'
import TaskList from '@tiptap/extension-task-list'
import { Handle, NodeResizer, Position } from '@xyflow/react'
import { Bold, CheckSquare, Code2, Eye, Italic, List, ListOrdered, Quote, X } from 'lucide-react'
import { marked } from 'marked'
import { CanvasComponentData, useWorkspaceStore } from '../../store/workspaceStore'
import { sanitizeMarkdownHtml } from '../../utils/sanitizeMarkdownHtml'

type JsonNode = { type?: string; text?: string; attrs?: Record<string, unknown>; marks?: Array<{ type: string; attrs?: Record<string, unknown> }>; content?: JsonNode[] }

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

function blockMarkdown(node: JsonNode): string {
  const content = node.content || []
  switch (node.type) {
    case 'paragraph': return inlineMarkdown(content)
    case 'heading': return `${'#'.repeat(Math.max(1, Math.min(6, Number(node.attrs?.level) || 1)))} ${inlineMarkdown(content)}`
    case 'blockquote': return blockMarkdown(content[0] || { type: 'paragraph' }).split('\n').map((line) => `> ${line}`).join('\n')
    case 'bulletList': return content.map((item) => `- ${inlineMarkdown(item.content?.[0]?.content || item.content || [])}`).join('\n')
    case 'orderedList': return content.map((item, index) => `${index + 1}. ${inlineMarkdown(item.content?.[0]?.content || item.content || [])}`).join('\n')
    case 'taskList': return content.map((item) => `- [${item.attrs?.checked ? 'x' : ' '}] ${inlineMarkdown(item.content?.[0]?.content || item.content || [])}`).join('\n')
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
  try { return sanitizeMarkdownHtml(marked.parse(content) as string) } catch { return '' }
}

export const NoteNode: React.FC<{ id: string; data: CanvasComponentData }> = ({ id, data }) => {
  const { updateNode, deleteNode, setSelectedNodeId, commitHistory } = useWorkspaceStore()
  const props = data.properties || {}
  const title = String(props.title || 'Nota')
  const content = String(props.content || '')
  const lastLocalMarkdown = useRef(content)
  const [saveState, setSaveState] = useState<'saving' | 'saved'>('saved')
  // Recompute the seed when React Flow reuses this component for another note;
  // the editor effect below handles live external updates without remounting
  // on every keystroke.
  const initialContent = useMemo(() => markdownAsHtml(content), [content])
  const [isEditing, setIsEditing] = useState(false)

  const editor = useEditor({
    extensions: [
      // StarterKit v3 bundles Link. Disable that instance so the configured
      // extension below is the only link extension in the editor (otherwise
      // every note mount logs a duplicate-extension warning).
      StarterKit.configure({ link: false }),
      Link.configure({ openOnClick: false, protocols: ['http', 'https'] }),
      Placeholder.configure({ placeholder: 'Escreve, usa / para blocos…' }),
      TaskList,
      TaskItem.configure({ nested: true })
    ],
    content: initialContent,
    editorProps: { attributes: { class: 'tiptap note-editor', spellcheck: 'true', 'aria-label': 'Conteúdo da nota', 'aria-multiline': 'true' } },
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
    if (!editor || content === lastLocalMarkdown.current) return
    lastLocalMarkdown.current = content
    editor.commands.setContent(markdownAsHtml(content), { emitUpdate: false })
  }, [content, editor])

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

  return (
    <div className={`node note-node ${isEditing ? 'note-editor-focused' : ''}`} data-kind="note" data-editor-focused={isEditing ? 'true' : undefined} style={{ width: '100%', height: '100%', minWidth: 220, minHeight: 180 }} onClick={() => setSelectedNodeId(id)}>
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
        <button type="button" className="icon-btn" aria-label="Citação" onClick={(event) => { event.stopPropagation(); editor?.chain().focus().toggleBlockquote().run() }} title="Citação"><Quote className="icon" /></button>
        <button type="button" className="icon-btn" aria-label="Bloco de código" onClick={(event) => { event.stopPropagation(); editor?.chain().focus().toggleCodeBlock().run() }} title="Código"><Code2 className="icon" /></button>
        <button type="button" className="icon-btn" aria-label="Negrito" onClick={(event) => { event.stopPropagation(); editor?.chain().focus().toggleBold().run() }} title="Negrito"><Bold className="icon" /></button>
        <button type="button" className="icon-btn" aria-label="Itálico" onClick={(event) => { event.stopPropagation(); editor?.chain().focus().toggleItalic().run() }} title="Itálico"><Italic className="icon" /></button>
        <button type="button" className="icon-btn" aria-label="Eliminar nota" onClick={(event) => { event.stopPropagation(); deleteNode(id) }} title="Eliminar nota"><X className="icon" /></button>
      </div>
      <div
        className={`markdown-note note-editor-shell nodrag nowheel ${isEditing ? 'is-editing' : ''}`}
        onPointerDown={(event) => { event.stopPropagation(); setSelectedNodeId(id) }}
        onFocusCapture={() => { setIsEditing(true); setSelectedNodeId(id) }}
        onBlurCapture={(event) => {
          const nextTarget = event.relatedTarget
          if (!(nextTarget instanceof Node) || !event.currentTarget.contains(nextTarget)) setIsEditing(false)
        }}
      >
        <EditorContent editor={editor} />
      </div>
      <div className="note-footer" aria-live="polite"><Eye className="icon" aria-hidden="true" /> {saveState === 'saving' ? 'A guardar…' : 'Guardado'} · Markdown canónico</div>
    </div>
  )
}
