import { defineConfig } from '@playwright/test'
import { resolve } from 'node:path'

const python = resolve('..', '.venv', process.platform === 'win32' ? 'Scripts' : 'bin', process.platform === 'win32' ? 'python.exe' : 'python')
const port = Number(process.env.E2E_PORT || '7889')
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('E2E_PORT must be a valid port')
const localOrigin = `http://127.0.0.1:${port}`
// A second server without accounts, like a new installation, for the first-run screen (first-run.spec.ts).
process.env.E2E_FIRST_RUN_PORT ||= String(port + 1)
const firstRunPort = Number(process.env.E2E_FIRST_RUN_PORT)
if (!Number.isInteger(firstRunPort) || firstRunPort < 1 || firstRunPort > 65535 || firstRunPort === port) {
  throw new Error('E2E_FIRST_RUN_PORT must be a valid port other than E2E_PORT')
}
const smokeServer = `"${python}" "${resolve('..', 'scripts', 'smoke_server.py')}"`
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
  webServer: process.env.E2E_BASE_URL ? undefined : [{
    command: `${smokeServer} --port ${port}${process.env.E2E_GOOGLE === 'true' ? ' --fake-google' : ''}`,
    url: `${localOrigin}/health`,
    reuseExistingServer: false,
    timeout: 60_000,
  }, {
    command: `${smokeServer} --port ${firstRunPort} --first-run`,
    url: `http://127.0.0.1:${firstRunPort}/health`,
    reuseExistingServer: false,
    timeout: 60_000,
  }],
})
