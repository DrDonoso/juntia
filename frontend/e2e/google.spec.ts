import { test, expect, type Page, type BrowserContext } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import type { UserOut } from '../src/api/schema.gen'

const password = 'synthetic google resident password'
const googleName = 'Synthetic Google Resident'

async function syntheticGoogle(context: BrowserContext, email: () => string, cancelled = () => false) {
  await context.route('https://accounts.google.com/**', async route => {
    const url = new URL(route.request().url())
    expect(url.pathname).toBe('/o/oauth2/v2/auth')
    expect(url.searchParams.get('scope')).toBe('openid email profile')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.has('nonce')).toBe(true)
    const callback = new URL(url.searchParams.get('redirect_uri') || '')
    callback.searchParams.set('state', url.searchParams.get('state') || '')
    if (cancelled()) callback.searchParams.set('error', 'access_denied')
    else callback.searchParams.set('code', `synthetic-code:${email()}`)
    await route.fulfill({ status: 302, headers: { Location: callback.toString() }, body: '' })
  })
}

async function invite(page: Page, label: string, email: string) {
  const headers = { Origin: new URL(page.url()).origin, 'X-Juntia-Request': '1' }
  const unit = await page.request.post('/api/admin/dwellings', {
    headers, data: { label, coefficient: '12.50' },
  })
  expect(unit.status()).toBe(201)
  const response = await page.request.post('/api/admin/users', {
    headers, data: { name: 'Google resident', email, dwelling_id: (await unit.json()).id },
  })
  expect(response.status()).toBe(201)
  const messages: { to: string; body: string }[] = await (await page.request.get('/api/admin/test-mailbox')).json()
  const link = messages.find(message => message.to === email)?.body.match(/https?:\/\/[^\s]+/)?.[0]
  if (!link) throw new Error('Synthetic invitation was not captured')
  return link
}

test('Google remains invitation-only and supports passwordless profiles and linking', async ({ page, browser }) => {
  test.skip(process.env.E2E_GOOGLE !== 'true' || Boolean(process.env.E2E_BASE_URL), 'Requires synthetic Google and SMTP')
  test.setTimeout(120_000)
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto('/admin')
  await expect(page.getByRole('button', { name: 'Continue with Google', exact: true })).toHaveCount(0)
  await page.getByLabel('Username', { exact: true }).fill('browser-test')
  await page.getByLabel('Password', { exact: true }).fill('synthetic-browser-test-password')
  await page.getByRole('button', { name: 'Sign in to administration', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Import statement', exact: true })).toBeVisible()
  const email = 'google-resident@example.org'
  const link = await invite(page, 'Google 1 A', email)
  const context = await browser.newContext({ baseURL: new URL(page.url()).origin })
  try {
    let googleEmail = 'uninvited@example.org', cancelled = false
    await syntheticGoogle(context, () => googleEmail, () => cancelled)
    const resident = await context.newPage()
    resident.on('pageerror', error => errors.push(error.message))
    await resident.goto('/login')
    await resident.getByRole('button', { name: 'Continue with Google', exact: true }).click()
    await expect(resident.getByRole('alert')).toContainText('has no linked access')
    expect((await resident.request.get('/api/summary')).status()).toBe(401)
    await resident.goto(link)
    await expect(resident.getByRole('button', { name: 'Save password', exact: true })).toBeVisible()
    await resident.getByRole('button', { name: 'Continue with Google', exact: true }).click()
    await expect(resident.getByRole('alert')).toContainText('open the invitation link in the email again')
    googleEmail = email
    await resident.goto(link)
    await resident.getByRole('button', { name: 'Continue with Google', exact: true }).click()
    await expect(resident.getByRole('heading', { name: 'Community finances', exact: true })).toBeVisible()
    expect((await resident.request.get('/api/admin/users')).status()).toBe(401)
    await resident.getByRole('button', { name: 'User menu', exact: true }).click()
    await resident.getByRole('link', { name: /My profile/ }).click()
    await expect(resident.getByLabel('Name', { exact: true })).toHaveValue(googleName)
    await expect(resident.getByRole('heading', { name: 'Local password', exact: true })).toBeVisible()
    await expect(resident.getByLabel('Current password', { exact: true })).toHaveCount(0)
    await expect(resident.getByText(`Google is linked to the email address ${email}.`, { exact: true })).toBeVisible()
    await expect(resident.getByRole('button', { name: 'Unlink Google', exact: true })).toHaveCount(0)
    expect((await new AxeBuilder({ page: resident }).analyze()).violations).toEqual([])
    await resident.screenshot({ path: 'test-results/google-profile.png', fullPage: true })
    await resident.getByRole('button', { name: 'Send link to create a password', exact: true }).click()
    await expect(resident.getByText(/If the email can be sent/)).toBeVisible()
    let recovery = ''
    await expect.poll(async () => {
      const messages: { to: string; body: string }[] = await (await page.request.get('/api/admin/test-mailbox')).json()
      recovery = messages.find(message => message.to === email && message.body.includes('/reset-password'))?.body.match(/https?:\/\/[^\s]+/)?.[0] || ''
      return Boolean(recovery)
    }).toBe(true)
    await resident.goto(recovery)
    await resident.getByLabel('New password', { exact: true }).fill(password)
    await resident.getByLabel('Repeat password', { exact: true }).fill(password)
    await resident.getByRole('button', { name: 'Save password', exact: true }).click()
    await expect(resident.getByRole('heading', { name: 'Password saved', exact: true })).toBeVisible()
    await resident.getByRole('link', { name: 'Back to sign in', exact: true }).click()
    await resident.getByLabel('Email', { exact: true }).fill(email)
    await resident.getByLabel('Password', { exact: true }).fill(password)
    await resident.getByRole('button', { name: 'Sign in', exact: true }).click()
    await expect(resident.getByRole('heading', { name: 'Community finances', exact: true })).toBeVisible()
    await resident.getByRole('button', { name: 'User menu', exact: true }).click()
    await resident.getByRole('link', { name: /My profile/ }).click()
    await resident.getByLabel('Password to unlink Google', { exact: true }).fill(password)
    await resident.getByRole('button', { name: 'Unlink Google', exact: true }).click()
    await expect(resident.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible()
    await expect(resident.getByText(/Google unlinked/)).toBeVisible()
    await resident.getByLabel('Email', { exact: true }).fill(email)
    await resident.getByLabel('Password', { exact: true }).fill(password)
    await resident.getByRole('button', { name: 'Sign in', exact: true }).click()
    await expect(resident.getByRole('heading', { name: 'My profile', exact: true })).toBeVisible()
    await resident.getByLabel('Password to link Google', { exact: true }).fill('incorrect')
    await resident.getByRole('button', { name: 'Link Google', exact: true }).click()
    await expect(resident.getByRole('alert')).toContainText('The current password is not correct')
    await resident.getByLabel('Password to link Google', { exact: true }).fill(password)
    await resident.getByRole('button', { name: 'Link Google', exact: true }).click()
    await expect(resident.getByText('Google linked. You can now sign in with Google or with your password.', { exact: true })).toBeVisible()
    await expect(resident.getByRole('heading', { name: 'Change password', exact: true })).toBeVisible()
    await resident.getByRole('button', { name: 'User menu', exact: true }).click()
    await resident.getByRole('button', { name: 'Sign out', exact: true }).click()
    await expect(resident.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible()
    cancelled = true
    await resident.getByRole('button', { name: 'Continue with Google', exact: true }).click()
    await expect(resident.getByRole('alert')).toContainText('You cancelled')
    cancelled = false
    await resident.goto('/login?next=%2Fneighbors')
    await resident.getByRole('button', { name: 'Continue with Google', exact: true }).click()
    await expect(resident.getByRole('heading', { name: 'Neighbors', exact: true })).toBeVisible()
    await page.getByRole('link', { name: 'Users', exact: true }).click()
    const accounts: UserOut[] = await (await page.request.get('/api/admin/users')).json()
    const oldAccount = accounts.find(account => account.email === email)
    if (!oldAccount) throw new Error('Synthetic Google account is missing')
    await page.getByRole('button', { name: `Delete user ${email}`, exact: true }).click()
    const deletion = page.getByRole('dialog', { name: 'Delete user', exact: true })
    await deletion.getByLabel('Type the email address to confirm', { exact: true }).fill(email)
    await deletion.getByRole('button', { name: 'Delete permanently', exact: true }).click()
    await expect(deletion).toHaveCount(0)
    expect((await resident.request.get('/api/summary')).status()).toBe(401)
    const headers = { Origin: new URL(page.url()).origin, 'X-Juntia-Request': '1' }
    const reinvitation = await page.request.post('/api/admin/users', {
      headers, data: { name: 'New Google account', email, dwelling_id: oldAccount.dwelling_id },
    })
    expect(reinvitation.status()).toBe(201)
    const newAccount: UserOut = await reinvitation.json()
    expect(newAccount.id).toBeGreaterThan(oldAccount.id)
    expect(newAccount.google_linked).toBe(false)
    await resident.goto('/login')
    await resident.getByRole('button', { name: 'Continue with Google', exact: true }).click()
    await expect(resident.getByRole('alert')).toContainText('has no linked access')
    const freshMessages: { to: string; body: string }[] = await (await page.request.get('/api/admin/test-mailbox')).json()
    const freshLink = freshMessages.toReversed().find(message => message.to === email && message.body.includes('/activate#token='))?.body.match(/https?:\/\/[^\s]+/)?.[0]
    if (!freshLink) throw new Error('New synthetic invitation is missing')
    await resident.goto(freshLink)
    await resident.getByRole('button', { name: 'Continue with Google', exact: true }).click()
    await expect(resident.getByRole('heading', { name: 'Community finances', exact: true })).toBeVisible()
    await resident.getByRole('button', { name: 'User menu', exact: true }).click()
    await resident.getByRole('link', { name: /My profile/ }).click()
    await expect(resident.getByLabel('Name', { exact: true })).toHaveValue(googleName)
    await expect(resident.locator('.profile-details')).toContainText('Google 1 A')
    expect(errors).toEqual([])
  } finally {
    await context.close()
  }
})
