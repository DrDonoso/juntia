import { QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest'
import { cache } from './api/client'
import type { ResidentStorageOut, StorageOut, StoredAttachmentOut, StoredAttachmentPage } from './api/schema.gen'
import { setLanguage } from './i18n'
import { StoragePage } from './storage'

const MiB = 1024 ** 2, GiB = 1024 ** 3
const alice: ResidentStorageOut = {
  user_id: 7, name: 'Alice', account_deleted: false, quota_bytes: 250 * MiB,
  stored_bytes: 240 * MiB, active_bytes: 200 * MiB, withdrawn_bytes: 40 * MiB, active_files: 10, withdrawn_files: 2,
}
const ben: ResidentStorageOut = {
  user_id: 8, name: 'Ben', account_deleted: true, quota_bytes: 250 * MiB,
  stored_bytes: 20 * MiB, active_bytes: 0, withdrawn_bytes: 20 * MiB, active_files: 0, withdrawn_files: 1,
}
const carol: ResidentStorageOut = {
  user_id: 9, name: 'Carol', account_deleted: false, quota_bytes: 250 * MiB,
  stored_bytes: 5 * MiB, active_bytes: 5 * MiB, withdrawn_bytes: 0, active_files: 1, withdrawn_files: 0,
}
const usage: StorageOut = {
  community: {
    quota_bytes: 2048 * MiB, stored_bytes: 1280 * MiB, active_bytes: GiB, withdrawn_bytes: 256 * MiB,
    active_files: 30, withdrawn_files: 5,
  },
  administrator: { stored_bytes: 15 * MiB, active_bytes: 10 * MiB, withdrawn_bytes: 5 * MiB, active_files: 2, withdrawn_files: 1 },
  residents: [alice, ben, carol],
  resident_quota_bytes: 250 * MiB,
  disk: { total_bytes: 200 * GiB, free_bytes: 50 * GiB, reserve_bytes: GiB },
}
const stamp = '2026-10-10T10:00:00Z'
const quote: StoredAttachmentOut = {
  id: 'pdf-1', filename: 'old-quote.pdf', size: 40 * MiB, sha256: 'a'.repeat(64),
  author: { kind: 'resident', user_id: 7, name: 'Alice' }, version: 2, created_at: '2026-09-01T08:00:00Z',
  withdrawn_at: stamp, purged_at: null, action_id: 12, action_title: 'Entrance door',
}
const defaults = cache.getDefaultOptions()
const originalShow = HTMLDialogElement.prototype.showModal
const originalClose = HTMLDialogElement.prototype.close
let summary: StorageOut, withdrawn: StoredAttachmentOut[], total: number | null
let purge: (body: unknown) => Response
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
  total = null
  requests.length = 0
  purge = () => {
    withdrawn = []
    return reply({ ...quote, purged_at: '2026-10-12T09:30:00Z', version: 3 })
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
  requests.push(options.method === 'POST' ? `POST ${input} ${String(options.body)}` : input)
  if (input === '/api/admin/storage') return reply(summary)
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
  const administrator = region('Technical administrator')
  expect(administrator.getByText('15 MiB stored')).toBeVisible()
  expect(administrator.getByText('No quota of its own: these PDFs count only towards the community quota.')).toBeVisible()
  expect(administrator.getByText('Withdrawn').nextElementSibling).toHaveTextContent('5 MiB · 1 PDF')
  const disk = region('Server disk')
  expect(disk.getByText('50 GiB free of 200 GiB')).toBeVisible()
  expect(disk.getByRole('meter', { name: 'Server disk space used' })).toHaveAttribute('aria-valuetext', '150 GiB of 200 GiB used (75%)')
  expect(disk.getByText('1 GiB are kept free as a reserve. Below it, PDF uploads and statement imports are refused.')).toBeVisible()
  expect(screen.queryByRole('alert')).toBeNull()
  const help = region('How storage limits work')
  for (const [label, size, setting] of [
    ['Quota per neighbor', '250 MiB', 'ACTION_STORAGE_USER_QUOTA_MB'],
    ['Community quota', '2 GiB', 'ACTION_STORAGE_COMMUNITY_QUOTA_MB'],
    ['Free disk reserve', '1 GiB', 'MIN_FREE_DISK_MB'],
  ]) {
    const value = help.getByText(label).nextElementSibling
    expect(value).toHaveTextContent(`${size}${setting}`)
    expect(value?.querySelector('code')).toHaveTextContent(setting)
  }
  expect(help.getByText('Withdrawn PDFs keep counting towards both quotas until you delete them permanently on this page.')).toBeVisible()
  expect(help.getByText('To change a limit, set the server environment variable shown next to it, in whole MiB, and recreate the Juntia container (docker compose up -d): a plain restart keeps the previous values.')).toBeVisible()
  expect(help.getByText('Deleting a PDF permanently cannot be undone.')).toBeVisible()
})

test.each([
  { name: 'a full community quota', change: (value: StorageOut) => { value.community.stored_bytes = 2100 * MiB }, alert: 'The community quota is full, so new PDFs are refused. Delete withdrawn PDFs permanently or raise the quota.' },
  { name: 'free space below the reserve', change: (value: StorageOut) => { value.disk.free_bytes = 512 * MiB }, alert: 'The free space is below the reserve, so PDF uploads and statement imports are refused. Free space on the server or delete withdrawn PDFs permanently.' },
  { name: 'a community quota almost full', change: (value: StorageOut) => { value.community.stored_bytes = 1900 * MiB }, warning: 'The community quota is almost full. Delete withdrawn PDFs permanently to free space.' },
  { name: 'free space close to the reserve', change: (value: StorageOut) => { value.disk.free_bytes = 1536 * MiB }, warning: 'The free space is close to the reserve. Free space on the server soon to keep accepting PDF uploads and statement imports.' },
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
  expect(disk.getByText('The server cannot read the free space of its upload folder right now. While it cannot, PDF uploads and statement imports are refused.'))
    .toHaveAttribute('role', 'status')
  expect(disk.queryByRole('meter')).toBeNull()
  expect(disk.getByText(/^1 GiB are kept free/)).toBeVisible()
  expect(screen.queryByRole('alert')).toBeNull()
})

test('neighbors are listed in the order returned, with their quota use and deleted accounts flagged', async () => {
  summary.residents = [alice, ben, { ...carol, name: '' }]
  renderPage()
  const table = await screen.findByRole('table', { name: 'Storage by neighbor' })
  expect(within(table).getAllByRole('columnheader').map(header => header.textContent)).toEqual(['Neighbor', 'Active PDFs', 'Withdrawn PDFs', 'Quota used'])
  const rows = within(table).getAllByRole('row').slice(1)
  expect(rows.map(row => within(row).getByRole('rowheader').textContent)).toEqual(['Alice', 'BenDeleted account', 'Neighbor #9'])
  expect(rows[0]).toHaveTextContent('200 MiB10 PDFs')
  expect(rows[0]).toHaveTextContent('40 MiB2 PDFs')
  expect(rows[0]).toHaveTextContent('240 MiB of 250 MiB used')
  const meter = within(rows[0]).getByRole('meter', { name: 'Quota used by Alice' })
  expect(meter).toHaveAttribute('aria-valuetext', '240 MiB of 250 MiB used (96%)')
  expect(meter).toHaveAttribute('data-level', 'warning')
  expect(within(rows[1]).getByText('Deleted account')).toHaveClass('tag')
  expect(within(rows[1]).getByRole('meter', { name: 'Quota used by Ben' })).toHaveAttribute('data-level', 'normal')
  expect(screen.getByText('Each neighbor can keep up to 250 MiB of PDFs, counting active and withdrawn ones. The neighbors using the most space come first.')).toBeVisible()
})

test('without stored PDFs the page says so', async () => {
  summary = { ...summary, residents: [] }
  withdrawn = []
  renderPage()
  expect(await screen.findByText('No neighbor has stored PDFs yet.')).toBeVisible()
  expect(await screen.findByText('There are no withdrawn PDFs using space.')).toBeVisible()
  expect(screen.queryByText(/still uses? space/)).toBeNull()
  expect(screen.queryByRole('table')).toBeNull()
  expect(screen.queryByRole('list', { name: 'Withdrawn PDFs' })).toBeNull()
})

test('withdrawn PDFs can be sorted, filtered by neighbor and paged', async () => {
  total = 21
  renderPage()
  const section = region('Withdrawn PDFs')
  const list = await section.findByRole('list', { name: 'Withdrawn PDFs' })
  expect(requests).toContain('/api/admin/storage/withdrawn?page=1&sort=largest')
  const entry = within(list).getByRole('listitem')
  expect(entry).toHaveTextContent('old-quote.pdf')
  expect(entry).toHaveTextContent('40 MiB · Uploaded by Alice')
  const withdrawnAt = within(entry).getByText('Withdrawn:', { exact: false })
  expect(withdrawnAt).toHaveTextContent('Withdrawn: 10 Oct 2026')
  expect(withdrawnAt.querySelector('time')).toHaveAttribute('datetime', stamp)
  expect(within(entry).getByRole('link', { name: '#12 · Entrance door' })).toHaveAttribute('href', '/actions/12')
  expect(within(entry).getByRole('button', { name: 'Delete permanently: old-quote.pdf' })).toHaveTextContent('Delete permanently')
  expect(section.getByText('21 withdrawn PDFs still use space.')).toBeVisible()

  const author = section.getByRole('combobox', { name: 'Uploaded by' })
  expect(within(author).getAllByRole('option').map(option => option.textContent)).toEqual(['Everyone', 'Alice', 'Ben (deleted account)'])
  fireEvent.click(section.getByRole('button', { name: 'Next: withdrawn PDFs' }))
  await waitFor(() => expect(requests).toContain('/api/admin/storage/withdrawn?page=2&sort=largest'))
  expect(await section.findByText('There are no withdrawn PDFs on this page.')).toBeVisible()
  fireEvent.change(section.getByRole('combobox', { name: 'Sort by' }), { target: { value: 'oldest' } })
  await waitFor(() => expect(requests).toContain('/api/admin/storage/withdrawn?page=1&sort=oldest'))
  fireEvent.change(author, { target: { value: '8' } })
  await waitFor(() => expect(requests).toContain('/api/admin/storage/withdrawn?page=1&sort=oldest&user_id=8'))
  expect(author).toHaveDisplayValue('Ben (deleted account)')
  withdrawn = []
  total = 0
  // The neighbor stays selectable after their last withdrawn PDF is gone.
  summary.residents = [alice]
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
  expect(await section.findByText('This neighbor has no withdrawn PDFs using space.')).toBeVisible()
  expect(author).toHaveDisplayValue('Ben (deleted account)')
  fireEvent.change(author, { target: { value: '' } })
  await waitFor(() => expect(requests.at(-1)).toBe('/api/admin/storage/withdrawn?page=1&sort=oldest'))
  expect(await section.findByText('There are no withdrawn PDFs using space.')).toBeVisible()
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
  const section = region('PDFs retirados')
  const entry = within(await section.findByRole('list', { name: 'PDFs retirados' })).getByRole('listitem')
  expect(entry).toHaveTextContent('40 MiB · Subido por Alice')
  expect(entry).toHaveTextContent('Retirado: 10 oct 2026')
  expect(section.getByRole('combobox', { name: 'Subido por' })).toHaveDisplayValue('Todos')
  expect(within(section.getByRole('combobox', { name: 'Ordenar por' })).getAllByRole('option').map(option => option.textContent))
    .toEqual(['Más grandes primero', 'Retirada más antigua primero'])
  fireEvent.click(section.getByRole('button', { name: 'Eliminar definitivamente: old-quote.pdf' }))
  const dialog = within(screen.getByRole('dialog', { name: 'Eliminar PDF definitivamente' }))
  expect(dialog.getByText('El archivo se eliminará del servidor para siempre. No se puede deshacer.')).toBeVisible()
  fireEvent.click(dialog.getByRole('button', { name: 'Eliminar definitivamente' }))
  expect(await section.findByText('old-quote.pdf se ha eliminado definitivamente. Se han liberado 40 MiB.')).toBeVisible()
  expect(region('Cómo funcionan los límites de almacenamiento').getByText('Cuota por vecino')).toBeVisible()

  act(() => setLanguage('en'))
  expect(screen.getByRole('heading', { name: 'Storage', level: 1 })).toBeVisible()
  expect(section.getByText('old-quote.pdf has been deleted permanently. 40 MiB freed.')).toBeVisible()
  expect(region('Community').getByText('1.25 GiB of 2 GiB used')).toBeVisible()
})
