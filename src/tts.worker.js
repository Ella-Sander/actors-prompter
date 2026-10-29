import { KokoroTTS, env as kokoroEnv } from 'kokoro-js'
import { env as transformersEnv } from '../node_modules/kokoro-js/node_modules/@huggingface/transformers/dist/transformers.web.js'
import ortWasmModuleUrl from '../node_modules/kokoro-js/node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.mjs?url'
import ortWasmBinaryUrl from '../node_modules/kokoro-js/node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.wasm?url'

let synthesizerPromise
let tracedFetchInstalled = false

function trace(event, details = {}) {
  self.postMessage({ type: 'trace', event, details })
}

function progress(requestId, phase, details = {}) {
  self.postMessage({ type: 'progress', requestId, progress: { phase, ...details } })
}

function errorDetails(error) {
  return {
    name: error instanceof Error ? error.name : 'Error',
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  }
}

function runtimeCapabilities() {
  const simdProbe = new Uint8Array([
    0, 97, 115, 109, 1, 0, 0, 0,
    1, 5, 1, 96, 0, 1, 123,
    3, 2, 1, 0,
    10, 22, 1, 20, 0, 253, 12,
    ...new Array(16).fill(0), 11,
  ])
  let sharedMemory = false
  try {
    sharedMemory = typeof SharedArrayBuffer !== 'undefined'
      && new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true }) instanceof WebAssembly.Memory
  } catch {
    sharedMemory = false
  }
  return {
    secureContext: self.isSecureContext,
    crossOriginIsolated: self.crossOriginIsolated,
    sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
    sharedMemory,
    wasm: typeof WebAssembly !== 'undefined',
    wasmSimd: typeof WebAssembly !== 'undefined' && WebAssembly.validate(simdProbe),
  }
}

function routeModelRequest(input) {
  try {
    const sourceUrl = typeof input === 'string' || input instanceof URL
      ? new URL(input, self.location.href)
      : new URL(input.url)
    const prefix = '/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/'
    if (sourceUrl.origin !== 'https://huggingface.co' || !sourceUrl.pathname.startsWith(prefix)) return input
    const assetPath = sourceUrl.pathname.slice(prefix.length)
    const proxyUrl = new URL(`/api/kokoro/${assetPath}`, self.location.origin)
    proxyUrl.search = sourceUrl.search
    return typeof Request !== 'undefined' && input instanceof Request
      ? new Request(proxyUrl, input)
      : proxyUrl.href
  } catch {
    return input
  }
}

function installFetchTrace() {
  if (tracedFetchInstalled) return
  tracedFetchInstalled = true
  const originalFetch = self.fetch.bind(self)
  self.fetch = async (input, init) => {
    const routedInput = routeModelRequest(input)
    const urlOf = (value) => {
      try {
        const url = new URL(typeof value === 'string' || value instanceof URL ? value : value.url, self.location.href)
        return `${url.origin}${url.pathname}`
      } catch {
        return 'unknown URL'
      }
    }
    const target = urlOf(routedInput)
    const upstreamTarget = urlOf(input)
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET')
    trace('fetch-start', { method, target, ...(target !== upstreamTarget ? { upstreamTarget } : {}) })
    try {
      const response = await originalFetch(routedInput, init)
      trace('fetch-response', {
        method,
        target,
        status: response.status,
        ok: response.ok,
        contentType: response.headers.get('content-type'),
        contentLength: response.headers.get('content-length'),
        finalTarget: urlOf(response.url || target),
      })
      return response
    } catch (error) {
      trace('fetch-failed', { method, target, error: errorDetails(error).message })
      throw error
    }
  }
}

function ensureReadableStreamAsyncIterator() {
  const prototype = globalThis.ReadableStream?.prototype
  if (!prototype || Symbol.asyncIterator in prototype) return
  Object.defineProperty(prototype, Symbol.asyncIterator, {
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

async function getSynthesizer(requestId) {
  if (synthesizerPromise) {
    trace('model-load-cached')
    return synthesizerPromise
  }

  const capabilities = runtimeCapabilities()
  trace('runtime-capabilities', capabilities)
  if (!capabilities.secureContext) throw new Error('Default voice generation requires a trusted HTTPS page.')
  if (!capabilities.wasm) throw new Error('This browser does not support WebAssembly, which the default voice requires.')
  if (!capabilities.wasmSimd) throw new Error('This browser does not support the SIMD WebAssembly runtime bundled with the default voice.')
  if (!capabilities.sharedMemory) {
    throw new Error('The page is not cross-origin isolated, so the threaded WebAssembly voice runtime cannot start. Enable COOP and COEP headers and reload.')
  }

  trace('module-import-ready')
  installFetchTrace()
  ensureReadableStreamAsyncIterator()
  kokoroEnv.wasmPaths = { mjs: ortWasmModuleUrl, wasm: ortWasmBinaryUrl }
  // The complete TTS pipeline is already in this dedicated worker. Keep ONNX
  // proxying off to avoid an unnecessary nested worker and cap compute threads
  // so generation leaves CPU available for the visible app and user input.
  transformersEnv.backends.onnx.wasm.proxy = false
  transformersEnv.backends.onnx.wasm.numThreads = Math.max(1, Math.min(2, (navigator.hardwareConcurrency || 2) - 1))
  trace('runtime-assets-configured', { module: ortWasmModuleUrl, wasm: ortWasmBinaryUrl, worker: true, proxy: false, numThreads: transformersEnv.backends.onnx.wasm.numThreads })
  trace('model-load-start', { model: 'onnx-community/Kokoro-82M-v1.0-ONNX', dtype: 'q8', device: 'wasm', runtime: capabilities })
  progress(requestId, 'loading')

  let lastProgressUpdate = 0
  const modelPromise = KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', {
    dtype: 'q8',
    device: 'wasm',
    progress_callback: (item) => {
      const details = { file: item.file, progress: item.progress, loaded: item.loaded, total: item.total }
      const now = performance.now()
      const isProgressTick = item.status === 'progress'
      if (isProgressTick && item.progress < 100 && now - lastProgressUpdate < 300) return
      lastProgressUpdate = now
      trace(`model-${item.status}`, details)
      progress(requestId, 'loading', details)
    },
  })
  const retryablePromise = modelPromise.catch((error) => {
    trace('model-load-failed', errorDetails(error))
    if (synthesizerPromise === retryablePromise) synthesizerPromise = undefined
    throw error
  })
  synthesizerPromise = retryablePromise
  return synthesizerPromise
}

async function generate(requestId, text) {
  try {
    trace('generation-start', { requestId, transcriptLength: text.length, worker: true })
    progress(requestId, 'loading')
    const synthesizer = await getSynthesizer(requestId)
    trace('model-ready', { requestId })
    trace('synthesis-start', { requestId })
    progress(requestId, 'synthesizing')
    const audio = await synthesizer.generate(text, { voice: 'af_bella' })
    const blob = audio.toBlob()
    trace('synthesis-ready', { requestId, audioBytes: blob.size, audioType: blob.type })
    progress(requestId, 'generated')
    self.postMessage({ type: 'result', requestId, audio: blob })
  } catch (error) {
    trace('generation-failed', { requestId, ...errorDetails(error) })
    self.postMessage({ type: 'error', requestId, error: errorDetails(error) })
  }
}

self.addEventListener('message', (event) => {
  const { type, requestId, text } = event.data ?? {}
  if (type === 'generate' && typeof requestId === 'number' && typeof text === 'string') {
    void generate(requestId, text)
  }
})
