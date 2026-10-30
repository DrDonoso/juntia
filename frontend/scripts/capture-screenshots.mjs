/**
 * Captures the screenshots of README.md and docs/features.md (docs/screenshots/*.png) from the
 * static demo, with its synthetic data for the fictional community "Maple Court":
 *
 *   npm run build:demo
 *   npm run screenshots
 *
 * Environment variables:
 * - SCREENSHOT_BASE_URL: the demo to capture, http://127.0.0.1:4183 by default. When nothing answers
 *   on a local address, the script serves dist-demo there with `vite preview --mode demo` and stops
 *   it at the end. The demo's API is a service worker, so the address must be localhost, 127.0.0.1 or
 *   HTTPS.
 * - SCREENSHOT_OUT_DIR: where the PNGs go, docs/screenshots by default.
 * - SCREENSHOT_ONLY: comma-separated names to capture only some of them, e.g. `overview,mobile`.
 *
 * Every screenshot starts a fresh browser context, because each page load starts the demo over: it
 * leaves the welcome dialog as a neighbor or as the administrator, then navigates inside the app.
 * English, en-GB formats, Europe/Madrid, light theme; 1440×900 on desktop and 390×844 at 2× on the
 * phone. The demo's dates are relative to the day of the capture, and its clock is frozen at 17:30
 * (Madrid) that day, so the result doesn't depend on the time the script runs. The demo banner is
 * hidden: the docs say where the data comes from. Console errors, page errors and /api requests that
 * fail or that the demo doesn't answer make the script fail, and that screenshot isn't written.
 *
 * Optimize the PNGs afterwards (lossless), e.g. with Docker:
 *   docker run --rm -v "<repository>/docs/screenshots:/work" ghcr.io/shssoichiro/oxipng -o 4 --strip safe --recursive /work
 */
import { chromium } from '@playwright/test'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const frontend = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const baseUrl = new URL(process.env.SCREENSHOT_BASE_URL || 'http://127.0.0.1:4183')
const outDir = resolve(process.env.SCREENSHOT_OUT_DIR || resolve(frontend, '../docs/screenshots'))
const only = (process.env.SCREENSHOT_ONLY || '').split(',').map(name => name.trim()).filter(Boolean)

const TIME_ZONE = 'Europe/Madrid'
const DESKTOP = { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 }
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }

/** `YYYY-MM-DD` of an instant in Madrid. */
const madridDay = instant => new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(instant)

/** The instant of a wall-clock time in Madrid (`HH:MM`) on a calendar day. */
function madridInstant(day, time) {
  const offset = new Intl.DateTimeFormat('en-GB', { timeZone: TIME_ZONE, timeZoneName: 'longOffset' })
    .formatToParts(new Date(`${day}T12:00:00Z`)).find(part => part.type === 'timeZoneName').value.slice(3)
  return new Date(`${day}T${time}:00${offset || 'Z'}`)
}

const today = madridDay(new Date())
const clock = madridInstant(today, '17:30')
// The overview's last twelve months: from the first day of the month eleven months ago to today.
const [year, month] = today.split('-').map(Number)
const yearAgo = new Date(Date.UTC(year, month - 12, 1)).toISOString().slice(0, 10)

/** A minimal valid PDF: the demo reads any PDF as a synthetic statement. */
const STATEMENT_PDF = Buffer.from([
  '%PDF-1.4',
  '1 0 obj <</Type /Catalog /Pages 2 0 R>> endobj',
  '2 0 obj <</Type /Pages /Kids [3 0 R] /Count 1>> endobj',
  '3 0 obj <</Type /Page /Parent 2 0 R /MediaBox [0 0 595 842]>> endobj',
  'trailer <</Root 1 0 R>>',
  '%%EOF',
  '',
].join('\n'))

/**
 * Scrolls the page until the bottom of `above` (and its 4 px shadow) reaches the sticky top bar:
 * what follows it starts right below the bar, after the page's usual gap.
 */
async function scrollPast(above) {
  await above.evaluate(element => {
    const topBar = document.querySelector('.topbar').getBoundingClientRect().bottom
    window.scrollBy(0, element.getBoundingClientRect().bottom + 4 - topBar)
  })
}

/** In-app navigation, like a link: the demo keeps its data (a page load would start it over). */
async function go(page, path) {
  await page.evaluate(target => {
    history.pushState(null, '', target)
    dispatchEvent(new PopStateEvent('popstate'))
  }, path)
}

const heading = (page, name) => page.getByRole('heading', { level: 1, name, exact: true })
const dwelling = (page, label) => page.locator('section.neighbor-dwelling', { has: page.getByRole('heading', { name: label, exact: true }) })

/**
 * The screenshots, in the order of the README. `as` is how the welcome dialog is left; `capture`
 * brings the page to the state to show.
 */
const SHOTS = [
  {
    name: 'overview',
    as: 'neighbor',
    async capture(page) {
      await go(page, `/?start=${yearAgo}&end=${today}`)
      await heading(page, 'Community finances').waitFor()
      await page.locator('.recharts-bar-rectangle').first().waitFor()
      await page.locator('.recharts-pie-sector').first().waitFor()
    },
  },
  {
    name: 'transactions',
    as: 'neighbor',
    async capture(page) {
      await go(page, '/transactions')
      await heading(page, 'Transactions').waitFor()
      await page.locator('tbody tr').nth(5).waitFor()
    },
  },
  {
    name: 'actions-board',
    as: 'neighbor',
    // Eight columns of 290 px: hiding the sidebar (the menu button, remembered by the browser) shows
    // as many as fit.
    sidebarCollapsed: true,
    async capture(page) {
      await go(page, '/actions?view=board&scope=all')
      await heading(page, 'Actions').waitFor()
      await page.locator('.action-board-card').nth(15).waitFor()
      await page.locator('.action-board').evaluate(board => board.scrollTo(0, 0))
    },
  },
  {
    name: 'action-detail',
    as: 'neighbor',
    async capture(page) {
      await go(page, '/actions/5')
      await heading(page, 'Lift modernisation: controller, doors and cabin').waitFor()
      await page.getByRole('heading', { name: 'Attachments', exact: true }).waitFor()
      await page.getByText('Annual lift inspection report.pdf').first().waitFor()
      await page.getByRole('heading', { name: 'Comments', exact: true }).waitFor()
    },
  },
  {
    name: 'events',
    as: 'neighbor',
    async capture(page) {
      await go(page, '/events')
      await heading(page, 'Events').waitFor()
      await page.getByText('Bulky waste collection').first().waitFor()
    },
  },
  {
    name: 'neighbors',
    as: 'neighbor',
    // Wider cards: the email addresses fit on one line.
    sidebarCollapsed: true,
    async capture(page) {
      await go(page, '/neighbors')
      await heading(page, 'Neighbors').waitFor()
      await page.getByText('James Okafor').first().waitFor()
      // The three lower floors: the visitor's "You" (2B) and the president's medal (James Okafor, 1A).
      await scrollPast(dwelling(page, '4A'))
    },
  },
  {
    name: 'contacts',
    as: 'neighbor',
    async capture(page) {
      await go(page, '/contacts')
      await heading(page, 'Contacts').waitFor()
      await page.locator('tbody tr').nth(8).waitFor()
    },
  },
  {
    name: 'import-review',
    as: 'administrator',
    async capture(page) {
      await heading(page, 'Import statement').waitFor()
      await page.locator('input[type="file"]').setInputFiles({ name: 'statement.pdf', mimeType: 'application/pdf', buffer: STATEMENT_PDF })
      const dialog = page.getByRole('dialog', { name: 'Review import' })
      await dialog.getByText('Already recorded').first().waitFor()
      // The last two new rows (the newest movements come first), then the first already recorded.
      await dialog.evaluate(element => {
        const header = element.querySelector(':scope > header').getBoundingClientRect().bottom
        const rows = [...element.querySelectorAll('tbody tr')]
        const firstRecorded = rows.findIndex(row => row.innerText.includes('Already recorded'))
        element.scrollTop += rows[Math.max(0, firstRecorded - 2)].getBoundingClientRect().top - header
      })
    },
  },
  {
    name: 'rules',
    as: 'administrator',
    async capture(page) {
      await go(page, '/admin/rules')
      await heading(page, 'Classification rules').waitFor()
      const rule = page.locator('section.rule-editor', { has: page.getByRole('heading', { name: 'Lift maintenance', exact: true }) })
      await rule.getByRole('button', { name: 'Preview on history' }).click()
      await rule.locator('.notice li').first().waitFor()
      await scrollPast(rule.locator('xpath=preceding-sibling::section[1]'))
    },
  },
  {
    name: 'users',
    as: 'administrator',
    async capture(page) {
      // Sorted by status: pending invitations and a deactivated account come first.
      await go(page, '/admin/users?sort=status&direction=desc')
      await heading(page, 'Users').waitFor()
      await page.getByText('Zara Ahmed').first().waitFor()
    },
  },
  {
    name: 'storage',
    as: 'administrator',
    async capture(page) {
      await go(page, '/admin/storage')
      await heading(page, 'Storage').waitFor()
      await page.getByRole('button', { name: /^Delete permanently/ }).nth(2).waitFor()
      const withdrawn = page.locator('section', { has: page.getByRole('heading', { name: 'Withdrawn PDFs', exact: true }) }).last()
      await scrollPast(withdrawn.locator('xpath=preceding-sibling::section[1]'))
    },
  },
  {
    name: 'mobile',
    as: 'neighbor',
    device: PHONE,
    async capture(page) {
      await go(page, `/?start=${yearAgo}&end=${today}`)
      await heading(page, 'Community finances').waitFor()
      await page.locator('.recharts-bar-rectangle').first().waitFor()
      // The figures and the monthly trend, below the filters.
      await scrollPast(page.locator('section.filters'))
    },
  },
]

/** Records what goes wrong on a page, and how many /api requests are in flight. */
function watch(page) {
  const problems = []
  const activity = { inFlight: 0, lastChange: Date.now() }
  const where = () => new URL(page.url()).pathname
  const isApi = url => {
    const target = new URL(url)
    return target.origin === baseUrl.origin && target.pathname.startsWith('/api/')
  }
  page.on('pageerror', error => problems.push(`${where()}: uncaught: ${error.message}`))
  page.on('console', message => {
    if (message.type() === 'error') problems.push(`${where()}: console: ${message.text()}`)
  })
  page.on('response', response => {
    if (!isApi(response.url())) return
    const request = `${response.request().method()} ${new URL(response.url()).pathname} → ${response.status()}`
    if (!response.fromServiceWorker()) problems.push(`${where()}: not answered by the demo: ${request}`)
    else if (response.status() >= 400) problems.push(`${where()}: ${request}`)
  })
  const change = delta => request => {
    if (!isApi(request.url())) return
    activity.inFlight += delta
    activity.lastChange = Date.now()
  }
  page.on('request', change(1))
  page.on('requestfinished', change(-1))
  page.on('requestfailed', request => {
    change(-1)(request)
    if (isApi(request.url())) problems.push(`${where()}: failed: ${request.method()} ${new URL(request.url()).pathname}`)
  })
  return { problems, activity }
}

/** Waits until no /api request has been in flight for half a second. */
async function apiIdle(activity, timeout = 15_000) {
  const deadline = Date.now() + timeout
  while (activity.inFlight > 0 || Date.now() - activity.lastChange < 500) {
    if (Date.now() > deadline) throw new Error(`The page kept requesting the API for ${timeout / 1000} s`)
    await new Promise(done => setTimeout(done, 100))
  }
}

/** Opens the demo and leaves its welcome dialog as a neighbor or as the administrator. */
async function start(page, as) {
  await page.goto(baseUrl.href)
  // The banner says the data is synthetic and resets on reload; the docs say it next to every image.
  await page.addStyleTag({ content: '.demo-banner { display: none !important; }' })
  const welcome = page.getByRole('dialog', { name: 'Welcome to the Juntia demo' })
  await welcome.getByRole('button', { name: as === 'administrator' ? 'Open administration' : 'Explore as a neighbor' }).click()
  await welcome.waitFor({ state: 'detached' })
  if (await page.locator('.demo-banner').count() !== 1) throw new Error('The demo banner is missing: is this the demo build?')
  if (await page.locator('html').getAttribute('lang') !== 'en') throw new Error('The demo did not start in English')
}

/** No pointer over the page, no focus ring, nothing loading. */
async function tidy(page, activity) {
  await page.mouse.move(page.viewportSize().width / 2, 1)
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
  })
  await apiIdle(activity)
  await page.evaluate(() => document.fonts.ready)
  for (const busy of [page.locator('.loading-spinner'), page.getByText('Loading…')]) {
    await busy.first().waitFor({ state: 'detached' })
  }
  await page.waitForTimeout(300)
}

async function answers(url) {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(2_000) })).ok
  } catch {
    return false
  }
}

/** One screenshot in a fresh context; returns its failure, if any, and writes the PNG otherwise. */
async function takeScreenshot(browser, shot) {
  const device = shot.device ?? DESKTOP
  const context = await browser.newContext({
    ...device,
    locale: 'en-GB',
    timezoneId: TIME_ZONE,
    colorScheme: 'light',
    reducedMotion: 'reduce',
    serviceWorkers: 'allow',
  })
  try {
    await context.clock.setFixedTime(clock)
    if (shot.sidebarCollapsed) await context.addInitScript(() => localStorage.setItem('juntia_sidebar_collapsed', '1'))
    const page = await context.newPage()
    const { problems, activity } = watch(page)
    await start(page, shot.as)
    await apiIdle(activity)
    await shot.capture(page)
    await tidy(page, activity)
    const image = await page.screenshot({ animations: 'disabled', caret: 'hide' })
    if (problems.length) throw new Error(problems.join('\n  '))
    writeFileSync(resolve(outDir, `${shot.name}.png`), image)
    const { pathname, search } = new URL(page.url())
    console.log(`${shot.name}.png  ${device.viewport.width}×${device.viewport.height}  ${pathname}${search}`)
    return []
  } catch (error) {
    console.error(`${shot.name}: FAILED\n  ${error.message}`)
    return [shot.name]
  } finally {
    await context.close()
  }
}

/** Serves dist-demo on the base URL with `vite preview --mode demo`, the demo's static host. */
async function startPreview() {
  if (!['127.0.0.1', 'localhost'].includes(baseUrl.hostname)) throw new Error(`Nothing answers on ${baseUrl.origin}`)
  if (!existsSync(resolve(frontend, 'dist-demo', 'index.html'))) throw new Error('Build the demo first: npm run build:demo')
  const port = baseUrl.port || '80'
  const preview = spawn(process.execPath, [resolve(frontend, 'node_modules/vite/bin/vite.js'), 'preview', '--mode', 'demo', '--host', baseUrl.hostname, '--port', port, '--strictPort'], { cwd: frontend, stdio: 'inherit' })
  const exited = new Promise(done => preview.once('exit', done))
  const deadline = Date.now() + 30_000
  while (!(await answers(baseUrl.href))) {
    if (preview.exitCode !== null || Date.now() > deadline) {
      preview.kill()
      throw new Error(`vite preview did not start on ${baseUrl.origin}`)
    }
    await new Promise(done => setTimeout(done, 250))
  }
  return async () => {
    preview.kill()
    await exited
  }
}

const shots = only.length ? SHOTS.filter(shot => only.includes(shot.name)) : SHOTS
const unknown = only.filter(name => !SHOTS.some(shot => shot.name === name))
if (unknown.length) throw new Error(`Unknown screenshots: ${unknown.join(', ')}. Known: ${SHOTS.map(shot => shot.name).join(', ')}`)

const stopPreview = await answers(baseUrl.href) ? null : await startPreview()
const failures = []
try {
  mkdirSync(outDir, { recursive: true })
  const browser = await chromium.launch({
    // Native date fields ignore the page's locale and use the browser's own: on Linux it comes from
    // LANG; on Windows, when it has the language of the user's regional format, that format is used
    // instead (mm/dd/yyyy on an en-US Windows, even for en-GB). LANG gives en-GB's day/month/year on
    // Linux, and a Spanish browser language gives the same order on Windows. The page keeps en-GB,
    // and the headless shell has no translations, so no Spanish text shows.
    env: { ...process.env, LANG: 'en_GB.UTF-8' },
    args: process.platform === 'win32' ? ['--lang=es-ES'] : [],
  })
  try {
    for (const shot of shots) failures.push(...await takeScreenshot(browser, shot))
  } finally {
    await browser.close()
  }
} finally {
  await stopPreview?.()
}
if (failures.length) {
  console.error(`\n${failures.length} of ${shots.length} screenshots failed.`)
  process.exitCode = 1
} else {
  console.log(`\n${shots.length} screenshots in ${outDir} (demo data of ${today}).`)
}
