import React, { useEffect } from 'react'
import { useWorkspaceStore } from './store/workspaceStore'
import { TopBar } from './components/Navigation/TopBar'
import { Sidebar } from './components/Navigation/Sidebar'
import { CanvasArea } from './components/Canvas/CanvasArea'
import { HomeScreen } from './components/Screens/HomeScreen'
import { EnvironmentsScreen } from './components/Screens/EnvironmentsScreen'
import { RecruitAgentModal } from './components/Modals/RecruitAgentModal'
import { FilesDirectoryModal } from './components/Modals/FilesDirectoryModal'
import { FloorModal } from './components/Modals/FloorModal'
import { CommandPalette } from './components/Modals/CommandPalette'

export const App: React.FC = () => {
  const {
    currentScreen,
    setWorkspaces,
    setActiveWorkspace,
    setFloors,
    setActiveFloor,
    setDaemonError,
    daemonError,
    isCommandPaletteOpen,
    isRecruitModalOpen,
    isFilesModalOpen,
    isFloorModalOpen
  } = useWorkspaceStore()

  // Native browser portals sit above the renderer DOM. Keep them painted for
  // the canvas, but never let them cover a modal or another full-screen app
  // surface. The main process tracks this as a reason set, so modal changes
  // cannot accidentally re-show a portal while another reason is active.
  useEffect(() => {
    const portal = window.orchestra?.portal
    if (!portal?.suppress) return
    const modalOpen = isCommandPaletteOpen || isRecruitModalOpen || isFilesModalOpen || isFloorModalOpen
    void portal.suppress('modal', modalOpen).catch(() => undefined)
  }, [isCommandPaletteOpen, isFilesModalOpen, isFloorModalOpen, isRecruitModalOpen])

  useEffect(() => {
    const portal = window.orchestra?.portal
    if (!portal?.suppress) return
    void portal.suppress('screen', currentScreen !== 'canvas').catch(() => undefined)
  }, [currentScreen])

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const workspaces = await window.orchestra?.invoke('workspace.list') as Array<{ id: string; name: string; path: string }>
        if (cancelled || !Array.isArray(workspaces)) return
        setWorkspaces(workspaces)
        const activate = async (workspace: { id: string; name: string; path: string }) => {
          setActiveWorkspace(workspace)
          const storedFloors = await window.orchestra?.invoke('workspace.floor.list', { workspaceId: workspace.id }) as Array<{ id: string; name: string; branch: string; path: string; isLanding?: boolean }>
          if (Array.isArray(storedFloors) && storedFloors.length > 0) {
            setFloors(storedFloors)
            setActiveFloor(storedFloors[0])
          } else {
            const landing = { id: `floor_${workspace.id}`, workspaceId: workspace.id, name: 'Main', branch: 'HEAD', path: workspace.path, isLanding: true }
            await window.orchestra?.invoke('workspace.floor.save', { workspaceId: workspace.id, floor: landing })
            setFloors([landing])
            setActiveFloor(landing)
          }
        }
        if (workspaces[0]) {
          await activate(workspaces[0])
        } else {
          const defaultPath = await window.orchestra?.invoke('workspace.default-path') as string
          if (!cancelled && typeof defaultPath === 'string' && defaultPath) {
            const id = `ws_${crypto.randomUUID()}`
            const workspace = { id, name: defaultPath.split('/').filter(Boolean).pop() || 'Workspace', path: defaultPath }
            await window.orchestra?.invoke('workspace.save', workspace)
            if (!cancelled) {
              setWorkspaces([workspace])
              await activate(workspace)
            }
          }
        }
        setDaemonError(null)
      } catch (error) {
        if (!cancelled) setDaemonError(error instanceof Error ? error.message : 'Core indisponível')
      }
    }
    load()
    return () => { cancelled = true }
  }, [setActiveFloor, setActiveWorkspace, setDaemonError, setFloors, setWorkspaces])

  return (
    <div className="app">
      <TopBar />
      <Sidebar />

      <main style={{ position: 'relative' }}>
        {currentScreen === 'canvas' && <CanvasArea />}
        {currentScreen === 'home' && <HomeScreen />}
        {currentScreen === 'environments' && <EnvironmentsScreen />}

        {daemonError && (
          <div className="daemon-error-banner" role="alert">
            Core indisponível: {daemonError}
          </div>
        )}

      </main>

      {/* Global Modals */}
      <RecruitAgentModal />
      <FilesDirectoryModal />
      <FloorModal />
      <CommandPalette />
    </div>
  )
}
