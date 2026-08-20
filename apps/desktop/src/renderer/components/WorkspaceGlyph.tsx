import React from 'react'
import {
  Bot,
  Box,
  BrainCircuit,
  Code2,
  Cpu,
  Eye,
  FileText,
  Folder,
  FolderKanban,
  Globe2,
  Hammer,
  Laptop,
  LucideIcon,
  MessagesSquare,
  Monitor,
  Settings,
  Shield,
  Sparkles,
  SquareTerminal,
  Wrench,
  Zap
} from 'lucide-react'

export const WORKSPACE_COLORS = ['#2f91f5', '#ff4d4f', '#34c86f', '#ff9f1c', '#a855d8', '#f23873', '#58bce8', '#ffd21c']

export const WORKSPACE_ICONS: Array<{ id: string; label: string; icon: LucideIcon }> = [
  { id: 'folder-kanban', label: 'Projeto', icon: FolderKanban },
  { id: 'code', label: 'Código', icon: Code2 },
  { id: 'terminal', label: 'Terminal', icon: SquareTerminal },
  { id: 'sparkles', label: 'Criativo', icon: Sparkles },
  { id: 'brain', label: 'IA', icon: BrainCircuit },
  { id: 'settings', label: 'Configuração', icon: Settings },
  { id: 'messages', label: 'Comunicação', icon: MessagesSquare },
  { id: 'laptop', label: 'Laptop', icon: Laptop },
  { id: 'monitor', label: 'Desktop', icon: Monitor },
  { id: 'hammer', label: 'Construção', icon: Hammer },
  { id: 'wrench', label: 'Ferramentas', icon: Wrench },
  { id: 'zap', label: 'Rápido', icon: Zap },
  { id: 'cpu', label: 'Sistema', icon: Cpu },
  { id: 'bot', label: 'Agentes', icon: Bot },
  { id: 'folder', label: 'Pasta', icon: Folder },
  { id: 'file', label: 'Documento', icon: FileText },
  { id: 'box', label: 'Pacote', icon: Box },
  { id: 'shield', label: 'Segurança', icon: Shield },
  { id: 'eye', label: 'Observação', icon: Eye },
  { id: 'globe', label: 'Web', icon: Globe2 }
]

export function WorkspaceGlyph({ icon, color = '#2f91f5', className = '' }: { icon?: string; color?: string; className?: string }) {
  const definition = WORKSPACE_ICONS.find((item) => item.id === icon) || WORKSPACE_ICONS[0]
  const Icon = definition.icon
  return <span className={`workspace-glyph ${className}`} style={{ color, background: `color-mix(in srgb, ${color} 16%, transparent)`, borderColor: `color-mix(in srgb, ${color} 38%, transparent)` }}><Icon className="icon" /></span>
}
