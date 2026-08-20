export const CUSTOM_AGENT_STORAGE_KEY = 'orchestra.customAgents.v1'

export type CustomAgent = {
  id: string
  name: string
  command: string
  options: string[]
}

export type CustomAgentDraft = Omit<CustomAgent, 'id'> & { id?: string }

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>

function validId(value: string): boolean {
  return /^custom_[A-Za-z0-9_-]{8,80}$/.test(value)
}

export function validateCustomAgent(draft: CustomAgentDraft): { value?: CustomAgent; error?: string } {
  const name = draft.name.trim()
  const command = draft.command.trim()
  const options = draft.options.map((option) => option.trim()).filter(Boolean)
  if (!name || name.length > 80 || /[\u0000-\u001f\u007f]/.test(name)) return { error: 'O nome deve ter entre 1 e 80 caracteres.' }
  if (!command || command.length > 1024 || command.startsWith('-') || !/^[A-Za-z0-9_@%+=:,./-]+$/.test(command)) {
    return { error: 'O executável deve ser um nome ou path, sem espaços nem operadores de shell.' }
  }
  if (options.length > 64 || options.some((option) => option.length > 1024 || /[\u0000-\u001f\u007f]/.test(option))) {
    return { error: 'Usa no máximo 64 opções; uma por linha e sem caracteres de controlo.' }
  }
  const id = draft.id && validId(draft.id)
    ? draft.id
    : `custom_${crypto.randomUUID().replace(/-/g, '')}`
  return { value: { id, name, command, options } }
}

export function customAgentArgv(agent: Pick<CustomAgent, 'command' | 'options'>): string[] {
  return [agent.command, ...agent.options]
}

export function readCustomAgents(storage: StorageLike = localStorage): CustomAgent[] {
  try {
    const parsed = JSON.parse(storage.getItem(CUSTOM_AGENT_STORAGE_KEY) || '[]')
    if (!Array.isArray(parsed)) return []
    return parsed.slice(0, 50).flatMap((candidate) => {
      if (!candidate || typeof candidate !== 'object') return []
      const result = validateCustomAgent({
        id: typeof candidate.id === 'string' ? candidate.id : undefined,
        name: typeof candidate.name === 'string' ? candidate.name : '',
        command: typeof candidate.command === 'string' ? candidate.command : '',
        options: Array.isArray(candidate.options) ? candidate.options.filter((value: unknown): value is string => typeof value === 'string') : []
      })
      return result.value && typeof candidate.id === 'string' && validId(candidate.id) ? [result.value] : []
    })
  } catch {
    return []
  }
}

export function writeCustomAgents(agents: CustomAgent[], storage: StorageLike = localStorage): void {
  const safe = agents.slice(0, 50).flatMap((agent) => validateCustomAgent(agent).value || [])
  storage.setItem(CUSTOM_AGENT_STORAGE_KEY, JSON.stringify(safe))
}
