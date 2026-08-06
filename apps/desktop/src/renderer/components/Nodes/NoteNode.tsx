import React, { useState } from 'react'
import { Handle, Position } from '@xyflow/react'
import { FileText, Edit2, Eye, X } from 'lucide-react'
import { marked } from 'marked'
import { useWorkspaceStore } from '../../store/workspaceStore'

export const NoteNode: React.FC<{ id: string; data: any }> = ({ id, data }) => {
  const [isEditing, setIsEditing] = useState(false)
  const { updateNode, deleteNode, setSelectedNodeId } = useWorkspaceStore()

  const props = data.properties || {}
  const title = props.title || 'Sticky Note'
  const content = props.content || 'Digita aqui as tuas notas em Markdown...'

  const handleContentChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    updateNode(id, { properties: { ...props, content: e.target.value } })
  }

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
        width: data.width || 320,
        height: data.height || 240,
        minWidth: 200,
        minHeight: 160
      }}
      onClick={() => setSelectedNodeId(id)}
    >
      <Handle type="target" position={Position.Left} className="port left" />
      <Handle type="source" position={Position.Right} className="port right" />

      <div className="node-head">
        <div className="node-icon">
          <FileText className="icon" />
        </div>
        <div className="node-title">
          <strong>{title}</strong>
          <span>Nota Markdown</span>
        </div>

        <button className="icon-btn" onClick={() => setIsEditing(!isEditing)} title={isEditing ? 'Preview' : 'Editar'}>
          {isEditing ? <Eye className="icon" /> : <Edit2 className="icon" />}
        </button>

        <button className="icon-btn" onClick={() => deleteNode(id)} title="Eliminar Nota">
          <X className="icon" />
        </button>
      </div>

      <div className="markdown-note" style={{ height: 'calc(100% - 33px)' }}>
        {isEditing ? (
          <textarea
            className="note-source"
            value={content}
            onChange={handleContentChange}
            placeholder="Digita em Markdown..."
            style={{ display: 'block' }}
          />
        ) : (
          <div
            className="note-preview"
            dangerouslySetInnerHTML={renderMarkdown()}
            onDoubleClick={() => setIsEditing(true)}
          />
        )}
      </div>
    </div>
  )
}
