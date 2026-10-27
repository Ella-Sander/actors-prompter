import { Component, StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'

window.__promptBrowserCapabilities = {
  secureContext: window.isSecureContext,
  mediaDevices: Boolean(navigator.mediaDevices),
  getUserMedia: Boolean(navigator.mediaDevices?.getUserMedia),
  mediaRecorder: typeof window.MediaRecorder === 'function',
  speechRecognition: Boolean(window.SpeechRecognition || window.webkitSpeechRecognition),
  audioWorkletNode: typeof window.AudioWorkletNode === 'function',
  crossOriginIsolated: Boolean(window.crossOriginIsolated),
  sharedArrayBuffer: typeof window.SharedArrayBuffer === 'function',
}

function reportGlobalFailure(kind, details) {
  const entry = {
    time: new Date().toISOString(),
    kind,
    ...details,
    active: {
      rehearsal: window.__promptRehearsalRuntime ?? null,
      playback: window.__promptAudioRuntime ?? null,
      recording: window.__promptRecordingRuntime ?? null,
      tts: window.__promptLibraryTtsStatus ?? null,
      browserCapabilities: window.__promptBrowserCapabilities ?? null,
      recordingTrace: (window.__promptRecordingTrace ?? []).slice(-5),
      audioTrace: (window.__promptAudioTrace ?? []).slice(-8),
      ttsTrace: (window.__promptLibraryTtsTrace ?? []).slice(-5),
    },
  }
  const trace = window.__promptGlobalErrorTrace ??= []
  trace.push(entry)
  if (trace.length > 30) trace.shift()
  console.error('[Actors Prompter global failure]', entry)
}

window.addEventListener('error', (event) => {
  reportGlobalFailure('window-error', {
    message: event.message || 'Script error.',
    filename: event.filename || null,
    lineno: event.lineno || null,
    colno: event.colno || null,
    stack: event.error?.stack || null,
  })
})

window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason
  reportGlobalFailure('unhandled-rejection', {
    message: reason instanceof Error ? reason.message : String(reason ?? 'Unknown rejection'),
    name: reason instanceof Error ? reason.name : null,
    stack: reason instanceof Error ? reason.stack || null : null,
  })
})

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
