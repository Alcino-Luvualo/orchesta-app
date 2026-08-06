import React from 'react'
import { useWorkspaceStore } from './store/workspaceStore'
import { TopBar } from './components/Navigation/TopBar'
import { Sidebar } from './components/Navigation/Sidebar'
import { CanvasArea } from './components/Canvas/CanvasArea'
import { HomeScreen } from './components/Screens/HomeScreen'
import { EnvironmentsScreen } from './components/Screens/EnvironmentsScreen'
import { SettingsScreen } from './components/Screens/SettingsScreen'
import { PromptComposer } from './components/Composer/PromptComposer'
import { RecruitAgentModal } from './components/Modals/RecruitAgentModal'
import { FloorModal } from './components/Modals/FloorModal'
import { CommandPalette } from './components/Modals/CommandPalette'

export const App: React.FC = () => {
  const { currentScreen } = useWorkspaceStore()

  return (
    <div className="app">
      <TopBar />
      <Sidebar />

      <main style={{ position: 'relative' }}>
        {currentScreen === 'canvas' && <CanvasArea />}
        {currentScreen === 'home' && <HomeScreen />}
        {currentScreen === 'environments' && <EnvironmentsScreen />}
        {currentScreen === 'settings' && <SettingsScreen />}

        {/* The compact action strip above the canvas toolbar replaces a persistent inspector. */}
        {currentScreen === 'canvas' && <PromptComposer />}
      </main>

      {/* Global Modals */}
      <RecruitAgentModal />
      <FloorModal />
      <CommandPalette />
    </div>
  )
}
