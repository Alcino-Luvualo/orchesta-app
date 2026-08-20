import React from 'react'

/**
 * Material Icon Theme generator for Orchestra Desktop.
 * Provides pixel-perfect, colored Material folders (with closed/open states and badges)
 * and file icons matching the popular VS Code Material Icon Theme.
 */

export type MaterialFolderBadge =
  | 'src'
  | 'app'
  | 'components'
  | 'public'
  | 'dist'
  | 'style'
  | 'test'
  | 'node'
  | 'git'
  | 'tools'
  | 'store'
  | 'hook'
  | 'types'
  | 'config'
  | 'docs'
  | 'desktop'
  | 'rust'
  | 'routes'
  | 'api'
  | 'db'

interface FolderTheme {
  front: string
  back: string
  badge?: MaterialFolderBadge
}

function getFolderTheme(folderName: string): FolderTheme {
  const name = folderName.toLowerCase().trim()

  // 1. Source & Code
  if (/^(src|source|sources|code)$/.test(name)) {
    return { front: '#42a5f5', back: '#1e88e5', badge: 'src' }
  }
  // 2. Apps & Workspace packages
  if (/^(app|apps|application|applications|packages|modules)$/.test(name)) {
    return { front: '#8b5cf6', back: '#7c3aed', badge: 'app' }
  }
  // 3. Components & UI widgets
  if (/^(components|component|widgets|elements|ui|views)$/.test(name)) {
    return { front: '#06b6d4', back: '#0891b2', badge: 'components' }
  }
  // 4. Public & Static assets
  if (/^(public|static|assets|asset|resources|res|media|images|img|icons|svg|fonts)$/.test(name)) {
    return { front: '#10b981', back: '#059669', badge: 'public' }
  }
  // 5. Build, Output & Distribution
  if (/^(dist|build|out|output|target|release|bundle|temp|tmp|\.next|\.vite|\.nuxt|out-tsc|bin)$/.test(name)) {
    return { front: '#f59e0b', back: '#d97706', badge: 'dist' }
  }
  // 6. Styles & Themes
  if (/^(styles|style|css|scss|sass|less|theme|themes|styling)$/.test(name)) {
    return { front: '#ec4899', back: '#db2777', badge: 'style' }
  }
  // 7. Tests & Specs
  if (/^(test|tests|__tests__|__mocks__|spec|specs|e2e|coverage|cypress|fixtures)$/.test(name)) {
    return { front: '#84cc16', back: '#65a30d', badge: 'test' }
  }
  // 8. Node modules
  if (name === 'node_modules') {
    return { front: '#22c55e', back: '#16a34a', badge: 'node' }
  }
  // 9. Git & Github
  if (/^(\.git|\.github|\.gitlab|\.gitea|git)$/.test(name)) {
    return { front: '#f43f5e', back: '#e11d48', badge: 'git' }
  }
  // 10. Utils, Helpers & Shared libraries
  if (/^(utils|util|helpers|helper|lib|libs|core|common|shared|services|service)$/.test(name)) {
    return { front: '#f59e0b', back: '#d97706', badge: 'tools' }
  }
  // 11. State & Store
  if (/^(store|stores|state|redux|zustand|mobx|context|contexts)$/.test(name)) {
    return { front: '#a855f7', back: '#9333ea', badge: 'store' }
  }
  // 12. Hooks
  if (/^(hooks|composables)$/.test(name)) {
    return { front: '#06b6d4', back: '#0891b2', badge: 'hook' }
  }
  // 13. Types & Interfaces
  if (/^(types|type|interfaces|@types|typings)$/.test(name)) {
    return { front: '#3b82f6', back: '#2563eb', badge: 'types' }
  }
  // 14. Config & Settings
  if (/^(config|configs|\.config|settings|options|\.vscode|\.idea|\.agents|\.husky)$/.test(name)) {
    return { front: '#64748b', back: '#475569', badge: 'config' }
  }
  // 15. Scripts & Tools
  if (/^(scripts|script|bin|tools|tasks|workflows)$/.test(name)) {
    return { front: '#ef4444', back: '#dc2626', badge: 'tools' }
  }
  // 16. Documentation
  if (/^(docs|doc|documentation|guide|guides|manual)$/.test(name)) {
    return { front: '#14b8a6', back: '#0d9488', badge: 'docs' }
  }
  // 17. Desktop & Native apps
  if (/^(desktop|electron|tauri|native|renderer|main|preload)$/.test(name)) {
    return { front: '#0ea5e9', back: '#0284c7', badge: 'desktop' }
  }
  // 18. Rust & Cargo
  if (/^(crates|rust|cargo)$/.test(name)) {
    return { front: '#ea580c', back: '#c2410c', badge: 'rust' }
  }
  // 19. Routes & Pages
  if (/^(routes|router|pages|views|screens)$/.test(name)) {
    return { front: '#6366f1', back: '#4f46e5', badge: 'routes' }
  }
  // 20. API & Server
  if (/^(api|apis|server|backend|controllers|routes|handlers|proto|grpc)$/.test(name)) {
    return { front: '#f97316', back: '#ea580c', badge: 'api' }
  }
  // 21. Database & Migrations
  if (/^(db|database|prisma|migrations|sql|entities|models|schemas)$/.test(name)) {
    return { front: '#ff7043', back: '#f4511e', badge: 'db' }
  }

  // Default Material Icon Theme warm amber folder
  return { front: '#e5a93b', back: '#ca8a04' }
}

function renderFolderBadge(badge?: MaterialFolderBadge, isOpen = false) {
  if (!badge) return null
  const yOffset = isOpen ? 1 : 0

  switch (badge) {
    case 'src':
      return (
        <path
          d={`M8.5 ${11 + yOffset}L6.5 ${13 + yOffset}L8.5 ${15 + yOffset}M15.5 ${11 + yOffset}L17.5 ${13 + yOffset}L15.5 ${15 + yOffset}`}
          stroke="white"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )
    case 'components':
      return (
        <path
          d={`M12 ${9.5 + yOffset}L15.5 ${11.5 + yOffset}L12 ${13.5 + yOffset}L8.5 ${11.5 + yOffset}ZM12 ${13 + yOffset}L15.5 ${15 + yOffset}L12 ${17 + yOffset}L8.5 ${15 + yOffset}Z`}
          stroke="white"
          strokeWidth="1.1"
          strokeLinejoin="round"
          fill="none"
        />
      )
    case 'app':
      return (
        <g stroke="white" strokeWidth="1.2" fill="none">
          <rect x="8.5" y={10 + yOffset} width="7" height="6.5" rx="1" />
          <line x1="8.5" y1={12.5 + yOffset} x2="15.5" y2={12.5 + yOffset} />
        </g>
      )
    case 'public':
      return (
        <g stroke="white" strokeWidth="1" fill="none">
          <rect x="8.5" y={10.5 + yOffset} width="7" height="6" rx="1" strokeWidth="1.1" />
          <circle cx="10.5" cy={12.5 + yOffset} r="0.8" fill="white" />
          <path d={`M8.5 ${15.5 + yOffset}L11 ${13.5 + yOffset}L13.5 ${15.5 + yOffset}L15.5 ${14 + yOffset}`} />
        </g>
      )
    case 'dist':
      return (
        <path
          d={`M8.5 ${11 + yOffset}L12 ${9.5 + yOffset}L15.5 ${11 + yOffset}V15.5L12 ${17 + yOffset}L8.5 ${15.5 + yOffset}ZM12 ${9.5 + yOffset}V17M8.5 ${11 + yOffset}L15.5 ${15 + yOffset}`}
          stroke="white"
          strokeWidth="1.1"
          strokeLinejoin="round"
          fill="none"
        />
      )
    case 'style':
      return (
        <path
          d={`M12 ${10 + yOffset}C9.8 ${10 + yOffset} 8 ${11.5 + yOffset} 8 ${13.5 + yOffset}C8 ${15.2 + yOffset} 9.2 ${16.5 + yOffset} 10.8 ${16.5 + yOffset}C11.5 ${16.5 + yOffset} 12 ${16 + yOffset} 12 ${15.5 + yOffset}C12 ${15.2 + yOffset} 11.8 ${15 + yOffset} 11.8 ${14.8 + yOffset}C11.8 ${14.5 + yOffset} 12 ${14.2 + yOffset} 12.3 ${14.2 + yOffset}H13.5C15.2 ${14.2 + yOffset} 16.5 ${13 + yOffset} 16.5 ${11.5 + yOffset}C16.5 ${10 + yOffset} 14.5 ${10 + yOffset} 12 ${10 + yOffset}Z`}
          stroke="white"
          strokeWidth="1.1"
          fill="none"
        />
      )
    case 'test':
      return (
        <path
          d={`M10.5 ${9.5 + yOffset}V12L8.5 ${15.5 + yOffset}C8.2 ${16.2 + yOffset} 8.7 ${17 + yOffset} 9.5 ${17 + yOffset}H14.5C15.3 ${17 + yOffset} 15.8 ${16.2 + yOffset} 15.5 ${15.5 + yOffset}L13.5 ${12 + yOffset}V9.5M9.5 ${9.5 + yOffset}H14.5`}
          stroke="white"
          strokeWidth="1.1"
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        />
      )
    case 'node':
      return (
        <path
          d={`M12 ${9.5 + yOffset}L15.5 ${11.5 + yOffset}V15.5L12 ${17.5 + yOffset}L8.5 ${15.5 + yOffset}V11.5Z`}
          stroke="white"
          strokeWidth="1.2"
          strokeLinejoin="round"
          fill="none"
        />
      )
    case 'git':
      return (
        <g fill="white">
          <circle cx="9.5" cy={11 + yOffset} r="1.1" />
          <circle cx="14.5" cy={11 + yOffset} r="1.1" />
          <circle cx="12" cy={16 + yOffset} r="1.1" />
          <path
            d={`M9.5 ${11 + yOffset}V13.5C9.5 ${14.5 + yOffset} 10.5 ${15 + yOffset} 12 ${16 + yOffset}M14.5 ${11 + yOffset}V13.5C14.5 ${14.5 + yOffset} 13.5 ${15 + yOffset} 12 ${16 + yOffset}`}
            stroke="white"
            strokeWidth="1.1"
            fill="none"
          />
        </g>
      )
    case 'tools':
      return (
        <path
          d={`M9.5 ${10.5 + yOffset}L11.5 ${12.5 + yOffset}M14.5 ${15.5 + yOffset}L12.5 ${13.5 + yOffset}M14.5 ${10.5 + yOffset}C13.5 ${10.5 + yOffset} 12.8 ${11 + yOffset} 12.5 ${11.5 + yOffset}L9.5 ${14.5 + yOffset}C9 ${15 + yOffset} 9 ${16 + yOffset} 9.5 ${16.5 + yOffset}C10 ${17 + yOffset} 11 ${17 + yOffset} 11.5 ${16.5 + yOffset}L14.5 ${13.5 + yOffset}C15 ${13.2 + yOffset} 15.5 ${12.5 + yOffset} 15.5 ${11.5 + yOffset}C15.5 ${11 + yOffset} 15 ${10.5 + yOffset} 14.5 ${10.5 + yOffset}Z`}
          stroke="white"
          strokeWidth="1.1"
          fill="none"
        />
      )
    case 'store':
      return (
        <path
          d={`M12.5 ${9.5 + yOffset}L9.5 ${13 + yOffset}H12L11.5 ${16.5 + yOffset}L14.5 ${13 + yOffset}H12L12.5 ${9.5 + yOffset}Z`}
          fill="white"
        />
      )
    case 'hook':
      return (
        <path
          d={`M13.5 ${10 + yOffset}C11.5 ${10 + yOffset} 10.5 ${11.5 + yOffset} 10.5 ${13.5 + yOffset}C10.5 ${15.5 + yOffset} 12 ${16.5 + yOffset} 13.5 ${16.5 + yOffset}C15 ${16.5 + yOffset} 15.5 ${15.5 + yOffset} 15.5 ${14.5 + yOffset}L14 ${15 + yOffset}`}
          stroke="white"
          strokeWidth="1.2"
          strokeLinecap="round"
          fill="none"
        />
      )
    case 'types':
      return (
        <g fill="white">
          <text x="12" y={15 + yOffset} textAnchor="middle" fontSize="6.5" fontWeight="900" fontFamily="sans-serif">
            TS
          </text>
        </g>
      )
    case 'config':
      return (
        <g stroke="white" strokeWidth="1.1" fill="none">
          <circle cx="12" cy={13.5 + yOffset} r="1.5" />
          <path d={`M12 ${10 + yOffset}V11M12 ${16 + yOffset}V17M8.5 ${13.5 + yOffset}H9.5M14.5 ${13.5 + yOffset}H15.5`} />
        </g>
      )
    case 'docs':
      return (
        <path
          d={`M9.5 ${11 + yOffset}H14.5M9.5 ${13.5 + yOffset}H14.5M9.5 ${16 + yOffset}H12.5`}
          stroke="white"
          strokeWidth="1.2"
          strokeLinecap="round"
        />
      )
    case 'desktop':
      return (
        <g stroke="white" strokeWidth="1.1" fill="none">
          <rect x="8.5" y={10 + yOffset} width="7" height="5" rx="0.8" />
          <line x1="10" y1={16.5 + yOffset} x2="14" y2={16.5 + yOffset} />
          <line x1="12" y1={15 + yOffset} x2="12" y2={16.5 + yOffset} />
        </g>
      )
    case 'rust':
      return (
        <g stroke="white" strokeWidth="1.1" fill="none">
          <circle cx="12" cy={13.5 + yOffset} r="2" />
          <path d={`M12 ${10.5 + yOffset}V11.5M12 ${15.5 + yOffset}V16.5M9 ${13.5 + yOffset}H10M14 ${13.5 + yOffset}H15`} />
        </g>
      )
    case 'routes':
      return (
        <g fill="none" stroke="white" strokeWidth="1.1">
          <circle cx="9.5" cy={11 + yOffset} r="1" fill="white" />
          <circle cx="14.5" cy={16 + yOffset} r="1" fill="white" />
          <path d={`M9.5 ${12 + yOffset}V14C9.5 ${15 + yOffset} 10.5 ${16 + yOffset} 11.5 ${16 + yOffset}H13.5`} />
        </g>
      )
    case 'api':
      return (
        <g stroke="white" strokeWidth="1.1" fill="none">
          <circle cx="12" cy={13.5 + yOffset} r="3" />
          <ellipse cx="12" cy={13.5 + yOffset} rx="1.3" ry="3" />
          <line x1="9" y1={13.5 + yOffset} x2="15" y2={13.5 + yOffset} />
        </g>
      )
    case 'db':
      return (
        <g stroke="white" strokeWidth="1.1" fill="none">
          <ellipse cx="12" cy={10.5 + yOffset} rx="3.5" ry="1.2" />
          <path d={`M8.5 ${10.5 + yOffset}V15.5C8.5 ${16.2 + yOffset} 10.1 ${16.7 + yOffset} 12 ${16.7 + yOffset}C13.9 ${16.7 + yOffset} 15.5 ${16.2 + yOffset} 15.5 ${15.5 + yOffset}V10.5`} />
          <path d={`M8.5 ${13 + yOffset}C8.5 ${13.7 + yOffset} 10.1 ${14.2 + yOffset} 12 ${14.2 + yOffset}C13.9 ${14.2 + yOffset} 15.5 ${13.7 + yOffset} 15.5 ${13 + yOffset}`} />
        </g>
      )
    default:
      return null
  }
}

/** Material Folder Icon Component */
export const MaterialFolderIcon: React.FC<{
  name: string
  isOpen?: boolean
  className?: string
}> = ({ name, isOpen = false, className = 'file-icon folder' }) => {
  const theme = getFolderTheme(name)

  if (isOpen) {
    return (
      <svg
        viewBox="0 0 24 24"
        className={className}
        width="15"
        height="15"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        style={{ flexShrink: 0 }}
      >
        {/* Back plate & tab */}
        <path
          d="M2.5 5C2.5 3.9 3.4 3 4.5 3H9.1C9.6 3 10.1 3.2 10.5 3.6L12.4 5.5H19.5C20.6 5.5 21.5 6.4 21.5 7.5V12.5H2.5V5Z"
          fill={theme.back}
        />
        {/* Interior sheet depth */}
        <rect x="4.5" y="7.5" width="15" height="5.5" rx="1" fill="#ffffff" fillOpacity="0.28" />
        {/* Open perspective flap */}
        <path
          d="M22.2 11.2C22.6 11.2 22.9 11.6 22.8 12L20.6 19.2C20.3 19.9 19.7 20.5 18.9 20.5H3.1C2.5 20.5 2.1 20 2.3 19.4L4.7 12.4C4.9 11.7 5.5 11.2 6.3 11.2H22.2Z"
          fill={theme.front}
        />
        {/* Top flap specular highlight */}
        <path
          d="M6.3 11.2H22.2C22.6 11.2 22.9 11.6 22.8 12L22.4 12.6H5.8L6.3 11.2Z"
          fill="#ffffff"
          fillOpacity="0.22"
        />
        {renderFolderBadge(theme.badge, true)}
      </svg>
    )
  }

  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      width="15"
      height="15"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      style={{ flexShrink: 0 }}
    >
      {/* Back tab */}
      <path
        d="M2.5 5C2.5 3.9 3.4 3 4.5 3H9.1C9.6 3 10.1 3.2 10.5 3.6L12.4 5.5H19.5C20.6 5.5 21.5 6.4 21.5 7.5V11H2.5V5Z"
        fill={theme.back}
      />
      {/* Front folder body */}
      <path
        d="M2.5 8.5C2.5 7.4 3.4 6.5 4.5 6.5H19.5C20.6 6.5 21.5 7.4 21.5 8.5V18.5C21.5 19.6 20.6 20.5 19.5 20.5H4.5C3.4 20.5 2.5 19.6 2.5 18.5V8.5Z"
        fill={theme.front}
      />
      {/* Top highlight */}
      <path
        d="M4.5 6.5H19.5C20.6 6.5 21.5 7.4 21.5 8.5V9.2H2.5V8.5C2.5 7.4 3.4 6.5 4.5 6.5Z"
        fill="#ffffff"
        fillOpacity="0.18"
      />
      {renderFolderBadge(theme.badge, false)}
    </svg>
  )
}

/** Material File Icon Component */
export const MaterialFileIcon: React.FC<{
  name: string
  className?: string
}> = ({ name, className = 'file-icon' }) => {
  const lower = name.toLowerCase().trim()

  // 1. Exact / Special Filename Rules
  if (lower === 'package.json') {
    return (
      <svg viewBox="0 0 24 24" className={className} width="15" height="15" fill="none" style={{ flexShrink: 0 }}>
        <rect x="3" y="3" width="18" height="18" rx="3" fill="#cb3837" />
        <path d="M7 7H17V17H13.5V10.5H10.5V17H7V7Z" fill="white" />
      </svg>
    )
  }

  if (lower.startsWith('tsconfig') && lower.endsWith('.json')) {
    return (
      <svg viewBox="0 0 24 24" className={className} width="15" height="15" fill="none" style={{ flexShrink: 0 }}>
        <rect x="3" y="3" width="18" height="18" rx="3" fill="#3178c6" />
        <text x="12" y="15.5" textAnchor="middle" fill="white" fontSize="9.5" fontWeight="900" fontFamily="sans-serif">
          TS
        </text>
        <circle cx="17.5" cy="6.5" r="2.5" fill="#f59e0b" />
      </svg>
    )
  }

  if (lower.startsWith('vite.config.')) {
    return (
      <svg viewBox="0 0 24 24" className={className} width="15" height="15" fill="none" style={{ flexShrink: 0 }}>
        <rect x="3" y="3" width="18" height="18" rx="3" fill="#646cff" />
        <path d="M12.5 5L7 13.5H12L11 19L17 10.5H12L12.5 5Z" fill="#ffdf00" />
      </svg>
    )
  }

  if (lower.startsWith('tailwind.config.')) {
    return (
      <svg viewBox="0 0 24 24" className={className} width="15" height="15" fill="none" style={{ flexShrink: 0 }}>
        <rect x="3" y="3" width="18" height="18" rx="3" fill="#06b6d4" />
        <path
          d="M8.5 13C9.5 11 11 10.5 13 11.5C12 12.5 12 13.5 13 14C14 14.5 15 14 15.5 13C14.5 15 13 15.5 11 14.5C12 13.5 12 12.5 11 12C10 11.5 9 12 8.5 13Z"
          fill="white"
        />
      </svg>
    )
  }

  if (/^(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb|cargo\.lock)$/.test(lower)) {
    return (
      <svg viewBox="0 0 24 24" className={className} width="15" height="15" fill="none" style={{ flexShrink: 0 }}>
        <path d="M5 3.5C5 2.7 5.7 2 6.5 2H14.5L19 6.5V20.5C19 21.3 18.3 22 17.5 22H6.5C5.7 22 5 21.3 5 20.5V3.5Z" fill="#64748b" />
        <path d="M14.5 2V6.5H19" fill="#475569" />
        <rect x="9" y="12" width="6" height="5" rx="1" fill="#f59e0b" />
        <path d="M10.5 12V10C10.5 9.2 11.2 8.5 12 8.5C12.8 8.5 13.5 9.2 13.5 10V12" stroke="#f59e0b" strokeWidth="1.2" fill="none" />
      </svg>
    )
  }

  if (/^\.env(\..+)?$/.test(lower)) {
    return (
      <svg viewBox="0 0 24 24" className={className} width="15" height="15" fill="none" style={{ flexShrink: 0 }}>
        <rect x="3" y="3" width="18" height="18" rx="3" fill="#eab308" />
        <circle cx="10" cy="12" r="3" stroke="#1c1917" strokeWidth="1.5" fill="none" />
        <path d="M13 12H17M15 12V14M17 12V14" stroke="#1c1917" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    )
  }

  if (/^\.git(ignore|attributes|modules)$/.test(lower)) {
    return (
      <svg viewBox="0 0 24 24" className={className} width="15" height="15" fill="none" style={{ flexShrink: 0 }}>
        <rect x="3" y="3" width="18" height="18" rx="3" fill="#f97316" />
        <circle cx="9" cy="9" r="1.8" fill="white" />
        <circle cx="15" cy="9" r="1.8" fill="white" />
        <circle cx="12" cy="15" r="1.8" fill="white" />
        <path d="M9 9V12C9 13.5 10.5 14 12 15M15 9V12C15 13.5 13.5 14 12 15" stroke="white" strokeWidth="1.5" fill="none" />
      </svg>
    )
  }

  if (/^dockerfile(\..+)?$|^docker-compose\.ya?ml$/.test(lower)) {
    return (
      <svg viewBox="0 0 24 24" className={className} width="15" height="15" fill="none" style={{ flexShrink: 0 }}>
        <rect x="3" y="3" width="18" height="18" rx="3" fill="#2496ed" />
        <rect x="6.5" y="11" width="2" height="2" fill="white" />
        <rect x="9" y="11" width="2" height="2" fill="white" />
        <rect x="11.5" y="11" width="2" height="2" fill="white" />
        <rect x="9" y="8.5" width="2" height="2" fill="white" />
        <path d="M5 14C6 14 7 15 9 15C11 15 12 14 14 14C16 14 17 15 19 15" stroke="white" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    )
  }

  if (/^readme(\.md|\.markdown|\.txt)?$/.test(lower)) {
    return (
      <svg viewBox="0 0 24 24" className={className} width="15" height="15" fill="none" style={{ flexShrink: 0 }}>
        <path d="M5 3.5C5 2.7 5.7 2 6.5 2H14.5L19 6.5V20.5C19 21.3 18.3 22 17.5 22H6.5C5.7 22 5 21.3 5 20.5V3.5Z" fill="#0284c7" />
        <path d="M14.5 2V6.5H19" fill="#0369a1" />
        <circle cx="12" cy="10" r="1.2" fill="white" />
        <line x1="12" y1="13" x2="12" y2="17" stroke="white" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
    )
  }

  if (/^license(\.md|\.txt)?$|^licence(\.md|\.txt)?$/.test(lower)) {
    return (
      <svg viewBox="0 0 24 24" className={className} width="15" height="15" fill="none" style={{ flexShrink: 0 }}>
        <path d="M5 3.5C5 2.7 5.7 2 6.5 2H14.5L19 6.5V20.5C19 21.3 18.3 22 17.5 22H6.5C5.7 22 5 21.3 5 20.5V3.5Z" fill="#eab308" />
        <path d="M14.5 2V6.5H19" fill="#ca8a04" />
        <path d="M8.5 12H15.5M12 9.5V16.5M9.5 16.5H14.5" stroke="#1c1917" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    )
  }

  if (lower === 'cargo.toml') {
    return (
      <svg viewBox="0 0 24 24" className={className} width="15" height="15" fill="none" style={{ flexShrink: 0 }}>
        <rect x="3" y="3" width="18" height="18" rx="3" fill="#ea580c" />
        <rect x="6.5" y="6.5" width="11" height="11" rx="1.5" stroke="white" strokeWidth="1.5" fill="none" />
        <path d="M6.5 6.5L17.5 17.5M17.5 6.5L6.5 17.5" stroke="white" strokeWidth="1.2" />
      </svg>
    )
  }

  // 2. Test File Pattern
  if (/\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs)$/.test(lower)) {
    return (
      <svg viewBox="0 0 24 24" className={className} width="15" height="15" fill="none" style={{ flexShrink: 0 }}>
        <rect x="3" y="3" width="18" height="18" rx="3" fill="#84cc16" />
        <path d="M10 7V10L7.5 15C7 16 7.7 17 8.8 17H15.2C16.3 17 17 16 16.5 15L14 10V7M9 7H15" stroke="white" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" fill="none" />
      </svg>
    )
  }

  // 3. Extension Rules
  const ext = lower.slice(lower.lastIndexOf('.') + 1)

  switch (ext) {
    case 'ts':
      return (
        <svg viewBox="0 0 24 24" className={className} width="15" height="15" fill="none" style={{ flexShrink: 0 }}>
          <rect x="3" y="3" width="18" height="18" rx="3" fill="#3178c6" />
          <text x="12" y="16.5" textAnchor="middle" fill="white" fontSize="11" fontWeight="900" fontFamily="sans-serif">
            TS
          </text>
        </svg>
      )
    case 'tsx':
      return (
        <svg viewBox="0 0 24 24" className={className} width="15" height="15" fill="none" style={{ flexShrink: 0 }}>
          <rect x="3" y="3" width="18" height="18" rx="3" fill="#00b4d8" />
          <ellipse cx="12" cy="12" rx="7.5" ry="3" stroke="white" strokeWidth="1.2" transform="rotate(30 12 12)" />
          <ellipse cx="12" cy="12" rx="7.5" ry="3" stroke="white" strokeWidth="1.2" transform="rotate(-30 12 12)" />
          <ellipse cx="12" cy="12" rx="7.5" ry="3" stroke="white" strokeWidth="1.2" transform="rotate(90 12 12)" />
          <circle cx="12" cy="12" r="1.5" fill="white" />
        </svg>
      )
    case 'js':
    case 'mjs':
    case 'cjs':
      return (
        <svg viewBox="0 0 24 24" className={className} width="15" height="15" fill="none" style={{ flexShrink: 0 }}>
          <rect x="3" y="3" width="18" height="18" rx="3" fill="#f7df1e" />
          <text x="12" y="16.5" textAnchor="middle" fill="#18181b" fontSize="11" fontWeight="900" fontFamily="sans-serif">
            JS
          </text>
        </svg>
      )
    case 'jsx':
      return (
        <svg viewBox="0 0 24 24" className={className} width="15" height="15" fill="none" style={{ flexShrink: 0 }}>
          <rect x="3" y="3" width="18" height="18" rx="3" fill="#00d8ff" />
          <ellipse cx="12" cy="12" rx="7.5" ry="3" stroke="#18181b" strokeWidth="1.3" transform="rotate(30 12 12)" />
          <ellipse cx="12" cy="12" rx="7.5" ry="3" stroke="#18181b" strokeWidth="1.3" transform="rotate(-30 12 12)" />
          <ellipse cx="12" cy="12" rx="7.5" ry="3" stroke="#18181b" strokeWidth="1.3" transform="rotate(90 12 12)" />
          <circle cx="12" cy="12" r="1.5" fill="#18181b" />
        </svg>
      )
    case 'json':
    case 'jsonc':
    case 'json5':
      return (
        <svg viewBox="0 0 24 24" className={className} width="15" height="15" fill="none" style={{ flexShrink: 0 }}>
          <path d="M5 3.5C5 2.7 5.7 2 6.5 2H14.5L19 6.5V20.5C19 21.3 18.3 22 17.5 22H6.5C5.7 22 5 21.3 5 20.5V3.5Z" fill="#f59e0b" />
          <path d="M14.5 2V6.5H19" fill="#d97706" />
          <text x="12" y="16" textAnchor="middle" fill="white" fontSize="9" fontWeight="900" fontFamily="monospace">
            {'{ }'}
          </text>
        </svg>
      )
    case 'css':
      return (
        <svg viewBox="0 0 24 24" className={className} width="15" height="15" fill="none" style={{ flexShrink: 0 }}>
          <path d="M5 3.5C5 2.7 5.7 2 6.5 2H14.5L19 6.5V20.5C19 21.3 18.3 22 17.5 22H6.5C5.7 22 5 21.3 5 20.5V3.5Z" fill="#38bdf8" />
          <path d="M14.5 2V6.5H19" fill="#0284c7" />
          <text x="12" y="16.5" textAnchor="middle" fill="white" fontSize="11" fontWeight="900" fontFamily="sans-serif">
            #
          </text>
        </svg>
      )
    case 'scss':
    case 'sass':
    case 'less':
      return (
        <svg viewBox="0 0 24 24" className={className} width="15" height="15" fill="none" style={{ flexShrink: 0 }}>
          <path d="M5 3.5C5 2.7 5.7 2 6.5 2H14.5L19 6.5V20.5C19 21.3 18.3 22 17.5 22H6.5C5.7 22 5 21.3 5 20.5V3.5Z" fill="#ec4899" />
          <path d="M14.5 2V6.5H19" fill="#be185d" />
          <text x="12" y="16" textAnchor="middle" fill="white" fontSize="9.5" fontWeight="900" fontFamily="sans-serif">
            S
          </text>
        </svg>
      )
    case 'html':
    case 'htm':
      return (
        <svg viewBox="0 0 24 24" className={className} width="15" height="15" fill="none" style={{ flexShrink: 0 }}>
          <path d="M5 3.5C5 2.7 5.7 2 6.5 2H14.5L19 6.5V20.5C19 21.3 18.3 22 17.5 22H6.5C5.7 22 5 21.3 5 20.5V3.5Z" fill="#e34f26" />
          <path d="M14.5 2V6.5H19" fill="#c23916" />
          <path d="M9 11L7 13.5L9 16M15 11L17 13.5L15 16M13 10.5L11 16.5" stroke="white" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )
    case 'md':
    case 'mdx':
    case 'markdown':
      return (
        <svg viewBox="0 0 24 24" className={className} width="15" height="15" fill="none" style={{ flexShrink: 0 }}>
          <path d="M5 3.5C5 2.7 5.7 2 6.5 2H14.5L19 6.5V20.5C19 21.3 18.3 22 17.5 22H6.5C5.7 22 5 21.3 5 20.5V3.5Z" fill="#0284c7" />
          <path d="M14.5 2V6.5H19" fill="#0369a1" />
          <path d="M8 16V11L10 13.5L12 11V16M15 13.5L16.5 15L15 16.5M16.5 15H13.5" stroke="white" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )
    case 'rs':
      return (
        <svg viewBox="0 0 24 24" className={className} width="15" height="15" fill="none" style={{ flexShrink: 0 }}>
          <rect x="3" y="3" width="18" height="18" rx="3" fill="#dea584" />
          <circle cx="12" cy="12" r="5" stroke="#18181b" strokeWidth="1.5" strokeDasharray="2 1.5" fill="none" />
          <text x="12" y="15.5" textAnchor="middle" fill="#18181b" fontSize="8" fontWeight="900" fontFamily="sans-serif">
            R
          </text>
        </svg>
      )
    case 'toml':
      return (
        <svg viewBox="0 0 24 24" className={className} width="15" height="15" fill="none" style={{ flexShrink: 0 }}>
          <path d="M5 3.5C5 2.7 5.7 2 6.5 2H14.5L19 6.5V20.5C19 21.3 18.3 22 17.5 22H6.5C5.7 22 5 21.3 5 20.5V3.5Z" fill="#f59e0b" />
          <path d="M14.5 2V6.5H19" fill="#d97706" />
          <text x="12" y="16.5" textAnchor="middle" fill="white" fontSize="10" fontWeight="900" fontFamily="sans-serif">
            T
          </text>
        </svg>
      )
    case 'yaml':
    case 'yml':
      return (
        <svg viewBox="0 0 24 24" className={className} width="15" height="15" fill="none" style={{ flexShrink: 0 }}>
          <path d="M5 3.5C5 2.7 5.7 2 6.5 2H14.5L19 6.5V20.5C19 21.3 18.3 22 17.5 22H6.5C5.7 22 5 21.3 5 20.5V3.5Z" fill="#a855f7" />
          <path d="M14.5 2V6.5H19" fill="#9333ea" />
          <text x="12" y="16.5" textAnchor="middle" fill="white" fontSize="10" fontWeight="900" fontFamily="sans-serif">
            Y
          </text>
        </svg>
      )
    case 'sh':
    case 'bash':
    case 'zsh':
    case 'fish':
    case 'ps1':
    case 'bat':
    case 'cmd':
      return (
        <svg viewBox="0 0 24 24" className={className} width="15" height="15" fill="none" style={{ flexShrink: 0 }}>
          <rect x="3" y="3" width="18" height="18" rx="3" fill="#22c55e" />
          <path d="M7.5 9L11 12L7.5 15M12.5 15H16.5" stroke="white" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )
    case 'png':
    case 'jpg':
    case 'jpeg':
    case 'gif':
    case 'webp':
    case 'ico':
    case 'bmp':
    case 'tiff':
      return (
        <svg viewBox="0 0 24 24" className={className} width="15" height="15" fill="none" style={{ flexShrink: 0 }}>
          <rect x="3" y="3" width="18" height="18" rx="3" fill="#10b981" />
          <circle cx="8.5" cy="8.5" r="1.5" fill="white" />
          <path d="M6 18L11 12L15 16L18 13L20 16V18H6Z" fill="white" />
        </svg>
      )
    case 'svg':
      return (
        <svg viewBox="0 0 24 24" className={className} width="15" height="15" fill="none" style={{ flexShrink: 0 }}>
          <rect x="3" y="3" width="18" height="18" rx="3" fill="#f59e0b" />
          <path d="M7 15C7 11 10 9 12 12C14 15 17 13 17 9" stroke="white" strokeWidth="1.8" strokeLinecap="round" fill="none" />
          <circle cx="7" cy="15" r="1.5" fill="white" />
          <circle cx="17" cy="9" r="1.5" fill="white" />
        </svg>
      )
    case 'mp3':
    case 'wav':
    case 'ogg':
    case 'flac':
    case 'm4a':
      return (
        <svg viewBox="0 0 24 24" className={className} width="15" height="15" fill="none" style={{ flexShrink: 0 }}>
          <rect x="3" y="3" width="18" height="18" rx="3" fill="#a855f7" />
          <circle cx="9" cy="15.5" r="2" fill="white" />
          <circle cx="15" cy="13.5" r="2" fill="white" />
          <path d="M11 15.5V8.5L17 6.5V13.5" stroke="white" strokeWidth="1.5" />
        </svg>
      )
    case 'mp4':
    case 'webm':
    case 'mov':
    case 'mkv':
    case 'avi':
      return (
        <svg viewBox="0 0 24 24" className={className} width="15" height="15" fill="none" style={{ flexShrink: 0 }}>
          <rect x="3" y="3" width="18" height="18" rx="3" fill="#8b5cf6" />
          <polygon points="10,8.5 16,12 10,15.5" fill="white" />
        </svg>
      )
    case 'woff':
    case 'woff2':
    case 'ttf':
    case 'otf':
    case 'eot':
      return (
        <svg viewBox="0 0 24 24" className={className} width="15" height="15" fill="none" style={{ flexShrink: 0 }}>
          <rect x="3" y="3" width="18" height="18" rx="3" fill="#ec4899" />
          <text x="12" y="16.5" textAnchor="middle" fill="white" fontSize="12" fontWeight="900" fontFamily="serif">
            A
          </text>
        </svg>
      )
    case 'pdf':
      return (
        <svg viewBox="0 0 24 24" className={className} width="15" height="15" fill="none" style={{ flexShrink: 0 }}>
          <path d="M5 3.5C5 2.7 5.7 2 6.5 2H14.5L19 6.5V20.5C19 21.3 18.3 22 17.5 22H6.5C5.7 22 5 21.3 5 20.5V3.5Z" fill="#ef4444" />
          <path d="M14.5 2V6.5H19" fill="#b91c1c" />
          <text x="12" y="16" textAnchor="middle" fill="white" fontSize="7.5" fontWeight="900" fontFamily="sans-serif">
            PDF
          </text>
        </svg>
      )
    case 'zip':
    case 'tar':
    case 'gz':
    case '7z':
    case 'rar':
    case 'tgz':
      return (
        <svg viewBox="0 0 24 24" className={className} width="15" height="15" fill="none" style={{ flexShrink: 0 }}>
          <path d="M5 3.5C5 2.7 5.7 2 6.5 2H14.5L19 6.5V20.5C19 21.3 18.3 22 17.5 22H6.5C5.7 22 5 21.3 5 20.5V3.5Z" fill="#f59e0b" />
          <path d="M14.5 2V6.5H19" fill="#d97706" />
          <rect x="10.5" y="8" width="3" height="1.5" fill="white" />
          <rect x="10.5" y="11" width="3" height="1.5" fill="white" />
          <rect x="10.5" y="14" width="3" height="1.5" fill="white" />
        </svg>
      )
    case 'sql':
    case 'sqlite':
    case 'prisma':
    case 'db':
      return (
        <svg viewBox="0 0 24 24" className={className} width="15" height="15" fill="none" style={{ flexShrink: 0 }}>
          <rect x="3" y="3" width="18" height="18" rx="3" fill="#ff7043" />
          <ellipse cx="12" cy="8" rx="5" ry="2" stroke="white" strokeWidth="1.2" fill="none" />
          <path d="M7 8V16C7 17.1 9.2 18 12 18C14.8 18 17 17.1 17 16V8" stroke="white" strokeWidth="1.2" fill="none" />
          <path d="M7 12C7 13.1 9.2 14 12 14C14.8 14 17 13.1 17 12" stroke="white" strokeWidth="1.2" fill="none" />
        </svg>
      )
    case 'graphql':
    case 'gql':
      return (
        <svg viewBox="0 0 24 24" className={className} width="15" height="15" fill="none" style={{ flexShrink: 0 }}>
          <rect x="3" y="3" width="18" height="18" rx="3" fill="#e10098" />
          <circle cx="12" cy="7" r="1.5" fill="white" />
          <circle cx="16.5" cy="9.5" r="1.5" fill="white" />
          <circle cx="16.5" cy="14.5" r="1.5" fill="white" />
          <circle cx="12" cy="17" r="1.5" fill="white" />
          <circle cx="7.5" cy="14.5" r="1.5" fill="white" />
          <circle cx="7.5" cy="9.5" r="1.5" fill="white" />
          <polygon points="12,7 16.5,9.5 16.5,14.5 12,17 7.5,14.5 7.5,9.5" stroke="white" strokeWidth="1" fill="none" />
        </svg>
      )
    case 'py':
    case 'pyw':
      return (
        <svg viewBox="0 0 24 24" className={className} width="15" height="15" fill="none" style={{ flexShrink: 0 }}>
          <rect x="3" y="3" width="18" height="18" rx="3" fill="#3776ab" />
          <path
            d="M12 6C9.5 6 9.5 7.5 9.5 7.5V9.5H12.5V10.5H8C6.5 10.5 5.5 11.5 5.5 13C5.5 14.5 6.5 15.5 8 15.5H9V14C9 12.8 10 12 11 12H13.5C14.5 12 15.5 11 15.5 10V7.5C15.5 6 14.5 6 12 6Z"
            fill="#ffde57"
          />
          <path
            d="M12 18C14.5 18 14.5 16.5 14.5 16.5V14.5H11.5V13.5H16C17.5 13.5 18.5 12.5 18.5 11C18.5 9.5 17.5 8.5 16 8.5H15V10C15 11.2 14 12 13 12H10.5C9.5 12 8.5 13 8.5 14V16.5C8.5 18 9.5 18 12 18Z"
            fill="white"
          />
        </svg>
      )
    case 'go':
      return (
        <svg viewBox="0 0 24 24" className={className} width="15" height="15" fill="none" style={{ flexShrink: 0 }}>
          <rect x="3" y="3" width="18" height="18" rx="3" fill="#00add8" />
          <text x="12" y="16" textAnchor="middle" fill="white" fontSize="9.5" fontWeight="900" fontFamily="sans-serif">
            GO
          </text>
        </svg>
      )
    case 'xml':
      return (
        <svg viewBox="0 0 24 24" className={className} width="15" height="15" fill="none" style={{ flexShrink: 0 }}>
          <path d="M5 3.5C5 2.7 5.7 2 6.5 2H14.5L19 6.5V20.5C19 21.3 18.3 22 17.5 22H6.5C5.7 22 5 21.3 5 20.5V3.5Z" fill="#f1662a" />
          <path d="M14.5 2V6.5H19" fill="#c2410c" />
          <path d="M9 11L7 13.5L9 16M15 11L17 13.5L15 16" stroke="white" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )
    case 'txt':
    case 'log':
      return (
        <svg viewBox="0 0 24 24" className={className} width="15" height="15" fill="none" style={{ flexShrink: 0 }}>
          <path d="M5 3.5C5 2.7 5.7 2 6.5 2H14.5L19 6.5V20.5C19 21.3 18.3 22 17.5 22H6.5C5.7 22 5 21.3 5 20.5V3.5Z" fill="#94a3b8" />
          <path d="M14.5 2V6.5H19" fill="#64748b" />
          <line x1="8.5" y1="11" x2="15.5" y2="11" stroke="white" strokeWidth="1.3" strokeLinecap="round" />
          <line x1="8.5" y1="14" x2="15.5" y2="14" stroke="white" strokeWidth="1.3" strokeLinecap="round" />
          <line x1="8.5" y1="17" x2="13" y2="17" stroke="white" strokeWidth="1.3" strokeLinecap="round" />
        </svg>
      )
    default:
      // Default file icon
      return (
        <svg viewBox="0 0 24 24" className={className} width="15" height="15" fill="none" style={{ flexShrink: 0 }}>
          <path d="M5 3.5C5 2.7 5.7 2 6.5 2H14.5L19 6.5V20.5C19 21.3 18.3 22 17.5 22H6.5C5.7 22 5 21.3 5 20.5V3.5Z" fill="#64748b" />
          <path d="M14.5 2V6.5H19" fill="#475569" />
          <line x1="8.5" y1="12" x2="15.5" y2="12" stroke="white" strokeWidth="1.2" strokeLinecap="round" />
          <line x1="8.5" y1="15.5" x2="13.5" y2="15.5" stroke="white" strokeWidth="1.2" strokeLinecap="round" />
        </svg>
      )
  }
}

/** Unified Entry Icon (Folder or File) */
export const MaterialEntryIcon: React.FC<{
  name: string
  isDir: boolean
  isOpen?: boolean
  className?: string
}> = ({ name, isDir, isOpen = false, className }) => {
  if (isDir) {
    return <MaterialFolderIcon name={name} isOpen={isOpen} className={className} />
  }
  return <MaterialFileIcon name={name} className={className} />
}
