import { expect, test, type APIResponse, type Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { signInAsAdministrator, writeHeaders } from './support'

const password = 'synthetic search resident password'
const resident = { name: 'Quokka Resident', email: 'search-quokka@example.org' }

async function created(response: Promise<APIResponse>): Promise<{ id: number }> {
  const answer = await response
  expect(answer.status()).toBe(201)
  return answer.json()
}

/** Whether every result shows its type on the right of its title's first line, inside the list. */
function kindsBesideTitles(page: Page) {
  return page.getByRole('listbox', { name: 'Search results', exact: true }).getByRole('option').evaluateAll(options => options.every(option => {
    const row = option.getBoundingClientRect()
    const title = option.querySelector('.search-hit-title')!.getBoundingClientRect()
    const kind = option.querySelector('.search-hit-kind')!.getBoundingClientRect()
    return kind.left >= title.right && kind.right <= row.right && Math.abs(kind.top - title.top) < 4 && row.right <= window.innerWidth
  }))
}

test.afterEach(async ({ page }) => {
  if (process.env.E2E_BASE_URL || page.url() === 'about:blank') return
  const headers = writeHeaders(page)
  for (const feature of ['events', 'documents']) {
    expect((await page.request.patch(`/api/admin/settings/features/${feature}`, { headers, data: { enabled: false } })).status()).toBe(200)
  }
  expect((await page.request.post('/api/admin/test-reset-login-attempts', { headers })).status()).toBe(204)
})

test('the search at the top finds every kind of item as it is typed and opens each one', async ({ page, browser }) => {
  test.skip(Boolean(process.env.E2E_BASE_URL), 'Requires disposable data and the synthetic mailbox')
  test.setTimeout(120_000)
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.setViewportSize({ width: 1280, height: 900 })
  await signInAsAdministrator(page, '/admin')
  const origin = new URL(page.url()).origin
  const headers = writeHeaders(page)
  for (const feature of ['events', 'documents']) {
    expect((await page.request.patch(`/api/admin/settings/features/${feature}`, { headers, data: { enabled: true } })).status()).toBe(200)
  }
  const action = await created(page.request.post('/api/actions/items', { headers, data: {
    title: 'Quokka lift repair', description: 'The cabin door closes too fast.',
  } }))
  const event = await created(page.request.post('/api/events', { headers, data: {
    title: 'Quokka lift inspection', location: 'Main hall', timezone: 'Europe/Madrid', all_day: true,
    starts_on: '2040-03-10', ends_on: '2040-03-11',
  } }))
  const folder = await created(page.request.post('/api/documents/folders', { headers, data: { name: 'Quokka minutes' } }))
  const contact = await created(page.request.post('/api/contacts', { headers, data: {
    name: 'Quokka plumbing', company: 'Pipes and taps', phone: '+44 20 7946 0999',
  } }))
  const dwelling = await created(page.request.post('/api/admin/dwellings', { headers, data: { label: 'Search E2E 1 A', coefficient: '1.00' } }))
  const neighbor = await created(page.request.post('/api/admin/users', { headers, data: { ...resident, dwelling_id: dwelling.id } }))
  const messages: { to: string; body: string }[] = await (await page.request.get('/api/admin/test-mailbox')).json()
  const token = [...messages].reverse().find(message => message.to === resident.email)?.body.match(/\/activate#token=([a-f0-9]{64})/)?.[1]
  if (!token) throw new Error('Synthetic invitation token was not delivered')
  const mobile = await browser.newContext({ baseURL: origin, viewport: { width: 390, height: 844 }, locale: 'en-GB' })
  try {
    expect((await mobile.request.post('/api/auth/activate', { headers, data: { token, password } })).status()).toBe(204)

    // The box is in the top bar of the administration too, and searches the portal's content.
    const box = page.getByRole('combobox', { name: 'Search the portal', exact: true })
    await expect(box).toBeVisible()
    await page.goto(`/documents/folders/${folder.id}`)
    await page.getByLabel('Files to upload').setInputFiles({
      name: 'Quokka rules.txt', mimeType: 'text/plain', buffer: Buffer.from('Wombats may not use the lift after 22:00.\n'),
    })
    await expect(page.getByRole('region', { name: 'Uploads' }).getByText('Uploaded as “Quokka rules.txt”.')).toBeVisible()

    await box.fill('quokka')
    const results = page.getByRole('listbox', { name: 'Search results', exact: true })
    const options = results.getByRole('option')
    await expect(options).toHaveCount(6)
    await expect(box).toHaveAttribute('aria-expanded', 'true')
    await expect(options.locator('.search-hit-kind')).toHaveText(['Action', 'Event', 'Folder', 'Document', 'Neighbor', 'Contact'])
    await expect(options.locator('.search-hit-title')).toHaveText([
      'Quokka lift repair', 'Quokka lift inspection', 'Quokka minutes', 'Quokka rules.txt', resident.name, 'Quokka plumbing',
    ])
    for (let index = 0; index < 6; index += 1) await expect(options.nth(index).locator('.search-hit-title mark')).toHaveText('Quokka')
    await expect(options.nth(0)).toContainText('Detected')
    await expect(options.nth(1)).toContainText('Main hall')
    await expect(options.nth(3)).toContainText('Documents / Quokka minutes')
    await expect(options.nth(4)).toContainText('Dwelling Search E2E 1 A')
    await expect(options.nth(5)).toContainText('Pipes and taps · +442079460999')
    await expect(page.getByRole('search', { name: 'Search the portal' }).getByRole('status')).toHaveText('6 results')
    expect(await kindsBesideTitles(page)).toBe(true)
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
    await page.screenshot({ path: 'test-results/search-desktop.png' })

    // The arrows choose a result and Enter opens it.
    await box.press('ArrowDown')
    await box.press('ArrowDown')
    await expect(options.nth(1)).toHaveAttribute('aria-selected', 'true')
    await expect(box).toHaveAttribute('aria-activedescendant', (await options.nth(1).getAttribute('id'))!)
    await box.press('Enter')
    await expect(page).toHaveURL(new RegExp(`/events\\?event=${event.id}$`))
    await expect(page.getByRole('dialog', { name: 'Quokka lift inspection', exact: true })).toBeVisible()
    await expect(box).toHaveValue('')
    await expect(results).toHaveCount(0)
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)

    // Words inside a file, once the server has read it, and `/` goes to the box.
    await expect.poll(async () => (await (await page.request.get('/api/search?q=wombats')).json()).items.length, { timeout: 30_000 }).toBe(1)
    await page.locator('main').focus()
    await page.keyboard.press('/')
    await expect(box).toBeFocused()
    await page.keyboard.type('wombats LIFT')
    // The previous results stay while the next ones load: wait for these.
    await expect(options).toHaveText([/^Quokka rules\.txt/])
    await expect(options.locator('.search-hit-excerpt')).toHaveText('Wombats may not use the lift after 22:00.')
    await expect(options.locator('.search-hit-excerpt mark')).toHaveText(['Wombats', 'lift'])
    await options.click()
    await expect(page).toHaveURL(new RegExp(`/documents/folders/${folder.id}\\?file=[1-9][0-9]*$`))
    const viewer = page.getByRole('dialog', { name: 'Quokka rules.txt', exact: true })
    await expect(viewer.getByText('Wombats may not use the lift after 22:00.')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(viewer).toHaveCount(0)
    await expect(page).toHaveURL(new RegExp(`/documents/folders/${folder.id}$`))

    // Escape hides the results first and then empties the box.
    await page.keyboard.press('Control+k')
    await expect(box).toBeFocused()
    await box.fill('quokka plumbing')
    await expect(options).toHaveText([/^Quokka plumbing/])
    await box.press('Escape')
    await expect(results).toHaveCount(0)
    await expect(box).toHaveValue('quokka plumbing')
    await box.press('ArrowDown')
    await expect(options).toHaveText([/^Quokka plumbing/])
    await options.click()
    await expect(page).toHaveURL(new RegExp(`/contacts\\?contact=${contact.id}$`))
    await expect(page.getByRole('dialog', { name: 'Quokka plumbing', exact: true }).getByText('Pipes and taps')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)

    await box.fill('quokka resident')
    await expect(options).toHaveText([new RegExp(`^${resident.name}`)])
    await box.press('Enter')
    await expect(page).toHaveURL(new RegExp(`/neighbors\\?neighbor=${neighbor.id}$`))
    const person = page.locator(`[data-neighbor="${neighbor.id}"]`)
    await expect(person).toBeFocused()
    await expect(person).toHaveAttribute('data-found', 'true')
    await expect(person).toContainText(resident.name)

    // Only what can be read: the events go when they are turned off.
    expect((await page.request.patch('/api/admin/settings/features/events', { headers, data: { enabled: false } })).status()).toBe(200)
    const kinds = (await (await page.request.get('/api/search?q=quokka')).json()).items.map((item: { kind: string }) => item.kind)
    expect(kinds).toEqual(['action', 'folder', 'file', 'neighbor', 'contact'])

    // On a phone, the magnifier opens the search under the top bar.
    expect((await mobile.request.post('/api/auth/login', { headers, data: { email: resident.email, password } })).status()).toBe(200)
    const phone = await mobile.newPage()
    phone.on('pageerror', error => errors.push(error.message))
    await phone.goto('/')
    const magnifier = phone.getByRole('button', { name: 'Search', exact: true })
    await expect(magnifier).toHaveAttribute('aria-expanded', 'false')
    await expect(phone.getByRole('combobox', { name: 'Search the portal', exact: true })).toHaveCount(0)
    await expect(phone.locator('.topbar')).toHaveCSS('height', '52px')
    await magnifier.click()
    const field = phone.getByRole('combobox', { name: 'Search the portal', exact: true })
    await expect(field).toBeFocused()
    const close = phone.getByRole('button', { name: 'Close the search', exact: true })
    await expect(close).toHaveAttribute('aria-expanded', 'true')
    await field.fill('quokka')
    await expect(phone.getByRole('listbox', { name: 'Search results', exact: true }).getByRole('option')).toHaveCount(5)
    expect(await kindsBesideTitles(phone)).toBe(true)
    expect(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    expect((await new AxeBuilder({ page: phone }).analyze()).violations).toEqual([])
    await phone.screenshot({ path: 'test-results/search-mobile.png' })
    await phone.getByRole('option', { name: /Quokka lift repair/ }).click()
    await expect(phone).toHaveURL(new RegExp(`/actions/${action.id}$`))
    await expect(phone.getByRole('heading', { name: 'Quokka lift repair', level: 1 })).toBeVisible()
    await expect(magnifier).toHaveAttribute('aria-expanded', 'false')
    await expect(field).toHaveCount(0)
    await magnifier.click()
    await expect(field).toBeFocused()
    await phone.keyboard.press('Escape')
    await expect(field).toHaveCount(0)
    await expect(magnifier).toBeFocused()
    expect(errors).toEqual([])
  } finally {
    await mobile.close()
  }
})
