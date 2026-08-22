import type { NodeChange } from '@xyflow/react'
import type { CanvasNodeData } from '../../store/workspaceStore'

export interface CanvasNodeMeasurement {
  width: number
  height: number
}

export interface CanvasNodeChangeResult {
  /** Persistable domain nodes. React Flow internals never get copied here. */
  nodes: CanvasNodeData[]
  /** Runtime-only dimensions reported by React Flow's DOM measurement pass. */
  measurements: Map<string, CanvasNodeMeasurement>
  /** The node ids removed by a controlled React Flow change. */
  removedNodeIds: string[]
  /** The domain selection represented by the controlled change batch. */
  selectedNodeId: string | null
  /** Whether at least one persistable x/y coordinate changed. */
  positionChanged: boolean
}

type CanvasRect = {
  x: number
  y: number
  width: number
  height: number
}

const nodeWidth = (node: CanvasNodeData) => node.width || 300
const nodeHeight = (node: CanvasNodeData) => node.height || 200

const rectsTouch = (first: CanvasRect, second: CanvasRect, gap = 8) => !(
  first.x + first.width + gap <= second.x ||
  first.x >= second.x + second.width + gap ||
  first.y + first.height + gap <= second.y ||
  first.y >= second.y + second.height + gap
)

const validDimension = (value: number | undefined): value is number => Number.isFinite(value) && value > 0

/**
 * Applies React Flow's controlled node changes while keeping the persisted
 * canvas model deliberately smaller than a React Flow node. In particular,
 * `dimensions` are DOM/runtime state and must not be written to the domain
 * store; they are returned separately for the visual node projection.
 */
export function applyCanvasNodeChanges(
  changes: NodeChange[],
  nodes: CanvasNodeData[],
  measurements: ReadonlyMap<string, CanvasNodeMeasurement>,
  selectedNodeId: string | null,
): CanvasNodeChangeResult {
  const nextMeasurements = new Map(measurements)
  const positionChanges = new Map<string, { x: number; y: number; dragging: boolean }>()
  const removedIds = new Set<string>()
  let nextSelectedNodeId = selectedNodeId

  for (const change of changes) {
    switch (change.type) {
      case 'dimensions': {
        const width = change.dimensions?.width
        const height = change.dimensions?.height
        if (validDimension(width) && validDimension(height)) {
          nextMeasurements.set(change.id, { width, height })
        }
        break
      }
      case 'position':
        if (change.position && Number.isFinite(change.position.x) && Number.isFinite(change.position.y)) {
          // React Flow can queue more than one position change in a batch.
          // The final position is the only one that should reach the domain.
          // Preserve the dragging flag so collision detection can be skipped
          // while the user is actively moving a node — applying it mid-drag
          // rejects valid positions and makes nodes snap back.
          positionChanges.set(change.id, {
            x: change.position.x,
            y: change.position.y,
            dragging: change.dragging === true,
          })
        }
        break
      case 'select':
        nextSelectedNodeId = change.selected
          ? change.id
          : nextSelectedNodeId === change.id ? null : nextSelectedNodeId
        break
      case 'remove':
        removedIds.add(change.id)
        if (nextSelectedNodeId === change.id) nextSelectedNodeId = null
        break
      case 'replace':
      case 'add':
        // Canvas nodes are created by the domain store. There is no user
        // action in this surface that asks React Flow to add/replace one.
        break
    }
  }

  const collisionNodes = nodes.filter((node) => !removedIds.has(node.id))
  let positionChanged = false
  const nextNodes = collisionNodes.map((node) => {
    const requested = positionChanges.get(node.id)
    if (!requested) return node

    const wantedX = Math.round(requested.x)
    const wantedY = Math.round(requested.y)

    // Skip collision detection while the user is actively dragging. Enforcing
    // it mid-drag rejects valid intermediate positions (the node briefly
    // overlaps another during transit) and causes the node to snap back to its
    // starting coordinates on every frame. Collision is still applied on the
    // final drop (dragging === false) to prevent nodes from landing on each other.
    if (requested.dragging) {
      if (wantedX === node.x && wantedY === node.y) return node
      positionChanged = true
      return { ...node, x: wantedX, y: wantedY }
    }

    const currentRect: CanvasRect = {
      x: node.x,
      y: node.y,
      width: nodeWidth(node),
      height: nodeHeight(node),
    }

    const candidateX: CanvasRect = { ...currentRect, x: wantedX }
    const collideX = collisionNodes.some((other) => other.id !== node.id && rectsTouch(candidateX, {
      x: other.x,
      y: other.y,
      width: nodeWidth(other),
      height: nodeHeight(other),
    }))
    const finalX = collideX ? node.x : wantedX

    const candidateY: CanvasRect = { ...currentRect, x: finalX, y: wantedY }
    const collideY = collisionNodes.some((other) => other.id !== node.id && rectsTouch(candidateY, {
      x: other.x,
      y: other.y,
      width: nodeWidth(other),
      height: nodeHeight(other),
    }))
    const finalY = collideY ? node.y : wantedY

    if (finalX === node.x && finalY === node.y) return node
    positionChanged = true
    return { ...node, x: finalX, y: finalY }
  })

  return {
    nodes: nextNodes,
    measurements: nextMeasurements,
    removedNodeIds: [...removedIds],
    selectedNodeId: nextSelectedNodeId,
    positionChanged,
  }
}
