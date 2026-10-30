import { useEffect, useMemo, useRef, useState } from 'react'
import { describePdfError, inspectPdfDialogueMatch, loadPdfJsRuntime, normalizePdfMatchText, readBlobAsArrayBuffer } from './pdfFollow.js'

function buildPdfIndex(pageRecords) {
  const words = []
  const indexedRows = []
  let rowId = 0
  for (const page of pageRecords) {
    const pageRows = new Map()
    for (const item of page.items) {
      const y = Math.round(item.y / 3) * 3
      const row = pageRows.get(y) ?? []
      row.push({ ...item, fontHeight: Math.max(1, item.fontHeight ?? 0) })
      pageRows.set(y, row)
    }
    for (const [y, row] of [...pageRows.entries()].sort((first, second) => second[0] - first[0])) {
      const text = row.sort((first, second) => first.x - second.x).map((item) => item.text).join(' ')
      const baselineFromTop = page.height - y
      const lineHeight = Math.max(...row.map((item) => item.fontHeight), 1)
      indexedRows.push({ rowId, page: page.page, y: baselineFromTop, pageHeight: page.height, text })
      normalizePdfMatchText(text).forEach((word) => words.push({
        word,
        page: page.page,
        y: baselineFromTop,
        rowId,
        lineTop: Math.max(0, baselineFromTop - lineHeight),
        lineBottom: baselineFromTop,
        pageHeight: page.height,
      }))
      rowId += 1
    }
  }
  const startsByWord = new Map()
  words.forEach((entry, start) => {
    const starts = startsByWord.get(entry.word) ?? []
    starts.push(start)
    startsByWord.set(entry.word, starts)
  })
  return { words, startsByWord, rows: indexedRows }
}

export default function PdfFollowViewer({ file, fileId, fileName, pdfLibrary = [], characterNames = [], sessionId, syncResetKey, activePrompt, rehearsalIndex, rehearsalStatus, rehearsalSpeaker, remainingSeconds, onRun, onPdfSelected, onSelectPdf, onBack, rehearsalActive }) {
  const scrollRef = useRef(null)
  const pageRefs = useRef([])
  const canvasRefs = useRef([])
  const [pdf, setPdf] = useState(null)
  const [pageRecords, setPageRecords] = useState([])
  const [loadError, setLoadError] = useState('')
  const [status, setStatus] = useState('Loading PDF…')
  const [viewerWidth, setViewerWidth] = useState(800)
  const [renderVersion, setRenderVersion] = useState(0)
  const [anchor, setAnchor] = useState(null)
  const [centerPrompt, setCenterPrompt] = useState(false)
  const [pdfDragActive, setPdfDragActive] = useState(false)
  const [matchTrace, setMatchTrace] = useState(null)
  const anchorRef = useRef(null)
  const lastPromptRef = useRef({ id: null, index: null })
  const lastSessionRef = useRef(sessionId)
  const lastSyncResetKeyRef = useRef(syncResetKey)

  useEffect(() => {
    if (!file) {
      setStatus('')
      setPdf(null)
      setPageRecords([])
      return undefined
    }
    let cancelled = false
    let loadedPdf
    let loadingTask
    setPdf(null)
    setPageRecords([])
    setLoadError('')
    setAnchor(null)
    setMatchTrace(null)
    anchorRef.current = null
    lastPromptRef.current = { id: null, index: null }
    setStatus('Loading PDF…')
    loadPdfJsRuntime().then(async (pdfjs) => {
      const data = await readBlobAsArrayBuffer(file)
      if (cancelled) return
      loadingTask = pdfjs.getDocument({ data })
      loadedPdf = await loadingTask.promise
      const records = []
      for (let pageNumber = 1; pageNumber <= loadedPdf.numPages; pageNumber += 1) {
        if (cancelled) return
        const page = await loadedPdf.getPage(pageNumber)
        const viewport = page.getViewport({ scale: 1 })
        const content = await page.getTextContent()
        const items = content.items
          .filter((item) => typeof item.str === 'string' && item.str.trim())
          .map((item) => ({
            text: item.str,
            x: item.transform[4],
            y: item.transform[5],
            fontHeight: item.height ?? Math.hypot(item.transform[2], item.transform[3]),
          }))
        records.push({ page: pageNumber, width: viewport.width, height: viewport.height, items })
        page.cleanup?.()
      }
      if (cancelled) return
      setPdf(loadedPdf)
      setPageRecords(records)
      setStatus(records.some((page) => page.items.length) ? '' : 'This PDF has no selectable text. Scroll manually; automatic follow is unavailable.')
    }).catch((error) => {
      if (!cancelled) {
        console.error('[PDF loading failure]', error)
        setLoadError(describePdfError(error))
        setStatus('')
      }
    })
    return () => {
      cancelled = true
      if (typeof loadingTask?.destroy === 'function') {
        Promise.resolve(loadingTask.destroy()).catch(() => {})
      } else if (typeof loadedPdf?.cleanup === 'function') {
        Promise.resolve(loadedPdf.cleanup()).catch(() => {})
      }
    }
  }, [file])

  useEffect(() => {
    if (lastSessionRef.current === sessionId && lastSyncResetKeyRef.current === syncResetKey) return
    lastSessionRef.current = sessionId
    lastSyncResetKeyRef.current = syncResetKey
    lastPromptRef.current = { id: null, index: null }
    anchorRef.current = null
    setAnchor(null)
    setMatchTrace(null)
    setStatus('')
  }, [sessionId, syncResetKey])

  useEffect(() => {
    const element = scrollRef.current
    if (!element) return undefined
    const onResize = () => setViewerWidth(Math.max(280, element.clientWidth - 24))
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(onResize) : null
    observer?.observe(element)
    if (!observer) window.addEventListener('resize', onResize)
    onResize()
    return () => {
      observer?.disconnect()
      if (!observer) window.removeEventListener('resize', onResize)
    }
  }, [])

  const index = useMemo(() => buildPdfIndex(pageRecords), [pageRecords])

  useEffect(() => {
    if (!pdf || !pageRecords.length || !viewerWidth) return undefined
    let cancelled = false
    const tasks = new Map()
    const renderingPages = new Set()
    const renderedCanvases = new Set()
    const visiblePages = new Set()
    const mobileViewport = window.matchMedia?.('(max-width: 700px)').matches ?? false
    const maxCanvasPixels = mobileViewport ? 1_500_000 : 4_000_000
    const renderPages = async () => {
      const renderPage = async (record) => {
        if (cancelled) return
        const canvas = canvasRefs.current[record.page - 1]
        if (!canvas || tasks.has(record.page) || renderingPages.has(record.page)) return
        renderingPages.add(record.page)
        const displayWidth = Math.min(viewerWidth, 800)
        const scale = displayWidth / record.width
        const viewport = { width: record.width * scale, height: record.height * scale }
        const outputScale = Math.min(window.devicePixelRatio || 1, mobileViewport ? 1.5 : 2, Math.sqrt(maxCanvasPixels / Math.max(1, viewport.width * viewport.height)))
        canvas.width = Math.max(1, Math.floor(viewport.width * outputScale))
        canvas.height = Math.max(1, Math.floor(viewport.height * outputScale))
        canvas.style.width = `${viewport.width}px`
        canvas.style.height = `${viewport.height}px`
        let page
        try {
          page = await pdf.getPage(record.page)
          if (cancelled || !visiblePages.has(record.page)) return
          const pageViewport = page.getViewport({ scale })
          const context = canvas.getContext('2d', { alpha: false })
          if (!context) throw new Error('This browser could not allocate a canvas for a PDF page. Try a smaller PDF or close other tabs.')
          const task = page.render({ canvasContext: context, viewport: pageViewport, transform: outputScale === 1 ? null : [outputScale, 0, 0, outputScale, 0, 0] })
          tasks.set(record.page, task)
          await task.promise
          if (!cancelled && visiblePages.has(record.page)) renderedCanvases.add(record.page)
        } catch (error) {
          if (error?.name !== 'RenderingCancelledException' && !cancelled) {
            console.error(`[PDF page ${record.page} render failure]`, error)
            setLoadError(`Page ${record.page}: ${describePdfError(error)}`)
          }
        } finally {
          page?.cleanup?.()
          renderingPages.delete(record.page)
          tasks.delete(record.page)
        }
      }
      const clearPage = (record) => {
        visiblePages.delete(record.page)
        tasks.get(record.page)?.cancel()
        renderedCanvases.delete(record.page)
        const canvas = canvasRefs.current[record.page - 1]
        if (canvas) {
          canvas.width = 0
          canvas.height = 0
        }
      }
      const observer = typeof IntersectionObserver === 'function'
        ? new IntersectionObserver((entries) => {
          for (const entry of entries) {
            const record = pageRecords[Number(entry.target.dataset.pageIndex)]
            if (!record) continue
            if (entry.isIntersecting) {
              visiblePages.add(record.page)
              renderPage(record)
            }
            else clearPage(record)
          }
        }, { root: scrollRef.current, rootMargin: '120% 0px' })
        : null
      if (observer && scrollRef.current) {
        pageRefs.current.forEach((element) => element && observer.observe(element))
      } else {
        for (const record of pageRecords) visiblePages.add(record.page)
        for (const record of pageRecords) await renderPage(record)
      }
      if (!cancelled) setRenderVersion((current) => current + 1)
      return observer
    }
    let observer
    renderPages().then((value) => { observer = value })
    return () => {
      cancelled = true
      observer?.disconnect()
      tasks.forEach((task) => task.cancel())
    }
  }, [pdf, pageRecords, viewerWidth])

  useEffect(() => {
    if (!activePrompt?.transcript) return
    const currentId = activePrompt.id
    const prior = lastPromptRef.current
    if (prior.id === currentId && prior.index === rehearsalIndex) return
    const direction = prior.index === null || rehearsalIndex >= prior.index ? 1 : -1
    lastPromptRef.current = { id: currentId, index: rehearsalIndex }
    const { match, diagnostics } = inspectPdfDialogueMatch(activePrompt.transcript, index, anchorRef.current, direction, {
      characterName: activePrompt.character,
      characterNames,
    })
    const traceEntry = {
      time: new Date().toISOString(),
      promptId: activePrompt.id,
      prompt: `${rehearsalIndex + 1}`,
      transcript: activePrompt.transcript.slice(0, 180),
      character: activePrompt.character ?? null,
      result: diagnostics.reason,
      ...diagnostics,
    }
    const trace = window.__pdfFollowTrace ??= []
    trace.push(traceEntry)
    if (trace.length > 30) trace.shift()
    console.info('[PDF follow trace]', traceEntry)
    setMatchTrace(traceEntry)
    if (!match) {
      const failureMessage = diagnostics.reason === 'no-selectable-text'
        ? 'This PDF has no selectable text. Scroll manually and use Start Here or Resync Here.'
        : diagnostics.reason === 'short-match-not-near-anchor'
          ? 'This exact short line is outside the next one or two rows from the confirmed line. Scroll to it and use Resync Here.'
          : diagnostics.reason === 'short-ambiguous-in-document'
            ? 'This short line appears more than once. Scroll to the correct occurrence and use Resync Here.'
            : diagnostics.reason === 'short-no-exact-match'
              ? 'This short line was not found exactly in the PDF. Scroll to it and use Resync Here.'
              : diagnostics.reason === 'short-character-cue-text-mismatch'
                ? `Found the next ${diagnostics.character} cue, but the short prompt text did not match inside that character's dialogue block. Scroll to it and use Resync Here.`
          : diagnostics.reason === 'ambiguous-match'
            ? 'This line has multiple plausible matches. Scroll to the right one and use Resync Here.'
            : 'Could not confidently locate this line. Scroll to it and choose Resync Here.'
      setStatus(failureMessage)
      return
    }
    anchorRef.current = match
    setAnchor(match)
    setStatus('')
  }, [activePrompt?.id, activePrompt?.transcript, activePrompt?.character, rehearsalIndex, index, characterNames])

  useEffect(() => {
    if (!anchor) return
    const match = anchor
    const page = pageRecords[match.page - 1]
    const endPage = pageRecords[(match.endPage ?? match.page) - 1]
    const pageElement = pageRefs.current[match.page - 1]
    const endPageElement = pageRefs.current[(match.endPage ?? match.page) - 1]
    const viewportScale = viewerWidth / (page?.width ?? viewerWidth)
    const endViewportScale = viewerWidth / (endPage?.width ?? viewerWidth)
    if (!pageElement || !endPageElement || !scrollRef.current) return
    const scroll = scrollRef.current
    const pageTop = pageElement.getBoundingClientRect().top - scroll.getBoundingClientRect().top + scroll.scrollTop
    const endPageTop = endPageElement.getBoundingClientRect().top - scroll.getBoundingClientRect().top + scroll.scrollTop
    const lineTop = pageTop + (match.lineTop ?? match.y) * viewportScale
    const lineBottom = endPageTop + (match.endLineBottom ?? match.endY ?? match.y) * endViewportScale
    if (centerPrompt) {
      const promptMiddle = (lineTop + lineBottom) / 2
      const centeredTop = Math.max(0, promptMiddle - scroll.clientHeight / 2)
      if (Math.abs(centeredTop - scroll.scrollTop) > 24) scroll.scrollTo({ top: centeredTop, behavior: 'smooth' })
    } else {
      const top = pageTop + Math.max(0, match.y * viewportScale - 90)
      if (top < scroll.scrollTop + 20 || top > scroll.scrollTop + scroll.clientHeight - 150) {
        scroll.scrollTo({ top, behavior: 'smooth' })
      }
    }
  }, [anchor, pageRecords, viewerWidth, renderVersion, centerPrompt])

  function captureCurrentPosition() {
    const container = scrollRef.current
    if (!container || pageRecords.length === 0) return
    const containerRect = container.getBoundingClientRect()
    const pageIndex = pageRefs.current.findIndex((element) => element && element.getBoundingClientRect().bottom > containerRect.top + 16)
    const safePageIndex = Math.max(0, pageIndex)
    const pageElement = pageRefs.current[safePageIndex]
    const record = pageRecords[safePageIndex]
    if (!pageElement || !record) return
    const fraction = Math.min(1, Math.max(0, (containerRect.top + 16 - pageElement.getBoundingClientRect().top) / pageElement.clientHeight))
    const y = record.height * fraction
    const nearestRow = index.rows?.filter((row) => row.page === record.page).reduce((nearest, row) => (
      !nearest || Math.abs(row.y - y) < Math.abs(nearest.y - y) ? row : nearest
    ), null)
    const nextAnchor = {
      page: record.page,
      y,
      pageHeight: record.height,
      ...(nearestRow ? { rowId: nearestRow.rowId, startRowId: nearestRow.rowId, endRowId: nearestRow.rowId } : {}),
    }
    anchorRef.current = nextAnchor
    setAnchor(nextAnchor)
    if (activePrompt) lastPromptRef.current = { id: activePrompt.id, index: rehearsalIndex }
    setStatus(activePrompt ? 'PDF position linked to the current prompt.' : 'PDF position saved. Start rehearsal to begin following.')
  }

  return (
    <section
      className={`pdf-follow-view${pdfDragActive ? ' is-pdf-dragging' : ''}`}
      aria-label="PDF Run With Me viewer"
      onDragOver={(event) => {
        if (event.dataTransfer?.files?.length) {
          event.preventDefault()
          setPdfDragActive(true)
        }
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setPdfDragActive(false)
      }}
      onDrop={(event) => {
        event.preventDefault()
        setPdfDragActive(false)
        const files = event.dataTransfer?.files
        let dropped = null
        for (let index = 0; files && index < files.length; index += 1) {
          const candidate = files[index]
          if (candidate.type === 'application/pdf' || candidate.name.toLowerCase().endsWith('.pdf')) {
            dropped = candidate
            break
          }
        }
        if (dropped) onPdfSelected?.(dropped)
        else setLoadError('Drop a PDF file to load audition sides.')
      }}
    >
      <div className="pdf-follow-toolbar">
        <div className="pdf-follow-toolbar-copy">
          <strong>{fileName || 'Audition sides'}</strong>
          <span>{pageRecords.length ? `${pageRecords.length} pages` : 'Preparing reader'}</span>
        </div>
        <div className="pdf-follow-actions">
          {!rehearsalActive && <button className="quiet-button pdf-back-button" type="button" onClick={onBack}>Run With Me</button>}
          {rehearsalActive && <button className="quiet-button pdf-resync-button" type="button" onClick={captureCurrentPosition}>{anchor ? 'Resync Here' : 'Start Here'}</button>}
          {rehearsalActive && <button className={`quiet-button pdf-center-button${centerPrompt ? ' is-active' : ''}`} type="button" onClick={() => setCenterPrompt((current) => !current)} disabled={!anchor} aria-pressed={centerPrompt} aria-label={centerPrompt ? 'Turn off prompt centering' : 'Center current and following prompts'} title={centerPrompt ? 'Prompt centering on' : 'Center current and following prompts'}><svg viewBox="0 0 18 18" aria-hidden="true"><circle cx="9" cy="9" r="5.5" /><path d="M9 1v3M9 14v3M1 9h3m10 0h3" /></svg><span>{centerPrompt ? 'Centered' : 'Center prompt'}</span></button>}
          {pdfLibrary.length > 0 && <select className="pdf-follow-library-select" aria-label="Choose a PDF from your library" value={fileId ?? ''} onChange={(event) => event.target.value && onSelectPdf?.(event.target.value)}><option value="" disabled>Choose PDF</option>{pdfLibrary.map((pdf) => <option value={pdf.id} key={pdf.id}>{pdf.name}</option>)}</select>}
          {file && <label className="quiet-button pdf-replace-button">Replace PDF<input type="file" accept="application/pdf,.pdf" onChange={(event) => { const selected = event.target.files?.[0]; if (selected) onPdfSelected?.(selected); event.target.value = '' }} /></label>}
          {!rehearsalActive && <button className="run-with-me-button" type="button" onClick={onRun} disabled={!pdf || Boolean(loadError)}>▶ Run</button>}
        </div>
      </div>
      {status && <p className="pdf-follow-status" role="status">{status}</p>}
      {matchTrace && <details className="pdf-match-diagnostics">
        <summary>PDF match trace <span>{matchTrace.result.replaceAll('-', ' ')}</span></summary>
        <div className="pdf-match-diagnostics-content">
          <dl>
            <div><dt>Prompt</dt><dd>{matchTrace.prompt} · {matchTrace.transcriptWordCount} words</dd></div>
            {matchTrace.character && <div><dt>Assigned character</dt><dd>{matchTrace.character}</dd></div>}
            <div><dt>PDF text</dt><dd>{matchTrace.pdfWordCount} selectable words</dd></div>
            <div><dt>Reason</dt><dd>{matchTrace.result.replaceAll('-', ' ')}</dd></div>
            {matchTrace.threshold !== undefined && <div><dt>Required match</dt><dd>{Math.round(matchTrace.threshold * 100)}%</dd></div>}
            {matchTrace.searchedRows && <div><dt>Short-line search</dt><dd>{matchTrace.direction ?? 'either direction'} · rows {matchTrace.searchedRows.join(' and ')}</dd></div>}
            {matchTrace.confidence !== undefined && <div><dt>Match confidence</dt><dd>{Math.round(matchTrace.confidence * 100)}%</dd></div>}
            {matchTrace.bestConfidence !== null && matchTrace.bestConfidence !== undefined && <div><dt>Best candidate</dt><dd>{Math.round(matchTrace.bestConfidence * 100)}% · page {matchTrace.candidatePage ?? 'unknown'}</dd></div>}
            {matchTrace.exactOccurrences !== undefined && <div><dt>Exact occurrences</dt><dd>{matchTrace.exactOccurrences}</dd></div>}
            {matchTrace.characterCueCount !== undefined && <div><dt>Character cues ahead</dt><dd>{matchTrace.characterCueCount}</dd></div>}
            {matchTrace.characterBlockOccurrences !== undefined && <div><dt>Matches in character block</dt><dd>{matchTrace.characterBlockOccurrences}</dd></div>}
            {matchTrace.candidatePreview && <div className="pdf-match-candidate"><dt>Closest PDF text</dt><dd>{matchTrace.candidatePreview}</dd></div>}
          </dl>
          <p>Recent attempts are also available in the browser console as <code>window.__pdfFollowTrace</code>.</p>
          <ol className="pdf-match-trace-recent" aria-label="Recent matching attempts">
            {(window.__pdfFollowTrace ?? []).slice(-5).reverse().map((attempt, attemptIndex) => (
              <li key={`${attempt.time}-${attemptIndex}`}><span>Prompt {attempt.prompt}</span><strong>{attempt.result.replaceAll('-', ' ')}</strong>{attempt.bestConfidence !== null && attempt.bestConfidence !== undefined && <em>{Math.round(attempt.bestConfidence * 100)}%</em>}</li>
            ))}
          </ol>
        </div>
      </details>}
      {loadError && <p className="pdf-follow-error" role="alert">{loadError}</p>}
      <div className="pdf-follow-pages" ref={scrollRef}>
        {!file && <div className="pdf-follow-empty"><span aria-hidden="true">▤</span><strong>Choose audition sides</strong><p>Select a PDF above or add one from your device.</p><label className="quiet-button pdf-select-button">Add PDF from device<input type="file" accept="application/pdf,.pdf" onChange={(event) => { const selected = event.target.files?.[0]; if (selected) onPdfSelected?.(selected); event.target.value = '' }} /></label><p className="pdf-library-hint">Manage your saved PDFs from the home screen.</p></div>}
        {file && !pageRecords.length && !loadError && <div className="pdf-follow-loading">Loading script pages…</div>}
        {pageRecords.map((page, index) => (
          <div className="pdf-follow-page" key={`${page.page}-${fileName}`} data-page-index={index} style={{ width: `${Math.min(viewerWidth, 800)}px`, height: `${Math.min(viewerWidth, 800) * page.height / page.width}px` }} ref={(element) => { pageRefs.current[index] = element }}>
            <canvas ref={(element) => { canvasRefs.current[index] = element }} aria-label={`Script page ${page.page}`} />
            <span className="pdf-follow-page-number">{page.page}</span>
          </div>
        ))}
      </div>
      {rehearsalActive && rehearsalStatus && <div className="pdf-follow-live-status" aria-live="polite"><span>{rehearsalStatus}</span>{rehearsalSpeaker === 'Reader' && Number.isFinite(remainingSeconds) && <strong>RECORDING TIME&nbsp; {Math.floor(remainingSeconds / 60).toString().padStart(2, '0')}:{Math.ceil(remainingSeconds % 60).toString().padStart(2, '0')}</strong>}</div>}
    </section>
  )
}
