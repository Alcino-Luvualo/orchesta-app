import React, { useEffect, useMemo, useState } from 'react'
import { Handle, Position } from '@xyflow/react'
import { ChevronDown, ChevronRight, FileCode2, FileText, Folder, FolderOpen, GitBranch, GitCommitHorizontal, Search, X } from 'lucide-react'
import { useWorkspaceStore } from '../../store/workspaceStore'

type ViewMode = 'list' | 'diff' | 'graph'
type TreeItem = { name: string; path: string; is_dir: boolean; children?: TreeItem[]; extension?: string }

const demoEntries = [
  { path: 'src', fullPath: 'src', kind: 'folder', depth: 0, open: true },
  { path: 'app', fullPath: 'src/app', kind: 'folder', depth: 1, open: true },
  { path: 'auth', fullPath: 'src/app/auth', kind: 'folder', depth: 2, open: true },
  { path: 'session.ts', fullPath: 'src/app/auth/session.ts', kind: 'file', depth: 3, status: 'M' },
  { path: 'login.tsx', fullPath: 'src/app/auth/login.tsx', kind: 'file', depth: 3, status: 'M' },
  { path: 'components', fullPath: 'src/components', kind: 'folder', depth: 1, open: false },
  { path: 'api', fullPath: 'src/api', kind: 'folder', depth: 1, open: false },
  { path: 'tests', fullPath: 'tests', kind: 'folder', depth: 0, open: false },
  { path: 'package.json', fullPath: 'package.json', kind: 'file', depth: 0, status: 'M' },
  { path: 'README.md', fullPath: 'README.md', kind: 'file', depth: 0 }
]

const sampleCode = `import { createSession } from './session'

export async function login(request: Request) {
  const user = await authenticate(request)
  const session = await createSession(user.id)

  return Response.json({ user, session })
}`

export const FilesNode: React.FC<{ id: string; data: any }> = ({ id, data }) => {
  const [viewMode, setViewMode] = useState<ViewMode>('list')
  const [selectedFile, setSelectedFile] = useState('login.tsx')
  const [selectedFilePath, setSelectedFilePath] = useState('src/app/auth/login.tsx')
  const [fileContent, setFileContent] = useState(sampleCode)
  const [gitStatus, setGitStatus] = useState<any>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [tree, setTree] = useState<TreeItem | null>(null)
  const { deleteNode, setSelectedNodeId } = useWorkspaceStore()
  const props = data.properties || {}
  const projectPath = props.path || '/home/user/dev/commerce'
  const isWide = (data.width || 440) >= 580

  useEffect(() => {
    window.orchestra?.invoke?.('git.status', { path: projectPath }).then(setGitStatus).catch(() => undefined)
  }, [projectPath])

  useEffect(() => {
    let cancelled = false
    window.orchestra?.invoke?.('workspace.tree', { path: projectPath, depth: 4 }).then((result: TreeItem | { error?: string }) => {
      if (!cancelled && result && !('error' in result)) setTree(result as TreeItem)
    }).catch(() => undefined)
    return () => { cancelled = true }
  }, [projectPath])

  const entries = useMemo(() => {
    if (!tree) return demoEntries
    const flattened: Array<{ path: string; fullPath: string; kind: 'file' | 'folder'; depth: number; open: boolean; status?: string }> = []
    const walk = (item: TreeItem, depth: number) => {
      if (depth > 0) flattened.push({ path: item.name, fullPath: item.path, kind: item.is_dir ? 'folder' : 'file', depth: depth - 1, open: item.is_dir })
      item.children?.forEach((child) => walk(child, depth + 1))
    }
    walk(tree, 0)
    return flattened
  }, [tree])

  const visibleEntries = useMemo(() => entries.filter((entry) => entry.path.toLowerCase().includes(searchQuery.toLowerCase())), [entries, searchQuery])
  const selectFile = (file: string) => {
    setSelectedFile(file.split('/').pop() || file)
    const resolved = file.startsWith('/') ? file : `${projectPath}/${file}`
    setSelectedFilePath(resolved)
    window.orchestra?.invoke?.('workspace.read_file', { path: resolved })
      .then((result: any) => setFileContent(result?.content || sampleCode))
      .catch(() => setFileContent(sampleCode))
  }

  return (
    <div className="node files-node" data-kind="files" style={{ width: data.width || 440, height: data.height || 300, minWidth: 330, minHeight: 220 }} onClick={() => setSelectedNodeId(id)}>
      <Handle type="target" position={Position.Left} className="port left" />
      <Handle type="source" position={Position.Right} className="port right" />

      <header className="files-head">
        <div className="files-nav"><button disabled>‹</button><button disabled>›</button></div>
        <strong>{props.title || 'Project files'}</strong>
        <div className="files-head-spacer" />
        <div className="files-view-switcher" aria-label="Vista do ficheiro">
          <button className={viewMode === 'list' ? 'active' : ''} onClick={() => setViewMode('list')}>Tree</button>
          <button className={viewMode === 'diff' ? 'active' : ''} onClick={() => setViewMode('diff')}>Diff</button>
          <button className={viewMode === 'graph' ? 'active' : ''} onClick={() => setViewMode('graph')}>Graph</button>
        </div>
        <button className="branch-pill" title="Operações Git"><GitBranch className="icon" />{gitStatus?.branch || 'main'}<ChevronDown className="icon" /></button>
        <button className="icon-btn" onClick={(event) => { event.stopPropagation(); deleteNode(id) }} title="Fechar ficheiros"><X className="icon" /></button>
      </header>

      <div className={`files-body ${isWide ? 'wide' : ''}`}>
        <section className="files-tree-pane">
          {viewMode === 'list' && <>
            <div className="file-tree-list">
              {visibleEntries.map((entry, index) => {
                const isFolder = entry.kind === 'folder'
                const Icon = isFolder ? (entry.open ? FolderOpen : Folder) : entry.path.endsWith('.md') ? FileText : FileCode2
                return <button key={`${entry.fullPath}-${index}`} className={`file-row ${selectedFile === entry.path ? 'selected' : ''}`} style={{ paddingLeft: 9 + entry.depth * 15 }} onClick={() => !isFolder && selectFile(entry.fullPath)}>
                  {isFolder ? (entry.open ? <ChevronDown className="disclosure" /> : <ChevronRight className="disclosure" />) : <span className="disclosure" />}
                  <Icon className={`file-icon ${isFolder ? 'folder' : ''}`} />
                  <span>{entry.path}</span>{entry.status && <i className="git-mark">{entry.status}</i>}
                </button>
              })}
            </div>
            <label className="files-search"><Search className="icon" /><input value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder="Search files" /></label>
          </>}

          {viewMode === 'diff' && <div className="git-diff-list">
            <span className="diff-summary">3 changes</span>
            {['src/app/auth/session.ts', 'src/app/auth/login.tsx', 'package.json'].map((file) => <button key={file} onClick={() => { setViewMode('list'); selectFile(file.split('/').pop() || file) }}><i>M</i>{file}</button>)}
            <button className="commit-action"><GitCommitHorizontal className="icon" />Commit changes</button>
          </div>}

          {viewMode === 'graph' && <div className="fork-graph">
            <div className="graph-branch">main</div>
            {[
              ['f8c2e1a', 'Refine authentication flow', 'HEAD · main'],
              ['82fe36a', 'Add refresh-token tests', 'origin/main'],
              ['17d7f18', 'Build login form', ''],
              ['a238eb9', 'Initial workspace', '']
            ].map(([hash, message, badge], index) => <button className="graph-commit" key={hash}><span className={`graph-line ${index === 0 ? 'head' : ''}`} /><span><b>{message}</b><small>{hash} · 2h ago</small></span>{badge && <em>{badge}</em>}</button>)}
          </div>}
        </section>

        {isWide && <section className="files-editor-pane">
          <div className="editor-tab"><FileCode2 className="icon" /><span>{selectedFile}</span><span>×</span></div>
          <textarea className="editor-source nodrag" value={fileContent} spellCheck={false} onChange={(event) => setFileContent(event.target.value)} onBlur={() => {
            window.orchestra?.invoke?.('workspace.write_file', { path: selectedFilePath, content: fileContent }).catch(() => undefined)
          }} aria-label={`Editar ${selectedFile}`} />
          <footer>Ln 1, Col 1 <span>TypeScript</span></footer>
        </section>}
      </div>
    </div>
  )
}
