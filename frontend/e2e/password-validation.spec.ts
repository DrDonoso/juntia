import { test, expect, type Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'

async function expectPasswordError(page: Page, message: string, field: string) {
  const alert = page.getByRole('alert')
  await expect(alert).toHaveText(message)
  await expect(alert).toHaveClass('notice error')
  const input = page.getByLabel(field, { exact: true })
  await expect(input).toHaveAttribute('aria-invalid', 'true')
  await expect(input).toBeFocused()
  const errorId = await alert.getAttribute('id')
  expect(errorId).toBeTruthy()
  await expect(input).toHaveAttribute('aria-describedby', errorId!)
}

test('password forms use styled errors instead of native validation and accept ten characters', async ({ page, browser }) => {
  test.skip(Boolean(process.env.E2E_BASE_URL), 'Requires only the disposable server and synthetic mail')
  test.setTimeout(120_000)
  await page.goto('/admin')
  await page.getByLabel('Username', { exact: true }).fill('browser-test')
  await page.getByLabel('Password', { exact: true }).fill('synthetic-browser-test-password')
  await page.getByRole('button', { name: 'Sign in to administration', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Import statement', exact: true })).toBeVisible()
  const origin = new URL(page.url()).origin
  const headers = { Origin: origin, 'X-Juntia-Request': '1' }
  const unit = await page.request.post('/api/admin/dwellings', {
    headers, data: { label: 'Password 1 A', coefficient: '5.00' },
  })
  expect(unit.status()).toBe(201)
  const email = 'password-validation@example.org'
  expect((await page.request.post('/api/admin/users', {
    headers, data: { name: 'Test resident', email, dwelling_id: (await unit.json()).id },
  })).status()).toBe(201)
  const general = await (await page.request.get('/api/settings/general')).json()
  const messages: { to: string; body: string }[] = await (await page.request.get('/api/admin/test-mailbox')).json()
  const message = messages.find(item => item.to === email)
  expect(message?.body).toContain(`You have been invited to join ${general.community_name}. Activate your account with`)
  const invitation = message?.body.match(/https?:\/\/[^\s]+/)?.[0]
  if (!invitation) throw new Error('Synthetic invitation is missing')
  const context = await browser.newContext({ baseURL: origin, locale: 'en-US' })
  try {
    const resident = await context.newPage()
    let passwordWrites = 0
    resident.on('request', request => {
      if (request.method() === 'POST' && ['/api/auth/activate', '/api/auth/reset-password', '/api/auth/profile/password'].includes(new URL(request.url()).pathname)) passwordWrites++
    })
    await resident.goto(invitation)
    const password = resident.getByLabel('New password', { exact: true })
    const confirmation = resident.getByLabel('Repeat password', { exact: true })
    const save = resident.getByRole('button', { name: 'Save password', exact: true })
    await expect(resident.locator('form.password-form')).toHaveAttribute('novalidate', '')
    await expect(resident.locator('main')).toContainText('at least 10 characters')
    await expect(resident.locator('main')).not.toContainText(/15 characters|bytes|UTF-8/)
    await save.click()
    await expectPasswordError(resident, 'Enter a password.', 'New password')
    await password.fill('123456789')
    await confirmation.fill('123456789')
    await save.click()
    await expectPasswordError(resident, 'The password must have at least 10 characters.', 'New password')
    expect((await new AxeBuilder({ page: resident }).analyze()).violations).toEqual([])
    await resident.screenshot({ path: 'test-results/password-validation.png', fullPage: true })
    await password.fill('Secret1234')
    await confirmation.fill('')
    await save.click()
    await expectPasswordError(resident, 'Repeat the password.', 'Repeat password')
    await confirmation.fill('Different1')
    await save.click()
    await expectPasswordError(resident, 'The passwords do not match.', 'Repeat password')
    await password.fill('x'.repeat(73))
    await confirmation.fill('x'.repeat(73))
    await save.click()
    await expect(password).toHaveValue('x'.repeat(73))
    await expectPasswordError(resident, 'The password is too long. Use a shorter one.', 'New password')
    expect(passwordWrites).toBe(0)
    await password.fill('Secret1234')
    await confirmation.fill('Secret1234')
    await save.click()
    await expect(resident.getByRole('heading', { name: 'Password saved', exact: true })).toBeVisible()
    expect(passwordWrites).toBe(1)
    await resident.getByRole('link', { name: 'Back to sign in', exact: true }).click()
    await resident.getByLabel('Email', { exact: true }).fill(email)
    await resident.getByLabel('Password', { exact: true }).fill('Secret1234')
    await resident.getByRole('button', { name: 'Sign in', exact: true }).click()
    await expect(resident.getByRole('heading', { name: 'Community finances', exact: true })).toBeVisible()
    await resident.getByRole('button', { name: 'User menu', exact: true }).click()
    await resident.getByRole('link', { name: /My profile/ }).click()
    const update = resident.getByRole('button', { name: 'Update password', exact: true })
    await expect(resident.locator('.profile-password form')).toHaveAttribute('novalidate', '')
    await expect(resident.locator('.profile-password')).not.toContainText(/bytes|UTF-8/)
    await update.click()
    await expectPasswordError(resident, 'Enter your current password.', 'Current password')
    await resident.getByLabel('Current password', { exact: true }).fill('Secret1234')
    await password.fill('123456789')
    await resident.getByLabel('Repeat new password', { exact: true }).fill('123456789')
    await update.click()
    await expectPasswordError(resident, 'The password must have at least 10 characters.', 'New password')
    await password.fill('Update1234')
    await resident.getByLabel('Repeat new password', { exact: true }).fill('Update1234')
    await update.click()
    await expect(resident.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible()
    expect(passwordWrites).toBe(2)
    expect((await context.request.post('/api/auth/forgot-password', { headers, data: { email } })).status()).toBe(202)
    let recovery = ''
    await expect.poll(async () => {
      const mailbox: { to: string; body: string }[] = await (await page.request.get('/api/admin/test-mailbox')).json()
      recovery = mailbox.find(item => item.to === email && item.body.includes('/reset-password#token='))?.body.match(/https?:\/\/[^\s]+/)?.[0] || ''
      return Boolean(recovery)
    }).toBe(true)
    await resident.goto(recovery)
    await expect(resident.locator('form.password-form')).toHaveAttribute('novalidate', '')
    await save.click()
    await expectPasswordError(resident, 'Enter a password.', 'New password')
    await password.fill('Reset12345')
    await confirmation.fill('Reset12345')
    await save.click()
    await expect(resident.getByRole('heading', { name: 'Password saved', exact: true })).toBeVisible()
    expect(passwordWrites).toBe(3)
    expect((await context.request.post('/api/auth/login', { headers, data: { email, password: 'Reset12345' } })).status()).toBe(200)
  } finally {
    await context.close()
  }
})
