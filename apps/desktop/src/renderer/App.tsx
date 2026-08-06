import React from 'react'
import { useWorkspaceStore } from './store/workspaceStore'
import { TopBar } from './components/Navigation/TopBar'
import { Sidebar } from './components/Navigation/Sidebar'
import { CanvasArea } from './components/Canvas/CanvasArea'
import { HomeScreen } from './components/Screens/HomeScreen'
import { RoutinesScreen } from './components/Screens/RoutinesScreen'
import { EnvironmentsScreen } from './components/Screens/EnvironmentsScreen'
import { SettingsScreen } from './components/Screens/SettingsScreen'
import { InspectorPanel } from './components/Inspector/InspectorPanel'
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
        {currentScreen === 'routines' && <RoutinesScreen />}
        {currentScreen === 'environments' && <EnvironmentsScreen />}
        {currentScreen === 'settings' && <SettingsScreen />}

        {/* Floating Context Composer & Inspector on Canvas Screen */}
        {currentScreen === 'canvas' && <PromptComposer />}
        <InspectorPanel />
      </main>

      {/* Global Modals */}
      <RecruitAgentModal />
      <FloorModal />
      <CommandPalette />
    </div>
  )
}
