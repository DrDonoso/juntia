import { QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest'
import { cache } from './api/client'
import type {
  DocumentSettings, ResidentStorageOut, StorageOut, StoredAttachmentOut, StoredAttachmentPage, StoredDocumentVersionOut,
  StoredDocumentVersionPage, StoredImageOut, StoredImagePage,
} from './api/schema.gen'
import { setLanguage } from './i18n'
import { sizeStops } from './size-field'
import { StoragePage } from './storage'

const MiB = 1024 ** 2, GiB = 1024 ** 3
const alice: ResidentStorageOut = {
  user_id: 7, name: 'Alice', account_deleted: false, quota_bytes: 250 * MiB,
  stored_bytes: 240 * MiB, active_bytes: 200 * MiB, withdrawn_bytes: 40 * MiB, active_files: 10, withdrawn_files: 2,
  image_bytes: 0, image_files: 0,
}
const ben: ResidentStorageOut = {
  user_id: 8, name: 'Ben', account_deleted: true, quota_bytes: 250 * MiB,
  stored_bytes: 20 * MiB, active_bytes: 0, withdrawn_bytes: 20 * MiB, active_files: 0, withdrawn_files: 1,
  image_bytes: 0, image_files: 0,
}
const carol: ResidentStorageOut = {
  user_id: 9, name: 'Carol', account_deleted: false, quota_bytes: 250 * MiB,
  stored_bytes: 8 * MiB, active_bytes: 5 * MiB, withdrawn_bytes: 0, active_files: 1, withdrawn_files: 0,
  image_bytes: 3 * MiB, image_files: 2,
}
const usage: StorageOut = {
  community: {
    quota_bytes: 2048 * MiB, stored_bytes: 1280 * MiB, active_bytes: GiB, withdrawn_bytes: 256 * MiB,
    active_files: 30, withdrawn_files: 5, image_bytes: 0, image_files: 0,
  },
  administrator: {
    stored_bytes: 15 * MiB, active_bytes: 10 * MiB, withdrawn_bytes: 5 * MiB, active_files: 2, withdrawn_files: 1,
    image_bytes: 0, image_files: 0,
  },
  residents: [alice, ben, carol],
  resident_quota_bytes: 250 * MiB,
  disk: { total_bytes: 200 * GiB, free_bytes: 50 * GiB, reserve_bytes: GiB },
  documents: {
    quota_bytes: 20 * GiB, resident_quota_bytes: 2 * GiB, stored_bytes: 300 * MiB, current_bytes: 200 * MiB,
    previous_bytes: 60 * MiB, deleted_bytes: 40 * MiB, files: 12, previous_versions: 2, deleted_files: 1,
    administrator_bytes: 20 * MiB, upload_bytes: 5 * MiB, uploads: 1, residents: [],
  },
}
const stamp = '2026-10-10T10:00:00Z'
const budget: StoredDocumentVersionOut = {
  id: 'version-1', number: 1, extension: 'xlsx', media_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  size: 60 * MiB, sha256: 'c'.repeat(64), author: { kind: 'resident', user_id: 7, name: 'Alice' }, created_at: stamp,
  purged_at: null, document_id: 4, document_name: 'Budget.xlsx', location: ['Accounts'], previewable: false,
}
const rules: StoredDocumentVersionOut = {
  ...budget, id: 'version-2', extension: 'pdf', media_type: 'application/pdf', size: MiB, document_id: 5,
  document_name: 'Rules.pdf', location: [], previewable: true,
}
const quote: StoredAttachmentOut = {
  id: 'pdf-1', filename: 'old-quote.pdf', size: 40 * MiB, sha256: 'a'.repeat(64),
  author: { kind: 'resident', user_id: 7, name: 'Alice' }, version: 2, created_at: '2026-09-01T08:00:00Z',
  withdrawn_at: stamp, purged_at: null, action_id: 12, action_title: 'Entrance door',
}
const photo: StoredImageOut = {
  id: 'img-1', url: '/api/actions/images/img-1', filename: 'Leak on the roof.jpg', media_type: 'image/jpeg', size: 2 * MiB,
  width: 2560, height: 1920, created_at: stamp, scope: 'actions', sha256: 'b'.repeat(64),
  author: { kind: 'resident', user_id: 9, name: 'Carol' }, purged_at: null,
}
const defaults = cache.getDefaultOptions()
const originalShow = HTMLDialogElement.prototype.showModal
const originalClose = HTMLDialogElement.prototype.close
let summary: StorageOut, withdrawn: StoredAttachmentOut[], total: number | null, images: StoredImageOut[]
let versions: StoredDocumentVersionOut[], settings: DocumentSettings
let purge: (body: unknown) => Response, purgeImage: () => Response
const requests: string[] = []

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', '') }
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open') }
})
afterAll(() => {
  HTMLDialogElement.prototype.showModal = originalShow
  HTMLDialogElement.prototype.close = originalClose
})
beforeEach(() => {
  cache.setDefaultOptions({ queries: { retry: false } })
  summary = structuredClone(usage)
  withdrawn = [quote]
  images = [photo]
  versions = []
  settings = { manage_policy: 'creator', max_file_mb: 50, max_video_mb: 1024, user_quota_mb: 2048, community_quota_mb: 20480 }
  total = null
  requests.length = 0
  purge = () => {
    withdrawn = []
    return reply({ ...quote, purged_at: '2026-10-12T09:30:00Z', version: 3 })
  }
  purgeImage = () => {
    images = []
    return reply({ ...photo, purged_at: '2026-10-12T09:30:00Z' })
  }
  vi.stubGlobal('fetch', vi.fn(respond))
})
afterEach(() => {
  cleanup(); cache.clear(); cache.setDefaultOptions(defaults); vi.restoreAllMocks(); vi.unstubAllGlobals()
})

function reply(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status })
}

async function respond(input: string, options: RequestInit = {}) {
  requests.push(options.method === 'POST' || options.method === 'PATCH' ? `${options.method} ${input} ${String(options.body)}` : input)
  if (input === '/api/admin/storage') return reply(summary)
  if (input === '/api/admin/settings/documents') {
    if (options.method === 'PATCH') settings = { ...settings, ...JSON.parse(String(options.body)) }
    return reply(settings)
  }
  if (input.startsWith('/api/admin/storage/withdrawn?')) {
    const page = Number(new URL(input, 'http://localhost').searchParams.get('page'))
    const count = total ?? withdrawn.length
    const body: StoredAttachmentPage = { items: page === 1 ? withdrawn : [], total: count, page, pages: Math.max(1, Math.ceil(count / 20)) }
    return reply(body)
  }
  if (input === '/api/admin/storage/attachments/pdf-1/purge' && options.method === 'POST') {
    expect(options.headers).toEqual({ 'X-Juntia-Request': '1', 'Content-Type': 'application/json' })
    return purge(JSON.parse(String(options.body)))
  }
  if (input.startsWith('/api/admin/storage/images?')) {
    const page = Number(new URL(input, 'http://localhost').searchParams.get('page'))
    const body: StoredImagePage = { items: page === 1 ? images : [], total: images.length, page, pages: 1 }
    return reply(body)
  }
  if (input === '/api/admin/storage/images/img-1/purge' && options.method === 'POST') {
    expect(options.body).toBeUndefined()
    return purgeImage()
  }
  if (input.startsWith('/api/admin/storage/document-versions?')) {
    const page = Number(new URL(input, 'http://localhost').searchParams.get('page'))
    const body: StoredDocumentVersionPage = { items: page === 1 ? versions : [], total: versions.length, page, pages: 1 }
    return reply(body)
  }
  if (input === '/api/admin/storage/document-versions/version-1/purge' && options.method === 'POST') {
    versions = []
    return reply({ ...budget, purged_at: '2026-10-12T09:30:00Z' })
  }
  throw new Error(`Unexpected request: ${input}`)
}

function renderPage() {
  return render(<QueryClientProvider client={cache}><MemoryRouter initialEntries={['/admin/storage']}><StoragePage /></MemoryRouter></QueryClientProvider>)
}

function region(name: string) {
  return within(screen.getByRole('region', { name }))
}

async function findRegion(name: string) {
  return within(await screen.findByRole('region', { name }))
}

test('the summary shows the community, administrator and disk usage with accessible meters', async () => {
  renderPage()
  expect(screen.getByRole('heading', { name: 'Storage', level: 1 })).toBeVisible()
  expect(screen.getByText('ADMINISTRATION')).toBeVisible()
  const community = await findRegion('Community')
  expect(community.getByText('1.25 GiB of 2 GiB used')).toBeVisible()
  const meter = community.getByRole('meter', { name: 'Community quota used' })
  expect(meter).toHaveAttribute('aria-valuetext', '1.25 GiB of 2 GiB used (62.5%)')
  expect(meter).toHaveAttribute('aria-valuenow', String(1280 * MiB))
  expect(meter).toHaveAttribute('aria-valuemax', String(2048 * MiB))
  expect(meter).toHaveAttribute('data-level', 'normal')
  expect(community.getByText('768 MiB still available.')).toBeVisible()
  expect(community.getByText('Active').nextElementSibling).toHaveTextContent('1 GiB · 30 PDFs')
  expect(community.getByText('Withdrawn').nextElementSibling).toHaveTextContent('256 MiB · 5 PDFs')
  expect(community.getByText('Images').nextElementSibling).toHaveTextContent('0 B · 0 images')
  const administrator = region('Technical administrator')
  expect(administrator.getByText('15 MiB stored')).toBeVisible()
  expect(administrator.getByText('No quota of its own: these PDFs and images count only towards the community quota.')).toBeVisible()
  expect(administrator.getByText('Withdrawn').nextElementSibling).toHaveTextContent('5 MiB · 1 PDF')
  const disk = region('Server disk')
  expect(disk.getByText('50 GiB free of 200 GiB')).toBeVisible()
  expect(disk.getByRole('meter', { name: 'Server disk space used' })).toHaveAttribute('aria-valuetext', '150 GiB of 200 GiB used (75%)')
  expect(disk.getByText('1 GiB are kept free as a reserve. Below it, uploads of PDFs, images and documents and statement imports are refused.')).toBeVisible()
  expect(screen.queryByRole('alert')).toBeNull()
})

test.each([
  { name: 'a full community quota', change: (value: StorageOut) => { value.community.stored_bytes = 2100 * MiB }, alert: 'The community quota is full, so new PDFs and images are refused. Delete withdrawn PDFs or images permanently, or raise the quota.' },
  { name: 'free space below the reserve', change: (value: StorageOut) => { value.disk.free_bytes = 512 * MiB }, alert: 'The free space is below the reserve, so uploads of PDFs, images and documents and statement imports are refused. Free space on the server or delete withdrawn PDFs or images permanently.' },
  { name: 'a community quota almost full', change: (value: StorageOut) => { value.community.stored_bytes = 1900 * MiB }, warning: 'The community quota is almost full. Delete withdrawn PDFs or images permanently to free space.' },
  { name: 'free space close to the reserve', change: (value: StorageOut) => { value.disk.free_bytes = 1536 * MiB }, warning: 'The free space is close to the reserve. Free space on the server soon to keep accepting uploads of PDFs, images and documents and statement imports.' },
])('the summary warns about $name', async ({ change, alert, warning }) => {
  change(summary)
  renderPage()
  await screen.findByText('Storage by neighbor')
  if (alert) expect(screen.getByRole('alert')).toHaveTextContent(alert)
  else expect(screen.queryByRole('alert')).toBeNull()
  if (warning) expect(screen.getByText(warning)).toHaveAttribute('role', 'status')
})

test('an over-quota community never reads more than full on its meter', async () => {
  summary.community.stored_bytes = 2560 * MiB
  renderPage()
  const meter = await screen.findByRole('meter', { name: 'Community quota used' })
  expect(meter).toHaveAttribute('aria-valuenow', String(2048 * MiB))
  expect(meter).toHaveAttribute('aria-valuetext', '2.5 GiB of 2 GiB used (125%)')
  expect(meter).toHaveAttribute('data-level', 'full')
  expect(meter.firstElementChild).toHaveStyle({ width: '100%' })
  expect(screen.getByText('0 B still available.')).toBeVisible()
})

test('a disk the server cannot read is explained without an alarm', async () => {
  summary.disk = { total_bytes: null, free_bytes: null, reserve_bytes: GiB }
  renderPage()
  const disk = within(await screen.findByRole('region', { name: 'Server disk' }))
  expect(disk.getByText('The server cannot read the free space of its upload folder right now. While it cannot, uploads of PDFs, images and documents and statement imports are refused.'))
    .toHaveAttribute('role', 'status')
  expect(disk.queryByRole('meter')).toBeNull()
  expect(disk.getByText(/^1 GiB are kept free/)).toBeVisible()
  expect(screen.queryByRole('alert')).toBeNull()
})

test('neighbors come sorted by quota used and can be sorted by any column, with deleted accounts flagged', async () => {
  summary.residents = [ben, { ...carol, name: '' }, alice]
  renderPage()
  const table = await screen.findByRole('table', { name: 'Storage by neighbor' })
  expect(within(table).getAllByRole('columnheader').map(header => header.textContent)).toEqual(['Neighbor', 'Active PDFs', 'Withdrawn PDFs', 'Images', 'Quota used'])
  expect(within(table).getByRole('columnheader', { name: 'Quota used' })).toHaveAttribute('aria-sort', 'descending')
  const names = () => within(table).getAllByRole('row').slice(1).map(row => within(row).getByRole('rowheader').textContent)
  expect(names()).toEqual(['Alice', 'BenDeleted account', 'Neighbor #9'])
  const rows = within(table).getAllByRole('row').slice(1)
  expect(rows[0]).toHaveTextContent('200 MiB10 PDFs')
  expect(rows[0]).toHaveTextContent('40 MiB2 PDFs')
  expect(rows[0]).toHaveTextContent('240 MiB of 250 MiB used')
  const meter = within(rows[0]).getByRole('meter', { name: 'Quota used by Alice' })
  expect(meter).toHaveAttribute('aria-valuetext', '240 MiB of 250 MiB used (96%)')
  expect(meter).toHaveAttribute('data-level', 'warning')
  expect(within(rows[1]).getByText('Deleted account')).toHaveClass('tag')
  expect(within(rows[1]).getByRole('meter', { name: 'Quota used by Ben' })).toHaveAttribute('data-level', 'normal')
  expect(rows[2]).toHaveTextContent('3 MiB2 images')
  expect(rows[2]).toHaveTextContent('8 MiB of 250 MiB used')
  // Sizes start with the largest; equal ones keep the order of names.
  fireEvent.click(within(table).getByRole('button', { name: 'Sort by: Images' }))
  expect(names()).toEqual(['Neighbor #9', 'Alice', 'BenDeleted account'])
  expect(within(table).getByRole('columnheader', { name: 'Images' })).toHaveAttribute('aria-sort', 'descending')
  expect(within(table).getByRole('columnheader', { name: 'Quota used' })).toHaveAttribute('aria-sort', 'none')
  fireEvent.click(within(table).getByRole('button', { name: 'Sort by: Images' }))
  expect(names()).toEqual(['Alice', 'BenDeleted account', 'Neighbor #9'])
  expect(within(table).getByRole('columnheader', { name: 'Images' })).toHaveAttribute('aria-sort', 'ascending')
  fireEvent.click(within(table).getByRole('button', { name: 'Sort by: Neighbor' }))
  expect(within(table).getByRole('columnheader', { name: 'Neighbor' })).toHaveAttribute('aria-sort', 'ascending')
  fireEvent.click(within(table).getByRole('button', { name: 'Sort by: Neighbor' }))
  expect(names()).toEqual(['Neighbor #9', 'BenDeleted account', 'Alice'])
})

test('without stored PDFs the page says so', async () => {
  summary = { ...summary, residents: [] }
  withdrawn = []
  images = []
  renderPage()
  expect(await screen.findByText('No neighbor has stored PDFs or images yet.')).toBeVisible()
  expect(await screen.findByText('There are no withdrawn PDFs using space.')).toBeVisible()
  expect(await screen.findByText('No images are stored.')).toBeVisible()
  expect(screen.queryByText(/still uses? space/)).toBeNull()
  expect(screen.queryByRole('table')).toBeNull()
  expect(screen.queryByRole('list', { name: 'Withdrawn PDFs' })).toBeNull()
  expect(screen.queryByRole('list', { name: 'Images in texts' })).toBeNull()
})

test('shared documents have their own quotas, neighbors and earlier versions to open and purge', async () => {
  summary.documents.residents = [
    { user_id: 7, name: 'Alice', account_deleted: false, stored_bytes: 1946 * MiB, versions: 14 },
    { user_id: 9, name: 'Carol', account_deleted: false, stored_bytes: 10 * MiB, versions: 30 },
  ]
  versions = [rules, budget]
  renderPage()
  const documents = await findRegion('Documents')
  expect(documents.getByText('300 MiB of 20 GiB used')).toBeVisible()
  expect(documents.getByRole('meter', { name: 'Documents quota used' })).toHaveAttribute('data-level', 'normal')
  expect(documents.getByText('Earlier versions').nextElementSibling).toHaveTextContent('60 MiB · 2 versions')
  expect(documents.getByText('Deleted, not purged').nextElementSibling).toHaveTextContent('40 MiB · 1 file')
  expect(documents.getByText('Uploads in progress').nextElementSibling).toHaveTextContent('5 MiB · 1 upload')
  const table = screen.getByRole('table', { name: 'Documents by neighbor' })
  const neighbors = within(table)
  expect(neighbors.getByRole('meter', { name: 'Quota used by Alice' })).toHaveAttribute('data-level', 'warning')
  const names = () => neighbors.getAllByRole('rowheader').map(header => header.textContent)
  expect(names()).toEqual(['Alice', 'Carol'])
  expect(neighbors.getByRole('columnheader', { name: 'Quota used' })).toHaveAttribute('aria-sort', 'descending')
  fireEvent.click(neighbors.getByRole('button', { name: 'Sort by: Versions' }))
  expect(names()).toEqual(['Carol', 'Alice'])
  expect(documents.getByRole('link', { name: 'Change the limits' })).toHaveAttribute('href', '#document-limits')
  expect(screen.getByRole('region', { name: 'Shared documents limits' })).toHaveAttribute('id', 'document-limits')
  const earlier = await findRegion('Earlier versions of documents')
  const list = await earlier.findByRole('list', { name: 'Earlier versions of documents' })
  expect(requests).toContain('/api/admin/storage/document-versions?page=1')
  expect(earlier.getByText('2 earlier versions use space.')).toBeVisible()
  const [pdf, sheet] = within(list).getAllByRole('listitem')
  expect(pdf).toHaveTextContent('Rules.pdfVersion 1 · 1 MiB · Uploaded by Alice · Uploaded:')
  const preview = within(pdf).getByRole('link', { name: 'Preview version 1 of Rules.pdf' })
  expect(preview).toHaveAttribute('href', '/api/admin/documents/versions/version-2/preview')
  expect(preview).toHaveAttribute('target', '_blank')
  expect(within(sheet).queryByRole('link', { name: /^Preview/ })).toBeNull()
  expect(within(sheet).getByRole('link', { name: 'Download version 1 of Budget.xlsx' }))
    .toHaveAttribute('href', '/api/admin/documents/versions/version-1/download')
  expect(sheet).toHaveTextContent('Accounts')
  fireEvent.click(within(sheet).getByRole('button', { name: 'Delete permanently: version 1 of Budget.xlsx' }))
  const dialog = within(screen.getByRole('dialog', { name: 'Delete version permanently' }))
  expect(dialog.getByText('It frees 60 MiB of the documents quotas of the community and of Alice.')).toBeVisible()
  fireEvent.click(dialog.getByRole('button', { name: 'Delete permanently' }))
  expect(await earlier.findByText('Version 1 of Budget.xlsx has been deleted permanently. 60 MiB freed.')).toBeVisible()
  expect(requests).toContain('POST /api/admin/storage/document-versions/version-1/purge undefined')
  expect(await earlier.findByText('There are no earlier versions using space.')).toBeVisible()
})

test('the limits of shared documents are edited with a slider or an exact size and saved together', async () => {
  summary.documents.residents = [{ user_id: 7, name: 'Alice', account_deleted: false, stored_bytes: 1946 * MiB, versions: 14 }]
  renderPage()
  const limits = await findRegion('Shared documents limits')
  const file = await limits.findByRole('textbox', { name: 'Largest file' })
  expect(limits.getAllByRole('slider').map(slider => slider.getAttribute('aria-valuetext'))).toEqual(['50 MiB', '1 GiB', '2 GiB', '20 GiB'])
  expect(limits.getAllByRole('button', { name: /^More about / }).map(button => button.getAttribute('aria-label'))).toEqual([
    'More about Largest file', 'More about Largest video', 'More about Documents quota per neighbor', 'More about Community documents quota',
  ])
  const save = limits.getByRole('button', { name: 'Save limits' })
  const discard = limits.getByRole('button', { name: 'Discard changes' })
  expect(save).toBeDisabled()
  expect(discard).toBeDisabled()
  fireEvent.change(file, { target: { value: '0' } })
  expect(limits.getByRole('alert')).toHaveTextContent('Enter a whole number of MiB from 1 to 10,240.')
  expect(save).toBeDisabled()
  fireEvent.change(file, { target: { value: '100' } })
  fireEvent.change(limits.getByRole('slider', { name: 'Largest video' }), { target: { value: String(sizeStops(1, 10240).indexOf(2048)) } })
  expect(limits.getByRole('textbox', { name: 'Largest video' })).toHaveValue('2048')
  // A quota below what is already stored is allowed, with a warning.
  const neighborQuota = limits.getByRole('textbox', { name: 'Documents quota per neighbor' })
  fireEvent.change(neighborQuota, { target: { value: '1024' } })
  expect(neighborQuota).toHaveAccessibleDescription(/1 neighbor already uses more than this: their uploads will be refused until they have space again\.$/)
  const communityQuota = limits.getByRole('textbox', { name: 'Community documents quota' })
  fireEvent.change(communityQuota, { target: { value: '200' } })
  expect(limits.getByText('Documents already use 300 MiB, more than this: every upload will be refused until enough is deleted permanently.')).toBeVisible()
  fireEvent.change(communityQuota, { target: { value: '20480' } })
  const summaries = requests.filter(request => request === '/api/admin/storage').length
  fireEvent.click(save)
  expect(await limits.findByText('The limits of shared documents have been saved.')).toBeVisible()
  expect(requests).toContain('PATCH /api/admin/settings/documents {"max_file_mb":100,"max_video_mb":2048,"user_quota_mb":1024}')
  await waitFor(() => expect(requests.filter(request => request === '/api/admin/storage').length).toBeGreaterThan(summaries))
  expect(file).toHaveValue('100')
  expect(save).toBeDisabled()
  fireEvent.change(file, { target: { value: '7' } })
  expect(limits.queryByText('The limits of shared documents have been saved.')).toBeNull()
  fireEvent.click(discard)
  expect(file).toHaveValue('100')
  expect(discard).toBeDisabled()
})

test('stored images show a thumbnail, their details and author, the newest first', async () => {
  renderPage()
  const section = region('Images in texts')
  const list = await section.findByRole('list', { name: 'Images in texts' })
  expect(requests).toContain('/api/admin/storage/images?page=1')
  expect(section.queryByRole('combobox')).toBeNull()
  const entry = within(list).getByRole('listitem')
  const thumbnail = within(entry).getByRole('link', { name: 'Open Leak on the roof.jpg at full size in a new tab' })
  expect(thumbnail).toHaveAttribute('href', '/api/admin/storage/images/img-1/file')
  expect(thumbnail).toHaveAttribute('target', '_blank')
  expect(thumbnail.querySelector('img')).toHaveAttribute('src', '/api/admin/storage/images/img-1/file')
  expect(entry).toHaveTextContent('Leak on the roof.jpg')
  expect(entry).toHaveTextContent('2 MiB · 2,560 × 1,920 px · Actions')
  expect(entry).toHaveTextContent('Uploaded by Carol · Uploaded: 10 Oct 2026')
  expect(within(entry).getByText('Uploaded:', { exact: false }).querySelector('time')).toHaveAttribute('datetime', stamp)
  expect(section.getByText('1 image uses space.')).toBeVisible()
})

test('deleting an image permanently is confirmed and refreshes the usage and the list', async () => {
  renderPage()
  const section = region('Images in texts')
  const remove = await section.findByRole('button', { name: 'Delete permanently: Leak on the roof.jpg' })
  fireEvent.click(remove)
  const dialog = within(screen.getByRole('dialog', { name: 'Delete image permanently' }))
  expect(dialog.getByRole('img', { name: 'Leak on the roof.jpg' })).toHaveAttribute('src', '/api/admin/storage/images/img-1/file')
  expect(dialog.getByText('Actions', { exact: false })).toHaveTextContent('Uploaded by Carol')
  expect(dialog.getByText('The file will be deleted from the server forever. This cannot be undone.')).toBeVisible()
  expect(dialog.getByText('The descriptions, comments and history entries that show it will say "Image not available" instead.')).toBeVisible()
  expect(dialog.getByText('It frees 2 MiB of the community quota and of the quota of Carol.')).toBeVisible()
  const before = requests.filter(request => request === '/api/admin/storage').length
  fireEvent.click(dialog.getByRole('button', { name: 'Delete permanently' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(requests.filter(request => request.startsWith('POST'))).toEqual(['POST /api/admin/storage/images/img-1/purge undefined'])
  expect(section.getByText('Leak on the roof.jpg has been deleted permanently. 2 MiB freed.')).toHaveAttribute('role', 'status')
  expect(section.getByRole('heading', { name: 'Images in texts' })).toHaveFocus()
  expect(await section.findByText('No images are stored.')).toBeVisible()
  await waitFor(() => expect(requests.filter(request => request === '/api/admin/storage').length).toBe(before + 1))
})

test('an image the server could not delete keeps the dialog open with an explanation', async () => {
  purgeImage = () => reply({ code: 'image_storage_error' }, 503)
  renderPage()
  fireEvent.click(await screen.findByRole('button', { name: 'Delete permanently: Leak on the roof.jpg' }))
  const dialog = within(screen.getByRole('dialog', { name: 'Delete image permanently' }))
  fireEvent.click(dialog.getByRole('button', { name: 'Delete permanently' }))
  expect(await dialog.findByRole('alert')).toHaveTextContent('The file could not be deleted from the server storage, so nothing has changed. Try again later.')
  expect(screen.queryByText(/has been deleted permanently/)).toBeNull()
})

test('withdrawn PDFs, the latest withdrawn first, can be viewed and downloaded before deleting them, page by page', async () => {
  total = 21
  renderPage()
  const section = region('Withdrawn PDFs')
  const list = await section.findByRole('list', { name: 'Withdrawn PDFs' })
  expect(requests).toContain('/api/admin/storage/withdrawn?page=1')
  expect(section.queryByRole('combobox')).toBeNull()
  const entry = within(list).getByRole('listitem')
  expect(entry).toHaveTextContent('old-quote.pdf')
  expect(entry).toHaveTextContent('40 MiB · Uploaded by Alice · Withdrawn: 10 Oct 2026')
  expect(within(entry).getByText('Withdrawn:', { exact: false }).querySelector('time')).toHaveAttribute('datetime', stamp)
  expect(within(entry).getByRole('link', { name: '#12 · Entrance door' })).toHaveAttribute('href', '/actions/12')
  const view = within(entry).getByRole('link', { name: 'View old-quote.pdf (new tab)' })
  expect(view).toHaveAttribute('href', '/api/admin/storage/attachments/pdf-1/preview')
  expect(view).toHaveAttribute('target', '_blank')
  expect(within(entry).getByRole('link', { name: 'Download old-quote.pdf' })).toHaveAttribute('href', '/api/admin/storage/attachments/pdf-1/download')
  expect(within(entry).getByRole('button', { name: 'Delete permanently: old-quote.pdf' })).toHaveTextContent('Delete permanently')
  expect(section.getByText('21 withdrawn PDFs still use space.')).toBeVisible()
  fireEvent.click(section.getByRole('button', { name: 'Next: withdrawn PDFs' }))
  await waitFor(() => expect(requests).toContain('/api/admin/storage/withdrawn?page=2'))
  expect(await section.findByText('There are no withdrawn PDFs on this page.')).toBeVisible()
})

test('a permanent deletion is confirmed, then refreshes the usage, the list and the cached actions', async () => {
  cache.setQueryData(['actions', 'history', 12, 1], { items: [], total: 0, page: 1, pages: 1 })
  renderPage()
  const section = region('Withdrawn PDFs')
  const remove = await section.findByRole('button', { name: 'Delete permanently: old-quote.pdf' })
  remove.focus()
  fireEvent.click(remove)
  let dialog = within(screen.getByRole('dialog', { name: 'Delete PDF permanently' }))
  expect(dialog.getByText('old-quote.pdf')).toBeVisible()
  expect(dialog.getByText('Action: #12 · Entrance door', { exact: false })).toHaveTextContent('Uploaded by Alice')
  expect(dialog.getByText('The file will be deleted from the server forever. This cannot be undone.')).toBeVisible()
  expect(dialog.getByText('The action history keeps its name, size and SHA-256 checksum.')).toBeVisible()
  expect(dialog.getByText('It frees 40 MiB of the community quota and of the quota of Alice.')).toBeVisible()
  fireEvent.click(dialog.getByRole('button', { name: 'Cancel' }))
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(remove).toHaveFocus()
  expect(requests.filter(request => request.startsWith('POST'))).toEqual([])

  const before = requests.filter(request => request === '/api/admin/storage').length
  fireEvent.click(remove)
  dialog = within(screen.getByRole('dialog', { name: 'Delete PDF permanently' }))
  fireEvent.click(dialog.getByRole('button', { name: 'Delete permanently' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(requests.filter(request => request.startsWith('POST'))).toEqual(['POST /api/admin/storage/attachments/pdf-1/purge {"version":2}'])
  expect(section.getByText('old-quote.pdf has been deleted permanently. 40 MiB freed.')).toHaveAttribute('role', 'status')
  expect(section.getByRole('heading', { name: 'Withdrawn PDFs' })).toHaveFocus()
  expect(await section.findByText('There are no withdrawn PDFs using space.')).toBeVisible()
  await waitFor(() => expect(requests.filter(request => request === '/api/admin/storage').length).toBe(before + 1))
  expect(cache.getQueryState(['actions', 'history', 12, 1])?.isInvalidated).toBe(true)
})

test('the technical administrator\'s PDFs free only the community quota', async () => {
  withdrawn = [{ ...quote, size: 1536 * 1024, author: { kind: 'administrator', user_id: null, name: 'ops-admin' } }]
  renderPage()
  fireEvent.click(await screen.findByRole('button', { name: 'Delete permanently: old-quote.pdf' }))
  const dialog = within(screen.getByRole('dialog', { name: 'Delete PDF permanently' }))
  expect(dialog.getByText('It frees 1.5 MiB of the community quota.')).toBeVisible()
  expect(dialog.getByText('Uploaded by Technical administrator', { exact: false })).toBeVisible()
  expect(document.body).not.toHaveTextContent('ops-admin')
})

test('a PDF changed meanwhile is not deleted: the list reloads and says why', async () => {
  purge = () => reply({ code: 'action_stale' }, 409)
  renderPage()
  const section = region('Withdrawn PDFs')
  fireEvent.click(await section.findByRole('button', { name: 'Delete permanently: old-quote.pdf' }))
  const lists = requests.filter(request => request.startsWith('/api/admin/storage/withdrawn')).length
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete permanently' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(section.getByRole('alert')).toHaveTextContent('This PDF changed while you were confirming, so it has not been deleted. The list has been reloaded: review it and try again.')
  await waitFor(() => expect(requests.filter(request => request.startsWith('/api/admin/storage/withdrawn')).length).toBe(lists + 1))
  expect(section.getByRole('heading', { name: 'Withdrawn PDFs' })).toHaveFocus()
  expect(section.getByRole('button', { name: 'Delete permanently: old-quote.pdf' })).toBeVisible()
})

test.each([
  { code: 'action_attachment_active', status: 409, message: 'Only withdrawn PDFs can be deleted permanently. Withdraw it from its action first.' },
  { code: 'action_storage_error', status: 503, message: 'The file could not be deleted from the server storage, so nothing has changed. Try again later.' },
  { code: 'internal_error', status: 500, message: 'The operation could not be completed. Contact the administrator.' },
])('other failures keep the dialog open with their message ($code)', async ({ code, status, message }) => {
  purge = () => reply({ code }, status)
  renderPage()
  fireEvent.click(await screen.findByRole('button', { name: 'Delete permanently: old-quote.pdf' }))
  const dialog = within(screen.getByRole('dialog', { name: 'Delete PDF permanently' }))
  fireEvent.click(dialog.getByRole('button', { name: 'Delete permanently' }))
  expect(await dialog.findByRole('alert')).toHaveTextContent(message)
  expect(dialog.getByRole('button', { name: 'Delete permanently' })).toBeEnabled()
  expect(screen.queryByText(/has been deleted permanently/)).toBeNull()
})

test('a failed summary can be retried while the withdrawn PDFs stay available', async () => {
  let fail = true
  vi.stubGlobal('fetch', vi.fn((input: string, options?: RequestInit) => input === '/api/admin/storage' && fail
    ? Promise.resolve(reply({ code: 'internal_error' }, 500)) : respond(input, options)))
  renderPage()
  expect(await screen.findByText('The operation could not be completed. Contact the administrator.')).toHaveAttribute('role', 'alert')
  expect(await screen.findByRole('button', { name: 'Delete permanently: old-quote.pdf' })).toBeVisible()
  fail = false
  fireEvent.click(screen.getByRole('button', { name: 'Retry loading' }))
  expect(await screen.findByText('1.25 GiB of 2 GiB used')).toBeVisible()
  expect(screen.queryByRole('alert')).toBeNull()
})

test('the page renders in Spanish and follows a language switch', async () => {
  setLanguage('es')
  renderPage()
  expect(screen.getByRole('heading', { name: 'Almacenamiento', level: 1 })).toBeVisible()
  const community = await findRegion('Comunidad')
  expect(community.getByText('1,25 GiB de 2 GiB usados')).toBeVisible()
  expect(community.getByRole('meter', { name: 'Cuota de la comunidad usada' }))
    .toHaveAttribute('aria-valuetext', expect.stringMatching(/^1,25 GiB de 2 GiB usados \(62,5\s%\)$/))
  expect(region('Disco del servidor').getByText('50 GiB libres de 200 GiB')).toBeVisible()
  expect(screen.getByRole('table', { name: 'Almacenamiento por vecino' })).toHaveTextContent('Cuenta eliminada')
  expect(screen.getByRole('button', { name: 'Ordenar por: Cuota usada' })).toBeVisible()
  const section = region('PDFs retirados')
  const entry = within(await section.findByRole('list', { name: 'PDFs retirados' })).getByRole('listitem')
  expect(entry).toHaveTextContent('40 MiB · Subido por Alice · Retirado: 10 oct 2026')
  expect(within(entry).getByRole('link', { name: 'Visualizar old-quote.pdf (nueva pestaña)' })).toBeVisible()
  fireEvent.click(section.getByRole('button', { name: 'Eliminar definitivamente: old-quote.pdf' }))
  const dialog = within(screen.getByRole('dialog', { name: 'Eliminar PDF definitivamente' }))
  expect(dialog.getByText('El archivo se eliminará del servidor para siempre. No se puede deshacer.')).toBeVisible()
  fireEvent.click(dialog.getByRole('button', { name: 'Eliminar definitivamente' }))
  expect(await section.findByText('old-quote.pdf se ha eliminado definitivamente. Se han liberado 40 MiB.')).toBeVisible()

  act(() => setLanguage('en'))
  expect(screen.getByRole('heading', { name: 'Storage', level: 1 })).toBeVisible()
  expect(section.getByText('old-quote.pdf has been deleted permanently. 40 MiB freed.')).toBeVisible()
  expect(region('Community').getByText('1.25 GiB of 2 GiB used')).toBeVisible()
})
