import { expect, test } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'

test.afterEach(async ({ page }) => {
  if (process.env.E2E_BASE_URL || page.url() === 'about:blank') return
  const headers = { Origin: new URL(page.url()).origin, 'X-Juntia-Request': '1' }
  for (const feature of ['coefficient', 'actions']) {
    expect((await page.request.patch(`/api/admin/settings/features/${feature}`, { headers, data: { enabled: true } })).status()).toBe(200)
  }
  expect((await page.request.post('/api/admin/test-reset-login-attempts', { headers })).status()).toBe(204)
})

test('administrator switches update open resident pages and retain data without a reload', async ({ page, browser }) => {
  test.skip(Boolean(process.env.E2E_BASE_URL), 'Requires the disposable synthetic application')
  test.setTimeout(120_000)
  await page.goto('/admin/features')
  await page.getByLabel('Username', { exact: true }).fill('browser-test')
  await page.getByLabel('Password', { exact: true }).fill('synthetic-browser-test-password')
  await page.getByRole('button', { name: 'Sign in to administration' }).click()
  await expect(page.getByRole('heading', { name: 'Features', exact: true })).toBeVisible()
  const coefficient = page.getByRole('switch', { name: 'Ownership coefficients' })
  const actions = page.getByRole('switch', { name: 'Actions', exact: true })
  await expect(coefficient).toHaveAttribute('aria-checked', 'true')
  await expect(actions).toHaveAttribute('aria-checked', 'true')
  const origin = new URL(page.url()).origin
  const headers = { Origin: origin, 'X-Juntia-Request': '1' }
  const unitResponse = await page.request.post('/api/admin/dwellings', {
    headers, data: { label: 'Runtime flags 1 A', coefficient: '12.50' },
  })
  expect(unitResponse.status()).toBe(201)
  const unit = await unitResponse.json()
  const email = 'runtime-flags@example.org', password = 'synthetic runtime flag password'
  expect((await page.request.post('/api/admin/users', {
    headers, data: { name: 'Runtime flag resident', email, dwelling_id: unit.id },
  })).status()).toBe(201)
  const messages: { to: string; body: string }[] = await (await page.request.get('/api/admin/test-mailbox')).json()
  const token = messages.find(message => message.to === email)?.body.match(/#token=([a-f0-9]{64})/)?.[1]
  expect(token).toBeTruthy()
  const context = await browser.newContext({ baseURL: origin, locale: 'en-GB' })
  try {
    expect((await context.request.post('/api/auth/activate', { headers, data: { token, password } })).status()).toBe(204)
    expect((await context.request.post('/api/auth/login', { headers, data: { email, password } })).status()).toBe(200)
    const resident = await context.newPage()
    await resident.goto('/profile')
    await expect(resident.getByText(/12\.50\s*%/)).toBeVisible()
    await resident.getByLabel('Name', { exact: true }).fill('Unsaved resident draft')
    await coefficient.click()
    await expect(coefficient).toHaveAttribute('aria-checked', 'false')
    await expect(resident.locator('.profile-details')).not.toContainText('Ownership coefficient', { timeout: 10_000 })
    expect((await (await resident.request.get('/api/auth/profile')).json()).coefficient).toBeNull()
    await coefficient.click()
    await expect(coefficient).toHaveAttribute('aria-checked', 'true')
    await expect(resident.getByText(/12\.50\s*%/)).toBeVisible({ timeout: 10_000 })
    await expect(resident.getByLabel('Name', { exact: true })).toHaveValue('Unsaved resident draft')
    const created = await resident.request.post('/api/actions/items', {
      headers, data: { title: 'Retained runtime action' },
    })
    expect(created.status()).toBe(201)
    const item = await created.json()
    await resident.goto(`/actions/${item.id}`)
    await expect(resident.getByRole('heading', { name: item.title, exact: true })).toBeVisible()
    await actions.click()
    await expect(actions).toHaveAttribute('aria-checked', 'false')
    await expect(page.getByRole('navigation', { name: 'Administration navigation' }).getByRole('link', { name: 'Actions', exact: true })).toHaveCount(0)
    await expect(page.getByRole('navigation', { name: 'Administration navigation' }).getByRole('group', { name: 'Management', exact: true })).toHaveCount(0)
    await expect(resident.getByRole('navigation', { name: 'Main navigation' }).getByRole('group', { name: 'Management', exact: true })).toHaveCount(0)
    await expect(resident.getByRole('heading', { name: 'Actions turned off' })).toBeVisible({ timeout: 10_000 })
    expect((await resident.request.get(`/api/actions/items/${item.id}`)).status()).toBe(404)
    await actions.click()
    await expect(actions).toHaveAttribute('aria-checked', 'true')
    await expect(resident.getByRole('heading', { name: item.title, exact: true })).toBeVisible({ timeout: 10_000 })
    expect((await (await resident.request.get('/api/auth/session')).json()).authenticated).toBe(true)

    await coefficient.click()
    await expect(coefficient).toHaveAttribute('aria-checked', 'false')
    await actions.click()
    await expect(actions).toHaveAttribute('aria-checked', 'false')
    await page.reload()
    await expect(coefficient).toHaveAttribute('aria-checked', 'false')
    await expect(actions).toHaveAttribute('aria-checked', 'false')
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
    await page.screenshot({ path: 'test-results/feature-flags-desktop.png', fullPage: true })
    await page.setViewportSize({ width: 390, height: 844 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
    await page.screenshot({ path: 'test-results/feature-flags-mobile.png', fullPage: true })
    await coefficient.focus()
    await page.keyboard.press('Space')
    await expect(coefficient).toHaveAttribute('aria-checked', 'true')
  } finally {
    await context.close()
  }
})
