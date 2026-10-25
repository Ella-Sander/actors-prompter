import { useEffect, useRef, useState } from 'react'
import './App.css'

const DATABASE_NAME = 'prompt-library'
const DATABASE_VERSION = 1
const APP_VERSION = '1.0.0'

let databasePromise
const audioBoundsCache = new WeakMap()
let ttsModelPromise
let ttsFetchTraceState

function recordTtsTrace(event, details = {}) {
  if (typeof window === 'undefined') return
  const entry = { time: new Date().toISOString(), event, ...details }
  window.__promptLibraryTtsTrace ??= []
  window.__promptLibraryTtsTrace.push(entry)
  if (window.__promptLibraryTtsTrace.length > 60) window.__promptLibraryTtsTrace.shift()
  console.info('[Prompt TTS trace]', entry)
}

function safeFetchTarget(input) {
  try {
    const requestUrl = typeof input === 'string' || input instanceof URL ? input : input.url
    const url = new URL(requestUrl, window.location.href)
    return `${url.origin}${url.pathname}`
  } catch {
    return 'unknown URL'
  }
}

function startTtsFetchTrace() {
  if (!ttsFetchTraceState) {
    const originalFetch = globalThis.fetch
    const tracedFetch = async (input, init) => {
      const target = safeFetchTarget(input)
      const method = init?.method ?? (typeof Request !== 'undefined' && input instanceof Request ? input.method : 'GET')
      recordTtsTrace('fetch-start', { method, target })
      try {
        const response = await originalFetch.call(globalThis, input, init)
        recordTtsTrace('fetch-response', {
          method,
          target,
          status: response.status,
          responseType: response.type,
          finalTarget: safeFetchTarget(response.url || target),
        })
        return response
      } catch (error) {
        recordTtsTrace('fetch-failed', {
          method,
          target,
          error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        })
        throw error
      }
    }
    ttsFetchTraceState = { originalFetch, tracedFetch, users: 0 }
    globalThis.fetch = tracedFetch
  }

  const traceState = ttsFetchTraceState
  traceState.users += 1
  let stopped = false
  return () => {
    if (stopped) return
    stopped = true
    traceState.users -= 1
    if (traceState.users === 0) {
      if (globalThis.fetch === traceState.tracedFetch) globalThis.fetch = traceState.originalFetch
      ttsFetchTraceState = undefined
    }
  }
}

function ensureReadableStreamAsyncIterator() {
  const streamPrototype = globalThis.ReadableStream?.prototype
  if (!streamPrototype || Symbol.asyncIterator in streamPrototype) return

  Object.defineProperty(streamPrototype, Symbol.asyncIterator, {
    configurable: true,
    value: async function* iterateReadableStream() {
      const reader = this.getReader()
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) return
          yield value
        }
      } finally {
        reader.releaseLock()
      }
    },
  })
}

async function generateTtsAudio(text) {
  const stopFetchTrace = startTtsFetchTrace()
  recordTtsTrace('generation-start', { transcriptLength: text.length })
  try {
    ensureReadableStreamAsyncIterator()
    recordTtsTrace('module-import-start')
    const { KokoroTTS } = await import('kokoro-js')
    recordTtsTrace('module-import-ready')
    if (!ttsModelPromise) {
      recordTtsTrace('model-load-start', { model: 'onnx-community/Kokoro-82M-v1.0-ONNX', dtype: 'q8', device: 'wasm' })
      const modelPromise = KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', {
        dtype: 'q8',
        device: 'wasm',
        progress_callback: (progress) => recordTtsTrace(`model-${progress.status}`, {
          file: progress.file,
          progress: progress.progress,
          loaded: progress.loaded,
          total: progress.total,
        }),
      })
      const retryableModelPromise = modelPromise.catch((error) => {
        if (ttsModelPromise === retryableModelPromise) ttsModelPromise = undefined
        throw error
      })
      ttsModelPromise = retryableModelPromise
    } else {
      recordTtsTrace('model-load-cached')
    }
    const synthesizer = await ttsModelPromise
    recordTtsTrace('model-ready')
    recordTtsTrace('synthesis-start')
    const audio = await synthesizer.generate(text, { voice: 'af_bella' })
    const blob = audio.toBlob()
    recordTtsTrace('synthesis-ready', { audioBytes: blob.size, audioType: blob.type })
    return blob
  } catch (error) {
    recordTtsTrace('generation-failed', {
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    })
    throw error
  } finally {
    stopFetchTrace()
  }
}


function isScriptHeading(line) {
  const text = line.trim()
  return !text || /^\d+$/.test(text) || /^(INT\.?|EXT\.?|INT\.?\/EXT\.?|SCENE\s+\d+|ACT\s+\d+|FADE IN|FADE OUT|CUT TO|DISSOLVE TO|THE END)\b/i.test(text)
}

function isCharacterCue(line) {
  const text = line.trim()
  if (text.length < 2 || text.length > 38 || isScriptHeading(text)) return false
  if (/^[[(].*[)\]]$/.test(text) || /\d{3,}/.test(text)) return false
  if (!/^[A-Z0-9][A-Z0-9 ._''()-]+$/.test(text)) return false
  const letters = text.match(/[A-Z]/g)?.length ?? 0
  return letters >= 2 && letters / Math.max(1, text.match(/[A-Z]/gi)?.length ?? 0) > 0.85
}

async function extractScriptLines(file) {
  const [pdfjsLib, pdfWorker] = await Promise.all([
    import('pdfjs-dist'),
    import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
  ])
  pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker.default
  const pdf = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise
  const lines = []
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber)
    const content = await page.getTextContent()
    const positionedLines = new Map()
    for (const item of content.items) {
      if (!('str' in item) || !item.str.trim()) continue
      const y = Math.round(item.transform[5] / 2) * 2
      const row = positionedLines.get(y) ?? []
      row.push({ x: item.transform[4], text: item.str })
      positionedLines.set(y, row)
    }
    const pageLines = [...positionedLines.entries()]
      .sort(([yA], [yB]) => yB - yA)
      .map(([, items]) => items.sort((a, b) => a.x - b.x).map((item) => item.text).join(' ').replace(/\s+/g, ' ').trim())
    lines.push(...pageLines)
  }

  const dialogue = []
  let activeCharacter = ''
  let activeText = []
  const flush = () => {
    const text = activeText.join(' ').replace(/\s+/g, ' ').trim()
    if (activeCharacter && text) dialogue.push({ id: makeId(), character: activeCharacter, text })
    activeText = []
  }
  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line || isScriptHeading(line) || /^[([][^)\]]*[)\]]$/.test(line)) continue
    if (isCharacterCue(line)) {
      flush()
      activeCharacter = line.replace(/\s*\([^)]*\)\s*$/, '').trim()
      continue
    }
    if (activeCharacter) activeText.push(line)
  }
  flush()
  if (!dialogue.length) throw new Error('No dialogue was detected. This PDF may be scanned, image-only, or not formatted as a character script.')
  return dialogue
}
function getAudioBounds(blob) {
  if (!blob || typeof blob.arrayBuffer !== 'function') return Promise.resolve({ start: 0, end: 0 })
  if (audioBoundsCache.has(blob)) return audioBoundsCache.get(blob)

  const boundsPromise = (async () => {
    const AudioContextConstructor = window.AudioContext || window.webkitAudioContext
    if (!AudioContextConstructor) return { start: 0, end: 0 }
    let context
    try {
      context = new AudioContextConstructor()
      const decoded = await context.decodeAudioData(await blob.arrayBuffer())
      const duration = decoded.duration
      const samplesPerWindow = Math.max(1, Math.floor(decoded.sampleRate * 0.01))
      const windowCount = Math.ceil(decoded.length / samplesPerWindow)
      const levels = new Float32Array(windowCount)
      for (let channel = 0; channel < decoded.numberOfChannels; channel += 1) {
        const samples = decoded.getChannelData(channel)
        for (let windowIndex = 0; windowIndex < windowCount; windowIndex += 1) {
          const start = windowIndex * samplesPerWindow
          const end = Math.min(samples.length, start + samplesPerWindow)
          let energy = 0
          for (let sampleIndex = start; sampleIndex < end; sampleIndex += 1) energy += samples[sampleIndex] ** 2
          const level = Math.sqrt(energy / Math.max(1, end - start))
          levels[windowIndex] = Math.max(levels[windowIndex], level)
        }
      }

      const threshold = 0.012
      const activeWindows = 6
      const findSpeechStart = () => {
        for (let index = 0; index <= windowCount - activeWindows; index += 1) {
          if (levels.subarray(index, index + activeWindows).every((level) => level >= threshold)) return index
        }
        return -1
      }
      const findSpeechEnd = () => {
        for (let index = windowCount - activeWindows; index >= 0; index -= 1) {
          if (levels.subarray(index, index + activeWindows).every((level) => level >= threshold)) return index + activeWindows
        }
        return -1
      }
      const firstActive = findSpeechStart()
      const lastActive = findSpeechEnd()
      if (firstActive < 0 || lastActive < 0) return { start: 0, end: duration }
      const padding = 0.08
      const start = Math.max(0, firstActive * samplesPerWindow / decoded.sampleRate - padding)
      const end = Math.min(duration, lastActive * samplesPerWindow / decoded.sampleRate + padding)
      return end > start ? { start, end } : { start: 0, end: duration }
    } catch {
      return { start: 0, end: 0 }
    } finally {
      if (context && context.state !== 'closed') context.close().catch(() => {})
    }
  })()

  audioBoundsCache.set(blob, boundsPromise)
  return boundsPromise
}

function waitForAudioMetadata(audio) {
  if (audio.readyState >= 1) return Promise.resolve()
  return new Promise((resolve) => {
    const finish = () => {
      audio.removeEventListener('loadedmetadata', finish)
      audio.removeEventListener('error', finish)
      resolve()
    }
    audio.addEventListener('loadedmetadata', finish, { once: true })
    audio.addEventListener('error', finish, { once: true })
    audio.load()
  })
}

async function prepareAudioTrim(audio, blob, shouldTrim, onTrimEnd) {
  if (!shouldTrim) return { cleanup: () => {}, duration: audio.duration }
  const [bounds] = await Promise.all([getAudioBounds(blob), waitForAudioMetadata(audio)])
  const start = Math.max(0, bounds.start)
  const end = Math.min(Number.isFinite(audio.duration) ? audio.duration : bounds.end, bounds.end || audio.duration)
  if (audio.readyState >= 1) audio.currentTime = start
  if (end <= start) return { cleanup: () => {}, duration: audio.duration }

  let finished = false
  const handleTimeUpdate = () => {
    if (finished || audio.currentTime < end - 0.025) return
    finished = true
    audio.pause()
    audio.currentTime = end
    onTrimEnd?.()
  }
  audio.addEventListener('timeupdate', handleTimeUpdate)
  return {
    duration: end - start,
    cleanup: () => audio.removeEventListener('timeupdate', handleTimeUpdate),
  }
}

function openDatabase() {
  if (!databasePromise) {
    databasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION)
      request.onupgradeneeded = () => {
        const database = request.result
        database.createObjectStore('folders', { keyPath: 'id' })
        database.createObjectStore('prompts', { keyPath: 'id' })
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
  }
  return databasePromise
}

function readAll(storeName) {
  return openDatabase().then((database) => new Promise((resolve, reject) => {
    const request = database.transaction(storeName).objectStore(storeName).getAll()
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  }))
}

function saveRecord(storeName, record) {
  return openDatabase().then((database) => new Promise((resolve, reject) => {
    const transaction = database.transaction(storeName, 'readwrite')
    transaction.objectStore(storeName).put(record)
    transaction.oncomplete = resolve
    transaction.onerror = () => reject(transaction.error)
  }))
}

function savePromptRecords(records) {
  if (records.length === 0) return Promise.resolve()
  return openDatabase().then((database) => new Promise((resolve, reject) => {
    const transaction = database.transaction('prompts', 'readwrite')
    const store = transaction.objectStore('prompts')
    records.forEach((record) => store.put(record))
    transaction.oncomplete = resolve
    transaction.onerror = () => reject(transaction.error)
  }))
}

function normalizePromptPositions(prompts) {
  const byFolder = new Map()
  prompts.forEach((prompt) => {
    const folderPrompts = byFolder.get(prompt.folderId) ?? []
    folderPrompts.push(prompt)
    byFolder.set(prompt.folderId, folderPrompts)
  })

  const normalizedById = new Map()
  byFolder.forEach((folderPrompts) => {
    if (folderPrompts.every((prompt) => prompt.position !== undefined && prompt.position !== null)) return
    folderPrompts
      .sort((first, second) => first.createdAt - second.createdAt || first.id.localeCompare(second.id))
      .forEach((prompt, position) => normalizedById.set(prompt.id, { ...prompt, position }))
  })

  return {
    prompts: prompts.map((prompt) => normalizedById.get(prompt.id) ?? prompt),
    changed: [...normalizedById.values()],
  }
}

function removeFolder(folderId) {
  return openDatabase().then((database) => new Promise((resolve, reject) => {
    const transaction = database.transaction(['folders', 'prompts'], 'readwrite')
    const folderStore = transaction.objectStore('folders')
    const promptStore = transaction.objectStore('prompts')
    const request = promptStore.getAll()
    request.onsuccess = () => {
      request.result
        .filter((prompt) => prompt.folderId === folderId)
        .forEach((prompt) => promptStore.delete(prompt.id))
      folderStore.delete(folderId)
    }
    transaction.oncomplete = resolve
    transaction.onerror = () => reject(transaction.error)
  }))
}

function makeId() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function formatTime(seconds) {
  const minutes = Math.floor(seconds / 60).toString().padStart(2, '0')
  const remainder = (seconds % 60).toString().padStart(2, '0')
  return `${minutes}:${remainder}`
}

function formatRoundedTime(seconds) {
  const totalSeconds = Math.max(0, Math.round(seconds))
  const minutes = Math.floor(totalSeconds / 60).toString().padStart(2, '0')
  const remainder = (totalSeconds % 60).toString().padStart(2, '0')
  return `${minutes}:${remainder}`
}

function silenceDurationSeconds(prompt) {
  const duration = prompt?.duration ?? 3
  return Number.isFinite(duration) ? Math.max(1, Math.min(600, duration)) : 3
}

function setReaderPlaybackPitch(audio, speaker, pitch) {
  if (speaker !== 'Reader') return
  audio.playbackRate = pitch
  if ('preservesPitch' in audio) audio.preservesPitch = false
  if ('mozPreservesPitch' in audio) audio.mozPreservesPitch = false
  if ('webkitPreservesPitch' in audio) audio.webkitPreservesPitch = false
}

function formatPromptLabel(prompt, sequenceNumber) {
  if (prompt.type === 'silence') return `Silence ${sequenceNumber}`
  return `${prompt.speaker ?? 'Myself'} ${sequenceNumber}`
}

function comparePromptOrder(first, second) {
  return (first.position ?? first.createdAt) - (second.position ?? second.createdAt) || first.id.localeCompare(second.id)
}

function normalizeTranscriptWords(value) {
  return value
    .normalize('NFKD')
    .toLocaleLowerCase('en-US')
    .replace(/\p{M}/gu, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .trim()
    .split(/\s+/u)
    .filter(Boolean)
}

function countTriggerWordOccurrences(transcript, triggerWord) {
  if (!triggerWord) return 0
  return normalizeTranscriptWords(transcript).filter((word) => word === triggerWord).length
}

function findTranscriptWordMatches(expectedText, recognizedText) {
  const expected = normalizeTranscriptWords(expectedText)
  const recognized = normalizeTranscriptWords(recognizedText)
  const matches = []
  let expectedIndex = 0

  for (const recognizedWord of recognized) {
    const matchIndex = expected.indexOf(recognizedWord, expectedIndex)
    if (matchIndex < 0) continue
    matches.push(matchIndex)
    expectedIndex = matchIndex + 1
  }

  return matches
}

function TranscriptWords({ text, matchedWordIndices = [], latestMatchedWordIndex = -1 }) {
  const matched = new Set(matchedWordIndices)
  const parts = text.match(/\S+\s*/gu) ?? []
  let wordIndex = 0

  return parts.map((part, index) => {
    const normalizedWords = normalizeTranscriptWords(part.trim())
    if (normalizedWords.length === 0) return <span key={index}>{part}</span>

    const indices = normalizedWords.map((_, offset) => wordIndex + offset)
    wordIndex += normalizedWords.length
    const isMatched = indices[0] <= latestMatchedWordIndex || indices.every((matchedIndex) => matched.has(matchedIndex))
    const isCurrent = isMatched && indices.includes(latestMatchedWordIndex)

    return (
      <span className={isMatched ? `teleprompter-word is-highlighted${isCurrent ? ' is-current' : ''}` : 'teleprompter-word'} key={index}>
        {part}
      </span>
    )
  })
}

function stopRehearsalVoiceMonitor(session) {
  window.clearInterval(session.voiceMonitorTimer)
  session.voiceMonitorTimer = null
  session.voiceStream?.getTracks().forEach((track) => track.stop())
  session.voiceStream = null
  if (session.voiceAudioContext && session.voiceAudioContext.state !== 'closed') {
    session.voiceAudioContext.close().catch(() => {})
  }
  session.voiceAudioContext = null
}

function stopRehearsalReaderPlayback(session) {
  const playback = session?.readerAudio
  if (!playback) return
  session.readerAudio = null
  session.readerEndTime = null
  window.clearInterval(session.readerCountdownTimer)
  session.readerCountdownTimer = null
  const { audio, objectUrl } = playback
  audio.onended = null
  audio.onerror = null
  playback.trimCleanup?.()
  audio.pause()
  try { audio.currentTime = 0 } catch { /* metadata may not be ready */ }
  audio.removeAttribute('src')
  audio.src = ''
  audio.load()
  URL.revokeObjectURL(objectUrl)
}

function disposeRehearsalSession(session) {
  if (!session) return
  session.phase = 'stopped'
  window.clearInterval(session.readerCountdownTimer)
  session.readerCountdownTimer = null
  window.clearTimeout(session.advanceTimer)
  session.advanceTimer = null
  window.clearTimeout(session.silenceTimer)
  session.silenceTimer = null
  window.clearInterval(session.silenceCountdownInterval)
  session.silenceCountdownInterval = null
  stopRehearsalVoiceMonitor(session)
  if (session.recognition) {
    session.recognition.onresult = null
    session.recognition.onerror = null
    session.recognition.onend = null
    session.recognition.abort()
    session.recognition = null
  }
  stopRehearsalReaderPlayback(session)
}

function RunControlIcon({ name }) {
  const common = {
    fill: 'none',
    stroke: 'currentColor',
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    strokeWidth: 1.7,
  }

  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" width="17" height="17" {...common}>
      {name === 'play' && <path d="M6.5 4.75 15 10l-8.5 5.25z" fill="currentColor" stroke="none" />}
      {name === 'pause' && <><path d="M7 5v10" strokeWidth="2.2" /><path d="M13 5v10" strokeWidth="2.2" /></>}
      {name === 'skip' && <><path d="M4.5 5.5 11 10l-6.5 4.5z" fill="currentColor" stroke="none" /><path d="M11 5.5 17.5 10 11 14.5z" fill="currentColor" stroke="none" /><path d="M18 5v10" strokeWidth="2" /></>}
      {name === 'previous' && <g transform="translate(20 0) scale(-1 1)"><path d="M4.5 5.5 11 10l-6.5 4.5z" fill="currentColor" stroke="none" /><path d="M11 5.5 17.5 10 11 14.5z" fill="currentColor" stroke="none" /><path d="M18 5v10" strokeWidth="2" /></g>}
      {name === 'restart' && <><path d="M4.5 8a6 6 0 1 1-.1 4" /><path d="M4.5 4.8V8h3.2" /></>}
      {name === 'stop' && <rect x="5.5" y="5.5" width="9" height="9" rx="1.5" fill="currentColor" stroke="none" />}
      {name === 'fullscreen' && <path d="M7.5 3.8H3.8v3.7M12.5 3.8h3.7v3.7M16.2 12.5v3.7h-3.7M7.5 16.2H3.8v-3.7" />}
      {name === 'exit-fullscreen' && <path d="M3.8 7.5h3.7V3.8M16.2 7.5h-3.7V3.8M16.2 12.5h-3.7v3.7M3.8 12.5h3.7v3.7" />}
    </svg>
  )
}

function AudioPlayer({ audio, trimSilence = false }) {
  const [source, setSource] = useState('')
  const [playbackDuration, setPlaybackDuration] = useState(null)
  const playerRef = useRef(null)

  useEffect(() => {
    const objectUrl = URL.createObjectURL(audio)
    setSource(objectUrl)
    return () => URL.revokeObjectURL(objectUrl)
  }, [audio])

  useEffect(() => {
    const player = playerRef.current
    if (!player) return undefined
    let disposed = false
    async function updatePlaybackDuration() {
      setPlaybackDuration(null)
      await waitForAudioMetadata(player)
      if (disposed) return
      const sourceDuration = player.duration
      if (!Number.isFinite(sourceDuration)) return
      if (!trimSilence) {
        setPlaybackDuration(sourceDuration)
        return
      }
      const bounds = await getAudioBounds(audio)
      if (disposed) return
      const start = Math.max(0, bounds.start)
      const end = Math.min(sourceDuration, bounds.end || sourceDuration)
      setPlaybackDuration(end > start ? end - start : sourceDuration)
    }
    updatePlaybackDuration()
    if (!trimSilence) return () => { disposed = true }
    let preparing = false
    let bounds = null
    const boundsPromise = getAudioBounds(audio)
    const handlePlay = async () => {
      if (preparing) {
        player.pause()
        return
      }
      if (!bounds) {
        preparing = true
        player.pause()
        const detectedBounds = await boundsPromise
        if (disposed) return
        bounds = {
          start: detectedBounds.start,
          end: detectedBounds.end || player.duration,
        }
        preparing = false
        if (player.currentTime < bounds.start || player.currentTime >= bounds.end) player.currentTime = bounds.start
        player.play().catch(() => {})
        return
      }
      if (player.currentTime < bounds.start || player.currentTime >= bounds.end) player.currentTime = bounds.start
    }
    const handleTimeUpdate = () => {
      if (bounds && player.currentTime >= bounds.end) {
        player.pause()
        player.currentTime = bounds.end
      }
    }
    player.addEventListener('play', handlePlay)
    player.addEventListener('timeupdate', handleTimeUpdate)
    return () => {
      disposed = true
      player.removeEventListener('play', handlePlay)
      player.removeEventListener('timeupdate', handleTimeUpdate)
    }
  }, [audio, source, trimSilence])

  return source ? (
    <div className="audio-player-group">
      <audio ref={playerRef} className="audio-player" controls preload="metadata" src={source}>Audio playback is not supported.</audio>
      {trimSilence && Number.isFinite(playbackDuration) && (
        <div className="audio-player-trimmed-duration" aria-label={`Trimmed playback duration ${formatRoundedTime(playbackDuration)}`}>
          <span className="trimmed-duration-label"><i aria-hidden="true" />TRIMMED</span>
          <strong>{formatRoundedTime(playbackDuration)}</strong>
        </div>
      )}
    </div>
  ) : null
}


function ScriptImportDialog({ folderName, onClose, onImport }) {
  const [fileName, setFileName] = useState('')
  const [lines, setLines] = useState([])
  const [characters, setCharacters] = useState([])
  const [selectedCharacter, setSelectedCharacter] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function selectFile(event) {
    const file = event.target.files?.[0]
    if (!file) return
    setFileName(file.name)
    setLines([])
    setCharacters([])
    setError('')
    if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
      setError('Choose a PDF file to import.')
      return
    }
    setLoading(true)
    try {
      const extracted = await extractScriptLines(file)
      const detected = [...new Set(extracted.map((line) => line.character))]
      setLines(extracted)
      setCharacters(detected)
      setSelectedCharacter(detected[0] ?? '')
    } catch (extractError) {
      setError(extractError?.message || 'This PDF could not be read. Try a text-based PDF instead of a scanned image.')
    } finally {
      setLoading(false)
    }
  }

  function editLine(id, text) {
    setLines((current) => current.map((line) => line.id === id ? { ...line, text } : line))
  }

  function removeLine(id) {
    setLines((current) => current.filter((line) => line.id !== id))
  }

  async function confirmImport() {
    const importableLines = lines.filter((line) => line.text.trim())
    if (!selectedCharacter || !importableLines.length) {
      setError('Choose your character and keep at least one dialogue line to import.')
      return
    }
    setLoading(true)
    setError('')
    try {
      await onImport(importableLines, selectedCharacter, characters)
    } catch (importError) {
      setError(importError?.message || 'The prompts could not be imported. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="dialog-backdrop" onMouseDown={(event) => event.target === event.currentTarget && !loading && onClose()}>
      <section className="record-dialog script-import-dialog" role="dialog" aria-modal="true" aria-labelledby="script-import-title">
        <div className="dialog-heading">
          <div>
            <p className="eyebrow">SCRIPT IMPORT <span>///</span> {folderName}</p>
            <h2 id="script-import-title">Import a script PDF</h2>
          </div>
          <button className="icon-button" type="button" aria-label="Close dialog" onClick={onClose} disabled={loading}>{'\u00D7'}</button>
        </div>
        <label className="field-label" htmlFor="script-pdf">PDF file</label>
        <input id="script-pdf" className="text-field script-file-input" type="file" accept="application/pdf,.pdf" onChange={selectFile} disabled={loading} />
        {fileName && <p className="script-import-meta">{fileName}{loading ? '  /  PROCESSING' : lines.length ? `  /  ${lines.length} DIALOGUE LINES` : ''}</p>}
        {characters.length > 0 && <>
          <label className="field-label" htmlFor="script-character">Character you will play</label>
          <select id="script-character" className="text-field character-select" value={selectedCharacter} onChange={(event) => setSelectedCharacter(event.target.value)} disabled={loading}>
            {characters.map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
          <p className="script-import-hint">Your selected character becomes Myself. Other characters become Reader.</p>
          <div className="script-preview-list" aria-label="Review extracted dialogue">
            {lines.map((line, index) => (
              <div className="script-preview-line" key={line.id}>
                <div className="script-preview-label"><strong>{line.character}</strong><span>{line.character === selectedCharacter ? 'MYSELF' : 'READER'}  /  {String(index + 1).padStart(2, '0')}</span><button className="script-line-delete" type="button" onClick={() => removeLine(line.id)} disabled={loading} aria-label={`Remove ${line.character} dialogue ${index + 1}`}>Remove</button></div>
                <textarea className="text-field script-preview-text" value={line.text} onChange={(event) => editLine(line.id, event.target.value)} disabled={loading} aria-label={`${line.character} dialogue ${index + 1}`} />
              </div>
            ))}
          </div>
          {lines.length === 0 && <p className="script-import-hint">All dialogue rows have been removed.</p>}
        </>}
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="dialog-actions">
          <button className="quiet-button" type="button" onClick={onClose} disabled={loading}>Cancel</button>
          {lines.length > 0 && <button className="primary-button" type="button" onClick={confirmImport} disabled={loading}>{loading ? 'Preparing...' : 'Approve & import'}</button>}
        </div>
      </section>
    </div>
  )
}
function PromptDialog({ folderName, characters, prompt, onClose, onSave }) {
  const [speaker, setSpeaker] = useState(prompt?.speaker ?? 'Myself')
  const [character, setCharacter] = useState(prompt?.character ?? '')
  const [audio, setAudio] = useState(prompt?.audio ?? null)
  const [audioSource, setAudioSource] = useState(prompt?.audioSource ?? 'user')
  const [trimSilence, setTrimSilence] = useState(prompt?.trimSilence ?? false)
  const [transcript, setTranscript] = useState(prompt?.transcript ?? '')
  const [transcriptNotice, setTranscriptNotice] = useState('')
  const [transcriptError, setTranscriptError] = useState('')
  const [recording, setRecording] = useState(false)
  const [seconds, setSeconds] = useState(0)
  const [error, setError] = useState('')
  const [generationError, setGenerationError] = useState('')
  const [generatingAudio, setGeneratingAudio] = useState(false)
  const recorderRef = useRef(null)
  const recognitionRef = useRef(null)
  const chunksRef = useRef([])

  useEffect(() => {
    if (!recording) return undefined
    const timer = window.setInterval(() => setSeconds((value) => value + 1), 1000)
    return () => window.clearInterval(timer)
  }, [recording])

  useEffect(() => () => {
    const recorder = recorderRef.current
    if (recorder?.state === 'recording') recorder.stop()
    recorder?.stream.getTracks().forEach((track) => track.stop())
    recognitionRef.current?.abort()
  }, [])

  async function startRecording() {
    setError('')
    setAudio(null)
    setAudioSource(null)
    setTranscriptNotice('')
    setTranscriptError('')
    setSeconds(0)

    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
      setError('Audio recording is not supported in this browser.')
      return
    }

    const SpeechRecognitionApi = window.SpeechRecognition || window.webkitSpeechRecognition
    if (SpeechRecognitionApi) {
      const recognition = new SpeechRecognitionApi()
      recognition.continuous = true
      recognition.interimResults = true
      recognition.lang = 'en-US'
      recognition.onresult = (event) => {
        const spokenWords = Array.from(event.results)
          .map((result) => result[0].transcript)
          .join(' ')
          .trim()
        setTranscript(spokenWords)
      }
      recognition.onerror = () => {
        setTranscriptNotice('TRANSCRIPTION INTERRUPTED')
      }
      recognitionRef.current = recognition
      try {
        recognition.start()
      } catch {
        setTranscriptNotice('TRANSCRIPTION UNAVAILABLE')
      }
    } else {
      setTranscriptNotice('TYPE AN ENGLISH TRANSCRIPT')
    }

    let stream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const recorder = new MediaRecorder(stream)
      chunksRef.current = []
      recorderRef.current = recorder
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data)
      }
      recorder.onstop = () => {
        const clip = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' })
        if (clip.size > 0) setAudio(clip)
        if (clip.size > 0) setAudioSource('user')
        stream.getTracks().forEach((track) => track.stop())
        setRecording(false)
      }
      recorder.start()
      setRecording(true)
    } catch {
      stream?.getTracks().forEach((track) => track.stop())
      recognitionRef.current?.abort()
      setError('Microphone access was unavailable. Allow microphone access and try again.')
    }
  }

  function stopRecording() {
    recognitionRef.current?.stop()
    if (recorderRef.current?.state === 'recording') recorderRef.current.stop()
  }

  async function submitPrompt(event) {
    event.preventDefault()
    if (recording || generatingAudio) return
    if (!transcript.trim()) {
      setTranscriptError('Add an English transcript before saving this recording.')
      return
    }
    const cleanTranscript = transcript.trim()
    let savedAudio = audio
    let savedAudioSource = audioSource
    const isUserRecording = Boolean(audio && audioSource !== 'tts')
    const transcriptChanged = cleanTranscript !== (prompt?.transcript ?? '')
    if (!isUserRecording && (!audio || audioSource !== 'tts' || transcriptChanged)) {
      setGeneratingAudio(true)
      setGenerationError('')
      try {
        savedAudio = await generateTtsAudio(cleanTranscript)
        savedAudioSource = 'tts'
      } catch (ttsError) {
        let errorDetails
        if (ttsError instanceof Error) {
          const message = ttsError.message || 'No error message provided.'
          const stack = ttsError.stack && !ttsError.stack.includes(message) ? ttsError.stack : ''
          errorDetails = [`${ttsError.name}: ${message}`, stack].filter(Boolean).join('\n')
        } else {
          errorDetails = String(ttsError || 'Check your connection and try saving again.')
        }
        const traceDetails = (window.__promptLibraryTtsTrace ?? []).slice(-24).map((entry) => {
          const { time, event, ...details } = entry
          return `${time} ${event}${Object.keys(details).length ? ` ${JSON.stringify(details)}` : ''}`
        }).join('\n')
        if (traceDetails) errorDetails += `\n\nRecent TTS trace:\n${traceDetails}`
        setGenerationError(`The default voice could not be generated:\n${errorDetails}`)
        setGeneratingAudio(false)
        return
      }
      setGeneratingAudio(false)
    }
    onSave({
      id: prompt?.id ?? makeId(),
      speaker,
      character,
      audio: savedAudio,
      audioSource: savedAudioSource,
      trimSilence,
      transcript: cleanTranscript,
      createdAt: prompt?.createdAt ?? Date.now(),
    })
  }

  return (
    <div className="dialog-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="record-dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title">
        <div className="dialog-heading">
          <div>
            <p className="eyebrow">{prompt ? 'EDIT RECORDING' : 'NEW RECORDING'} <span>///</span> {folderName}</p>
            <h2 id="dialog-title">{prompt ? 'Edit prompt' : 'Add a prompt'}</h2>
          </div>
          <button className="icon-button" type="button" aria-label="Close dialog" onClick={onClose}>{'\u00D7'}</button>
        </div>

        <form onSubmit={submitPrompt}>
          <label className="field-label" htmlFor="prompt-character">Character <span className="optional-label">OPTIONAL</span></label>
          <select id="prompt-character" className="text-field character-select" value={character} onChange={(event) => setCharacter(event.target.value)}>
            <option value="">No character</option>
            {prompt?.character && !characters.includes(prompt.character) && <option value={prompt.character}>{prompt.character}</option>}
            {characters.map((name) => <option key={name} value={name}>{name}</option>)}
          </select>

          <fieldset className="speaker-field">
            <legend className="field-label">Recorded by</legend>
            <div className="segmented-control">
              {['Myself', 'Reader'].map((option) => (
                <button
                  className={speaker === option ? 'segment is-selected' : 'segment'}
                  key={option}
                  type="button"
                  aria-pressed={speaker === option}
                  onClick={() => setSpeaker(option)}
                >
                  {option}
                </button>
              ))}
            </div>
          </fieldset>

          <div className="recorder-panel">
            <div className="recorder-status">
              <span className={recording ? 'record-indicator is-live' : 'record-indicator'} />
              <span>{recording ? 'Recording in progress' : audio ? (audioSource === 'tts' ? 'Default voice ready' : 'Recording ready') : 'Ready to record'}</span>
              <span className="recording-time">{formatTime(seconds)}</span>
            </div>
            <button className={recording ? 'record-button is-recording' : 'record-button'} type="button" onClick={recording ? stopRecording : startRecording}>
              <span className="record-button-icon" aria-hidden="true">{recording ? '\u25A0' : '\u25CF'}</span>
              {recording ? 'Stop recording' : audio ? 'Record again' : 'Start recording'}
            </button>
            {audio && !recording && <AudioPlayer audio={audio} trimSilence={trimSilence} />}
            {error && <p className="form-error" role="alert">{error}</p>}
          </div>

          <label className="trim-silence-setting">
            <input type="checkbox" checked={trimSilence} onChange={(event) => setTrimSilence(event.target.checked)} />
            <span className="trim-silence-copy">
              <strong>Cut silence from start and end</strong>
              <span>Skip quiet audio before and after speech during playback.</span>
            </span>
          </label>

          <div className="transcript-editor">
            <div className="transcript-label-row">
              <label className="field-label" htmlFor="prompt-transcript">Transcript</label>
              <span>{transcriptNotice || (recording ? 'LIVE  /  ENGLISH' : 'PASTE OR TYPE  /  ENGLISH')}</span>
            </div>
            <textarea
              id="prompt-transcript"
              className="transcript-input"
              lang="en"
              spellCheck="true"
              value={transcript}
              onChange={(event) => {
                const value = event.target.value
                setTranscript(value)
                if (value.trim()) setTranscriptError('')
              }}
              placeholder="Paste or type an English transcript, or start recording..."
              rows={3}
            />
            {transcriptError && <p className="form-error" role="alert">{transcriptError}</p>}
          </div>
          <div className="dialog-actions">
            <button className="quiet-button" type="button" onClick={onClose}>Cancel</button>
            <div className="dialog-submit-group">
              {(generatingAudio || generationError) && (
                <div className={generationError ? 'generation-status is-error' : 'generation-status'} role={generationError ? 'alert' : 'status'} aria-live="polite">
                  {generatingAudio && <span className="generation-spinner" aria-hidden="true" />}
                  <span>{generatingAudio ? 'Generating default voice…' : generationError}</span>
                </div>
              )}
              <button className="primary-button" type="submit" disabled={!transcript.trim() || recording || generatingAudio}>{prompt ? 'Save changes' : 'Done'} <span aria-hidden="true">{'\u2192'}</span></button>
            </div>
          </div>
        </form>
      </section>
    </div>
  )
}

function FolderDialog({ folder, onClose, onSave }) {
  const [name, setName] = useState(folder?.name ?? '')
  const isEditing = Boolean(folder)

  function submitFolder(event) {
    event.preventDefault()
    if (!name.trim()) return
    onSave({ ...(folder ?? { id: makeId(), createdAt: Date.now() }), name: name.trim() })
  }

  return (
    <div className="dialog-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="record-dialog folder-dialog" role="dialog" aria-modal="true" aria-labelledby="folder-dialog-title">
        <div className="dialog-heading">
          <div>
            <p className="eyebrow">LIBRARY SETUP</p>
            <h2 id="folder-dialog-title">{isEditing ? 'Rename folder' : 'New folder'}</h2>
          </div>
          <button className="icon-button" type="button" aria-label="Close dialog" onClick={onClose}>{'\u00D7'}</button>
        </div>
        <form onSubmit={submitFolder}>
          <label className="field-label" htmlFor="folder-name">Folder name</label>
          <input id="folder-name" className="text-field" value={name} onChange={(event) => setName(event.target.value)} maxLength={60} autoFocus required />
          <div className="dialog-actions">
            <button className="quiet-button" type="button" onClick={onClose}>Cancel</button>
            <button className="primary-button" type="submit">{isEditing ? 'Save changes' : 'Create folder'} <span aria-hidden="true">{'\u2192'}</span></button>
          </div>
        </form>
      </section>
    </div>
  )
}

function App() {
  const [folders, setFolders] = useState([])
  const [prompts, setPrompts] = useState([])
  const [selectedFolderId, setSelectedFolderId] = useState(null)
  const [folderDialog, setFolderDialog] = useState(null)
  const [promptDialog, setPromptDialog] = useState(null)
  const [isImportingScript, setIsImportingScript] = useState(false)
  const [isLoading, setIsLoading] = useState(true)
  const [storageError, setStorageError] = useState('')
  const [isLightMode, setIsLightMode] = useState(false)
  const [runSpeakers, setRunSpeakers] = useState({ Myself: false, Reader: true })
  const [readerPitch, setReaderPitch] = useState(1)
  const [runStatus, setRunStatus] = useState(null)
  const [isRunPaused, setIsRunPaused] = useState(false)
  const [isRunPrompterFullscreen, setIsRunPrompterFullscreen] = useState(false)
  const [runError, setRunError] = useState('')
  const [rehearsalView, setRehearsalView] = useState(null)
  const [isTeleprompterFullscreen, setIsTeleprompterFullscreen] = useState(false)
  const [isAddingCharacter, setIsAddingCharacter] = useState(false)
  const [isFolderSettingsOpen, setIsFolderSettingsOpen] = useState(false)
  const [characterName, setCharacterName] = useState('')
  const [draggedPromptId, setDraggedPromptId] = useState(null)
  const [dragOverPromptId, setDragOverPromptId] = useState(null)
  const activePlaybackRef = useRef(null)
  const pendingRunSkipRef = useRef(null)
  const runPausedRef = useRef(false)
  const playbackSessionRef = useRef(0)
  const rehearsalSessionRef = useRef(null)
  const rehearsalPanelRef = useRef(null)
  const runPrompterRef = useRef(null)
  const promptDragRef = useRef(null)
  const selectedFolder = folders.find((folder) => folder.id === selectedFolderId)
  const folderPrompts = prompts
    .filter((prompt) => prompt.folderId === selectedFolderId)
    .sort(comparePromptOrder)
  const runQueue = folderPrompts.filter((prompt) => (
    prompt.type === 'silence' ||
    (prompt.speaker === 'Myself' ? runSpeakers.Myself || runSpeakers.Reader : runSpeakers.Reader)
  ))
  const myselfSilentMode = runSpeakers.Reader && !runSpeakers.Myself
  const runModeDescription = runSpeakers.Reader && runSpeakers.Myself
    ? 'Play Reader and Myself recordings in order.'
    : runSpeakers.Reader
      ? 'Play Reader recordings and keep Myself lines as silence.'
      : runSpeakers.Myself
        ? 'Play Myself recordings in order; skip Reader lines.'
        : 'Turn on Reader or Myself to choose what runs.'
  const selectedRunCount = runQueue.length
  const isRehearsalRunning = Boolean(rehearsalView && !['completed', 'error'].includes(rehearsalView.status))
  const rehearsalIsListening = ['listening', 'speech-end', 'waiting'].includes(rehearsalView?.status)
  const rehearsalStatusLabel = rehearsalView?.status === 'paused'
    ? 'Paused'
    : ['speech-end', 'waiting'].includes(rehearsalView?.status)
      ? 'Waiting for you to finish speaking'
      : rehearsalView?.status === 'listening'
        ? 'Listening to you'
        : rehearsalView?.speaker === 'Reader'
          ? 'Reader is speaking'
          : rehearsalView?.speaker === 'Silence'
            ? 'Silence'
            : 'Ready'
  const activeRunPrompt = folderPrompts.find((prompt) => prompt.id === runStatus?.promptId)
  const compactRunPrompt = activeRunPrompt ?? runQueue[0] ?? folderPrompts[0]
  const prompterPrompts = [compactRunPrompt].filter(Boolean)
  const canReorderPrompts = !runStatus && (!rehearsalView || ['completed', 'error'].includes(rehearsalView.status))

  useEffect(() => {
    Promise.all([readAll('folders'), readAll('prompts')])
      .then(([savedFolders, savedPrompts]) => {
        const { prompts: positionedPrompts, changed } = normalizePromptPositions(savedPrompts)
        setFolders(savedFolders.sort((a, b) => b.createdAt - a.createdAt))
        setPrompts(positionedPrompts.sort((a, b) => b.createdAt - a.createdAt))
        savePromptRecords(changed).catch(() => setStorageError('The prompt order could not be saved. Please try again.'))
      })
      .catch(() => setStorageError('Your local library could not be loaded. Check that browser storage is available.'))
      .finally(() => setIsLoading(false))
  }, [])

  useEffect(() => () => {
    playbackSessionRef.current += 1
    const playback = activePlaybackRef.current
    if (playback) {
      playback.audio.pause()
      playback.finish(false)
    }
    disposeRehearsalSession(rehearsalSessionRef.current)
    rehearsalSessionRef.current = null
  }, [])

  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsTeleprompterFullscreen(Boolean(rehearsalPanelRef.current && document.fullscreenElement === rehearsalPanelRef.current))
      setIsRunPrompterFullscreen(Boolean(runPrompterRef.current && document.fullscreenElement === runPrompterRef.current))
    }
    document.addEventListener('fullscreenchange', handleFullscreenChange)
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange)
  }, [])

  useEffect(() => {
    if (!runStatus) {
      const panel = runPrompterRef.current
      if (panel && document.fullscreenElement === panel && typeof document.exitFullscreen === 'function') {
        Promise.resolve(document.exitFullscreen()).catch(() => {})
      } else {
        setIsRunPrompterFullscreen(false)
      }
    }
  }, [runStatus])

  useEffect(() => {
    if (!isRehearsalRunning) {
      const panel = rehearsalPanelRef.current
      if (panel && document.fullscreenElement === panel && typeof document.exitFullscreen === 'function') {
        Promise.resolve(document.exitFullscreen()).catch(() => {})
      } else {
        setIsTeleprompterFullscreen(false)
      }
    }
  }, [isRehearsalRunning])

  useEffect(() => {
    setIsFolderSettingsOpen(false)
  }, [selectedFolderId])

  useEffect(() => {
    if (!isFolderSettingsOpen) return undefined
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') setIsFolderSettingsOpen(false)
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [isFolderSettingsOpen])

  async function saveFolder(folder) {
    try {
      await saveRecord('folders', folder)
      setFolders((current) => current.some((item) => item.id === folder.id)
        ? current.map((item) => item.id === folder.id ? folder : item)
        : [folder, ...current])
      setFolderDialog(null)
      return true
    } catch {
      setStorageError('This folder could not be saved. Check available browser storage.')
      return false
    }
  }

  async function addCharacter(event) {
    event.preventDefault()
    const name = characterName.trim()
    if (!name || !selectedFolder) return

    const characters = selectedFolder.characters ?? []
    if (characters.some((character) => character.toLocaleLowerCase() === name.toLocaleLowerCase())) {
      setStorageError('That character is already in this folder.')
      return
    }

    const saved = await saveFolder({ ...selectedFolder, characters: [...characters, name] })
    if (saved) {
      setCharacterName('')
      setIsAddingCharacter(false)
    }
  }

  async function removeCharacter(name) {
    if (!selectedFolder) return
    await saveFolder({
      ...selectedFolder,
      characters: (selectedFolder.characters ?? []).filter((character) => character !== name),
    })
  }
  async function savePrompt(prompt, { closeDialog = true } = {}) {
    try {
      const existingPrompt = prompts.find((item) => item.id === prompt.id)
      const isEditing = Boolean(existingPrompt)
      const latestTimestamp = prompts
        .filter((item) => item.folderId === selectedFolderId)
        .reduce((latest, item) => Math.max(latest, item.createdAt), 0)
      const savedPrompt = {
        ...prompt,
        folderId: selectedFolderId,
        createdAt: isEditing ? prompt.createdAt : Math.max(prompt.createdAt, latestTimestamp + 1),
          position: prompt.position ?? existingPrompt?.position ?? (isEditing ? folderPrompts.findIndex((item) => item.id === prompt.id) : folderPrompts.reduce((latest, item, index) => Math.max(latest, item.position ?? index), -1) + 1),
      }
      await saveRecord('prompts', savedPrompt)
      setPrompts((current) => isEditing
        ? current.map((item) => item.id === savedPrompt.id ? savedPrompt : item)
        : [savedPrompt, ...current])
      if (closeDialog) setPromptDialog(null)
      return true
    } catch {
      setStorageError('This recording could not be saved. Check available browser storage.')
      return false
    }
  }

  async function importScriptPrompts(lines, selectedCharacter, detectedCharacters) {
    if (!selectedFolder) throw new Error('Open a folder before importing a script.')
    const firstPosition = folderPrompts.reduce((latest, item, index) => Math.max(latest, item.position ?? index), -1) + 1
    const timestamp = Math.max(Date.now(), folderPrompts.reduce((latest, item) => Math.max(latest, item.createdAt ?? 0), 0) + 1)
    const preparedPrompts = []
    for (const [index, line] of lines.entries()) {
      const audio = await generateTtsAudio(line.text.trim())
      preparedPrompts.push({
        id: makeId(),
        folderId: selectedFolderId,
        speaker: line.character === selectedCharacter ? 'Myself' : 'Reader',
        character: line.character,
        audio,
        audioSource: 'tts',
        trimSilence: false,
        transcript: line.text.trim(),
        createdAt: timestamp + index,
        position: firstPosition + index,
      })
    }
    const updatedCharacters = [...new Set([...(selectedFolder.characters ?? []), ...detectedCharacters])]
    if (updatedCharacters.length !== (selectedFolder.characters ?? []).length) {
      const savedFolder = await saveFolder({ ...selectedFolder, characters: updatedCharacters })
      if (!savedFolder) throw new Error('The detected character names could not be saved.')
    }
    try {
      await savePromptRecords(preparedPrompts)
    } catch {
      throw new Error('The prompts could not be saved. Check browser storage and try again.')
    }
    setPrompts((current) => [...preparedPrompts, ...current])
    setIsImportingScript(false)
  }
  function editPrompt(prompt) {
    stopRun()
    stopRehearsal()
    setPromptDialog({ prompt })
  }

  function addSilenceRow() {
    savePrompt({ id: makeId(), type: 'silence', duration: 3, createdAt: Date.now() })
  }

  function adjustSilenceDuration(prompt, adjustment) {
    const duration = Math.max(1, Math.min(600, (prompt.duration ?? 3) + adjustment))
    savePrompt({ ...prompt, duration })
  }

  async function reorderPrompts(draggedId, targetId) {
    if (!draggedId || draggedId === targetId || runStatus || (rehearsalView && !['completed', 'error'].includes(rehearsalView.status))) return
    const ordered = [...folderPrompts]
    const draggedIndex = ordered.findIndex((prompt) => prompt.id === draggedId)
    const targetIndex = ordered.findIndex((prompt) => prompt.id === targetId)
    if (draggedIndex < 0 || targetIndex < 0) return

    const [draggedPrompt] = ordered.splice(draggedIndex, 1)
    ordered.splice(targetIndex, 0, draggedPrompt)
    const positioned = ordered.map((prompt, position) => ({ ...prompt, position }))

    try {
      const database = await openDatabase()
      await new Promise((resolve, reject) => {
        const transaction = database.transaction('prompts', 'readwrite')
        const store = transaction.objectStore('prompts')
        positioned.forEach((prompt) => store.put(prompt))
        transaction.oncomplete = resolve
        transaction.onerror = () => reject(transaction.error)
      })
      const byId = new Map(positioned.map((prompt) => [prompt.id, prompt]))
      setPrompts((current) => current.map((prompt) => byId.get(prompt.id) ?? prompt))
    } catch {
      setStorageError('The prompt order could not be saved. Please try again.')
    }
  }

  function startPromptDrag(event, promptId) {
    const dragHandle = event.target.closest('[data-prompt-drag-handle]')
    if (
      !canReorderPrompts ||
      event.button !== 0 ||
      (event.pointerType === 'touch' && !dragHandle) ||
      (event.target.closest('button, input, select, audio') && !dragHandle)
    ) return
    promptDragRef.current = { promptId, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, active: false }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  function movePromptDrag(event) {
    const drag = promptDragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    if (!drag.active && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 6) return
    drag.active = true
    document.body.classList.add('is-reordering-prompts')
    event.preventDefault()
    setDraggedPromptId(drag.promptId)
    const target = document.elementFromPoint(event.clientX, event.clientY)?.closest('[data-prompt-id]')
    setDragOverPromptId(target?.dataset.promptId ?? null)
  }

  function finishPromptDrag(event) {
    const drag = promptDragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    const target = document.elementFromPoint(event.clientX, event.clientY)?.closest('[data-prompt-id]')
    if (drag.active && target) reorderPrompts(drag.promptId, target.dataset.promptId)
    promptDragRef.current = null
    document.body.classList.remove('is-reordering-prompts')
    setDraggedPromptId(null)
    setDragOverPromptId(null)
  }

  function cancelPromptDrag() {
    promptDragRef.current = null
    document.body.classList.remove('is-reordering-prompts')
    setDraggedPromptId(null)
    setDragOverPromptId(null)
  }

  async function deleteFolder(folder) {
    const promptCount = prompts.filter((prompt) => prompt.folderId === folder.id).length
    const detail = promptCount ? ` and its ${promptCount} ${promptCount === 1 ? 'recording' : 'recordings'}` : ''
    if (!window.confirm(`Delete "${folder.name}"${detail}? This cannot be undone.`)) return

    try {
      if (selectedFolderId === folder.id) {
        stopRun()
        stopRehearsal()
      }
      await removeFolder(folder.id)
      setFolders((current) => current.filter((item) => item.id !== folder.id))
      setPrompts((current) => current.filter((prompt) => prompt.folderId !== folder.id))
      if (selectedFolderId === folder.id) {
        setSelectedFolderId(null)
      }
    } catch {
      setStorageError('This folder could not be deleted. Please try again.')
    }
  }

  async function deletePrompt(prompt) {
    const sequenceNumber = folderPrompts.findIndex((item) => item.id === prompt.id) + 1
    const label = formatPromptLabel(prompt, sequenceNumber)
    if (!window.confirm(`Delete "${label}"? This cannot be undone.`)) return
    try {
      stopRun()
      stopRehearsal()
      const database = await openDatabase()
      await new Promise((resolve, reject) => {
        const transaction = database.transaction('prompts', 'readwrite')
        transaction.objectStore('prompts').delete(prompt.id)
        transaction.oncomplete = resolve
        transaction.onerror = () => reject(transaction.error)
      })
      setPrompts((current) => current.filter((item) => item.id !== prompt.id))
    } catch {
      setStorageError('This recording could not be deleted. Please try again.')
    }
  }

  function stopRun() {
    playbackSessionRef.current += 1
    pendingRunSkipRef.current = null
    runPausedRef.current = false
    setIsRunPaused(false)
    const playback = activePlaybackRef.current
    if (playback) {
      playback.audio.pause()
      playback.finish(false)
      activePlaybackRef.current = null
    }
    setRunStatus(null)
  }

  function skipRunPrompt() {
    if (!runStatus) return
    const promptId = runStatus.promptId
    pendingRunSkipRef.current = promptId
    const playback = activePlaybackRef.current
    if (playback) {
      if (typeof playback.skip === 'function') playback.skip()
      else playback.finish?.(true)
      pendingRunSkipRef.current = null
    }
  }

  function pauseRun() {
    const playback = activePlaybackRef.current
    if (!runStatus || !playback) return
    runPausedRef.current = true
    setIsRunPaused(true)
    playback.paused = true
    playback.pause?.()
  }

  function resumeRun() {
    const playback = activePlaybackRef.current
    if (!runStatus || !playback) return
    runPausedRef.current = false
    setIsRunPaused(false)
    playback.paused = false
    playback.resume?.()
  }

  function restartRun() {
    stopRun()
    setRunError('')
    runPrompts()
  }

  function previousRunPrompt() {
    if (!runStatus || runStatus.index <= 1) return
    const previousIndex = runStatus.index - 2
    stopRun()
    setRunError('')
    runPrompts(previousIndex)
  }

  async function toggleRunPrompterFullscreen() {
    const panel = runPrompterRef.current
    if (!panel) return

    if (document.fullscreenElement === panel) {
      if (typeof document.exitFullscreen === 'function') {
        await Promise.resolve(document.exitFullscreen()).catch(() => {})
      } else {
        setIsRunPrompterFullscreen(false)
      }
      return
    }

    if (isRunPrompterFullscreen) {
      setIsRunPrompterFullscreen(false)
      return
    }

    if (typeof panel.requestFullscreen !== 'function') {
      setIsRunPrompterFullscreen(true)
      return
    }

    try {
      await panel.requestFullscreen()
    } catch {
      setIsRunPrompterFullscreen(true)
    }
  }

  function waitForRunSilence(prompt, label, queueIndex, queueLength, session) {
    const duration = silenceDurationSeconds(prompt)
    setRunStatus({ index: queueIndex, total: queueLength, title: label, promptId: prompt.id, silence: true, remainingSeconds: duration })
    return new Promise((resolve) => {
      let settled = false
      let timer
      let countdownInterval
      let remainingMs = duration * 1000
      let timerStartedAt = 0
      const updateCountdown = () => {
        const elapsed = runPausedRef.current ? 0 : performance.now() - timerStartedAt
        const remainingSeconds = Math.ceil(Math.max(0, remainingMs - elapsed) / 1000)
        setRunStatus((current) => current?.promptId === prompt.id && current.remainingSeconds !== remainingSeconds
          ? { ...current, remainingSeconds }
          : current)
      }
      const finish = (completed) => {
        if (settled) return
        settled = true
        window.clearTimeout(timer)
        window.clearInterval(countdownInterval)
        resolve(completed)
      }
      const schedule = () => {
        if (settled || runPausedRef.current) return
        timerStartedAt = performance.now()
        updateCountdown()
        timer = window.setTimeout(() => finish(true), remainingMs)
      }
      const playback = {
        audio: { pause: () => finish(false) },
        finish,
        skip: () => finish(true),
        promptId: prompt.id,
        sessionId: session,
        paused: runPausedRef.current,
        pause: () => {
          window.clearTimeout(timer)
          remainingMs = Math.max(0, remainingMs - (performance.now() - timerStartedAt))
          updateCountdown()
        },
        resume: schedule,
      }
      activePlaybackRef.current = playback
      if (pendingRunSkipRef.current === prompt.id) {
        pendingRunSkipRef.current = null
        playback.skip()
      }
      countdownInterval = window.setInterval(updateCountdown, 250)
      schedule()
    })
  }

  function updateRehearsalView(session, status = session.phase) {
    if (rehearsalSessionRef.current !== session) return
    const line = session.lines[session.index]
    const showMyselfWordFollow = line?.speaker === 'Myself' && ['listening', 'speech-end', 'paused'].includes(status)
    setRehearsalView({
      status,
      index: Math.max(0, Math.min(session.index, session.lines.length - 1)),
      total: session.lines.length,
      promptId: line?.id ?? null,
      speaker: line?.type === 'silence' ? 'Silence' : line?.speaker ?? '',
      label: line ? formatPromptLabel(line, session.index + 1) : '',
      dialogue: line?.type === 'silence' ? '(SILENCE)' : line?.transcript ?? '',
      remainingSeconds: session.phase === 'silence'
        ? Math.ceil(Math.max(0, session.silenceRemainingMs - (performance.now() - session.silenceStartedAt)) / 1000)
        : session.phase === 'paused' && session.resumePhase === 'silence'
          ? Math.ceil(Math.max(0, session.silenceRemainingMs) / 1000)
          : ['speaking', 'paused'].includes(session.phase) && (session.phase !== 'paused' || session.resumePhase === 'speaking') && Number.isFinite(session.readerEndTime)
            ? Math.ceil(Math.max(0, session.readerEndTime - (session.readerAudio?.audio.currentTime ?? session.readerEndTime)))
            : null,
      transcript: session.recognizedTranscript ?? '',
      matchedWordIndices: showMyselfWordFollow ? session.matchedWordIndices ?? [] : [],
      latestMatchedWordIndex: showMyselfWordFollow ? session.latestMatchedWordIndex ?? -1 : -1,
      triggerProgress: session.expectedCount
        ? `${session.recognizedTriggerWordCount ?? 0} / ${session.expectedCount}  / ${session.triggerWord} / `
        : '',
      message: session.message ?? '',
    })
  }

  function failRehearsal(session, message) {
    if (rehearsalSessionRef.current !== session) return
    disposeRehearsalSession(session)
    session.phase = 'error'
    session.message = message
    updateRehearsalView(session, 'error')
  }

  function completeRehearsal(session) {
    window.clearInterval(session.readerCountdownTimer)
    session.readerCountdownTimer = null
    session.phase = 'completed'
    session.message = 'Script complete.'
    stopRehearsalVoiceMonitor(session)
    updateRehearsalView(session, 'completed')
  }

  function scheduleMyselfAdvance(session) {
    if (rehearsalSessionRef.current !== session || !session.triggerSatisfied || session.phase === 'advancing') return

    session.phase = 'speech-end'
    session.message = ''
    updateRehearsalView(session, 'speech-end')
    if (!session.speechEnded || session.advanceTimer !== null) return

    session.advanceTimer = window.setTimeout(() => {
      session.advanceTimer = null
      const currentCount = countTriggerWordOccurrences(session.recognizedTranscript, session.triggerWord)
      if (
        rehearsalSessionRef.current !== session ||
        session.phase !== 'speech-end' ||
        !session.speechEnded ||
        currentCount < session.expectedCount
      ) return

      advanceMyselfLine(session)
    }, 300)
  }

  function advanceMyselfLine(session) {
    if (rehearsalSessionRef.current !== session || session.advancedLineIndex === session.index) return
    session.advancedLineIndex = session.index
    window.clearTimeout(session.advanceTimer)
    session.advanceTimer = null

    const recognition = session.recognition
    session.recognition = null
    if (recognition) {
      recognition.onresult = null
      recognition.onerror = null
      recognition.onend = null
      recognition.onspeechstart = null
      recognition.onspeechend = null
      recognition.stop()
    }

    session.index += 1
    session.phase = 'advancing'
    session.message = ''
    session.committedTranscript = ''
    session.recognizedTranscript = ''
    session.recognizedTriggerWordCount = 0
    session.matchedWordIndices = []
    session.latestMatchedWordIndex = -1
    session.triggerWord = ''
    session.expectedCount = 0
    session.triggerSatisfied = false
    session.speechEnded = false
    session.currentFinalTranscript = ''
    session.currentInterimTranscript = ''
    processRehearsalLine(session)
  }

  function advanceRehearsalSilence(session) {
    if (rehearsalSessionRef.current !== session || session.advancedLineIndex === session.index) return
    session.advancedLineIndex = session.index
    window.clearTimeout(session.silenceTimer)
    session.silenceTimer = null
    window.clearInterval(session.silenceCountdownInterval)
    session.silenceCountdownInterval = null
    session.index += 1
    session.phase = 'advancing'
    session.message = ''
    processRehearsalLine(session)
  }

  function startRehearsalSilence(session, line, durationMs = silenceDurationSeconds(line) * 1000) {
    session.phase = 'silence'
    session.silenceRemainingMs = Math.max(0, durationMs)
    session.silenceStartedAt = performance.now()
    session.silenceDisplayedRemainingSeconds = Math.ceil(session.silenceRemainingMs / 1000)
    session.message = ''
    updateRehearsalView(session, 'silence')
    window.clearTimeout(session.silenceTimer)
    window.clearInterval(session.silenceCountdownInterval)
    session.silenceCountdownInterval = window.setInterval(() => {
      if (session.phase !== 'silence') return
      const remainingSeconds = Math.ceil(Math.max(0, session.silenceRemainingMs - (performance.now() - session.silenceStartedAt)) / 1000)
      if (remainingSeconds === session.silenceDisplayedRemainingSeconds) return
      session.silenceDisplayedRemainingSeconds = remainingSeconds
      updateRehearsalView(session, 'silence')
    }, 250)
    session.silenceTimer = window.setTimeout(() => advanceRehearsalSilence(session), session.silenceRemainingMs)
  }

  async function startRehearsalVoiceMonitor(session) {
    if (session.voiceMonitorRequested) return
    session.voiceMonitorRequested = true

    const AudioContextConstructor = window.AudioContext || window.webkitAudioContext
    if (!navigator.mediaDevices?.getUserMedia || !AudioContextConstructor) return

    let stream
    let audioContext
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      audioContext = new AudioContextConstructor()
      if (rehearsalSessionRef.current !== session || session.phase === 'stopped') {
        stream.getTracks().forEach((track) => track.stop())
        await audioContext.close()
        return
      }

      const analyser = audioContext.createAnalyser()
      analyser.fftSize = 512
      audioContext.createMediaStreamSource(stream).connect(analyser)
      session.voiceStream = stream
      session.voiceAudioContext = audioContext
      const samples = new Uint8Array(analyser.fftSize)
      session.voiceMonitorTimer = window.setInterval(() => {
        if (!['listening', 'speech-end'].includes(session.phase)) return

        analyser.getByteTimeDomainData(samples)
        let energy = 0
        for (const sample of samples) {
          const amplitude = (sample - 128) / 128
          energy += amplitude * amplitude
        }
        const level = Math.sqrt(energy / samples.length)
        const now = performance.now()

        if (level >= 0.025) {
          session.lastVoiceAt = now
          session.voiceActivitySeen = true
          if (session.speechEnded || (session.phase === 'speech-end' && !session.triggerSatisfied)) {
            window.clearTimeout(session.advanceTimer)
            session.advanceTimer = null
            session.speechEnded = false
            session.phase = session.triggerSatisfied ? 'speech-end' : 'listening'
            session.message = ''
            updateRehearsalView(session, session.triggerSatisfied ? 'speech-end' : 'listening')
          }
        } else if (
          session.triggerSatisfied &&
          session.voiceActivitySeen &&
          !session.speechEnded &&
          session.lastVoiceAt !== null &&
          now - session.lastVoiceAt >= 650
        ) {
          session.speechEnded = true
          scheduleMyselfAdvance(session)
        }
      }, 50)

      audioContext.resume().catch(() => {})
    } catch (error) {
      stream?.getTracks().forEach((track) => track.stop())
      if (audioContext && audioContext.state !== 'closed') audioContext.close().catch(() => {})
      if (error?.name === 'NotAllowedError' || error?.name === 'PermissionDeniedError') {
        failRehearsal(session, 'Microphone access is required for speech-end detection. Allow microphone access and restart rehearsal.')
      }
    }
  }

  function startRehearsalListening(session) {
    if (rehearsalSessionRef.current !== session || session.phase === 'paused') return
    const SpeechRecognitionApi = window.SpeechRecognition || window.webkitSpeechRecognition
    if (!SpeechRecognitionApi) {
      failRehearsal(session, 'Speech recognition is not supported in this browser.')
      return
    }

    const line = session.lines[session.index]
    if (session.activeLineIndex !== session.index) {
      const expectedWords = normalizeTranscriptWords(line.transcript)
      session.triggerWord = expectedWords.at(-1) ?? ''
      session.expectedCount = countTriggerWordOccurrences(line.transcript, session.triggerWord)
      session.recognizedTranscript = ''
      session.recognizedTriggerWordCount = 0
      session.committedTranscript = ''
      session.currentFinalTranscript = ''
      session.currentInterimTranscript = ''
      session.matchedWordIndices = []
      session.latestMatchedWordIndex = -1
      session.triggerSatisfied = false
      session.speechEnded = false
      session.voiceActivitySeen = false
      session.lastVoiceAt = null
      session.advanceTimer = null
      session.advancedLineIndex = null
      session.activeLineIndex = session.index
      if (!session.triggerWord || session.expectedCount === 0) {
        failRehearsal(session, `${formatPromptLabel(line, session.index + 1)} has no usable final word in its transcript.`)
        return
      }
    }

    session.phase = session.triggerSatisfied ? 'speech-end' : 'listening'
    session.message = ''
    updateRehearsalView(session, session.triggerSatisfied ? 'speech-end' : 'listening')
    startRehearsalVoiceMonitor(session)

    const recognition = new SpeechRecognitionApi()
    recognition.continuous = true
    recognition.interimResults = true
    recognition.maxAlternatives = 1
    recognition.lang = 'en-US'
    session.recognition = recognition

    recognition.onresult = (event) => {
      if (rehearsalSessionRef.current !== session || session.recognition !== recognition || !['listening', 'speech-end', 'paused'].includes(session.phase)) return
      const finalSegments = []
      const interimSegments = []
      for (const result of Array.from(event.results)) {
        const text = result[0]?.transcript?.trim()
        if (!text) continue
        if (result.isFinal) finalSegments.push(text)
        else interimSegments.push(text)
      }
      session.currentFinalTranscript = finalSegments.join(' ')
      session.currentInterimTranscript = interimSegments.join(' ')
      const finalTranscript = [session.committedTranscript, session.currentFinalTranscript].filter(Boolean).join(' ')
      session.recognizedTranscript = [finalTranscript, session.currentInterimTranscript].filter(Boolean).join(' ').trim()
      session.recognizedTriggerWordCount = countTriggerWordOccurrences(session.recognizedTranscript, session.triggerWord)
      session.triggerSatisfied = session.recognizedTriggerWordCount >= session.expectedCount
      const line = session.lines[session.index]
      const newMatches = findTranscriptWordMatches(line.transcript, session.recognizedTranscript)
      if (newMatches.length > 0) {
        const matchedWords = new Set(session.matchedWordIndices)
        newMatches.forEach((wordIndex) => matchedWords.add(wordIndex))
        session.matchedWordIndices = [...matchedWords].sort((first, second) => first - second)
        session.latestMatchedWordIndex = Math.max(session.latestMatchedWordIndex, ...newMatches)
      }

      if (session.phase === 'paused') {
        updateRehearsalView(session, 'paused')
        return
      }

      if (session.triggerSatisfied) {
        scheduleMyselfAdvance(session)
      } else {
        window.clearTimeout(session.advanceTimer)
        session.advanceTimer = null
        if (session.phase === 'speech-end') session.phase = 'listening'
        session.message = ''
        const status = session.speechEnded && session.recognizedTriggerWordCount > 0 ? 'waiting' : 'listening'
        updateRehearsalView(session, status)
      }
    }

    recognition.onspeechstart = () => {
      if (rehearsalSessionRef.current !== session || session.recognition !== recognition || session.phase === 'paused') return
      window.clearTimeout(session.advanceTimer)
      session.advanceTimer = null
      session.speechEnded = false
      session.voiceActivitySeen = true
      session.lastVoiceAt = performance.now()
      session.message = ''
      session.phase = session.triggerSatisfied ? 'speech-end' : 'listening'
      updateRehearsalView(session, session.triggerSatisfied ? 'speech-end' : 'listening')
    }

    recognition.onspeechend = () => {
      if (rehearsalSessionRef.current !== session || session.recognition !== recognition || session.phase === 'paused') return
      if (!session.voiceActivitySeen) return
      session.speechEnded = true
      if (session.triggerSatisfied) scheduleMyselfAdvance(session)
      else updateRehearsalView(session, session.recognizedTriggerWordCount > 0 ? 'waiting' : 'listening')
    }

    recognition.onerror = (event) => {
      if (rehearsalSessionRef.current !== session || session.recognition !== recognition || !['listening', 'speech-end'].includes(session.phase)) return
      if (event.error === 'no-speech') {
        session.message = 'No speech detected. Keep speaking or try the line again.'
        updateRehearsalView(session, 'listening')
        return
      }
      const message = event.error === 'not-allowed' || event.error === 'service-not-allowed'
        ? 'Microphone access was denied. Allow microphone access and restart rehearsal.'
        : `Speech recognition stopped${event.error ? ` (${event.error})` : ''}. Restart rehearsal to try again.`
      failRehearsal(session, message)
    }

    recognition.onend = () => {
      if (rehearsalSessionRef.current !== session || session.recognition !== recognition) return
      session.recognition = null
      session.committedTranscript = [session.committedTranscript, session.currentFinalTranscript].filter(Boolean).join(' ')
      session.currentFinalTranscript = ''
      session.currentInterimTranscript = ''
      session.recognizedTranscript = session.committedTranscript
      session.recognizedTriggerWordCount = countTriggerWordOccurrences(session.recognizedTranscript, session.triggerWord)
      session.triggerSatisfied = session.recognizedTriggerWordCount >= session.expectedCount

      if (session.phase === 'paused') {
        updateRehearsalView(session, 'paused')
      } else if (session.triggerSatisfied && session.speechEnded) {
        scheduleMyselfAdvance(session)
      } else if (['listening', 'waiting', 'speech-end'].includes(session.phase)) {
        startRehearsalListening(session)
      } else {
        updateRehearsalView(session, session.phase)
      }
    }

    try {
      recognition.start()
    } catch {
      failRehearsal(session, 'Could not start speech recognition. Restart rehearsal to try again.')
    }
  }

  function processRehearsalLine(session) {
    if (rehearsalSessionRef.current !== session) return
    const line = session.lines[session.index]
    if (!line) {
      completeRehearsal(session)
      return
    }
    window.clearInterval(session.readerCountdownTimer)
    session.readerCountdownTimer = null
    session.readerEndTime = null

    if (line.type === 'silence') {
      startRehearsalSilence(session, line)
      return
    }

    if (!line.transcript?.trim()) {
      failRehearsal(session, `${formatPromptLabel(line, session.index + 1)} has no transcript. Add one before rehearsing.`)
      return
    }

    if (line.speaker === 'Myself') {
      startRehearsalListening(session)
      return
    }

    if (line.speaker !== 'Reader') {
      failRehearsal(session, `${formatPromptLabel(line, session.index + 1)} has an unsupported speaker.`)
      return
    }

    if (!line.audio || typeof Audio !== 'function') {
      failRehearsal(session, `${formatPromptLabel(line, session.index + 1)} has no playable Reader recording.`)
      return
    }

    session.phase = 'speaking'
    session.message = ''
    session.recognizedTranscript = ''
    session.matchedWordIndices = []
    session.latestMatchedWordIndex = -1
    updateRehearsalView(session, 'speaking')
    const objectUrl = URL.createObjectURL(line.audio)
    const audio = new Audio(objectUrl)
    setReaderPlaybackPitch(audio, 'Reader', readerPitch)
    const playback = { audio, objectUrl }
    session.readerAudio = playback
    const finishPlayback = () => {
      if (rehearsalSessionRef.current !== session || session.readerAudio !== playback || session.phase !== 'speaking') return
      window.clearInterval(session.readerCountdownTimer)
      session.readerCountdownTimer = null
      audio.onended = null
      audio.onerror = null
      playback.trimCleanup?.()
      URL.revokeObjectURL(objectUrl)
      session.readerAudio = null
      session.index += 1
      processRehearsalLine(session)
    }
    audio.onended = finishPlayback
    audio.onerror = () => {
      if (rehearsalSessionRef.current !== session || session.readerAudio !== playback || session.phase !== 'speaking') return
      failRehearsal(session, `The Reader recording ${formatPromptLabel(line, session.index + 1)} could not be played.`)
    }
    const preparePlayback = async () => {
      if (!line.trimSilence) await waitForAudioMetadata(audio)
      return prepareAudioTrim(audio, line.audio, line.trimSilence, finishPlayback)
    }
    preparePlayback().then(({ cleanup, duration }) => {
      playback.trimCleanup = cleanup
      if (rehearsalSessionRef.current !== session || session.readerAudio !== playback) {
        cleanup()
        return
      }
      if (session.phase !== 'speaking') {
        if (session.phase !== 'paused') cleanup()
        return
      }
      session.readerEndTime = audio.currentTime + duration
      session.readerCountdownTimer = window.setInterval(() => updateRehearsalView(session, 'speaking'), 250)
      updateRehearsalView(session, 'speaking')
      try {
        audio.play().catch(() => {
          if (rehearsalSessionRef.current === session && session.readerAudio === playback && session.phase === 'speaking') {
            failRehearsal(session, 'Reader playback was interrupted. Restart rehearsal to try again.')
          }
        })
      } catch {
        failRehearsal(session, 'Reader playback could not be started. Restart rehearsal to try again.')
      }
    })
  }

  function stopRehearsal() {
    const session = rehearsalSessionRef.current
    rehearsalSessionRef.current = null
    disposeRehearsalSession(session)
    setRehearsalView(null)
  }

  async function toggleTeleprompterFullscreen() {
    const panel = rehearsalPanelRef.current
    if (!panel) return

    if (document.fullscreenElement === panel) {
      if (typeof document.exitFullscreen === 'function') {
        await Promise.resolve(document.exitFullscreen()).catch(() => {})
      } else {
        setIsTeleprompterFullscreen(false)
      }
      return
    }

    if (isTeleprompterFullscreen) {
      setIsTeleprompterFullscreen(false)
      return
    }

    if (typeof panel.requestFullscreen !== 'function') {
      setIsTeleprompterFullscreen(true)
      return
    }

    try {
      await panel.requestFullscreen()
    } catch {
      setIsTeleprompterFullscreen(true)
    }
  }

  function startRehearsal() {
    stopRun()
    stopRehearsal()
    const session = {
      lines: [...folderPrompts],
      index: 0,
      phase: 'starting',
      committedTranscript: '',
      currentFinalTranscript: '',
      currentInterimTranscript: '',
      recognition: null,
      readerAudio: null,
      lastSkippedIndex: -1,
      readerEndTime: null,
      readerCountdownTimer: null,
      message: '',
    }
    rehearsalSessionRef.current = session
    if (session.lines.length === 0) {
      failRehearsal(session, 'Add prompts to this folder before starting rehearsal.')
      return
    }
    processRehearsalLine(session)
  }

  function pauseRehearsal() {
    const session = rehearsalSessionRef.current
    if (!session || !['speaking', 'listening', 'speech-end', 'silence'].includes(session.phase)) return
    session.resumePhase = session.phase
    session.phase = 'paused'
    window.clearInterval(session.readerCountdownTimer)
    session.readerCountdownTimer = null
    window.clearTimeout(session.advanceTimer)
    session.advanceTimer = null
    if (session.resumePhase === 'speaking') {
      session.readerAudio?.audio.pause()
    } else if (session.resumePhase === 'silence') {
      session.silenceRemainingMs = Math.max(0, session.silenceRemainingMs - (performance.now() - session.silenceStartedAt))
      session.silenceDisplayedRemainingSeconds = Math.ceil(session.silenceRemainingMs / 1000)
      window.clearTimeout(session.silenceTimer)
      session.silenceTimer = null
      window.clearInterval(session.silenceCountdownInterval)
      session.silenceCountdownInterval = null
    }
    else {
      session.voiceActivitySeen = false
      session.lastVoiceAt = null
      session.recognition?.stop()
    }
    updateRehearsalView(session, 'paused')
  }

  function skipRehearsalCurrent() {
    const session = rehearsalSessionRef.current
    if (!session || !['speaking', 'listening', 'speech-end', 'silence', 'paused'].includes(session.phase)) return
    const wasPaused = session.phase === 'paused'
    const line = session.lines[session.index]
    if (!line) return
    window.clearTimeout(session.advanceTimer)
    window.clearTimeout(session.silenceTimer)
    window.clearInterval(session.silenceCountdownInterval)
    window.clearInterval(session.readerCountdownTimer)
    const recognition = session.recognition
    session.recognition = null
    if (recognition) {
      recognition.onresult = recognition.onerror = recognition.onend = null
      recognition.onspeechstart = recognition.onspeechend = null
      recognition.abort()
    }
    stopRehearsalReaderPlayback(session)
    session.index += 1
    if (wasPaused) {
      session.phase = 'paused'
      session.resumePhase = 'starting'
      updateRehearsalView(session, 'paused')
    } else {
      session.phase = 'advancing'
      processRehearsalLine(session)
    }
  }

  function previousRehearsalPrompt() {
    const session = rehearsalSessionRef.current
    if (!session || session.index <= 0) return
    const wasPaused = session.phase === 'paused'
    window.clearTimeout(session.advanceTimer)
    window.clearTimeout(session.silenceTimer)
    window.clearInterval(session.silenceCountdownInterval)
    window.clearInterval(session.readerCountdownTimer)
    const recognition = session.recognition
    session.recognition = null
    if (recognition) {
      recognition.onresult = recognition.onerror = recognition.onend = null
      recognition.onspeechstart = recognition.onspeechend = null
      recognition.abort()
    }
    stopRehearsalReaderPlayback(session)
    session.index -= 1
    session.advancedLineIndex = null
    session.activeLineIndex = null
    if (wasPaused) {
      session.phase = 'paused'
      session.resumePhase = 'starting'
      updateRehearsalView(session, 'paused')
    } else {
      session.phase = 'advancing'
      processRehearsalLine(session)
    }
  }

  function resumeRehearsal() {
    const session = rehearsalSessionRef.current
    if (!session || session.phase !== 'paused') return
    if (session.resumePhase === 'starting') {
      session.phase = 'advancing'
      processRehearsalLine(session)
      return
    }
    session.phase = session.resumePhase ?? 'listening'
    if (session.phase === 'silence') {
      startRehearsalSilence(session, session.lines[session.index], session.silenceRemainingMs)
    } else if (session.phase === 'speaking') {
      updateRehearsalView(session, 'speaking')
      session.readerCountdownTimer = window.setInterval(() => updateRehearsalView(session, 'speaking'), 250)
      session.readerAudio?.audio.play().catch(() => {
        failRehearsal(session, 'Reader playback could not be resumed. Restart rehearsal to try again.')
      })
    } else if (session.triggerSatisfied) {
      session.phase = 'speech-end'
      if (session.speechEnded) scheduleMyselfAdvance(session)
      else {
        updateRehearsalView(session, 'speech-end')
        if (!session.recognition) startRehearsalListening(session)
      }
    } else {
      session.phase = 'listening'
      updateRehearsalView(session, 'listening')
      if (!session.recognition) startRehearsalListening(session)
    }
  }

  async function waitSilentlyForPrompt(prompt, label, queueIndex, queueLength, session) {
    const objectUrl = URL.createObjectURL(prompt.audio)
    const audio = new Audio(objectUrl)
    audio.preload = 'metadata'

    let resolveDuration
    let settled = false
    let skipRequested = false
    let finishCountdown = null
    const finishMetadata = (duration) => {
      if (settled) return
      settled = true
      audio.removeEventListener('loadedmetadata', onMetadata)
      audio.removeEventListener('error', onError)
      resolveDuration(duration)
    }
    const onMetadata = () => finishMetadata(audio.duration)
    const onError = () => finishMetadata(null)
    const durationPromise = new Promise((resolve) => { resolveDuration = resolve })
    const playback = {
      audio,
      promptId: prompt.id,
      finish: (didFinish) => {
        if (finishCountdown) finishCountdown(didFinish)
        else finishMetadata(didFinish ? 'skip' : null)
      },
      skip: () => {
        skipRequested = true
        if (finishCountdown) finishCountdown(true)
        else finishMetadata('skip')
      },
      paused: runPausedRef.current,
    }
    const cleanupAudio = () => {
      audio.pause()
      audio.removeAttribute('src')
      audio.load()
      URL.revokeObjectURL(objectUrl)
      if (activePlaybackRef.current === playback) activePlaybackRef.current = null
    }

    activePlaybackRef.current = playback
    if (pendingRunSkipRef.current === prompt.id) {
      pendingRunSkipRef.current = null
      playback.skip()
    }
    audio.addEventListener('loadedmetadata', onMetadata)
    audio.addEventListener('error', onError)
    audio.load()

    if (audio.readyState >= 1) finishMetadata(audio.duration)
    const duration = await durationPromise
    if (skipRequested) {
      cleanupAudio()
      return true
    }
    if (session !== playbackSessionRef.current) {
      URL.revokeObjectURL(objectUrl)
      if (activePlaybackRef.current === playback) activePlaybackRef.current = null
      return false
    }

    if (!Number.isFinite(duration) || duration < 0) {
      URL.revokeObjectURL(objectUrl)
      if (activePlaybackRef.current === playback) activePlaybackRef.current = null
      setRunError(`Could not read the recording duration for "${label}".`)
      return false
    }

    const bounds = prompt.trimSilence ? await getAudioBounds(prompt.audio) : null
    if (skipRequested) {
      cleanupAudio()
      return true
    }
    if (session !== playbackSessionRef.current) {
      URL.revokeObjectURL(objectUrl)
      if (activePlaybackRef.current === playback) activePlaybackRef.current = null
      return false
    }
    const playbackDuration = bounds?.end > bounds?.start ? bounds.end - bounds.start : duration

    setRunStatus({ index: queueIndex, total: queueLength, title: label, promptId: prompt.id, silence: true, remainingSeconds: Math.ceil(playbackDuration) })

    const completed = await new Promise((resolve) => {
      let timer
      let countdownInterval
      let isComplete = false
      let remainingMs = playbackDuration * 1000
      let timerStartedAt = 0
      const updateCountdown = () => {
        const elapsed = runPausedRef.current ? 0 : performance.now() - timerStartedAt
        const remainingSeconds = Math.ceil(Math.max(0, remainingMs - elapsed) / 1000)
        setRunStatus((current) => current?.promptId === prompt.id && current.remainingSeconds !== remainingSeconds
          ? { ...current, remainingSeconds }
          : current)
      }
      finishCountdown = (didFinish) => {
        if (isComplete) return
        isComplete = true
        window.clearTimeout(timer)
        window.clearInterval(countdownInterval)
        resolve(didFinish)
      }
      playback.pause = () => {
        window.clearTimeout(timer)
        remainingMs = Math.max(0, remainingMs - (performance.now() - timerStartedAt))
        updateCountdown()
      }
      playback.resume = () => {
        if (isComplete || playback.paused) return
        timerStartedAt = performance.now()
        updateCountdown()
        timer = window.setTimeout(() => finishCountdown(true), remainingMs)
      }
      countdownInterval = window.setInterval(updateCountdown, 250)
      playback.resume()
    })

    cleanupAudio()
    return completed
  }

  async function runPrompts(startIndex = 0) {
    stopRehearsal()
    pendingRunSkipRef.current = null
    runPausedRef.current = false
    setIsRunPaused(false)
    const queue = runQueue
    if (queue.length === 0) return

    setRunError('')
    const session = playbackSessionRef.current + 1
    playbackSessionRef.current = session

    for (let index = startIndex; index < queue.length; index += 1) {
      if (session !== playbackSessionRef.current) return
      const prompt = queue[index]
      if (pendingRunSkipRef.current === prompt.id) {
        pendingRunSkipRef.current = null
        continue
      }
      const sequenceNumber = folderPrompts.findIndex((item) => item.id === prompt.id) + 1
      const label = formatPromptLabel(prompt, sequenceNumber)

      if (prompt.type === 'silence') {
        const completed = await waitForRunSilence(prompt, label, index + 1, queue.length, session)
        if (session !== playbackSessionRef.current) return
        if (!completed) break
        if (activePlaybackRef.current?.promptId === prompt.id) activePlaybackRef.current = null
        continue
      }

      if (myselfSilentMode && prompt.speaker === 'Myself') {
        const completed = await waitSilentlyForPrompt(prompt, label, index + 1, queue.length, session)
        if (session !== playbackSessionRef.current) return
        if (activePlaybackRef.current?.promptId === prompt.id) activePlaybackRef.current = null
        if (!completed) {
          if (!runError) setRunError(`Silent wait stopped at "${label}".`)
          break
        }
        continue
      }

      const objectUrl = URL.createObjectURL(prompt.audio)
      const audio = new Audio(objectUrl)
      setReaderPlaybackPitch(audio, prompt.speaker, readerPitch)
      setRunStatus({ index: index + 1, total: queue.length, title: label, promptId: prompt.id, silence: false })
      const played = await new Promise((resolve) => {
        let settled = false
        let trimReady = false
        let trimCleanup = () => {}
        let countdownInterval = null
        const finish = (didPlay) => {
          if (settled) return
          settled = true
          window.clearInterval(countdownInterval)
          countdownInterval = null
          trimCleanup()
          audio.removeEventListener('ended', onEnded)
          audio.removeEventListener('error', onError)
          resolve(didPlay)
        }
        const onEnded = () => {
          finish(true)
        }
        const onError = () => {
          finish(false)
        }
        const pausePlayback = () => {
          audio.pause()
        }
        const resumePlayback = () => {
          if (settled || runPausedRef.current || !trimReady) return
          audio.play().catch(() => finish(false))
        }
        audio.addEventListener('ended', onEnded)
        audio.addEventListener('error', onError)
        const playback = {
          audio,
          finish,
          skip: () => {
            // Settle the playback promise before pausing the media element. A
            // pause can race an ended/error event; settling first guarantees
            // the run loop treats this click as a completed prompt and moves on.
            finish(true)
            audio.pause()
            trimCleanup()
          },
          promptId: prompt.id,
          sessionId: session,
          paused: runPausedRef.current,
          pause: pausePlayback,
          resume: resumePlayback,
          trimCleanup: () => trimCleanup(),
        }
        activePlaybackRef.current = playback
        if (pendingRunSkipRef.current === prompt.id) {
          pendingRunSkipRef.current = null
          playback.skip()
        }
        waitForAudioMetadata(audio).then(() => prepareAudioTrim(audio, prompt.audio, prompt.trimSilence, () => {
          finish(true)
        })).then(({ cleanup, duration }) => {
          if (session !== playbackSessionRef.current) {
            cleanup()
            finish(false)
            return
          }
          trimCleanup = cleanup
          trimReady = true
          const safeDuration = Number.isFinite(duration) ? duration : Math.max(0, audio.duration - audio.currentTime)
          const playbackEndTime = audio.currentTime + safeDuration
          const updatePromptTimer = () => {
            const remainingSeconds = Math.ceil(Math.max(0, playbackEndTime - audio.currentTime))
            setRunStatus((current) => current?.promptId === prompt.id && current.remainingSeconds !== remainingSeconds
              ? { ...current, remainingSeconds }
              : current)
          }
          updatePromptTimer()
          countdownInterval = window.setInterval(updatePromptTimer, 250)
          if (settled) {
            trimCleanup()
            return
          }
          if (!runPausedRef.current) resumePlayback()
        })
      })

      URL.revokeObjectURL(objectUrl)
      if (activePlaybackRef.current?.audio === audio) activePlaybackRef.current = null
      if (session !== playbackSessionRef.current) return
      if (!played) {
        setRunError(`Playback stopped at "${label}".`)
        break
      }
    }

    if (session === playbackSessionRef.current) {
      runPausedRef.current = false
      setIsRunPaused(false)
      setRunStatus(null)
    }
  }

  function toggleRunSpeaker(speaker) {
    setRunSpeakers((current) => ({ ...current, [speaker]: !current[speaker] }))
  }

  return (
    <main className={[
      'app-shell',
      isTeleprompterFullscreen && 'has-teleprompter-fullscreen',
      isLightMode && 'theme-light',
    ].filter(Boolean).join(' ')}>
      <header className="topbar">
        <div className="brand-group">
          <button className="brand" type="button" onClick={() => { stopRun(); stopRehearsal(); setSelectedFolderId(null) }} aria-label="Prompt Library home">
            <span className="brand-mark" aria-hidden="true">P<span>/</span></span>
            <span className="brand-name">PROMPT<span>LIBRARY</span></span>
          </button>
          {!selectedFolder && <span className="app-version">{`Ella v${APP_VERSION}`}</span>}
        </div>
        <div className="topbar-tools">
          <div className="topbar-meta"><span className="status-dot" /> LOCAL ARCHIVE</div>
          <button
            className="theme-toggle"
            type="button"
            aria-label={`Switch to ${isLightMode ? 'dark' : 'light'} mode`}
            aria-pressed={isLightMode}
            onClick={() => setIsLightMode((current) => !current)}
          >
            <span className="theme-toggle-icon" aria-hidden="true">{isLightMode ? '\u25D0' : '\u25D1'}</span>
            <span>{isLightMode ? 'Dark mode' : 'Light mode'}</span>
          </button>
        </div>
      </header>

      {storageError && <div className="notice" role="status">{storageError}<button type="button" onClick={() => setStorageError('')} aria-label="Dismiss message">{'\u00D7'}</button></div>}

      <section className={selectedFolder ? 'workspace folder-workspace' : 'workspace'}>
        {selectedFolder ? (
          <>
            <div className="page-toolbar">
              <button className="back-button" type="button" onClick={() => { stopRun(); stopRehearsal(); setSelectedFolderId(null) }}><span aria-hidden="true">{'\u2190'}</span> All folders</button>
              <span className="toolbar-divider" />
              <span className="breadcrumb-current">{selectedFolder.name}</span>
              <div className="folder-toolbar-actions"><button className="quiet-button import-script-button" type="button" onClick={() => setIsImportingScript(true)}>Import Script</button><button className="primary-button add-prompt-button" type="button" onClick={() => setPromptDialog({})}><span aria-hidden="true">+</span> Add prompt</button></div>
            </div>

            <div className="page-heading folder-heading">
              <div>
                <p className="eyebrow">FOLDER <span>///</span> {folderPrompts.length.toString().padStart(2, '0')} RECORDINGS</p>
                <h1>{selectedFolder.name}</h1>
              </div>
            </div>

            <div className={`run-panel${runStatus ? ' is-running' : ''}${isRunPrompterFullscreen && runStatus ? ' is-fullscreen' : ''}`} ref={runPrompterRef}>
              <div className="run-panel-header">
                <div className="run-copy">
                  <p className="eyebrow">SEQUENCE PLAYBACK</p>
                  <p>{runModeDescription}</p>
                </div>
                <div className="run-speaker-settings" role="group" aria-label="Include prompts from">
                  <label className="speaker-toggle">
                    <span>Reader</span>
                    <input type="checkbox" checked={runSpeakers.Reader} disabled={Boolean(runStatus)} onChange={() => toggleRunSpeaker('Reader')} aria-label="Include Reader prompts" />
                    <span className="switch-track" aria-hidden="true" />
                  </label>
                  <label className="speaker-toggle">
                    <span>Myself</span>
                    <input type="checkbox" checked={runSpeakers.Myself} disabled={Boolean(runStatus)} onChange={() => toggleRunSpeaker('Myself')} aria-label="Include Myself prompts" />
                    <span className="switch-track" aria-hidden="true" />
                  </label>
                </div>
                <div className="run-controls">
                  {runStatus && <>
                    <button className="rehearsal-control run-icon-control run-fullscreen-control" type="button" onClick={toggleRunPrompterFullscreen} aria-label={isRunPrompterFullscreen ? 'Exit full screen' : 'Enter full screen'} title={isRunPrompterFullscreen ? 'Exit full screen' : 'Enter full screen'}>
                      <RunControlIcon name={isRunPrompterFullscreen ? 'exit-fullscreen' : 'fullscreen'} />
                    </button>
                    <button className="rehearsal-control run-icon-control" type="button" onClick={previousRunPrompt} disabled={runStatus.index <= 1} aria-label="Previous prompt" title="Go to previous prompt">
                      <RunControlIcon name="previous" />
                    </button>
                    <button className="rehearsal-control run-icon-control run-pause-control" type="button" onClick={isRunPaused ? resumeRun : pauseRun} aria-label={isRunPaused ? 'Resume playback' : 'Pause playback'} title={isRunPaused ? 'Resume playback' : 'Pause playback'}>
                      <RunControlIcon name={isRunPaused ? 'play' : 'pause'} />
                    </button>
                    <button className="rehearsal-control run-icon-control" type="button" onClick={skipRunPrompt} aria-label="Skip prompt" title="Skip to next prompt">
                      <RunControlIcon name="skip" />
                    </button>
                    <button className="rehearsal-control run-icon-control run-restart-control" type="button" onClick={restartRun} disabled={selectedRunCount === 0} aria-label="Restart playback" title="Restart playback">
                      <RunControlIcon name="restart" />
                    </button>
                  </>}
                  <button
                    className={runStatus ? 'rehearsal-control run-icon-control run-stop-control' : 'run-with-me-button run-action-control'}
                    type="button"
                    onClick={runStatus ? stopRun : () => runPrompts()}
                    disabled={!runStatus && selectedRunCount === 0}
                    aria-label={runStatus ? 'Stop playback' : 'Run sequence'}
                    title={runStatus ? 'Stop playback' : 'Run sequence'}
                  >
                    {runStatus ? <RunControlIcon name="stop" /> : <><RunControlIcon name="play" />Run</>}
                  </button>
                </div>
              </div>
              {runStatus && <section className="run-prompter-content" aria-label="Run transcript prompter">
                <div className="run-prompter-header">
                  <div>
                    <p className="eyebrow">RUN PROMPTER</p>
                  </div>
                </div>
                <div className="run-prompter-lines">
                  {prompterPrompts.map((prompt) => {
                    const isActive = prompt.id === runStatus.promptId
                    return (
                      <div
                        className={isActive ? 'run-prompter-line is-active' : 'run-prompter-line'}
                        key={prompt.id}
                      >
                        <p className="run-prompter-label rehearsal-line-label">
                          {formatPromptLabel(prompt, folderPrompts.findIndex((item) => item.id === prompt.id) + 1)}
                        </p>
                        <p className="run-prompter-text prompter-display-text">
                          {prompt.type === 'silence'
                            ? '(SILENCE)'
                            : prompt.transcript}
                        </p>
                      </div>
                    )
                  })}
                </div>
                {runStatus.remainingSeconds !== null && runStatus.remainingSeconds !== undefined && <span className="silence-countdown run-prompter-countdown" aria-live="off">{runStatus.silence ? formatTime(runStatus.remainingSeconds) : <>RECORDING TIME&nbsp; {formatTime(runStatus.remainingSeconds)}</>}</span>}
              </section>}
            </div>
            <section
              className={`rehearsal-panel${isRehearsalRunning ? ' is-running' : ''}${isTeleprompterFullscreen && isRehearsalRunning ? ' is-fullscreen' : ''}`}
              aria-label="Run With Me rehearsal"
              ref={rehearsalPanelRef}
            >
              <div className="rehearsal-heading">
                <div>
                  <p className="eyebrow">INTERACTIVE REHEARSAL</p>
                  <p>Hear Reader recordings, then speak each Myself line.</p>
                </div>
                {!isRehearsalRunning && (
                  <div className="rehearsal-controls">
                    <button className="run-with-me-button" type="button" onClick={startRehearsal} disabled={folderPrompts.length === 0}>
                      <span aria-hidden="true">{'\u25B6'}</span> Run With Me
                    </button>
                  </div>
                )}
                {isRehearsalRunning && (
                  <div className="rehearsal-controls">
                    <button className="rehearsal-control run-icon-control rehearsal-fullscreen-control" type="button" onClick={toggleTeleprompterFullscreen} aria-label={isTeleprompterFullscreen ? 'Exit full screen' : 'Enter full screen'} title={isTeleprompterFullscreen ? 'Exit full screen' : 'Enter full screen'}>
                      <RunControlIcon name={isTeleprompterFullscreen ? 'exit-fullscreen' : 'fullscreen'} />
                    </button>
                    <button className="rehearsal-control run-icon-control" type="button" onClick={previousRehearsalPrompt} disabled={(rehearsalSessionRef.current?.index ?? 0) <= 0} aria-label="Previous prompt" title="Go to previous prompt"><RunControlIcon name="previous" /></button>
                    <button className="rehearsal-control run-icon-control rehearsal-pause-control" type="button" onClick={rehearsalView.status === 'paused' ? resumeRehearsal : pauseRehearsal} aria-label={rehearsalView.status === 'paused' ? 'Resume rehearsal' : 'Pause rehearsal'} title={rehearsalView.status === 'paused' ? 'Resume rehearsal' : 'Pause rehearsal'}>
                      <RunControlIcon name={rehearsalView.status === 'paused' ? 'play' : 'pause'} />
                    </button>
                    <button className="rehearsal-control run-icon-control" type="button" onClick={skipRehearsalCurrent} aria-label="Skip prompt" title="Skip to next prompt"><RunControlIcon name="skip" /></button>
                    <button className="rehearsal-control run-icon-control rehearsal-restart-control" type="button" onClick={startRehearsal} aria-label="Restart rehearsal" title="Restart rehearsal"><RunControlIcon name="restart" /></button>
                    <button className="rehearsal-control run-icon-control rehearsal-action-control" type="button" onClick={stopRehearsal} aria-label="Stop rehearsal" title="Stop rehearsal"><RunControlIcon name="stop" /></button>
                  </div>
                )}
              </div>
              {isRehearsalRunning && (
                <div className={`rehearsal-session${rehearsalView.speaker === 'Myself' && rehearsalView.status !== 'completed' && !isTeleprompterFullscreen ? ' has-user-transcript' : ''}`} aria-live="polite">
                  <div className={`rehearsal-run-status${rehearsalIsListening ? ' is-listening' : ''}`} aria-live="polite">
                    <i aria-hidden="true" />
                    <strong>{rehearsalStatusLabel}</strong>
                  </div>
                  {(rehearsalView.label || rehearsalView.dialogue) && (
                    <div className="prompter-active-line">
                      {rehearsalView.label && <p className="rehearsal-line-label run-prompter-label">{rehearsalView.label}</p>}
                      {rehearsalView.dialogue && (
                        <p className={isTeleprompterFullscreen ? 'rehearsal-dialogue prompter-display-text teleprompter-dialogue' : 'rehearsal-dialogue prompter-display-text'}>
                          <TranscriptWords text={rehearsalView.dialogue} matchedWordIndices={rehearsalView.matchedWordIndices} latestMatchedWordIndex={rehearsalView.latestMatchedWordIndex} />
                        </p>
                      )}
                    </div>
                  )}
                  {rehearsalView.speaker === 'Reader' && ['speaking', 'paused'].includes(rehearsalView.status) && rehearsalView.remainingSeconds !== null && (
                    <span className="rehearsal-prompt-timer rehearsal-countdown" aria-live="off">RECORDING TIME&nbsp; {formatTime(rehearsalView.remainingSeconds)}</span>
                  )}
                  {rehearsalView.speaker === 'Silence' && ['silence', 'paused'].includes(rehearsalView.status) && (
                    <span className="silence-countdown rehearsal-countdown" aria-live="off">{formatTime(rehearsalView.remainingSeconds ?? 0)}</span>
                  )}
                  {rehearsalView.speaker === 'Myself' && rehearsalView.triggerProgress && !isTeleprompterFullscreen && <p className="rehearsal-trigger-progress">{rehearsalView.triggerProgress}</p>}
                  {rehearsalView.speaker === 'Myself' && rehearsalView.status !== 'completed' && !isTeleprompterFullscreen && (
                    <div className="rehearsal-transcript">
                      <span>YOU</span>
                      <p>{rehearsalView.transcript || 'Your speech will appear here.'}</p>
                    </div>
                  )}
                  <p
                    className={rehearsalView.status === 'error' ? 'rehearsal-message is-error' : 'rehearsal-message'}
                    aria-hidden={!rehearsalView.message}
                  >
                    {rehearsalView.message || '\u00a0'}
                  </p>
                </div>
              )}
            </section>

            {rehearsalView?.status === 'error' && <p className="run-error rehearsal-error" role="status">{rehearsalView.message}</p>}

            {runError && <p className="run-error" role="status">{runError}</p>}

            {folderPrompts.length === 0 ? (
              <div className="empty-state">
                <span className="empty-symbol" aria-hidden="true">{'\u25C9'}</span>
                <h2>No prompts recorded</h2>
                <p>Start with a voice recording and choose who is speaking.</p>
                <button className="primary-button" type="button" onClick={() => setPromptDialog({})}>Record a prompt <span aria-hidden="true">{'\u2192'}</span></button>
              </div>
            ) : (
              <div className="prompt-list" aria-label="Prompts in chronological order">
                {folderPrompts.map((prompt, index) => (
                  <article
                    className={[
                      'prompt-row',
                      prompt.type === 'silence' && 'prompt-row-silence',
                      draggedPromptId === prompt.id && 'is-dragging',
                      dragOverPromptId === prompt.id && draggedPromptId !== prompt.id && 'is-drag-over',
                    ].filter(Boolean).join(' ')}
                    key={prompt.id}
                    data-prompt-id={prompt.id}
                    onPointerDown={(event) => startPromptDrag(event, prompt.id)}
                    onPointerMove={movePromptDrag}
                    onPointerUp={finishPromptDrag}
                    onPointerCancel={cancelPromptDrag}
                  >
                    <span className="prompt-drag-handle" data-prompt-drag-handle aria-hidden="true">{'\u22EE\u22EE'}</span>
                    <div className="prompt-info">
                      <h3>{formatPromptLabel(prompt, index + 1)}</h3>
                      {prompt.type === 'silence' ? (
                        <p className="prompt-transcript">Silent pause in the sequence.</p>
                      ) : (
                        <>
                          {prompt.character && <p className="prompt-character">{prompt.character}</p>}
                          <p className="prompt-transcript">{prompt.transcript || 'No transcript available.'}</p>
                          <p className="prompt-date">RECORDED {new Date(prompt.createdAt).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).toUpperCase()}</p>
                        </>
                      )}
                    </div>
                    {prompt.type === 'silence' ? (
                      <div className="silence-duration-control" aria-label={`Silence duration, ${silenceDurationSeconds(prompt)} seconds`}>
                        <button type="button" aria-label="Decrease silence duration" disabled={!canReorderPrompts || silenceDurationSeconds(prompt) <= 1} onClick={() => adjustSilenceDuration(prompt, -1)}>-</button>
                        <span>{silenceDurationSeconds(prompt)}s</span>
                        <button type="button" aria-label="Increase silence duration" disabled={!canReorderPrompts || silenceDurationSeconds(prompt) >= 600} onClick={() => adjustSilenceDuration(prompt, 1)}>+</button>
                      </div>
                    ) : <AudioPlayer audio={prompt.audio} trimSilence={prompt.trimSilence} />}
                    <div className="prompt-actions">
                      {prompt.type !== 'silence' && <button className="text-action" type="button" onClick={() => editPrompt(prompt)}>Edit</button>}
                      <button className="text-action" type="button" onClick={() => deletePrompt(prompt)}>Delete</button>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </>
        ) : (
          <>
            <div className="page-heading library-heading">
              <div>
                <p className="eyebrow">YOUR PRIVATE WORKSPACE <span>///</span> {folders.length.toString().padStart(2, '0')} FOLDERS</p>
                <h1>Prompt library</h1>
                <p className="page-description">A quiet place for every voice and every line.</p>
              </div>
              <button className="primary-button" type="button" onClick={() => setFolderDialog({ mode: 'create' })}><span aria-hidden="true">+</span> New folder</button>
            </div>

            {isLoading ? <p className="loading-state">LOADING LIBRARY...</p> : folders.length === 0 ? (
              <div className="empty-state library-empty">
                <span className="empty-symbol folder-symbol" aria-hidden="true">{'\u25A4'}</span>
                <h2>Your library starts here</h2>
                <p>Create a folder to keep your recordings organized.</p>
                <button className="primary-button" type="button" onClick={() => setFolderDialog({ mode: 'create' })}>Create your first folder <span aria-hidden="true">{'\u2192'}</span></button>
              </div>
            ) : (
              <div className="folder-grid">
                {folders.map((folder, index) => {
                  const count = prompts.filter((prompt) => prompt.folderId === folder.id).length
                  return (
                    <article className="folder-tile" key={folder.id}>
                      <button className="folder-open" type="button" onClick={() => setSelectedFolderId(folder.id)}>
                        <span className="folder-index">{(index + 1).toString().padStart(2, '0')}</span>
                        <span className="folder-glyph" aria-hidden="true">{'\u25A4'}</span>
                        <span className="folder-title">{folder.name}</span>
                        <span className="folder-count">{count} {count === 1 ? 'prompt' : 'prompts'}</span>
                        <span className="folder-arrow" aria-hidden="true">{'\u2197'}</span>
                      </button>
                      <div className="folder-actions">
                        <button className="text-action" type="button" onClick={() => setFolderDialog({ mode: 'edit', folder })}>Rename</button>
                        <button className="text-action delete-action" type="button" onClick={() => deleteFolder(folder)}>Delete</button>
                      </div>
                    </article>
                  )
                })}
              </div>
            )}
          </>
        )}
      </section>

      {selectedFolder && (
        <>
          {isFolderSettingsOpen && (
            <button
              className="settings-scrim"
              type="button"
              aria-label="Close folder settings"
              onClick={() => setIsFolderSettingsOpen(false)}
            />
          )}
          <button
            className={isFolderSettingsOpen ? 'settings-edge-toggle is-open' : 'settings-edge-toggle'}
            type="button"
            aria-controls="folder-settings-panel"
            aria-expanded={isFolderSettingsOpen}
            onClick={() => setIsFolderSettingsOpen((open) => !open)}
          >
            <span className="settings-edge-icon" aria-hidden="true">{isFolderSettingsOpen ? '\u203A' : '\u2039'}</span>
            <span className="settings-gear-icon" aria-hidden="true">{'\u2699'}</span>
            <span>{isFolderSettingsOpen ? 'Close' : 'Settings'}</span>
          </button>
          {isFolderSettingsOpen && (
            <aside className="folder-settings-panel" id="folder-settings-panel" aria-label="Folder settings">
              <div className="folder-settings-heading">
                <div>
                  <p className="eyebrow">FOLDER CONTROLS</p>
                  <h2>Settings</h2>
                </div>
                <span className="settings-heading-mark" aria-hidden="true">///</span>
              </div>
              <section className="character-library" aria-label="Folder characters">
                <div className="character-heading">
                  <div>
                    <p className="eyebrow">CHARACTERS <span>///</span> OPTIONAL</p>
                    <p>Assign a character to a prompt.</p>
                  </div>
                  {!isAddingCharacter && <button className="text-action add-character-button" type="button" onClick={() => setIsAddingCharacter(true)}>+ Add name</button>}
                </div>
                {(selectedFolder.characters ?? []).length > 0 && (
                  <div className="character-list">
                    {selectedFolder.characters.map((character) => (
                      <span className="character-chip" key={character}>
                        {character}
                        <button type="button" aria-label={`Remove ${character}`} onClick={() => removeCharacter(character)}>{'\u00D7'}</button>
                      </span>
                    ))}
                  </div>
                )}
                {isAddingCharacter && (
                  <form className="character-add-form" onSubmit={addCharacter}>
                    <input
                      className="text-field"
                      aria-label="Character name"
                      placeholder="Character name"
                      value={characterName}
                      onChange={(event) => setCharacterName(event.target.value)}
                      maxLength={40}
                      autoFocus
                      required
                    />
                    <button className="character-save-button" type="submit">Add</button>
                    <button className="character-cancel-button" type="button" onClick={() => { setCharacterName(''); setIsAddingCharacter(false) }}>Cancel</button>
                  </form>
                )}
              </section>
              <section className="settings-panel-section" aria-label="Sequence controls">
                <p className="eyebrow">SEQUENCE</p>
                <button className="add-silence-button" type="button" onClick={addSilenceRow}>
                  <span aria-hidden="true">+</span>
                  <span>Add silence row</span>
                </button>
              </section>
              <section className="reader-pitch-control">
                <div className="reader-pitch-heading">
                  <label htmlFor="reader-pitch">Reader pitch</label>
                  <output htmlFor="reader-pitch">{readerPitch.toFixed(2)}{'\u00B0'}</output>
                </div>
                <input
                  id="reader-pitch"
                  type="range"
                  min="0.85"
                  max="1.15"
                  step="0.01"
                  value={readerPitch}
                  onChange={(event) => setReaderPitch(Number(event.target.value))}
                  aria-label="Reader voice pitch"
                />
                <div className="pitch-range-labels"><span>LOW</span><span>HIGH</span></div>
              </section>
            </aside>
          )}
        </>
      )}

      <footer className="app-footer"><span>PROMPT LIBRARY</span><span>VOICE NOTES / {new Date().getFullYear()}</span></footer>

      {isImportingScript && selectedFolder && <ScriptImportDialog folderName={selectedFolder.name} onClose={() => setIsImportingScript(false)} onImport={importScriptPrompts} />}
      {folderDialog && <FolderDialog folder={folderDialog.folder} onClose={() => setFolderDialog(null)} onSave={saveFolder} />}
      {promptDialog && selectedFolder && <PromptDialog folderName={selectedFolder.name} characters={selectedFolder.characters ?? []} prompt={promptDialog.prompt} onClose={() => setPromptDialog(null)} onSave={savePrompt} />}
    </main>
  )
}

export default App

