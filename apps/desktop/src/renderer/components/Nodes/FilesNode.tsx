import React, { useState, useEffect } from 'react'
import { Handle, Position } from '@xyflow/react'
import { FolderTree, FileCode, GitBranch, Search, X, GitCommit } from 'lucide-react'
import { useWorkspaceStore } from '../../store/workspaceStore'

export const FilesNode: React.FC<{ id: string; data: any }> = ({ id, data }) => {
  const [viewMode, setViewMode] = useState<'list' | 'diff' | 'graph'>('list')
  const [selectedFile, setSelectedFile] = useState<string | null>('src/App.tsx')
  const [fileContent, setFileContent] = useState<string>('// Seleciona um ficheiro para visualizar o código...')
  const [gitStatus, setGitStatus] = useState<any>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const { deleteNode, setSelectedNodeId } = useWorkspaceStore()

  const props = data.properties || {}
  const projectPath = props.path || '/home/user/dev/commerce'

  useEffect(() => {
    if (window.orchestra?.invoke) {
      window.orchestra.invoke('git.status', { path: projectPath }).then((res: any) => {
        if (res) setGitStatus(res)
      }).catch(console.error)
    }
  }, [projectPath])

  const handleSelectFile = (path: string) => {
    setSelectedFile(path)
    if (window.orchestra?.invoke) {
      window.orchestra.invoke('workspace.read_file', { path: `${projectPath}/${path}` })
        .then((res: any) => {
          if (res?.content) setFileContent(res.content)
        })
        .catch(() => setFileContent(`// Ficheiro ${path} aberto (simulação local)`))
    } else {
      setFileContent(`// Conteúdo do ficheiro: ${path}\n\nexport const App = () => {\n  return <div>Orchestra Desktop</div>\n}`)
    }
  }

  return (
    <div
      className="node"
      data-kind="files"
      style={{
        width: data.width || 480,
        height: data.height || 320,
        minWidth: 340,
        minHeight: 220
      }}
      onClick={() => setSelectedNodeId(id)}
    >
      <Handle type="target" position={Position.Left} className="port left" />
      <Handle type="source" position={Position.Right} className="port right" />

      {/* Header */}
      <div className="node-head">
        <div className="node-icon">
          <FolderTree className="icon" />
        </div>
        <div className="node-title">
          <strong>Explorador do Projeto</strong>
          <span>{projectPath}</span>
        </div>

        <button className="icon-btn" onClick={() => deleteNode(id)} title="Fechar Ficheiros">
          <X className="icon" />
        </button>
      </div>

      {/* Tree toolbar view switcher */}
      <div className="tree-modebar" style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '4px 8px', borderBottom: '1px solid var(--line)' }}>
        <button className={viewMode === 'list' ? 'active' : ''} onClick={() => setViewMode('list')}>Ficheiros</button>
        <button className={viewMode === 'diff' ? 'active' : ''} onClick={() => setViewMode('diff')}>Git Diff</button>
        <button className={viewMode === 'graph' ? 'active' : ''} onClick={() => setViewMode('graph')}>Graph</button>
        <span style={{ flex: 1 }} />
        <span className="branch-pill" style={{ font: '9px var(--mono)', padding: '2px 6px', borderRadius: 999, background: 'var(--primary-muted)', color: 'var(--primary)' }}>
          <GitBranch className="icon" style={{ width: 10, height: 10, display: 'inline', marginRight: 4 }} />
          {gitStatus?.branch || 'main'}
        </span>
      </div>

      {/* Body Content */}
      <div style={{ height: 'calc(100% - 73px)', display: 'grid', gridTemplateColumns: '160px 1fr' }}>
        {/* Left File List / Git view */}
        <div style={{ borderRight: '1px solid var(--line)', padding: 6, overflow: 'auto' }}>
          {viewMode === 'list' && (
            <div style={{ font: '10px var(--mono)' }}>
              {['src/App.tsx', 'src/main.rs', 'src/components/Header.tsx', 'package.json', 'README.md'].map((file) => (
                <div
                  key={file}
                  className={`tree-line ${selectedFile === file ? 'active' : ''}`}
                  onClick={() => handleSelectFile(file)}
                  style={{ padding: '3px 6px', borderRadius: 4, cursor: 'pointer', marginBottom: 2 }}
                >
                  {file}
                </div>
              ))}
            </div>
          )}

          {viewMode === 'diff' && (
            <div style={{ font: '9px var(--mono)', color: 'var(--muted)' }}>
              <b>Alterações pendentes:</b>
              <div style={{ color: 'var(--warn)', marginTop: 4 }}>M src/App.tsx</div>
              <div style={{ color: 'var(--success)' }}>A src/components/Floor.tsx</div>
              <button
                className="btn primary"
                style={{ marginTop: 12, height: 24, fontSize: 9, width: '100%', justifyContent: 'center' }}
                onClick={() => {
                  if (window.orchestra?.invoke) {
                    window.orchestra.invoke('git.commit', { path: projectPath, message: 'update features' })
                  }
                }}
              >
                <GitCommit className="icon" style={{ width: 12, height: 12 }} /> Commit
              </button>
            </div>
          )}

          {viewMode === 'graph' && (
            <div style={{ font: '9px var(--mono)', color: 'var(--muted)' }}>
              <div>● <b>a1b2c3d</b> initial commit</div>
              <div style={{ marginTop: 6 }}>● <b>f4e5d6c</b> add floor system</div>
            </div>
          )}
        </div>

        {/* Right Code Area */}
        <div style={{ padding: 8, overflow: 'auto', background: 'var(--canvas)', font: '10px/1.5 var(--mono)' }}>
          <pre style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{fileContent}</pre>
        </div>
      </div>
    </div>
  )
}
