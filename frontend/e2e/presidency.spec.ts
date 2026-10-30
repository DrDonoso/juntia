import { test, expect } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import type { DwellingOut, PresidencyOut, UserOut } from '../src/api/schema.gen'

test('a single president can be assigned, transferred and cleared with accessible medals', async ({ page, browser }, testInfo) => {
  test.skip(Boolean(process.env.E2E_BASE_URL), 'Requires the disposable server with synthetic SMTP capture')
  test.setTimeout(180_000)
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.setViewportSize({ width: 1440, height: 960 })
  await page.goto('/admin')
  await page.getByLabel('Username', { exact: true }).fill('browser-test')
  await page.getByLabel('Password', { exact: true }).fill('synthetic-browser-test-password')
  await page.getByRole('button', { name: 'Sign in to administration' }).click()
  await expect(page.getByRole('heading', { name: 'Import statement', exact: true })).toBeVisible()
  const origin = new URL(page.url()).origin
  const headers = { Origin: origin, 'X-Juntia-Request': '1' }
  const password = 'synthetic presidency browser password'
  const general = await (await page.request.get('/api/settings/general')).json()
  expect((await page.request.patch('/api/admin/settings/general', {
    headers, data: { community_name: 'Acacia Court' },
  })).status()).toBe(200)

  const units: DwellingOut[] = []
  for (const label of ['Entrance A · 1A', 'Entrance A · 1B', 'Entrance A · 2A', 'Entrance A · 2B']) {
    const response = await page.request.post('/api/admin/dwellings', { headers, data: { label, coefficient: '25.00' } })
    expect(response.status()).toBe(201)
    units.push(await response.json())
  }
  async function resident(name: string, email: string, dwellingId: number, phone: string, active = true): Promise<UserOut> {
    const response = await page.request.post('/api/admin/users', {
      headers, data: { name, email, dwelling_id: dwellingId, phone },
    })
    expect(response.status()).toBe(201)
    const person: UserOut = await response.json()
    if (active) {
      const messages: { to: string; body: string }[] = await (await page.request.get('/api/admin/test-mailbox')).json()
      const token = messages.toReversed().find(message => message.to === email)?.body.match(/#token=([a-f0-9]{64})/)?.[1]
      if (!token) throw new Error('Missing synthetic invitation token')
      expect((await page.request.post('/api/auth/activate', { headers, data: { token, password } })).status()).toBe(204)
    }
    return person
  }
  const alice = await resident('Alice Lewis', 'alice.lewis@example.org', units[0].id, '+442079460201')
  await resident('Charles Reed', 'charles.reed@example.org', units[0].id, '+442079460202')
  const peter = await resident('Peter Martin', 'peter.martin@example.org', units[1].id, '+442079460203')
  await resident('Lucy Sanders', 'lucy.sanders@example.org', units[2].id, '+442079460204')
  await resident('Martha Green', 'martha.green@example.org', units[3].id, '+442079460205')
  await resident('Pending invitation', 'pending-president@example.org', units[3].id, '', false)

  await page.goto('/admin/users')
  const card = page.getByRole('region', { name: 'Presidency', exact: true })
  const change = card.getByRole('button', { name: 'Change president', exact: true })
  await expect(card).toContainText('Unassigned')
  await change.click()
  const dialog = page.getByRole('dialog', { name: 'Change president', exact: true })
  const select = dialog.getByRole('combobox', { name: 'New president', exact: true })
  await expect(select.getByRole('option', { name: /Pending invitation/ })).toHaveCount(0)
  await select.selectOption(String(alice.id))
  await expect(dialog).toContainText('The presidency will pass to Alice Lewis.')
  expect((await (await page.request.get('/api/admin/presidency')).json()).president).toBeNull()
  await dialog.getByRole('button', { name: 'Confirm change', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(change).toBeFocused()
  await expect(card).toContainText('Alice Lewis')
  await expect(page.getByRole('button', { name: 'Alice Lewis: Community president', exact: true })).toBeVisible()
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
  await page.screenshot({ path: testInfo.outputPath('admin-presidency.png'), fullPage: true, animations: 'disabled' })

  await change.click()
  await select.selectOption(String(peter.id))
  await expect(dialog).toContainText('The presidency will pass from Alice Lewis to Peter Martin.')
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
  await page.screenshot({ path: testInfo.outputPath('presidency-transfer.png'), animations: 'disabled' })
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(change).toBeFocused()
  await expect(card).toContainText('Alice Lewis')

  const readerContext = await browser.newContext({ baseURL: origin, viewport: { width: 1440, height: 960 }, colorScheme: 'light' })
  try {
    const reader = await readerContext.newPage()
    reader.on('pageerror', error => errors.push(error.message))
    expect((await reader.request.post('/api/auth/login', {
      headers, data: { email: alice.email, password },
    })).status()).toBe(200)
    expect((await reader.request.get('/api/admin/presidency')).status()).toBe(401)
    expect((await reader.request.put('/api/admin/presidency', {
      headers, data: { user_id: peter.id, version: 1 },
    })).status()).toBe(401)
    await reader.goto('/neighbors')
    const badge = reader.getByRole('button', { name: 'Alice Lewis: Community president', exact: true })
    await expect(badge).toBeVisible()
    await expect(reader.getByText('You', { exact: true })).toBeVisible()
    await badge.hover()
    const tooltip = reader.getByRole('tooltip')
    await expect(tooltip).toHaveText('Community president')
    expect(await badge.getAttribute('aria-describedby')).toBe(await tooltip.getAttribute('id'))
    expect((await new AxeBuilder({ page: reader }).analyze()).violations).toEqual([])
    await reader.screenshot({ path: testInfo.outputPath('neighbors-desktop.png'), fullPage: true, animations: 'disabled' })
    await tooltip.hover()
    await expect(tooltip).toBeVisible()
    await reader.keyboard.press('Escape')
    await expect(tooltip).toHaveCount(0)
    // Move to the badge with the keyboard from the next control in its card, without scrolling: Tab from
    // the top of the page would depend on the dwellings that earlier specs created.
    await expect(badge).toBeInViewport({ ratio: 1 })
    await reader.getByRole('link', { name: `Email Alice Lewis: ${alice.email}`, exact: true }).focus()
    await reader.keyboard.press('Shift+Tab')
    await expect(badge).toBeFocused()
    await expect(tooltip).toBeVisible()
    await reader.keyboard.press('Escape')
    await reader.getByRole('button', { name: 'Dark mode', exact: true }).click()
    await badge.hover()
    await expect(tooltip).toBeVisible()
    expect((await new AxeBuilder({ page: reader }).analyze()).violations).toEqual([])
    await reader.screenshot({ path: testInfo.outputPath('neighbors-dark.png'), fullPage: true, animations: 'disabled' })
    await reader.getByRole('button', { name: 'Light mode', exact: true }).click()

    const mobileContext = await browser.newContext({
      baseURL: origin, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
      colorScheme: 'light', storageState: await readerContext.storageState(),
    })
    try {
      const mobile = await mobileContext.newPage()
      mobile.on('pageerror', error => errors.push(error.message))
      await mobile.goto('/neighbors')
      const mobileBadge = mobile.getByRole('button', { name: 'Alice Lewis: Community president', exact: true })
      await mobileBadge.tap()
      await expect(mobile.getByRole('tooltip')).toHaveText('Community president')
      const bounds = await mobileBadge.boundingBox()
      expect(bounds?.width).toBeGreaterThanOrEqual(44)
      expect(bounds?.height).toBeGreaterThanOrEqual(44)
      expect(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      expect((await new AxeBuilder({ page: mobile }).analyze()).violations).toEqual([])
      await mobile.screenshot({ path: testInfo.outputPath('neighbors-mobile.png'), fullPage: true, animations: 'disabled' })
      await mobileBadge.tap()
      await expect(mobile.getByRole('tooltip')).toHaveCount(0)
      await mobileBadge.tap()
      await expect(mobile.getByRole('tooltip')).toBeVisible()
      await mobile.getByRole('heading', { name: 'Neighbors', exact: true }).tap()
      await expect(mobile.getByRole('tooltip')).toHaveCount(0)
    } finally {
      await mobileContext.close()
    }

    await change.click()
    await select.selectOption(String(peter.id))
    await dialog.getByRole('button', { name: 'Confirm change', exact: true }).click()
    await expect(card).toContainText('Peter Martin')
    await expect(page.getByRole('button', { name: 'Alice Lewis: Community president', exact: true })).toHaveCount(0)
    await reader.reload()
    await expect(reader.getByRole('button', { name: /Community president/ })).toHaveCount(1)
    await expect(reader.getByRole('button', { name: 'Peter Martin: Community president', exact: true })).toBeVisible()

    await change.click()
    await select.selectOption('')
    const before: PresidencyOut = await (await page.request.get('/api/admin/presidency')).json()
    expect((await page.request.put('/api/admin/presidency', {
      headers, data: { user_id: alice.id, version: before.version },
    })).status()).toBe(200)
    await dialog.getByRole('button', { name: 'Confirm change', exact: true }).click()
    await expect(dialog.getByRole('alert')).toContainText('The presidency or the selected account has changed')
    await expect(dialog.getByRole('button', { name: 'Confirm change', exact: true })).toBeDisabled()
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(card).toContainText('Alice Lewis')

    await change.click()
    await select.selectOption('')
    await expect(dialog).toContainText('The presidency will be left unassigned.')
    await dialog.getByRole('button', { name: 'Confirm change', exact: true }).click()
    await expect(card).toContainText('Unassigned')
    await reader.reload()
    await expect(reader.getByRole('heading', { name: 'Neighbors', exact: true })).toBeVisible()
    await expect(reader.getByRole('button', { name: /Community president/ })).toHaveCount(0)

    await change.click()
    await select.selectOption(String(alice.id))
    await dialog.getByRole('button', { name: 'Confirm change', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await page.getByRole('button', { name: `Deactivate user ${alice.email}`, exact: true }).click()
    const disabling = page.getByRole('dialog', { name: 'Deactivate user', exact: true })
    await expect(disabling).toContainText('leave the presidency unassigned')
    await disabling.getByRole('button', { name: 'Confirm deactivation', exact: true }).click()
    await expect(card).toContainText('Unassigned')
    await page.getByRole('button', { name: `Reactivate user ${alice.email}`, exact: true }).click()
    await page.getByRole('button', { name: 'Confirm reactivation', exact: true }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(card).toContainText('Unassigned')
    expect((await (await page.request.get('/api/admin/presidency')).json()).president).toBeNull()
  } finally {
    await readerContext.close()
    const current: PresidencyOut = await (await page.request.get('/api/admin/presidency')).json()
    if (current.president) expect((await page.request.put('/api/admin/presidency', {
      headers, data: { user_id: null, version: current.version },
    })).status()).toBe(200)
    expect((await page.request.patch('/api/admin/settings/general', { headers, data: general })).status()).toBe(200)
  }
  expect(errors).toEqual([])
})
