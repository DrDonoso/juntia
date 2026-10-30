import { test, expect } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'

test.afterEach(async ({ page }) => {
  if (process.env.E2E_BASE_URL || page.url() === 'about:blank') return
  const headers = { Origin: new URL(page.url()).origin, 'X-Juntia-Request': '1' }
  expect((await page.request.patch('/api/admin/settings/features/actions', { headers, data: { enabled: true } })).status()).toBe(200)
  expect((await page.request.post('/api/admin/test-reset-login-attempts', { headers })).status()).toBe(204)
})

test('disabled actions hide navigation and block direct pages and APIs for both account types', async ({ page, browser }) => {
  test.skip(Boolean(process.env.E2E_BASE_URL), 'Requires the disposable synthetic application')
  await page.goto('/admin/features')
  await page.getByLabel('Username', { exact: true }).fill('browser-test')
  await page.getByLabel('Password', { exact: true }).fill('synthetic-browser-test-password')
  await page.getByRole('button', { name: 'Sign in to administration' }).click()
  const toggle = page.getByRole('switch', { name: 'Actions', exact: true })
  await expect(toggle).toHaveAttribute('aria-checked', 'true')
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-checked', 'false')
  expect(await (await page.request.get('/api/features')).json()).toEqual({
    actions: false, coefficient: true, google_login: false, events: false,
  })
  await page.goto('/admin/actions')
  await expect(page.getByRole('heading', { name: 'Actions turned off' })).toBeVisible()
  await expect(page.getByRole('navigation').getByRole('link', { name: 'Actions', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'New action' })).toHaveCount(0)
  const origin = new URL(page.url()).origin
  const headers = { Origin: origin, 'X-Juntia-Request': '1' }
  expect((await page.request.get('/api/actions/items')).status()).toBe(404)
  expect((await page.request.post('/api/actions/items', { headers, data: { title: 'Rejected' } })).status()).toBe(404)
  await page.goto('/admin/actions/1')
  await expect(page.getByRole('heading', { name: 'Actions turned off' })).toBeVisible()
  const unit = await page.request.post('/api/admin/dwellings', {
    headers, data: { label: 'Actions flag 1 A', coefficient: '12.50' },
  })
  expect(unit.status()).toBe(201)
  const email = 'actions-disabled@example.org'
  expect((await page.request.post('/api/admin/users', {
    headers, data: { name: 'Flag resident', email, dwelling_id: (await unit.json()).id },
  })).status()).toBe(201)
  const messages: { to: string; body: string }[] = await (await page.request.get('/api/admin/test-mailbox')).json()
  const token = messages.find(message => message.to === email)?.body.match(/#token=([a-f0-9]{64})/)?.[1]
  expect(token).toBeTruthy()
  const context = await browser.newContext({ baseURL: origin, locale: 'en-GB' })
  try {
    const password = 'synthetic disabled actions password'
    expect((await context.request.post('/api/auth/activate', { headers, data: { token, password } })).status()).toBe(204)
    expect((await context.request.post('/api/auth/login', { headers, data: { email, password } })).status()).toBe(200)
    const resident = await context.newPage()
    for (const path of ['/actions', '/actions/1']) {
      await resident.goto(path)
      await expect(resident.getByRole('heading', { name: 'Actions turned off' })).toBeVisible()
      await expect(resident.getByRole('navigation').getByRole('link', { name: 'Actions', exact: true })).toHaveCount(0)
      await expect(resident.getByLabel('New comment')).toHaveCount(0)
    }
    expect((await resident.request.get('/api/actions/items/1/history')).status()).toBe(404)
    expect((await resident.request.get('/api/summary')).status()).toBe(200)
    expect((await resident.request.get('/api/admin/users')).status()).toBe(401)
    expect((await new AxeBuilder({ page: resident }).analyze()).violations).toEqual([])
    await resident.getByRole('link', { name: 'Neighbors', exact: true }).click()
    await expect(resident.getByRole('heading', { name: 'Neighbors', exact: true })).toBeVisible()
  } finally {
    await context.close()
  }
})
