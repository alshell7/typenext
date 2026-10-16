import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

// GitHub Pages serves the project site at https://alshell7.github.io/typenext/
export default defineConfig({
  base: '/typenext/',
  plugins: [react()],
  build: {
    outDir: fileURLToPath(new URL('../site-dist', import.meta.url)),
    emptyOutDir: true,
    // Hashed scripts and styles; public/assets holds the screenshots.
    assetsDir: 'static',
    target: 'es2022',
    cssCodeSplit: true,
    assetsInlineLimit: 2048,
    reportCompressedSize: true,
  },
  server: { port: 4321, strictPort: false },
  preview: { port: 4322, strictPort: false },
})
