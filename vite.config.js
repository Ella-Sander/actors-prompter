import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'

const crossOriginIsolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
}

const allowedKokoroAssets = new Set([
  'config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'special_tokens_map.json',
  'generation_config.json',
  'onnx/model_quantized.onnx',
  'onnx/model_q8f16.onnx',
  'voices/af_bella.bin',
])

const kokoroDevelopmentProxy = {
  target: 'https://huggingface.co',
  changeOrigin: true,
  secure: true,
  followRedirects: true,
  bypass(request) {
    if (request.method !== 'GET' && request.method !== 'HEAD') return false
    try {
      const assetPath = decodeURIComponent(new URL(request.url, 'http://localhost').pathname.slice('/api/kokoro/'.length))
      return allowedKokoroAssets.has(assetPath) ? undefined : false
    } catch {
      return false
    }
  },
  rewrite(path) {
    return path.replace(
      /^\/api\/kokoro\//,
      '/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/',
    )
  },
}

function getLocalHttpsOptions() {
  if (process.env.ACTORS_PROMPTER_HTTPS !== '1') return undefined

  const certPath = resolve(process.env.ACTORS_PROMPTER_TLS_CERT || '.certs/dev-cert.pem')
  const keyPath = resolve(process.env.ACTORS_PROMPTER_TLS_KEY || '.certs/dev-key.pem')
  if (!existsSync(certPath) || !existsSync(keyPath)) {
    throw new Error(`HTTPS development was requested, but its certificate files were not found. Expected:\n  ${certPath}\n  ${keyPath}\nCreate them with mkcert as described in README.md.`)
  }
  return { cert: readFileSync(certPath), key: readFileSync(keyPath) }
}

const localHttpsOptions = getLocalHttpsOptions()

// https://vite.dev/config/
export default defineConfig({
  build: {
    target: ['es2020', 'safari14'],
  },
  plugins: [react()],
  // Kokoro's threaded ONNX WebAssembly runtime requires cross-origin isolation.
  // The deployed site gets these from public/_headers; Vite must set them locally.
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    https: localHttpsOptions,
    headers: crossOriginIsolationHeaders,
    proxy: {
      '/api/kokoro/': kokoroDevelopmentProxy,
    },
  },
  preview: {
    headers: crossOriginIsolationHeaders,
  },
})
