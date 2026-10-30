import AxeBuilder from '@axe-core/playwright'
import { expect, test as base, type Locator, type Page } from '@playwright/test'
import { en } from '../src/i18n/locales/en'
import { es } from '../src/i18n/locales/es'

// The public demo (playwright.demo.config.ts): the static build with its in-browser API. Besides
// each test's own checks, nothing may go wrong unnoticed: no /api request may reach the static host
// (only the MSW service worker answers the API), no API answer may be a server error, no request
// may fall into the demo's catch-all (a route no demo handler serves), and no uncaught error or
// console error may happen.

/** Logged by the demo's catch-all for an /api request no handler answers (src/demo/handlers/index.ts). */
const UNHANDLED_PREFIX = '[demo] Unhandled API request:'

const SAMPLE_NEIGHBOR = { name: 'Olivia Bennett', email: 'olivia.bennett@example.com' }

type Language = 'en' | 'es'
const MESSAGES = { en, es } as const

interface Problems {
  /** /api responses that did not come from the service worker. */
  escaped: string[]
  /** /api responses with a 5xx status (the catch-all's 501 included). */
  serverErrors: string[]
  /** Uncaught exceptions and console errors. */
  errors: string[]
  /** Requests answered by the catch-all: routes no demo module serves. */
  unserved: string[]
}

/** In-flight /api requests of the page, to wait until a page has loaded its data. */
interface ApiActivity {
  inFlight: number
  lastChange: number
}

const isApi = (url: string) => new URL(url).pathname.startsWith('/api/')

const test = base.extend<{ problems: Problems; apiActivity: ApiActivity; expectedConsoleErrors: RegExp[] }>({
  expectedConsoleErrors: [[], { option: true }],
  problems: [async ({ page, expectedConsoleErrors }, use) => {
    const problems: Problems = { escaped: [], serverErrors: [], errors: [], unserved: [] }
    const where = () => new URL(page.url()).pathname
    page.on('pageerror', error => problems.errors.push(`${where()}: uncaught: ${error.message}`))
    page.on('console', message => {
      if (message.type() !== 'error') return
      const text = message.text()
      if (text.startsWith(UNHANDLED_PREFIX)) problems.unserved.push(text.slice(UNHANDLED_PREFIX.length).trim())
      // Chromium also logs every 4xx/5xx response; the API's own answers are checked below.
      else if (!text.startsWith('Failed to load resource') && !expectedConsoleErrors.some(pattern => pattern.test(text))) {
        problems.errors.push(`${where()}: console: ${text}`)
      }
    })
    page.on('response', response => {
      if (!isApi(response.url())) return
      const request = `${response.request().method()} ${new URL(response.url()).pathname} → ${response.status()}`
      if (!response.fromServiceWorker()) problems.escaped.push(request)
      if (response.status() >= 500) problems.serverErrors.push(`${where()}: ${request}`)
    })
    await use(problems)
    expect(problems.escaped, 'API requests that reached the static host').toEqual([])
    expect([...new Set(problems.unserved)], 'API requests no demo handler answers').toEqual([])
    expect(problems.serverErrors, 'API answers with a server error').toEqual([])
    expect(problems.errors, 'uncaught errors and console errors').toEqual([])
  }, { auto: true }],
  apiActivity: async ({ page }, use) => {
    const activity: ApiActivity = { inFlight: 0, lastChange: Date.now() }
    const change = (delta: number) => (url: string) => {
      if (!isApi(url)) return
      activity.inFlight += delta
      activity.lastChange = Date.now()
    }
    const started = change(1), ended = change(-1)
    page.on('request', request => started(request.url()))
    page.on('requestfinished', request => ended(request.url()))
    page.on('requestfailed', request => ended(request.url()))
    await use(activity)
  },
})

const welcome = (page: Page, language: Language = 'en') =>
  page.getByRole('dialog', { name: MESSAGES[language].demo.welcome.title })

const banner = (page: Page, language: Language = 'en') =>
  page.getByRole('complementary', { name: MESSAGES[language].demo.banner.label })

const mainNavigation = (page: Page, language: Language = 'en') =>
  page.getByRole('navigation', { name: MESSAGES[language].shell.navigation.main })

const adminNavigation = (page: Page, language: Language = 'en') =>
  page.getByRole('navigation', { name: MESSAGES[language].shell.navigation.admin })

/** The page rendered without falling into the error boundary. */
async function expectNoCrash(page: Page): Promise<void> {
  for (const messages of [en, es]) await expect(page.getByRole('heading', { name: messages.shell.crash.title })).toHaveCount(0)
}

async function explore(page: Page): Promise<void> {
  await welcome(page).getByRole('button', { name: en.demo.welcome.neighbor }).click()
  await expect(welcome(page)).toBeHidden()
}

async function expectValue(field: Locator, value: string): Promise<void> {
  await expect(field).toHaveValue(value)
}

test('opens signed in as the sample neighbor, with the banner and a welcome once per page load', async ({ page }) => {
  const response = await page.goto('/')
  // The static host's security headers (vite preview locally, dist-demo/_headers on Cloudflare).
  expect(response?.headers()['content-security-policy']).toContain("worker-src 'self'")
  expect(response?.headers()['x-frame-options']).toBe('DENY')
  await expect(page.locator('html')).toHaveAttribute('lang', 'en')
  await expect(page).toHaveTitle('Maple Court')
  const dialog = welcome(page)
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText(`You are signed in as ${SAMPLE_NEIGHBOR.name}, a neighbor at Maple Court.`)
  await expect(dialog).toContainText(en.demo.welcome.data)

  const bar = banner(page)
  await expect(bar).toContainText(en.demo.banner.text)
  await expect(bar.getByRole('link', { name: en.demo.banner.sourceLabel }))
    .toHaveAttribute('href', 'https://github.com/DrDonoso/juntia')

  await explore(page)
  await expect(mainNavigation(page).getByRole('link', { name: en.shell.links.overview })).toBeVisible()
  await expect(page.getByRole('button', { name: en.shell.userMenu })).toHaveText('OB')
  await expectNoCrash(page)

  // Moving around the app keeps the same page load: no second welcome.
  await mainNavigation(page).getByRole('link', { name: en.shell.links.neighbors }).click()
  await expect(page).toHaveURL(/\/neighbors$/)
  await mainNavigation(page).getByRole('link', { name: en.shell.links.overview }).click()
  await expect(page).toHaveURL(/\/$/)
  await expect(welcome(page)).toHaveCount(0)
  await expectNoCrash(page)
})

test('the welcome dialog opens the administration', async ({ page }) => {
  await page.goto('/')
  await welcome(page).getByRole('button', { name: en.demo.welcome.admin }).click()
  await expect(page).toHaveURL(/\/admin$/)
  await expect(welcome(page)).toBeHidden()
  await expect(adminNavigation(page)).toBeVisible()
  await expectNoCrash(page)
})

test('the administration sign-in comes filled in with demo / demo', async ({ page }) => {
  await page.goto('/admin')
  await welcome(page).getByRole('button', { name: en.common.close }).click()
  const card = page.locator('section.login')
  await expect(card.getByRole('note')).toHaveText(`Demo: sign in with the username demo and the password demo.`)
  await expectValue(card.getByLabel(en.auth.admin.username), 'demo')
  await expectValue(card.getByLabel(en.auth.password), 'demo')
  await card.getByRole('button', { name: en.auth.admin.submit }).click()
  await expect(adminNavigation(page)).toBeVisible()
  await expect(card).toHaveCount(0)
  await expectNoCrash(page)
})

test('switching to Spanish shows the Spanish shell and demo texts', async ({ page }) => {
  await page.goto('/')
  await explore(page)
  await page.getByRole('button', { name: en.shell.userMenu }).click()
  await page.locator('#user-menu').getByLabel(en.common.language.label).selectOption('es')
  await expect(page.locator('html')).toHaveAttribute('lang', 'es')
  await expect(page.getByRole('navigation', { name: es.shell.navigation.main }).getByRole('link', { name: es.shell.links.overview })).toBeVisible()
  await expect(banner(page, 'es')).toContainText(es.demo.banner.text)

  // The choice is remembered: the next page load welcomes the visitor in Spanish.
  await page.reload()
  await expect(welcome(page, 'es')).toBeVisible()
  await expect(welcome(page, 'es').getByRole('button', { name: es.demo.welcome.neighbor })).toBeVisible()
  await expectNoCrash(page)
})

test('a reload starts the demo again: signing out is undone', async ({ page }) => {
  await page.goto('/')
  await explore(page)
  await page.getByRole('button', { name: en.shell.userMenu }).click()
  await page.getByRole('button', { name: en.shell.signOut }).click()
  await expect(page).toHaveURL(/\/login/)
  const card = page.locator('section.login')
  await expect(card.getByRole('note')).toHaveText(
    `Demo: sign in as ${SAMPLE_NEIGHBOR.email} with the password demo. Every active neighbor of the demo uses the same password.`,
  )
  await expectValue(card.getByLabel(en.auth.email), SAMPLE_NEIGHBOR.email)
  await expectValue(card.getByLabel(en.auth.password), 'demo')

  await page.reload()
  await expect(page).toHaveURL(/\/$/)
  await expect(welcome(page)).toBeVisible()
  await explore(page)
  await expect(mainNavigation(page)).toBeVisible()
  await expect(page.getByRole('button', { name: en.shell.userMenu })).toHaveText('OB')
  await expectNoCrash(page)
})

test('a neighbor signs in with the filled-in form', async ({ page }) => {
  await page.goto('/')
  await explore(page)
  await page.getByRole('button', { name: en.shell.userMenu }).click()
  await page.getByRole('button', { name: en.shell.signOut }).click()
  const card = page.locator('section.login')
  await expectValue(card.getByLabel(en.auth.email), SAMPLE_NEIGHBOR.email)
  await card.getByLabel(en.auth.email).fill('james.okafor@example.com')
  await card.getByRole('button', { name: en.auth.login.submit }).click()
  await expect(mainNavigation(page)).toBeVisible()
  await expect(page.getByRole('button', { name: en.shell.userMenu })).toHaveText('JO')
  await expectNoCrash(page)
})

test.describe('without service workers', () => {
  test.use({ serviceWorkers: 'block', expectedConsoleErrors: [/^The demo API could not start/] })

  test('the demo explains why it cannot run and never asks the static host for the API', async ({ page }) => {
    const api: string[] = []
    page.on('request', request => {
      if (new URL(request.url()).pathname.startsWith('/api/')) api.push(request.url())
    })
    await page.goto('/')
    await expect(page.getByRole('alert')).toContainText(en.demo.startError.title)
    await expect(page.getByRole('alert')).toContainText(en.demo.startError.description)
    expect(api).toEqual([])
  })
})

/**
 * Accessibility violations of app components outside the demo that the crawl tolerates until their
 * owners fix them: each one names its axe rule and the element (axe's selector). Anything else
 * serious or critical fails.
 */
const KNOWN_VIOLATIONS: readonly { rule: string; target: string }[] = []

/** WCAG 2 A and AA checks of the page as it is now: serious and critical violations fail. */
async function expectAccessible(page: Page, where: string): Promise<void> {
  const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()
  const found = violations
    .filter(violation => violation.impact === 'serious' || violation.impact === 'critical')
    .flatMap(violation => violation.nodes.map(node => ({ rule: violation.id, target: node.target.join(' '), summary: node.failureSummary ?? '' })))
    .filter(item => !KNOWN_VIOLATIONS.some(known => known.rule === item.rule && known.target === item.target))
  expect(found, `serious or critical accessibility violations on ${where}`).toEqual([])
}

/** Waits until no /api request has been in flight for a moment since `since`: the page has loaded its data. */
async function settled(activity: ApiActivity, since: number): Promise<void> {
  await expect.poll(() => activity.inFlight <= 0 && Date.now() - Math.max(activity.lastChange, since) >= 400, {
    timeout: 15_000, intervals: [100],
  }).toBe(true)
}

/** Marks the heading of the page on screen: the next page's checks wait until it is gone. */
async function leavePage(page: Page): Promise<void> {
  await page.locator('#content h1').first().evaluate(heading => heading.setAttribute('data-crawl-left', ''))
}

/** The page on screen: loaded, titled, in `language`, unbroken and accessible. */
async function expectPage(page: Page, activity: ApiActivity, language: Language, where: string): Promise<void> {
  await expect(page.locator('#content h1[data-crawl-left]')).toHaveCount(0)
  await expect(page.getByText(MESSAGES[language].shell.loadingPage)).toHaveCount(0)
  await expect(page.locator('#content h1').first()).toBeVisible()
  await settled(activity, Date.now())
  await expect(page.locator('#content h1').first()).toBeVisible()
  await expect(page.locator('html')).toHaveAttribute('lang', language)
  await expectNoCrash(page)
  await expectAccessible(page, `${where} (${language})`)
}

/** Opens every link of a navigation landmark in turn, as found on screen, and checks each page; returns their paths. */
async function visitEveryLink(page: Page, activity: ApiActivity, navigation: Locator, language: Language): Promise<string[]> {
  await expect(navigation.getByRole('link').first()).toBeVisible()
  const links = await navigation.getByRole('link').evaluateAll(anchors => anchors.map(anchor => ({
    name: anchor.textContent?.trim() ?? '', href: anchor.getAttribute('href') ?? '',
  })))
  for (const link of links) {
    await test.step(`${link.name}: ${link.href}`, async () => {
      if (new URL(page.url()).pathname !== link.href) await leavePage(page)
      await navigation.locator(`a[href="${link.href}"]`).click()
      await expect(page).toHaveURL(url => url.pathname === link.href)
      await expectPage(page, activity, language, link.href)
    })
  }
  return links.map(link => link.href)
}

const PORTAL_PAGES = ['/', '/transactions', '/actions', '/events', '/neighbors', '/contacts']
const ADMIN_PAGES = [
  '/admin', '/admin/transactions', '/admin/rules', '/admin/catalog', '/admin/statements', '/admin/general', '/admin/features',
  '/admin/dwellings', '/admin/users', '/admin/labels', '/admin/deleted-contacts',
]

// Every page of both navigations, in English and in Spanish (the browser's language picks it): new
// links are found on screen, so new pages are crawled without changing this list of expectations.
for (const language of ['en', 'es'] as const) {
  const messages = MESSAGES[language]
  test.describe(`every page in ${language === 'en' ? 'English' : 'Spanish'}`, () => {
    test.use({ locale: language === 'en' ? 'en-GB' : 'es-ES' })
    test.describe.configure({ timeout: 180_000 })

    test('as the sample neighbor', async ({ page, apiActivity }) => {
      await page.goto('/')
      await expect(page.locator('html')).toHaveAttribute('lang', language)
      await welcome(page, language).getByRole('button', { name: messages.demo.welcome.neighbor }).click()
      await expect(welcome(page, language)).toBeHidden()
      const visited = await visitEveryLink(page, apiActivity, mainNavigation(page, language), language)
      expect(visited).toEqual(expect.arrayContaining(PORTAL_PAGES))

      await test.step('My profile: /profile', async () => {
        await leavePage(page)
        await page.getByRole('button', { name: messages.shell.userMenu }).click()
        await page.getByRole('navigation', { name: messages.shell.userOptions }).getByRole('link', { name: messages.shell.myProfile }).click()
        await expect(page).toHaveURL(url => url.pathname === '/profile')
        await expectPage(page, apiActivity, language, '/profile')
      })

      await test.step('the actions as a Kanban board: /actions?view=board', async () => {
        await leavePage(page)
        await mainNavigation(page, language).locator('a[href="/actions"]').click()
        await expect(page.locator('#content h1[data-crawl-left]')).toHaveCount(0)
        await page.getByRole('group', { name: messages.actions.list.view }).getByRole('button', { name: messages.actions.list.boardView }).click()
        await expect(page).toHaveURL(url => url.pathname === '/actions' && url.searchParams.get('view') === 'board')
        await expectPage(page, apiActivity, language, '/actions?view=board')
      })

      await test.step('an action with comments and a withdrawn PDF: /actions/:id', async () => {
        await leavePage(page)
        await page.getByRole('link', { name: /^Lift modernisation/ }).click()
        await expect(page).toHaveURL(url => /^\/actions\/\d+$/.test(url.pathname))
        await expectPage(page, apiActivity, language, '/actions/:id')
        await expect(page.locator('#content h1')).toHaveText(/^Lift modernisation/)
      })
    })

    test('as the administrator', async ({ page, apiActivity }) => {
      await page.goto('/')
      await welcome(page, language).getByRole('button', { name: messages.demo.welcome.admin }).click()
      await expect(page).toHaveURL(url => url.pathname === '/admin')
      await expect(welcome(page, language)).toBeHidden()
      const visited = await visitEveryLink(page, apiActivity, adminNavigation(page, language), language)
      expect(visited).toEqual(expect.arrayContaining(ADMIN_PAGES))
    })
  })
}
