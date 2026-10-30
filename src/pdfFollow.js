let pdfJsRuntimePromise

export function recordPdfDiagnostic(stage, status, details = {}) {
  if (typeof window === 'undefined') return
  const entries = window.__pdfInitializationTrace ??= []
  const entry = {
    time: new Date().toISOString(),
    stage,
    status,
    userAgent: window.navigator?.userAgent ?? 'unknown',
    ...details,
  }
  entries.push(entry)
  if (entries.length > 30) entries.shift()
  if (status === 'failed') console.error('[PDF initialization failure]', entry)
  else console.info('[PDF initialization]', entry)
  return entry
}

export function watchPdfWindowErrors(context, onError = () => {}) {
  if (typeof window === 'undefined') return () => {}
  const handleError = (event) => {
    const entry = recordPdfDiagnostic(`${context}: window error`, 'failed', {
      error: event.message || event.error?.message || 'Unspecified browser error',
      filename: event.filename || null,
      line: event.lineno || null,
      column: event.colno || null,
      stack: event.error?.stack,
    })
    onError(entry)
  }
  const handleRejection = (event) => {
    const reason = event.reason
    const entry = recordPdfDiagnostic(`${context}: unhandled promise rejection`, 'failed', {
      error: reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason ?? 'Unknown rejection'),
      stack: reason instanceof Error ? reason.stack : undefined,
    })
    onError(entry)
  }
  window.addEventListener('error', handleError, true)
  window.addEventListener('unhandledrejection', handleRejection)
  return () => {
    window.removeEventListener('error', handleError, true)
    window.removeEventListener('unhandledrejection', handleRejection)
  }
}

export function buildPdfDiagnosticReport(error, failureTrace = null) {
  if (typeof window === 'undefined') return String(error ?? 'No PDF error details are available.')
  const navigatorInfo = window.navigator ?? {}
  const entries = (window.__pdfInitializationTrace ?? []).slice(-20)
  const capabilities = {
    secureContext: window.isSecureContext ?? null,
    crossOriginIsolated: window.crossOriginIsolated ?? null,
    promiseWithResolvers: typeof Promise.withResolvers,
    worker: typeof window.Worker,
    readableStreamGetReader: typeof window.ReadableStream?.prototype?.getReader,
    readableStreamAsyncIterator: typeof window.ReadableStream?.prototype?.[Symbol.asyncIterator],
    blob: typeof window.Blob,
    fileReader: typeof window.FileReader,
    fileArrayBuffer: typeof window.File?.prototype?.arrayBuffer,
    canvas2d: (() => {
      try { return Boolean(document.createElement('canvas').getContext('2d')) } catch { return false }
    })(),
    intersectionObserver: typeof window.IntersectionObserver,
    resizeObserver: typeof window.ResizeObserver,
    devicePixelRatio: window.devicePixelRatio ?? null,
    deviceMemory: navigatorInfo.deviceMemory ?? null,
  }
  const traceText = entries.length
    ? entries.map((entry, index) => `${index + 1}. ${entry.time} [${entry.status}] ${entry.stage}\n${JSON.stringify(entry, null, 2)}`).join('\n\n')
    : 'No PDF initialization events were recorded.'
  return [
    'ACTORS PROMPTER — PDF DIAGNOSTIC REPORT',
    `Captured: ${new Date().toISOString()}`,
    `Page: ${window.location.href}`,
    `Browser: ${navigatorInfo.userAgent ?? 'unknown'}`,
    `Platform: ${navigatorInfo.platform ?? 'unknown'}`,
    `Language: ${navigatorInfo.language ?? 'unknown'}`,
    `Online: ${navigatorInfo.onLine ?? 'unknown'}`,
    `Error shown: ${error || 'none'}`,
    failureTrace ? `Failing stage: ${failureTrace.stage}` : '',
    'Browser/runtime capabilities:',
    JSON.stringify(capabilities, null, 2),
    'Most recent PDF trace:',
    traceText,
  ].filter(Boolean).join('\n\n')
}

export function normalizePdfMatchText(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .toLocaleLowerCase('en-US')
    .replace(/[\u2018\u2019\u02bc]/gu, "'")
    .replace(/[\u201c\u201d]/gu, '"')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(/\s+/u)
    .filter(Boolean)
}

export function loadPdfJsRuntime() {
  if (!pdfJsRuntimePromise) {
    let stage = 'load legacy PDF.js API'
    recordPdfDiagnostic('runtime', 'started', { promiseWithResolvers: typeof Promise.withResolvers })
    pdfJsRuntimePromise = (async () => {
      try {
        const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
        recordPdfDiagnostic(stage, 'ready', { pdfjsVersion: pdfjs.version })
        stage = 'load matching PDF.js worker URL'
        const worker = await import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url')
        pdfjs.GlobalWorkerOptions.workerSrc = worker.default
        recordPdfDiagnostic(stage, 'ready', { pdfjsVersion: pdfjs.version, workerUrl: worker.default })
        return pdfjs
      } catch (error) {
        recordPdfDiagnostic(stage, 'failed', {
          error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        })
        pdfJsRuntimePromise = undefined
        throw error
      }
    })()
    pdfJsRuntimePromise.catch(() => {
      pdfJsRuntimePromise = undefined
    })
  }
  return pdfJsRuntimePromise
}

// Avoid PDF.js getTextContent()'s `for await` over ReadableStream. Some
// WebKit versions expose ReadableStream but omit its async iterator.
export async function readPdfPageTextItems(page) {
  if (typeof page?.streamTextContent !== 'function') {
    throw new Error('This PDF.js page does not provide a text content stream.')
  }
  const stream = page.streamTextContent()
  if (typeof stream?.getReader !== 'function') {
    throw new Error('PDF.js did not provide a readable text content stream.')
  }
  const reader = stream.getReader()
  const items = []
  try {
    while (true) {
      const result = await reader.read()
      if (result.done) break
      const chunkItems = result.value?.items
      if (!Array.isArray(chunkItems)) {
        throw new Error('PDF.js returned a text chunk without an items array.')
      }
      items.push(...chunkItems)
    }
    return items
  } catch (error) {
    try { await reader.cancel(error) } catch { /* Preserve the original extraction error. */ }
    throw error
  } finally {
    try { reader.releaseLock() } catch { /* Some stream implementations release on close. */ }
  }
}

export function readBlobAsArrayBuffer(blob) {
  if (typeof blob?.arrayBuffer === 'function') return blob.arrayBuffer()
  if (typeof FileReader !== 'function') return Promise.reject(new Error('This browser cannot read the selected file.'))
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => reader.result instanceof ArrayBuffer ? resolve(reader.result) : reject(new Error('The selected file could not be read.'))
    reader.onerror = () => reject(reader.error ?? new Error('The selected file could not be read.'))
    reader.readAsArrayBuffer(blob)
  })
}

export function describePdfError(error) {
  const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error ?? '')
  if (/not a function|undefined is not|is not iterable/i.test(detail)) {
    return `PDF support could not initialize in this browser. Reload the app and make sure iOS is up to date. Details: ${detail}`
  }
  if (/worker/i.test(detail)) {
    return `The PDF rendering worker could not start. Reload the app and try again. Details: ${detail}`
  }
  return detail || 'This PDF could not be opened. Try exporting it again as a standard PDF.'
}

function editSimilarity(first, second) {
  if (!first.length || !second.length) return 0
  let previous = Array.from({ length: second.length + 1 }, (_, index) => index)
  for (let row = 1; row <= first.length; row += 1) {
    const current = [row]
    for (let column = 1; column <= second.length; column += 1) {
      current[column] = Math.min(
        current[column - 1] + 1,
        previous[column] + 1,
        previous[column - 1] + (first[row - 1] === second[column - 1] ? 0 : 1),
      )
    }
    previous = current
  }
  return 1 - previous[second.length] / Math.max(first.length, second.length)
}

function detectCharacterCue(rowText, characterNames) {
  const rowWords = normalizePdfMatchText(rowText)
  if (rowWords.length === 0) return null
  const isUppercaseCue = !/[a-z]/u.test(rowText)
  const allowedSuffixWords = new Set(['cont', 'd', 'v', 'o', 's', 'os', 'oc', 'continued', 'on', 'the', 'phone', 'into'])
  for (const characterName of characterNames) {
    const nameWords = normalizePdfMatchText(characterName)
    if (nameWords.length === 0 || rowWords.length < nameWords.length) continue
    if (!nameWords.every((word, index) => rowWords[index] === word)) continue
    const suffix = rowWords.slice(nameWords.length)
    if (suffix.length === 0 || (isUppercaseCue && suffix.length <= 3 && suffix.every((word) => allowedSuffixWords.has(word)))) return characterName
  }
  return null
}

export function inspectPdfDialogueMatch(transcript, index, anchor = null, direction = 1, characterContext = {}) {
  const expected = normalizePdfMatchText(transcript)
  const diagnosticBase = { transcriptWordCount: expected.length, pdfWordCount: index?.words?.length ?? 0 }
  if (!index?.words?.length) return { match: null, diagnostics: { ...diagnosticBase, reason: 'no-selectable-text' } }

  const candidates = []
  const startsByWord = index.startsByWord ?? index.words.reduce((map, entry, start) => {
    const starts = map.get(entry.word) ?? []
    starts.push(start)
    map.set(entry.word, starts)
    return map
  }, new Map())
  const exactStarts = startsByWord.get(expected[0]) ?? []
  for (const start of exactStarts) {
    if (expected.every((word, offset) => index.words[start + offset]?.word === word)) {
      const first = index.words[start]
      const last = index.words[start + expected.length - 1]
      candidates.push({ ...first, endPosition: last, similarity: 1 })
    }
  }

  if (expected.length < 5) {
    const exactMatches = candidates.map(({ similarity, endPosition, ...position }) => ({
      ...position,
      endPage: endPosition.page,
      endY: endPosition.y,
      endLineBottom: endPosition.lineBottom ?? endPosition.y,
      endRowId: endPosition.rowId ?? position.rowId,
      similarity,
    }))
    const targetCharacter = characterContext.characterName
    const characterNames = [...new Set([targetCharacter, ...(characterContext.characterNames ?? [])].filter(Boolean))]
      .sort((first, second) => normalizePdfMatchText(second).length - normalizePdfMatchText(first).length)
    if (targetCharacter && characterNames.length && index.rows?.length) {
      const cues = index.rows
        .map((row) => ({ ...row, characterName: detectCharacterCue(row.text, characterNames) }))
        .filter((row) => row.characterName)
        .sort((first, second) => first.rowId - second.rowId)
      const normalizedTarget = normalizePdfMatchText(targetCharacter).join(' ')
      const targetCues = cues.filter((row) => normalizePdfMatchText(row.characterName).join(' ') === normalizedTarget)
      const anchorStartRow = anchor?.startRowId ?? anchor?.rowId
      const anchorEndRow = anchor?.endRowId ?? anchor?.rowId
      const directionalCues = targetCues
        .filter((cue) => !Number.isInteger(anchorEndRow) || (direction < 0 ? cue.rowId < anchorStartRow : cue.rowId > anchorEndRow))
        .sort((first, second) => direction < 0 ? second.rowId - first.rowId : first.rowId - second.rowId)

      for (const cue of directionalCues) {
        const nextCue = cues.find((candidate) => candidate.rowId > cue.rowId)
        const blockEndRow = nextCue?.rowId ?? Number.POSITIVE_INFINITY
        const blockMatches = exactMatches
          .filter((match) => match.rowId > cue.rowId && match.rowId < blockEndRow)
          .sort((first, second) => direction < 0 ? second.rowId - first.rowId : first.rowId - second.rowId)
        if (blockMatches.length) {
          const match = blockMatches[0]
          return {
            match,
            diagnostics: {
              ...diagnosticBase,
              reason: 'short-character-cue-exact-match',
              character: targetCharacter,
              cuePage: cue.page,
              matchedPage: match.page,
              exactOccurrences: exactMatches.length,
              characterBlockOccurrences: blockMatches.length,
              confidence: 1,
            },
          }
        }
      }

      if (directionalCues.length) {
        return {
          match: null,
          diagnostics: {
            ...diagnosticBase,
            reason: 'short-character-cue-text-mismatch',
            character: targetCharacter,
            cuePage: directionalCues[0].page,
            characterCueCount: directionalCues.length,
            exactOccurrences: exactMatches.length,
          },
        }
      }
    }
    if (!anchor?.startRowId && !Number.isInteger(anchor?.rowId)) {
      if (exactMatches.length === 1) {
        return { match: exactMatches[0], diagnostics: { ...diagnosticBase, reason: 'short-unique-exact-match', exactOccurrences: 1, confidence: 1, matchedPage: exactMatches[0].page } }
      }
      return { match: null, diagnostics: { ...diagnosticBase, reason: exactMatches.length ? 'short-ambiguous-in-document' : 'short-no-exact-match', exactOccurrences: exactMatches.length, minimumWords: 5 } }
    }

    const anchorStartRow = anchor.startRowId ?? anchor.rowId
    const anchorEndRow = anchor.endRowId ?? anchor.rowId
    const nearbyMatches = exactMatches.map((match) => ({
      ...match,
      rowDistance: direction < 0 ? anchorStartRow - match.endRowId : match.rowId - anchorEndRow,
    })).filter((match) => match.rowDistance >= 1 && match.rowDistance <= 2)
    if (nearbyMatches.length) {
      nearbyMatches.sort((first, second) => first.rowDistance - second.rowDistance)
      const match = nearbyMatches[0]
      return {
        match,
        diagnostics: {
          ...diagnosticBase,
          reason: 'short-nearby-exact-match',
          exactOccurrences: exactMatches.length,
          nearbyOccurrences: nearbyMatches.length,
          rowDistance: match.rowDistance,
          confidence: 1,
          matchedPage: match.page,
        },
      }
    }
    return {
      match: null,
      diagnostics: {
        ...diagnosticBase,
        reason: exactMatches.length ? 'short-match-not-near-anchor' : 'short-no-exact-match',
        exactOccurrences: exactMatches.length,
        searchedRows: [1, 2],
        direction: direction < 0 ? 'backward' : 'forward',
      },
    }
  }

  const evaluateCandidate = (position, similarity, ending = position) => {
    const distance = anchor
      ? Math.abs(position.page - anchor.page) * 2 + Math.abs(position.y - anchor.y) / Math.max(position.pageHeight, 1)
      : position.page + position.y / Math.max(position.pageHeight, 1)
    const signedDistance = anchor
      ? ((position.page - anchor.page) * 2 + (position.y - anchor.y) / Math.max(position.pageHeight, 1)) * (direction < 0 ? -1 : 1)
      : 1
    const directionPenalty = anchor && signedDistance < -0.02 ? 0.14 : 0
    return {
      ...position,
      endPage: ending.page,
      endY: ending.y,
      endLineBottom: ending.lineBottom ?? ending.y,
      startRowId: position.rowId,
      endRowId: ending.rowId ?? position.rowId,
      similarity,
      score: similarity - Math.min(distance * 0.2, 0.5) - directionPenalty,
    }
  }

  if (candidates.length) {
    const exactMatches = candidates.map(({ similarity, endPosition, ...position }) => evaluateCandidate(position, similarity, endPosition))
    const forwardMatches = anchor ? exactMatches.filter((match) => match.score > -Infinity && (((match.page - anchor.page) * 2 + (match.y - anchor.y) / Math.max(match.pageHeight, 1)) * (direction < 0 ? -1 : 1)) >= -0.02) : exactMatches
    const preferredMatches = forwardMatches.length ? forwardMatches : exactMatches
    preferredMatches.sort((first, second) => second.score - first.score)
    const match = preferredMatches[0]
    return {
      match,
      diagnostics: {
        ...diagnosticBase,
        reason: 'exact-match',
        exactOccurrences: exactMatches.length,
        matchedPage: match.page,
        confidence: 1,
      },
    }
  }

  const minLength = Math.max(4, expected.length - Math.max(2, Math.ceil(expected.length * 0.14)))
  const maxLength = expected.length + Math.max(2, Math.ceil(expected.length * 0.14))
  const possibleStarts = new Set(expected.slice(0, Math.min(3, expected.length)).flatMap((word) => startsByWord.get(word) ?? []))
  const threshold = expected.length >= 8 ? 0.82 : 0.9
  let bestCandidate = null
  for (const start of possibleStarts) {
    for (let length = minLength; length <= maxLength && start + length <= index.words.length; length += 1) {
      const first = index.words[start]
      const last = index.words[start + length - 1]
      if (first.page !== last.page && length > expected.length * 1.15) continue
      const actual = index.words.slice(start, start + length).map((word) => word.word)
      const similarity = editSimilarity(expected, actual)
      const evaluated = evaluateCandidate(first, similarity, last)
      if (!bestCandidate || evaluated.similarity > bestCandidate.similarity) {
        bestCandidate = { ...evaluated, preview: actual.join(' ') }
      }
      if (similarity < threshold) continue
      candidates.push(evaluated)
    }
  }
  if (candidates.length === 0) {
    return {
      match: null,
      diagnostics: {
        ...diagnosticBase,
        reason: possibleStarts.size ? 'below-confidence-threshold' : 'no-shared-start-words',
        possibleStartCount: possibleStarts.size,
        threshold,
        bestConfidence: bestCandidate?.similarity ?? null,
        candidatePage: bestCandidate?.page ?? null,
        candidatePreview: bestCandidate?.preview ?? '',
      },
    }
  }
  const directionalMatches = anchor
    ? candidates.filter((match) => (((match.page - anchor.page) * 2 + (match.y - anchor.y) / Math.max(match.pageHeight, 1)) * (direction < 0 ? -1 : 1)) >= -0.02)
    : candidates
  const preferredCandidates = directionalMatches.length ? directionalMatches : candidates
  preferredCandidates.sort((first, second) => second.score - first.score)
  const winner = preferredCandidates[0]
  if (preferredCandidates[1] && winner.score - preferredCandidates[1].score < 0.015 && winner.similarity < 0.99) {
    return {
      match: null,
      diagnostics: {
        ...diagnosticBase,
        reason: 'ambiguous-match',
        threshold,
        bestConfidence: winner.similarity,
        candidatePage: winner.page,
        candidatePreview: bestCandidate?.preview ?? '',
      },
    }
  }
  return {
    match: winner,
    diagnostics: {
      ...diagnosticBase,
      reason: 'fuzzy-match',
      threshold,
      confidence: winner.similarity,
      matchedPage: winner.page,
      possibleStartCount: possibleStarts.size,
    },
  }
}

export function findPdfDialogueMatch(transcript, index, anchor = null, direction = 1) {
  return inspectPdfDialogueMatch(transcript, index, anchor, direction).match
}
