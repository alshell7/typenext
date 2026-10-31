import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

const host = process.env.TAURI_DEV_HOST

// https://vitejs.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],
  worker: { format: 'es' },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    chunkSizeWarningLimit: 600,
  },
  optimizeDeps: {
    include: ['pdfjs-dist/legacy/build/pdf.mjs', 'mammoth'],
  },
  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    // The Cloudflare API refuses browser requests from other origins. The
    // desktop app calls it from Rust; in development the browser build goes
    // through this proxy (cloud sync with D1).
    proxy: {
      '/__cloudflare': {
        target: 'https://api.cloudflare.com',
        changeOrigin: true,
        rewrite: path => path.replace(/^\/__cloudflare/, ''),
      },
    },
    hmr: host
      ? {
          protocol: 'ws',
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell vite to ignore watching `src-tauri`
      ignored: [
        '**/src-tauri/**',
        '**/artifacts/**',
        '**/test-results*/**',
        '**/playwright-report/**',
        '**/site/**',
        '**/site-dist/**',
        '**/docs/screenshots/**',
      ],
    },
  },
}))
