import { CanvasEdgeData, CanvasNodeData } from '../../store/workspaceStore'

export type AgentContext = {
  id: string
  kind: 'code' | 'browser' | 'screenshot'
  title: string
  reference: string
  content?: string
  metadata?: Record<string, unknown>
}

export type AgentTarget = {
  id: string
  name: string
  status: string
}

export function connectedAgentTargets(nodes: CanvasNodeData[], edges: CanvasEdgeData[] = [], connectedToNodeId?: string): AgentTarget[] {
  const connectedNodeIds = connectedToNodeId
    ? new Set(edges.flatMap((edge) => edge.source === connectedToNodeId
      ? [edge.target]
      : edge.target === connectedToNodeId
        ? [edge.source]
        : []))
    : null
  return nodes
    .filter((node) => node.kind === 'terminal' && (!connectedNodeIds || connectedNodeIds.has(node.id)))
    .map((node) => ({
      id: node.id,
      name: String(node.properties.agent || node.properties.title || 'Agente'),
      status: String(node.properties.status || 'starting')
    }))
    .filter((agent) => agent.status !== 'exited' && agent.status !== 'error')
}

export function agentContextInput(context: AgentContext, multiline: boolean): string {
  const sections = [
    `Contexto anexado (${context.kind}): ${context.title}`,
    context.reference,
    context.content?.trim() || ''
  ].filter(Boolean)
  const payload = sections.join('\n')
  return multiline ? `${payload}\n` : `${payload.replace(/[ \t]*\r?\n+[ \t]*/g, ' · ')} `
}

export async function materializeAgentContext(context: AgentContext): Promise<AgentContext> {
  const screenshot = context.metadata?.screenshot
  if (!screenshot || typeof screenshot !== 'object' || typeof (screenshot as { dataUrl?: unknown }).dataUrl !== 'string') return context
  try {
    const result = await window.orchestra?.invoke('context.save_image', {
      contextId: context.id,
      dataUrl: (screenshot as { dataUrl: string }).dataUrl
    }) as { path?: string } | undefined
    if (!result?.path) return context
    return {
      ...context,
      content: [context.content?.trim() || '', `Screenshot: ${result.path}`].filter(Boolean).join('\n'),
      metadata: { ...context.metadata, screenshotPath: result.path }
    }
  } catch {
    return context
  }
}

export function addContextToAgent(sessionId: string, context: AgentContext, submit = false): void {
  window.dispatchEvent(new CustomEvent('orchestra:add-agent-context', {
    detail: { sessionId, context, submit }
  }))
  window.dispatchEvent(new CustomEvent('orchestra:focus-node', { detail: { nodeId: sessionId } }))
}

export function formatCodeContext(path: string, startLine: number, endLine: number, selectedText: string): string {
  const range = startLine === endLine ? `Line: ${startLine}` : `Lines: ${startLine}-${endLine}`
  return `File: ${path}\n${range}\n\n\`\`\`\n${selectedText}${selectedText.endsWith('\n') ? '' : '\n'}\`\`\``
}
