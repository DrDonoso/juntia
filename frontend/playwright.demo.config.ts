import { defineConfig } from '@playwright/test'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

// Smoke test of the public demo (`npm run build:demo`, then `npm run e2e:demo`): `vite preview`
// serves the static bundle in dist-demo, the files Cloudflare serves, with the demo's security
// headers. No backend and no database: the API is the MSW service worker, which browsers allow on
// 127.0.0.1 without HTTPS. Set DEMO_E2E_BASE_URL to check a deployed demo instead.
const port = Number(process.env.DEMO_E2E_PORT || '4183')
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('DEMO_E2E_PORT must be a valid port')
const localOrigin = `http://127.0.0.1:${port}`
if (!process.env.DEMO_E2E_BASE_URL && !existsSync(resolve('dist-demo', 'index.html'))) {
  throw new Error('Build the demo first: npm run build:demo')
}

export default defineConfig({
  testDir: './e2e',
  testMatch: /demo\.spec\.ts$/,
  outputDir: './test-results/demo',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  use: {
    baseURL: process.env.DEMO_E2E_BASE_URL || localOrigin,
    channel: process.env.PLAYWRIGHT_CHANNEL,
    colorScheme: 'light',
    locale: 'en-GB',
    timezoneId: 'Europe/London',
    serviceWorkers: 'allow',
    trace: 'retain-on-failure',
  },
  webServer: process.env.DEMO_E2E_BASE_URL ? undefined : {
    command: `npm run preview:demo -- --port ${port} --strictPort`,
    url: localOrigin,
    reuseExistingServer: false,
    timeout: 60_000,
  },
})
