(() => {
  let errorNumber = 0
  let overlayShown = false

  function recordRuntimeError(kind, details) {
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
      },
    }
    const trace = window.__promptGlobalErrorTrace ??= []
    trace.push(entry)
    if (trace.length > 30) trace.shift()
    console.error('[Actors Prompter global failure]', entry)
    return entry
  }

  function showError(title, details) {
    if (overlayShown) return
    overlayShown = true
    errorNumber += 1

    const ttsTrace = Array.isArray(window.__promptLibraryTtsTrace)
      ? window.__promptLibraryTtsTrace.slice(-24).map((entry) => {
          const { time, event, ...data } = entry
          return `${time} ${event}${Object.keys(data).length ? ` ${JSON.stringify(data)}` : ''}`
        }).join('\n')
      : ''
    const rehearsalTrace = Array.isArray(window.__promptRehearsalTrace)
      ? window.__promptRehearsalTrace.slice(-24).map((entry) => {
          const { time, event, ...data } = entry
          return `${time} ${event}${Object.keys(data).length ? ` ${JSON.stringify(data)}` : ''}`
        }).join('\n')
      : ''
    const rehearsalRuntime = window.__promptRehearsalRuntime
    const ttsStatus = window.__promptLibraryTtsStatus
    const recordingTrace = Array.isArray(window.__promptRecordingTrace)
      ? window.__promptRecordingTrace.slice(-24).map((entry) => {
          const { time, event, ...data } = entry
          return `${time} ${event}${Object.keys(data).length ? ` ${JSON.stringify(data)}` : ''}`
        }).join('\n')
      : ''
    const audioTrace = Array.isArray(window.__promptAudioTrace)
      ? window.__promptAudioTrace.slice(-16).map((entry) => {
          const { time, event, ...data } = entry
          return `${time} ${event}${Object.keys(data).length ? ` ${JSON.stringify(data)}` : ''}`
        }).join('\n')
      : ''
    const globalErrorTrace = Array.isArray(window.__promptGlobalErrorTrace)
      ? window.__promptGlobalErrorTrace.slice(-6).map((entry) => JSON.stringify(entry, null, 2)).join('\n\n')
      : ''

    const screen = document.createElement('main')
    screen.id = 'runtime-error-overlay'
    screen.className = 'runtime-error-overlay'
    screen.setAttribute('role', 'alert')

    const heading = document.createElement('h1')
    heading.textContent = `Application error #${errorNumber}`

    const message = document.createElement('p')
    message.textContent = title

    const output = document.createElement('pre')
    output.textContent = [
      details || 'No additional error details were provided by the browser.',
      ttsStatus && `\nTTS runtime status:\n${JSON.stringify(ttsStatus)}`,
      rehearsalRuntime && `\nRun With Me state:\n${JSON.stringify(rehearsalRuntime)}`,
      rehearsalTrace && `\nRecent Run With Me trace:\n${rehearsalTrace}`,
      recordingTrace && `\nRecent prompt recording trace:\n${recordingTrace}`,
      audioTrace && `\nRecent audio playback trace:\n${audioTrace}`,
      ttsTrace && `\nRecent TTS trace:\n${ttsTrace}`,
      globalErrorTrace && `\nGlobal error context:\n${globalErrorTrace}`,
    ].filter(Boolean).join('\n')

    screen.append(heading, message, output)
    document.body.replaceChildren(screen)
  }

  function describeError(error) {
    if (error instanceof Error) {
      const summary = `${error.name || 'Error'}: ${error.message || 'No error message provided.'}`
      return error.stack && !error.stack.includes(error.message)
        ? `${summary}\n${error.stack}`
        : error.stack || summary
    }
    if (typeof error === 'string') return error
    try {
      return JSON.stringify(error, null, 2) || String(error)
    } catch {
      return String(error)
    }
  }

  window.addEventListener('error', (event) => {
    if (event.target && event.target !== window) {
      const resource = event.target.src || event.target.href
      if (resource) {
        recordRuntimeError('resource-error', { resource, tagName: event.target.tagName || null })
        showError('A JavaScript or stylesheet resource failed to load.', resource)
      }
      return
    }

    const location = event.filename
      ? `${event.filename}${event.lineno ? `:${event.lineno}` : ''}${event.colno ? `:${event.colno}` : ''}`
      : ''
    const errorDetails = {
      message: event.message || 'Unknown window error',
      filename: event.filename || null,
      lineno: event.lineno || null,
      colno: event.colno || null,
      stack: event.error?.stack || null,
      hasException: Boolean(event.error),
    }
    recordRuntimeError('window-error', errorDetails)
    window.__promptLibraryTtsTrace ??= []
    window.__promptLibraryTtsTrace.push({ time: new Date().toISOString(), event: 'window-error', ...errorDetails })
    const isOpaqueScriptError = event.message === 'Script error.' && !event.filename && !event.error
    const details = isOpaqueScriptError
      ? [
          'The browser did not expose the script filename, line, or exception object, so this message cannot identify the failing code.',
          `Page: ${window.location.origin}`,
          'Check the Run With Me or TTS trace below to see which feature was active when this happened.',
        ].join('\n')
      : [location, describeError(event.error)].filter(Boolean).join('\n')
    showError(event.message || 'Uncaught JavaScript error.', details)
  }, true)

  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason
    const rejection = {
      message: reason instanceof Error ? reason.message : String(reason ?? 'Unknown rejection'),
      name: reason instanceof Error ? reason.name : null,
      stack: reason instanceof Error ? reason.stack || null : null,
      details: describeError(reason),
    }
    recordRuntimeError('unhandled-rejection', rejection)
    showError('Unhandled JavaScript promise rejection.', rejection.details)
  })

  window.addEventListener('securitypolicyviolation', (event) => {
    const details = [
      `Directive: ${event.effectiveDirective || 'unknown'}`,
      `Blocked: ${event.blockedURI || 'unknown'}`,
      event.sourceFile && `Source: ${event.sourceFile}${event.lineNumber ? `:${event.lineNumber}` : ''}`,
      event.sample && `Sample: ${event.sample}`,
    ].filter(Boolean).join('\n')
    window.__promptLibraryTtsTrace ??= []
    window.__promptLibraryTtsTrace.push({
      time: new Date().toISOString(),
      event: 'csp-violation',
      directive: event.effectiveDirective || 'unknown',
      blockedURI: event.blockedURI || 'unknown',
      sourceFile: event.sourceFile || null,
      lineNumber: event.lineNumber || null,
      ttsStatus: window.__promptLibraryTtsStatus ?? null,
    })
    recordRuntimeError('csp-violation', {
      directive: event.effectiveDirective || 'unknown',
      blockedURI: event.blockedURI || 'unknown',
      sourceFile: event.sourceFile || null,
      lineNumber: event.lineNumber || null,
      sample: event.sample || null,
    })
    showError('The browser blocked a resource or JavaScript operation under the site’s Content Security Policy.', details)
  })
})()
