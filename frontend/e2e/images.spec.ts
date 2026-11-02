import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'

const password = 'synthetic images resident password'
test.use({ actionTimeout: 15_000 })

async function adminLogin(page: Page) {
  await page.goto('/admin/storage')
  await page.getByLabel('Username', { exact: true }).fill('browser-test')
  await page.getByLabel('Password', { exact: true }).fill('synthetic-browser-test-password')
  await page.getByRole('button', { name: 'Sign in to administration' }).click()
  await expect(page.getByRole('heading', { name: 'Storage', exact: true })).toBeVisible()
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
  await page.getByLabel('Email', { exact: true }).fill(email)
  await page.getByLabel('Password', { exact: true }).fill(password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page).toHaveURL(new RegExp(target.replace('?', '\\?')))
}

async function fillEventDate(container: Locator, name: string, value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value)
  if (!match) throw new Error(`Invalid test date: ${value}`)
  const field = container.locator(`[data-event-date-field="${name}"]`)
  for (const [type, part] of [['day', match[3]], ['month', match[2]], ['year', match[1]], ['hour', match[4]], ['minute', match[5]]]) {
    const segment = field.locator(`[data-type="${type}"]`)
    await segment.focus()
    await segment.pressSequentially(part)
  }
  await field.locator('[role="spinbutton"]').last().press('Tab')
}

/** Pastes a synthetic PNG drawn in the page, as a screenshot tool leaves it on the clipboard. */
async function pasteImage(field: Locator, width: number, height: number, name = 'image.png') {
  await field.focus()
  await field.evaluate(async (element, image) => {
    const canvas = document.createElement('canvas')
    canvas.width = image.width
    canvas.height = image.height
    const context = canvas.getContext('2d')
    if (!context) throw new Error('No canvas')
    context.fillStyle = '#21639f'
    context.fillRect(0, 0, image.width, image.height)
    context.fillStyle = '#12b886'
    context.fillRect(image.width / 4, image.height / 4, image.width / 2, image.height / 2)
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'))
    if (!blob) throw new Error('No PNG')
    const clipboard = new DataTransfer()
    clipboard.items.add(new File([blob], image.name, { type: 'image/png' }))
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: clipboard, bubbles: true, cancelable: true }))
  }, { width, height, name })
}

async function expectLoaded(image: Locator, width: number) {
  await expect(image).toBeVisible()
  await expect.poll(() => image.evaluate(element => (element as HTMLImageElement).naturalWidth)).toBe(width)
}

test.afterEach(async ({ page }) => {
  if (process.env.E2E_BASE_URL || page.url() === 'about:blank') return
  const headers = { Origin: new URL(page.url()).origin, 'X-Juntia-Request': '1' }
  expect((await page.request.patch('/api/admin/settings/features/events', { headers, data: { enabled: false } })).status()).toBe(200)
})

test('pasted images are reduced, uploaded and shown in actions, comments and events, and the administrator can delete them', async ({ page, browser }) => {
  test.skip(Boolean(process.env.E2E_BASE_URL), 'Requires the disposable server and synthetic mailbox')
  test.setTimeout(180_000)
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await adminLogin(page)
  const origin = new URL(page.url()).origin
  const headers = { Origin: origin, 'X-Juntia-Request': '1' }
  expect((await page.request.patch('/api/admin/settings/features/events', { headers, data: { enabled: true } })).status()).toBe(200)
  const features = await (await page.request.get('/api/features')).json()
  const unit = await page.request.post('/api/admin/dwellings', {
    headers, data: { label: 'Images E2E 2 B', ...(features.coefficient ? { coefficient: '10.00' } : {}) },
  })
  expect(unit.status()).toBe(201)
  const residentContext = await browser.newContext({ baseURL: origin, locale: 'en-GB' })
  try {
    const email = 'images-alice@example.org'
    await activateResident(page.request, residentContext.request, origin, (await unit.json()).id, email, 'Alice Images')
    const resident = await residentContext.newPage()
    resident.on('pageerror', error => errors.push(error.message))
    await signIn(resident, email, '/actions')

    // A screenshot pasted into a new action's description: reduced to 2560 pixels, then shown in the preview.
    await resident.getByRole('button', { name: 'New action', exact: true }).click()
    const editor = resident.getByRole('dialog', { name: 'New action' })
    await editor.getByLabel('Title', { exact: true }).fill('Images E2E roof leak')
    const description = editor.getByRole('textbox', { name: 'Description', exact: true })
    await description.fill('The **north** corner leaks:\n')
    await pasteImage(description, 3000, 2000, 'image.png')
    await expect(description).toHaveValue(/^The \*\*north\*\* corner leaks:\n!\[Image\]\(\/api\/actions\/images\/[0-9a-f-]{36}\)$/)
    await expect(editor.getByText(/^Uploading/)).toHaveCount(0)
    const address = /\((\/api\/actions\/images\/[0-9a-f-]{36})\)/.exec(await description.inputValue())?.[1] ?? ''
    const served = await resident.request.get(address)
    expect(served.status()).toBe(200)
    expect(served.headers()['content-type']).toBe('image/png')
    expect(served.headers()['cache-control']).toBe('no-store')
    await editor.getByRole('tab', { name: 'Preview' }).click()
    await expect(editor.getByText('north', { exact: true })).toHaveJSProperty('tagName', 'STRONG')
    await expectLoaded(editor.getByRole('img', { name: 'Image' }), 2560)
    expect((await new AxeBuilder({ page: resident }).analyze()).violations).toEqual([])
    await editor.getByRole('button', { name: 'Save action' }).click()
    await expect(editor).toHaveCount(0)
    await expect(resident).toHaveURL(/\/actions\/[0-9]+$/)
    const details = resident.locator('.action-details')
    await expectLoaded(details.getByRole('img', { name: 'Image' }), 2560)

    // A second image, in a comment, named after its file.
    const comment = resident.getByLabel('New comment', { exact: true })
    await comment.fill('Photo after the rain:')
    await pasteImage(comment, 400, 300, 'after the rain.png')
    await expect(comment).toHaveValue(/^Photo after the rain:\n!\[after the rain\]\(\/api\/actions\/images\/[0-9a-f-]{36}\)$/)
    await resident.getByRole('button', { name: 'Post comment', exact: true }).click()
    const comments = resident.locator('.action-comment-list')
    await expectLoaded(comments.getByRole('img', { name: 'after the rain' }), 400)
    expect((await new AxeBuilder({ page: resident }).analyze()).violations).toEqual([])

    // The administrator sees both images in Storage and deletes the comment's for good.
    await page.reload()
    const images = page.getByRole('region', { name: 'Images in texts' })
    const listed = images.getByRole('list', { name: 'Images in texts' }).getByRole('listitem')
    await expect(listed).toHaveCount(2)
    await expect(listed.first()).toContainText('after the rain.png')
    await expect(listed.first()).toContainText('400 × 300 px · Actions')
    await expect(listed.nth(1)).toContainText('2,560 × 1,707 px · Actions')
    await expect(listed.first()).toContainText('Uploaded by Alice Images')
    await expectLoaded(listed.first().locator('img'), 400)
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
    await images.getByRole('button', { name: 'Delete permanently: after the rain.png' }).click()
    const confirm = page.getByRole('dialog', { name: 'Delete image permanently' })
    await expect(confirm.getByText('The descriptions, comments and history entries that show it will say "Image not available" instead.')).toBeVisible()
    await confirm.getByRole('button', { name: 'Delete permanently' }).click()
    await expect(images.getByText('after the rain.png has been deleted permanently.', { exact: false })).toBeVisible()
    await expect(listed).toHaveCount(1)
    await resident.reload()
    await expect(comments.getByText('Image not available: after the rain')).toBeVisible()
    await expectLoaded(details.getByRole('img', { name: 'Image' }), 2560)

    // Event descriptions take images too, stored with the events.
    await resident.goto('/events')
    await resident.getByRole('button', { name: 'New event', exact: true }).click()
    const eventEditor = resident.getByRole('dialog', { name: 'New event', exact: true })
    await eventEditor.getByLabel('Title', { exact: true }).fill('Images E2E roof visit')
    const eventDescription = eventEditor.getByRole('textbox', { name: 'Description', exact: true })
    await pasteImage(eventDescription, 640, 480, 'meeting point.png')
    await expect(eventDescription).toHaveValue(/^!\[meeting point\]\(\/api\/events\/images\/[0-9a-f-]{36}\)$/)
    await fillEventDate(eventEditor, 'starts_at', '2035-06-10T18:00')
    await fillEventDate(eventEditor, 'ends_at', '2035-06-10T19:00')
    await eventEditor.getByRole('button', { name: 'Save event' }).click()
    const dialog = resident.getByRole('dialog', { name: 'Images E2E roof visit' })
    await expectLoaded(dialog.getByRole('img', { name: 'meeting point' }), 640)
    expect((await new AxeBuilder({ page: resident }).analyze()).violations).toEqual([])
    expect(errors).toEqual([])
  } finally {
    await residentContext.close()
  }
})
