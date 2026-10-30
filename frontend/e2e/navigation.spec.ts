import { test, expect, type Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import type { ContactOut, ProfileOut, SummaryOut, UserAuthOut } from '../src/api/schema.gen'

async function mockSession(page: Page, { administrator = false, actions = true, contacts = [] }: {
  administrator?: boolean; actions?: boolean; contacts?: ContactOut[]
} = {}) {
  const state = { authenticated: true, logoutFails: false, logoutRequests: 0 }
  const identity: UserAuthOut = {
    authenticated: true, kind: administrator ? 'administrator' : 'resident',
    name: administrator ? 'Administrator' : 'Test Neighbor',
    email: administrator ? null : 'neighbor@example.org',
    user_id: administrator ? null : 1, dwelling_id: administrator ? null : 1,
    expires_at: '2099-01-01T00:00:00Z',
  }
  const profile: ProfileOut = {
    id: 1, name: 'Test Neighbor', email: 'neighbor@example.org', phone: '',
    dwelling_id: 1, dwelling_label: '1 A', coefficient: '5.00',
    google_linked: false, has_password: true, last_login_at: null, version: 1,
  }
  const summary: SummaryOut = {
    income: '0.00', expense: '0.00', net: '0.00', count: 0,
    balance: null, balance_date: null, coverage_start: null, coverage_end: null,
    monthly: [], categories: [], merchants: [], daily: [],
  }
  await page.route(url => url.pathname.startsWith('/api/'), async route => {
    const path = new URL(route.request().url()).pathname
    const json = (value: unknown) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(value) })
    if (path === '/api/admin/auth/session') return json({
      authenticated: state.authenticated && administrator, username: administrator ? 'admin' : null,
    })
    if (path === '/api/auth/session') return json(state.authenticated ? identity : {
      authenticated: false, kind: null, name: null, email: null,
      user_id: null, dwelling_id: null, expires_at: null,
    })
    if (path === '/api/settings/general') return json({
      community_name: 'Residential community of Park Avenue and Market Square',
    })
    if (path === '/api/features') return json({ actions, coefficient: true, events: false, google_login: false })
    if (path === '/api/catalog/categories' || path === '/api/catalog/tags') return json([])
    if (path === '/api/admin/action-labels' || path === '/api/admin/contact-tags') return json({ items: [], total: 0, page: 1, pages: 1 })
    if (path === '/api/summary') return json(summary)
    if (path === '/api/transactions') return json({ items: [], total: 0, page: 1, pages: 1 })
    if (path === '/api/contacts' || path === '/api/admin/contacts/deleted') return json({
      items: contacts, total: contacts.length, page: 1, pages: 1,
    })
    if (path === '/api/auth/profile') return json(profile)
    if (path === '/api/auth/logout') {
      expect(route.request().method()).toBe('POST')
      state.logoutRequests += 1
      if (state.logoutFails) return route.fulfill({
        status: 503, contentType: 'application/json', body: JSON.stringify({ code: 'internal_error' }),
      })
      state.authenticated = false
      return json({ ok: true })
    }
    return route.abort()
  })
  return state
}

for (const width of [320, 390, 720]) {
  test(`the ${width}px header keeps navigation and profile details out of the page`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 })
    await mockSession(page)
    await page.goto('/')
    const navigation = page.getByRole('button', { name: 'Navigation menu', exact: true })
    const avatar = page.getByRole('button', { name: 'User menu', exact: true })
    await expect(navigation).toHaveAttribute('aria-expanded', 'false')
    await expect(page.locator('.sidebar')).toBeHidden()
    await expect(page.locator('.sidebar-profile')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toHaveCount(0)
    await expect(avatar.locator('.profile-avatar')).toHaveText('TN')
    await expect(avatar).toHaveCSS('width', '40px')
    await expect(avatar).toHaveCSS('height', '40px')
    await expect(page.locator('.topbar')).toHaveCSS('height', '52px')
    const header = await page.locator('.topbar').boundingBox()
    expect(header?.y).toBe(0)
    expect(header?.width).toBe(width)
    const theme = page.getByRole('button', { name: 'Dark mode', exact: true })
    const themeBox = await theme.boundingBox(), avatarBox = await avatar.boundingBox()
    expect(avatarBox?.y).toBe(themeBox?.y)
    expect(avatarBox!.x).toBeGreaterThan(themeBox!.x)
    await page.getByRole('button', { name: 'Hide amounts', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Show amounts', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await theme.click()
    await expect(page.getByRole('button', { name: 'Light mode', exact: true })).toHaveAttribute('aria-pressed', 'true')
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await avatar.click()
    const menu = page.getByRole('navigation', { name: 'User options', exact: true })
    await expect(menu.getByRole('link', { name: 'My profile', exact: true })).toBeVisible()
    await expect(menu.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible()
    await expect(menu.getByRole('combobox', { name: 'Language', exact: true })).toHaveValue('en')
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
    if (width === 390) await page.screenshot({ path: 'test-results/navigation-mobile-user.png' })
  })
}

test('mobile menus support keyboard navigation, light dismissal and mutually exclusive panels', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await mockSession(page)
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'User menu', exact: true })).toBeVisible()
  await page.getByRole('link', { name: 'Skip to content', exact: true }).focus()
  await page.keyboard.press('Enter')
  await expect(page.locator('main')).toBeFocused()
  expect((await page.locator('main').boundingBox())?.y).toBeGreaterThanOrEqual(52)
  const toggle = page.getByRole('button', { name: 'Navigation menu', exact: true })
  const navigation = page.getByRole('navigation', { name: 'Main navigation', exact: true })
  await toggle.press('Enter')
  await expect(navigation.getByRole('link', { name: 'Overview', exact: true })).toBeFocused()
  await expect(navigation.getByRole('group', { name: 'Finances', exact: true })).toBeVisible()
  await expect(navigation.getByRole('group', { name: 'Management', exact: true })).toBeVisible()
  await expect(navigation.getByRole('group', { name: 'Community', exact: true })).toBeVisible()
  await expect(navigation.locator('a[href^="/admin"]')).toHaveCount(0)
  await expect(page.locator('.sidebar-profile')).toHaveCount(0)
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
  await page.screenshot({ path: 'test-results/navigation-mobile-open.png' })
  await page.keyboard.press('Tab')
  await expect(navigation.getByRole('link', { name: 'Transactions', exact: true })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/\/transactions$/)
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await expect(page.locator('main')).toBeFocused()
  await toggle.click()
  await navigation.getByRole('link', { name: 'Contacts', exact: true }).click()
  await expect(page).toHaveURL(/\/contacts$/)
  await expect(page.getByRole('heading', { name: 'Contacts', exact: true })).toBeVisible()
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await toggle.click()
  await page.keyboard.press('Escape')
  await expect(toggle).toBeFocused()
  await expect(page.locator('.sidebar')).toBeHidden()
  await toggle.click()
  await page.mouse.click(380, 800)
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await toggle.click()
  const avatar = page.getByRole('button', { name: 'User menu', exact: true })
  await avatar.click()
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await expect(avatar).toHaveAttribute('aria-expanded', 'true')
  await page.keyboard.press('Escape')
  await expect(avatar).toBeFocused()
  await expect(avatar).toHaveAttribute('aria-expanded', 'false')
  await avatar.click()
  await page.getByRole('button', { name: 'Dark mode', exact: true }).focus()
  await expect(avatar).toHaveAttribute('aria-expanded', 'false')
})

test('the avatar opens the profile and signs out without concealing a logout failure', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const state = await mockSession(page)
  await page.goto('/')
  const avatar = page.getByRole('button', { name: 'User menu', exact: true })
  await avatar.click()
  await page.getByRole('link', { name: 'My profile', exact: true }).click()
  await expect(page).toHaveURL(/\/profile$/)
  await expect(page.getByRole('heading', { name: 'My profile', exact: true })).toBeVisible()
  await expect(avatar).toHaveAttribute('aria-expanded', 'false')
  await expect(page.locator('main')).toBeFocused()
  state.logoutFails = true
  await avatar.click()
  await page.getByRole('button', { name: 'Sign out', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('The operation could not be completed.')
  await expect(avatar).toBeVisible()
  await expect(avatar).toHaveAttribute('aria-expanded', 'false')
  expect(state.authenticated).toBe(true)
  state.logoutFails = false
  await avatar.click()
  await page.getByRole('button', { name: 'Sign out', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible()
  await expect(avatar).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toHaveCount(0)
  await expect(page.getByText('Test Neighbor', { exact: true })).toHaveCount(0)
  expect(state.logoutRequests).toBe(2)
})

test('desktop navigation gives space back to the page and remembers its state independently of mobile', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await mockSession(page)
  await page.goto('/')
  const toggle = page.getByRole('button', { name: 'Navigation menu', exact: true })
  const sidebar = page.locator('.sidebar'), workspace = page.locator('.workspace')
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  await expect(sidebar).toBeVisible()
  await expect(page.locator('.sidebar-profile')).toHaveCount(0)
  await expect(sidebar.locator('.sidebar-footer')).toHaveCount(0)
  await expect(sidebar.locator('a[href="/profile"]')).toHaveCount(0)
  await expect(page.locator('.topbar a[href="/profile"]')).toHaveCount(1)
  await expect(workspace).toHaveCSS('margin-left', '240px')
  expect((await sidebar.boundingBox())?.y).toBe(52)
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await expect(sidebar).toBeHidden()
  await expect(sidebar).toHaveAttribute('inert', '')
  await expect(workspace).toHaveCSS('margin-left', '0px')
  expect(await page.evaluate(() => localStorage.getItem('juntia_sidebar_collapsed'))).toBe('1')
  await page.reload()
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await expect(workspace).toHaveCSS('margin-left', '0px')
  await page.getByRole('button', { name: 'User menu', exact: true }).click()
  await page.getByRole('link', { name: 'My profile', exact: true }).click()
  await expect(page).toHaveURL(/\/profile$/)
  await expect(sidebar).toBeHidden()
  await page.screenshot({ path: 'test-results/navigation-desktop-collapsed.png' })
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await toggle.click()
  await expect(sidebar).toBeVisible()
  expect(await page.evaluate(() => localStorage.getItem('juntia_sidebar_collapsed'))).toBe('1')
  await page.setViewportSize({ width: 721, height: 900 })
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await expect(sidebar).toBeHidden()
  await expect(page.locator('.sidebar-backdrop')).toHaveCount(0)
  await toggle.click()
  await expect(workspace).toHaveCSS('margin-left', '205px')
  await page.reload()
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Test Neighbor')
  await page.setViewportSize({ width: 390, height: 844 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await page.setViewportSize({ width: 1280, height: 900 })
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  await expect(workspace).toHaveCSS('margin-left', '240px')
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
})

for (const actions of [true, false]) {
  test(`the short mobile administrator menu separates configuration from community views (${actions})`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 320 })
    await mockSession(page, { administrator: true, actions })
    await page.goto('/admin/general')
    await expect(page.getByRole('heading', { name: 'General', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Navigation menu', exact: true }).click()
    const navigation = page.getByRole('navigation', { name: 'Administration navigation', exact: true })
    await expect(navigation.getByRole('link')).toHaveCount(12)
    await expect(navigation.getByRole('link', { name: 'Features', exact: true })).toHaveAttribute('href', '/admin/features')
    await expect(navigation.getByRole('link', { name: 'Community labels', exact: true })).toHaveAttribute('href', '/admin/labels')
    await expect(navigation.getByRole('link', { name: 'Deleted contacts', exact: true })).toHaveAttribute('href', '/admin/deleted-contacts')
    await expect(navigation.getByRole('group', { name: 'Settings', exact: true }).getByRole('link', { name: 'Storage', exact: true })).toHaveAttribute('href', '/admin/storage')
    for (const name of ['Actions', 'Neighbors', 'Contacts']) await expect(navigation.getByRole('link', { name, exact: true })).toHaveCount(0)
    await expect(navigation.getByRole('group', { name: 'Management', exact: true })).toHaveCount(0)
    expect(await page.locator('.sidebar').evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true)
    await expect(page.locator('.sidebar-profile')).toHaveCount(0)
    await page.getByRole('link', { name: 'Community portal' }).click()
    await expect(page).toHaveURL(/\/$/)
    await expect(page.locator('.sidebar')).toBeHidden()
    await page.getByRole('button', { name: 'Navigation menu', exact: true }).click()
    const readerNavigation = page.getByRole('navigation', { name: 'Main navigation', exact: true })
    await expect(readerNavigation.getByRole('link')).toHaveCount(actions ? 5 : 4)
    await expect(readerNavigation.getByRole('group', { name: 'Management', exact: true })).toHaveCount(actions ? 1 : 0)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  })
}

const layoutContact: ContactOut = {
  id: 1, name: 'Contact A', company: 'Company A', email: 'one@example.org',
  phone: '+442079460123', notes: '', version: 1, deleted_at: null,
  tags: [{ id: 1, name: 'Emergencies', color: '#21639f', version: 1 }],
  created_at: '2026-10-11T08:00:00Z', updated_at: '2026-10-11T08:00:00Z',
}
const layoutContacts: ContactOut[] = [
  layoutContact,
  { ...layoutContact, id: 2, name: 'Contact B', company: '', email: null, phone: '+123456789012345', tags: [] },
  {
    ...layoutContact, id: 3, name: 'Maintenance service for the shared community facilities',
    company: 'Repairs and full maintenance company for the whole community',
    email: `${'services'.repeat(8)}@${'community'.repeat(5)}.example.org`,
    phone: '', tags: [{ id: 2, name: 'Maintenance of the shared community facilities', color: '#21639f', version: 1 }],
  },
]

for (const administrator of [false, true]) {
  test(`contacts keep text and headers aligned across layouts (${administrator})`, async ({ page }, testInfo) => {
    await mockSession(page, { administrator, contacts: layoutContacts })
    await page.goto(administrator ? '/admin/contacts' : '/contacts')
    await expect(page).toHaveURL(/\/contacts$/)
    await expect(page.getByRole('heading', { name: 'Contacts', exact: true })).toBeVisible()
    await page.evaluate(() => document.fonts.ready)
    const table = page.getByRole('table', { name: 'Community contacts' })
    for (const width of [1440, 1920, 1280, 1101]) {
      await page.setViewportSize({ width, height: 1000 })
      await expect(table).toBeVisible()
      const row = table.locator('tbody tr').first()
      const alignment = await row.evaluate(element => {
        const cells = element.querySelectorAll('td')
        const text = [
          cells[0].querySelector('button')!, cells[1],
          cells[2].querySelector('a')!, cells[3].querySelector('a')!,
        ].map(node => {
          const range = document.createRange()
          range.selectNodeContents(node)
          const bounds = range.getBoundingClientRect()
          return { left: bounds.left, center: bounds.top + bounds.height / 2 }
        })
        const headers = Array.from(element.closest('table')!.querySelectorAll('th button')).map(button => {
          const range = document.createRange()
          range.selectNodeContents(button.firstChild!)
          return range.getBoundingClientRect().left
        })
        return { text, headers }
      })
      await page.screenshot({ path: testInfo.outputPath(`contacts-${width}.png`), fullPage: true, animations: 'disabled' })
      const centers = alignment.text.map(value => value.center)
      expect(Math.max(...centers) - Math.min(...centers), `text centers at ${width}px`).toBeLessThanOrEqual(1)
      for (const [index, text] of alignment.text.entries()) {
        expect(Math.abs(text.left - alignment.headers[index]), `column ${index + 1} at ${width}px`).toBeLessThanOrEqual(1)
      }
      expect(await table.locator('td').evaluateAll(cells => cells.every(cell => cell.scrollWidth <= cell.clientWidth + 1))).toBe(true)
      for (const control of await row.locator('button, a').all()) {
        expect((await control.boundingBox())!.height).toBeGreaterThanOrEqual(44)
      }
    }
    for (const width of [1100, 768, 390, 320]) {
      await page.setViewportSize({ width, height: 844 })
      await expect(table).toBeHidden()
      if (width <= 720) await expect(page.locator('.sidebar')).toBeHidden()
      await expect(page.getByRole('article')).toHaveCount(3)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      const card = page.getByRole('article').first()
      expect(await card.evaluate(element => {
        const name = element.querySelector('.contact-name')!.getBoundingClientRect()
        const company = element.querySelector('p')!.getBoundingClientRect()
        return Math.abs(name.left - company.left)
      })).toBeLessThanOrEqual(1)
      await page.screenshot({ path: testInfo.outputPath(`contacts-${width}.png`), fullPage: true, animations: 'disabled' })
    }
    if (administrator) {
      await page.setViewportSize({ width: 1440, height: 1000 })
      await page.goto('/admin/deleted-contacts')
      await expect(page.getByRole('heading', { name: 'Deleted contacts', exact: true })).toBeVisible()
      await expect(table.locator('td').first()).toHaveCSS('vertical-align', 'middle')
    }
  })
}

test.describe('touch navigation icons', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  for (const administrator of [false, true]) {
    test(`both themes use decorative SVGs instead of OS glyphs (${administrator})`, async ({ page }, testInfo) => {
      await mockSession(page, { administrator })
      await page.goto(administrator ? '/admin/labels' : '/contacts')
      await expect(page.getByRole('heading', { name: administrator ? 'Community labels' : 'Contacts', exact: true })).toBeVisible()
      for (const theme of ['light', 'dark']) {
        if (theme === 'dark') await page.getByRole('button', { name: 'Dark mode', exact: true }).click()
        const toggle = page.getByRole('button', { name: 'Navigation menu', exact: true })
        await toggle.click()
        const navigation = page.getByRole('navigation', {
          name: administrator ? 'Administration navigation' : 'Main navigation', exact: true,
        })
        for (const link of await navigation.getByRole('link').all()) {
          const icon = link.locator('svg.icon')
          await expect(icon).toHaveCount(1)
          await expect(icon).toHaveAttribute('viewBox', '0 0 24 24')
          await expect(icon).toHaveAttribute('aria-hidden', 'true')
          await expect(icon).toHaveAttribute('focusable', 'false')
          await expect(icon).toHaveCSS('stroke', await link.evaluate(element => getComputedStyle(element).color))
          expect(await link.textContent()).not.toMatch(/[\p{Extended_Pictographic}\u2190-\u2bff]/u)
        }
        await expect(navigation.getByRole('link', { name: administrator ? 'Community labels' : 'Contacts', exact: true })).toBeVisible()
        await page.screenshot({ path: testInfo.outputPath(`icons-${theme}.png`), animations: 'disabled' })
        await toggle.click()
      }
    })
  }
})

test('the language picker in the user menu switches the interface immediately and remembers the choice', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await mockSession(page)
  await page.goto('/')
  await expect(page.locator('html')).toHaveAttribute('lang', 'en')
  await page.getByRole('button', { name: 'User menu', exact: true }).click()
  await page.getByRole('combobox', { name: 'Language', exact: true }).selectOption('es')
  const spanish = page.getByRole('navigation', { name: 'Navegación principal', exact: true })
  await expect(spanish.getByRole('link', { name: 'Resumen', exact: true })).toBeVisible()
  await expect(spanish.getByRole('group', { name: 'Gastos', exact: true })).toBeVisible()
  await expect(page.locator('html')).toHaveAttribute('lang', 'es')
  await expect(page.getByRole('combobox', { name: 'Idioma', exact: true })).toHaveValue('es')
  await expect(page.getByRole('button', { name: 'Cerrar sesión', exact: true })).toBeVisible()
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
  await page.reload()
  await expect(page.getByRole('navigation', { name: 'Navegación principal', exact: true }).getByRole('link', { name: 'Movimientos', exact: true })).toBeVisible()
  await expect(page.locator('html')).toHaveAttribute('lang', 'es')
  await page.getByRole('button', { name: 'Menú de usuario', exact: true }).click()
  await page.getByRole('combobox', { name: 'Idioma', exact: true }).selectOption('en')
  await expect(page.getByRole('navigation', { name: 'Main navigation', exact: true }).getByRole('link', { name: 'Overview', exact: true })).toBeVisible()
  expect(await page.evaluate(() => localStorage.getItem('juntia_language'))).toBe('en')
})

test.describe('Spanish browser', () => {
  test.use({ locale: 'es-ES' })

  test('sign-in screens follow the browser language until the visitor picks another one', async ({ page }) => {
    const state = await mockSession(page)
    state.authenticated = false
    await page.goto('/login')
    await expect(page.getByRole('heading', { name: 'Iniciar sesión', exact: true })).toBeVisible()
    await expect(page.locator('html')).toHaveAttribute('lang', 'es')
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
    await page.getByRole('combobox', { name: 'Idioma', exact: true }).selectOption('en')
    await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible()
    await expect(page.getByRole('textbox', { name: 'Email', exact: true })).toBeVisible()
    await page.goto('/admin')
    await expect(page.getByRole('heading', { name: 'Administration', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Sign in to administration', exact: true })).toBeVisible()
    await expect(page.getByRole('combobox', { name: 'Language', exact: true })).toHaveValue('en')
    await page.setViewportSize({ width: 320, height: 640 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  })
})
