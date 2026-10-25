(() => {
  let errorNumber = 0
  let overlayShown = false

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
      ttsTrace && `\nRecent TTS trace:\n${ttsTrace}`,
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
      if (resource) showError('A JavaScript or stylesheet resource failed to load.', resource)
      return
    }

    const location = event.filename
      ? `${event.filename}${event.lineno ? `:${event.lineno}` : ''}${event.colno ? `:${event.colno}` : ''}`
      : ''
    const isOpaqueScriptError = event.message === 'Script error.' && !event.filename && !event.error
    const details = isOpaqueScriptError
      ? [
          'The browser did not expose the script filename, line, or exception object, so this message cannot identify the failing code.',
          `Page: ${window.location.origin}`,
          'Check the recent TTS trace below if this happened during voice generation. A missing trace means the error occurred before TTS started.',
        ].join('\n')
      : [location, describeError(event.error)].filter(Boolean).join('\n')
    showError(event.message || 'Uncaught JavaScript error.', details)
  }, true)

  window.addEventListener('unhandledrejection', (event) => {
    showError('Unhandled JavaScript promise rejection.', describeError(event.reason))
  })

  window.addEventListener('securitypolicyviolation', (event) => {
    const details = [
      `Directive: ${event.effectiveDirective || 'unknown'}`,
      `Blocked: ${event.blockedURI || 'unknown'}`,
      event.sourceFile && `Source: ${event.sourceFile}${event.lineNumber ? `:${event.lineNumber}` : ''}`,
      event.sample && `Sample: ${event.sample}`,
    ].filter(Boolean).join('\n')
    showError('The browser blocked a resource or JavaScript operation under the site’s Content Security Policy.', details)
  })
})()
