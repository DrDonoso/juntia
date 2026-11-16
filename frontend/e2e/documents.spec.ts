import { readFile } from 'node:fs/promises'
import { expect, test, type BrowserContext, type Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'

const password = 'synthetic documents resident password'

/** A one-page PDF that browsers can display. */
function pdf(text: string): Buffer {
  const stream = `BT /F1 24 Tf 40 100 Td (${text}) Tj ET`
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let body = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((object, index) => { offsets.push(body.length); body += `${index + 1} 0 obj\n${object}\nendobj\n` })
  const xref = body.length
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(body, 'latin1')
}

async function resident(context: BrowserContext, admin: Page, email: string, name: string, dwellingId: number) {
  const headers = { Origin: new URL(admin.url()).origin, 'X-Juntia-Request': '1' }
  expect((await admin.request.post('/api/admin/users', { headers, data: { name, email, dwelling_id: dwellingId } })).status()).toBe(201)
  const messages: { to: string; body: string }[] = await (await admin.request.get('/api/admin/test-mailbox')).json()
  const token = [...messages].reverse().find(item => item.to === email)?.body.match(/\/activate#token=([a-f0-9]{64})/)?.[1]
  if (!token) throw new Error('Synthetic invitation token was not delivered')
  const page = await context.newPage()
  expect((await page.request.post('/api/auth/activate', { headers, data: { token, password } })).status()).toBe(204)
  await page.goto('/documents')
  await page.getByLabel('Email', { exact: true }).fill(email)
  await page.getByLabel('Password', { exact: true }).fill(password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page).toHaveURL(/\/documents$/)
  return page
}

async function choose(page: Page, name: string, option: string) {
  await page.getByRole('button', { name: `Options for ${name}`, exact: true }).click()
  await page.getByRole('menu', { name: `Options for ${name}` }).getByRole('menuitem', { name: option, exact: true }).click()
}

test.afterEach(async ({ page }) => {
  if (process.env.E2E_BASE_URL || page.url() === 'about:blank') return
  const headers = { Origin: new URL(page.url()).origin, 'X-Juntia-Request': '1' }
  expect((await page.request.patch('/api/admin/settings/documents', { headers, data: {
    manage_policy: 'creator', max_file_mb: 50, max_video_mb: 1024, user_quota_mb: 2048, community_quota_mb: 20480,
  } })).status()).toBe(200)
  expect((await page.request.patch('/api/admin/settings/features/documents', { headers, data: { enabled: false } })).status()).toBe(200)
  expect((await page.request.post('/api/admin/test-reset-login-attempts', { headers })).status()).toBe(204)
})

test('neighbors share folders and files, preview PDFs, follow their history and download them together', async ({ page: admin, browser }) => {
  test.skip(Boolean(process.env.E2E_BASE_URL), 'Requires disposable data and the synthetic mailbox')
  test.setTimeout(180_000)
  const errors: string[] = []
  admin.on('pageerror', error => errors.push(error.message))
  await admin.goto('/admin/features')
  await admin.getByLabel('Username', { exact: true }).fill('browser-test')
  await admin.getByLabel('Password', { exact: true }).fill('synthetic-browser-test-password')
  await admin.getByRole('button', { name: 'Sign in to administration' }).click()
  const toggle = admin.getByRole('switch', { name: 'Documents', exact: true })
  await expect(toggle).toHaveAttribute('aria-checked', 'false')
  await expect(admin.getByRole('heading', { name: 'Who can change shared documents' })).toHaveCount(0)
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-checked', 'true')
  await expect(admin.getByRole('radio', { name: /^Whoever created them/ })).toBeChecked()
  const origin = new URL(admin.url()).origin
  const headers = { Origin: origin, 'X-Juntia-Request': '1' }
  const unit: { id: number } = await (await admin.request.post('/api/admin/dwellings', {
    headers, data: { label: 'Documents E2E dwelling', coefficient: '1.00' },
  })).json()
  const first = await browser.newContext({ baseURL: origin, locale: 'en-GB' })
  const second = await browser.newContext({ baseURL: origin, locale: 'en-GB' })
  // Ana's browser shows PDFs inside pages, like desktop browsers do.
  await first.addInitScript(() => Object.defineProperty(Navigator.prototype, 'pdfViewerEnabled', { configurable: true, get: () => true }))
  try {
    const ana = await resident(first, admin, 'documents-ana@example.org', 'Ana Documents', unit.id)
    const leo = await resident(second, admin, 'documents-leo@example.org', 'Leo Documents', unit.id)
    for (const page of [ana, leo]) page.on('pageerror', error => errors.push(error.message))
    await expect(ana.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Documents', exact: true }))
      .toHaveAttribute('aria-current', 'page')
    await expect(ana.getByText('There are no documents yet. Create a folder or upload the first files.')).toBeVisible()
    await expect(ana.getByText('Everything here is visible to every neighbor. Do not upload documents with private information.')).toBeVisible()

    await ana.getByRole('button', { name: 'New folder' }).click()
    const creation = ana.getByRole('dialog', { name: 'New folder' })
    await creation.getByLabel('Folder name').fill('Minutes 2026')
    await creation.getByRole('button', { name: 'Create folder' }).click()
    await expect(ana.getByText('Folder “Minutes 2026” created.')).toBeVisible()
    await ana.getByRole('link', { name: 'Minutes 2026', exact: true }).click()
    await expect(ana.getByRole('heading', { name: 'Minutes 2026', level: 1 })).toBeVisible()
    await ana.getByLabel('Files to upload').setInputFiles([
      { name: 'General meeting.pdf', mimeType: 'application/pdf', buffer: pdf('General meeting') },
      { name: 'Rules.txt', mimeType: 'text/plain', buffer: Buffer.from('Quiet hours from 22:00 to 08:00.\n') },
      { name: 'Payments.docm', mimeType: 'application/octet-stream', buffer: Buffer.from('PK') },
    ])
    const queue = ana.getByRole('region', { name: 'Uploads' })
    await expect(queue.getByText('Uploaded as “General meeting.pdf”.')).toBeVisible()
    await expect(queue.getByText('Uploaded as “Rules.txt”.')).toBeVisible()
    await expect(queue.getByText(/^This type of file is not accepted/)).toBeVisible()
    const folder = ana.getByRole('list', { name: 'Folders and files in Minutes 2026' })
    await expect(folder.getByRole('listitem')).toHaveCount(2)
    // Text files open in the portal's own viewer.
    await folder.getByRole('link', { name: 'Preview Rules.txt' }).click()
    const viewer = ana.getByRole('dialog', { name: 'Rules.txt' })
    await expect(viewer.getByText('Quiet hours from 22:00 to 08:00.')).toBeVisible()
    expect((await new AxeBuilder({ page: ana }).analyze()).violations).toEqual([])
    // Like any dialog, a click outside it closes the viewer.
    await ana.mouse.click(5, 5)
    await expect(viewer).toHaveCount(0)
    const previewPath = await folder.getByRole('link', { name: 'Preview General meeting.pdf' }).getAttribute('href')
    expect(previewPath).toMatch(/^\/api\/documents\/versions\/[0-9a-f-]{36}\/preview$/)
    const preview = await ana.request.get(previewPath ?? '')
    expect(preview.status()).toBe(200)
    expect(preview.headers()['content-type']).toBe('application/pdf')
    expect(preview.headers()['content-disposition']).toMatch(/^inline;/)
    expect((await preview.body()).subarray(0, 8).toString()).toBe('%PDF-1.4')
    expect((await new AxeBuilder({ page: ana }).analyze()).violations).toEqual([])
    // Where the browser shows PDFs inside pages (Ana's does; Playwright's headless shell does
    // not), the eye opens them in the portal's viewer too: a frame of the portal, which keeps the
    // session where new tabs lose it.
    const framed = ana.waitForResponse(response => response.url().endsWith(previewPath ?? '') && response.request().resourceType() === 'document')
    await folder.getByRole('link', { name: 'Preview General meeting.pdf' }).click()
    const pdfViewer = ana.getByRole('dialog', { name: 'General meeting.pdf' })
    await expect(pdfViewer.locator('iframe')).toHaveAttribute('src', previewPath ?? '')
    expect((await framed).headers()['x-frame-options']).toBe('SAMEORIGIN')
    await expect(pdfViewer.getByRole('link', { name: 'Download' })).toHaveAttribute('href', /\/download$/)
    await pdfViewer.getByRole('button', { name: 'Close' }).click()
    await expect(pdfViewer).toHaveCount(0)

    await choose(ana, 'Rules.txt', 'Rename')
    const rename = ana.getByRole('dialog', { name: 'Rename “Rules.txt”' })
    await expect(rename.getByLabel('New name')).toHaveValue('Rules')
    await rename.getByLabel('New name').fill('Community rules')
    await rename.getByRole('button', { name: 'Rename' }).click()
    await expect(ana.getByText('Renamed to “Community rules.txt”.')).toBeVisible()
    await choose(ana, 'Community rules.txt', 'Move to…')
    const move = ana.getByRole('dialog', { name: 'Move “Community rules.txt”' })
    await expect(move.getByRole('radio', { name: /^Minutes 2026/ })).toBeDisabled()
    await move.getByRole('radio', { name: 'Documents', exact: true }).check()
    await move.getByRole('button', { name: 'Move here' }).click()
    await expect(ana.getByText('“Community rules.txt” moved.')).toBeVisible()
    await expect(folder.getByRole('listitem')).toHaveCount(1)
    await ana.getByRole('navigation', { name: 'Folder path' }).getByRole('link', { name: 'Documents' }).click()
    await expect(ana.getByRole('list', { name: 'Folders and files in Documents' }).getByRole('listitem')).toHaveCount(2)

    // The search finds files in any folder, ignoring capitals, and says where they are.
    const searchBox = ana.getByRole('searchbox', { name: 'Search all documents' })
    await searchBox.fill('MEETING')
    const results = ana.getByRole('list', { name: 'Folders and files that contain “MEETING”' })
    await expect(results.getByRole('listitem')).toHaveCount(1)
    await expect(ana.getByRole('heading', { name: '1 result', exact: true })).toBeVisible()
    await expect(results.getByRole('link', { name: 'In Documents / Minutes 2026', exact: true })).toHaveAttribute('href', /^\/documents\/folders\/\d+$/)
    expect((await new AxeBuilder({ page: ana }).analyze()).violations).toEqual([])
    // The server reads the files' text in the background; then the words inside them are found too.
    await expect.poll(async () => (await (await ana.request.get('/api/documents/search?q=quiet%20hours')).json()).total, { timeout: 30_000 }).toBe(1)
    await searchBox.fill('quiet HOURS')
    const byText = ana.getByRole('list', { name: 'Folders and files that contain “quiet HOURS”' })
    await expect(byText.getByRole('listitem')).toHaveCount(1)
    await expect(byText.getByRole('link', { name: 'Community rules.txt', exact: true })).toBeVisible()
    await expect(byText.locator('mark')).toHaveText('Quiet hours')
    await expect(byText.getByText('Quiet hours from 22:00 to 08:00.')).toBeVisible()
    expect((await new AxeBuilder({ page: ana }).analyze()).violations).toEqual([])
    await searchBox.fill('')
    await expect(ana.getByRole('list', { name: 'Folders and files in Documents' }).getByRole('listitem')).toHaveCount(2)

    // With the default policy, other neighbors see and download everything but only change their own items.
    await leo.reload()
    const shared = leo.getByRole('list', { name: 'Folders and files in Documents' })
    await expect(shared.getByRole('link', { name: 'Minutes 2026', exact: true })).toBeVisible()
    await leo.getByRole('button', { name: 'Options for Community rules.txt', exact: true }).click()
    await expect(leo.getByRole('menu').getByRole('menuitem')).toHaveText(['Preview', 'Download', 'Select', 'Info'])
    await leo.getByRole('menuitem', { name: 'Info', exact: true }).click()
    const info = leo.getByRole('dialog', { name: 'Info: Community rules.txt' })
    const history = info.getByRole('region', { name: 'History' })
    await expect(history.getByRole('listitem')).toHaveText([
      /Ana Documents.*Moved it from Documents \/ Minutes 2026 to Documents\.$/,
      /Ana Documents.*Renamed it from “Rules\.txt” to “Community rules\.txt”\.$/,
      /Ana Documents.*Uploaded the file \(33 B\) to Documents \/ Minutes 2026\.$/,
    ])
    await info.getByRole('button', { name: 'Close' }).click()
    await leo.getByRole('checkbox', { name: 'Select Minutes 2026' }).check()
    await leo.getByRole('checkbox', { name: 'Select Community rules.txt' }).check()
    const selection = leo.getByRole('region', { name: 'Selection' })
    await expect(selection.getByRole('status')).toHaveText(/^2 selected · 2 files · /)
    const [download] = await Promise.all([
      leo.waitForEvent('download'), selection.getByRole('link', { name: 'Download ZIP' }).click(),
    ])
    expect(download.suggestedFilename()).toBe('Documents.zip')
    const archive = await readFile(await download.path())
    expect(archive.subarray(0, 2).toString()).toBe('PK')
    for (const name of ['Minutes 2026/', 'Minutes 2026/General meeting.pdf', 'Community rules.txt']) {
      expect(archive.includes(Buffer.from(name)), name).toBe(true)
    }

    // A deleted file disappears for everyone until the administrator restores it.
    await choose(ana, 'Community rules.txt', 'Delete')
    await ana.getByRole('dialog', { name: 'Delete “Community rules.txt”?' }).getByRole('button', { name: 'Delete' }).click()
    await expect(ana.getByText('“Community rules.txt” deleted.')).toBeVisible()
    await admin.goto('/admin/deleted-documents')
    const deleted = admin.getByRole('list', { name: 'Deleted documents' })
    await expect(deleted.getByText('Community rules.txt', { exact: true })).toBeVisible()
    await expect(deleted.getByText(/^Deleted by Ana Documents/)).toBeVisible()
    expect((await new AxeBuilder({ page: admin }).analyze()).violations).toEqual([])
    await admin.getByRole('button', { name: 'Restore Community rules.txt' }).click()
    await admin.getByRole('dialog', { name: 'Restore “Community rules.txt”?' }).getByRole('button', { name: 'Restore' }).click()
    await expect(admin.getByText('“Community rules.txt” restored.')).toBeVisible()
    await leo.reload()
    await expect(shared.getByRole('link', { name: 'Community rules.txt', exact: true })).toBeVisible()

    // The administrator follows how the text of the files is read for the search.
    await admin.getByRole('navigation', { name: 'Administration navigation' }).getByRole('link', { name: 'Document reading', exact: true }).click()
    await expect(admin.getByRole('heading', { name: 'Document reading', level: 1 })).toBeVisible()
    await expect(admin.getByText('2 of 2 files read')).toBeVisible({ timeout: 15_000 })
    await expect(admin.getByRole('progressbar', { name: 'Files read' })).toHaveAttribute('aria-valuenow', '2')
    const reading = admin.getByRole('list', { name: 'Files: Every file' })
    await expect(reading.getByRole('listitem')).toHaveCount(2)
    await expect(reading.getByText('Community rules.txt', { exact: true })).toBeVisible()
    expect((await new AxeBuilder({ page: admin }).analyze()).violations).toEqual([])
    await reading.getByRole('button', { name: 'Read again: Community rules.txt' }).click()
    await expect(admin.getByText('“Community rules.txt” will be read again.')).toBeVisible()
    await expect(admin.getByText('Every file has been read.')).toBeVisible({ timeout: 15_000 })

    // When every neighbor may change documents, Leo deletes Ana's PDF and the administrator purges it.
    await admin.goto('/admin/features')
    // Like the switches, the options show the saved setting once the server confirms it.
    await admin.getByRole('radio', { name: /^Every neighbor/ }).click()
    await expect(admin.getByText('Documents can now be changed by: Every neighbor.')).toBeVisible()
    await expect(admin.getByRole('radio', { name: /^Every neighbor/ })).toBeChecked()
    await leo.getByRole('link', { name: 'Minutes 2026', exact: true }).click()
    await choose(leo, 'General meeting.pdf', 'Delete')
    await leo.getByRole('dialog', { name: 'Delete “General meeting.pdf”?' }).getByRole('button', { name: 'Delete' }).click()
    await expect(leo.getByText('“General meeting.pdf” deleted.')).toBeVisible()
    await admin.goto('/admin/deleted-documents')
    await admin.getByRole('button', { name: 'Delete permanently: General meeting.pdf' }).click()
    const purge = admin.getByRole('dialog', { name: 'Delete “General meeting.pdf” permanently?' })
    await expect(purge.getByText('Its files, with every version, will be deleted from the server forever. This cannot be undone.')).toBeVisible()
    await purge.getByRole('button', { name: 'Delete permanently' }).click()
    await expect(admin.getByText(/^“General meeting\.pdf” has been deleted permanently\./)).toBeVisible()
    expect((await ana.request.get(previewPath ?? '')).status()).toBe(404)

    // The administrator lowers the largest file in Storage, where each limit has a slider, a box and
    // an explanation; neighbors' larger files are then refused before they are sent.
    await admin.goto('/admin/storage')
    const limits = admin.getByRole('region', { name: 'Shared documents limits' })
    await limits.getByRole('button', { name: 'More about Largest file' }).hover()
    await expect(admin.getByRole('tooltip')).toContainText('The largest file a neighbor can upload to Documents')
    const largest = limits.getByRole('textbox', { name: 'Largest file' })
    await expect(largest).toHaveValue('50')
    await largest.fill('1')
    await expect(limits.getByRole('slider', { name: 'Largest file' })).toHaveAttribute('aria-valuetext', '1 MiB')
    await limits.getByRole('button', { name: 'Save limits' }).click()
    await expect(limits.getByText('The limits of shared documents have been saved.')).toBeVisible()
    expect((await new AxeBuilder({ page: admin }).analyze()).violations).toEqual([])
    expect((await (await admin.request.get('/api/admin/settings/documents')).json()).max_file_mb).toBe(1)
    await ana.reload()
    await ana.getByLabel('Files to upload').setInputFiles({
      name: 'Large plan.pdf', mimeType: 'application/pdf', buffer: Buffer.concat([pdf('Large plan'), Buffer.alloc(2 * 1024 * 1024)]),
    })
    await expect(ana.getByRole('region', { name: 'Uploads' }).getByText('The file is larger than 1 MiB, the limit for this type of file.')).toBeVisible()

    // Turning the feature off closes the section on open pages without deleting anything.
    await admin.goto('/admin/features')
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-checked', 'false')
    await expect(leo.getByRole('heading', { name: 'Documents turned off' })).toBeVisible({ timeout: 10_000 })
    await expect(leo.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Documents', exact: true }))
      .toHaveCount(0)
    expect(errors).toEqual([])
  } finally {
    await first.close()
    await second.close()
  }
})
