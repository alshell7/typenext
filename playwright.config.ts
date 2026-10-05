import { defineConfig, devices } from '@playwright/test'
import { existsSync } from 'node:fs'

const systemBrowser = process.env.PLAYWRIGHT_EXECUTABLE_PATH ??
  (process.platform === 'win32' && existsSync('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe')
    ? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe' : undefined)

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  timeout: 30_000,
  expect: { timeout: 7_000 },
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: { baseURL: 'http://127.0.0.1:1420', trace: 'retain-on-failure', screenshot: 'only-on-failure',
    launchOptions: systemBrowser ? { executablePath: systemBrowser } : {} },
  projects: [{ name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1360, height: 900 } } }],
  webServer: { command: 'npm run dev -- --host 127.0.0.1', url: 'http://127.0.0.1:1420', reuseExistingServer: !process.env.CI },
})
