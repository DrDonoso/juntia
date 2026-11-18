import { expect, test, type Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import type { UserOut } from '../src/api/schema.gen'
import { administrator, signInAsAdministrator, writeHeaders } from './support'

const password = 'synthetic administrators browser password'

/** A neighbor with a dwelling of their own, invited and activated through the API. */
async function neighbor(admin: Page, email: string, name: string): Promise<UserOut> {
  const headers = writeHeaders(admin)
  const dwelling = await admin.request.post('/api/admin/dwellings', { headers, data: { label: `${name} home`, coefficient: '1.00' } })
  expect(dwelling.status()).toBe(201)
  const invited = await admin.request.post('/api/admin/users', { headers, data: { name, email, dwelling_id: (await dwelling.json()).id } })
  expect(invited.status()).toBe(201)
  let token = ''
  await expect.poll(async () => {
    const messages: { to: string; body: string }[] = await (await admin.request.get('/api/admin/test-mailbox')).json()
    token = messages.toReversed().find(message => message.to === email)?.body.match(/#token=([a-f0-9]{64})/)?.[1] || ''
    return token
  }).not.toBe('')
  expect((await admin.request.post('/api/auth/activate', { headers, data: { token, password } })).status()).toBe(204)
  return invited.json()
}

async function signIn(page: Page, email: string) {
  await page.goto('/login')
  await page.getByLabel('Email', { exact: true }).fill(email)
  await page.getByLabel('Password', { exact: true }).fill(password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Community finances', exact: true })).toBeVisible()
}

async function openUserMenu(page: Page) {
  await page.getByRole('button', { name: 'User menu' }).click()
  return page.getByRole('navigation', { name: 'User options', exact: true })
}

test('the user menu opens the administration for administrators only', async ({ page, browser }) => {
  test.skip(Boolean(process.env.E2E_BASE_URL), 'Requires the disposable server and synthetic mailbox')
  test.setTimeout(120_000)
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await signInAsAdministrator(page, '/')
  await expect(page.getByRole('heading', { name: 'Community finances', exact: true })).toBeVisible()
  let menu = await openUserMenu(page)
  await expect(menu.getByRole('link')).toHaveText(['Administration', 'My profile'])
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
  await menu.getByRole('link', { name: 'Administration', exact: true }).click()
  await expect(page).toHaveURL(/\/admin$/)
  await expect(page.getByRole('heading', { name: 'Import statement', exact: true })).toBeVisible()
  menu = await openUserMenu(page)
  await expect(menu.getByRole('link')).toHaveText(['Community portal', 'My profile'])
  await menu.getByRole('link', { name: 'Community portal', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Community finances', exact: true })).toBeVisible()

  const email = 'menu-neighbor@example.org'
  await neighbor(page, email, 'Menu Neighbor')
  const context = await browser.newContext({ baseURL: new URL(page.url()).origin })
  try {
    const resident = await context.newPage()
    resident.on('pageerror', error => errors.push(error.message))
    await signIn(resident, email)
    await expect((await openUserMenu(resident)).getByRole('link')).toHaveText(['My profile'])
    expect((await new AxeBuilder({ page: resident }).analyze()).violations).toEqual([])
    await resident.goto('/admin/users')
    await expect(resident.getByText('Page not found.', { exact: true })).toBeVisible()
    await expect(resident.getByRole('navigation', { name: 'Administration navigation' })).toHaveCount(0)
    expect((await resident.request.get('/api/admin/users')).status()).toBe(403)
  } finally {
    await context.close()
  }
  expect(errors).toEqual([])
})

test('administrators grant and revoke the role of others, never their own', async ({ page, browser }) => {
  test.skip(Boolean(process.env.E2E_BASE_URL), 'Requires the disposable server and synthetic mailbox')
  test.setTimeout(120_000)
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await signInAsAdministrator(page, '/admin/users')
  const users = page.getByRole('table', { name: 'Community users' })
  const own = users.getByRole('row').filter({ hasText: administrator.email })
  await expect(own).toContainText('Administrator')
  await expect(own).toContainText('No dwelling')
  await expect(own.getByRole('button', { name: `Deactivate user ${administrator.email}`, exact: true })).toHaveCount(0)
  await expect(own.getByRole('button', { name: `Delete user ${administrator.email}`, exact: true })).toHaveCount(0)
  await own.getByRole('button', { name: `Edit user ${administrator.email}`, exact: true }).click()
  const form = page.getByRole('dialog', { name: 'Edit user' })
  await expect(form.getByRole('checkbox', { name: 'Administrator', exact: true })).toBeDisabled()
  await expect(form.getByLabel('Email', { exact: true })).toBeDisabled()
  await expect(form).toContainText('You cannot change your own role or email address: ask another administrator.')
  await form.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(form).toHaveCount(0)

  const email = 'role-neighbor@example.org'
  await neighbor(page, email, 'Role Neighbor')
  await page.reload()
  const row = users.getByRole('row').filter({ hasText: email })
  const context = await browser.newContext({ baseURL: new URL(page.url()).origin })
  try {
    const resident = await context.newPage()
    resident.on('pageerror', error => errors.push(error.message))
    await signIn(resident, email)
    await row.getByRole('button', { name: `Edit user ${email}`, exact: true }).click()
    await form.getByRole('checkbox', { name: 'Administrator', exact: true }).check()
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
    await form.getByRole('button', { name: 'Save user', exact: true }).click()
    await expect(form).toHaveCount(0)
    await expect(row).toContainText('Administrator')
    // The role applies at once, in the session the neighbor already had.
    await resident.reload()
    await (await openUserMenu(resident)).getByRole('link', { name: 'Administration', exact: true }).click()
    await expect(resident.getByRole('heading', { name: 'Import statement', exact: true })).toBeVisible()

    await row.getByRole('button', { name: `Edit user ${email}`, exact: true }).click()
    await form.getByRole('checkbox', { name: 'Administrator', exact: true }).uncheck()
    await form.getByRole('button', { name: 'Save user', exact: true }).click()
    await expect(form).toHaveCount(0)
    await expect(row.getByText('Administrator', { exact: true })).toHaveCount(0)
    // The next request of the open administration is refused, and the page closes.
    await resident.getByRole('navigation', { name: 'Administration navigation' }).getByRole('link', { name: 'Users', exact: true }).click()
    await expect(resident.getByText('Page not found.', { exact: true })).toBeVisible()
    await expect((await openUserMenu(resident)).getByRole('link')).toHaveText(['My profile'])
  } finally {
    await context.close()
  }

  await page.getByRole('button', { name: 'Invite user', exact: true }).click()
  const invitation = page.getByRole('dialog', { name: 'Invite user' })
  await invitation.getByLabel('Name', { exact: true }).fill('Second Administrator')
  await invitation.getByLabel('Email', { exact: true }).fill('second-administrator@example.org')
  await expect(invitation.getByRole('button', { name: 'Send invitation', exact: true })).toBeDisabled()
  await invitation.getByRole('checkbox', { name: 'Administrator', exact: true }).check()
  await expect(invitation.getByRole('combobox', { name: 'Dwelling', exact: true })).toHaveValue('')
  await invitation.getByRole('button', { name: 'Send invitation', exact: true }).click()
  await expect(invitation).toHaveCount(0)
  const second = users.getByRole('row').filter({ hasText: 'second-administrator@example.org' })
  await expect(second).toContainText('Administrator')
  await expect(second).toContainText('No dwelling')
  await expect(second).toContainText('Pending activation')
  expect(errors).toEqual([])
})
