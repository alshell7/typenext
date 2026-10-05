import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/notebook/test-setup.ts'],
    include: ['src/notebook/**/*.test.{ts,tsx}', 'src/services/*.test.ts', 'src/components/notebook/*.test.{ts,tsx}'],
    exclude: [
      'node_modules',
      'dist',
      'src-tauri',
      '.git',
      '.cache',
      'build',
    ],
  },
  resolve: {
    alias: {
      '@': new URL('./src', import.meta.url).pathname,
    },
  },
})
