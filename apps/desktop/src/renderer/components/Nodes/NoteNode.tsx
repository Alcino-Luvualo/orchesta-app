import React, { useEffect, useRef, useState } from 'react'
import { Handle, Position, NodeResizer } from '@xyflow/react'
import { Edit2, Eye, X } from 'lucide-react'
import { marked } from 'marked'
import { useWorkspaceStore } from '../../store/workspaceStore'

export const NoteNode: React.FC<{ id: string; data: any }> = ({ id, data }) => {
  const [isEditing, setIsEditing] = useState(false)
  const editorRef = useRef<HTMLTextAreaElement>(null)
  const { updateNode, deleteNode, setSelectedNodeId } = useWorkspaceStore()

  const props = data.properties || {}
  const title = props.title || 'Sticky Note'
  const content = props.content ?? ''

  const handleContentChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    updateNode(id, { properties: { ...props, content: e.target.value } })
  }

  useEffect(() => {
    const receiveAction = (event: Event) => {
      const command = (event as CustomEvent<'bold' | 'italic' | 'list' | 'check'>).detail
      if (!command) return
      const marker = command === 'bold' ? '**texto**' : command === 'italic' ? '*texto*' : command === 'list' ? '- item' : '- [ ] tarefa'
      const input = editorRef.current
      const start = input?.selectionStart ?? content.length
      const end = input?.selectionEnd ?? content.length
      const selected = content.slice(start, end) || marker
      const wrapped = command === 'bold' ? `**${selected === marker ? 'texto' : selected}**`
        : command === 'italic' ? `*${selected === marker ? 'texto' : selected}*`
        : selected
      updateNode(id, { properties: { ...props, content: `${content.slice(0, start)}${wrapped}${content.slice(end)}` } })
      setIsEditing(true)
      requestAnimationFrame(() => input?.focus())
    }
    window.addEventListener('orchestra:note-action', receiveAction)
    return () => window.removeEventListener('orchestra:note-action', receiveAction)
  }, [content, id, props, updateNode])

  const renderMarkdown = () => {
    try {
      const html = marked.parse(content) as string
      return { __html: html }
    } catch {
      return { __html: content }
    }
  }

  return (
    <div
      className="node"
      data-kind="note"
      style={{
        width: '100%',
        height: '100%',
        minWidth: 200,
        minHeight: 160
      }}
      onClick={() => setSelectedNodeId(id)}
    >
      <NodeResizer
        isVisible={data.selected}
        minWidth={200}
        minHeight={160}
        handleClassName="nodrag nopan canvas-resize-handle"
        lineClassName="nodrag nopan canvas-resize-line"
        onResize={(_, params) => updateNode(id, { width: params.width, height: params.height })}
      />
      <Handle type="target" position={Position.Left} className="port left" />
      <Handle type="source" position={Position.Right} className="port right" />

      <div className="sticky-note-head">
        <span className="sticky-note-title">{title}</span>
        <button className="icon-btn" onClick={(event) => { event.stopPropagation(); setIsEditing(!isEditing) }} title={isEditing ? 'Pré-visualizar' : 'Editar'}>
          {isEditing ? <Eye className="icon" /> : <Edit2 className="icon" />}
        </button>
        <button className="icon-btn" onClick={(event) => { event.stopPropagation(); deleteNode(id) }} title="Eliminar nota">
          <X className="icon" />
        </button>
      </div>

      <div className="markdown-note">
        {isEditing ? (
          <textarea
            ref={editorRef}
            className="note-source nodrag nowheel"
            value={content}
            onChange={handleContentChange}
            placeholder="Escreve a tua nota (Markdown)..."
            onPointerDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
            style={{ display: 'block' }}
          />
        ) : (
          <div
            className="note-preview nodrag nowheel"
            dangerouslySetInnerHTML={renderMarkdown()}
            onPointerDown={(e) => e.stopPropagation()}
            onDoubleClick={() => setIsEditing(true)}
          />
        )}
      </div>
    </div>
  )
}
