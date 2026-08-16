import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Handle, NodeResizer, Position } from '@xyflow/react'
import {
  Archive,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CloudDownload,
  CloudUpload,
  Copy,
  FileCode2,
  FilePlus,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  GitBranch,
  GitCommitHorizontal,
  GitFork,
  GitMerge,
  History,
  LoaderCircle,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  SquareStack,
  Tag,
  Trash2,
  Undo2,
  X,
} from 'lucide-react'
import { EditorState } from '@codemirror/state'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { markdown } from '@codemirror/lang-markdown'
import { rust } from '@codemirror/lang-rust'
import { bracketMatching, foldGutter, foldKeymap, indentOnInput } from '@codemirror/language'
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search'
import { drawSelection, EditorView, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers } from '@codemirror/view'
import { oneDark } from '@codemirror/theme-one-dark'
import { CanvasComponentData, useWorkspaceStore } from '../../store/workspaceStore'
import { useModalA11y } from '../Modals/modalUtils'
import {
  buildGraphRows,
  FileTreeItem,
  filterDeletableBranches,
  filterFileTreeRows,
  flattenFileTree,
  gitStatusFlags,
  GraphCommit,
  clampContextMenuPosition,
  mapVisualPointToLayout,
  mergeTreeNode,
  mergeRefreshedTree,
} from './filesTreeUtils'

type ViewMode = 'list' | 'diff' | 'graph'
type GitFile = { path: string; status: string; originalPath?: string; conflict?: boolean }
type GitStatus = { branch?: string; modified_files?: GitFile[]; clean?: boolean; ahead?: number; behind?: number }
type Branch = { name: string; hash: string; current?: boolean; upstream?: string }
type GitRef = { name: string; fullName?: string; kind: 'local' | 'remote' | 'tag'; hash: string; upstream?: string }
type Stash = { name: string; hash: string; message: string }
type Worktree = { path: string; branch?: string; detached?: boolean }
type ContentResult = { name: string; path: string; line?: number; snippet?: string }
type Diagnostic = { severity: string; message: string; file?: string; line?: number; column?: number }
type BlameLine = { line?: number; commit?: string; author?: string; authorTime?: string; summary?: string; content?: string }
type TreeRow = ReturnType<typeof flattenFileTree>[number]
type Notice = { kind: 'success' | 'error' | 'info'; message: string }
type ConfirmState = { title: string; message: string; action: () => Promise<void> }

function invoke<T = unknown>(type: string, payload: Record<string, unknown> = {}): Promise<T> {
  if (!window.orchestra?.invoke) return Promise.reject(new Error('A ponte do Orchestra não está disponível.'))
  return window.orchestra.invoke(type, payload) as Promise<T>
}

function errorMessage(reason: unknown, fallback: string) {
  return reason instanceof Error && reason.message ? reason.message : fallback
}

function normalizeUnixPath(value: string): string {
  const absolute = value.startsWith('/')
  const parts: string[] = []
  value.split('/').forEach((part) => {
    if (!part || part === '.') return
    if (part === '..') { parts.pop(); return }
    parts.push(part)
  })
  return `${absolute ? '/' : ''}${parts.join('/')}` || (absolute ? '/' : '.')
}

function joinWorkspacePath(root: string, value: string) {
  if (value.startsWith('/')) return normalizeUnixPath(value)
  return normalizeUnixPath(`${root.replace(/\/$/, '')}/${value}`)
}

function relativeWorkspacePath(root: string, value: string) {
  const normalizedRoot = normalizeUnixPath(root)
  const normalizedValue = normalizeUnixPath(value)
  if (normalizedValue === normalizedRoot) return '.'
  return normalizedValue.startsWith(`${normalizedRoot}/`) ? normalizedValue.slice(normalizedRoot.length + 1) : value
}

/**
 * A File Tree may intentionally target a directory outside the active
 * workspace. Keep that path separate from the registered workspace root:
 * workspace-scoped requests keep their workspace id, while an explicitly
 * selected external root is sent as a standalone read/write root. This keeps
 * the core sandbox intact for workspace requests without rejecting a valid
 * directory chosen in the File Tree modal.
 */
function resolveProjectPath(workspaceRoot: string, requested: string): { path: string; outside: boolean } {
  const root = normalizeUnixPath(workspaceRoot)
  if (!root) return { path: normalizeUnixPath(requested), outside: false }
  const raw = requested.trim()
  const candidate = normalizeUnixPath(raw.startsWith('/') ? raw : `${root}/${raw}`)
  const inside = candidate === root || candidate.startsWith(`${root}/`)
  return { path: inside ? candidate : root, outside: Boolean(raw) && !inside }
}

function languageExtension(fileName: string) {
  const lower = fileName.toLowerCase()
  if (lower.endsWith('.rs')) return rust()
  if (lower.endsWith('.json')) return json()
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return markdown()
  if (/\.(js|jsx|ts|tsx|mjs|cjs)$/.test(lower)) return javascript({ jsx: true, typescript: /\.(ts|tsx)$/.test(lower) })
  return []
}

function displayStatus(status: string) {
  if (status === '??') return 'U'
  const flags = gitStatusFlags(status)
  if (flags.conflict) return '!'
  if (flags.staged && flags.unstaged) return 'M'
  if (flags.staged) return 'S'
  return 'M'
}

function fileName(path: string) { return path.split('/').filter(Boolean).pop() || path }

function findTreeItem(root: FileTreeItem | null, path: string): FileTreeItem | null {
  if (!root) return null
  if (root.path === path) return root
  for (const child of root.children || []) {
    const found = findTreeItem(child, path)
    if (found) return found
  }
  return null
}

function allDirectoryPaths(root: FileTreeItem | null) {
  const paths = new Set<string>()
  const walk = (item: FileTreeItem) => {
    if (!item.is_dir) return
    paths.add(item.path)
    item.children?.forEach(walk)
  }
  if (root) walk(root)
  return paths
}

export const FilesNode: React.FC<{ id: string; data: CanvasComponentData }> = ({ id, data }) => {
  const [viewMode, setViewMode] = useState<ViewMode>('list')
  const [selectedFile, setSelectedFile] = useState('')
  const [selectedFilePath, setSelectedFilePath] = useState('')
  const [selectedFolderPath, setSelectedFolderPath] = useState('')
  const [treeFocusPath, setTreeFocusPath] = useState('')
  const [newEntryName, setNewEntryName] = useState('')
  const [newEntryMode, setNewEntryMode] = useState<'file' | 'folder' | 'rename'>('file')
  const [branchDraft, setBranchDraft] = useState('')
  const [branchToDelete, setBranchToDelete] = useState('')
  const [tagDraft, setTagDraft] = useState('')
  const [tagToDelete, setTagToDelete] = useState('')
  const [stashTarget, setStashTarget] = useState('')
  const [worktreeDraft, setWorktreeDraft] = useState('')
  const [worktreeBranchDraft, setWorktreeBranchDraft] = useState('')
  const [historyTarget, setHistoryTarget] = useState('')
  const [operationKind, setOperationKind] = useState('merge')
  const [resetMode, setResetMode] = useState<'soft' | 'mixed' | 'hard'>('mixed')
  const [fileContent, setFileContent] = useState('')
  const [gitStatus, setGitStatus] = useState<GitStatus | null>(null)
  const [commits, setCommits] = useState<GraphCommit[]>([])
  const [branches, setBranches] = useState<Branch[]>([])
  const [refs, setRefs] = useState<GitRef[]>([])
  const [stashes, setStashes] = useState<Stash[]>([])
  const [worktrees, setWorktrees] = useState<Worktree[]>([])
  const [diffText, setDiffText] = useState<{ working: string; staged: string }>({ working: '', staged: '' })
  const [selectedGitPath, setSelectedGitPath] = useState('')
  const [selectedCommitHash, setSelectedCommitHash] = useState('')
  const [contentResults, setContentResults] = useState<ContentResult[]>([])
  const [blameLines, setBlameLines] = useState<BlameLine[]>([])
  const [diagnostics, setDiagnostics] = useState<Diagnostic[]>([])
  const [searchQuery, setSearchQuery] = useState('')
  const [tree, setTree] = useState<FileTreeItem | null>(null)
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set())
  const [loadedPaths, setLoadedPaths] = useState<Set<string>>(new Set())
  const [loadingPaths, setLoadingPaths] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(true)
  const [loadingFile, setLoadingFile] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [fileError, setFileError] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'error'>('saved')
  const [commitMessage, setCommitMessage] = useState('')
  const [pendingLocation, setPendingLocation] = useState<{ line: number; column?: number } | null>(null)
  const [gitBusy, setGitBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [confirmState, setConfirmState] = useState<ConfirmState | null>(null)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; row: TreeRow } | null>(null)
  const [graphScrollTop, setGraphScrollTop] = useState(0)
  const [graphViewportHeight, setGraphViewportHeight] = useState(360)
  const { updateNode, deleteNode, setSelectedNodeId, commitHistory, activeWorkspace, activeFloor } = useWorkspaceStore()
  const editorHostRef = useRef<HTMLDivElement>(null)
  const editorViewRef = useRef<EditorView | null>(null)
  const saveFileRef = useRef<() => void>(() => undefined)
  const lastDiskContentRef = useRef('')
  const syncingDiskRef = useRef(false)
  const treeListRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const graphRef = useRef<HTMLDivElement>(null)
  const newEntryRef = useRef<HTMLInputElement>(null)
  const contextMenuRef = useRef<HTMLDivElement>(null)
  const contextMenuRowPathRef = useRef('')
  const confirmRef = useModalA11y({
    open: Boolean(confirmState),
    onClose: () => setConfirmState(null)
  })
  const props = data.properties || {}
  const workspaceRoot = normalizeUnixPath(String(activeWorkspace?.path || ''))
  const configuredProjectPath = String(props.path || props.cwd || activeFloor?.path || workspaceRoot || '')
  const resolvedProject = resolveProjectPath(workspaceRoot, configuredProjectPath)
  const projectPath = resolvedProject.path
  const workspaceId = activeWorkspace?.id
  const externalRoot = resolvedProject.outside ? projectPath : ''
  const fileRoot = externalRoot || workspaceRoot
  const fileWorkspaceId = externalRoot ? undefined : workspaceId
  const isWide = (data.width || 440) >= 580
  // `fileRoot` is the actual root used by this node. For an external File
  // Tree it equals `projectPath`, so all descendants remain inside the folder
  // explicitly chosen by the user instead of being compared with another
  // workspace's root.
  const payloadBase = useMemo(() => ({
    ...(fileWorkspaceId ? { workspaceId: fileWorkspaceId } : {}),
    workspaceRoot: fileRoot,
  }), [fileRoot, fileWorkspaceId])

  const setFeedback = useCallback((next: Notice) => {
    setNotice(next)
    window.setTimeout(() => setNotice((current) => current?.message === next.message ? null : current), 4200)
  }, [])

  const loadData = useCallback(async () => {
    if (!fileRoot || !projectPath || !window.orchestra?.invoke) {
      setLoading(false)
      setError('Escolhe um diretório válido para abrir os ficheiros.')
      return
    }
    setLoading(true)
    // A directory selected outside the active workspace is sent as its own
    // sandbox root. Only actual filesystem/request failures become errors.
    setError(null)
    const base = { ...payloadBase, path: relativeWorkspacePath(fileRoot, projectPath) }
    const requests = await Promise.allSettled([
      invoke<FileTreeItem>('workspace.tree', { ...base, depth: 1 }),
      invoke<GitStatus>('git.status', base),
      invoke<{ commits?: GraphCommit[] }>('git.log', { ...base, limit: 500 }),
      invoke<{ branches?: Branch[] }>('git.branch.list', base),
      invoke<{ refs?: GitRef[] }>('git.refs', base),
      invoke<{ stashes?: Stash[] }>('git.stash.list', base),
      invoke<{ worktrees?: Worktree[] }>('git.worktrees', base),
    ])
    const [treeResult, statusResult, logResult, branchResult, refsResult, stashResult, worktreeResult] = requests
    if (treeResult.status === 'rejected' || !treeResult.value?.is_dir) {
      setTree(null)
      setError(treeResult.status === 'rejected' ? errorMessage(treeResult.reason, 'Não foi possível carregar a árvore.') : 'O diretório do workspace não está disponível.')
    } else {
      // The periodic refresh asks the core for a shallow root listing. Keep
      // already-loaded descendants when replacing that listing, otherwise the
      // expanded-path set and loaded-path cache disagree and clicking an open
      // folder appears to do nothing after the next refresh.
      setTree((current) => mergeRefreshedTree(current, treeResult.value))
      setExpandedPaths((current) => current.size ? current : new Set([treeResult.value.path]))
      setLoadedPaths((current) => new Set(current).add(treeResult.value.path))
    }
    if (statusResult.status === 'fulfilled') setGitStatus(statusResult.value || null)
    if (logResult.status === 'fulfilled') setCommits(Array.isArray(logResult.value?.commits) ? logResult.value.commits : [])
    if (branchResult.status === 'fulfilled') setBranches(Array.isArray(branchResult.value?.branches) ? branchResult.value.branches : [])
    if (refsResult.status === 'fulfilled') setRefs(Array.isArray(refsResult.value?.refs) ? refsResult.value.refs : [])
    if (stashResult.status === 'fulfilled') setStashes(Array.isArray(stashResult.value?.stashes) ? stashResult.value.stashes : [])
    if (worktreeResult.status === 'fulfilled') setWorktrees(Array.isArray(worktreeResult.value?.worktrees) ? worktreeResult.value.worktrees : [])
    setLoading(false)
  }, [fileRoot, payloadBase, projectPath])

  useEffect(() => { void loadData() }, [loadData])

  useEffect(() => {
    const timer = window.setInterval(() => { void loadData() }, 8000)
    return () => window.clearInterval(timer)
  }, [loadData])

  useEffect(() => {
    const graph = graphRef.current
    if (!graph || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(([entry]) => setGraphViewportHeight(Math.max(180, entry.contentRect.height)))
    observer.observe(graph)
    return () => observer.disconnect()
  }, [viewMode])

  useEffect(() => {
    const close = () => setContextMenu(null)
    window.addEventListener('pointerdown', close)
    return () => window.removeEventListener('pointerdown', close)
  }, [])

  // A native context menu is not available inside a scaled React Flow node,
  // so the tree owns a small accessible menu. Move focus into it after paint
  // and return focus to the row when Escape closes it; otherwise the next Tab
  // can jump out of the node or land on an unrelated canvas control.
  useEffect(() => {
    if (!contextMenu) {
      const path = contextMenuRowPathRef.current
      if (!path) return
      contextMenuRowPathRef.current = ''
      // Menu actions (new/rename/stage) explicitly focus their destination.
      // Only restore focus when the menu itself disappeared, e.g. Escape or
      // an outside click, so those actions do not lose their newly focused
      // input on the next animation frame.
      const active = document.activeElement
      if (active && active !== document.body && active.isConnected) return
      window.requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-file-tree-path="${CSS.escape(path)}"]`)?.focus())
      return
    }
    contextMenuRowPathRef.current = contextMenu.row.item.path
    window.requestAnimationFrame(() => contextMenuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus())
  }, [contextMenu])

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !contextMenu) return
      event.preventDefault()
      event.stopPropagation()
      setContextMenu(null)
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [contextMenu])

  const statuses = useMemo(() => new Map((gitStatus?.modified_files || []).map((file) => [joinWorkspacePath(projectPath, file.path), file])), [gitStatus?.modified_files, projectPath])
  const flatEntries = useMemo(() => {
    const expanded = new Set(expandedPaths)
    if (searchQuery.trim()) allDirectoryPaths(tree).forEach((path) => expanded.add(path))
    return flattenFileTree(tree, expanded)
  }, [expandedPaths, searchQuery, tree])
  const visibleEntries = useMemo(() => filterFileTreeRows(flatEntries, searchQuery), [flatEntries, searchQuery])
  const graphRows = useMemo(() => buildGraphRows(commits), [commits])
  const graphWindow = useMemo(() => {
    const rowHeight = 48
    const start = Math.max(0, Math.floor(graphScrollTop / rowHeight) - 8)
    const end = Math.min(graphRows.length, start + Math.ceil(graphViewportHeight / rowHeight) + 16)
    return { start, end, rowHeight, rows: graphRows.slice(start, end) }
  }, [graphRows, graphScrollTop, graphViewportHeight])
  const changedFiles = gitStatus?.modified_files || []
  const selectedGitFile = changedFiles.find((file) => file.path === selectedGitPath) || changedFiles[0]
  const selectedCommit = commits.find((commit) => commit.hash === selectedCommitHash)
  const currentBranch = gitStatus?.branch || branches.find((branch) => branch.current)?.name || ''
  const deletableBranches = useMemo(() => filterDeletableBranches(branches, currentBranch), [branches, currentBranch])
  const tagRefs = useMemo(() => refs.filter((ref) => ref.kind === 'tag'), [refs])
  const rootPath = tree?.path || projectPath
  const selectedPath = selectedFilePath || selectedFolderPath || treeFocusPath || rootPath
  const breadcrumbs = useMemo(() => {
    const relative = relativeWorkspacePath(projectPath, selectedPath)
    const parts = relative === '.' ? [] : relative.split('/').filter(Boolean)
    const result = [{ label: fileName(projectPath), path: projectPath }]
    let current = projectPath
    parts.forEach((part) => { current = joinWorkspacePath(current, part); result.push({ label: part, path: current }) })
    return result
  }, [projectPath, selectedPath])

  useEffect(() => {
    if (!deletableBranches.some((branch) => branch.name === branchToDelete)) setBranchToDelete(deletableBranches[0]?.name || '')
  }, [branchToDelete, deletableBranches])

  useEffect(() => {
    if (!tagRefs.some((ref) => ref.name === tagToDelete)) setTagToDelete(tagRefs[0]?.name || '')
  }, [tagRefs, tagToDelete])

  useEffect(() => {
    if (!stashes.some((stash) => stash.name === stashTarget)) setStashTarget(stashes[0]?.name || '')
  }, [stashTarget, stashes])

  useEffect(() => {
    if (!changedFiles.length) { setSelectedGitPath(''); return }
    if (!selectedGitPath || !changedFiles.some((file) => file.path === selectedGitPath)) setSelectedGitPath(changedFiles[0].path)
  }, [changedFiles, selectedGitPath])

  const selectFile = useCallback(async (entry: FileTreeItem | { path: string; name: string; is_dir: false }) => {
    if (entry.is_dir || !fileRoot) return
    const resolved = joinWorkspacePath(projectPath, entry.path)
    setFileError(null)
    setSaveState('saved')
    setLoadingFile(true)
    setSelectedFolderPath('')
    setTreeFocusPath(resolved)
    try {
      const result = await invoke<{ content?: string }>('workspace.read_file', { ...payloadBase, path: relativeWorkspacePath(fileRoot, resolved) })
      const content = result?.content ?? ''
      setFileContent(content)
      lastDiskContentRef.current = content
      setSelectedFile(fileName(resolved))
      setSelectedFilePath(resolved)
      setSelectedGitPath(relativeWorkspacePath(projectPath, resolved))
      setDirty(false)
    } catch (reason) {
      setFileError(errorMessage(reason, 'Não foi possível ler o ficheiro.'))
      setFileContent('')
    } finally {
      setLoadingFile(false)
    }
  }, [fileRoot, payloadBase, projectPath])

  const loadFolder = useCallback(async (entry: FileTreeItem, force = false) => {
    if (!entry.is_dir || (!force && loadedPaths.has(entry.path)) || loadingPaths.has(entry.path)) return
    setLoadingPaths((current) => new Set(current).add(entry.path))
    try {
      const result = await invoke<FileTreeItem>('workspace.tree', { ...payloadBase, path: relativeWorkspacePath(fileRoot, entry.path), depth: 1 })
      if (result?.is_dir) {
        setTree((current) => current ? mergeTreeNode(current, result) : current)
        setLoadedPaths((current) => new Set(current).add(entry.path))
      }
    } catch (reason) {
      setFeedback({ kind: 'error', message: errorMessage(reason, 'Não foi possível abrir esta pasta.') })
    } finally {
      setLoadingPaths((current) => { const next = new Set(current); next.delete(entry.path); return next })
    }
  }, [fileRoot, loadedPaths, loadingPaths, payloadBase, projectPath, setFeedback])

  const focusTreeRow = useCallback((index: number) => {
    const row = visibleEntries[index]
    if (!row) return
    setTreeFocusPath(row.item.path)
    window.requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-file-tree-path="${CSS.escape(row.item.path)}"]`)?.focus())
  }, [visibleEntries])

  const toggleFolder = useCallback(async (row: TreeRow) => {
    if (!row.item.is_dir) { void selectFile(row.item); return }
    setTreeFocusPath(row.item.path)
    setSelectedFolderPath(row.item.path)
    setSelectedFilePath('')
    setExpandedPaths((current) => { const next = new Set(current); row.open ? next.delete(row.item.path) : next.add(row.item.path); return next })
    if (!row.open) await loadFolder(row.item, true)
  }, [loadFolder, selectFile])

  const handleTreeKeyDown = useCallback((event: React.KeyboardEvent<HTMLElement>, index: number, row: TreeRow) => {
    if (event.key === '/') {
      event.preventDefault()
      searchRef.current?.focus()
      return
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'p') {
      event.preventDefault()
      searchRef.current?.focus()
      searchRef.current?.select()
      return
    }
    if (event.key === 'ArrowDown') { event.preventDefault(); focusTreeRow(Math.min(visibleEntries.length - 1, index + 1)); return }
    if (event.key === 'ArrowUp') { event.preventDefault(); focusTreeRow(Math.max(0, index - 1)); return }
    if (event.key === 'Home') { event.preventDefault(); focusTreeRow(0); return }
    if (event.key === 'End') { event.preventDefault(); focusTreeRow(Math.max(0, visibleEntries.length - 1)); return }
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); void toggleFolder(row); return }
    if (event.key === 'ArrowRight' && row.item.is_dir) {
      event.preventDefault()
      if (!row.open) void toggleFolder(row)
      else focusTreeRow(Math.min(visibleEntries.length - 1, index + 1))
      return
    }
    if (event.key === 'ArrowLeft') {
      event.preventDefault()
      if (row.item.is_dir && row.open) {
        setExpandedPaths((current) => { const next = new Set(current); next.delete(row.item.path); return next })
        return
      }
      // Match the familiar VS Code tree contract: left on a closed/file row
      // selects its parent rather than doing nothing.
      const parentIndex = row.parentPath ? visibleEntries.findIndex((entry) => entry.item.path === row.parentPath) : -1
      if (parentIndex >= 0) focusTreeRow(parentIndex)
      return
    }
    if (event.key === 'F2') {
      event.preventDefault()
      // F2 acts on the focused row, never on a stale editor/folder selection.
      if (row.item.is_dir) {
        setSelectedFolderPath(row.item.path)
        setSelectedFilePath('')
      } else {
        setSelectedFilePath(joinWorkspacePath(projectPath, row.item.path))
        setSelectedFolderPath('')
        setSelectedFile(row.item.name)
      }
      setNewEntryMode('rename')
      setNewEntryName(row.item.name)
      setTreeFocusPath(row.item.path)
      newEntryRef.current?.focus()
    }
  }, [focusTreeRow, projectPath, toggleFolder, visibleEntries])

  useEffect(() => {
    const onTerminalFileLink = (event: Event) => {
      const detail = (event as CustomEvent<{ path?: string; cwd?: string; line?: number; column?: number; workspaceId?: string }>).detail || {}
      if (!detail.path || (detail.workspaceId && detail.workspaceId !== workspaceId)) return
      const rawPath = detail.path.trim()
      if (!rawPath || rawPath.startsWith('~')) return
      const absolutePath = normalizeUnixPath(rawPath.startsWith('/') ? rawPath : `${detail.cwd || projectPath}/${rawPath}`)
      const root = normalizeUnixPath(projectPath)
      if (absolutePath !== root && !absolutePath.startsWith(`${root}/`)) return
      setViewMode('list')
      setPendingLocation({ line: Math.max(1, Number(detail.line) || 1), column: detail.column ? Math.max(1, Number(detail.column)) : undefined })
      void selectFile({ path: relativeWorkspacePath(root, absolutePath), name: fileName(absolutePath), is_dir: false })
    }
    window.addEventListener('orchestra:terminal-file-link', onTerminalFileLink)
    return () => window.removeEventListener('orchestra:terminal-file-link', onTerminalFileLink)
  }, [projectPath, selectFile, workspaceId])

  const saveFile = useCallback(async () => {
    if (!dirty || !selectedFilePath || !fileRoot) return
    setSaveState('saving')
    const apiPath = relativeWorkspacePath(projectPath, selectedFilePath)
    try {
      const disk = await invoke<{ content?: string }>('workspace.read_file', { ...payloadBase, path: apiPath })
      if (typeof disk?.content === 'string' && disk.content !== lastDiskContentRef.current && disk.content !== fileContent) {
        setSaveState('error')
        setFileError('Conflito externo: o ficheiro mudou no disco. Recarrega antes de guardar.')
        return
      }
      await invoke('workspace.write_file', { ...payloadBase, path: apiPath, content: fileContent })
      lastDiskContentRef.current = fileContent
      setDirty(false)
      setSaveState('saved')
      setFeedback({ kind: 'success', message: `${fileName(selectedFilePath)} guardado.` })
      await loadData()
    } catch (reason) {
      setSaveState('error')
      setFileError(errorMessage(reason, 'Não foi possível guardar o ficheiro.'))
    }
  }, [dirty, fileContent, fileRoot, loadData, payloadBase, projectPath, selectedFilePath, setFeedback])

  saveFileRef.current = saveFile

  useEffect(() => {
    editorViewRef.current?.destroy()
    editorViewRef.current = null
    const host = editorHostRef.current
    if (!host || !selectedFilePath) return
    const state = EditorState.create({
      doc: fileContent,
      extensions: [
        history(), lineNumbers(), highlightActiveLineGutter(), highlightActiveLine(), drawSelection(), foldGutter(), bracketMatching(), closeBrackets(), indentOnInput(), autocompletion(),
        keymap.of([...defaultKeymap, ...historyKeymap, ...foldKeymap, ...closeBracketsKeymap, ...completionKeymap, ...searchKeymap, indentWithTab, { key: 'Mod-s', run: () => { saveFileRef.current(); return true } }]),
        highlightSelectionMatches(), languageExtension(selectedFile), oneDark, EditorView.lineWrapping,
        EditorView.updateListener.of((update) => {
          if (!update.docChanged) return
          if (syncingDiskRef.current) { syncingDiskRef.current = false; return }
          setFileContent(update.state.doc.toString()); setDirty(true); setSaveState('saved')
        }),
      ],
    })
    const view = new EditorView({ state, parent: host })
    editorViewRef.current = view
    return () => { view.destroy(); if (editorViewRef.current === view) editorViewRef.current = null }
  }, [selectedFilePath])

  useEffect(() => {
    const view = editorViewRef.current
    if (!view || !pendingLocation || !selectedFilePath) return
    const line = view.state.doc.line(Math.min(pendingLocation.line, view.state.doc.lines))
    const position = Math.min(line.to, line.from + Math.max(0, (pendingLocation.column || 1) - 1))
    view.dispatch({ selection: { anchor: position }, effects: EditorView.scrollIntoView(position, { y: 'center' }) })
    view.focus(); setPendingLocation(null)
  }, [fileContent, pendingLocation, selectedFilePath])

  useEffect(() => {
    if (!selectedFilePath || !fileRoot || dirty) return
    const timer = window.setInterval(() => {
      invoke<{ content?: string }>('workspace.read_file', { ...payloadBase, path: relativeWorkspacePath(projectPath, selectedFilePath) })
        .then((result) => {
          const next = typeof result?.content === 'string' ? result.content : null
          if (next === null || next === lastDiskContentRef.current) return
          lastDiskContentRef.current = next; syncingDiskRef.current = true
          if (editorViewRef.current) editorViewRef.current.dispatch({ changes: { from: 0, to: editorViewRef.current.state.doc.length, insert: next } })
          else setFileContent(next)
        }).catch(() => undefined)
    }, 3000)
    return () => window.clearInterval(timer)
  }, [dirty, fileRoot, payloadBase, projectPath, selectedFilePath])

  useEffect(() => {
    if (!selectedFilePath || !fileRoot || !projectPath) { setDiagnostics([]); return }
    const timer = window.setTimeout(() => {
      invoke<{ diagnostics?: Diagnostic[] }>('workspace.diagnostics', { ...payloadBase, path: '.', file: relativeWorkspacePath(projectPath, selectedFilePath) })
        .then((result) => setDiagnostics(Array.isArray(result?.diagnostics) ? result.diagnostics : []))
        .catch(() => setDiagnostics([]))
    }, 450)
    return () => window.clearTimeout(timer)
  }, [fileRoot, payloadBase, projectPath, selectedFilePath])

  useEffect(() => {
    if (viewMode !== 'diff' || !selectedGitPath || !fileRoot || !projectPath) return
    let active = true
    setDiffText({ working: '', staged: '' })
    Promise.allSettled([
      invoke<{ diff?: string }>('git.diff', { ...payloadBase, path: '.', file: selectedGitPath }),
      invoke<{ diff?: string }>('git.diff.staged', { ...payloadBase, path: '.', file: selectedGitPath }),
    ]).then(([working, staged]) => {
      if (!active) return
      setDiffText({
        working: working.status === 'fulfilled' && typeof working.value?.diff === 'string' ? working.value.diff : '',
        staged: staged.status === 'fulfilled' && typeof staged.value?.diff === 'string' ? staged.value.diff : '',
      })
    })
    return () => { active = false }
  }, [fileRoot, payloadBase, projectPath, selectedGitPath, viewMode])

  useEffect(() => {
    const query = searchQuery.trim()
    if (!query || !fileRoot || !projectPath) { setContentResults([]); return }
    const timer = window.setTimeout(() => {
      invoke<{ results?: ContentResult[] }>('workspace.search', { ...payloadBase, path: '.', query, content: true })
        .then((result) => setContentResults(Array.isArray(result?.results) ? result.results : []))
        .catch(() => setContentResults([]))
    }, 220)
    return () => window.clearTimeout(timer)
  }, [fileRoot, payloadBase, projectPath, searchQuery])

  const runGitAction = useCallback(async (label: string, type: string, payload: Record<string, unknown> = {}, refresh = true) => {
    if (!fileRoot || gitBusy) return
    setGitBusy(type); setError(null)
    try {
      await invoke(type, { ...payloadBase, path: '.', ...payload })
      setFeedback({ kind: 'success', message: `${label} concluído.` })
      if (refresh) await loadData()
    } catch (reason) {
      const message = errorMessage(reason, `${label} falhou.`)
      setError(message); setFeedback({ kind: 'error', message })
    } finally { setGitBusy(null) }
  }, [fileRoot, gitBusy, loadData, payloadBase, setFeedback])

  const requestConfirmation = useCallback((title: string, message: string, action: () => Promise<void>) => setConfirmState({ title, message, action }), [])

  const stageFile = useCallback(async (file: GitFile, staged: boolean) => {
    await runGitAction(staged ? 'Unstage' : 'Stage', staged ? 'git.unstage' : 'git.stage', { file: file.path })
  }, [runGitAction])

  const stageAll = useCallback(async () => {
    const pending = changedFiles.filter((file) => gitStatusFlags(file.status).unstaged)
    if (!pending.length) { setFeedback({ kind: 'info', message: 'Não há alterações unstaged.' }); return }
    if (!fileRoot || gitBusy) return
    setGitBusy('git.stage-all')
    try {
      for (const file of pending) await invoke('git.stage', { ...payloadBase, path: '.', file: file.path })
      setFeedback({ kind: 'success', message: `${pending.length} ficheiro(s) staged.` }); await loadData()
    } catch (reason) { const message = errorMessage(reason, 'Não foi possível stagear tudo.'); setError(message); setFeedback({ kind: 'error', message }) }
    finally { setGitBusy(null) }
  }, [changedFiles, fileRoot, gitBusy, loadData, payloadBase, setFeedback])

  const unstageAll = useCallback(async () => {
    const staged = changedFiles.filter((file) => gitStatusFlags(file.status).staged)
    if (!staged.length) { setFeedback({ kind: 'info', message: 'Não há ficheiros staged.' }); return }
    if (!fileRoot || gitBusy) return
    setGitBusy('git.unstage-all')
    try {
      for (const file of staged) await invoke('git.unstage', { ...payloadBase, path: '.', file: file.path })
      setFeedback({ kind: 'success', message: `${staged.length} ficheiro(s) unstaged.` }); await loadData()
    } catch (reason) { const message = errorMessage(reason, 'Não foi possível remover o stage.'); setError(message); setFeedback({ kind: 'error', message }) }
    finally { setGitBusy(null) }
  }, [changedFiles, fileRoot, gitBusy, loadData, payloadBase, setFeedback])

  const commitStaged = useCallback(async (stageFirst = false) => {
    if (!commitMessage.trim() || !fileRoot || gitBusy) return
    if (stageFirst) await stageAll()
    if (!stageFirst && !changedFiles.some((file) => gitStatusFlags(file.status).staged)) {
      setFeedback({ kind: 'info', message: 'Stage pelo menos um ficheiro antes de fazer commit.' }); return
    }
    await runGitAction('Commit', 'git.commit', { message: commitMessage.trim() })
    setCommitMessage('')
  }, [changedFiles, commitMessage, fileRoot, gitBusy, runGitAction, setFeedback, stageAll])

  const createEntry = useCallback(async (directory: boolean) => {
    const name = newEntryName.trim()
    if (!name || !fileRoot) return
    if (name === '.' || name === '..' || /[\\/]/.test(name)) { setFeedback({ kind: 'error', message: 'Usa apenas um nome de ficheiro ou pasta.' }); return }
    const parent = selectedFolderPath || (selectedFilePath ? selectedFilePath.slice(0, selectedFilePath.lastIndexOf('/')) || projectPath : projectPath)
    const path = relativeWorkspacePath(projectPath, `${parent.replace(/\/$/, '')}/${name}`)
    try {
      await invoke(directory ? 'workspace.create_directory' : 'workspace.create_file', { ...payloadBase, path })
      setNewEntryName(''); setExpandedPaths((current) => new Set(current).add(parent)); setFeedback({ kind: 'success', message: `${name} criado.` }); await loadData()
    } catch (reason) { const message = errorMessage(reason, 'Não foi possível criar a entrada.'); setError(message); setFeedback({ kind: 'error', message }) }
  }, [fileRoot, loadData, newEntryName, payloadBase, projectPath, selectedFilePath, selectedFolderPath, setFeedback])

  const removeSelected = useCallback(() => {
    const target = selectedFilePath || selectedFolderPath
    if (!target || target === projectPath || !fileRoot) return
    requestConfirmation('Eliminar entrada', `Eliminar permanentemente “${fileName(target)}”? Esta ação não pode ser desfeita.`, async () => {
      try {
        await invoke('workspace.delete', { ...payloadBase, path: relativeWorkspacePath(projectPath, target) })
        setSelectedFile(''); setSelectedFilePath(''); setSelectedFolderPath(''); setTreeFocusPath(''); setFileContent(''); setFeedback({ kind: 'success', message: `${fileName(target)} eliminado.` }); await loadData()
      } catch (reason) { const message = errorMessage(reason, 'Não foi possível eliminar a entrada.'); setError(message); setFeedback({ kind: 'error', message }) }
    })
  }, [fileRoot, loadData, payloadBase, projectPath, requestConfirmation, selectedFilePath, selectedFolderPath, setFeedback])

  const renameSelected = useCallback(async () => {
    const nextName = newEntryName.trim()
    const target = selectedFilePath || selectedFolderPath
    if (!nextName || !target || target === projectPath || !fileRoot) return
    if (nextName === '.' || nextName === '..' || /[\\/]/.test(nextName)) { setFeedback({ kind: 'error', message: 'Usa apenas um nome de entrada.' }); return }
    const separator = target.lastIndexOf('/')
    const nextPath = `${separator > 0 ? target.slice(0, separator) : projectPath}/${nextName}`
    try {
      await invoke('workspace.rename', { ...payloadBase, path: relativeWorkspacePath(projectPath, target), targetPath: relativeWorkspacePath(projectPath, nextPath) })
      setNewEntryName(''); setSelectedFile(''); setSelectedFilePath(''); setSelectedFolderPath(''); setFeedback({ kind: 'success', message: `${fileName(target)} renomeado.` }); await loadData()
    } catch (reason) { const message = errorMessage(reason, 'Não foi possível renomear a entrada.'); setError(message); setFeedback({ kind: 'error', message }) }
  }, [fileRoot, loadData, newEntryName, payloadBase, projectPath, selectedFilePath, selectedFolderPath, setFeedback])

  const selectGitFile = useCallback((file: GitFile) => {
    setSelectedGitPath(file.path)
    setViewMode('diff')
  }, [])

  const runBlame = useCallback(async () => {
    const target = selectedFilePath ? relativeWorkspacePath(projectPath, selectedFilePath) : selectedGitPath
    if (!target || !fileRoot) return
    try {
      const result = await invoke<{ lines?: BlameLine[] }>('git.blame', { ...payloadBase, path: '.', file: target })
      setBlameLines(Array.isArray(result?.lines) ? result.lines : [])
      setFeedback({ kind: 'info', message: `Blame carregado para ${fileName(target)}.` })
    } catch (reason) { setFeedback({ kind: 'error', message: errorMessage(reason, 'Blame não disponível para este ficheiro.') }) }
  }, [fileRoot, payloadBase, projectPath, selectedFilePath, selectedGitPath, setFeedback])

  const deleteBranch = useCallback((branch: Branch) => requestConfirmation('Eliminar branch', `Eliminar a branch “${branch.name}”?`, () => runGitAction('Branch eliminada', 'git.branch.delete', { name: branch.name, force: false, confirm: true })), [requestConfirmation, runGitAction])
  const deleteTag = useCallback((ref: GitRef) => requestConfirmation('Eliminar tag', `Eliminar a tag “${ref.name}”?`, () => runGitAction('Tag eliminada', 'git.tag.delete', { name: ref.name, confirm: true })), [requestConfirmation, runGitAction])
  const runHistoryOperation = useCallback((operation: string) => {
    const target = historyTarget || selectedCommitHash
    if (!target) { setFeedback({ kind: 'info', message: 'Seleciona um commit primeiro.' }); return }
    requestConfirmation(`${operation} ${target.slice(0, 8)}`, `Executar ${operation} sobre este commit? O estado Git pode mudar.`, () => runGitAction(operation, `git.${operation}`, { target, confirm: true }))
  }, [historyTarget, requestConfirmation, runGitAction, selectedCommitHash, setFeedback])

  const handleContextMenu = useCallback((event: React.MouseEvent, row: TreeRow) => {
    event.preventDefault(); event.stopPropagation()
    const host = treeListRef.current?.getBoundingClientRect()
    if (!host) return
    setTreeFocusPath(row.item.path)
    if (row.item.is_dir) { setSelectedFolderPath(row.item.path); setSelectedFilePath('') }
    else { setSelectedFilePath(joinWorkspacePath(projectPath, row.item.path)); setSelectedFolderPath('') }
    // Keep the menu inside the node even when a row is right at the lower or
    // trailing edge. Native/context overlays must not render outside a scaled
    // canvas node where they can be clipped or appear detached from the tree.
    const layout = {
      width: treeListRef.current?.offsetWidth || host.width,
      height: treeListRef.current?.offsetHeight || host.height
    }
    const point = mapVisualPointToLayout(
      { x: event.clientX, y: event.clientY },
      { left: host.left, top: host.top, width: host.width, height: host.height },
      layout
    )
    const position = clampContextMenuPosition(point, layout, 190, 176)
    setContextMenu({ x: position.x, y: position.y, row })
  }, [projectPath])

  const handleContextMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      setContextMenu(null)
      return
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
    if (!items.length) return
    event.preventDefault()
    const current = items.indexOf(document.activeElement as HTMLButtonElement)
    const delta = event.key === 'ArrowDown' ? 1 : -1
    items[(current + delta + items.length) % items.length]?.focus()
  }

  const renderFileIcon = (row: TreeRow) => {
    if (row.item.is_dir) return row.open ? <FolderOpen className="file-icon folder" /> : <Folder className="file-icon folder" />
    return /\.(md|markdown|txt|rst)$/i.test(row.item.name) ? <FileText className="file-icon" /> : <FileCode2 className="file-icon" />
  }

  return (
    <div className="node files-node" data-kind="files" style={{ width: '100%', height: '100%', minWidth: 330, minHeight: 220 }} onClick={() => setSelectedNodeId(id)}>
      <NodeResizer isVisible={data.selected} minWidth={330} minHeight={220} handleClassName="nodrag nopan canvas-resize-handle" lineClassName="nodrag nopan canvas-resize-line" onResizeStart={commitHistory} onResize={(_, params) => updateNode(id, { width: params.width, height: params.height })} />
      <Handle type="target" position={Position.Left} className="port left" />
      <Handle type="source" position={Position.Right} className="port right" />
      <header className="files-head">
        <div className="files-brand"><span className="files-brand-icon"><GitFork className="icon" /></span><strong>{props.title || fileName(projectPath) || 'Ficheiros'}</strong></div>
        <div className="files-head-spacer" />
        <div className="files-view-switcher" aria-label="Vista do ficheiro" role="tablist">
          <button type="button" role="tab" aria-selected={viewMode === 'list'} className={viewMode === 'list' ? 'active' : ''} onClick={() => setViewMode('list')}>Tree</button>
          <button type="button" role="tab" aria-selected={viewMode === 'diff'} className={viewMode === 'diff' ? 'active' : ''} onClick={() => setViewMode('diff')}>Changes{changedFiles.length ? ` ${changedFiles.length}` : ''}</button>
          <button type="button" role="tab" aria-selected={viewMode === 'graph'} className={viewMode === 'graph' ? 'active' : ''} onClick={() => setViewMode('graph')}>Graph</button>
        </div>
        <label className="branch-pill" title="Branch Git"><GitBranch className="icon" /><select value={currentBranch} aria-label="Branch Git" onChange={(event) => void runGitAction('Checkout', 'git.branch.checkout', { name: event.target.value })}>
          {branches.length === 0 && <option value={currentBranch}>{currentBranch || '—'}</option>}
          {branches.map((branch) => <option value={branch.name} key={branch.name}>{branch.name}</option>)}
        </select></label>
        <button type="button" className="icon-btn" onClick={(event) => { event.stopPropagation(); void loadData() }} title="Atualizar workspace"><RefreshCw className={`icon ${loading ? 'spin' : ''}`} /></button>
        <button type="button" className="icon-btn" onClick={(event) => { event.stopPropagation(); deleteNode(id) }} title="Fechar ficheiros"><X className="icon" /></button>
      </header>
      {notice && <div className={`files-notice ${notice.kind}`} role={notice.kind === 'error' ? 'alert' : 'status'}><span>{notice.message}</span><button type="button" className="icon-btn" onClick={() => setNotice(null)} aria-label="Fechar mensagem"><X className="icon" /></button></div>}
      {error && <div className="files-error" role="alert"><CircleAlert className="icon" /><span>{error}</span><button type="button" className="icon-btn" onClick={() => setError(null)} aria-label="Fechar erro"><X className="icon" /></button></div>}
      <div className={`files-body ${isWide ? 'wide' : ''}`}>
        <section className="files-tree-pane">
          <div className="files-pane-toolbar">
            {viewMode === 'list' && <>
              <button type="button" className="compact-action" onClick={() => { setSelectedFolderPath(selectedFolderPath || projectPath); setNewEntryMode('file'); setNewEntryName(''); newEntryRef.current?.focus() }}><Plus className="icon" />Novo</button>
              <button type="button" className="compact-action" onClick={() => { setExpandedPaths(new Set()); if (tree) setExpandedPaths(new Set([tree.path])) }} title="Recolher todas as pastas"><ChevronRight className="icon" />Recolher</button>
              <div className="files-head-spacer" />
              <span className="files-count">{visibleEntries.length} entradas</span>
            </>}
            {viewMode === 'diff' && <>
              <b className="pane-title">Source control</b><span className="files-count">{changedFiles.length} alterações</span><div className="files-head-spacer" />
              <button type="button" className="compact-action" disabled={Boolean(gitBusy)} onClick={() => void stageAll()}>Stage all</button>
              <button type="button" className="compact-action" disabled={Boolean(gitBusy)} onClick={() => void unstageAll()}>Unstage all</button>
            </>}
            {viewMode === 'graph' && <><b className="pane-title"><History className="icon" />History</b><span className="files-count">{commits.length} commits</span><div className="files-head-spacer" /><button type="button" className="compact-action" disabled={Boolean(gitBusy)} onClick={() => void runGitAction('Fetch', 'git.remote.fetch', { remote: 'origin' })}><CloudDownload className="icon" />Fetch</button></>}
          </div>
          {viewMode === 'list' && <>
            <div className="files-breadcrumbs" aria-label="Caminho atual">
              {breadcrumbs.map((crumb, index) => <React.Fragment key={crumb.path}><button type="button" className={index === breadcrumbs.length - 1 ? 'current' : ''} onClick={() => { setSelectedFolderPath(crumb.path); setSelectedFilePath(''); setTreeFocusPath(crumb.path); setExpandedPaths((current) => new Set(current).add(crumb.path)) }}>{crumb.label}</button>{index < breadcrumbs.length - 1 && <span>/</span>}</React.Fragment>)}
            </div>
            <label className="files-search"><Search className="icon" /><input ref={searchRef} value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder="Pesquisar ficheiros e conteúdo" aria-label="Pesquisar ficheiros e conteúdo" /><kbd>⌘P</kbd></label>
            <div ref={treeListRef} className="file-tree-list nodrag nowheel" role="tree" aria-label="Árvore de ficheiros" onKeyDown={(event) => { if (event.key === '/' && event.target === treeListRef.current) { event.preventDefault(); searchRef.current?.focus() } }}>
              {loading && <div className="empty-state"><LoaderCircle className="icon spin" />A carregar…</div>}
              {!loading && error && <div className="empty-state error">Não foi possível abrir a árvore.</div>}
              {!loading && !error && visibleEntries.length === 0 && <div className="empty-state"><FolderOpen className="icon" />{searchQuery ? 'Sem correspondências.' : 'Este workspace não contém entradas visíveis.'}</div>}
              {visibleEntries.map((row, index) => {
                const status = statuses.get(joinWorkspacePath(projectPath, row.item.path))
                const flags = gitStatusFlags(status?.status)
                const selected = treeFocusPath === row.item.path || selectedFilePath === joinWorkspacePath(projectPath, row.item.path) || selectedFolderPath === row.item.path
                return <button type="button" key={row.item.path} data-file-tree-path={row.item.path} className={`file-row ${selected ? 'selected' : ''} ${flags.conflict ? 'conflict' : ''}`} style={{ paddingLeft: 9 + row.depth * 15 }} role="treeitem" aria-level={row.depth + 1} aria-expanded={row.item.is_dir ? row.open : undefined} aria-selected={selected} tabIndex={treeFocusPath === row.item.path || (!treeFocusPath && index === 0) ? 0 : -1} onClick={() => void toggleFolder(row)} onContextMenu={(event) => handleContextMenu(event, row)} onKeyDown={(event) => handleTreeKeyDown(event, index, row)}>
                  {row.item.is_dir ? (loadingPaths.has(row.item.path) ? <LoaderCircle className="disclosure spin" /> : row.open ? <ChevronDown className="disclosure" /> : <ChevronRight className="disclosure" />) : <span className="disclosure" />}
                  {renderFileIcon(row)}<span className="file-row-name">{row.item.name}</span>{status && <i className={`git-mark ${flags.staged ? 'staged' : ''} ${flags.untracked ? 'untracked' : ''}`} title={status.status}>{displayStatus(status.status)}</i>}
                </button>
              })}
              {contextMenu && <div ref={contextMenuRef} className="files-context-menu" style={{ left: contextMenu.x, top: contextMenu.y }} role="menu" tabIndex={-1} aria-label="Ações do ficheiro" onKeyDown={handleContextMenuKeyDown} onPointerDown={(event) => event.stopPropagation()}>
                <button type="button" role="menuitem" onClick={() => { setSelectedFolderPath(contextMenu.row.item.is_dir ? contextMenu.row.item.path : contextMenu.row.parentPath || projectPath); setSelectedFilePath(''); setNewEntryMode('file'); setNewEntryName(''); newEntryRef.current?.focus(); setContextMenu(null) }}><FilePlus className="icon" />Novo ficheiro</button>
                <button type="button" role="menuitem" onClick={() => { setSelectedFolderPath(contextMenu.row.item.is_dir ? contextMenu.row.item.path : contextMenu.row.parentPath || projectPath); setSelectedFilePath(''); setNewEntryMode('folder'); setNewEntryName(''); newEntryRef.current?.focus(); setContextMenu(null) }}><FolderPlus className="icon" />Nova pasta</button>
                <button type="button" role="menuitem" onClick={() => { setNewEntryMode('rename'); setNewEntryName(contextMenu.row.item.name); newEntryRef.current?.focus(); setContextMenu(null) }}><Pencil className="icon" />Renomear</button>
                {!contextMenu.row.item.is_dir && (() => { const itemStatus = statuses.get(joinWorkspacePath(projectPath, contextMenu.row.item.path)); const itemFlags = gitStatusFlags(itemStatus?.status); return itemStatus ? <button type="button" role="menuitem" onClick={() => { setContextMenu(null); void stageFile(itemStatus, itemFlags.staged && !itemFlags.unstaged) }}>{itemFlags.staged && !itemFlags.unstaged ? <Undo2 className="icon" /> : <Check className="icon" />}{itemFlags.staged && !itemFlags.unstaged ? 'Unstage' : 'Stage'}</button> : null })()}
                <button type="button" role="menuitem" className="danger" onClick={() => { setContextMenu(null); removeSelected() }}><Trash2 className="icon" />Eliminar</button>
              </div>}
            </div>
            {searchQuery.trim() && <div className="content-search-results" aria-label="Resultados de pesquisa no conteúdo">
              {contentResults.map((result) => <button type="button" key={`${result.path}:${result.line}`} onClick={() => void selectFile({ path: relativeWorkspacePath(projectPath, result.path), name: result.name, is_dir: false })}><b>{result.name}:{result.line || 1}</b><span>{result.snippet || ''}</span></button>)}
              {!contentResults.length && <small>Sem correspondências no conteúdo.</small>}
            </div>}
            <div className="files-tree-actions">
              <input ref={newEntryRef} className="files-entry-name" value={newEntryName} onChange={(event) => setNewEntryName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { if (newEntryMode === 'rename') void renameSelected(); else void createEntry(newEntryMode === 'folder') }; if (event.key === 'Escape') setNewEntryName('') }} placeholder="nome…" aria-label="Nome da entrada" />
              <button type="button" className="icon-btn" disabled={!newEntryName.trim()} onClick={() => { setNewEntryMode('file'); void createEntry(false) }} title="Criar ficheiro"><FilePlus className="icon" /></button>
              <button type="button" className="icon-btn" disabled={!newEntryName.trim()} onClick={() => { setNewEntryMode('folder'); void createEntry(true) }} title="Criar pasta"><FolderPlus className="icon" /></button>
              <button type="button" className="icon-btn" disabled={!newEntryName.trim() || !(selectedFilePath || selectedFolderPath)} onClick={() => { setNewEntryMode('rename'); void renameSelected() }} title="Renomear selecionado"><Pencil className="icon" /></button>
              <button type="button" className="icon-btn danger" disabled={!(selectedFilePath || selectedFolderPath)} onClick={removeSelected} title="Eliminar selecionado"><Trash2 className="icon" /></button>
            </div>
          </>}
          {viewMode === 'diff' && <div className="git-diff-view nodrag nowheel">
            <div className="git-section-title"><span><SquareStack className="icon" />Changes</span><small>{gitStatus?.clean ? 'Working tree clean' : `${gitStatus?.ahead || 0} ahead · ${gitStatus?.behind || 0} behind`}</small></div>
            <div className="git-file-list">
              {changedFiles.map((file) => { const flags = gitStatusFlags(file.status); return <div className={`git-file-row ${selectedGitFile?.path === file.path ? 'selected' : ''}`} key={file.path}><button type="button" onClick={() => selectGitFile(file)}><i className={`${flags.conflict ? 'conflict' : flags.staged ? 'staged' : flags.untracked ? 'untracked' : ''}`}>{displayStatus(file.status)}</i><span>{file.path}</span></button><button type="button" className="git-file-action" onClick={() => void stageFile(file, flags.staged && !flags.unstaged)} title={flags.staged && !flags.unstaged ? 'Unstage' : 'Stage'}>{flags.staged && !flags.unstaged ? <Undo2 className="icon" /> : <Check className="icon" />}</button></div> })}
              {!changedFiles.length && <div className="empty-state"><Check className="icon" />Working tree clean.</div>}
            </div>
            <div className="git-commit-box"><textarea value={commitMessage} onChange={(event) => setCommitMessage(event.target.value)} placeholder="Mensagem do commit…" aria-label="Mensagem do commit" rows={2} /><div><button type="button" className="compact-action" disabled={!commitMessage.trim() || Boolean(gitBusy)} onClick={() => void commitStaged(false)}><GitCommitHorizontal className="icon" />Commit staged</button><button type="button" className="compact-action primary" disabled={!commitMessage.trim() || Boolean(gitBusy)} onClick={() => void commitStaged(true)}>Stage all & commit</button></div></div>
            {diffText.working && <pre className="git-diff-preview"><code>{diffText.working}</code></pre>}
            {diffText.staged && <pre className="git-diff-preview staged"><code>{diffText.staged}</code></pre>}
          </div>}
          {viewMode === 'graph' && <div className="git-graph-view nodrag nowheel">
            <div className="git-ref-strip"><span className="git-ref-head"><GitBranch className="icon" />{currentBranch || 'detached HEAD'}</span>{refs.filter((ref) => ref.kind !== 'tag').slice(0, 10).map((ref) => <span className={`git-ref-chip ${ref.kind}`} key={`${ref.kind}:${ref.fullName || ref.name}`}><Tag className="icon" />{ref.name}</span>)}{tagRefs.length > 0 && <span className="git-ref-chip tag">+{tagRefs.length} tags</span>}</div>
              <div ref={graphRef} className="fork-graph graph-scroll" onScroll={(event) => setGraphScrollTop(event.currentTarget.scrollTop)} role="listbox" aria-label="Histórico Git">
              <div className="graph-spacer" style={{ height: graphRows.length * graphWindow.rowHeight }} />
              <div className="graph-window" style={{ transform: `translateY(${graphWindow.start * graphWindow.rowHeight}px)` }}>{graphWindow.rows.map(({ commit, lane, laneCount, color }) => <button type="button" className={`graph-commit ${selectedCommitHash === commit.hash ? 'selected' : ''}`} style={{ '--lane': lane, '--lane-count': laneCount } as React.CSSProperties} key={commit.hash} role="option" aria-selected={selectedCommitHash === commit.hash} onClick={() => { setSelectedCommitHash(commit.hash); setHistoryTarget(commit.hash) }}><span className="graph-line" style={{ '--graph-color': color } as React.CSSProperties} /><span className="graph-commit-copy"><b>{commit.message}</b><small>{commit.hash.slice(0, 8)} · {commit.author || 'unknown'} · {commit.time || ''}</small></span>{commit.refs?.length ? <em>{commit.refs.join(' · ')}</em> : null}</button>)}</div>
              {commits.length === 0 && <div className="empty-state"><History className="icon" />Ainda não existem commits.</div>}
            </div>
            {selectedCommit && <div className="commit-details"><div className="git-section-title"><span><GitCommitHorizontal className="icon" />Commit {selectedCommit.hash.slice(0, 8)}</span><small>{selectedCommit.parents?.length || 0} parent(s)</small></div><b>{selectedCommit.message}</b><p>{selectedCommit.author || 'Autor desconhecido'} · {selectedCommit.time || 'sem data'}</p>{selectedCommit.refs?.length ? <div className="commit-refs">{selectedCommit.refs.map((ref) => <span key={ref}>{ref}</span>)}</div> : null}<label>Target<input value={historyTarget} onChange={(event) => setHistoryTarget(event.target.value)} /></label></div>}
            <div className="git-graph-actions">
              <div className="git-action-row"><input value={branchDraft} onChange={(event) => setBranchDraft(event.target.value)} placeholder="nova branch" aria-label="Nome da nova branch" /><button type="button" className="compact-action" disabled={!branchDraft.trim() || Boolean(gitBusy)} onClick={() => { void runGitAction('Branch criada', 'git.branch.create', { name: branchDraft.trim(), startPoint: selectedCommitHash || undefined, checkout: false }); setBranchDraft('') }}><GitBranch className="icon" />Criar</button><select value={branchToDelete} onChange={(event) => setBranchToDelete(event.target.value)} aria-label="Branch para eliminar"><option value="">Eliminar branch…</option>{deletableBranches.map((branch) => <option value={branch.name} key={branch.name}>{branch.name}</option>)}</select><button type="button" className="compact-action danger" disabled={!branchToDelete || Boolean(gitBusy)} onClick={() => { const branch = deletableBranches.find((item) => item.name === branchToDelete); if (branch) deleteBranch(branch) }}><Trash2 className="icon" />Apagar</button></div>
              <div className="git-action-row"><input value={tagDraft} onChange={(event) => setTagDraft(event.target.value)} placeholder="nova tag" aria-label="Nome da nova tag" /><button type="button" className="compact-action" disabled={!tagDraft.trim() || Boolean(gitBusy)} onClick={() => { void runGitAction('Tag criada', 'git.tag.create', { name: tagDraft.trim(), target: selectedCommitHash || undefined }); setTagDraft('') }}><Tag className="icon" />Tag</button><select value={tagToDelete} onChange={(event) => setTagToDelete(event.target.value)} aria-label="Tag para eliminar"><option value="">Eliminar tag…</option>{tagRefs.map((ref) => <option value={ref.name} key={ref.name}>{ref.name}</option>)}</select><button type="button" className="compact-action danger" disabled={!tagToDelete || Boolean(gitBusy)} onClick={() => { const ref = tagRefs.find((item) => item.name === tagToDelete); if (ref) deleteTag(ref) }}><Trash2 className="icon" />Apagar tag</button></div>
              <div className="git-action-row"><button type="button" className="compact-action" disabled={Boolean(gitBusy)} onClick={() => void runGitAction('Pull', 'git.remote.pull', { remote: 'origin' })}><CloudDownload className="icon" />Pull</button><button type="button" className="compact-action" disabled={Boolean(gitBusy)} onClick={() => void runGitAction('Push', 'git.remote.push', { remote: 'origin', branch: currentBranch || undefined })}><CloudUpload className="icon" />Push</button><button type="button" className="compact-action" disabled={Boolean(gitBusy)} onClick={() => void runGitAction('Stash', 'git.stash.push', { includeUntracked: true })}><Archive className="icon" />Stash</button><select value={stashTarget} onChange={(event) => setStashTarget(event.target.value)} aria-label="Stash selecionado"><option value="">Selecionar stash…</option>{stashes.map((stash) => <option value={stash.name} key={stash.name}>{stash.name} · {stash.message}</option>)}</select><button type="button" className="compact-action" disabled={!stashTarget || Boolean(gitBusy)} onClick={() => void runGitAction('Stash pop', 'git.stash.pop', { name: stashTarget })}>Pop</button><button type="button" className="compact-action" disabled={!stashTarget || Boolean(gitBusy)} onClick={() => void runGitAction('Stash apply', 'git.stash.apply', { name: stashTarget })}>Apply</button><button type="button" className="compact-action danger" disabled={!stashTarget || Boolean(gitBusy)} onClick={() => requestConfirmation('Eliminar stash', 'Eliminar ' + stashTarget + '?', () => runGitAction('Stash eliminado', 'git.stash.drop', { name: stashTarget }))}>Drop</button></div>
              <div className="git-action-row"><input value={worktreeDraft} onChange={(event) => setWorktreeDraft(event.target.value)} placeholder="novo worktree" aria-label="Nome do novo worktree" /><input value={worktreeBranchDraft} onChange={(event) => setWorktreeBranchDraft(event.target.value)} placeholder="branch do worktree" aria-label="Branch do novo worktree" /><button type="button" className="compact-action" disabled={!worktreeDraft.trim() || !worktreeBranchDraft.trim() || Boolean(gitBusy)} onClick={() => { void runGitAction('Worktree criado', 'git.create_floor', { name: worktreeDraft.trim(), branch: worktreeBranchDraft.trim() }); setWorktreeDraft(''); setWorktreeBranchDraft('') }}><SquareStack className="icon" />Criar worktree</button></div>
              <div className="git-action-row"><select value={operationKind} onChange={(event) => setOperationKind(event.target.value)} aria-label="Tipo de operação Git"><option value="merge">merge</option><option value="rebase">rebase</option><option value="cherry-pick">cherry-pick</option><option value="revert">revert</option></select><button type="button" className="compact-action" disabled={Boolean(gitBusy)} onClick={() => runHistoryOperation(operationKind)}><GitMerge className="icon" />Executar</button><button type="button" className="compact-action" disabled={Boolean(gitBusy)} onClick={() => void runGitAction('Continue', 'git.operation.continue', { kind: operationKind })}>Continue</button><button type="button" className="compact-action danger" disabled={Boolean(gitBusy)} onClick={() => requestConfirmation('Abortar operação', 'Abortar ' + operationKind + '?', () => runGitAction('Abort', 'git.operation.abort', { kind: operationKind }))}>Abort</button><select value={resetMode} onChange={(event) => setResetMode(event.target.value as 'soft' | 'mixed' | 'hard')} aria-label="Modo de reset"><option value="soft">reset soft</option><option value="mixed">reset mixed</option><option value="hard">reset hard</option></select><button type="button" className="compact-action danger" disabled={Boolean(gitBusy)} onClick={() => requestConfirmation('Reset Git', 'Executar reset ' + resetMode + ' para ' + (historyTarget || 'HEAD') + '?', () => runGitAction('Reset', 'git.reset', { target: historyTarget || 'HEAD', mode: resetMode, confirm: true }))}><RotateCcw className="icon" />Reset</button></div>
            </div>
            <div className="git-worktrees"><b>Worktrees · leitura e criação</b>{worktrees.length === 0 && <span>Nenhum worktree adicional.</span>}{worktrees.map((worktree) => <span key={worktree.path}><SquareStack className="icon" />{worktree.branch || '(detached)'} · {worktree.path}</span>)}</div>
          </div>}
        </section>
        {isWide && <section className="files-editor-pane">
          <div className="editor-tab"><FileCode2 className="icon" /><span>{selectedFile || 'Nenhum ficheiro selecionado'}</span>{dirty && <span aria-label="Alterações não guardadas">●</span>}<button type="button" className="compact-action" disabled={!selectedFilePath || Boolean(gitBusy)} onClick={() => void runBlame()} title="Ver autoria de cada linha"><History className="icon" />Blame</button></div>
          {loadingFile && <div className="editor-loading"><LoaderCircle className="icon spin" />A abrir ficheiro…</div>}
          {fileError && <div className="editor-error" role="alert">{fileError}</div>}
          <div ref={editorHostRef} className="editor-source nodrag nowheel" aria-label={selectedFile ? `Editar ${selectedFile}` : 'Nenhum ficheiro selecionado'} />
          {blameLines.length > 0 && <div className="blame-panel"><div className="git-section-title"><span>Blame</span><button type="button" className="icon-btn" onClick={() => setBlameLines([])} aria-label="Fechar blame"><X className="icon" /></button></div>{blameLines.slice(0, 80).map((line) => <div key={line.line} className="blame-row"><small>{line.commit?.slice(0, 8) || '—'}</small><span>{line.author || '—'}</span><code>{line.content || ''}</code></div>)}</div>}
          {diagnostics.length > 0 && <div className="editor-diagnostics" role="status">{diagnostics.map((diagnostic, index) => <div key={`${diagnostic.file}:${diagnostic.line}:${index}`} className={diagnostic.severity === 'warning' ? 'warning' : 'error'}><b>{diagnostic.severity}</b><span>{diagnostic.message}</span><small>{diagnostic.line || 1}:{diagnostic.column || 1}</small></div>)}</div>}
          <footer>{saveState === 'saving' ? 'A guardar…' : saveState === 'error' ? 'Erro ao guardar' : dirty ? 'Alterações não guardadas' : 'Guardado'}<span>{selectedFile ? selectedFile.split('.').pop() : '—'}</span></footer>
        </section>}
      </div>
      {newEntryName && <div className="files-inline-tools"><span>{newEntryMode === 'rename' ? `Renomear ${fileName(selectedFilePath || selectedFolderPath)}` : `${newEntryMode === 'folder' ? 'Nova pasta' : 'Novo ficheiro'} em ${fileName(selectedFolderPath || projectPath)}`}</span></div>}
      {confirmState && <div className="files-confirm-layer" role="presentation"><div ref={confirmRef} className="files-confirm" role="dialog" aria-modal="true" aria-labelledby="files-confirm-title" tabIndex={-1}><div className="git-section-title"><span id="files-confirm-title"><CircleAlert className="icon" />{confirmState.title}</span><button type="button" className="icon-btn" onClick={() => setConfirmState(null)} aria-label="Cancelar"><X className="icon" /></button></div><p>{confirmState.message}</p><div className="files-confirm-actions"><button type="button" className="compact-action" onClick={() => setConfirmState(null)}>Cancelar</button><button type="button" className="compact-action danger primary" onClick={async () => { const action = confirmState.action; setConfirmState(null); await action() }}>Confirmar</button></div></div></div>}
    </div>
  )
}
