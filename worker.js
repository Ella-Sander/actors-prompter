const MODEL_ORIGIN = 'https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/'

const ALLOWED_MODEL_FILES = new Set([
  'config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'special_tokens_map.json',
  'generation_config.json',
  'onnx/model_quantized.onnx',
  'onnx/model_q8f16.onnx',
  'voices/af_bella.bin',
])

async function proxyKokoroAsset(request, pathname) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } })
  }

  let assetPath
  try {
    assetPath = decodeURIComponent(pathname.slice('/api/kokoro/'.length))
  } catch {
    return new Response('Invalid model asset path', { status: 400 })
  }
  if (!ALLOWED_MODEL_FILES.has(assetPath)) return new Response('Model asset not allowed', { status: 404 })

  const upstreamUrl = new URL(assetPath, MODEL_ORIGIN)
  upstreamUrl.search = new URL(request.url).search
  const headers = new Headers()
  const range = request.headers.get('Range')
  const ifNoneMatch = request.headers.get('If-None-Match')
  if (range) headers.set('Range', range)
  if (ifNoneMatch) headers.set('If-None-Match', ifNoneMatch)

  try {
    const upstream = await fetch(upstreamUrl, { method: request.method, headers, redirect: 'follow' })
    const responseHeaders = new Headers(upstream.headers)
    responseHeaders.set('Cache-Control', 'public, max-age=3600, s-maxage=86400')
    responseHeaders.set('X-Content-Type-Options', 'nosniff')
    return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: responseHeaders })
  } catch {
    return new Response('Could not fetch the Kokoro model asset from Hugging Face.', {
      status: 502,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
    })
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    if (url.pathname.startsWith('/api/kokoro/')) return proxyKokoroAsset(request, url.pathname)
    return env.ASSETS.fetch(request)
  },
}
