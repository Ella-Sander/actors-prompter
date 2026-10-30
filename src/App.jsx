import { useEffect, useRef, useState } from 'react'
import { blocksRecordingGeneration, findPromptInsertion, isRecoverableRecognitionInterruption, movePromptInList } from './promptBehavior.js'
import PdfFollowViewer from './PdfFollowViewer.jsx'
import { describePdfError, loadPdfJsRuntime, readBlobAsArrayBuffer, recordPdfDiagnostic } from './pdfFollow.js'
import TtsWorker from './tts.worker.js?worker'
import './App.css'

const DATABASE_NAME = 'prompt-library'
const DATABASE_VERSION = 4
const APP_VERSION = '1.0.0'
const NOISE_REDUCTION_VERSION = 2
const MYSELF_SPEECH_END_MS = 450
const MYSELF_FINAL_TRANSCRIPT_SETTLE_MS = 150

let databasePromise
const audioBoundsCache = new WeakMap()
let ttsGenerationQueue = Promise.resolve()
let ttsWorker
let ttsWorkerRequestId = 0
const ttsWorkerRequests = new Map()
const readerPitchGraphs = new WeakMap()
let soundTouchRuntimePromise

const NON_ENGLISH_CLUES = {
  Spanish: new Set(['el', 'la', 'los', 'las', 'un', 'una', 'unos', 'unas', 'que', 'qué', 'como', 'cómo', 'pero', 'porque', 'para', 'por', 'con', 'estoy', 'estas', 'estás', 'está', 'somos', 'tengo', 'tiene', 'quiero', 'puedo', 'hola', 'gracias', 'adios', 'adiós']),
  French: new Set(['le', 'la', 'les', 'un', 'une', 'des', 'que', 'qui', 'quoi', 'mais', 'avec', 'pour', 'dans', 'est', 'suis', 'êtes', 'vous', 'nous', 'je', 'tu', 'pas', 'bonjour', 'merci', 'oui', 'non']),
  German: new Set(['der', 'die', 'das', 'ein', 'eine', 'und', 'aber', 'mit', 'für', 'nicht', 'ich', 'du', 'wir', 'sie', 'ist', 'sind', 'bin', 'habe', 'haben', 'was', 'wie', 'danke', 'hallo']),
  Italian: new Set(['il', 'lo', 'la', 'gli', 'le', 'un', 'una', 'che', 'chi', 'con', 'per', 'non', 'sono', 'siamo', 'voglio', 'questo', 'questa', 'ciao', 'grazie']),
  Portuguese: new Set(['o', 'a', 'os', 'as', 'um', 'uma', 'que', 'com', 'para', 'não', 'nao', 'estou', 'você', 'voce', 'vocês', 'ola', 'olá', 'obrigado', 'obrigada']),
}

function validateScriptDialogue(value) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  if (!text) return { valid: false, reason: 'Empty dialogue' }
  if (!/[\p{L}\p{N}]/u.test(text)) return { valid: false, reason: 'Punctuation or symbols only' }
  if (/^\d+$/.test(text)) return { valid: false, reason: 'Looks like a page number or isolated number' }
  if (/[\p{Script=Cyrillic}\p{Script=Hebrew}\p{Script=Arabic}\p{Script=Devanagari}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}\p{Script=Hangul}]/u.test(text)) return { valid: false, reason: 'Language is not supported for default voice generation' }
  const words = text.toLocaleLowerCase().match(/[\p{L}]+/gu) ?? []
  const uniqueClues = new Set()
  for (const word of words) {
    for (const [language, clues] of Object.entries(NON_ENGLISH_CLUES)) {
      if (clues.has(word)) uniqueClues.add(language)
    }
  }
  const distinctNonEnglishWords = Object.values(NON_ENGLISH_CLUES).reduce((count, clues) => count + new Set(words.filter((word) => clues.has(word))).size, 0)
  const hasSpanishQuestionPunctuation = /[¿¡]/u.test(text) && uniqueClues.has('Spanish')
  if ((uniqueClues.size === 1 && distinctNonEnglishWords >= 2 && words.length >= 3) || hasSpanishQuestionPunctuation) {
    return { valid: false, reason: `Looks like unsupported ${[...uniqueClues][0] ?? 'non-English'} dialogue` }
  }
  return { valid: true, text }
}

function isUsableRecording(audio) {
  return Boolean(audio && typeof audio.size === 'number' && audio.size > 0 && typeof audio.arrayBuffer === 'function')
}

function getPromptPlaybackAudio(prompt) {
  return prompt?.reduceBackgroundNoise
    && prompt.noiseReductionVersion === NOISE_REDUCTION_VERSION
    && isUsableRecording(prompt.noiseReducedAudio)
    ? prompt.noiseReducedAudio
    : prompt?.audio
}

async function encodeAudioBufferAsWav(audioBuffer) {
  const channelCount = audioBuffer.numberOfChannels
  const frameCount = audioBuffer.length
  const bytesPerSample = 2
  const dataSize = frameCount * channelCount * bytesPerSample
  const buffer = new ArrayBuffer(44 + dataSize)
  const view = new DataView(buffer)
  const writeText = (offset, value) => [...value].forEach((character, index) => view.setUint8(offset + index, character.charCodeAt(0)))
  writeText(0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true)
  writeText(8, 'WAVE')
  writeText(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, channelCount, true)
  view.setUint32(24, audioBuffer.sampleRate, true)
  view.setUint32(28, audioBuffer.sampleRate * channelCount * bytesPerSample, true)
  view.setUint16(32, channelCount * bytesPerSample, true)
  view.setUint16(34, 16, true)
  writeText(36, 'data')
  view.setUint32(40, dataSize, true)

  const channels = Array.from({ length: channelCount }, (_, index) => audioBuffer.getChannelData(index))
  let offset = 44
  for (let frame = 0; frame < frameCount; frame += 1) {
    for (let channel = 0; channel < channelCount; channel += 1) {
      const sample = Math.max(-1, Math.min(1, channels[channel][frame]))
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true)
      offset += bytesPerSample
    }
    if (frame > 0 && frame % 32768 === 0) await new Promise((resolve) => window.setTimeout(resolve, 0))
  }
  return new Blob([buffer], { type: 'audio/wav' })
}

async function applyAdaptiveNoiseGate(audioBuffer) {
  const channelCount = audioBuffer.numberOfChannels
  const frameCount = audioBuffer.length
  const windowSize = Math.max(1, Math.floor(audioBuffer.sampleRate * 0.01))
  const channels = Array.from({ length: channelCount }, (_, index) => audioBuffer.getChannelData(index))
  const levels = []
  for (let start = 0; start < frameCount; start += windowSize) {
    const end = Math.min(frameCount, start + windowSize)
    let energy = 0
    for (let channel = 0; channel < channelCount; channel += 1) {
      for (let frame = start; frame < end; frame += 1) energy += channels[channel][frame] ** 2
    }
    levels.push(Math.sqrt(energy / Math.max(1, (end - start) * channelCount)))
  }
  const orderedLevels = [...levels].sort((first, second) => first - second)
  const noiseFloor = orderedLevels[Math.floor((orderedLevels.length - 1) * 0.2)] ?? 0
  const openThreshold = Math.max(0.0035, Math.min(0.012, noiseFloor * 2.4))
  const closeThreshold = openThreshold * 0.72
  let gateOpen = true
  let gain = 1
  for (let windowIndex = 0, start = 0; start < frameCount; windowIndex += 1, start += windowSize) {
    const end = Math.min(frameCount, start + windowSize)
    const level = levels[windowIndex] ?? 0
    if (gateOpen ? level < closeThreshold : level > openThreshold) gateOpen = !gateOpen
    const targetGain = gateOpen ? 1 : 0.12
    const transitionSeconds = gateOpen ? 0.012 : 0.04
    const blend = 1 - Math.exp(-((end - start) / audioBuffer.sampleRate) / transitionSeconds)
    gain += (targetGain - gain) * blend
    for (let channel = 0; channel < channelCount; channel += 1) {
      const samples = channels[channel]
      for (let frame = start; frame < end; frame += 1) samples[frame] *= gain
    }
    if (windowIndex > 0 && windowIndex % 200 === 0) await new Promise((resolve) => window.setTimeout(resolve, 0))
  }
}

async function createNoiseReducedRecording(audioBlob) {
  const AudioContextConstructor = window.AudioContext || window.webkitAudioContext
  const OfflineAudioContextConstructor = window.OfflineAudioContext || window.webkitOfflineAudioContext
  if (!AudioContextConstructor || !OfflineAudioContextConstructor) {
    throw new Error('This browser does not support offline audio filtering.')
  }
  const decodeContext = new AudioContextConstructor()
  let decoded
  try {
    decoded = await decodeContext.decodeAudioData(await audioBlob.arrayBuffer())
  } finally {
    if (decodeContext.state !== 'closed') decodeContext.close().catch(() => {})
  }
  const offlineContext = new OfflineAudioContextConstructor(
    decoded.numberOfChannels,
    decoded.length,
    decoded.sampleRate,
  )
  const source = offlineContext.createBufferSource()
  const highPass = offlineContext.createBiquadFilter()
  const lowPass = offlineContext.createBiquadFilter()
  const compressor = offlineContext.createDynamicsCompressor()
  source.buffer = decoded
  highPass.type = 'highpass'
  highPass.frequency.value = 100
  highPass.Q.value = 0.707
  lowPass.type = 'lowpass'
  lowPass.frequency.value = Math.min(8500, decoded.sampleRate / 2 - 100)
  lowPass.Q.value = 0.707
  compressor.threshold.value = -32
  compressor.knee.value = 12
  compressor.ratio.value = 2.5
  compressor.attack.value = 0.008
  compressor.release.value = 0.14
  source.connect(highPass)
  highPass.connect(lowPass)
  lowPass.connect(compressor)
  compressor.connect(offlineContext.destination)
  source.start(0)
  const filteredBuffer = await offlineContext.startRendering()
  await applyAdaptiveNoiseGate(filteredBuffer)
  return encodeAudioBufferAsWav(filteredBuffer)
}

function recordRehearsalTrace(session, event, details = {}) {
  if (typeof window === 'undefined') return
  const entry = {
    time: new Date().toISOString(),
    event,
    sessionId: session?.sessionId ?? null,
    phase: session?.phase ?? 'none',
    prompt: session ? `${session.index + 1}/${session.lines.length}` : 'none',
    promptId: session?.lines?.[session.index]?.id ?? null,
    ...details,
  }
  window.__promptRehearsalTrace ??= []
  window.__promptRehearsalTrace.push(entry)
  if (window.__promptRehearsalTrace.length > 40) window.__promptRehearsalTrace.shift()
  console.info('[Run With Me trace]', entry)
}

function recordTtsTrace(event, details = {}) {
  if (typeof window === 'undefined') return
  const entry = { time: new Date().toISOString(), event, ...details }
  window.__promptLibraryTtsTrace ??= []
  window.__promptLibraryTtsTrace.push(entry)
  if (window.__promptLibraryTtsTrace.length > 60) window.__promptLibraryTtsTrace.shift()
  window.__promptLibraryTtsStatus = { event, time: entry.time, ...details }
  console.info('[Prompt TTS trace]', entry)
}

function recordPromptRecordingTrace(event, details = {}) {
  if (typeof window === 'undefined') return
  const entries = window.__promptRecordingTrace ??= []
  entries.push({ time: new Date().toISOString(), event, sessionId: window.__promptRecordingRuntime?.sessionId ?? null, ...details })
  if (entries.length > 30) entries.shift()
}

function generateTtsAudio(text, onProgress) {
  const generation = ttsGenerationQueue.then(() => generateTtsAudioNow(text, onProgress))
  ttsGenerationQueue = generation.then(() => undefined, () => undefined)
  return generation
}

async function generateTtsAudioNow(text, onProgress) {
  recordTtsTrace('generation-start', { transcriptLength: text.length, secureContext: window.isSecureContext })
  onProgress?.({ phase: 'starting', progress: 0 })
  if (!window.isSecureContext) {
    const error = new Error('Default voice generation requires HTTPS on an iPhone. Open the HTTPS LAN development URL; localhost is secure only on the computer running Vite.')
    recordTtsTrace('generation-failed', { error: `${error.name}: ${error.message}` })
    throw error
  }

  onProgress?.({ phase: 'loading' })
  if (!ttsWorker) {
    recordTtsTrace('worker-starting')
    try {
      ttsWorker = new TtsWorker()
    } catch (error) {
      recordTtsTrace('worker-start-failed', { error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) })
      throw error
    }
    ttsWorker.addEventListener('message', (event) => {
      const message = event.data
      if (message.type === 'trace') {
        recordTtsTrace(message.event, message.details)
        return
      }
      const request = ttsWorkerRequests.get(message.requestId)
      if (!request) return
      if (message.type === 'progress') {
        request.onProgress?.(message.progress)
      } else if (message.type === 'result') {
        ttsWorkerRequests.delete(message.requestId)
        recordTtsTrace('synthesis-ready', { audioBytes: message.audio.size, audioType: message.audio.type })
        request.resolve(message.audio)
      } else if (message.type === 'error') {
        ttsWorkerRequests.delete(message.requestId)
        const error = new Error(message.error?.message || 'The background voice worker failed.')
        error.name = message.error?.name || 'Error'
        if (message.error?.stack) error.stack = message.error.stack
        recordTtsTrace('generation-failed', { error: `${error.name}: ${error.message}`, stack: error.stack })
        request.reject(error)
      }
    })
    ttsWorker.addEventListener('error', (event) => {
      const message = event.message || 'The background voice worker stopped unexpectedly.'
      recordTtsTrace('worker-error', { message, filename: event.filename || null, line: event.lineno || null })
      for (const [requestId, request] of ttsWorkerRequests) {
        ttsWorkerRequests.delete(requestId)
        request.reject(new Error(message))
      }
      ttsWorker?.terminate()
      ttsWorker = undefined
    })
    ttsWorker.addEventListener('messageerror', () => {
      recordTtsTrace('worker-message-error')
      for (const [pendingId, request] of ttsWorkerRequests) {
        ttsWorkerRequests.delete(pendingId)
        request.reject(new Error('The voice worker returned data the browser could not read.'))
      }
      ttsWorker?.terminate()
      ttsWorker = undefined
    })
  }

  const requestId = ++ttsWorkerRequestId
  recordTtsTrace('worker-request-sent', { requestId })
  return new Promise((resolve, reject) => {
    ttsWorkerRequests.set(requestId, { resolve, reject, onProgress })
    try {
      ttsWorker.postMessage({ type: 'generate', requestId, text })
    } catch (error) {
      ttsWorkerRequests.delete(requestId)
      recordTtsTrace('worker-request-failed', { requestId, error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) })
      reject(error)
    }
  })
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

async function extractScriptLines(file, onPageProgress = () => {}) {
  const pdfjsLib = await loadPdfJsRuntime()
  recordPdfDiagnostic('script import: read file', 'started', { fileSize: file?.size ?? null })
  const data = await readBlobAsArrayBuffer(file)
  recordPdfDiagnostic('script import: parse document', 'started', { byteLength: data.byteLength })
  const loadingTask = pdfjsLib.getDocument({ data })
  let pdf
  try {
    pdf = await loadingTask.promise
  } catch (error) {
    recordPdfDiagnostic('script import: parse document', 'failed', {
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    })
    throw error
  }
  recordPdfDiagnostic('script import: document ready', 'ready', { pageCount: pdf.numPages })
  onPageProgress({ page: 0, total: pdf.numPages })
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
    page.cleanup?.()
    onPageProgress({ page: pageNumber, total: pdf.numPages })
  }
  recordPdfDiagnostic('script import: text extraction', 'ready', { pageCount: pdf.numPages, extractedRows: lines.length })

  const dialogue = []
  let activeCharacter = ''
  let activeText = []
  const flush = () => {
    const text = activeText.join(' ')
      .replace(/\s*[([](?:laughs?|chuckles?|sighs?|gasps?|coughs?|sobs?|cries?|whispers?|shouts?|offscreen|beat|pause|a beat|long pause)[)\]]\s*/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim()
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
  return { dialogue, pageCount: pdf.numPages }
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
      // Five-millisecond windows give the start detector enough resolution to
      // place the cut close to the first word without treating a brief click as speech.
      const samplesPerWindow = Math.max(1, Math.floor(decoded.sampleRate * 0.005))
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

      const sortedLevels = [...levels].sort((first, second) => first - second)
      const noiseFloor = sortedLevels[Math.floor((sortedLevels.length - 1) * 0.2)] ?? 0
      const endThreshold = 0.012
      const startThreshold = Math.max(0.0035, noiseFloor * 2)
      const activeWindows = Math.max(1, Math.ceil(0.06 * decoded.sampleRate / samplesPerWindow))
      const findSpeechStart = () => {
        // Require 20 ms of continuous activity. A tap/click at record start is
        // usually only a few milliseconds, while the first spoken sound sustains.
        const sustainedOnsetWindows = Math.max(1, Math.ceil(0.02 * decoded.sampleRate / samplesPerWindow))
        let sustainedCount = 0
        for (let index = 0; index < windowCount; index += 1) {
          sustainedCount = levels[index] >= startThreshold ? sustainedCount + 1 : 0
          if (sustainedCount >= sustainedOnsetWindows) return index - sustainedOnsetWindows + 1
        }
        return -1
      }
      const findSpeechEnd = () => {
        for (let index = windowCount - activeWindows; index >= 0; index -= 1) {
          if (levels.subarray(index, index + activeWindows).every((level) => level >= endThreshold)) return index + activeWindows
        }
        return -1
      }
      const firstActive = findSpeechStart()
      const lastActive = findSpeechEnd()
      if (firstActive < 0 || lastActive < 0) return { start: 0, end: duration }
      const startPadding = 0.005
      const endPadding = 0.08
      const start = Math.max(0, firstActive * samplesPerWindow / decoded.sampleRate - startPadding)
      const end = Math.min(duration, lastActive * samplesPerWindow / decoded.sampleRate + endPadding)
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

function seekAudioTo(audio, time) {
  if (!Number.isFinite(time) || Math.abs(audio.currentTime - time) <= 0.025) return Promise.resolve()
  return new Promise((resolve) => {
    let timeout
    const finish = () => {
      window.clearTimeout(timeout)
      audio.removeEventListener('seeked', finish)
      audio.removeEventListener('error', finish)
      resolve()
    }
    audio.addEventListener('seeked', finish, { once: true })
    audio.addEventListener('error', finish, { once: true })
    timeout = window.setTimeout(finish, 1500)
    try {
      audio.currentTime = time
      if (Math.abs(audio.currentTime - time) <= 0.025) finish()
    } catch {
      finish()
    }
  })
}

async function prepareAudioTrim(audio, blob, shouldTrim, onTrimEnd) {
  if (!shouldTrim) return { cleanup: () => {}, duration: audio.duration }
  const [bounds] = await Promise.all([getAudioBounds(blob), waitForAudioMetadata(audio)])
  const start = Math.max(0, bounds.start)
  const end = Math.min(Number.isFinite(audio.duration) ? audio.duration : bounds.end, bounds.end || audio.duration)
  if (audio.readyState >= 1) await seekAudioTo(audio, start)
  if (end <= start) return { cleanup: () => {}, duration: audio.duration }

  let finished = false
  let correctingStart = false
  const handleTimeUpdate = () => {
    if (finished) return
    if (audio.currentTime < start - 0.025 && !correctingStart) {
      correctingStart = true
      seekAudioTo(audio, start).finally(() => { correctingStart = false })
      return
    }
    if (audio.currentTime < end - 0.025) return
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
      request.onupgradeneeded = (event) => {
        const database = request.result
        if (!database.objectStoreNames.contains('folders')) database.createObjectStore('folders', { keyPath: 'id' })
        if (!database.objectStoreNames.contains('prompts')) database.createObjectStore('prompts', { keyPath: 'id' })
        if (!database.objectStoreNames.contains('importJobs')) database.createObjectStore('importJobs', { keyPath: 'id' })
        const hasPdfScripts = database.objectStoreNames.contains('pdfScripts')
        if (!hasPdfScripts) database.createObjectStore('pdfScripts', { keyPath: 'folderId' })
        const pdfLibraryStore = database.objectStoreNames.contains('pdfLibrary')
          ? event.target.transaction.objectStore('pdfLibrary')
          : database.createObjectStore('pdfLibrary', { keyPath: 'id' })
        if (event.oldVersion < 4 && hasPdfScripts) {
          const cursorRequest = event.target.transaction.objectStore('pdfScripts').openCursor()
          cursorRequest.onsuccess = () => {
            const cursor = cursorRequest.result
            if (!cursor) return
            const savedScript = cursor.value
            if (savedScript.blob) {
              const pdfId = savedScript.pdfId ?? `legacy-${savedScript.folderId}`
              pdfLibraryStore.put({ id: pdfId, name: savedScript.name ?? 'Imported sides.pdf', blob: savedScript.blob, size: savedScript.blob.size, addedAt: savedScript.updatedAt ?? Date.now() })
              cursor.update({ folderId: savedScript.folderId, pdfId, name: savedScript.name, updatedAt: savedScript.updatedAt })
            }
            cursor.continue()
          }
        }
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

function formatFileSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 KB'
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`
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
    const transaction = database.transaction(['folders', 'prompts', 'pdfScripts'], 'readwrite')
    const folderStore = transaction.objectStore('folders')
    const promptStore = transaction.objectStore('prompts')
    const pdfStore = transaction.objectStore('pdfScripts')
    const request = promptStore.getAll()
    request.onsuccess = () => {
      request.result
        .filter((prompt) => prompt.folderId === folderId)
        .forEach((prompt) => promptStore.delete(prompt.id))
      pdfStore.delete(folderId)
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

async function prepareReaderPitch(audio, speaker, pitch) {
  if (speaker !== 'Reader' || Math.abs(pitch - 1) < 0.001) return () => {}
  if (!window.isSecureContext) {
    throw new Error('Reader Pitch processing requires HTTPS on an iPhone. Open the HTTPS LAN development URL.')
  }
  if (typeof window.AudioWorkletNode !== 'function') {
    throw new Error('This browser does not expose AudioWorkletNode. Reader Pitch needs a current Safari version on a trusted HTTPS origin.')
  }
  let graph = readerPitchGraphs.get(audio)
  if (!graph) {
    const AudioContextConstructor = window.AudioContext || window.webkitAudioContext
    if (!AudioContextConstructor || !window.AudioWorkletNode) {
      throw new Error('Independent Reader pitch shifting is not supported by this browser.')
    }
    const context = new AudioContextConstructor()
    if (!context.audioWorklet) {
      context.close().catch(() => {})
      throw new Error('This browser does not support AudioWorklet processing for Reader Pitch.')
    }
    context.resume().catch(() => {})
    graph = { context, source: null, node: null, ready: null }
    readerPitchGraphs.set(audio, graph)
    graph.ready = (async () => {
      soundTouchRuntimePromise ??= Promise.all([
        import('@soundtouchjs/audio-worklet'),
        import('@soundtouchjs/audio-worklet/processor?url'),
      ]).then(([soundTouchModule, processorModule]) => ({
        SoundTouchNode: soundTouchModule.SoundTouchNode,
        processorUrl: processorModule.default,
      })).catch((error) => {
        soundTouchRuntimePromise = undefined
        throw error
      })
      const { SoundTouchNode, processorUrl } = await soundTouchRuntimePromise
      await SoundTouchNode.register(context, processorUrl)
      graph.source = context.createMediaElementSource(audio)
      graph.node = new SoundTouchNode({ context })
      graph.source.connect(graph.node)
      graph.node.connect(context.destination)
      audio.preservesPitch = false
      audio.mozPreservesPitch = false
      audio.webkitPreservesPitch = false
    })().catch((error) => {
      if (readerPitchGraphs.get(audio) === graph) readerPitchGraphs.delete(audio)
      try { graph.source?.disconnect() } catch { /* no connection was created */ }
      try { graph.node?.disconnect() } catch { /* no node was connected */ }
      if (context.state !== 'closed') context.close().catch(() => {})
      throw error
    })
  }
  await graph.ready
  if (graph.context.state === 'suspended') await graph.context.resume()
  if (!graph.node) throw new Error('Reader pitch processor could not be initialized.')
  graph.node.pitch.value = pitch
  return () => {
    const current = readerPitchGraphs.get(audio)
    if (current !== graph) return
    readerPitchGraphs.delete(audio)
    try { graph.source?.disconnect() } catch { /* already disconnected */ }
    try { graph.node?.disconnect() } catch { /* already disconnected */ }
    if (graph.context.state !== 'closed') graph.context.close().catch(() => {})
  }
}

async function resumeReaderPitch(audio) {
  const graph = readerPitchGraphs.get(audio)
  if (graph?.context.state === 'suspended') await graph.context.resume()
}

function recordPromptAudioTrace(event, details = {}) {
  if (typeof window === 'undefined') return
  const entries = window.__promptAudioTrace ??= []
  entries.push({ time: new Date().toISOString(), event, ...details })
  if (entries.length > 40) entries.shift()
  console.info('[Prompt audio trace]', entries.at(-1))
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

function getFinalWordTriggerMatch(transcript, expectedWords, expectedCount) {
  const triggerWord = expectedWords.at(-1) ?? ''
  const words = normalizeTranscriptWords(transcript)
  const exactCount = words.filter((word) => word === triggerWord).length
  return { count: exactCount, satisfied: exactCount >= expectedCount }
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
  playback.cancelled = true
  playback.pitchCleanup?.()
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

function disposePreloadedRehearsalReader(session) {
  const playback = session?.preloadedReader
  if (!playback) return
  session.preloadedReader = null
  playback.cancelled = true
  playback.pitchCleanup?.()
  playback.audio.pause()
  playback.audio.removeAttribute('src')
  playback.audio.src = ''
  playback.audio.load()
  URL.revokeObjectURL(playback.objectUrl)
}

function disposeRehearsalSession(session) {
  if (!session) return
  session.phase = 'stopped'
  window.clearInterval(session.readerCountdownTimer)
  session.readerCountdownTimer = null
  window.clearTimeout(session.advanceTimer)
  session.advanceTimer = null
  window.clearTimeout(session.recognitionRecoveryTimer)
  session.recognitionRecoveryTimer = null
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
  session.readerAudio?.pitchCleanup?.()
  stopRehearsalReaderPlayback(session)
  disposePreloadedRehearsalReader(session)
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

function AudioPlayer({ audio, trimSilence = false, speaker = 'Myself', pitch = 1, promptId = null }) {
  const [source, setSource] = useState('')
  const [playbackDuration, setPlaybackDuration] = useState(null)
  const [playbackError, setPlaybackError] = useState('')
  const playerRef = useRef(null)
  const pitchRef = useRef(pitch)
  pitchRef.current = pitch

  useEffect(() => {
    const objectUrl = URL.createObjectURL(audio)
    setSource(objectUrl)
    return () => URL.revokeObjectURL(objectUrl)
  }, [audio])

  useEffect(() => {
    const player = playerRef.current
    if (!player) return undefined
    let disposed = false
    let pitchPreparing = false
    let trimPreparing = false
    let bounds = null
    let pitchCleanup = () => {}
    const boundsPromise = trimSilence ? getAudioBounds(audio) : null
    const traceDetails = { promptId, speaker, source: 'prompt-list' }
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
    const handlePlay = async () => {
      const selectedPitch = pitchRef.current
      window.__promptAudioRuntime = { mode: 'Audio player', promptId, speaker, pitch: selectedPitch, phase: 'play-requested' }
      recordPromptAudioTrace('media-play-requested', { ...traceDetails, pitch: selectedPitch })
      if (pitchPreparing || trimPreparing) {
        player.pause()
        return
      }
      if (speaker === 'Reader' && Math.abs(selectedPitch - 1) >= 0.001 && !readerPitchGraphs.has(player)) {
        pitchPreparing = true
        player.pause()
        setPlaybackError('')
        recordPromptAudioTrace('pitch-setup-start', { ...traceDetails, pitch: selectedPitch })
        try {
          pitchCleanup = await prepareReaderPitch(player, speaker, selectedPitch)
          recordPromptAudioTrace('pitch-setup-ready', { ...traceDetails, pitch: selectedPitch })
        } catch (error) {
          const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
          setPlaybackError(`Reader pitch could not be applied: ${message}`)
          recordPromptAudioTrace('pitch-setup-failed', { ...traceDetails, pitch: selectedPitch, error: message, stack: error instanceof Error ? error.stack : undefined })
          pitchPreparing = false
          return
        }
        pitchPreparing = false
        if (disposed) return
        if (trimSilence) {
          const detectedBounds = await boundsPromise
          if (disposed) return
          bounds = { start: detectedBounds.start, end: detectedBounds.end || player.duration }
          if (player.currentTime < bounds.start || player.currentTime >= bounds.end) await seekAudioTo(player, bounds.start)
        }
        player.play().catch((error) => {
          recordPromptAudioTrace('play-rejected', { ...traceDetails, error: error?.message ?? String(error) })
          setPlaybackError(`Audio playback could not start: ${error?.message ?? 'browser rejected playback'}`)
        })
        return
      }
      if (trimSilence && !bounds) {
        trimPreparing = true
        player.pause()
        try {
          const detectedBounds = await boundsPromise
          if (disposed) return
          bounds = { start: detectedBounds.start, end: detectedBounds.end || player.duration }
          if (player.currentTime < bounds.start || player.currentTime >= bounds.end) await seekAudioTo(player, bounds.start)
          trimPreparing = false
          player.play().catch((error) => {
            recordPromptAudioTrace('play-rejected', { ...traceDetails, error: error?.message ?? String(error) })
            setPlaybackError(`Audio playback could not start: ${error?.message ?? 'browser rejected playback'}`)
          })
        } catch (error) {
          trimPreparing = false
          setPlaybackError(`Trimmed audio could not be prepared: ${error?.message ?? String(error)}`)
        }
        return
      }
      if (bounds && (player.currentTime < bounds.start || player.currentTime >= bounds.end)) player.currentTime = bounds.start
    }
    const handleTimeUpdate = () => {
      if (trimSilence && bounds && player.currentTime >= bounds.end) {
        player.pause()
        player.currentTime = bounds.end
      }
    }
    const handleError = () => {
      window.__promptAudioRuntime = { mode: 'Audio player', promptId, speaker, pitch: pitchRef.current, phase: 'error', mediaErrorCode: player.error?.code ?? null }
      recordPromptAudioTrace('media-error', { ...traceDetails, mediaErrorCode: player.error?.code ?? null })
      setPlaybackError(`Audio could not be played (media error ${player.error?.code ?? 'unknown'}).`)
    }
    const handleMetadata = () => recordPromptAudioTrace('media-metadata-ready', { ...traceDetails, duration: Number.isFinite(player.duration) ? player.duration : null, readyState: player.readyState })
    const handleEnded = () => {
      window.__promptAudioRuntime = { mode: 'Audio player', promptId, speaker, pitch: pitchRef.current, phase: 'ended' }
      recordPromptAudioTrace('media-ended', traceDetails)
    }
    player.addEventListener('play', handlePlay)
    player.addEventListener('timeupdate', handleTimeUpdate)
    player.addEventListener('error', handleError)
    player.addEventListener('loadedmetadata', handleMetadata)
    player.addEventListener('ended', handleEnded)
    return () => {
      disposed = true
      pitchCleanup()
      player.removeEventListener('play', handlePlay)
      player.removeEventListener('timeupdate', handleTimeUpdate)
      player.removeEventListener('error', handleError)
      player.removeEventListener('loadedmetadata', handleMetadata)
      player.removeEventListener('ended', handleEnded)
    }
  }, [audio, source, trimSilence, speaker, promptId])

  useEffect(() => {
    const graph = playerRef.current && readerPitchGraphs.get(playerRef.current)
    if (graph?.node && speaker === 'Reader') graph.node.pitch.value = pitch
  }, [audio, pitch, speaker])

  return source ? (
    <div className={`audio-player-group${trimSilence ? ' is-trimmed' : ''}`} data-audio-speaker={speaker}>
      {trimSilence && Number.isFinite(playbackDuration) && (
        <div className="audio-player-trimmed-duration" aria-label={`Trimmed playback duration ${formatRoundedTime(playbackDuration)}`}>
          <span className="trimmed-duration-label"><i aria-hidden="true" />TRIMMED</span>
          <strong>{formatRoundedTime(playbackDuration)}</strong>
        </div>
      )}
      <audio ref={playerRef} className="audio-player" controls preload="metadata" src={source}>Audio playback is not supported.</audio>
      {playbackError && <p className="audio-playback-error" role="alert">{playbackError}</p>}
    </div>
  ) : null
}


function ScriptImportDialog({ folderName, pdfLibrary, onClose, onImport }) {
  const [fileName, setFileName] = useState('')
  const [selectedFile, setSelectedFile] = useState(null)
  const [selectedLibraryPdfId, setSelectedLibraryPdfId] = useState('')
  const [lines, setLines] = useState([])
  const [characters, setCharacters] = useState([])
  const [selectedCharacter, setSelectedCharacter] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [pageProgress, setPageProgress] = useState(null)
  const [pdfDragActive, setPdfDragActive] = useState(false)

  async function loadPdf(file, name = file?.name, libraryPdfId = '') {
    if (!file) return
    setFileName(name)
    setSelectedFile(file)
    setSelectedLibraryPdfId(libraryPdfId)
    setLines([])
    setCharacters([])
    setError('')
    setPageProgress(null)
    if (!file.type?.includes('pdf') && !name.toLowerCase().endsWith('.pdf')) {
      setError('Choose a PDF file to import.')
      return
    }
    setLoading(true)
    try {
      const extracted = await extractScriptLines(file, setPageProgress)
      const detected = [...new Set(extracted.dialogue.map((line) => line.character))]
      setLines(extracted.dialogue)
      setCharacters(detected)
      setSelectedCharacter(detected[0] ?? '')
    } catch (extractError) {
      recordPdfDiagnostic('script import', 'failed', {
        error: extractError instanceof Error ? `${extractError.name}: ${extractError.message}` : String(extractError),
        stack: extractError instanceof Error ? extractError.stack : undefined,
      })
      setError(describePdfError(extractError))
    } finally {
      setLoading(false)
    }
  }

  function selectFile(event) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (file) loadPdf(file)
  }

  function selectLibraryPdf(event) {
    const pdf = pdfLibrary.find((entry) => entry.id === event.target.value)
    if (pdf) loadPdf(pdf.blob, pdf.name, pdf.id)
  }

  function editLine(id, text) {
    setLines((current) => current.map((line) => line.id === id ? { ...line, text } : line))
  }

  function removeLine(id) {
    setLines((current) => current.filter((line) => line.id !== id))
  }

  async function confirmImport() {
    const checkedLines = lines.map((line) => ({ ...line, validation: validateScriptDialogue(line.text) }))
    const importableLines = checkedLines.filter((line) => line.validation.valid).map(({ validation, ...line }) => ({ ...line, text: validation.text }))
    const skippedLines = checkedLines.filter((line) => !line.validation.valid).map((line) => ({ character: line.character, reason: line.validation.reason }))
    if (!selectedCharacter || !importableLines.length) {
      setError('No valid dialogue remains. Keep at least one supported, non-empty spoken line to import.')
      return
    }
    setLoading(true)
    setError('')
    try {
      await onImport(importableLines, selectedCharacter, characters, { skippedLines, pageCount: pageProgress?.total ?? 0, fileName, file: selectedFile, pdfId: selectedLibraryPdfId })
    } catch (importError) {
      setError(importError?.message || 'The prompts could not be imported. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="dialog-backdrop" onMouseDown={(event) => event.target === event.currentTarget && !loading && onClose()}>
      <section
        className={`record-dialog script-import-dialog${pdfDragActive ? ' is-pdf-dragging' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="script-import-title"
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
          if (dropped) loadPdf(dropped)
          else setError('Drop a PDF file to import dialogue.')
        }}
      >
        <div className="dialog-heading">
          <div>
            <p className="eyebrow">SCRIPT IMPORT <span>///</span> {folderName}</p>
            <h2 id="script-import-title">Import a script PDF</h2>
          </div>
          <button className="icon-button" type="button" aria-label="Close dialog" onClick={onClose} disabled={loading}>{'\u00D7'}</button>
        </div>
        {pdfLibrary.length > 0 && <>
          <label className="field-label" htmlFor="script-library-pdf">Choose from your PDF library</label>
          <select id="script-library-pdf" className="text-field character-select" value={selectedLibraryPdfId} onChange={selectLibraryPdf} disabled={loading}>
            <option value="">Select an uploaded PDF</option>
            {pdfLibrary.map((pdf) => <option key={pdf.id} value={pdf.id}>{pdf.name} · {formatFileSize(pdf.size)}</option>)}
          </select>
          <p className="script-import-hint">Or choose a new PDF below. Imported PDFs are added to your library after import.</p>
        </>}
        <label className="field-label" htmlFor="script-pdf">{pdfLibrary.length ? 'Or upload a new PDF' : 'PDF file'}</label>
        <input id="script-pdf" className="text-field script-file-input" type="file" accept="application/pdf,.pdf" onChange={selectFile} disabled={loading} />
        {fileName && <p className="script-import-meta">{fileName}{loading ? '  /  PROCESSING' : lines.length ? `  /  ${lines.length} DIALOGUE LINES` : ''}</p>}
        {loading && pageProgress && <p className="script-import-progress" role="status">Reading PDF pages: {pageProgress.page} of {pageProgress.total}</p>}
        {characters.length > 0 && <>
          <label className="field-label" htmlFor="script-character">Character you will play</label>
          <select id="script-character" className="text-field character-select" value={selectedCharacter} onChange={(event) => setSelectedCharacter(event.target.value)} disabled={loading}>
            {characters.map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
          <p className="script-import-hint">Your selected character becomes Myself. Other characters become Reader.</p>
          <div className="script-preview-list" aria-label="Review extracted dialogue">
            {lines.map((line, index) => (
              <div className={`script-preview-line${validateScriptDialogue(line.text).valid ? '' : ' is-invalid'}`} key={line.id}>
                <div className="script-preview-label"><strong>{line.character}</strong><span>{line.character === selectedCharacter ? 'MYSELF' : 'READER'}  /  {String(index + 1).padStart(2, '0')}</span><button className="script-line-delete" type="button" onClick={() => removeLine(line.id)} disabled={loading} aria-label={`Remove ${line.character} dialogue ${index + 1}`}>Remove</button></div>
                <textarea className="text-field script-preview-text" value={line.text} onChange={(event) => editLine(line.id, event.target.value)} disabled={loading} aria-label={`${line.character} dialogue ${index + 1}`} />
                {!validateScriptDialogue(line.text).valid && <p className="script-validation-reason">Skipped during import: {validateScriptDialogue(line.text).reason}</p>}
              </div>
            ))}
          </div>
          {lines.length === 0 && <p className="script-import-hint">All dialogue rows have been removed.</p>}
        </>}
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="dialog-actions">
          <button className="quiet-button" type="button" onClick={onClose} disabled={loading}>Cancel</button>
          {lines.length > 0 && <button className="primary-button" type="button" onClick={confirmImport} disabled={loading}>{loading ? 'Saving prompts…' : 'Done — import prompts'}</button>}
        </div>
      </section>
    </div>
  )
}

function PromptDialog({ folderName, characters, prompt, readerPitch, readerPitchApplyVersion, onClose, onSave, onGenerateRecording }) {
  const [speaker, setSpeaker] = useState(prompt?.speaker ?? 'Myself')
  const [character, setCharacter] = useState(prompt?.character ?? '')
  const [audio, setAudio] = useState(prompt?.audio ?? null)
  const [audioSource, setAudioSource] = useState(prompt?.audioSource ?? 'user')
  const [trimSilence, setTrimSilence] = useState(prompt?.trimSilence ?? false)
  const [reduceBackgroundNoise, setReduceBackgroundNoise] = useState(Boolean(prompt?.reduceBackgroundNoise && isUsableRecording(prompt?.noiseReducedAudio)))
  const [noiseReducedAudio, setNoiseReducedAudio] = useState(prompt?.noiseReducedAudio ?? null)
  const [noiseReductionVersion, setNoiseReductionVersion] = useState(prompt?.noiseReductionVersion ?? null)
  const [processingNoise, setProcessingNoise] = useState(false)
  const [noiseReductionError, setNoiseReductionError] = useState('')
  const [transcript, setTranscript] = useState(prompt?.transcript ?? '')
  const [transcriptNotice, setTranscriptNotice] = useState('')
  const [transcriptError, setTranscriptError] = useState('')
  const [recording, setRecording] = useState(false)
  const [recordingStarting, setRecordingStarting] = useState(false)
  const [seconds, setSeconds] = useState(0)
  const [error, setError] = useState('')
  const [generationError, setGenerationError] = useState('')
  const [generatingAudio, setGeneratingAudio] = useState(false)
  const [generationProgress, setGenerationProgress] = useState(null)
  const recorderRef = useRef(null)
  const recognitionRef = useRef(null)
  const chunksRef = useRef([])
  const recordingFailedRef = useRef(false)
  const recordingStartingRef = useRef(false)
  const stopOnPitchApplyRef = useRef(false)
  const recordingRef = useRef(recording)
  const stopRecordingRef = useRef(() => {})
  const liveTranscriptionAllowedRef = useRef(false)
  const noiseRefreshStartedRef = useRef(false)
  recordingRef.current = recording
  const promptIdRef = useRef(prompt?.id ?? makeId())
  const promptCreatedAtRef = useRef(prompt?.createdAt ?? Date.now())
  const usableAudio = isUsableRecording(audio)
  const generationPhase = generationProgress?.phase ?? 'preparing'
    const generationStage = { preparing: 0, loading: 1, synthesizing: 2, complete: 3 }[generationPhase] ?? 0

  useEffect(() => {
    if (
      noiseRefreshStartedRef.current ||
      !prompt?.reduceBackgroundNoise ||
      !usableAudio ||
      !isUsableRecording(noiseReducedAudio) ||
      noiseReductionVersion === NOISE_REDUCTION_VERSION
    ) return
    noiseRefreshStartedRef.current = true
    setProcessingNoise(true)
    setNoiseReductionError('')
    createNoiseReducedRecording(audio)
      .then((filteredAudio) => {
        setNoiseReducedAudio(filteredAudio)
        setNoiseReductionVersion(NOISE_REDUCTION_VERSION)
        setReduceBackgroundNoise(true)
      })
      .catch((processingError) => {
        setReduceBackgroundNoise(false)
        setNoiseReductionError(`Noise reduction could not be prepared: ${processingError?.message ?? String(processingError)}`)
      })
      .finally(() => setProcessingNoise(false))
  }, [audio, noiseReducedAudio, noiseReductionVersion, prompt?.reduceBackgroundNoise, usableAudio])

  useEffect(() => {
    if (!recording) return undefined
    const timer = window.setInterval(() => setSeconds((value) => value + 1), 1000)
    return () => window.clearInterval(timer)
  }, [recording])

  useEffect(() => {
    if (recordingRef.current) stopRecordingRef.current()
    else if (recordingStartingRef.current) stopOnPitchApplyRef.current = true
  }, [readerPitchApplyVersion])

  useEffect(() => () => {
    const recorder = recorderRef.current
    if (recorder?.state === 'recording') recorder.stop()
    recorder?.stream.getTracks().forEach((track) => track.stop())
    recognitionRef.current?.abort()
  }, [])

  async function startRecording() {
    if (recordingStartingRef.current || recorderRef.current?.state === 'recording') return
    liveTranscriptionAllowedRef.current = !transcript.trim()
    recordingStartingRef.current = true
    setRecordingStarting(true)
    setError('')
    setGenerationError('')
    setTranscriptNotice('')
    setTranscriptError('')
    setSeconds(0)
    window.__promptRecordingRuntime = { sessionId: makeId(), promptId: prompt?.id ?? promptIdRef.current, phase: 'requesting-microphone' }

    if (!window.isSecureContext) {
      recordPromptRecordingTrace('unsupported-insecure-context', { secureContext: false, promptId: prompt?.id ?? 'new' })
      setError('Microphone recording requires HTTPS on your iPhone. The HTTP LAN link can load the app, but browsers block microphone access there.')
      recordingStartingRef.current = false
      setRecordingStarting(false)
      return
    }

    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
      recordPromptRecordingTrace('unsupported', {
        mediaDevices: Boolean(navigator.mediaDevices),
        getUserMedia: Boolean(navigator.mediaDevices?.getUserMedia),
        mediaRecorder: Boolean(window.MediaRecorder),
      })
      setError('Audio recording is not supported in this browser.')
      recordingStartingRef.current = false
      setRecordingStarting(false)
      return
    }

    let stream
    try {
      recordPromptRecordingTrace('microphone-requested', { promptId: prompt?.id ?? 'new' })
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      recordPromptRecordingTrace('microphone-ready', { trackCount: stream.getAudioTracks().length })
      const supportedMimeType = [
        'audio/mp4;codecs=mp4a.40.2',
        'audio/mp4',
        'audio/webm;codecs=opus',
        'audio/webm',
      ].find((type) => MediaRecorder.isTypeSupported?.(type))
      const recorder = supportedMimeType
        ? new MediaRecorder(stream, { mimeType: supportedMimeType })
        : new MediaRecorder(stream)
      chunksRef.current = []
      recordingFailedRef.current = false
      recorderRef.current = recorder
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data)
      }
      recorder.onstop = () => {
        liveTranscriptionAllowedRef.current = false
        const clip = new Blob(chunksRef.current, { type: recorder.mimeType || supportedMimeType || 'audio/webm' })
        recordPromptRecordingTrace('recorder-stopped', { bytes: clip.size, failed: recordingFailedRef.current })
        window.__promptRecordingRuntime = { ...window.__promptRecordingRuntime, promptId: prompt?.id ?? promptIdRef.current, phase: 'stopped', bytes: clip.size, failed: recordingFailedRef.current }
        if (clip.size > 0 && !recordingFailedRef.current) {
          replacePromptAudio(clip, 'user')
        } else if (!recordingFailedRef.current) {
          setError('No audio was captured. Check microphone access and try recording again.')
        }
        stream.getTracks().forEach((track) => track.stop())
        if (recorderRef.current === recorder) recorderRef.current = null
        setRecording(false)
      }
      recorder.onerror = () => {
        liveTranscriptionAllowedRef.current = false
        recordingFailedRef.current = true
        recordPromptRecordingTrace('recorder-error', { state: recorder.state, mimeType: recorder.mimeType || 'unknown' })
        setError('The recording stopped unexpectedly. Your previous audio is still available; please try again.')
        stream.getTracks().forEach((track) => track.stop())
        setRecording(false)
      }
      recorder.start()
      setRecording(true)
      window.__promptRecordingRuntime = { ...window.__promptRecordingRuntime, promptId: prompt?.id ?? promptIdRef.current, phase: 'recording', mimeType: recorder.mimeType || supportedMimeType || 'browser-default' }
      recordPromptRecordingTrace('recorder-started', { mimeType: recorder.mimeType || supportedMimeType || 'browser-default' })

      if (stopOnPitchApplyRef.current) {
        stopOnPitchApplyRef.current = false
        stopRecording()
        return
      }

      // Start optional transcription only after the microphone recorder is running.
      // Safari can reject SpeechRecognition independently; that must not cancel audio capture.
      const SpeechRecognitionApi = window.SpeechRecognition || window.webkitSpeechRecognition
      if (SpeechRecognitionApi) {
        try {
          const recognition = new SpeechRecognitionApi()
          recognition.continuous = true
          recognition.interimResults = true
          recognition.lang = 'en-US'
          recognition.onresult = (event) => {
            if (!liveTranscriptionAllowedRef.current) return
            const spokenWords = Array.from(event.results)
              .map((result) => result[0].transcript)
              .join(' ')
              .trim()
            setTranscript(spokenWords)
          }
          recognition.onerror = (event) => {
            recordPromptRecordingTrace('transcription-error', { error: event.error ?? 'unknown' })
            setTranscriptNotice('TRANSCRIPTION INTERRUPTED — RECORDING CONTINUES')
          }
          recognitionRef.current = recognition
          recognition.start()
          recordPromptRecordingTrace('transcription-started')
        } catch {
          recognitionRef.current = null
          recordPromptRecordingTrace('transcription-start-failed')
          setTranscriptNotice('TYPE AN ENGLISH TRANSCRIPT')
        }
      } else {
        setTranscriptNotice('TYPE AN ENGLISH TRANSCRIPT')
      }
    } catch (recordingError) {
      recordPromptRecordingTrace('recorder-start-failed', {
        error: recordingError instanceof Error ? `${recordingError.name}: ${recordingError.message}` : String(recordingError),
      })
      stream?.getTracks().forEach((track) => track.stop())
      recognitionRef.current?.abort()
      recognitionRef.current = null
      recorderRef.current = null
      setRecording(false)
      window.__promptRecordingRuntime = { ...window.__promptRecordingRuntime, promptId: prompt?.id ?? promptIdRef.current, phase: 'error', error: recordingError instanceof Error ? `${recordingError.name}: ${recordingError.message}` : String(recordingError) }
      setError('Microphone access was unavailable. Allow microphone access and try again.')
    } finally {
      recordingStartingRef.current = false
      setRecordingStarting(false)
    }
  }

  function stopRecording() {
    liveTranscriptionAllowedRef.current = false
    const recognition = recognitionRef.current
    recognitionRef.current = null
    try {
      recognition?.stop()
    } catch {
      // Recognition is optional; stopping the audio recorder remains authoritative.
    }
    const recorder = recorderRef.current
    if (window.__promptRecordingRuntime) window.__promptRecordingRuntime = { ...window.__promptRecordingRuntime, phase: 'stopping' }
    recordPromptRecordingTrace('stop-requested', { recorderState: recorder?.state ?? 'missing' })
    if (recorder?.state === 'recording') recorder.stop()
  }

  stopRecordingRef.current = stopRecording

  function getPromptPayload() {
    const cleanTranscript = transcript.trim()
    return {
      ...(prompt ?? {}),
      id: promptIdRef.current,
      speaker,
      character,
      audio: isUsableRecording(audio) ? audio : null,
      audioSource: isUsableRecording(audio) ? audioSource : 'none',
      generatedForTranscript: isUsableRecording(audio) && audioSource === 'tts' ? cleanTranscript : null,
      trimSilence,
      reduceBackgroundNoise: reduceBackgroundNoise && isUsableRecording(noiseReducedAudio),
      noiseReducedAudio: isUsableRecording(noiseReducedAudio) ? noiseReducedAudio : null,
      noiseReductionVersion: isUsableRecording(noiseReducedAudio) ? noiseReductionVersion : null,
      transcript: cleanTranscript,
      createdAt: promptCreatedAtRef.current,
    }
  }

  async function toggleNoiseReduction(enabled) {
    setNoiseReductionError('')
    if (!enabled) {
      setReduceBackgroundNoise(false)
      return
    }
    if (!usableAudio) return
    setProcessingNoise(true)
    try {
      const filteredAudio = isUsableRecording(noiseReducedAudio) && noiseReductionVersion === NOISE_REDUCTION_VERSION
        ? noiseReducedAudio
        : await createNoiseReducedRecording(audio)
      setNoiseReducedAudio(filteredAudio)
      setNoiseReductionVersion(NOISE_REDUCTION_VERSION)
      setReduceBackgroundNoise(true)
    } catch (processingError) {
      setReduceBackgroundNoise(false)
      setNoiseReductionError(`Noise reduction could not be prepared: ${processingError?.message ?? String(processingError)}`)
    } finally {
      setProcessingNoise(false)
    }
  }

  function replacePromptAudio(nextAudio, nextSource) {
    setAudio(nextAudio)
    setAudioSource(nextSource)
    setNoiseReducedAudio(null)
    setReduceBackgroundNoise(false)
    setNoiseReductionVersion(null)
    setNoiseReductionError('')
  }

  async function submitPrompt(event) {
    event.preventDefault()
    if (recording || recordingStarting || generatingAudio || processingNoise) return
    if (!transcript.trim()) {
      setTranscriptError('Add an English transcript before saving this recording.')
      return
    }
    setError('')
    const savedPrompt = await onSave(getPromptPayload())
    if (!savedPrompt) setError('The prompt could not be saved. Please try again.')
  }

  async function generateRecording() {
    if (generatingAudio || recording || recordingStarting || !transcript.trim()) return
    setGeneratingAudio(true)
    setGenerationError('')
    setGenerationProgress(null)
    recordTtsTrace('generation-requested', { promptId: prompt?.id ?? promptIdRef.current, transcriptLength: transcript.trim().length })
    try {
          const generatedAudio = await onGenerateRecording(promptIdRef.current, transcript.trim(), setGenerationProgress, {
            userRecordingRemoved: Boolean(prompt?.audioSource !== 'tts' && isUsableRecording(prompt?.audio) && !usableAudio && audioSource === 'none'),
          })
      if (!isUsableRecording(generatedAudio)) throw new Error('The generated recording is empty.')
      setGenerationProgress({ phase: 'complete' })
      await new Promise((resolve) => window.setTimeout(resolve, 350))
      replacePromptAudio(generatedAudio, 'tts')
      recordTtsTrace('generated-audio-attached', { promptId: prompt?.id ?? promptIdRef.current, audioBytes: generatedAudio.size, transcriptLength: transcript.trim().length })
    } catch (ttsError) {
      let errorDetails
      if (ttsError instanceof Error) {
        const message = ttsError.message || 'No error message provided.'
        const stack = ttsError.stack && !ttsError.stack.includes(message) ? ttsError.stack : ''
        errorDetails = [`${ttsError.name}: ${message}`, stack].filter(Boolean).join('\n')
      } else {
        errorDetails = String(ttsError || 'Check your connection and try again.')
      }
      const traceDetails = (window.__promptLibraryTtsTrace ?? []).slice(-24).map((entry) => {
        const { time, event, ...details } = entry
        return `${time} ${event}${Object.keys(details).length ? ` ${JSON.stringify(details)}` : ''}`
      }).join('\n')
      if (traceDetails) errorDetails += `\n\nRecent TTS trace:\n${traceDetails}`
      setGenerationError(`The recording could not be generated:\n${errorDetails}`)
    } finally {
      setGeneratingAudio(false)
    }
  }

  return (
    <div className="dialog-backdrop" onMouseDown={(event) => event.target === event.currentTarget && !generatingAudio && !processingNoise && onClose()}>
      <section className="record-dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title">
        <div className="dialog-heading">
          <div>
            <p className="eyebrow">{prompt ? 'EDIT PROMPT' : 'NEW PROMPT'} <span>///</span> {folderName}</p>
            <h2 id="dialog-title">{prompt ? 'Edit prompt' : 'Add a prompt'}</h2>
          </div>
          <button className="icon-button" type="button" aria-label="Close dialog" onClick={onClose} disabled={generatingAudio || processingNoise}>{'\u00D7'}</button>
        </div>

        <form onSubmit={submitPrompt}>
          <label className="field-label" htmlFor="prompt-character">Character <span className="optional-label">OPTIONAL</span></label>
          <select id="prompt-character" className="text-field character-select" value={character} disabled={generatingAudio} onChange={(event) => setCharacter(event.target.value)}>
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
                  disabled={generatingAudio}
                >
                  {option}
                </button>
              ))}
            </div>
          </fieldset>

          <div className="recorder-panel">
            <div className="recorder-status">
              <span className={recording ? 'record-indicator is-live' : 'record-indicator'} />
              <span className={usableAudio ? 'recording-ready-status' : 'missing-recording-status'}>{generatingAudio ? 'Generating recording' : recording ? 'Recording in progress' : usableAudio ? 'Recording available' : 'Recording needed for Run'}</span>
              <span className="recording-time">{formatTime(seconds)}</span>
            </div>
            <button className={recording ? 'record-button is-recording' : 'record-button'} type="button" onClick={recording ? stopRecording : startRecording} disabled={recordingStarting || generatingAudio || processingNoise}>
              <span className="record-button-icon" aria-hidden="true">{recording ? '\u25A0' : '\u25CF'}</span>
              {recording ? 'Stop recording' : recordingStarting ? 'Starting…' : usableAudio ? 'Re-record' : 'Record audio'}
            </button>
            {usableAudio && !recording && <AudioPlayer audio={reduceBackgroundNoise && noiseReductionVersion === NOISE_REDUCTION_VERSION && isUsableRecording(noiseReducedAudio) ? noiseReducedAudio : audio} trimSilence={trimSilence} speaker={speaker} pitch={readerPitch} promptId={prompt?.id ?? promptIdRef.current} />}
            <div className="recording-actions">
              {(!usableAudio || audioSource === 'tts') && <button className="quiet-button generate-recording-button" type="button" onClick={generateRecording} disabled={generatingAudio || recording || recordingStarting || processingNoise || !transcript.trim()}>
                {generatingAudio && <span className="generation-spinner" aria-hidden="true" />}
                {generatingAudio ? ({ preparing: 'Preparing voice…', loading: 'Loading voice model…', synthesizing: 'Generating speech…', complete: 'Recording ready' }[generationPhase]) : usableAudio ? 'Generate replacement' : 'Generate recording'}
              </button>}
              <label className="quiet-button attach-recording-button">
                Attach audio
                <input type="file" accept="audio/*,.mp3,.m4a,.wav,.ogg,.webm" disabled={generatingAudio || recording || recordingStarting || processingNoise} onChange={(event) => {
                  const file = event.target.files?.[0]
                  if (file && isUsableRecording(file)) {
                    replacePromptAudio(file, 'user')
                    setError('')
                    setGenerationError('')
                  } else if (file) setError('Choose a non-empty audio recording.')
                  event.target.value = ''
                }} />
              </label>
              {usableAudio && <button className="text-action remove-recording-button" type="button" disabled={generatingAudio || recording || processingNoise} onClick={() => { replacePromptAudio(null, 'none'); setError(''); setGenerationError('') }}>Remove recording</button>}
            </div>
            {generatingAudio && <div className="recording-generation-progress" role="status" aria-live="polite">
              <ol className="recording-generation-stages" aria-label="Recording generation stages">
                {['Prepare', 'Load voice', 'Generate'].map((label, index) => (
                  <li key={label} className={index < generationStage ? 'is-complete' : index === generationStage && generationStage < 3 ? 'is-current' : ''}>
                    <span className="recording-generation-stage-marker" aria-hidden="true">{index < generationStage ? '✓' : index + 1}</span>
                    <span>{label}</span>
                  </li>
                ))}
              </ol>
            </div>}
            {error && <p className="form-error" role="alert">{error}</p>}
            {generationError && <p className="form-error recording-generation-error" role="alert">{generationError}</p>}
          </div>

          <label className="trim-silence-setting">
            <input type="checkbox" checked={trimSilence} disabled={generatingAudio} onChange={(event) => setTrimSilence(event.target.checked)} />
            <span className="trim-silence-copy">
              <strong>Cut silence from start and end</strong>
              <span>Skip quiet audio before and after speech during playback.</span>
            </span>
          </label>

          <label className={`trim-silence-setting noise-reduction-setting${processingNoise ? ' is-processing' : ''}`}>
            <input type="checkbox" checked={reduceBackgroundNoise} disabled={!usableAudio || generatingAudio || processingNoise} onChange={(event) => toggleNoiseReduction(event.target.checked)} />
            <span className="trim-silence-copy">
              <strong>Reduce background noise</strong>
              <span>Reduce low rumble, hiss, and quiet background noise between phrases. The original stays unchanged.</span>
              {processingNoise && <span className="noise-reduction-progress" role="status"><span className="generation-spinner" aria-hidden="true" /> Preparing filtered playback…</span>}
              {noiseReductionError && <span className="noise-reduction-error" role="alert">{noiseReductionError}</span>}
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
              disabled={generatingAudio}
              lang="en"
              spellCheck="true"
              value={transcript}
              onChange={(event) => {
                const value = event.target.value
                if (recording || recordingStartingRef.current) liveTranscriptionAllowedRef.current = false
                setTranscript(value)
                if (value.trim()) setTranscriptError('')
              }}
              placeholder="Paste or type an English transcript, or start recording..."
              rows={3}
            />
            {transcriptError && <p className="form-error" role="alert">{transcriptError}</p>}
          </div>
          <div className="dialog-actions">
            <button className="quiet-button" type="button" onClick={onClose} disabled={generatingAudio || processingNoise}>Cancel</button>
            <div className="dialog-submit-group">
              <button className="primary-button" type="submit" disabled={!transcript.trim() || recording || recordingStarting || generatingAudio || processingNoise}>{prompt ? 'Save changes' : 'Save prompt'} <span aria-hidden="true">{'\u2192'}</span></button>
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
  const [pdfScripts, setPdfScripts] = useState([])
  const [pdfLibrary, setPdfLibrary] = useState([])
  const [selectedFolderId, setSelectedFolderId] = useState(null)
  const [folderDialog, setFolderDialog] = useState(null)
  const [promptDialog, setPromptDialog] = useState(null)
  const [isImportingScript, setIsImportingScript] = useState(false)
  const [isLoading, setIsLoading] = useState(true)
  const [storageError, setStorageError] = useState('')
  const [isLightMode, setIsLightMode] = useState(false)
  const [runSpeakers, setRunSpeakers] = useState({ Myself: false, Reader: true })
  const [readerPitch, setReaderPitch] = useState(1)
  const [readerPitchDraft, setReaderPitchDraft] = useState(1)
  const [readerPitchApplyVersion, setReaderPitchApplyVersion] = useState(0)
  const readerPitchRef = useRef(readerPitch)
  readerPitchRef.current = readerPitch
  const [runStatus, setRunStatus] = useState(null)
  const [isRunPaused, setIsRunPaused] = useState(false)
  const [isRunPrompterFullscreen, setIsRunPrompterFullscreen] = useState(false)
  const [runError, setRunError] = useState('')
  const [runValidationPromptIds, setRunValidationPromptIds] = useState([])
  const [rehearsalView, setRehearsalView] = useState(null)
  const [pdfRunMode, setPdfRunMode] = useState(false)
  const [pdfSyncResetKey, setPdfSyncResetKey] = useState(0)
  const [isTeleprompterFullscreen, setIsTeleprompterFullscreen] = useState(false)
  const [isAddingCharacter, setIsAddingCharacter] = useState(false)
  const [isFolderSettingsOpen, setIsFolderSettingsOpen] = useState(false)
  const [characterName, setCharacterName] = useState('')
  const [draggedPromptId, setDraggedPromptId] = useState(null)
  const [dragOverPromptId, setDragOverPromptId] = useState(null)
  const [dragDropPosition, setDragDropPosition] = useState('before')
  const dragOverlayRef = useRef(null)
  const activePlaybackRef = useRef(null)
  const pendingRunSkipRef = useRef(null)
  const runPausedRef = useRef(false)
  const playbackSessionRef = useRef(0)
  const rehearsalSessionRef = useRef(null)
  const rehearsalPanelRef = useRef(null)
  const runPrompterRef = useRef(null)
  const runKeyboardControlsRef = useRef(null)
  const promptDragRef = useRef(null)
  const ttsGeneratingPromptIdsRef = useRef(new Set())
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
  const hasRunPlayback = Boolean(runStatus && !runStatus.completed)
  const runHasEnded = Boolean(runStatus?.completed)
  const hasRehearsalSession = Boolean(rehearsalView)
  const isRehearsalRunning = Boolean(rehearsalView && !['completed', 'error'].includes(rehearsalView.status))
  const nextRehearsalPrompt = isRehearsalRunning
    ? rehearsalSessionRef.current?.lines[rehearsalView.index + 1] ?? null
    : null
  const activeRehearsalPrompt = hasRehearsalSession
    ? rehearsalSessionRef.current?.lines[rehearsalView.index] ?? null
    : null
  const selectedPdfLink = pdfScripts.find((script) => script.folderId === selectedFolderId) ?? null
  const selectedPdfScript = pdfLibrary.find((pdf) => pdf.id === selectedPdfLink?.pdfId)
    ?? (selectedPdfLink?.blob ? selectedPdfLink : null)
  const rehearsalIsComplete = rehearsalView?.status === 'completed'
  const rehearsalIsListening = ['listening', 'speech-end', 'waiting'].includes(rehearsalView?.status)
  const rehearsalStatusLabel = rehearsalView?.status === 'paused'
    ? 'Paused'
    : rehearsalView?.status === 'completed'
      ? 'Complete'
      : rehearsalView?.status === 'error'
        ? 'Error'
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
  const canReorderPrompts = (!runStatus || runHasEnded) && (!rehearsalView || ['completed', 'error'].includes(rehearsalView.status))

  useEffect(() => {
    Promise.all([readAll('folders'), readAll('prompts'), readAll('pdfScripts'), readAll('pdfLibrary')])
      .then(([savedFolders, savedPrompts, savedPdfScripts, savedPdfLibrary]) => {
        const { prompts: positionedPrompts, changed } = normalizePromptPositions(savedPrompts)
        setFolders(savedFolders.sort((a, b) => b.createdAt - a.createdAt))
        setPrompts(positionedPrompts.sort((a, b) => b.createdAt - a.createdAt))
        setPdfScripts(savedPdfScripts)
        setPdfLibrary(savedPdfLibrary)
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
    if (!hasRehearsalSession) {
      const panel = rehearsalPanelRef.current
      if (panel && document.fullscreenElement === panel && typeof document.exitFullscreen === 'function') {
        Promise.resolve(document.exitFullscreen()).catch(() => {})
      } else {
        setIsTeleprompterFullscreen(false)
      }
    }
  }, [hasRehearsalSession])

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
      return null
    }
  }

  async function addPdfToLibrary(file, displayName = file?.name) {
    if (!file || (!file.type?.includes('pdf') && !displayName?.toLocaleLowerCase().endsWith('.pdf'))) {
      throw new Error('Choose a PDF file to add to your library.')
    }
    let fingerprint
    if (globalThis.crypto?.subtle) {
      const digest = await globalThis.crypto.subtle.digest('SHA-256', await readBlobAsArrayBuffer(file))
      fingerprint = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
    } else {
      fingerprint = `${displayName.toLocaleLowerCase()}-${file.size}-${file.lastModified ?? 0}`
    }
    const existing = pdfLibrary.find((pdf) => pdf.fingerprint === fingerprint)
    if (existing) return existing
    const record = { id: makeId(), fingerprint, name: displayName, blob: file, size: file.size, addedAt: Date.now() }
    await saveRecord('pdfLibrary', record)
    setPdfLibrary((current) => [...current, record])
    setStorageError('')
    return record
  }

  async function assignPdfToFolder(pdfId, folderId = selectedFolderId, pdfOverride = null) {
    const pdf = pdfLibrary.find((entry) => entry.id === pdfId) ?? pdfOverride
    if (!pdf || !folderId) throw new Error('Choose a PDF and open a folder first.')
    const link = { folderId, pdfId, name: pdf.name, updatedAt: Date.now() }
    await saveRecord('pdfScripts', link)
    setPdfScripts((current) => [...current.filter((entry) => entry.folderId !== folderId), link])
  }

  async function savePdfSides(file) {
    if (!selectedFolder) return
    try {
      const pdf = await addPdfToLibrary(file)
      await assignPdfToFolder(pdf.id, selectedFolder.id, pdf)
    } catch (error) {
      setStorageError(error?.message || 'The sides PDF could not be saved in this browser. Check available local storage.')
    }
  }

  async function selectPdfForFolder(pdfId) {
    try {
      await assignPdfToFolder(pdfId)
    } catch (error) {
      setStorageError(error?.message || 'The PDF could not be assigned to this folder.')
    }
  }

  async function removePdfFromLibrary(pdf) {
    if (!window.confirm(`Remove "${pdf.name}" from the PDF library? It will also be unlinked from any folders.`)) return
    try {
      const database = await openDatabase()
      await new Promise((resolve, reject) => {
        const transaction = database.transaction(['pdfLibrary', 'pdfScripts'], 'readwrite')
        transaction.objectStore('pdfLibrary').delete(pdf.id)
        const links = transaction.objectStore('pdfScripts')
        const request = links.openCursor()
        request.onsuccess = () => {
          const cursor = request.result
          if (!cursor) return
          if (cursor.value.pdfId === pdf.id) cursor.delete()
          cursor.continue()
        }
        transaction.oncomplete = resolve
        transaction.onerror = () => reject(transaction.error)
      })
      setPdfLibrary((current) => current.filter((entry) => entry.id !== pdf.id))
      setPdfScripts((current) => current.filter((entry) => entry.pdfId !== pdf.id))
    } catch {
      setStorageError('This PDF could not be removed from the library.')
    }
  }

  async function uploadPdfToLibrary(event) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    try {
      const existing = await addPdfToLibrary(file)
      if (existing.blob !== file) setStorageError('That PDF is already in your library.')
    } catch (error) {
      setStorageError(error?.message || 'The PDF could not be saved. Your browser may be low on storage.')
    }
  }

  function startPdfRehearsal() {
    if (!selectedPdfScript?.blob) return
    setPdfRunMode(true)
    startRehearsal()
  }

  function startClassicRehearsal() {
    setPdfRunMode(false)
    startRehearsal()
  }

  function openFolder(folderId) {
    setPdfRunMode(false)
    setSelectedFolderId(folderId)
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
      return savedPrompt
    } catch {
      setStorageError('This prompt could not be saved. Check available browser storage.')
      return null
    }
  }

  async function generateRecordingForPrompt(promptId, transcript, onProgress, { userRecordingRemoved = false } = {}) {
    if (ttsGeneratingPromptIdsRef.current.has(promptId)) throw new Error('A recording is already being generated for this prompt.')
    ttsGeneratingPromptIdsRef.current.add(promptId)
    try {
      const current = prompts.find((item) => item.id === promptId)
      if (blocksRecordingGeneration(current, userRecordingRemoved, isUsableRecording)) {
        throw new Error('This prompt already has a user recording. Remove or replace that recording explicitly first.')
      }
      const audio = await generateTtsAudio(transcript, onProgress)
      if (!isUsableRecording(audio)) throw new Error('The generated audio was empty.')
      return audio
    } finally {
      ttsGeneratingPromptIdsRef.current.delete(promptId)
    }
  }

  function blockRunWhenRecordingsMissing(candidatePrompts, runName) {
    const missingPrompts = candidatePrompts.filter((prompt) => prompt.type !== 'silence' && !isUsableRecording(prompt.audio))
    setRunValidationPromptIds(missingPrompts.map((prompt) => prompt.id))
    if (missingPrompts.length === 0) return false
    setRunError(`Can't start ${runName}: ${missingPrompts.length} prompt${missingPrompts.length === 1 ? ' is' : 's are'} missing a usable recording. Add a recording to each prompt below.`)
    return true
  }

  async function importScriptPrompts(lines, selectedCharacter, detectedCharacters, importOptions = {}) {
    if (!selectedFolder) throw new Error('Open a folder before importing a script.')
    const firstPosition = folderPrompts.reduce((latest, item, index) => Math.max(latest, item.position ?? index), -1) + 1
    const timestamp = Math.max(Date.now(), folderPrompts.reduce((latest, item) => Math.max(latest, item.createdAt ?? 0), 0) + 1)
    const preparedPrompts = lines.map((line, index) => ({
        id: makeId(),
        folderId: selectedFolderId,
        speaker: line.character === selectedCharacter ? 'Myself' : 'Reader',
        character: line.character,
        audio: null,
        audioSource: 'none',
        trimSilence: false,
        transcript: validateScriptDialogue(line.text).text,
        createdAt: timestamp + index,
        position: firstPosition + index,
      }))
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
    if (importOptions.file && selectedFolderId) {
      try {
        const pdf = importOptions.pdfId
          ? pdfLibrary.find((entry) => entry.id === importOptions.pdfId)
          : await addPdfToLibrary(importOptions.file, importOptions.fileName || importOptions.file.name)
        if (!pdf) throw new Error('The selected PDF is no longer in the library.')
        await assignPdfToFolder(pdf.id, selectedFolderId, pdf)
      } catch {
        setStorageError('Prompts imported, but the original PDF could not be saved to your PDF library. You can add it from the home screen.')
      }
    }
    setIsImportingScript(false)
  }
  function editPrompt(prompt) {
    stopRun()
    stopRehearsal()
    setRunError('')
    setRunValidationPromptIds([])
    setPromptDialog({ prompt })
  }

  function addSilenceRow() {
    savePrompt({ id: makeId(), type: 'silence', duration: 3, createdAt: Date.now() })
  }

  function adjustSilenceDuration(prompt, adjustment) {
    const duration = Math.max(1, Math.min(600, (prompt.duration ?? 3) + adjustment))
    savePrompt({ ...prompt, duration })
  }

  async function reorderPrompts(draggedId, targetId, position = 'before') {
    if (!draggedId || draggedId === targetId || (runStatus && !runHasEnded) || (rehearsalView && !['completed', 'error', 'stopped'].includes(rehearsalView.status))) return
    const ordered = movePromptInList(folderPrompts, draggedId, targetId, position)
    if (ordered === folderPrompts) return
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
      !dragHandle ||
      (event.target.closest('button, input, select, audio') && !dragHandle)
    ) return
    const bounds = event.currentTarget.getBoundingClientRect()
    promptDragRef.current = {
      promptId,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      offsetX: event.clientX - bounds.left,
      offsetY: event.clientY - bounds.top,
      width: bounds.width,
      height: bounds.height,
      active: false,
    }
    try { event.currentTarget.setPointerCapture(event.pointerId) } catch { /* the browser may cancel capture during touch handoff */ }
  }

  function movePromptDrag(event) {
    const drag = promptDragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    if (!drag.active && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 6) return
    drag.active = true
    document.body.classList.add('is-reordering-prompts')
    event.preventDefault()
    if (!dragOverlayRef.current) {
      const source = [...document.querySelectorAll('[data-prompt-id]')].find((element) => element.dataset.promptId === drag.promptId)
      if (source) {
        const overlay = source.cloneNode(true)
        overlay.classList.remove('is-drag-over', 'is-drop-before', 'is-drop-after', 'is-drag-source')
        overlay.classList.add('is-dragging', 'prompt-drag-overlay')
        overlay.setAttribute('aria-hidden', 'true')
        const sourceNodes = [source, ...source.querySelectorAll('*')]
        const overlayNodes = [overlay, ...overlay.querySelectorAll('*')]
        sourceNodes.forEach((sourceNode, index) => {
          const computed = window.getComputedStyle(sourceNode)
          for (let propertyIndex = 0; propertyIndex < computed.length; propertyIndex += 1) {
            const property = computed.item(propertyIndex)
            if (index === 0 && ['position', 'left', 'top', 'width', 'height', 'margin', 'transform', 'box-shadow', 'opacity', 'z-index', 'pointer-events'].includes(property)) continue
            overlayNodes[index].style.setProperty(property, computed.getPropertyValue(property))
          }
        })
        const appStyles = window.getComputedStyle(document.querySelector('.app-shell'))
        for (let propertyIndex = 0; propertyIndex < appStyles.length; propertyIndex += 1) {
          const property = appStyles.item(propertyIndex)
          if (property.startsWith('--tone-')) overlay.style.setProperty(property, appStyles.getPropertyValue(property))
        }
        overlay.querySelectorAll('[id]').forEach((element) => element.removeAttribute('id'))
        overlay.querySelectorAll('audio,button,input,select,textarea').forEach((element) => { element.style.opacity = '0'; element.tabIndex = -1 })
        overlay.style.position = 'fixed'
        overlay.style.left = `${event.clientX - drag.offsetX}px`
        overlay.style.top = `${event.clientY - drag.offsetY}px`
        overlay.style.width = `${drag.width}px`
        overlay.style.height = `${drag.height}px`
        overlay.style.margin = '0'
        overlay.style.zIndex = '9999'
        overlay.style.pointerEvents = 'none'
        document.body.appendChild(overlay)
        dragOverlayRef.current = overlay
      }
    }
    if (dragOverlayRef.current) {
      dragOverlayRef.current.style.left = `${event.clientX - drag.offsetX}px`
      dragOverlayRef.current.style.top = `${event.clientY - drag.offsetY}px`
    }
    setDraggedPromptId(drag.promptId)
    const location = getPromptDropLocation(event, drag.promptId)
    setDragOverPromptId(location?.targetId ?? null)
    if (location) setDragDropPosition(location.position)
  }

  function getPromptDropLocation(event, draggedId) {
    const list = document.querySelector('.prompt-list')
    const overlay = dragOverlayRef.current
    if (!list || !overlay) return null
    const listBounds = list.getBoundingClientRect()
    if (event.clientX < listBounds.left || event.clientX > listBounds.right) return null
    const rows = [...list.querySelectorAll('[data-prompt-id]')]
      .filter((row) => row.dataset.promptId !== draggedId)
      .map((row) => {
        const bounds = row.getBoundingClientRect()
        return { id: row.dataset.promptId, top: bounds.top, height: bounds.height }
      })
    const overlayBounds = overlay.getBoundingClientRect()
    const itemCenterY = overlayBounds.top + overlayBounds.height / 2
    if (rows.length === 0) return null
    return findPromptInsertion(rows, draggedId, itemCenterY)
  }

  function finishPromptDrag(event) {
    const drag = promptDragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    if (drag.active && dragOverlayRef.current) {
      dragOverlayRef.current.style.left = `${event.clientX - drag.offsetX}px`
      dragOverlayRef.current.style.top = `${event.clientY - drag.offsetY}px`
    }
    const location = drag.active ? getPromptDropLocation(event, drag.promptId) : null
    if (location) {
      reorderPrompts(drag.promptId, location.targetId, location.position)
    }
    promptDragRef.current = null
    dragOverlayRef.current?.remove()
    dragOverlayRef.current = null
    document.body.classList.remove('is-reordering-prompts')
    setDraggedPromptId(null)
    setDragOverPromptId(null)
    setDragDropPosition('before')
  }

  function cancelPromptDrag() {
    promptDragRef.current = null
    dragOverlayRef.current?.remove()
    dragOverlayRef.current = null
    document.body.classList.remove('is-reordering-prompts')
    setDraggedPromptId(null)
    setDragOverPromptId(null)
    setDragDropPosition('before')
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
        setPdfRunMode(false)
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
    window.__promptAudioRuntime = null
  }

  function applyReaderPitch() {
    if (readerPitchDraft === readerPitch) return

    stopRun()
    stopRehearsal()
    document.querySelectorAll('.audio-player-group[data-audio-speaker="Reader"] audio').forEach((audio) => {
      audio.pause()
      try { audio.currentTime = 0 } catch { /* the media element may not be seekable yet */ }
    })
    readerPitchRef.current = readerPitchDraft
    setReaderPitch(readerPitchDraft)
    setReaderPitchApplyVersion((version) => version + 1)
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
    if (window.__promptAudioRuntime) window.__promptAudioRuntime = { ...window.__promptAudioRuntime, phase: 'paused' }
  }

  function resumeRun() {
    const playback = activePlaybackRef.current
    if (!runStatus || !playback) return
    runPausedRef.current = false
    setIsRunPaused(false)
    playback.paused = false
    playback.resume?.()
    if (window.__promptAudioRuntime) window.__promptAudioRuntime = { ...window.__promptAudioRuntime, phase: 'playing' }
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
    const traceKey = `${status}:${session.index}:${line?.id ?? 'none'}`
    if (session.lastTraceKey !== traceKey) {
      session.lastTraceKey = traceKey
      recordRehearsalTrace(session, 'phase', { status, speaker: line?.speaker ?? line?.type ?? 'none' })
    }
    window.__promptRehearsalRuntime = {
      sessionId: session.sessionId,
      promptId: line?.id ?? null,
      phase: status,
      prompt: `${Math.max(0, session.index + 1)}/${session.lines.length}`,
      speaker: line?.speaker ?? line?.type ?? 'none',
    }
    const showMyselfWordFollow = line?.speaker === 'Myself' && ['listening', 'speech-end', 'paused'].includes(status)
    setRehearsalView({
      status,
      index: Math.max(0, Math.min(session.index, session.lines.length - 1)),
      total: session.lines.length,
      promptId: line?.id ?? null,
      speaker: line?.type === 'silence' ? 'Silence' : line?.speaker ?? '',
      label: line ? formatPromptLabel(line, session.index + 1) : '',
      dialogue: line?.type === 'silence' ? '(SILENCE)' : line?.transcript ?? '',
      remainingSeconds: session.phase === 'completed'
        ? session.finalRemainingSeconds ?? null
        : session.phase === 'silence'
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
    recordRehearsalTrace(session, 'rehearsal-failed', { message })
    disposeRehearsalSession(session)
    session.phase = 'error'
    session.message = message
    updateRehearsalView(session, 'error')
  }

  function completeRehearsal(session) {
    window.clearInterval(session.readerCountdownTimer)
    session.readerCountdownTimer = null
    session.index = Math.max(0, session.lines.length - 1)
    const finalLine = session.lines[session.index]
    session.finalRemainingSeconds = finalLine?.type === 'silence'
      ? 0
      : finalLine?.speaker === 'Reader' && Number.isFinite(session.readerEndTime)
        ? Math.ceil(Math.max(0, session.readerEndTime - (session.readerAudio?.audio.currentTime ?? session.readerEndTime)))
        : null
    session.phase = 'completed'
    session.message = 'Script complete.'
    stopRehearsalVoiceMonitor(session)
    updateRehearsalView(session, 'completed')
    window.__promptRehearsalRuntime = { sessionId: session.sessionId, promptId: null, phase: 'completed', prompt: `${session.lines.length}/${session.lines.length}`, speaker: 'none' }
  }

  function updateMyselfTriggerMatch(session) {
    const match = getFinalWordTriggerMatch(
      session.recognizedTranscript,
      session.expectedWords,
      session.expectedCount,
    )
    session.recognizedTriggerWordCount = match.count
    session.triggerSatisfied = match.satisfied
    return match
  }

  function scheduleMyselfAdvance(session) {
    if (rehearsalSessionRef.current !== session || !session.triggerSatisfied || session.phase === 'advancing') return

    session.phase = 'speech-end'
    session.message = ''
    updateRehearsalView(session, 'speech-end')
    if (!session.speechEnded || session.advanceTimer !== null) return

    session.advanceTimer = window.setTimeout(() => {
      session.advanceTimer = null
      const finalMatch = updateMyselfTriggerMatch(session)
      if (
        rehearsalSessionRef.current !== session ||
        session.phase !== 'speech-end' ||
        !session.speechEnded ||
        !finalMatch.satisfied
      ) return

      advanceMyselfLine(session)
    }, MYSELF_FINAL_TRANSCRIPT_SETTLE_MS)
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
    session.expectedWords = []
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
          session.voiceActivitySeen &&
          !session.speechEnded &&
          session.lastVoiceAt !== null &&
          now - session.lastVoiceAt >= MYSELF_SPEECH_END_MS
        ) {
          session.speechEnded = true
          updateMyselfTriggerMatch(session)
          if (session.triggerSatisfied) scheduleMyselfAdvance(session)
          else updateRehearsalView(session, session.recognizedTriggerWordCount > 0 ? 'waiting' : 'listening')
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
    if (!window.isSecureContext) {
      failRehearsal(session, 'Speech recognition requires HTTPS on your iPhone. Open the HTTPS LAN development URL and allow microphone access.')
      return
    }
    const SpeechRecognitionApi = window.SpeechRecognition || window.webkitSpeechRecognition
    if (!SpeechRecognitionApi) {
      failRehearsal(session, 'Speech recognition is not supported in this browser.')
      return
    }

    const line = session.lines[session.index]
    if (session.activeLineIndex !== session.index) {
      const expectedWords = normalizeTranscriptWords(line.transcript)
      session.expectedWords = expectedWords
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
      session.recognitionRecoveryAttempts = 0
      session.recognitionRecoveryTimer = null
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
    recordRehearsalTrace(session, 'recognition-created')

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
      updateMyselfTriggerMatch(session)
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
      updateMyselfTriggerMatch(session)
      if (session.triggerSatisfied) scheduleMyselfAdvance(session)
      else updateRehearsalView(session, session.recognizedTriggerWordCount > 0 ? 'waiting' : 'listening')
    }

    recognition.onerror = (event) => {
      recordRehearsalTrace(session, 'recognition-error', { error: event.error ?? 'unknown' })
      if (rehearsalSessionRef.current !== session || session.recognition !== recognition || !['listening', 'speech-end'].includes(session.phase)) return
      if (isRecoverableRecognitionInterruption(event.error)) {
        session.recognitionInterrupted = true
        return
      }
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
      recordRehearsalTrace(session, 'recognition-ended')
      if (rehearsalSessionRef.current !== session || session.recognition !== recognition) return
      session.recognition = null
      session.committedTranscript = [session.committedTranscript, session.currentFinalTranscript].filter(Boolean).join(' ')
      session.currentFinalTranscript = ''
      session.currentInterimTranscript = ''
      session.recognizedTranscript = session.committedTranscript
      updateMyselfTriggerMatch(session)

      if (session.phase === 'paused') {
        updateRehearsalView(session, 'paused')
      } else if (session.triggerSatisfied && session.speechEnded) {
        scheduleMyselfAdvance(session)
      } else if (['listening', 'waiting', 'speech-end'].includes(session.phase)) {
        if (session.recognitionRecoveryAttempts >= 2) {
          failRehearsal(session, 'Speech recognition stopped repeatedly. Check microphone access or restart rehearsal to try again.')
          return
        }
        session.recognitionRecoveryAttempts += 1
        const delay = session.recognitionInterrupted ? 250 : 500
        session.recognitionInterrupted = false
        recordRehearsalTrace(session, 'recognition-retry-scheduled', { attempt: session.recognitionRecoveryAttempts, delayMs: delay })
        session.recognitionRecoveryTimer = window.setTimeout(() => {
          session.recognitionRecoveryTimer = null
          if (rehearsalSessionRef.current === session && ['listening', 'waiting', 'speech-end'].includes(session.phase) && !session.recognition) {
            startRehearsalListening(session)
          }
        }, delay)
      } else {
        updateRehearsalView(session, session.phase)
      }
    }

    try {
      recognition.start()
      recordRehearsalTrace(session, 'recognition-started')
    } catch {
      failRehearsal(session, 'Could not start speech recognition. Restart rehearsal to try again.')
    }
  }

  function createRehearsalReaderPlayback(session, line, isPreloading = false) {
    const prepareStartedAt = performance.now()
    const objectUrl = URL.createObjectURL(line.audio)
    const audio = new Audio()
    audio.preload = 'auto'
    const playback = { audio, objectUrl, pitchCleanup: null, trimCleanup: null, line, cancelled: false, isPreloaded: isPreloading }
    recordRehearsalTrace(session, isPreloading ? 'reader-preload-started' : 'reader-preparation-started', {
      targetPromptId: line.id,
      targetPrompt: formatPromptLabel(line, session.lines.indexOf(line) + 1),
    })
    audio.src = objectUrl
    audio.load()
    playback.ready = Promise.all([
      waitForAudioMetadata(audio),
      prepareReaderPitch(audio, 'Reader', readerPitchRef.current),
      line.trimSilence ? getAudioBounds(line.audio) : Promise.resolve(null),
    ]).then(([, cleanup]) => {
      if (playback.cancelled) {
        cleanup()
      } else {
        playback.pitchCleanup = cleanup
      }
      if (audio.error) throw new Error(`Audio file could not be loaded (media error ${audio.error.code}).`)
      playback.preparedAt = performance.now()
      recordRehearsalTrace(session, isPreloading ? 'reader-preload-ready' : 'reader-preparation-ready', {
        targetPromptId: line.id,
        preparationMs: Math.round(playback.preparedAt - prepareStartedAt),
      })
      return playback
    }).catch((error) => {
      playback.error = error
      recordRehearsalTrace(session, 'reader-preparation-failed', {
        targetPromptId: line.id,
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        preparationMs: Math.round(performance.now() - prepareStartedAt),
      })
      return playback
    })
    return playback
  }

  function prepareNextRehearsalReader(session) {
    let nextReader = null
    for (let index = session.index + 1; index < session.lines.length; index += 1) {
      if (session.lines[index].speaker === 'Reader' && session.lines[index].audio) {
        nextReader = session.lines[index]
        break
      }
    }
    if (!nextReader) {
      disposePreloadedRehearsalReader(session)
      return
    }
    if (session.preloadedReader?.line === nextReader) return
    disposePreloadedRehearsalReader(session)
    session.preloadedReader = createRehearsalReaderPlayback(session, nextReader, true)
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
      prepareNextRehearsalReader(session)
      startRehearsalSilence(session, line)
      return
    }

    if (!line.transcript?.trim()) {
      failRehearsal(session, `${formatPromptLabel(line, session.index + 1)} has no transcript. Add one before rehearsing.`)
      return
    }

    if (line.speaker === 'Myself') {
      prepareNextRehearsalReader(session)
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
    let playback = session.preloadedReader?.line === line ? session.preloadedReader : null
    if (playback) session.preloadedReader = null
    else {
      disposePreloadedRehearsalReader(session)
      playback = createRehearsalReaderPlayback(session, line)
    }
    playback.isPreloaded = Boolean(playback.isPreloaded)
    playback.activationAt = performance.now()
    prepareNextRehearsalReader(session)
    const { audio, objectUrl } = playback
    session.readerAudio = playback
    const finishPlayback = () => {
      if (rehearsalSessionRef.current !== session || session.readerAudio !== playback || session.phase !== 'speaking') return
      window.clearInterval(session.readerCountdownTimer)
      session.readerCountdownTimer = null
      audio.onended = null
      audio.onerror = null
      playback.trimCleanup?.()
      playback.pitchCleanup?.()
      playback.cancelled = true
      URL.revokeObjectURL(objectUrl)
      session.readerAudio = null
      session.index += 1
      processRehearsalLine(session)
    }
    audio.onended = finishPlayback
    audio.onerror = () => {
      recordRehearsalTrace(session, 'reader-audio-error', { mediaErrorCode: audio.error?.code ?? null })
      if (rehearsalSessionRef.current !== session || session.readerAudio !== playback || session.phase !== 'speaking') return
      failRehearsal(session, `The Reader recording ${formatPromptLabel(line, session.index + 1)} could not be played.`)
    }
    const preparePlayback = async () => {
      await playback.ready
      if (playback.error) throw playback.error
      if (!line.trimSilence) await waitForAudioMetadata(audio)
      return prepareAudioTrim(audio, line.audio, line.trimSilence, finishPlayback)
    }
    preparePlayback().then(({ cleanup, duration }) => {
      playback.trimCleanup = cleanup
      if (rehearsalSessionRef.current !== session || session.readerAudio !== playback) {
        cleanup()
        playback.pitchCleanup?.()
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
        recordRehearsalTrace(session, 'reader-play-requested', {
          targetPromptId: line.id,
          preloaded: playback.isPreloaded,
          waitAfterTransitionMs: Math.round(performance.now() - playback.activationAt),
        })
        resumeReaderPitch(audio).then(() => {
          if (rehearsalSessionRef.current !== session || session.readerAudio !== playback || session.phase !== 'speaking') return
          audio.play().catch(() => {
            recordRehearsalTrace(session, 'reader-audio-play-rejected')
            if (rehearsalSessionRef.current === session && session.readerAudio === playback && session.phase === 'speaking') {
              failRehearsal(session, 'Reader playback was interrupted. Restart rehearsal to try again.')
            }
          })
        }).catch(() => {
          failRehearsal(session, 'Reader playback could not be initialized. Restart rehearsal to try again.')
        })
      } catch {
        failRehearsal(session, 'Reader playback could not be started. Restart rehearsal to try again.')
      }
    }).catch((error) => {
      if (rehearsalSessionRef.current !== session || session.readerAudio !== playback) playback.pitchCleanup?.()
      recordRehearsalTrace(session, 'reader-audio-prepare-failed', {
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      })
      if (rehearsalSessionRef.current === session && session.readerAudio === playback) {
        failRehearsal(session, `Reader recording ${formatPromptLabel(line, session.index + 1)} could not be prepared: ${error?.message || 'unknown audio error'}`)
      }
    })
  }

  function stopRehearsal() {
    const session = rehearsalSessionRef.current
    rehearsalSessionRef.current = null
    disposeRehearsalSession(session)
    setRehearsalView(null)
    window.__promptRehearsalRuntime = null
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

  function startRehearsalAt(startIndex) {
    if (blockRunWhenRecordingsMissing(folderPrompts, 'Run With Me')) return
    setPdfSyncResetKey((current) => current + 1)
    setRunError('')
    stopRun()
    stopRehearsal()
    const safeStartIndex = Number.isInteger(startIndex) ? startIndex : 0
    const session = {
      sessionId: makeId(),
      lines: folderPrompts.map((prompt) => ({ ...prompt, audio: getPromptPlaybackAudio(prompt) })),
      index: Math.max(0, Math.min(safeStartIndex, folderPrompts.length - 1)),
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
    recordRehearsalTrace(session, 'rehearsal-started', { lineCount: session.lines.length })
    if (session.lines.length === 0) {
      failRehearsal(session, 'Add prompts to this folder before starting rehearsal.')
      return
    }
    processRehearsalLine(session)
  }

  function startRehearsal() {
    startRehearsalAt(0)
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
    if (session.phase === 'completed') {
      startRehearsalAt(session.index - 1)
      return
    }
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
      resumeReaderPitch(session.readerAudio?.audio)
        .then(() => session.readerAudio?.audio.play())
        .catch(() => failRehearsal(session, 'Reader playback could not be resumed. Restart rehearsal to try again.'))
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
    const queue = runQueue.map((prompt) => ({ ...prompt, audio: getPromptPlaybackAudio(prompt) }))
    if (queue.length === 0) return
    if (blockRunWhenRecordingsMissing(queue, 'Run')) return
    stopRehearsal()
    pendingRunSkipRef.current = null
    runPausedRef.current = false
    setIsRunPaused(false)

    setRunError('')
    const session = playbackSessionRef.current + 1
    playbackSessionRef.current = session

    let completedNormally = true
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

      if (!prompt.audio) {
        setRunError(`"${label}" has no usable recording. Edit the prompt and add one before running.`)
        break
      }

      const objectUrl = URL.createObjectURL(prompt.audio)
      const audio = new Audio(objectUrl)
      window.__promptAudioRuntime = { mode: 'Run', sessionId: session, promptId: prompt.id, label, speaker: prompt.speaker, phase: 'preparing' }
      let pitchCleanup = () => {}
      const selectedPitch = readerPitchRef.current
      const pitchSetup = prepareReaderPitch(audio, prompt.speaker, selectedPitch)
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
          pitchCleanup()
          audio.removeEventListener('ended', onEnded)
          audio.removeEventListener('error', onError)
          resolve(didPlay)
        }
        const onEnded = () => {
          recordPromptAudioTrace('run-media-ended', { promptId: prompt.id, sessionId: session, speaker: prompt.speaker })
          finish(true)
        }
        const onError = () => {
          recordPromptAudioTrace('run-media-error', { promptId: prompt.id, sessionId: session, speaker: prompt.speaker, mediaErrorCode: audio.error?.code ?? null })
          finish(false)
        }
        const pausePlayback = () => {
          audio.pause()
        }
        const resumePlayback = () => {
          if (settled || runPausedRef.current || !trimReady) return
          resumeReaderPitch(audio).then(() => audio.play()).catch((error) => {
            recordPromptAudioTrace('run-play-rejected', { promptId: prompt.id, sessionId: session, error: error?.message ?? String(error) })
            finish(false)
          })
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
        waitForAudioMetadata(audio).then(async () => {
          pitchCleanup = await pitchSetup
          recordPromptAudioTrace('run-pitch-ready', { promptId: prompt.id, sessionId: session, speaker: prompt.speaker, pitch: selectedPitch })
          window.__promptAudioRuntime = { mode: 'Run', sessionId: session, promptId: prompt.id, label, speaker: prompt.speaker, phase: 'playing' }
          if (settled) {
            pitchCleanup()
            return { cleanup: () => {}, duration: 0 }
          }
          return prepareAudioTrim(audio, prompt.audio, prompt.trimSilence, () => finish(true))
        }).then(({ cleanup, duration }) => {
          if (session !== playbackSessionRef.current) {
            cleanup()
            finish(false)
            return
          }
          if (settled) {
            cleanup()
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
        }).catch((error) => {
          recordPromptAudioTrace('run-audio-setup-failed', { promptId: prompt.id, sessionId: session, error: error?.message ?? String(error), stack: error?.stack })
          setRunError(`Audio could not be prepared for "${label}": ${error?.message ?? String(error)}`)
          finish(false)
        })
      })

      URL.revokeObjectURL(objectUrl)
      if (activePlaybackRef.current?.audio === audio) activePlaybackRef.current = null
      if (session !== playbackSessionRef.current) return
      if (!played) {
        setRunError(`Playback stopped at "${label}".`)
        completedNormally = false
        break
      }
    }

    if (session === playbackSessionRef.current) {
      runPausedRef.current = false
      setIsRunPaused(false)
      if (completedNormally) {
        setRunStatus((current) => current ? { ...current, completed: true, remainingSeconds: 0 } : current)
      } else {
        setRunStatus(null)
      }
      window.__promptAudioRuntime = null
    }
  }

  function toggleRunSpeaker(speaker) {
    setRunSpeakers((current) => ({ ...current, [speaker]: !current[speaker] }))
  }

  runKeyboardControlsRef.current = {
    runStatus: hasRunPlayback ? runStatus : null,
    isRunPaused,
    isRehearsalRunning,
    rehearsalStatus: rehearsalView?.status,
    pauseRun,
    resumeRun,
    skipRunPrompt,
    previousRunPrompt,
    pauseRehearsal,
    resumeRehearsal,
    skipRehearsalCurrent,
    previousRehearsalPrompt,
  }

  useEffect(() => {
    if (!hasRunPlayback && !isRehearsalRunning) return undefined

    function handleRunKeyboardControls(event) {
      if (event.altKey || event.ctrlKey || event.metaKey) return
      const target = event.target
      if (target instanceof HTMLElement && target.closest('input, textarea, select, [contenteditable="true"], button, a, [role="button"]')) return
      const controls = runKeyboardControlsRef.current

      if (event.code === 'Space' || event.key === ' ') {
        event.preventDefault()
        if (event.repeat) return
        if (controls.runStatus) {
          if (controls.isRunPaused) controls.resumeRun()
          else controls.pauseRun()
        } else if (controls.isRehearsalRunning) {
          if (controls.rehearsalStatus === 'paused') controls.resumeRehearsal()
          else controls.pauseRehearsal()
        }
      } else if (event.key === 'ArrowRight') {
        event.preventDefault()
        if (controls.runStatus) controls.skipRunPrompt()
        else if (controls.isRehearsalRunning) controls.skipRehearsalCurrent()
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault()
        if (controls.runStatus) controls.previousRunPrompt()
        else if (controls.isRehearsalRunning) controls.previousRehearsalPrompt()
      }
    }

    window.addEventListener('keydown', handleRunKeyboardControls)
    return () => window.removeEventListener('keydown', handleRunKeyboardControls)
  }, [hasRunPlayback, isRehearsalRunning])

  return (
    <main className={[
      'app-shell',
      isTeleprompterFullscreen && 'has-teleprompter-fullscreen',
      isLightMode && 'theme-light',
    ].filter(Boolean).join(' ')}>
      <header className="topbar">
        <div className="brand-group">
          <button className="brand" type="button" onClick={() => { stopRun(); stopRehearsal(); setPdfRunMode(false); setSelectedFolderId(null) }} aria-label="Prompt Library home">
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
              <button className="back-button" type="button" onClick={() => { stopRun(); stopRehearsal(); setPdfRunMode(false); setSelectedFolderId(null) }}><span aria-hidden="true">{'\u2190'}</span> All folders</button>
              <span className="toolbar-divider" />
              <span className="breadcrumb-current">{selectedFolder.name}</span>
              <div className="folder-toolbar-actions"><button className="quiet-button import-script-button" type="button" onClick={() => setIsImportingScript(true)}>Import Script</button><button className="primary-button add-prompt-button" type="button" onClick={() => setPromptDialog({})}><span aria-hidden="true">+</span> Add prompt</button></div>
            </div>

            <div className="page-heading folder-heading">
              <div>
                <p className="eyebrow">FOLDER <span>///</span> {folderPrompts.length.toString().padStart(2, '0')} PROMPTS</p>
                <h1>{selectedFolder.name}</h1>
              </div>
            </div>

            <div className={`run-panel${runStatus ? ' is-running' : ''}${isRunPrompterFullscreen && runStatus ? ' is-fullscreen' : ''}`} ref={runPrompterRef}>
              <div className="run-panel-header">
                <div className="run-copy">
                  <p className="eyebrow">SEQUENCE PLAYBACK</p>
                  <p>{runModeDescription}</p>
                </div>
                {!runStatus && <div className="run-speaker-settings" role="group" aria-label="Include prompts from">
                  <label className="speaker-toggle">
                    <span>Reader</span>
                    <input type="checkbox" checked={runSpeakers.Reader} disabled={hasRunPlayback} onChange={() => toggleRunSpeaker('Reader')} aria-label="Include Reader prompts" />
                    <span className="switch-track" aria-hidden="true" />
                  </label>
                  <label className="speaker-toggle">
                    <span>Myself</span>
                    <input type="checkbox" checked={runSpeakers.Myself} disabled={hasRunPlayback} onChange={() => toggleRunSpeaker('Myself')} aria-label="Include Myself prompts" />
                    <span className="switch-track" aria-hidden="true" />
                  </label>
                </div>}
                <div className="run-controls">
                  {runStatus && <>
                    <button className="rehearsal-control run-icon-control run-fullscreen-control" type="button" onClick={toggleRunPrompterFullscreen} aria-label={isRunPrompterFullscreen ? 'Exit full screen' : 'Enter full screen'} title={isRunPrompterFullscreen ? 'Exit full screen' : 'Enter full screen'}>
                      <RunControlIcon name={isRunPrompterFullscreen ? 'exit-fullscreen' : 'fullscreen'} />
                    </button>
                    <button className="rehearsal-control run-icon-control" type="button" onClick={previousRunPrompt} disabled={runStatus.index <= 1} aria-label="Previous prompt" title="Go to previous prompt (←)">
                      <RunControlIcon name="previous" />
                    </button>
                    <button className="rehearsal-control run-icon-control run-pause-control" type="button" onClick={runHasEnded ? restartRun : isRunPaused ? resumeRun : pauseRun} aria-label={runHasEnded ? 'Run again' : isRunPaused ? 'Resume playback' : 'Pause playback'} title={runHasEnded ? 'Run again' : `${isRunPaused ? 'Resume playback' : 'Pause playback'} (Space)`}>
                      <RunControlIcon name={runHasEnded || isRunPaused ? 'play' : 'pause'} />
                    </button>
                    <button className="rehearsal-control run-icon-control" type="button" onClick={skipRunPrompt} disabled={runHasEnded} aria-label="Skip prompt" title="Skip to next prompt (→)">
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
                    <p className="eyebrow">{runHasEnded ? 'RUN COMPLETE' : 'RUN PROMPTER'}</p>
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
              className={`rehearsal-panel${hasRehearsalSession ? ' is-running' : ''}${pdfRunMode ? ' is-pdf-run' : ''}${isTeleprompterFullscreen && hasRehearsalSession ? ' is-fullscreen' : ''}`}
              aria-label="Run With Me rehearsal"
              ref={rehearsalPanelRef}
            >
              <div className="rehearsal-heading">
                <div>
                  <p className="eyebrow">{pdfRunMode ? 'PDF RUN WITH ME' : 'INTERACTIVE REHEARSAL'}</p>
                  <p>{pdfRunMode ? 'Rehearse with the original sides and follow the active dialogue.' : 'Hear Reader recordings, then speak each Myself line.'}</p>
                </div>
                {!hasRehearsalSession && (
                  <div className="rehearsal-controls">
                    <button className="run-with-me-button" type="button" onClick={startClassicRehearsal} disabled={folderPrompts.length === 0}>
                      <span aria-hidden="true">{'\u25B6'}</span> Run With Me
                    </button>
                    <button className="quiet-button pdf-mode-button" type="button" onClick={() => setPdfRunMode(true)}>PDF Run With Me</button>
                  </div>
                )}
                {hasRehearsalSession && (
                  <div className="rehearsal-controls">
                    <button className="rehearsal-control run-icon-control rehearsal-fullscreen-control" type="button" onClick={toggleTeleprompterFullscreen} aria-label={isTeleprompterFullscreen ? 'Exit full screen' : 'Enter full screen'} title={isTeleprompterFullscreen ? 'Exit full screen' : 'Enter full screen'}>
                      <RunControlIcon name={isTeleprompterFullscreen ? 'exit-fullscreen' : 'fullscreen'} />
                    </button>
                    <button className="rehearsal-control run-icon-control" type="button" onClick={previousRehearsalPrompt} disabled={(!isRehearsalRunning && !rehearsalIsComplete) || (rehearsalSessionRef.current?.index ?? 0) <= 0} aria-label="Previous prompt" title="Go to previous prompt (←)"><RunControlIcon name="previous" /></button>
                    <button className="rehearsal-control run-icon-control rehearsal-pause-control" type="button" onClick={rehearsalIsComplete ? () => startRehearsal() : rehearsalView.status === 'paused' ? resumeRehearsal : pauseRehearsal} disabled={!isRehearsalRunning && !rehearsalIsComplete} aria-label={rehearsalIsComplete ? 'Run again' : rehearsalView.status === 'paused' ? 'Resume rehearsal' : 'Pause rehearsal'} title={rehearsalIsComplete ? 'Run again' : `${rehearsalView.status === 'paused' ? 'Resume rehearsal' : 'Pause rehearsal'} (Space)`}>
                      <RunControlIcon name={rehearsalIsComplete || rehearsalView.status === 'paused' ? 'play' : 'pause'} />
                    </button>
                    <button className="rehearsal-control run-icon-control" type="button" onClick={skipRehearsalCurrent} disabled={!isRehearsalRunning} aria-label="Skip prompt" title="Skip to next prompt (→)"><RunControlIcon name="skip" /></button>
                    <button className="rehearsal-control run-icon-control rehearsal-restart-control" type="button" onClick={() => startRehearsal()} disabled={folderPrompts.length === 0} aria-label="Restart rehearsal" title="Restart rehearsal"><RunControlIcon name="restart" /></button>
                    <button className="rehearsal-control run-icon-control rehearsal-action-control" type="button" onClick={stopRehearsal} aria-label="Stop rehearsal and return to Run With Me" title="Stop rehearsal"><RunControlIcon name="stop" /></button>
                  </div>
                )}
              </div>
              {pdfRunMode ? (
                <PdfFollowViewer
                  file={selectedPdfScript?.blob ?? null}
                  fileId={selectedPdfScript?.id ?? selectedPdfScript?.pdfId ?? null}
                  fileName={selectedPdfScript?.name ?? null}
                  pdfLibrary={pdfLibrary}
                  characterNames={selectedFolder?.characters ?? []}
                  sessionId={rehearsalView?.sessionId ?? null}
                  syncResetKey={pdfSyncResetKey}
                  activePrompt={activeRehearsalPrompt}
                  rehearsalIndex={rehearsalView?.index ?? 0}
                  rehearsalStatus={rehearsalStatusLabel}
                  rehearsalSpeaker={rehearsalView?.speaker}
                  remainingSeconds={rehearsalView?.remainingSeconds}
                  rehearsalActive={hasRehearsalSession}
                  onRun={startPdfRehearsal}
                  onPdfSelected={savePdfSides}
                  onSelectPdf={selectPdfForFolder}
                  onBack={() => setPdfRunMode(false)}
                />
              ) : hasRehearsalSession && (
                <div className={`rehearsal-session${rehearsalView.speaker === 'Myself' && !isTeleprompterFullscreen ? ' has-user-transcript' : ''}`} aria-live="polite">
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
                  {nextRehearsalPrompt && (
                    <aside className="rehearsal-up-next" aria-label="Next prompt preview">
                      <div className="rehearsal-up-next-heading">
                        <span className="rehearsal-up-next-label"><i aria-hidden="true" />UP NEXT</span>
                        <span className="rehearsal-up-next-title">{formatPromptLabel(nextRehearsalPrompt, rehearsalView.index + 2)}</span>
                      </div>
                      <div className="rehearsal-up-next-content">
                        <p>{nextRehearsalPrompt.type === 'silence' ? `(SILENCE · ${silenceDurationSeconds(nextRehearsalPrompt)}s)` : nextRehearsalPrompt.transcript || 'No transcript available.'}</p>
                      </div>
                    </aside>
                  )}
                  {rehearsalView.speaker === 'Reader' && ['speaking', 'paused', 'completed'].includes(rehearsalView.status) && rehearsalView.remainingSeconds !== null && (
                    <span className="rehearsal-prompt-timer rehearsal-countdown" aria-live="off">RECORDING TIME&nbsp; {formatTime(rehearsalView.remainingSeconds)}</span>
                  )}
                  {rehearsalView.speaker === 'Silence' && ['silence', 'paused', 'completed'].includes(rehearsalView.status) && (
                    <span className="silence-countdown rehearsal-countdown" aria-live="off">{formatTime(rehearsalView.remainingSeconds ?? 0)}</span>
                  )}
                  {rehearsalView.speaker === 'Myself' && rehearsalView.triggerProgress && !isTeleprompterFullscreen && <p className="rehearsal-trigger-progress">{rehearsalView.triggerProgress}</p>}
                  {rehearsalView.speaker === 'Myself' && !isTeleprompterFullscreen && (
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

            {runError && <div className="run-error" role="status"><p>{runError}</p>{runValidationPromptIds.map((id) => {
              const missingPrompt = folderPrompts.find((prompt) => prompt.id === id)
              if (!missingPrompt) return null
              const promptNumber = folderPrompts.findIndex((prompt) => prompt.id === id) + 1
              return <button className="missing-prompt-edit" key={id} type="button" onClick={() => editPrompt(missingPrompt)}>Edit {formatPromptLabel(missingPrompt, promptNumber)}</button>
            })}</div>}

            {folderPrompts.length === 0 ? (
              <div className="empty-state">
                <span className="empty-symbol" aria-hidden="true">{'\u25C9'}</span>
                <h2>No prompts yet</h2>
                <p>Add a transcript, import a script, or record a line. Recording is optional.</p>
                <button className="primary-button" type="button" onClick={() => setPromptDialog({})}>Add a prompt <span aria-hidden="true">{'\u2192'}</span></button>
              </div>
            ) : (
              <div className="prompt-list" aria-label="Prompts in chronological order">
                {canReorderPrompts && (
                  <p className="prompt-reorder-hint"><span aria-hidden="true">↕</span> Drag the grip to reorder prompts</p>
                )}
                {folderPrompts.map((prompt, index) => (
                  <article
                    className={[
                      'prompt-row',
                      prompt.type === 'silence' && 'prompt-row-silence',
                      prompt.type !== 'silence' && !isUsableRecording(prompt.audio) && 'prompt-row-no-audio',
                      draggedPromptId === prompt.id && 'is-drag-source',
                      dragOverPromptId === prompt.id && draggedPromptId !== prompt.id && 'is-drag-over',
                      dragOverPromptId === prompt.id && draggedPromptId !== prompt.id && `is-drop-${dragDropPosition}`,
                      !canReorderPrompts && 'is-reorder-disabled',
                    ].filter(Boolean).join(' ')}
                    key={prompt.id}
                    data-prompt-id={prompt.id}
                    onPointerDown={(event) => startPromptDrag(event, prompt.id)}
                    onPointerMove={movePromptDrag}
                    onPointerUp={finishPromptDrag}
                    onPointerCancel={cancelPromptDrag}
                    onLostPointerCapture={cancelPromptDrag}
                  >
                    <span
                      className="prompt-drag-handle"
                      data-prompt-drag-handle
                      role="img"
                      aria-label={canReorderPrompts ? 'Drag to reorder prompt' : 'Reordering unavailable during a run'}
                      title={canReorderPrompts ? 'Drag to reorder' : 'Reordering unavailable during a run'}
                    >
                      <span aria-hidden="true">{'\u22EE\u22EE'}</span>
                    </span>
                    <div className="prompt-info">
                      <h3>{formatPromptLabel(prompt, index + 1)}</h3>
                      {prompt.type === 'silence' ? (
                        <p className="prompt-transcript">Silent pause in the sequence.</p>
                      ) : (
                        <>
                          {prompt.character && <p className="prompt-character">{prompt.character}</p>}
                          <p className="prompt-transcript">{prompt.transcript || 'No transcript available.'}</p>
                          {!isUsableRecording(prompt.audio) && <span className="missing-recording-status prompt-missing-recording">Recording needed for Run</span>}
                          <p className="prompt-date">{isUsableRecording(prompt.audio) ? 'RECORDED' : 'ADDED'} {new Date(prompt.createdAt).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).toUpperCase()}</p>
                        </>
                      )}
                    </div>
                    {prompt.type === 'silence' ? (
                      <div className="silence-duration-control" aria-label={`Silence duration, ${silenceDurationSeconds(prompt)} seconds`}>
                        <button type="button" aria-label="Decrease silence duration" disabled={!canReorderPrompts || silenceDurationSeconds(prompt) <= 1} onClick={() => adjustSilenceDuration(prompt, -1)}>-</button>
                        <span>{silenceDurationSeconds(prompt)}s</span>
                        <button type="button" aria-label="Increase silence duration" disabled={!canReorderPrompts || silenceDurationSeconds(prompt) >= 600} onClick={() => adjustSilenceDuration(prompt, 1)}>+</button>
                      </div>
                    ) : isUsableRecording(prompt.audio) ? <AudioPlayer audio={getPromptPlaybackAudio(prompt)} trimSilence={prompt.trimSilence} speaker={prompt.speaker} pitch={readerPitch} promptId={prompt.id} /> : <span className="prompt-audio-missing"><span aria-hidden="true">{'\u266A'}</span> Audio not added</span>}
                    <div className="prompt-actions">
                      {prompt.type !== 'silence' && <button className="text-action prompt-edit-action" type="button" onClick={() => editPrompt(prompt)}><svg className="prompt-action-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="m3 11.8-.7 2.9 2.9-.7L14 5.2 10.8 2 3 9.8v2Z" /><path d="m9.8 3 3.2 3.2" /></svg>Edit</button>}
                      <button className="text-action prompt-delete-action" type="button" onClick={() => deletePrompt(prompt)}><svg className="prompt-action-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 4.5h9M6 4.5V3h4v1.5m1.5 0-.5 9h-6l-.5-9M6.5 7v4m3-4v4" /></svg>Delete</button>
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
                      <button className="folder-open" type="button" onClick={() => openFolder(folder.id)}>
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
            {!isLoading && <section className="pdf-library-section" aria-label="PDF library">
              <div className="pdf-library-heading">
                <div>
                  <p className="eyebrow">SCRIPT ARCHIVE <span>///</span> {pdfLibrary.length.toString().padStart(2, '0')} PDFS</p>
                  <h2>Your PDFs</h2>
                  <p>Saved once on this device and available in every folder · {formatFileSize(pdfLibrary.reduce((total, pdf) => total + (pdf.size ?? pdf.blob?.size ?? 0), 0))} total</p>
                </div>
                <label className="primary-button pdf-library-upload">+ Add PDF<input type="file" accept="application/pdf,.pdf" onChange={uploadPdfToLibrary} /></label>
              </div>
              {pdfLibrary.length === 0 ? <p className="pdf-library-empty">Add audition sides once, then choose them for PDF rehearsal or script import.</p> : (
                <div className="pdf-library-list">
                  {pdfLibrary.map((pdf) => {
                    const linkedFolders = pdfScripts.filter((link) => link.pdfId === pdf.id).length
                    return <article className="pdf-library-item" key={pdf.id}>
                      <span className="pdf-library-mark" aria-hidden="true">PDF</span>
                      <div className="pdf-library-info"><strong>{pdf.name}</strong><span>{formatFileSize(pdf.size ?? pdf.blob?.size)} · {linkedFolders} {linkedFolders === 1 ? 'folder' : 'folders'}</span></div>
                      <button className="text-action delete-action" type="button" onClick={() => removePdfFromLibrary(pdf)}>Remove</button>
                    </article>
                  })}
                </div>
              )}
            </section>}
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
                  <div className="reader-pitch-value">
                    <output htmlFor="reader-pitch">{`${12 * Math.log2(readerPitchDraft) > 0 ? '+' : ''}${(12 * Math.log2(readerPitchDraft)).toFixed(1)} st`}</output>
                    <button className="reader-pitch-apply" type="button" onClick={applyReaderPitch} disabled={readerPitchDraft === readerPitch}>Apply</button>
                  </div>
                </div>
                <input
                  id="reader-pitch"
                  type="range"
                  min="0.85"
                  max="1.15"
                  step="0.01"
                  value={readerPitchDraft}
                  onChange={(event) => setReaderPitchDraft(Number(event.target.value))}
                  aria-label="Reader voice pitch"
                />
                <div className="pitch-range-labels"><span>LOW</span><span>HIGH</span></div>
                <p className="reader-pitch-hint">{readerPitchDraft === readerPitch ? 'Applied to Reader playback.' : 'Apply to update all Reader playback.'}</p>
              </section>
            </aside>
          )}
        </>
      )}

      <footer className="app-footer"><span>PROMPT LIBRARY</span><span>VOICE NOTES / {new Date().getFullYear()}</span></footer>

      {isImportingScript && selectedFolder && <ScriptImportDialog folderName={selectedFolder.name} pdfLibrary={pdfLibrary} onClose={() => setIsImportingScript(false)} onImport={importScriptPrompts} />}
      {folderDialog && <FolderDialog folder={folderDialog.folder} onClose={() => setFolderDialog(null)} onSave={saveFolder} />}
      {promptDialog && selectedFolder && <PromptDialog folderName={selectedFolder.name} characters={selectedFolder.characters ?? []} prompt={promptDialog.prompt} readerPitch={readerPitch} readerPitchApplyVersion={readerPitchApplyVersion} onClose={() => setPromptDialog(null)} onSave={savePrompt} onGenerateRecording={generateRecordingForPrompt} />}
    </main>
  )
}

export default App

