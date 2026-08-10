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

class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { hasError: boolean; error: Error | null }> {
  constructor(props: { children: React.ReactNode }) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('React ErrorBoundary caught an error:', error, errorInfo)
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: 32, background: '#0b0c0e', color: '#f87171', fontFamily: 'monospace' }}>
          <h2>Interface Error Caught</h2>
          <pre style={{ whiteSpace: 'pre-wrap', color: '#e2e8f0' }}>{this.state.error?.stack || this.state.error?.message}</pre>
          <button
            onClick={() => window.location.reload()}
            style={{ marginTop: 16, padding: '8px 16px', background: '#3b82f6', color: '#fff', border: 0, borderRadius: 4, cursor: 'pointer' }}
          >
            Reload App
          </button>
        </div>
      )
    }
    return this.props.children
  }
}

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
)
