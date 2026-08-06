import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './App'
import './index.css'

// Global keyboard shortcuts
document.addEventListener('keydown', (e) => {
  // F11 for fullscreen toggle
  if (e.key === 'F11') {
    e.preventDefault()
    ;(window as any).windowControls?.toggleFullscreen()
  }
})

// Global error boundary to prevent white screen on uncaught errors
window.addEventListener('error', (e) => {
  console.error('Unhandled error:', e.error)
})

window.addEventListener('unhandledrejection', (e) => {
  console.error('Unhandled promise rejection:', e.reason)
})

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
