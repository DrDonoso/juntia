import { test, expect, type Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'

const password = 'synthetic resident browser password'

async function latestLink(page: Page, email: string, purpose: 'activate' | 'reset-password') {
  let body = ''
  await expect.poll(async () => {
    const response = await page.request.get('/api/admin/test-mailbox')
    expect(response.status()).toBe(200)
    const messages: { to: string; body: string }[] = await response.json()
    body = messages.toReversed().find(item => item.to === email && item.body.includes(`/${purpose}#token=`))?.body || ''
    return Boolean(body)
  }).toBe(true)
  const link = body.match(/https?:\/\/[^\s]+/)?.[0]
  if (!link) throw new Error('Synthetic message has no account link')
  expect(new URL(link).origin).toBe(new URL(page.url()).origin)
  return link
}

async function invite(page: Page, email: string, name: string) {
  await page.getByRole('button', { name: 'Invite user', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Invite user' })
  await dialog.getByLabel('Name', { exact: true }).fill(name)
  await dialog.getByLabel('Email', { exact: true }).fill(email)
  await dialog.getByRole('combobox', { name: 'Dwelling', exact: true }).selectOption({ label: 'E2E 1 A' })
  await expect(dialog.getByText(/Dwelling ownership coefficient/)).toContainText('1.23')
  await dialog.getByRole('button', { name: 'Send invitation', exact: true }).click()
  await expect(dialog).toHaveCount(0)
}

async function setPassword(page: Page, value = password) {
  await page.getByLabel('New password', { exact: true }).fill(value)
  await page.getByLabel('Repeat password', { exact: true }).fill(value)
  await page.getByRole('button', { name: 'Save password', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Password saved' })).toBeVisible()
}

async function login(page: Page, email: string, value = password, destination: 'overview' | 'profile' | 'neighbors' = 'overview') {
  await page.getByLabel('Email', { exact: true }).fill(email)
  await page.getByLabel('Password', { exact: true }).fill(value)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  const heading = { overview: 'Community finances', profile: 'My profile', neighbors: 'Neighbors' }[destination]
  await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible()
}

test('invitation-only users, shared dwellings, email changes, revocation and recovery', async ({ page, browser }) => {
  test.skip(Boolean(process.env.E2E_BASE_URL), 'Requires the disposable server with synthetic SMTP capture')
  test.setTimeout(120_000)
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto('/login?next=https://attacker.example/')
  await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible()
  await expect(page.getByRole('navigation', { name: 'Main navigation' })).toHaveCount(0)
  expect((await page.request.get('/api/summary')).status()).toBe(401)
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
  await page.screenshot({ path: 'test-results/resident-login.png', fullPage: true })
  await page.goto('/admin')
  await page.getByLabel('Username', { exact: true }).fill('browser-test')
  await page.getByLabel('Password', { exact: true }).fill('synthetic-browser-test-password')
  await page.getByRole('button', { name: 'Sign in to administration' }).click()
  await page.getByRole('link', { name: 'Users', exact: true }).click()
  const existingDwellings = await (await page.request.get('/api/admin/dwellings')).json()
  if (existingDwellings.length === 0) {
    await expect(page.getByRole('button', { name: 'Invite user', exact: true })).toBeDisabled()
    await page.getByRole('link', { name: 'create a dwelling', exact: true }).click()
  } else {
    await expect(page.getByRole('button', { name: 'Invite user', exact: true })).toBeEnabled()
    await page.getByRole('link', { name: 'Dwellings', exact: true }).click()
  }
  await page.getByRole('button', { name: 'Create dwelling', exact: true }).click()
  const unit = page.getByRole('dialog', { name: 'Create dwelling' })
  await unit.getByLabel('Dwelling name', { exact: true }).fill('E2E 1 A')
  await expect(unit.getByLabel('Ownership coefficient (%)', { exact: true })).toHaveAttribute('step', '0.01')
  await unit.getByLabel('Ownership coefficient (%)', { exact: true }).fill('1.23')
  await unit.getByRole('button', { name: 'Save dwelling', exact: true }).click()
  await expect(unit).toHaveCount(0)
  await page.getByRole('link', { name: 'Users', exact: true }).click()
  const email = 'resident-e2e@example.org'
  await invite(page, email, 'Test resident')
  const invitation = await latestLink(page, email, 'activate')
  await invite(page, 'second-e2e@example.org', 'Second account')
  const firstRow = page.getByRole('row').filter({ hasText: email })
  await expect(firstRow).toContainText('Never')
  await expect(firstRow).toContainText('Pending activation')
  await page.getByRole('link', { name: 'Dwellings', exact: true }).click()
  const residentDwelling = page.getByRole('row').filter({ has: page.getByRole('cell', { name: 'E2E 1 A', exact: true }) })
  await expect(residentDwelling.getByRole('link', { name: '2 accounts', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Edit dwelling E2E 1 A', exact: true }).click()
  const editUnit = page.getByRole('dialog', { name: 'Edit dwelling' })
  await editUnit.getByLabel('Ownership coefficient (%)', { exact: true }).fill('2.35')
  await editUnit.getByRole('button', { name: 'Save dwelling', exact: true }).click()
  await expect(editUnit).toHaveCount(0)
  await residentDwelling.getByRole('link', { name: '2 accounts', exact: true }).click()
  await expect(page.getByRole('table').getByText(/2\.35/)).toHaveCount(2)
  const usersTable = page.getByRole('table', { name: 'Community users' })
  const userNames = usersTable.locator('tbody tr td:first-child strong')
  await expect(userNames).toHaveText(['Second account', 'Test resident'])
  const nameSort = usersTable.getByRole('button', { name: 'Sort by user' })
  await nameSort.click()
  await expect(userNames).toHaveText(['Test resident', 'Second account'])
  await expect(usersTable.getByRole('columnheader', { name: 'User', exact: true })).toHaveAttribute('aria-sort', 'descending')
  await nameSort.press('Enter')
  await expect(userNames).toHaveText(['Second account', 'Test resident'])
  await expect(usersTable.getByRole('columnheader', { name: 'User', exact: true })).toHaveAttribute('aria-sort', 'ascending')
  expect(new URL(page.url()).searchParams.get('dwelling')).not.toBeNull()

  const context = await browser.newContext({ baseURL: new URL(page.url()).origin })
  try {
    const resident = await context.newPage()
    resident.on('pageerror', error => errors.push(error.message))
    await resident.goto(invitation)
    await expect(resident).not.toHaveURL(/#token=/)
    await expect(resident.getByRole('heading', { name: 'Activate your account' })).toBeVisible()
    expect((await new AxeBuilder({ page: resident }).analyze()).violations).toEqual([])
    await setPassword(resident)
    await resident.getByRole('link', { name: 'Back to sign in', exact: true }).click()
    await login(resident, email)
    expect((await resident.request.get('/api/admin/users')).status()).toBe(401)
    expect((await resident.request.get('/api/admin/test-mailbox')).status()).toBe(401)
    await expect(resident.locator('nav a[href^="/admin"]')).toHaveCount(0)
    await page.reload()
    await expect(firstRow).toContainText('Active')
    await expect(firstRow.getByText('Never', { exact: true })).toHaveCount(0)
    await expect(firstRow.locator('time')).toHaveAttribute('datetime', /\d{4}-\d{2}-\d{2}T/)
    await usersTable.getByRole('button', { name: 'Sort by last sign-in' }).click()
    await expect(userNames).toHaveText(['Test resident', 'Second account'])
    await expect(usersTable.getByRole('columnheader', { name: 'Last sign-in' })).toHaveAttribute('aria-sort', 'descending')
    await page.reload()
    await expect(userNames).toHaveText(['Test resident', 'Second account'])
    await expect(usersTable.getByRole('columnheader', { name: 'Last sign-in' })).toHaveAttribute('aria-sort', 'descending')
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
    await page.screenshot({ path: 'test-results/users-desktop.png', fullPage: true })

    await firstRow.getByRole('button', { name: `Edit user ${email}`, exact: true }).click()
    const edit = page.getByRole('dialog', { name: 'Edit user' })
    const changedEmail = 'changed-e2e@example.org'
    await edit.getByLabel('Email', { exact: true }).fill(changedEmail)
    await expect(edit.getByText(/Changing the email/)).toBeVisible()
    await edit.getByRole('button', { name: 'Save user', exact: true }).click()
    await expect(edit).toHaveCount(0)
    await resident.getByRole('link', { name: 'Transactions', exact: true }).click()
    await expect(resident.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible()
    await resident.goto(await latestLink(page, changedEmail, 'activate'))
    await setPassword(resident)
    await resident.getByRole('link', { name: 'Back to sign in', exact: true }).click()
    await login(resident, changedEmail)

    await page.reload()
    const changedRow = page.getByRole('row').filter({ hasText: changedEmail })
    await changedRow.getByRole('button', { name: `Deactivate user ${changedEmail}`, exact: true }).click()
    await page.getByRole('button', { name: 'Confirm deactivation', exact: true }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(changedRow).toContainText('Deactivated')
    await resident.getByRole('link', { name: 'Transactions', exact: true }).click()
    await expect(resident.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible()
    await changedRow.getByRole('button', { name: `Reactivate user ${changedEmail}`, exact: true }).click()
    await page.getByRole('button', { name: 'Confirm reactivation', exact: true }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await resident.goto('/login')
    await login(resident, changedEmail)

    await resident.getByRole('button', { name: 'User menu', exact: true }).click()
    await resident.getByRole('button', { name: 'Sign out', exact: true }).click()
    await expect(resident.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible()
    await resident.getByRole('link', { name: 'Forgot your password?', exact: true }).click()
    await expect(resident.getByRole('heading', { name: 'Recover your password', exact: true })).toBeVisible()
    await resident.getByLabel('Email', { exact: true }).fill(changedEmail)
    await resident.getByRole('button', { name: 'Send recovery link', exact: true }).click()
    await expect(resident.getByText(/If an active account uses that email address/)).toBeVisible()
    const recovery = await latestLink(page, changedEmail, 'reset-password')
    await resident.goto(recovery)
    const newPassword = 'another synthetic browser password'
    await setPassword(resident, newPassword)
    await resident.getByRole('link', { name: 'Back to sign in', exact: true }).click()
    await login(resident, changedEmail, newPassword)
    await resident.goto(recovery)
    await resident.getByLabel('New password', { exact: true }).fill(newPassword)
    await resident.getByLabel('Repeat password', { exact: true }).fill(newPassword)
    await resident.getByRole('button', { name: 'Save password', exact: true }).click()
    await expect(resident.getByRole('alert')).toContainText('has already been used')

    await page.setViewportSize({ width: 390, height: 844 })
    await page.reload()
    await expect(changedRow).toContainText('Active')
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
    await page.screenshot({ path: 'test-results/users-mobile.png', fullPage: true })
    expect(errors).toEqual([])
  } finally {
    await context.close()
  }
})

test('header profile menu, editable name, password change and all-device logout', async ({ page, browser }) => {
  test.skip(Boolean(process.env.E2E_BASE_URL), 'Requires the disposable server with synthetic SMTP capture')
  test.setTimeout(120_000)
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto('/admin')
  await page.getByLabel('Username', { exact: true }).fill('browser-test')
  await page.getByLabel('Password', { exact: true }).fill('synthetic-browser-test-password')
  await page.getByRole('button', { name: 'Sign in to administration' }).click()
  await expect(page.getByRole('heading', { name: 'Import statement', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'User menu', exact: true }).click()
  await page.getByRole('link', { name: /My profile/ }).click()
  await expect(page.getByRole('heading', { name: 'My profile', exact: true })).toBeVisible()
  await expect(page.locator('.technical-profile')).toContainText('Technical administrator')
  await expect(page.getByLabel('Current password', { exact: true })).toHaveCount(0)
  const origin = new URL(page.url()).origin
  const headers = { Origin: origin, 'X-Juntia-Request': '1' }
  const unitResponse = await page.request.post('/api/admin/dwellings', {
    headers, data: { label: 'Profile 1 A', coefficient: '12.50' },
  })
  expect(unitResponse.status()).toBe(201)
  const unit = await unitResponse.json()
  const email = 'profile-resident@example.org'
  const invited = await page.request.post('/api/admin/users', {
    headers, data: { name: 'Profile resident', email, dwelling_id: unit.id },
  })
  expect(invited.status()).toBe(201)
  const context = await browser.newContext({ baseURL: origin })
  const otherDevice = await browser.newContext({ baseURL: origin })
  try {
    const resident = await context.newPage()
    resident.on('pageerror', error => errors.push(error.message))
    await resident.goto(await latestLink(page, email, 'activate'))
    await setPassword(resident)
    await resident.getByRole('link', { name: 'Back to sign in', exact: true }).click()
    await login(resident, email)
    expect((await otherDevice.request.post('/api/auth/login', {
      headers, data: { email, password },
    })).status()).toBe(200)
    await expect(resident.locator('.sidebar-profile')).toHaveCount(0)
    await resident.getByRole('button', { name: 'User menu', exact: true }).click()
    await resident.getByRole('link', { name: /My profile/ }).click()
    await expect(resident.getByRole('heading', { name: 'My profile', exact: true })).toBeVisible()
    await expect(resident.locator('.profile-details')).toContainText(email)
    await expect(resident.locator('.profile-details')).toContainText('Profile 1 A')
    await expect(resident.locator('.profile-details')).toContainText('12.50%')
    await expect(resident.getByRole('textbox', { name: 'Email', exact: true })).toHaveCount(0)
    await expect(resident.getByRole('button', { name: /^(Show|Hide) amounts$/ })).toHaveCount(0)
    await resident.getByLabel('Name', { exact: true }).fill('Lucy Fields')
    await resident.getByLabel('Contact phone', { exact: true }).fill('+44 (20) 7946-0101')
    await resident.getByRole('button', { name: 'Save details', exact: true }).click()
    await expect(resident.getByText('Contact details updated.', { exact: true })).toBeVisible()
    await expect(resident.locator('.profile-button .profile-avatar')).toHaveText('LF')
    expect((await new AxeBuilder({ page: resident }).analyze()).violations).toEqual([])
    await resident.screenshot({ path: 'test-results/profile-desktop.png', fullPage: true })
    await resident.reload()
    await expect(resident.getByLabel('Name', { exact: true })).toHaveValue('Lucy Fields')
    await expect(resident.getByLabel('Contact phone', { exact: true })).toHaveValue('+442079460101')

    const newPassword = 'updated synthetic profile password'
    await resident.getByLabel('Current password', { exact: true }).fill('incorrect')
    await resident.getByLabel('New password', { exact: true }).fill(newPassword)
    await resident.getByLabel('Repeat new password', { exact: true }).fill(newPassword)
    await resident.getByRole('button', { name: 'Update password', exact: true }).click()
    await expect(resident.getByRole('alert')).toContainText('The current password is not correct')
    await expect(resident.getByRole('heading', { name: 'My profile', exact: true })).toBeVisible()
    await resident.getByLabel('Current password', { exact: true }).fill(password)
    await resident.getByRole('button', { name: 'Update password', exact: true }).click()
    await expect(resident.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible()
    await expect(resident.getByText(/Password updated/)).toBeVisible()
    expect((await otherDevice.request.get('/api/summary')).status()).toBe(401)
    await login(resident, email, newPassword, 'profile')
    expect((await otherDevice.request.post('/api/auth/login', {
      headers, data: { email, password: newPassword },
    })).status()).toBe(200)
    await resident.getByRole('button', { name: 'User menu', exact: true }).click()
    await resident.getByRole('link', { name: /My profile/ }).click()
    await expect(resident.getByRole('heading', { name: 'My profile', exact: true })).toBeVisible()
    await resident.setViewportSize({ width: 390, height: 844 })
    expect(await resident.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    expect((await new AxeBuilder({ page: resident }).analyze()).violations).toEqual([])
    await resident.screenshot({ path: 'test-results/profile-mobile.png', fullPage: true })
    await resident.getByRole('button', { name: 'Sign out of all my sessions', exact: true }).click()
    await expect(resident.getByRole('dialog', { name: 'Sign out of all sessions', exact: true })).toBeVisible()
    await resident.getByRole('button', { name: 'Confirm sign-out', exact: true }).click()
    await expect(resident.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible()
    await expect(resident.getByText('Your sessions have been closed on every device.', { exact: true })).toBeVisible()
    expect((await otherDevice.request.get('/api/auth/profile')).status()).toBe(401)
    await expect(resident.getByRole('button', { name: 'User menu', exact: true })).toHaveCount(0)
    await login(resident, email, newPassword, 'profile')
    expect(errors).toEqual([])
  } finally {
    await context.close()
    await otherDevice.close()
  }
})

test('neighbors directory groups contact phones by naturally ordered dwelling', async ({ page, browser }) => {
  test.skip(Boolean(process.env.E2E_BASE_URL), 'Requires the disposable server with synthetic SMTP capture')
  test.setTimeout(120_000)
  await page.goto('/admin')
  await page.getByLabel('Username', { exact: true }).fill('browser-test')
  await page.getByLabel('Password', { exact: true }).fill('synthetic-browser-test-password')
  await page.getByRole('button', { name: 'Sign in to administration' }).click()
  const adminNavigation = page.getByRole('navigation', { name: 'Administration navigation' })
  await expect(adminNavigation.getByRole('group', { name: 'Finances', exact: true }).getByRole('link')).toHaveCount(5)
  await expect(adminNavigation.getByRole('group', { name: 'Settings', exact: true }).getByRole('link')).toHaveCount(7)
  await expect(adminNavigation.getByRole('link', { name: 'Storage', exact: true })).toHaveAttribute('href', '/admin/storage')
  await expect(adminNavigation.getByRole('group', { name: 'Management', exact: true })).toHaveCount(0)
  await expect(adminNavigation.getByRole('link', { name: 'Community labels', exact: true })).toHaveAttribute('href', '/admin/labels')
  for (const name of ['Actions', 'Neighbors', 'Contacts']) await expect(adminNavigation.getByRole('link', { name, exact: true })).toHaveCount(0)
  await page.goto('/admin/neighbors')
  await expect(page).toHaveURL(/\/neighbors$/)
  await expect(page.getByRole('heading', { name: 'Neighbors', exact: true })).toBeVisible()
  await expect(adminNavigation).toHaveCount(0)
  await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible()
  const origin = new URL(page.url()).origin
  const headers = { Origin: origin, 'X-Juntia-Request': '1' }
  const units: Record<string, number> = {}
  for (const label of ['10 A', '2 A', '1 B', '1 A']) {
    const response = await page.request.post('/api/admin/dwellings', { headers, data: { label, coefficient: '5.00' } })
    expect(response.status()).toBe(201)
    units[label] = (await response.json()).id
  }
  async function addNeighbor(label: string, name: string, email: string, phone: string, active = true) {
    const response = await page.request.post('/api/admin/users', {
      headers, data: { dwelling_id: units[label], name, email, phone },
    })
    expect(response.status()).toBe(201)
    const user = await response.json()
    if (active) {
      const link = await latestLink(page, email, 'activate')
      const token = new URLSearchParams(new URL(link).hash.slice(1)).get('token')
      expect((await page.request.post('/api/auth/activate', { headers, data: { token, password } })).status()).toBe(204)
    }
    const all = await (await page.request.get('/api/admin/users')).json()
    return all.find((item: { id: number }) => item.id === user.id)
  }
  const email = 'directory-viewer@example.org'
  await addNeighbor('2 A', 'Anna Clark', email, '+44 (20) 7946-0101')
  await addNeighbor('2 A', 'Ben Clark', 'directory-second@example.org', '')
  await addNeighbor('10 A', 'Oscar Hill', 'directory-ten@example.org', '+442079460102')
  await addNeighbor('1 A', 'Pending invitation', 'directory-pending@example.org', '+442079460103', false)
  const disabled = await addNeighbor('1 B', 'Deactivated account', 'directory-disabled@example.org', '+442079460104')
  expect((await page.request.patch(`/api/admin/users/${disabled.id}/status`, {
    headers, data: { disabled: true, version: disabled.version },
  })).status()).toBe(200)
  const context = await browser.newContext({ baseURL: origin })
  try {
    const resident = await context.newPage()
    // Keep this regression focused on an unconfigured directory, independently of layout scenarios.
    await resident.route('**/api/neighbors/layout', async route => {
      const response = await route.fetch()
      await route.fulfill(response.ok() ? { response, json: { ...await response.json(), layout: null } } : { response })
    })
    await resident.goto('/neighbors')
    await expect(resident.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible()
    expect((await resident.request.get('/api/neighbors')).status()).toBe(401)
    await login(resident, email, password, 'neighbors')
    const readerNavigation = resident.getByRole('navigation', { name: 'Main navigation' })
    await expect(readerNavigation.getByRole('group', { name: 'Finances', exact: true }).getByRole('link')).toHaveCount(2)
    await expect(readerNavigation.getByRole('group', { name: 'Management', exact: true }).getByRole('link')).toHaveCount(1)
    await expect(readerNavigation.getByRole('group', { name: 'Community', exact: true }).getByRole('link')).toHaveCount(2)
    await expect(readerNavigation.getByRole('link', { name: 'Contacts', exact: true })).toHaveAttribute('href', '/contacts')
    await expect(readerNavigation.getByRole('group', { name: 'Management', exact: true }).getByRole('link', { name: 'Actions', exact: true })).toHaveAttribute('href', '/actions')
    await expect(resident.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Neighbors', exact: true })).toHaveAttribute('aria-current', 'page')
    const headersInOrder = await resident.locator('.neighbor-dwelling h2').allTextContents()
    expect(headersInOrder.slice(0, 4)).toEqual(['1 A', '1 B', '2 A', '10 A'])
    const group = resident.getByRole('region', { name: '2 A', exact: true })
    await expect(group.locator('li')).toHaveCount(2)
    await expect(group.getByRole('heading', { name: 'Anna Clark', exact: true })).toBeVisible()
    await expect(group.getByText('You', { exact: true })).toBeVisible()
    await expect(group.getByRole('link', { name: 'Call Anna Clark: +442079460101', exact: true })).toHaveAttribute('href', 'tel:+442079460101')
    await expect(group.getByText('No phone number', { exact: true })).toBeVisible()
    await expect(resident.getByText('Pending invitation', { exact: true })).toHaveCount(0)
    await expect(resident.getByText('Deactivated account', { exact: true })).toHaveCount(0)
    await expect(group.getByRole('link', { name: `Email Anna Clark: ${email}`, exact: true })).toHaveAttribute('href', `mailto:${encodeURIComponent(email)}`)
    await resident.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin })
    await group.getByRole('button', { name: `Copy Anna Clark's email: ${email}`, exact: true }).click()
    await expect(group.getByRole('status').filter({ hasText: 'Email copied' })).toBeVisible()
    expect(await resident.evaluate(() => navigator.clipboard.readText())).toBe(email)
    await expect(resident).toHaveURL(/\/neighbors$/)
    await expect(resident.locator('.neighbor-grid')).not.toContainText('directory-pending@example.org')
    await expect(resident.locator('.neighbor-grid')).not.toContainText('directory-disabled@example.org')
    expect((await new AxeBuilder({ page: resident }).analyze()).violations).toEqual([])
    await resident.screenshot({ path: 'test-results/neighbors-desktop.png', fullPage: true })
    await resident.getByRole('link', { name: 'Update my phone number', exact: true }).click()
    await expect(resident.getByRole('heading', { name: 'My profile', exact: true })).toBeVisible()
    await resident.getByLabel('Contact phone', { exact: true }).fill('+44 20 7946 0110')
    await resident.getByRole('button', { name: 'Save details', exact: true }).click()
    await expect(resident.getByText('Contact details updated.', { exact: true })).toBeVisible()
    await resident.getByRole('link', { name: 'Neighbors', exact: true }).click()
    await expect(group.getByRole('link', { name: 'Call Anna Clark: +442079460110', exact: true })).toHaveAttribute('href', 'tel:+442079460110')
    await resident.setViewportSize({ width: 390, height: 844 })
    expect(await resident.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    expect((await new AxeBuilder({ page: resident }).analyze()).violations).toEqual([])
    await resident.screenshot({ path: 'test-results/neighbors-mobile.png', fullPage: true })
    await resident.getByRole('button', { name: 'User menu', exact: true }).click()
    await resident.getByRole('button', { name: 'Sign out', exact: true }).click()
    await expect(resident.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible()
    await expect(resident.getByText('Anna Clark', { exact: true })).toHaveCount(0)
    expect((await resident.request.get('/api/neighbors')).status()).toBe(401)
  } finally {
    await context.close()
  }
})
