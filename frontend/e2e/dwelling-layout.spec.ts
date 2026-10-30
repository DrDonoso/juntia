import { expect, test, type Locator, type Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import type { DwellingLayout, DwellingLayoutOut } from '../src/api/schema.gen'

test.beforeEach(async ({ page }) => {
  test.skip(Boolean(process.env.E2E_BASE_URL), 'Requires the disposable synthetic application')
  await page.goto('/admin/dwellings')
  await page.getByLabel('Username', { exact: true }).fill('browser-test')
  await page.getByLabel('Password', { exact: true }).fill('synthetic-browser-test-password')
  await page.getByRole('button', { name: 'Sign in to administration' }).click()
  await expect(page.getByRole('heading', { name: 'Dwellings', exact: true })).toBeVisible()
})

test.afterEach(async ({ page }) => {
  if (process.env.E2E_BASE_URL || page.url() === 'about:blank') return
  const response = await page.request.post('/api/admin/test-reset-login-attempts', { headers: headers(page) })
  expect(response.status()).toBe(204)
})

function headers(page: Page) {
  return { Origin: new URL(page.url()).origin, 'X-Juntia-Request': '1' }
}

async function homes(page: Page, labels: string[]) {
  const features = await (await page.request.get('/api/features')).json()
  const ids: number[] = []
  for (const label of labels) {
    const response = await page.request.post('/api/admin/dwellings', {
      headers: headers(page), data: { label, ...(features.coefficient ? { coefficient: '1.00' } : {}) },
    })
    expect(response.status()).toBe(201)
    ids.push((await response.json()).id)
  }
  return ids
}

async function publish(page: Page, layout: DwellingLayout) {
  const current: DwellingLayoutOut = await (await page.request.get('/api/neighbors/layout')).json()
  const response = await page.request.put('/api/admin/dwellings/layout', { headers: headers(page), data: { version: current.version, layout } })
  expect(response.status()).toBe(200)
  const saved: DwellingLayoutOut = await response.json()
  return saved
}

async function drag(page: Page, handle: Locator, destination: Locator) {
  await destination.scrollIntoViewIfNeeded()
  await handle.hover()
  const source = await handle.boundingBox(), target = await destination.boundingBox()
  if (!source || !target) throw new Error('Drag endpoints must be visible')
  const x = source.x + source.width / 2, y = source.y + source.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + 15, y, { steps: 3 })
  await expect.poll(() => page.locator('.layout-tile.dragging').count()).toBeGreaterThan(0)
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 12 })
  await page.mouse.up()
  await expect(page.locator('.layout-tile.dragging')).toHaveCount(0)
}

test('dwelling layout publishes aligned floors, holes and exterior homes to both directories', async ({ page, browser }, info) => {
  test.setTimeout(120_000)
  await page.setViewportSize({ width: 1600, height: 1000 })
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  const ids = await homes(page, ['Grid 2 A', 'Grid 2 C', 'Grid 1 A', 'Grid Ground A', 'Grid Courtyard', 'Grid New'])
  const layout: DwellingLayout = { show_row_names: true, show_column_names: true, zones: [
    { id: 'building', name: 'Main block', columns: 3, rows: [
      { id: 'floor2', name: 'Floor 2', cells: [ids[0], null, ids[1]] },
      { id: 'floor1', name: 'Floor 1', cells: [ids[2], null, null] },
      { id: 'ground', name: 'Ground floor', cells: [ids[3], null, null] },
    ] },
    { id: 'outside', name: 'Outdoors', columns: 2, rows: [{ id: 'patio', name: '', cells: [ids[4], null] }] },
  ] }
  const initial = await publish(page, layout)
  await page.reload()
  await page.getByRole('button', { name: 'Arrange dwellings', exact: true }).click()
  const editor = page.getByRole('dialog', { name: 'Arrange dwellings', exact: true })
  await expect(editor.getByLabel('Name of zone 1')).toHaveValue('Main block')
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
  await drag(page, editor.getByRole('button', { name: 'Drag dwelling Grid Ground A', exact: true }), editor.locator('[data-drop="cell:building:floor2:1"]'))
  await expect(editor.locator('[data-drop="cell:building:floor2:1"]')).toContainText('Grid Ground A')
  await drag(page, editor.getByRole('button', { name: 'Drag dwelling Grid 1 A', exact: true }), editor.locator('[data-drop="cell:building:floor2:0"]'))
  await expect(editor.locator('[data-drop="cell:building:floor1:0"]')).toContainText('Grid 2 A')
  expect((await (await page.request.get('/api/neighbors/layout')).json()).version).toBe(initial.version)
  await editor.getByRole('button', { name: 'Cancel', exact: true }).click()
  await page.getByRole('dialog', { name: 'Discard changes' }).getByRole('button', { name: 'Confirm', exact: true }).click()
  await expect(editor).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Arrange dwellings', exact: true })).toBeFocused()
  await page.getByRole('button', { name: 'Arrange dwellings', exact: true }).click()
  await expect(editor.locator('[data-drop="cell:building:ground:0"]')).toContainText('Grid Ground A')
  await drag(page, editor.getByRole('button', { name: 'Drag dwelling Grid New', exact: true }), editor.locator('[data-drop="cell:outside:patio:1"]'))
  await expect(editor.locator('[data-drop="cell:outside:patio:1"]')).toContainText('Grid New')
  await editor.getByRole('button', { name: 'Save layout', exact: true }).click()
  await expect(editor.getByText('Layout saved. It is now available to all neighbors.')).toBeVisible()
  const saved: DwellingLayoutOut = await (await page.request.get('/api/neighbors/layout')).json()
  expect(saved.version).toBe(initial.version + 1)
  expect(saved.layout?.zones[1].rows[0].cells).toEqual([ids[4], ids[5]])
  await editor.getByRole('button', { name: 'Cancel', exact: true }).click()
  await page.goto('/admin/neighbors')
  await expect(page.getByRole('region', { name: 'Main block', exact: true })).toBeVisible()
  await expect(page.locator('[data-cell="cell:building:floor2:1"] .neighbor-dwelling')).toHaveCount(0)
  const top = await page.getByRole('region', { name: 'Grid 2 A', exact: true }).boundingBox()
  const middle = await page.getByRole('region', { name: 'Grid 1 A', exact: true }).boundingBox()
  const bottom = await page.getByRole('region', { name: 'Grid Ground A', exact: true }).boundingBox()
  const third = await page.getByRole('region', { name: 'Grid 2 C', exact: true }).boundingBox()
  if (!top || !middle || !bottom || !third) throw new Error('Dwelling cards must be rendered')
  expect(Math.abs(top.x - middle.x)).toBeLessThanOrEqual(1)
  expect(Math.abs(top.x - bottom.x)).toBeLessThanOrEqual(1)
  expect(middle.y).toBeGreaterThanOrEqual(top.y + top.height)
  expect(bottom.y).toBeGreaterThanOrEqual(middle.y + middle.height)
  expect(third.x - top.x).toBeGreaterThan(top.width * 2)
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
  const desktop = await page.evaluate(() => {
    const main = document.querySelector('main'), sidebar = document.querySelector('.sidebar'), workspace = document.querySelector('.workspace')
    if (!main || !sidebar || !workspace) throw new Error('Missing page layout')
    return {
      mainLeft: main.getBoundingClientRect().left,
      sidebarRight: sidebar.getBoundingClientRect().right,
      margin: getComputedStyle(workspace).marginLeft,
      horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
      scrollLeft: document.documentElement.scrollLeft,
    }
  })
  expect(desktop).toMatchObject({ horizontalOverflow: false, scrollLeft: 0 })
  expect(desktop.mainLeft).toBeGreaterThanOrEqual(desktop.sidebarRight)
  await page.screenshot({ path: info.outputPath('layout-desktop.png'), fullPage: true, animations: 'disabled' })

  const email = 'layout-reader@example.org', password = 'synthetic layout reader password'
  const invited = await page.request.post('/api/admin/users', {
    headers: headers(page), data: { dwelling_id: ids[2], name: 'Layout Reader', email, phone: '+442079460101' },
  })
  expect(invited.status()).toBe(201)
  const mailbox: { to: string; body: string }[] = await (await page.request.get('/api/admin/test-mailbox')).json()
  const token = mailbox.find(message => message.to === email)?.body.match(/#token=([a-f0-9]{64})/)?.[1]
  expect(token).toBeTruthy()
  expect((await page.request.post('/api/auth/activate', { headers: headers(page), data: { token, password } })).status()).toBe(204)
  const context = await browser.newContext({ baseURL: new URL(page.url()).origin, locale: 'en-GB' })
  try {
    expect((await context.request.get('/api/neighbors/layout')).status()).toBe(401)
    expect((await context.request.post('/api/auth/login', { headers: headers(page), data: { email, password } })).status()).toBe(200)
    expect((await context.request.put('/api/admin/dwellings/layout', { headers: headers(page), data: { version: saved.version, layout } })).status()).toBe(401)
    const reader = await context.newPage()
    await reader.goto('/neighbors')
    await expect(reader.getByRole('heading', { name: 'Layout Reader', exact: true })).toBeVisible()
    await expect(reader.getByRole('link', { name: /Call Layout Reader/ })).toHaveAttribute('href', 'tel:+442079460101')
    await expect(reader.getByRole('button', { name: 'Arrange dwellings', exact: true })).toHaveCount(0)
    await reader.setViewportSize({ width: 390, height: 844 })
    const scroll = reader.getByRole('region', { name: /Layout of Main block/ })
    expect(await reader.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    expect(await scroll.evaluate(node => node.scrollWidth > node.clientWidth)).toBe(true)
    await scroll.evaluate(node => { node.scrollLeft = node.scrollWidth })
    await expect(reader.getByRole('region', { name: 'Grid 2 C', exact: true })).toBeInViewport()
    expect((await new AxeBuilder({ page: reader }).analyze()).violations).toEqual([])
    await scroll.evaluate(node => { node.scrollLeft = 0 })
    await reader.screenshot({ path: info.outputPath('layout-mobile.png'), fullPage: true, animations: 'disabled' })
    await reader.reload()
    await expect(reader.getByRole('region', { name: 'Outdoors', exact: true })).toContainText('Grid New')
  } finally {
    await context.close()
  }
  expect(errors).toEqual([])
})

test('dwelling layout supports real touch swapping, scroll and keyboard cancellation', async ({ page, browser, browserName }, info) => {
  test.skip(browserName !== 'chromium', 'Real touch input uses the Chromium DevTools protocol')
  const ids = await homes(page, ['Touch Top', 'Touch Bottom'])
  await publish(page, { show_row_names: false, show_column_names: false, zones: [{
    id: 'touch', name: 'Touch block', columns: 2, rows: [
      { id: 'up', name: 'Top', cells: [ids[0], null] },
      { id: 'down', name: 'Bottom', cells: [ids[1], null] },
    ],
  }] })
  const origin = new URL(page.url()).origin
  const context = await browser.newContext({ baseURL: origin, locale: 'en-GB', hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } })
  try {
    expect((await context.request.post('/api/admin/auth/login', { headers: headers(page), data: {
      username: 'browser-test', password: 'synthetic-browser-test-password',
    } })).status()).toBe(200)
    const mobile = await context.newPage()
    await mobile.goto('/admin/dwellings')
    await mobile.getByRole('button', { name: 'Arrange dwellings', exact: true }).tap()
    const editor = mobile.getByRole('dialog', { name: 'Arrange dwellings', exact: true })
    const grid = editor.getByRole('region', { name: /Layout of Touch block/ })
    await grid.scrollIntoViewIfNeeded()
    const handle = editor.getByRole('button', { name: 'Drag dwelling Touch Top', exact: true })
    const source = await handle.boundingBox(), target = await editor.locator('[data-drop="cell:touch:down:0"]').boundingBox()
    if (!source || !target) throw new Error('Touch endpoints must be rendered')
    const session = await context.newCDPSession(mobile)
    const start = { x: source.x + source.width / 2, y: source.y + source.height / 2 }
    await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [start] })
    await expect.poll(() => mobile.locator('.layout-tile.dragging').count()).toBeGreaterThan(0)
    for (let step = 1; step <= 8; step++) {
      await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{
        x: start.x + (target.x + target.width / 2 - start.x) * step / 8,
        y: start.y + (target.y + target.height / 2 - start.y) * step / 8,
      }] })
    }
    await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await expect(editor.locator('[data-drop="cell:touch:down:0"]')).toContainText('Touch Top')
    await expect(editor.locator('[data-drop="cell:touch:up:0"]')).toContainText('Touch Bottom')
    const bounds = await grid.boundingBox()
    if (!bounds) throw new Error('The grid must be visible')
    const swipe = { x: bounds.x + bounds.width - 20, y: bounds.y + 10 }
    await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [swipe] })
    for (let step = 1; step <= 6; step++) {
      await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: swipe.x - step * 25, y: swipe.y }] })
    }
    await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await expect.poll(() => grid.evaluate(node => node.scrollLeft)).toBeGreaterThan(0)
    await expect(mobile.locator('.layout-tile.dragging')).toHaveCount(0)
    await handle.scrollIntoViewIfNeeded()
    await handle.focus()
    await mobile.keyboard.press('Space')
    await expect.poll(() => mobile.locator('.layout-tile.dragging').count()).toBeGreaterThan(0)
    await mobile.keyboard.press('Escape')
    await expect(mobile.locator('.layout-tile.dragging')).toHaveCount(0)
    await expect(mobile.getByRole('dialog', { name: 'Discard changes' })).toHaveCount(0)
    await expect(editor).toBeVisible()
    expect(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    expect((await new AxeBuilder({ page: mobile }).analyze()).violations).toEqual([])
    await grid.evaluate(node => { node.scrollLeft = 0 })
    await mobile.screenshot({ path: info.outputPath('layout-editor-touch.png'), fullPage: true, animations: 'disabled' })
    await editor.getByRole('button', { name: 'Cancel', exact: true }).click()
    await mobile.getByRole('dialog', { name: 'Discard changes' }).getByRole('button', { name: 'Confirm' }).click()
  } finally {
    await context.close()
  }
})

test('dwelling layout label preferences control both directories without changing positions', async ({ page }, info) => {
  test.setTimeout(120_000)
  const ids = await homes(page, ['Reference A', 'Reference C', 'Reference D'])
  const document: DwellingLayout = {
    show_row_names: false, show_column_names: false,
    zones: [{ id: 'labels', name: 'Reference zone', columns: 3, rows: [
      { id: 'upper-labels', name: 'Upper floor', cells: [ids[0], null, ids[1]] },
      { id: 'lower-labels', name: 'Lower floor', cells: [ids[2], null, null] },
    ] }],
  }
  await publish(page, document)
  await page.reload()
  await page.getByRole('button', { name: 'Arrange dwellings', exact: true }).click()
  const editor = page.getByRole('dialog', { name: 'Arrange dwellings', exact: true })
  const rowOption = editor.getByRole('checkbox', { name: 'Show row names', exact: true })
  const columnOption = editor.getByRole('checkbox', { name: 'Show column names', exact: true })
  await expect(rowOption).not.toBeChecked()
  await expect(columnOption).not.toBeChecked()
  await expect(editor.getByText('Upper floor', { exact: true })).toBeVisible()
  await expect(editor.getByText('Column 1', { exact: true })).toBeVisible()
  await rowOption.check()
  await columnOption.check()
  await editor.getByRole('button', { name: 'Cancel', exact: true }).click()
  await page.getByRole('dialog', { name: 'Discard changes' }).getByRole('button', { name: 'Confirm', exact: true }).click()
  expect((await (await page.request.get('/api/neighbors/layout')).json()).layout).toEqual(document)

  for (const [rows, columns] of [[true, false], [false, true], [true, true], [false, false]]) {
    await page.goto('/admin/dwellings')
    await page.getByRole('button', { name: 'Arrange dwellings', exact: true }).click()
    await rowOption.setChecked(rows)
    await columnOption.setChecked(columns)
    await expect(editor.locator('.dwelling-layout-row-name')).toHaveCount(2)
    await expect(editor.locator('.dwelling-layout-column')).toHaveCount(3)
    await editor.getByRole('button', { name: 'Preview', exact: true }).click()
    const preview = editor.getByRole('region', { name: 'Directory preview', exact: true })
    await expect(preview.getByRole('region', { name: 'Reference zone', exact: true })).toBeVisible()
    await expect(preview.locator('.dwelling-layout-row-name')).toHaveCount(rows ? 2 : 0)
    await expect(preview.locator('.dwelling-layout-column')).toHaveCount(columns ? 3 : 0)
    await editor.getByRole('button', { name: 'Save layout', exact: true }).click()
    await expect(editor.getByText('Layout saved. It is now available to all neighbors.')).toBeVisible()
    await editor.getByRole('button', { name: 'Cancel', exact: true }).click()
    const saved: DwellingLayoutOut = await (await page.request.get('/api/neighbors/layout')).json()
    expect(saved.layout).toEqual({ ...document, show_row_names: rows, show_column_names: columns })
    for (const path of ['/neighbors', '/admin/neighbors']) {
      await page.goto(path)
      const zone = page.getByRole('region', { name: 'Reference zone', exact: true })
      await expect(zone).toBeVisible()
      await expect(zone.locator('.dwelling-layout-row-name')).toHaveCount(rows ? 2 : 0)
      await expect(zone.locator('.dwelling-layout-column')).toHaveCount(columns ? 3 : 0)
      await expect(zone.locator('[data-cell="cell:labels:upper-labels:1"] .neighbor-dwelling')).toHaveCount(0)
      const first = await zone.getByRole('region', { name: 'Reference A', exact: true }).boundingBox()
      const last = await zone.getByRole('region', { name: 'Reference C', exact: true }).boundingBox()
      const lower = await zone.getByRole('region', { name: 'Reference D', exact: true }).boundingBox()
      const grid = await zone.locator('.dwelling-layout-scroll').boundingBox()
      if (!first || !last || !lower || !grid) throw new Error('The saved dwelling grid must be visible')
      expect(Math.abs(first.x - lower.x)).toBeLessThanOrEqual(1)
      expect(last.x - first.x).toBeGreaterThan(first.width * 2)
      expect(lower.y).toBeGreaterThanOrEqual(first.y + first.height)
      if (!rows) expect(Math.abs(first.x - grid.x)).toBeLessThanOrEqual(1)
      if (!columns) expect(Math.abs(first.y - grid.y)).toBeLessThanOrEqual(1)
    }
  }
  await page.setViewportSize({ width: 390, height: 844 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
  await page.screenshot({ path: info.outputPath('neighbors-without-row-column-names.png'), fullPage: true, animations: 'disabled' })
  await page.goto('/admin/dwellings')
  await page.getByRole('button', { name: 'Arrange dwellings', exact: true }).click()
  await expect(rowOption).not.toBeChecked()
  await expect(columnOption).not.toBeChecked()
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
})
