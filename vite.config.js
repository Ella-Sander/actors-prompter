import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const crossOriginIsolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
}

// https://vite.dev/config/
export default defineConfig({
  build: {
    target: ['es2020', 'safari14'],
  },
  plugins: [react()],
  // Kokoro's threaded ONNX WebAssembly runtime requires cross-origin isolation.
  // The deployed site gets these from public/_headers; Vite must set them locally.
  server: {
    headers: crossOriginIsolationHeaders,
  },
  preview: {
    headers: crossOriginIsolationHeaders,
  },
})
