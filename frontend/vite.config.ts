import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'

/**
 * Security headers of the static demo: the ones src/juntia/middleware.py sends (keep them in
 * step), plus `worker-src 'self'` for the MSW service worker that answers the demo's API.
 */
const DEMO_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "worker-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ')

const DEMO_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'Content-Security-Policy': DEMO_CSP,
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
}

/** The backend serves /manifest.webmanifest (src/juntia/app.py); the static demo ships this one. */
const DEMO_MANIFEST = JSON.stringify({
  id: '/',
  name: 'Juntia demo',
  short_name: 'Juntia demo',
  description: 'Juntia demo: a residents\' community portal with synthetic data.',
  lang: 'en',
  dir: 'ltr',
  start_url: '/',
  scope: '/',
  display: 'standalone',
  background_color: '#f4f6f9',
  theme_color: '#123a6b',
  icons: [
    { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
  ],
}, null, 2)

/**
 * Static host files of `dist-demo/`, emitted here rather than kept in public/ (which also feeds the
 * production bundle): Cloudflare's `_headers` and the web manifest; the dev server answers the
 * manifest too. The SPA fallback is `not_found_handling` in wrangler.jsonc.
 */
function demoSite(): Plugin {
  const headers = [
    // The worker IS the demo's API: never serve a stale copy.
    '/mockServiceWorker.js',
    '  Cache-Control: no-cache',
    '',
    // Content-hashed by Vite.
    '/assets/*',
    '  Cache-Control: public, max-age=31536000, immutable',
    '',
    '/*',
    ...Object.entries(DEMO_SECURITY_HEADERS).map(([name, value]) => `  ${name}: ${value}`),
    '  Strict-Transport-Security: max-age=31536000',
    '',
  ].join('\n')
  return {
    name: 'juntia:demo-site',
    configureServer(server) {
      server.middlewares.use('/manifest.webmanifest', (_request, response) => {
        response.setHeader('Content-Type', 'application/manifest+json')
        response.end(DEMO_MANIFEST)
      })
    },
    transformIndexHtml(html) {
      // The demo's data is in English, and it says what it is.
      if (!/<title>[^<]*<\/title>/.test(html)) throw new Error('index.html has no <title> for the demo')
      return html.replace(/<title>[^<]*<\/title>/, '<title>Juntia demo</title>\n    <meta name="description" content="Juntia demo: shared finances, community actions, events, neighbors and contacts of a residents\' community, with synthetic data." />')
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: '_headers', source: headers })
      this.emitFile({ type: 'asset', fileName: 'manifest.webmanifest', source: DEMO_MANIFEST })
    },
  }
}

/** public/mockServiceWorker.js is copied into every build: only the demo may ship it. */
function withoutMockServiceWorker(): Plugin {
  return {
    name: 'juntia:without-mock-service-worker',
    apply: 'build',
    async writeBundle(options) {
      const worker = `${options.dir}/mockServiceWorker.js`
      if ((await this.fs.stat(worker).then(() => true, () => false))) await this.fs.unlink(worker)
    },
  }
}

export default defineConfig(({ mode }) => {
  // `--mode demo` (frontend/.env.demo): the static public demo, built into its own folder so it
  // never overwrites the production bundle that the backend serves.
  const demo = mode === 'demo'
  return {
    plugins: [react(), demo ? demoSite() : withoutMockServiceWorker()],
    // The demo's `/api/version` date (src/demo/handlers/core.ts); unused by normal builds.
    define: { __DEMO_BUILD_DATE__: JSON.stringify(new Date().toISOString().slice(0, 10)) },
    build: { outDir: demo ? 'dist-demo' : 'dist' },
    // The demo has no backend: nothing to proxy. `vite preview --mode demo` sends the demo's headers.
    server: demo ? {} : { proxy: { '/api': 'http://127.0.0.1:7778', '/manifest.webmanifest': 'http://127.0.0.1:7778' } },
    preview: demo ? { headers: { ...DEMO_SECURITY_HEADERS } } : {},
    test: { environment: 'jsdom', setupFiles: ['./src/test-setup.ts'], include: ['src/**/*.test.{ts,tsx}'] },
  }
})
