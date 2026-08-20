export type FileTreeItem = {
  name: string
  path: string
  is_dir: boolean
  children?: FileTreeItem[]
  extension?: string
}

export type FlatFileTreeItem = {
  item: FileTreeItem
  depth: number
  open: boolean
  parentPath?: string
}

export type GraphCommit = {
  hash: string
  parents?: string[]
  author?: string
  message: string
  time?: string
  refs?: string[]
}

export type GraphRow = {
  commit: GraphCommit
  lane: number
  laneCount: number
  laneColors: string[]
  color: string
  hasIncoming: boolean
  throughEdges: GraphEdge[]
  parentEdges: GraphEdge[]
}

export type GraphEdge = {
  fromLane: number
  toLane: number
  color: string
}

export const GRAPH_COLORS = ['#c8f169', '#74a7f5', '#a989f5', '#f2c46d', '#63d694', '#ff8c96']

/** Colors belong to graph lanes, so virtualized rows keep the same branch
 * color when they are mounted in a different window. */
export function graphColorForLane(lane: number): string {
  const index = Number.isFinite(lane) && lane >= 0 ? Math.floor(lane) : 0
  return GRAPH_COLORS[index % GRAPH_COLORS.length]
}

export type VisualPoint = { x: number; y: number }
export type VisualRect = { left: number; top: number; width: number; height: number }
export type LayoutSize = { width: number; height: number }

/** Convert a painted ReactFlow point to the node's unscaled CSS coordinates. */
export function mapVisualPointToLayout(point: VisualPoint, visual: VisualRect, layout: LayoutSize): VisualPoint {
  const scaleX = Number.isFinite(layout.width) && layout.width > 0 && Number.isFinite(visual.width) && visual.width > 0
    ? visual.width / layout.width
    : 1
  const scaleY = Number.isFinite(layout.height) && layout.height > 0 && Number.isFinite(visual.height) && visual.height > 0
    ? visual.height / layout.height
    : 1
  return {
    x: (point.x - visual.left) / scaleX,
    y: (point.y - visual.top) / scaleY
  }
}

export function clampContextMenuPosition(point: VisualPoint, layout: LayoutSize, menuWidth: number, menuHeight: number, margin = 6): VisualPoint {
  const maxX = Math.max(margin, layout.width - menuWidth)
  const maxY = Math.max(margin, layout.height - menuHeight)
  return {
    x: Math.max(margin, Math.min(maxX, point.x)),
    y: Math.max(margin, Math.min(maxY, point.y))
  }
}

/**
 * Flatten only the expanded part of the tree. The function is intentionally
 * pure so keyboard navigation and rendering can share exactly the same row
 * order without touching the canvas state.
 */
export function flattenFileTree(
  root: FileTreeItem | null,
  expandedPaths: ReadonlySet<string>,
  includeRoot = false,
): FlatFileTreeItem[] {
  if (!root) return []
  const rows: FlatFileTreeItem[] = []
  const visit = (item: FileTreeItem, depth: number, parentPath?: string) => {
    const open = item.is_dir && expandedPaths.has(item.path)
    if (includeRoot || depth > 0) rows.push({ item, depth: includeRoot ? depth : depth - 1, open, parentPath })
    if (item.is_dir && open && item.children) {
      item.children.forEach((child) => visit(child, depth + 1, item.path))
    }
  }
  visit(root, 0)
  return rows
}

/** Include matching ancestors so filtering never produces orphan rows. */
export function filterFileTreeRows(rows: FlatFileTreeItem[], query: string): FlatFileTreeItem[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return rows
  const matchingPaths = new Set(
    rows
      .filter(({ item }) => `${item.name} ${item.path}`.toLowerCase().includes(needle))
      .map(({ item }) => item.path),
  )
  const keep = (row: FlatFileTreeItem) => {
    if (matchingPaths.has(row.item.path)) return true
    const prefix = `${row.item.path.replace(/\/$/, '')}/`
    return [...matchingPaths].some((path) => path.startsWith(prefix))
  }
  return rows.filter(keep)
}

/**
 * Git's porcelain-v2 status has two columns. Keeping the interpretation here
 * avoids subtle differences between the tree, changes view and commit form.
 */
export function gitStatusFlags(status = '') {
  const value = status || '  '
  const untracked = value === '??' || value.includes('?')
  return {
    staged: !untracked && value[0] !== ' ' && value[0] !== '?',
    unstaged: untracked || value[1] !== ' ',
    untracked,
    conflict: value[0] === 'U' || value[1] === 'U' || value === 'AA' || value === 'DD',
  }
}

/** Never offer the checked-out branch as a destructive delete target. */
export function filterDeletableBranches<T extends { name: string; current?: boolean }>(branches: T[], currentBranch = '') {
  return branches.filter((branch) => !branch.current && branch.name !== currentBranch)
}

/**
 * Produce stable lane assignments for a commit list. This is a compact graph
 * layout (not a fake screenshot): every parent is inserted into the lane
 * sequence, including merge commits, and colour indexes remain deterministic.
 */
export function buildGraphRows(commits: GraphCommit[]): GraphRow[] {
  const lanes: string[] = []
  const colors = new Map<string, string>()
  return commits.map((commit) => {
    let lane = lanes.indexOf(commit.hash)
    const hasIncoming = lane >= 0
    if (lane < 0) {
      lane = lanes.length
      lanes.push(commit.hash)
    }
    const lanesBefore = [...lanes]
    const color = colors.get(commit.hash) || graphColorForLane(lane)
    colors.set(commit.hash, color)

    const lanesAfter = [...lanesBefore]
    lanesAfter.splice(lane, 1)
    const parents = [...new Set(commit.parents || [])]
    parents.forEach((parent, index) => {
      // A merge diamond can enqueue the same parent through both branches.
      // Keep one lane and preserve the first occurrence so the convergence
      // commit cannot leave a ghost lane behind.
      const existing = lanesAfter.indexOf(parent)
      if (existing >= 0) return
      lanesAfter.splice(Math.min(lane + index, lanesAfter.length), 0, parent)
      // The first parent continues the branch colour. Extra parents create a
      // new coloured rail until they converge again at a later commit.
      if (!colors.has(parent)) colors.set(parent, index === 0 ? color : graphColorForLane(lane + index))
    })

    const throughEdges = lanesBefore.flatMap((hash, fromLane) => {
      if (hash === commit.hash) return []
      const toLane = lanesAfter.indexOf(hash)
      return toLane < 0 ? [] : [{ fromLane, toLane, color: colors.get(hash) || graphColorForLane(fromLane) }]
    })
    const parentEdges = parents.flatMap((parent, index) => {
      const toLane = lanesAfter.indexOf(parent)
      return toLane < 0 ? [] : [{ fromLane: lane, toLane, color: index === 0 ? color : colors.get(parent) || color }]
    })

    lanes.splice(0, lanes.length, ...lanesAfter)
    return {
      commit,
      lane,
      laneCount: Math.max(1, lanesBefore.length, lanesAfter.length, lane + 1),
      laneColors: lanesAfter.map((hash, index) => colors.get(hash) || graphColorForLane(index)),
      color,
      hasIncoming,
      throughEdges,
      parentEdges,
    }
  })
}

export function mergeTreeNode(root: FileTreeItem, replacement: FileTreeItem): FileTreeItem {
  if (root.path === replacement.path) return replacement
  if (!root.children?.length) return root
  let changed = false
  const children = root.children.map((child) => {
    const next = mergeTreeNode(child, replacement)
    changed ||= next !== child
    return next
  })
  return changed ? { ...root, children } : root
}

/**
 * Refresh only replaces the requested directory's shallow listing. Preserve
 * children that were already loaded below each directory in that listing so
 * the periodic Git/status refresh does not silently make an expanded tree
 * impossible to open (the old loaded-path cache would otherwise point at
 * folders whose children had just been discarded).
 */
export function mergeRefreshedTree(current: FileTreeItem | null, replacement: FileTreeItem): FileTreeItem {
  if (!current || current.path !== replacement.path || !replacement.is_dir) return replacement
  const oldChildren = new Map((current.children || []).map((child) => [child.path, child]))
  return {
    ...replacement,
    children: (replacement.children || []).map((child) => {
      const old = oldChildren.get(child.path)
      if (!old || !child.is_dir || !old.is_dir || !old.children?.length) return child
      return { ...child, children: old.children }
    })
  }
}
