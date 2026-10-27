import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'

const crossOriginIsolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
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
  },
  preview: {
    headers: crossOriginIsolationHeaders,
  },
})
