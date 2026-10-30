import { defineConfig } from '@playwright/test'
import { resolve } from 'node:path'

const python = resolve('..', '.venv', process.platform === 'win32' ? 'Scripts' : 'bin', process.platform === 'win32' ? 'python.exe' : 'python')
const port = Number(process.env.E2E_PORT || '7889')
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('E2E_PORT must be a valid port')
const localOrigin = `http://127.0.0.1:${port}`
export default defineConfig({
  testDir: './e2e',
  // The static demo has its own server and config (playwright.demo.config.ts, `npm run e2e:demo`).
  testIgnore: /demo\.spec\.ts$/,
  workers: 1,
  timeout: 60_000,
  use: {
    baseURL: process.env.E2E_BASE_URL || localOrigin,
    channel: process.env.PLAYWRIGHT_CHANNEL,
    colorScheme: 'light',
    locale: 'en-GB',
    trace: 'retain-on-failure',
  },
  webServer: process.env.E2E_BASE_URL ? undefined : {
    command: `"${python}" "${resolve('..', 'scripts', 'smoke_server.py')}" --port ${port}${process.env.E2E_GOOGLE === 'true' ? ' --fake-google' : ''}`,
    url: `${localOrigin}/health`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
})
