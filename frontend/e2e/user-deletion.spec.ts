import { test, expect } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import type { UserOut } from '../src/api/schema.gen'

test('deletion requires explicit email confirmation and permits a fresh invitation', async ({ page, browser }) => {
  test.skip(Boolean(process.env.E2E_BASE_URL), 'Uses only the disposable server and synthetic accounts')
  await page.goto('/admin')
  await page.getByLabel('Username', { exact: true }).fill('browser-test')
  await page.getByLabel('Password', { exact: true }).fill('synthetic-browser-test-password')
  await page.getByRole('button', { name: 'Sign in to administration', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Import statement', exact: true })).toBeVisible()
  const origin = new URL(page.url()).origin
  const headers = { Origin: origin, 'X-Juntia-Request': '1' }
  const unitResponse = await page.request.post('/api/admin/dwellings', {
    headers, data: { label: 'Deletion 1 A', coefficient: '5.25' },
  })
  expect(unitResponse.status()).toBe(201)
  const unit = await unitResponse.json()
  const email = 'deletion-resident@example.org'
  const userResponse = await page.request.post('/api/admin/users', {
    headers, data: { name: 'Test account', email, dwelling_id: unit.id },
  })
  expect(userResponse.status()).toBe(201)
  const original: UserOut = await userResponse.json()
  const neighbour = await page.request.post('/api/admin/users', {
    headers, data: { name: 'Remaining neighbor', email: 'deletion-neighbour@example.org', dwelling_id: unit.id },
  })
  expect(neighbour.status()).toBe(201)
  const messages: { to: string; body: string }[] = await (await page.request.get('/api/admin/test-mailbox')).json()
  const token = messages.find(message => message.to === email)?.body.match(/#token=([a-f0-9]{64})/)?.[1]
  if (!token) throw new Error('Synthetic invitation is missing')
  const context = await browser.newContext({ baseURL: origin })
  try {
    const resident = await context.newPage()
    const password = 'synthetic deletion test password'
    expect((await context.request.post('/api/auth/activate', { headers, data: { token, password } })).status()).toBe(204)
    expect((await context.request.post('/api/auth/login', { headers, data: { email, password } })).status()).toBe(200)
    await resident.goto('/neighbors')
    await expect(resident.getByRole('heading', { name: 'Test account', exact: true })).toBeVisible()
    await page.getByRole('link', { name: 'Users', exact: true }).click()
    const row = page.getByRole('row').filter({ hasText: email })
    await row.getByRole('button', { name: `Delete user ${email}`, exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Delete user', exact: true })
    const confirm = dialog.getByRole('button', { name: 'Delete permanently', exact: true })
    await expect(dialog).toContainText('cannot be undone')
    await expect(dialog).toContainText('The dwelling')
    await expect(confirm).toBeDisabled()
    await dialog.getByLabel('Type the email address to confirm', { exact: true }).fill('wrong@example.org')
    await expect(confirm).toBeDisabled()
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await expect(row).toBeVisible()
    await row.getByRole('button', { name: `Delete user ${email}`, exact: true }).click()
    await dialog.getByLabel('Type the email address to confirm', { exact: true }).fill(email.toUpperCase())
    await expect(confirm).toBeEnabled()
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
    await page.screenshot({ path: 'test-results/delete-user-confirmation.png', fullPage: true })
    const before = await (await page.request.get('/api/summary')).json()
    const deleting = page.waitForResponse(response => response.request().method() === 'DELETE' && response.url().endsWith(`/api/admin/users/${original.id}`))
    await confirm.click()
    expect((await deleting).status()).toBe(204)
    await expect(dialog).toHaveCount(0)
    await expect(row).toHaveCount(0)
    await expect(page.getByText('User deleted. You can now invite the same email address again.', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Invite user', exact: true })).toBeFocused()
    expect(await (await page.request.get('/api/summary')).json()).toEqual(before)
    expect((await context.request.get('/api/summary')).status()).toBe(401)
    await resident.reload()
    await expect(resident.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible()
    const dwellings = await (await page.request.get('/api/admin/dwellings')).json()
    expect(dwellings.find((item: { id: number }) => item.id === unit.id)).toMatchObject({ label: 'Deletion 1 A', coefficient: '5.25', user_count: 1 })
    await expect(page.getByRole('row').filter({ hasText: 'deletion-neighbour@example.org' })).toBeVisible()
    await page.getByRole('button', { name: 'Invite user', exact: true }).click()
    const invitation = page.getByRole('dialog', { name: 'Invite user', exact: true })
    await invitation.getByLabel('Name', { exact: true }).fill('New test account')
    await invitation.getByLabel('Email', { exact: true }).fill(email)
    await invitation.getByRole('combobox', { name: 'Dwelling', exact: true }).selectOption({ label: 'Deletion 1 A' })
    await invitation.getByRole('button', { name: 'Send invitation', exact: true }).click()
    await expect(invitation).toHaveCount(0)
    await expect(row).toContainText('Pending activation')
    await expect(row).toContainText('Never')
    const accounts: UserOut[] = await (await page.request.get('/api/admin/users')).json()
    expect(accounts.find(account => account.email === email)?.id).toBeGreaterThan(original.id)
  } finally {
    await context.close()
  }
})
