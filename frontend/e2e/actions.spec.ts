import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { test, expect, type APIRequestContext, type Locator, type Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'

const password = 'synthetic actions resident password'
test.use({ actionTimeout: 15_000 })

function syntheticPDF() {
  const python = resolve('..', '.venv', process.platform === 'win32' ? 'Scripts' : 'bin', process.platform === 'win32' ? 'python.exe' : 'python')
  return execFileSync(python, ['-c', [
    'import io, sys',
    'from reportlab.pdfgen import canvas',
    'output = io.BytesIO()',
    'pdf = canvas.Canvas(output)',
    'pdf.drawString(50, 750, "Synthetic community repair quote")',
    'pdf.save()',
    'sys.stdout.buffer.write(output.getvalue())',
  ].join('; ')])
}

async function activateResident(admin: APIRequestContext, resident: APIRequestContext, origin: string, dwellingId: number, email: string, name: string) {
  const headers = { Origin: origin, 'X-Juntia-Request': '1' }
  const invited = await admin.post('/api/admin/users', { headers, data: { name, email, dwelling_id: dwellingId } })
  expect(invited.status()).toBe(201)
  const messages: { to: string; body: string }[] = await (await admin.get('/api/admin/test-mailbox')).json()
  const token = messages.toReversed().find(message => message.to === email)?.body.match(/#token=([a-f0-9]{64})/)?.[1]
  expect(token).toBeTruthy()
  expect((await resident.post('/api/auth/activate', { headers, data: { token, password } })).status()).toBe(204)
}

async function signIn(page: Page, email: string, target: string) {
  await page.goto(target)
  await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible()
  await page.getByLabel('Email', { exact: true }).fill(email)
  await page.getByLabel('Password', { exact: true }).fill(password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page).toHaveURL(new RegExp('/actions'))
}

async function expectDescriptionLayout(page: Page, title: string) {
  await expect(page.locator('.action-heading').getByRole('combobox', { name: `Status of ${title}`, exact: true })).toBeVisible()
  await expect(page.locator('.action-details select')).toHaveCount(0)
  const layout = await page.locator('.action-details').evaluate(element => {
    const description = element.querySelector('.action-text')
    const controls = document.querySelector('.action-heading-controls')
    if (!description || !controls) throw new Error('Missing description or heading controls')
    const style = getComputedStyle(element)
    const width = element.clientWidth - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight)
    return {
      fullWidth: description.getBoundingClientRect().width / width,
      controlsAbove: controls.getBoundingClientRect().bottom <= element.getBoundingClientRect().top,
    }
  })
  expect(layout.fullWidth).toBeGreaterThanOrEqual(0.99)
  expect(layout.controlsAbove).toBe(true)
}

async function expectDistinctStateColors(page: Page) {
  const badges = page.locator('.action-column h2 .action-status')
  await expect(badges).toHaveCount(8)
  const colors = await badges.evaluateAll(elements => elements.map(element => ({
    color: getComputedStyle(element).color,
    background: getComputedStyle(element).backgroundColor,
  })))
  expect(new Set(colors.map(value => value.color)).size).toBe(8)
  expect(new Set(colors.map(value => value.background)).size).toBe(8)
}

async function expectLabelColors(label: Locator, colors: { color: string; background: string }) {
  await expect(label).toHaveCSS('color', colors.color)
  await expect(label).toHaveCSS('background-color', colors.background)
}

async function expectHistoryDiff(history: Locator, dark = false) {
  const event = history.locator('.action-history-list > li').filter({ hasText: 'Updated the action' }).last()
  await event.locator('summary').click()
  const diff = event.getByRole('group', { name: 'Changes to description', exact: true })
  await expect(diff.getByText('The door closer does not latch.', { exact: true })).toHaveCount(1)
  await expect(diff.locator('del')).toHaveText(['Request quotes.'])
  await expect(diff.locator('ins')).toHaveText(['Quotes received.', 'Pending approval.'])
  await expect(history.getByText('+ Added', { exact: true })).toHaveCount(0)
  await expect(history.getByText('- Removed', { exact: true })).toHaveCount(0)
  await expect(diff.locator('.action-diff-removed')).toHaveCSS('color', dark ? 'rgb(244, 128, 111)' : 'rgb(180, 60, 50)')
  await expect(diff.locator('.action-diff-added').first()).toHaveCSS('color', dark ? 'rgb(46, 211, 167)' : 'rgb(8, 115, 90)')
  expect(await diff.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
}

test('shared actions, retained PDFs and comments, paged Kanban, drag and mobile controls', async ({ page, browser }, testInfo) => {
  test.skip(Boolean(process.env.E2E_BASE_URL), 'Requires the disposable server and synthetic mailbox')
  test.setTimeout(180_000)
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto('/admin')
  await page.getByLabel('Username', { exact: true }).fill('browser-test')
  await page.getByLabel('Password', { exact: true }).fill('synthetic-browser-test-password')
  await page.getByRole('button', { name: 'Sign in to administration' }).click()
  await page.getByRole('link', { name: 'Community portal' }).click()
  await page.getByRole('link', { name: 'Actions', exact: true }).click()
  await expect(page).toHaveURL(/\/actions$/)
  await expect(page.getByRole('heading', { name: 'Actions', exact: true })).toBeVisible()
  const origin = new URL(page.url()).origin
  const headers = { Origin: origin, 'X-Juntia-Request': '1' }
  const features = await (await page.request.get('/api/features')).json()
  const unit = await page.request.post('/api/admin/dwellings', {
    headers, data: { label: 'Actions E2E 1 A', ...(features.coefficient ? { coefficient: '12.50' } : {}) },
  })
  expect(unit.status()).toBe(201)
  const dwellingId = (await unit.json()).id
  const firstContext = await browser.newContext({ baseURL: origin, locale: 'en-GB' })
  const secondContext = await browser.newContext({ baseURL: origin, locale: 'en-GB' })
  try {
    const firstEmail = 'actions-alice@example.org', secondEmail = 'actions-ben@example.org'
    await activateResident(page.request, firstContext.request, origin, dwellingId, firstEmail, 'Alice Actions')
    await activateResident(page.request, secondContext.request, origin, dwellingId, secondEmail, 'Ben Actions')
    const first = await firstContext.newPage(), second = await secondContext.newPage()
    first.on('pageerror', error => errors.push(error.message)); second.on('pageerror', error => errors.push(error.message))
    await signIn(first, firstEmail, '/actions?view=board')
    await expect(first.getByRole('region', { name: 'Actions board', exact: true })).toBeVisible()
    await expect(first.locator('nav a[href^="/admin"]')).toHaveCount(0)
    await first.getByRole('button', { name: 'New action', exact: true }).click()
    const editor = first.getByRole('dialog', { name: 'New action' })
    await editor.getByLabel('Title', { exact: true }).fill('Actions E2E street door')
    await editor.getByRole('textbox', { name: 'Description', exact: true }).fill('The door closer does not latch.\nRequest quotes.')
    const labels = editor.getByRole('combobox', { name: 'Labels', exact: true })
    await labels.fill('Doors')
    await labels.press('Enter')
    await expect(editor.getByRole('button', { name: 'Remove doors', exact: true })).toBeVisible()
    const labelColors = await editor.locator('.contact-tag-chip').evaluate(element => ({
      color: getComputedStyle(element).color,
      background: getComputedStyle(element).backgroundColor,
    }))
    await expect(editor.getByRole('combobox', { name: 'Status', exact: true })).toHaveCount(0)
    await editor.getByRole('button', { name: 'Save action' }).click()
    await expect(editor).toHaveCount(0)
    await expect(first).toHaveURL(/\/actions\/[0-9]+\?view=board$/)
    const itemId = Number(new URL(first.url()).pathname.split('/').at(-1))
    const endpoint = `/api/actions/items/${itemId}`
    expect(itemId).toBeGreaterThan(0)
    await expect(first.getByRole('combobox', { name: 'Status of Actions E2E street door', exact: true })).toHaveValue('detected')
    await expectDescriptionLayout(first, 'Actions E2E street door')
    await expectLabelColors(first.locator('.action-heading .contact-tag'), labelColors)
    await first.getByLabel('New comment', { exact: true }).fill('Request two quotes.')
    await first.getByRole('button', { name: 'Post comment' }).click()
    await expect(first.locator('.action-comment-list').getByText('Request two quotes.', { exact: true })).toBeVisible()
    const firstComment = (await (await first.request.get(endpoint + '/comments')).json()).items[0]
    const pdf = syntheticPDF()
    const files = first.getByRole('region', { name: 'Attachments', exact: true })
    await expect(first.getByRole('heading', { name: 'Change history', exact: true })).toHaveCount(0)
    await expect(first.getByText('You can skip stages and reopen actions.', { exact: false })).toHaveCount(0)
    await expect(files.getByRole('checkbox', { name: 'Show withdrawn PDFs', exact: true })).toHaveCount(0)
    const chooser = first.waitForEvent('filechooser')
    await files.getByRole('button', { name: 'Upload PDF', exact: true }).click()
    await (await chooser).setFiles([
      { name: 'quote-a.pdf', mimeType: 'application/pdf', buffer: pdf },
      { name: 'quote-b.pdf', mimeType: 'application/pdf', buffer: pdf },
    ])
    await expect(files.getByRole('button', { name: 'Download quote-a.pdf', exact: true })).toBeVisible()
    await expect(files.getByRole('button', { name: 'Download quote-b.pdf', exact: true })).toBeVisible()
    await expect(files.getByRole('button', { name: 'Clear queue', exact: true })).toHaveCount(0)
    await expect(files.getByRole('button', { name: 'Upload PDFs', exact: true })).toHaveCount(0)
    await files.getByRole('button', { name: 'Rename quote-a.pdf', exact: true }).click()
    const rename = first.getByRole('dialog', { name: 'Rename PDF', exact: true })
    await rename.getByLabel('PDF name', { exact: true }).fill('quote-street-door')
    await rename.getByRole('button', { name: 'Save name', exact: true }).click()
    await expect(rename).toHaveCount(0)
    await expect(files.getByRole('button', { name: 'Download quote-street-door.pdf', exact: true })).toBeVisible()
    const viewPDF = files.getByRole('link', { name: 'View quote-street-door.pdf (new tab)', exact: true })
    await expect(viewPDF.locator('svg')).toHaveCount(1)
    expect(await viewPDF.evaluate(element => element.parentElement?.firstElementChild === element)).toBe(true)
    await expect(viewPDF).toHaveAttribute('target', '_blank')
    await expect(viewPDF).toHaveAttribute('rel', 'noopener noreferrer')
    const previewURL = await viewPDF.getAttribute('href')
    if (!previewURL) throw new Error('Missing PDF preview link')
    const response = await first.request.get(previewURL)
    expect(response.status()).toBe(200)
    expect(response.headers()['content-disposition']).toBe('inline; filename="quote-street-door.pdf"')
    expect(response.headers()['cache-control']).toBe('no-store')
    expect(await response.body()).toEqual(pdf)
    expect((await new AxeBuilder({ page: first }).analyze()).violations).toEqual([])
    await files.screenshot({ path: testInfo.outputPath('actions-attachments-desktop.png') })

    await signIn(second, secondEmail, `/actions/${itemId}?view=board`)
    await expect(second.getByRole('heading', { name: 'Actions E2E street door', exact: true })).toBeVisible()
    await expect(second.getByRole('button', { name: `Edit comment ${firstComment.id}`, exact: true })).toHaveCount(0)
    await expect(second.getByRole('button', { name: 'Withdraw quote-street-door.pdf', exact: true })).toHaveCount(0)
    await expect(second.getByRole('button', { name: 'Rename quote-street-door.pdf', exact: true })).toHaveCount(0)
    await expect(second.getByRole('link', { name: 'View quote-street-door.pdf (new tab)', exact: true })).toBeVisible()
    await second.getByRole('button', { name: 'Edit action', exact: true }).click()
    const edit = second.getByRole('dialog', { name: 'Edit action' })
    await expectLabelColors(edit.locator('.contact-tag-chip'), labelColors)
    const title = 'Actions E2E street door revised'
    await edit.getByLabel('Title', { exact: true }).fill(title)
    await edit.getByRole('textbox', { name: 'Description', exact: true }).fill('The door closer does not latch.\nQuotes received.\nPending approval.')
    await edit.getByRole('button', { name: 'Save action' }).click()
    await expect(edit).toHaveCount(0)
    await second.getByRole('combobox', { name: `Status of ${title}`, exact: true }).selectOption('quoting')
    await expect(second.getByRole('combobox', { name: `Status of ${title}`, exact: true })).toHaveValue('quoting')
    await second.getByLabel('New comment', { exact: true }).fill('I have contacted two suppliers.')
    await second.getByRole('button', { name: 'Post comment' }).click()
    await expect(second.locator('.action-comment-list').getByText('I have contacted two suppliers.', { exact: true })).toBeVisible()
    expect((await second.request.get('/api/admin/statements')).status()).toBe(401)

    await first.reload()
    await expect(first.getByRole('heading', { name: title, exact: true })).toBeVisible()
    const quotingColors = await first.locator('.page-heading .action-status-quoting').evaluate(element => ({
      color: getComputedStyle(element).color,
      background: getComputedStyle(element).backgroundColor,
    }))
    await first.getByRole('button', { name: `Edit comment ${firstComment.id}`, exact: true }).click()
    const commentEditor = first.getByRole('dialog', { name: 'Edit comment' })
    await commentEditor.getByRole('textbox', { name: 'Comment', exact: true }).fill('Request three quotes.')
    await commentEditor.getByRole('button', { name: 'Save comment' }).click()
    await expect(commentEditor).toHaveCount(0)
    await files.getByRole('button', { name: 'Withdraw quote-street-door.pdf', exact: true }).click()
    await first.getByRole('dialog', { name: 'Withdraw PDF', exact: true }).getByRole('button', { name: 'Confirm withdrawal' }).click()
    await expect(first.getByRole('dialog')).toHaveCount(0)
    await expect(files.getByRole('button', { name: 'Download quote-street-door.pdf', exact: true })).toHaveCount(0)
    const historyButton = first.getByRole('button', { name: 'History', exact: true })
    await historyButton.click()
    const history = first.getByRole('dialog', { name: 'Change history', exact: true })
    await expect(history).toBeVisible()
    await expectHistoryDiff(history)
    const editedComment = history.locator('.action-history-list > li').filter({ hasText: 'Edited a comment' })
    await editedComment.locator('summary').click()
    await expect(editedComment.locator('del')).toHaveText(['Request two quotes.'])
    await expect(editedComment.locator('ins')).toHaveText(['Request three quotes.'])
    const downloaded = first.waitForEvent('download', { timeout: 15_000 })
    await history.getByRole('button', { name: 'Download quote-street-door.pdf', exact: true }).first().click()
    const download = await downloaded
    expect(download.suggestedFilename()).toBe('quote-street-door.pdf')
    const downloadPath = await download.path()
    if (!downloadPath) throw new Error('The retained PDF was not downloaded')
    expect(await readFile(downloadPath)).toEqual(pdf)
    const events = (await (await first.request.get(endpoint + '/history')).json()).items
    expect(events.some((event: { author: { name: string }; kind: string }) => event.kind === 'updated' && event.author.name === 'Ben Actions')).toBe(true)
    expect(events.some((event: { changes: { before: unknown; after: unknown }[] }) => event.changes.some(change => change.before === 'Request two quotes.' && change.after === 'Request three quotes.'))).toBe(true)
    expect(events.some((event: { kind: string }) => event.kind === 'attachment_withdrawn')).toBe(true)
    expect(events.some((event: { kind: string }) => event.kind === 'attachment_renamed')).toBe(true)
    expect((await new AxeBuilder({ page: first }).analyze()).violations).toEqual([])
    await first.screenshot({ path: testInfo.outputPath('actions-history-modal.png'), fullPage: true })
    await first.keyboard.press('Escape')
    await expect(history).toHaveCount(0)
    await expect(historyButton).toBeFocused()
    await expect(first.getByRole('heading', { name: 'Change history', exact: true })).toHaveCount(0)
    await first.screenshot({ path: testInfo.outputPath('actions-detail-desktop.png'), fullPage: true })

    for (let index = 0; index < 23; index++) {
      const response = await first.request.post('/api/actions/items', {
        headers, data: { title: `Actions E2E pending ${index}`, labels: ['Doors'] },
      })
      expect(response.status()).toBe(201)
    }
    await first.getByRole('link', { name: 'Back to actions' }).click()
    await first.getByRole('combobox', { name: 'Show', exact: true }).selectOption('all')
    await first.getByLabel('Search actions', { exact: true }).fill('Actions E2E')
    const detected = first.getByRole('region', { name: 'Detected', exact: true })
    await expect(detected.locator('.action-board-card')).toHaveCount(20)
    await expect(detected.getByText('0 comments · 0 attachments', { exact: true })).toHaveCount(20)
    await detected.getByRole('button', { name: 'Next: Detected column', exact: true }).click()
    await expect(detected.locator('.action-board-card')).toHaveCount(3)
    const quoting = first.getByRole('region', { name: 'Requesting quotes', exact: true })
    await expect(quoting.locator('h2 .action-status-quoting')).toHaveCSS('color', quotingColors.color)
    await expect(quoting.locator('h2 .action-status-quoting')).toHaveCSS('background-color', quotingColors.background)
    const done = first.getByRole('region', { name: 'Done', exact: true })
    const card = quoting.locator('.action-board-card').filter({ hasText: title })
    await expectLabelColors(card.locator('.contact-tag'), labelColors)
    await expect(card.locator('.action-card-counts')).toHaveText('2 comments · 1 attachment')
    const handle = card.locator('.action-drag-handle')
    await handle.hover()
    const source = await handle.boundingBox()
    if (!source) throw new Error('Missing drag handle')
    await first.mouse.down()
    try {
      // Begin the native drag before panning to a column outside the viewport.
      await first.mouse.move(source.x + source.width / 2 + 12, source.y + source.height / 2, { steps: 5 })
      await done.scrollIntoViewIfNeeded()
      const target = await done.boundingBox()
      if (!target) throw new Error('Missing destination column')
      await first.mouse.move(target.x + target.width / 2, target.y + 80, { steps: 10 })
      await first.mouse.move(target.x + target.width / 2, target.y + 90)
    } finally {
      await first.mouse.up()
    }
    await expect(done.getByRole('link', { name: title, exact: true })).toBeVisible()
    await first.reload()
    await expect(first.getByRole('region', { name: 'Done', exact: true }).getByRole('link', { name: title, exact: true })).toBeVisible()
    await expectDistinctStateColors(first)
    expect((await new AxeBuilder({ page: first }).analyze()).violations).toEqual([])
    await first.screenshot({ path: testInfo.outputPath('actions-kanban-desktop.png'), fullPage: true })
    await first.getByRole('button', { name: 'Dark mode', exact: true }).click()
    await expectDistinctStateColors(first)
    await expectLabelColors(first.getByRole('region', { name: 'Done', exact: true }).locator('.contact-tag'), labelColors)
    expect((await new AxeBuilder({ page: first }).analyze()).violations).toEqual([])
    await first.screenshot({ path: testInfo.outputPath('actions-kanban-dark.png'), fullPage: true })
    await first.getByRole('button', { name: 'Light mode', exact: true }).click()

    await first.getByRole('button', { name: 'List', exact: true }).click()
    const firstListed = first.locator('.actions-table tbody .action-title-link').first()
    await expect(first.getByRole('columnheader', { name: 'Activity', exact: true })).toHaveAttribute('aria-sort', 'descending')
    await first.getByRole('button', { name: 'Sort by action', exact: true }).click()
    await expect(first.getByRole('columnheader', { name: 'Action', exact: true })).toHaveAttribute('aria-sort', 'ascending')
    await expect(firstListed).toContainText('Actions E2E pending 0')
    await first.getByRole('button', { name: 'Sort by action', exact: true }).click()
    await expect(first.getByRole('columnheader', { name: 'Action', exact: true })).toHaveAttribute('aria-sort', 'descending')
    await expect(firstListed).toContainText(title)
    await first.getByRole('button', { name: 'Next: actions', exact: true }).click()
    await expect(first).toHaveURL(/page=2/)
    await first.getByRole('button', { name: 'Sort by status', exact: true }).click()
    await expect(first).not.toHaveURL(/page=2/)
    await expect(first.getByRole('columnheader', { name: 'Status', exact: true })).toHaveAttribute('aria-sort', 'ascending')
    await expect(first.locator('.actions-table tbody select').first()).toHaveValue('detected')
    await first.getByRole('button', { name: 'Sort by status', exact: true }).click()
    await expect(first.locator('.actions-table tbody select').first()).toHaveValue('done')
    const activitySort = first.getByRole('button', { name: 'Sort by activity', exact: true })
    await activitySort.focus()
    await activitySort.press('Enter')
    await expect(first.getByRole('columnheader', { name: 'Activity', exact: true })).toHaveAttribute('aria-sort', 'descending')
    await expect(firstListed).toContainText(title)
    await expect(activitySort).toBeFocused()
    await activitySort.press('Enter')
    await expect(first.getByRole('columnheader', { name: 'Activity', exact: true })).toHaveAttribute('aria-sort', 'ascending')
    await expect(firstListed).toContainText('Actions E2E pending 0')
    await activitySort.press('Enter')
    await expect(firstListed).toContainText(title)
    await expect(first.getByLabel('Search actions', { exact: true })).toHaveValue('Actions E2E')
    await expect(first.getByRole('combobox', { name: 'Show', exact: true })).toHaveValue('all')
    await expectLabelColors(first.locator('.actions-table tbody .contact-tag').first(), labelColors)
    await expect(first.locator('.actions-table tbody .action-status-control label').filter({ hasText: 'Status' })).toHaveCount(0)
    await first.screenshot({ path: testInfo.outputPath('actions-list-desktop.png'), fullPage: true })

    await first.setViewportSize({ width: 390, height: 844 })
    await first.getByRole('button', { name: 'List', exact: true }).click()
    await expect(first.getByRole('columnheader', { name: 'Comments and attachments', exact: true })).toBeVisible()
    await first.getByRole('combobox', { name: `Status of ${title}`, exact: true }).selectOption('detected')
    await expect(first.getByRole('combobox', { name: `Status of ${title}`, exact: true })).toHaveValue('detected')
    await first.getByRole('link', { name: `#${itemId} · ${title}`, exact: true }).click()
    await expect(first.getByRole('heading', { name: title, exact: true })).toBeVisible()
    await expectDescriptionLayout(first, title)
    expect(await first.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    expect((await new AxeBuilder({ page: first }).analyze()).violations).toEqual([])
    await first.screenshot({ path: testInfo.outputPath('actions-detail-mobile.png'), fullPage: true })
    await historyButton.click()
    await expect(history).toBeVisible()
    await expectHistoryDiff(history)
    expect(await history.evaluate(element => {
      const box = element.getBoundingClientRect()
      return box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight
    })).toBe(true)
    expect((await new AxeBuilder({ page: first }).analyze()).violations).toEqual([])
    await history.getByRole('button', { name: 'Close', exact: true }).click()
    await first.getByRole('button', { name: 'Dark mode', exact: true }).click()
    await historyButton.click()
    await expectHistoryDiff(history, true)
    expect((await new AxeBuilder({ page: first }).analyze()).violations).toEqual([])
    await first.screenshot({ path: testInfo.outputPath('actions-history-dark-mobile.png'), fullPage: true })
    await history.getByRole('button', { name: 'Close', exact: true }).click()
    expect(errors).toEqual([])
  } finally {
    await firstContext.close(); await secondContext.close()
  }
})
