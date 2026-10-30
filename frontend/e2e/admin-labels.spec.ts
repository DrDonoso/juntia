import { expect, test, type Locator } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import type { ActionOut, ContactOut, ContactTagOut } from '../src/api/schema.gen'

test.use({ actionTimeout: 15_000 })

async function chooseColor(input: Locator, color: string) {
  await input.evaluate((element, value) => {
    if (!(element instanceof HTMLInputElement)) throw new Error('Expected a color input')
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    if (!setter) throw new Error('Color input setter is unavailable')
    setter.call(element, value)
    element.dispatchEvent(new Event('input', { bubbles: true }))
    element.dispatchEvent(new Event('change', { bubbles: true }))
  }, color)
}

test('administration edits independent label catalogs and redirects community views without losing access', async ({ page, browser }, testInfo) => {
  test.skip(Boolean(process.env.E2E_BASE_URL), 'Requires the disposable synthetic application')
  test.setTimeout(120_000)
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto('/admin/labels')
  await page.getByLabel('Username', { exact: true }).fill('browser-test')
  await page.getByLabel('Password', { exact: true }).fill('synthetic-browser-test-password')
  await page.getByRole('button', { name: 'Sign in to administration' }).click()
  await expect(page.getByRole('heading', { name: 'Community labels', exact: true })).toBeVisible()
  const origin = new URL(page.url()).origin
  const headers = { Origin: origin, 'X-Juntia-Request': '1' }
  const name = 'Labels E2E shared'
  const created = await page.request.post('/api/actions/items', {
    headers, data: { title: 'Labels E2E action', labels: [name] },
  })
  expect(created.status()).toBe(201)
  const action: ActionOut = await created.json()
  const tagResponse = await page.request.post('/api/contact-tags', {
    headers, data: { name, color: '#abcdef' },
  })
  expect(tagResponse.status()).toBe(201)
  const tag: ContactTagOut = await tagResponse.json()
  const contactResponse = await page.request.post('/api/contacts', {
    headers, data: { name: 'Labels E2E contact', phone: '+442079460456', tags: [tag.id] },
  })
  expect(contactResponse.status()).toBe(201)
  const contact: ContactOut = await contactResponse.json()
  await page.reload()
  const navigation = page.getByRole('navigation', { name: 'Administration navigation' })
  for (const name of ['Actions', 'Neighbors', 'Contacts']) {
    await expect(navigation.getByRole('link', { name, exact: true })).toHaveCount(0)
  }
  await expect(navigation.getByRole('link', { name: 'Community labels', exact: true })).toHaveAttribute('aria-current', 'page')
  const actions = page.getByRole('region', { name: 'Action labels', exact: true })
  const contacts = page.getByRole('region', { name: 'Contact tags', exact: true })
  await actions.getByRole('button', { name: `Edit ${name}`, exact: true }).click()
  let dialog = page.getByRole('dialog', { name: `Edit label: ${name}`, exact: true })
  const originalColor = await dialog.getByLabel('Color', { exact: true }).inputValue()
  const actionName = 'Labels E2E maintenance of the shared community facilities and entrances'
  await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill(actionName)
  await expect(dialog.getByLabel('Color', { exact: true })).toHaveValue(originalColor)
  await chooseColor(dialog.getByLabel('Color', { exact: true }), '#123456')
  await expect(dialog.getByLabel('Label preview')).toHaveCSS('background-color', 'rgb(18, 52, 86)')
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
  await dialog.getByRole('button', { name: 'Save label', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(actions.getByText(`Label “${actionName}” saved.`, { exact: true })).toBeVisible()
  await expect(actions.getByText(actionName, { exact: true })).toHaveCSS('background-color', 'rgb(18, 52, 86)')
  await expect(contacts.getByText(name, { exact: true })).toHaveCSS('background-color', 'rgb(171, 205, 239)')
  await contacts.getByRole('button', { name: `Edit ${name}`, exact: true }).click()
  dialog = page.getByRole('dialog', { name: `Edit tag: ${name}`, exact: true })
  await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill('Labels E2E emergencies')
  await chooseColor(dialog.getByLabel('Color', { exact: true }), '#fedcba')
  await dialog.getByRole('button', { name: 'Save tag', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await page.reload()
  await expect(actions.getByText(actionName, { exact: true })).toHaveCSS('background-color', 'rgb(18, 52, 86)')
  await expect(contacts.getByText('Labels E2E emergencies', { exact: true })).toHaveCSS('background-color', 'rgb(254, 220, 186)')
  const savedAction: ActionOut = await (await page.request.get(`/api/actions/items/${action.id}`)).json()
  const savedContact: ContactOut = await (await page.request.get(`/api/contacts/${contact.id}`)).json()
  expect(savedAction.labels).toEqual([{ ...action.labels[0], name: actionName, color: '#123456', version: 2 }])
  expect(savedContact.tags).toEqual([{ ...tag, name: 'Labels E2E emergencies', color: '#fedcba', version: 2 }])

  for (const width of [1280, 390, 320]) {
    await page.setViewportSize({ width, height: 900 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
    await page.screenshot({ path: testInfo.outputPath(`community-labels-${width}.png`), fullPage: true })
  }
  await page.getByRole('button', { name: 'Dark mode', exact: true }).click()
  await actions.getByRole('button', { name: `Edit ${actionName}`, exact: true }).click()
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
  expect(await page.getByRole('dialog').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('community-labels-mobile-dark-editor.png'), fullPage: true })
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await page.setViewportSize({ width: 1280, height: 900 })

  await page.goto(`/admin/actions/${action.id}?scope=all&label=${action.labels[0].id}#history`)
  await expect(page).toHaveURL(`${origin}/actions/${action.id}?scope=all&label=${action.labels[0].id}#history`)
  await expect(page.getByRole('heading', { name: action.title, exact: true })).toBeVisible()
  await expect(page.locator('.page-heading').getByText(actionName, { exact: true })).toHaveCSS('background-color', 'rgb(18, 52, 86)')
  await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible()
  await page.getByRole('button', { name: 'Edit action', exact: true }).click()
  const selectedLabel = page.getByRole('dialog').locator('.contact-tag-chip').filter({ hasText: actionName })
  await expect(selectedLabel).toHaveCSS('background-color', 'rgb(18, 52, 86)')
  await page.getByRole('dialog').getByLabel('Labels', { exact: true }).fill('no matches')
  await expect(selectedLabel).toHaveCSS('background-color', 'rgb(18, 52, 86)')
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()

  await page.goto('/admin/actions?q=Labels%20E2E')
  await expect(page).toHaveURL(/\/actions\?q=Labels\+E2E$/)
  await expect(page.getByRole('table').getByText(actionName, { exact: true })).toHaveCSS('background-color', 'rgb(18, 52, 86)')
  await page.getByRole('button', { name: 'Kanban', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Actions board', exact: true }).getByText(actionName, { exact: true })).toHaveCSS('background-color', 'rgb(18, 52, 86)')
  await page.goto('/admin/neighbors')
  await expect(page).toHaveURL(`${origin}/neighbors`)
  await expect(page.getByRole('heading', { name: 'Neighbors', exact: true })).toBeVisible()
  await page.goto('/admin/contacts?q=Labels%20E2E')
  await expect(page).toHaveURL(/\/contacts\?q=Labels\+E2E$/)
  await expect(page.getByRole('table').getByText('Labels E2E emergencies', { exact: true })).toHaveCSS('background-color', 'rgb(254, 220, 186)')
  await page.goto('/admin/contacts?deleted=1&q=Labels%20E2E')
  await expect(page).toHaveURL(/\/admin\/deleted-contacts\?q=Labels\+E2E$/)
  await expect(page.getByRole('heading', { name: 'Deleted contacts', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'New contact' })).toHaveCount(0)
  await expect(page.getByRole('link', { name: 'Go to the community address book' })).toHaveAttribute('href', '/contacts')

  const anonymous = await browser.newContext({ baseURL: origin })
  try {
    const visitor = await anonymous.newPage()
    await visitor.goto('/admin/labels')
    await expect(visitor.getByRole('button', { name: 'Sign in to administration' })).toBeVisible()
    await expect(visitor.getByRole('heading', { name: 'Community labels', exact: true })).toHaveCount(0)
  } finally {
    await anonymous.close()
    expect((await page.request.post('/api/admin/test-reset-login-attempts', { headers })).status()).toBe(204)
  }
  expect(errors).toEqual([])
})
