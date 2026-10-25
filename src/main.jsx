import { Component, StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'

class AppErrorBoundary extends Component {
  state = { error: null, componentStack: '' }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, info) {
    console.error('React render error:', error, info.componentStack)
    this.setState({ componentStack: info.componentStack || '' })
  }

  render() {
    const { error, componentStack } = this.state
    if (error) {
      const details = [
        `${error.name || 'Error'}: ${error.message || String(error)}`,
        error.stack,
        componentStack && `React component stack:\n${componentStack}`,
      ].filter(Boolean).join('\n\n')

      return (
        <main role="alert" className="react-render-error">
          <h1>React render error</h1>
          <pre>{details}</pre>
        </main>
      )
    }

    return this.props.children
  }
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </StrictMode>,
)
