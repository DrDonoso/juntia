import { type ReactNode } from 'react'
import { QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest'
import { cache, signedOut } from './api/client'
import type { ActionAttachmentOut, ActionChange, ActionCommentOut, ActionEventOut, ActionOut, UserAuthOut } from './api/schema.gen'
import { ActionAttachments, ActionComments, ActionDetailPage, ActionEditor, ActionsPage } from './community-actions'
import { ActionsBoard } from './community-actions-board'
import { PDF_BYTES, actionDraft, actionRequestParams, actionStatuses, attachmentCountLabel, byteSize, canModerate, commentCountLabel, createUploadId, rebaseActionDraft, type ActionStatus } from './community-action-shared'
import { paletteColor, tagTextColor } from './contact-tags'
import { setLanguage, translate } from './i18n'

const reader: UserAuthOut = { ...signedOut, authenticated: true, kind: 'resident', user_id: 7, name: 'Alice' }
const actor = { kind: 'resident' as const, user_id: 7, name: 'Alice' }
// Whatever name arrives for an administrator author (here a login), the UI must never show it.
const administrator = { kind: 'administrator' as const, user_id: null, name: 'ops-admin' }
const stamp = '2026-10-10T10:00:00Z'
const item: ActionOut = {
  id: 1, title: 'Entrance door', description: 'Check the lock', status: 'detected',
  labels: [{ id: 1, name: 'Doors', color: null, version: 1 }], author: actor, version: 1,
  created_at: stamp, updated_at: stamp, comment_count: 0, attachment_count: 0,
}
const comment: ActionCommentOut = {
  id: 1, body: 'My comment', author: actor, version: 1, created_at: stamp,
  updated_at: stamp, withdrawn_at: null,
}
const attachment: ActionAttachmentOut = {
  id: 'pdf-id', filename: 'quote.pdf', size: 1500, sha256: 'a'.repeat(64), author: actor,
  version: 1, created_at: stamp, withdrawn_at: null, purged_at: null,
}
const statusNames: Record<ActionStatus, string> = {
  detected: 'Detected', quoting: 'Requesting quotes', voting: 'Voting', approved: 'Approved',
  ordered: 'Ordered / paid', in_progress: 'In progress', done: 'Done', discarded: 'Discarded',
}
const defaults = cache.getDefaultOptions()
const originalShow = HTMLDialogElement.prototype.showModal
const originalClose = HTMLDialogElement.prototype.close

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', '') }
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open') }
})
afterAll(() => {
  HTMLDialogElement.prototype.showModal = originalShow
  HTMLDialogElement.prototype.close = originalClose
})
beforeEach(() => {
  cache.setDefaultOptions({ queries: { retry: false, staleTime: Infinity } })
  cache.setQueryData(['reader-auth'], reader)
  cache.setQueryData(['features'], { actions: true, coefficient: true, events: false, google_login: false })
})
afterEach(() => {
  cleanup(); cache.clear(); cache.setDefaultOptions(defaults); vi.restoreAllMocks(); vi.unstubAllGlobals()
})

function reply(body: unknown, status = 200) {
  return new Response(status === 204 ? null : JSON.stringify(body), { status })
}

function page<T>(items: T[], total = items.length, page = 1) {
  return { items, total, page, pages: Math.max(1, Math.ceil(total / 20)) }
}

function renderView(children: ReactNode, path = '/actions') {
  return render(<QueryClientProvider client={cache}><MemoryRouter initialEntries={[path]}>{children}</MemoryRouter></QueryClientProvider>)
}

async function openHistory(changes: ActionChange[], administration = false) {
  if (administration) cache.setQueryData(['reader-auth'], { ...reader, kind: 'administrator', user_id: null })
  const event: ActionEventOut = {
    id: 2, kind: 'updated', author: actor, created_at: stamp, changes, comment_id: null, attachment_id: null,
  }
  cache.setQueryData(['actions', 'item', item.id], item)
  cache.setQueryData(['actions', 'comments', item.id, 1], page([]))
  cache.setQueryData(['actions', 'attachments', item.id, 1], page([]))
  cache.setQueryData(['actions', 'history', item.id, 1], page([event]))
  renderView(<Routes><Route path="/actions/:itemId" element={<ActionDetailPage />} /></Routes>, `/actions/${item.id}`)
  fireEvent.click(screen.getByRole('button', { name: 'History' }))
  const dialog = screen.getByRole('dialog', { name: 'Change history' })
  expect(dialog.querySelector('.action-diff')).toBeNull()
  fireEvent.click(within(dialog).getByText('View changes'))
  await waitFor(() => expect(dialog.querySelector('.action-changes')).toBeVisible())
  return dialog
}

test.each([false, true])('disabled actions do not mount list or detail queries (detail: %s)', async detail => {
  cache.setQueryData(['features'], { actions: false, coefficient: true, events: false, google_login: false })
  const fetcher = vi.fn()
  vi.stubGlobal('fetch', fetcher)
  renderView(detail
    ? <Routes><Route path="/actions/:itemId" element={<ActionDetailPage />} /></Routes>
    : <ActionsPage />, detail ? '/actions/1' : '/actions')
  expect(await screen.findByRole('heading', { name: 'Actions turned off' })).toBeVisible()
  expect(screen.getByText('This section has been turned off in the administration. Its data is kept.')).toBeVisible()
  expect(screen.queryByRole('button', { name: 'New action' })).toBeNull()
  expect(screen.queryByLabelText('New comment')).toBeNull()
  expect(fetcher).not.toHaveBeenCalled()
})

test('filters retain multiple labels but never send presentation parameters to the API', () => {
  const params = new URLSearchParams('q=door&label=2&label=7&scope=all&status=done&view=board&page=3&sort=title&direction=asc')
  expect(actionRequestParams(params).toString()).toBe('q=door&status=done&label=2&label=7&scope=all')
  expect(params.get('page')).toBe('3')
})

test.each([false, true])('labels keep their editor colors in the list, Kanban and detail (administration: %s)', async administration => {
  if (administration) cache.setQueryData(['reader-auth'], { ...reader, kind: 'administrator', user_id: null })
  const labeledItem = { ...item, labels: [...item.labels, { id: 2, name: 'elevator', color: '#aabbcc', version: 2 }] }
  const basePath = '/actions'
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    if (input.startsWith('/api/actions/labels?')) return reply(page(labeledItem.labels))
    if (input.startsWith('/api/actions/items?')) return reply(page([labeledItem]))
    if (input.startsWith('/api/actions/board?')) return reply({
      columns: actionStatuses.map(status => ({ ...page(status === labeledItem.status ? [labeledItem] : []), status })),
    })
    if (input === '/api/actions/items/1') return reply(labeledItem)
    if (input.startsWith('/api/actions/items/1/comments?') || input.startsWith('/api/actions/items/1/attachments?')) return reply(page([]))
    throw new Error(`Unexpected request: ${input}`)
  }))
  function expectLabelColors(container: HTMLElement) {
    for (const label of labeledItem.labels) {
      const color = label.color ?? paletteColor(label.name)
      expect(within(container).getByText(label.name).closest('.tag')).toHaveStyle({
        backgroundColor: color, color: tagTextColor(color),
      })
    }
  }
  renderView(<Routes>
    <Route path={basePath} element={<ActionsPage />} />
    <Route path={`${basePath}/:itemId`} element={<ActionDetailPage />} />
  </Routes>, basePath)
  await screen.findByRole('link', { name: `#${item.id} · ${item.title}` })
  expectLabelColors(screen.getByRole('table', { name: 'Community actions' }))
  fireEvent.click(screen.getByRole('button', { name: 'Kanban' }))
  const link = await screen.findByRole('link', { name: item.title })
  const card = link.closest('li')
  if (!card) throw new Error('Missing action card')
  expectLabelColors(card)
  expect(within(card).getByText('Status', { exact: true })).toBeVisible()
  fireEvent.click(link)
  const heading = (await screen.findByRole('heading', { name: item.title })).closest('.page-heading')
  if (!(heading instanceof HTMLElement)) throw new Error('Missing action heading')
  expectLabelColors(heading)
  expect(within(heading).getByText('Status', { exact: true })).toBeVisible()
  fireEvent.click(screen.getByRole('button', { name: 'Edit action' }))
  expectLabelColors(await screen.findByRole('dialog', { name: 'Edit action' }))
})

test.each([false, true])('list status selectors omit the redundant label and still save changes (administration: %s)', async administration => {
  if (administration) cache.setQueryData(['reader-auth'], { ...reader, kind: 'administrator', user_id: null })
  let current = item
  const writes: unknown[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: string, options: RequestInit) => {
    if (input.startsWith('/api/actions/labels?')) return reply(page([]))
    if (input.startsWith('/api/actions/items?')) return reply(page([current]))
    if (input === '/api/actions/items/1' && options.method === 'PATCH') {
      writes.push(JSON.parse(String(options.body)))
      current = { ...current, status: 'quoting', version: current.version + 1 }
      return reply(current)
    }
    throw new Error(`Unexpected request: ${input}`)
  }))
  renderView(<ActionsPage />)
  const select = await screen.findByRole('combobox', { name: `Status of ${item.title}` })
  const cell = select.closest('td')
  if (!cell) throw new Error('Missing status cell')
  expect(within(cell).queryByText('Status', { exact: true })).toBeNull()
  expect(screen.getByRole('columnheader', { name: 'Status' })).toBeVisible()
  expect(select).toHaveValue(item.status)
  fireEvent.change(select, { target: { value: 'quoting' } })
  await waitFor(() => expect(writes).toEqual([{ version: item.version, status: 'quoting' }]))
  await waitFor(() => expect(select).toHaveValue('quoting'))
  expect(await screen.findByText('Status saved.')).toHaveAttribute('role', 'status')
})

test('list headers toggle ordering, retain filters and reset pagination without losing focus', async () => {
  const requests: URLSearchParams[] = [], boards: URLSearchParams[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    const params = new URL(input, 'http://localhost').searchParams
    if (input.startsWith('/api/actions/labels?')) return reply(page([
      { id: 4, name: 'Doors', color: null, version: 1 }, { id: 8, name: 'Entrance', color: null, version: 1 },
    ]))
    if (input.startsWith('/api/actions/items?')) {
      requests.push(params)
      return reply(page([item], 21, Number(params.get('page'))))
    }
    if (input.startsWith('/api/actions/board?')) {
      boards.push(params)
      return reply({ columns: actionStatuses.map(status => ({ ...page([]), status })) })
    }
    throw new Error(`Unexpected request: ${input}`)
  }))
  renderView(<ActionsPage />, '/actions?page=2&scope=all&q=door&label=4&label=8')
  await waitFor(() => expect(requests).toHaveLength(1))
  expect(requests[0].get('page')).toBe('2')
  expect(requests[0].get('sort')).toBe('activity')
  expect(requests[0].get('direction')).toBe('desc')
  expect(screen.getByRole('columnheader', { name: 'Activity' })).toHaveAttribute('aria-sort', 'descending')
  expect(await screen.findByText('21 actions match these filters')).toBeVisible()
  expect(screen.getByText('Filter by labels (2)')).toBeVisible()
  const title = screen.getByRole('button', { name: 'Sort by action' })
  title.focus()
  fireEvent.click(title)
  await waitFor(() => expect(requests.at(-1)?.get('sort')).toBe('title'))
  expect(requests.at(-1)?.get('direction')).toBe('asc')
  expect(requests.at(-1)?.get('page')).toBe('1')
  expect(title).toHaveFocus()
  expect(screen.getByRole('columnheader', { name: 'Action' })).toHaveAttribute('aria-sort', 'ascending')
  fireEvent.click(title)
  await waitFor(() => expect(requests.at(-1)?.get('direction')).toBe('desc'))
  expect(screen.getByRole('columnheader', { name: 'Action' })).toHaveAttribute('aria-sort', 'descending')
  fireEvent.click(screen.getByRole('button', { name: 'Sort by status' }))
  await waitFor(() => expect(requests.at(-1)?.get('sort')).toBe('status'))
  expect(requests.at(-1)?.get('direction')).toBe('asc')
  fireEvent.click(screen.getByRole('button', { name: 'Sort by activity' }))
  await waitFor(() => expect(requests.at(-1)?.get('sort')).toBe('activity'))
  expect(requests.at(-1)?.get('direction')).toBe('desc')
  fireEvent.click(screen.getByRole('button', { name: 'Sort by activity' }))
  await waitFor(() => expect(requests.at(-1)?.get('direction')).toBe('asc'))
  for (const request of requests) {
    expect(request.get('scope')).toBe('all')
    expect(request.get('q')).toBe('door')
    expect(request.getAll('label')).toEqual(['4', '8'])
  }
  fireEvent.click(screen.getByRole('button', { name: 'Kanban' }))
  await waitFor(() => expect(boards).toHaveLength(1))
  expect(boards[0].has('sort')).toBe(false)
  expect(boards[0].has('direction')).toBe(false)
  fireEvent.click(screen.getByRole('button', { name: 'List' }))
  expect(await screen.findByRole('columnheader', { name: 'Activity' })).toHaveAttribute('aria-sort', 'ascending')
  const link = await screen.findByRole('link', { name: `#${item.id} · ${item.title}` })
  expect(link.getAttribute('href')).toContain('sort=activity')
  expect(link.getAttribute('href')).toContain('direction=asc')
})

test('rebasing a stale draft keeps edits and updates untouched fields only', () => {
  const draft = { ...actionDraft(item), title: 'My title', labels: ['My label'] }
  const latest: ActionOut = { ...item, title: 'Another title', description: 'New description', status: 'approved', version: 2 }
  expect(rebaseActionDraft(draft, item, latest)).toEqual({
    title: 'My title', description: 'New description', status: 'approved', labels: ['My label'],
  })
})

test('rebasing label edits follows renamed label identities without recreating the old name', () => {
  const draft = { ...actionDraft(item), labels: ['Doors', 'My label', 'Access'] }
  const current = { ...item, labels: [{ ...item.labels[0], name: 'Access', color: '#123456', version: 2 }], version: 2 }
  expect(rebaseActionDraft(draft, item, current).labels).toEqual(['Access', 'My label'])
})

test('custom label colors survive filtered suggestions and labels outside the first catalog page', async () => {
  const user = userEvent.setup()
  const custom = { id: 42, name: 'Maintenance', color: '#123456', version: 2 }
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    const search = new URL(input, 'http://localhost').searchParams.get('q')
    return reply(page(search === 'main' ? [custom] : []))
  }))
  renderView(<ActionEditor value={item} close={vi.fn()} saved={vi.fn()} />)
  const input = screen.getByRole('combobox', { name: 'Labels' })
  await user.click(input)
  fireEvent.change(input, { target: { value: 'main' } })
  await user.click(await screen.findByRole('option', { name: custom.name }))
  await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull())
  expect(screen.getByText(custom.name).closest('.tag')).toHaveStyle({ backgroundColor: custom.color })
  fireEvent.change(input, { target: { value: 'another label' } })
  await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull())
  expect(screen.getByText(custom.name).closest('.tag')).toHaveStyle({ backgroundColor: custom.color })
  fireEvent.change(input, { target: { value: '' } })
  expect(screen.getByText(custom.name).closest('.tag')).toHaveStyle({ backgroundColor: custom.color })
})

test('moderation is limited to the author and technical administrator', () => {
  expect(canModerate(actor, reader)).toBe(true)
  expect(canModerate(actor, { ...reader, user_id: 8 })).toBe(false)
  expect(canModerate(actor, { ...reader, kind: 'administrator', user_id: null })).toBe(true)
  expect(canModerate(actor, signedOut)).toBe(false)
})

test('small nonempty PDFs never display as zero MiB and sizes follow the language', () => {
  expect(byteSize(1)).toBe('1 B')
  expect(byteSize(1023)).toBe('1,023 B')
  expect(byteSize(1536)).toBe('1.5 KiB')
  expect(byteSize(PDF_BYTES)).toBe('20 MiB')
  // Binary units like the server's MiB settings, never rounded up to "1,024" of the smaller unit.
  expect(byteSize(1024 * 1024 - 1)).toBe('1 MiB')
  expect(byteSize(1.25 * 1024 ** 3)).toBe('1.25 GiB')
  expect(byteSize(2048 * 1024 ** 2)).toBe('2 GiB')
  expect(byteSize(3.5 * 1024 ** 4)).toBe('3.5 TiB')
  setLanguage('es')
  expect(byteSize(1536)).toBe('1,5 KiB')
  expect(byteSize(PDF_BYTES)).toBe('20 MiB')
  expect(byteSize(1.25 * 1024 ** 3)).toBe('1,25 GiB')
})

test('summary counts use the correct singular or plural in each language', () => {
  expect(attachmentCountLabel(0)).toBe('0 attachments')
  expect(attachmentCountLabel(1)).toBe('1 attachment')
  expect(attachmentCountLabel(20)).toBe('20 attachments')
  expect(commentCountLabel(0)).toBe('0 comments')
  expect(commentCountLabel(1)).toBe('1 comment')
  expect(commentCountLabel(1234)).toBe('1,234 comments')
  setLanguage('es')
  expect(attachmentCountLabel(0)).toBe('0 adjuntos')
  expect(attachmentCountLabel(1)).toBe('1 adjunto')
  expect(attachmentCountLabel(20)).toBe('20 adjuntos')
  expect(commentCountLabel(1)).toBe('1 comentario')
  expect(commentCountLabel(12345)).toBe('12.345 comentarios')
})

test('upload identifiers work without secure-context-only randomUUID', () => {
  const random = vi.fn((bytes: Uint8Array) => bytes.fill(0))
  vi.stubGlobal('crypto', { getRandomValues: random })
  expect(createUploadId()).toBe('00000000-0000-4000-8000-000000000000')
  expect(random).toHaveBeenCalledOnce()
})

test('the editor description has a stable accessible label when its content is already populated', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => reply(page([]))))
  renderView(<ActionEditor value={{ ...item, description: 'First line\nSecond line' }} close={vi.fn()} saved={vi.fn()} />)
  const description = screen.getByLabelText('Description')
  expect(description).toHaveAccessibleName('Description')
  fireEvent.change(description, { target: { value: 'Updated description' } })
  expect(description).toHaveAccessibleName('Description')
  await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
})

test('the editor keeps a stale draft and requires explicit reconciliation before saving', async () => {
  const current: ActionOut = { ...item, description: 'Change by another neighbor', status: 'ordered', version: 2 }
  const writes: unknown[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: string, options: RequestInit) => {
    if (input.startsWith('/api/actions/labels?')) return reply(page([]))
    if (options.method === 'PATCH') {
      writes.push(JSON.parse(String(options.body)))
      return writes.length === 1 ? reply({ code: 'action_stale' }, 409)
        : reply({ ...current, title: 'My proposal', version: 3 })
    }
    if (input === '/api/actions/items/1') return reply(current)
    throw new Error(`Unexpected request: ${input}`)
  }))
  const saved = vi.fn()
  renderView(<ActionEditor value={item} close={vi.fn()} saved={saved} />)
  fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'My proposal' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save action' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('your draft is kept')
  expect(screen.getByRole('region', { name: 'Editing conflict' })).toHaveTextContent('Your draft is still in the form.')
  expect(screen.getByLabelText('Title')).toHaveValue('My proposal')
  expect(screen.getByRole('button', { name: 'Save action' })).toBeDisabled()
  expect(saved).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Check current version' }))
  await screen.findByRole('heading', { name: 'Current version' })
  expect(screen.getByRole('region', { name: 'Current version of the action' })).toHaveTextContent('Ordered / paid · Doors')
  expect(screen.getByLabelText('Description')).toHaveValue(item.description)
  fireEvent.click(screen.getByRole('button', { name: 'Update and keep my draft' }))
  expect(screen.getByLabelText('Title')).toHaveValue('My proposal')
  expect(screen.getByLabelText('Description')).toHaveValue(current.description)
  expect(screen.getByRole('combobox', { name: 'Status' })).toHaveValue('ordered')
  fireEvent.click(screen.getByRole('button', { name: 'Save action' }))
  await waitFor(() => expect(saved).toHaveBeenCalledOnce())
  expect(writes[1]).toEqual({
    title: 'My proposal', description: current.description, status: 'ordered', labels: ['Doors'], version: 2,
  })
})

test('new actions detect their status and use the shared tag picker with label texts', async () => {
  const user = userEvent.setup()
  let submitted: unknown
  vi.stubGlobal('fetch', vi.fn(async (input: string, options: RequestInit) => {
    if (input.startsWith('/api/actions/labels?')) return reply(page(item.labels))
    if (input === '/api/actions/items' && options.method === 'POST') {
      submitted = JSON.parse(String(options.body)); return reply(item, 201)
    }
    throw new Error(`Unexpected request: ${input}`)
  }))
  const saved = vi.fn()
  renderView(<ActionEditor value={null} close={vi.fn()} saved={saved} />)
  expect(screen.getByRole('dialog', { name: 'New action' })).toBeVisible()
  expect(screen.queryByRole('combobox', { name: 'Status' })).toBeNull()
  expect(screen.getByText('After saving, you can attach several PDFs on the action page.')).toBeVisible()
  expect(screen.queryByText(/Everything published will be visible/)).toBeNull()
  fireEvent.change(screen.getByLabelText('Title'), { target: { value: item.title } })
  expect(screen.queryByRole('combobox', { name: 'Tags' })).toBeNull()
  const labels = screen.getByRole('combobox', { name: 'Labels' })
  await user.click(labels)
  fireEvent.change(labels, { target: { value: 'Doors' } })
  expect(screen.getByLabelText('Label preview')).toHaveStyle({ backgroundColor: paletteColor('doors') })
  expect(screen.queryByLabelText('Tag preview')).toBeNull()
  await screen.findByRole('option', { name: 'Doors' })
  expect(screen.getByRole('listbox')).toHaveAttribute('aria-label', 'Available labels')
  fireEvent.keyDown(labels, { key: 'Enter' })
  expect(labels).toHaveValue('')
  expect(within(screen.getByRole('grid', { name: 'Selected labels' })).getByRole('button', { name: 'Remove Doors' })).toBeVisible()
  fireEvent.blur(labels)
  expect(screen.queryByRole('alert')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Save action' }))
  await waitFor(() => expect(saved).toHaveBeenCalledOnce())
  expect(submitted).toEqual({ title: item.title, description: '', labels: ['Doors'] })
})

test('label errors explain the problem and follow the active language', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => reply(page([]))))
  const full = { ...item, labels: Array.from({ length: 20 }, (_, index) => ({ id: index + 1, name: `label ${index + 1}`, color: null, version: 1 })) }
  renderView(<ActionEditor value={full} close={vi.fn()} saved={vi.fn()} />)
  const labels = screen.getByRole('combobox', { name: 'Labels' })
  fireEvent.change(labels, { target: { value: 'one more' } })
  fireEvent.keyDown(labels, { key: 'Enter' })
  expect(await screen.findByText('You can add up to 20 labels.')).toBeVisible()
  fireEvent.change(labels, { target: { value: 'x'.repeat(101) } })
  fireEvent.keyDown(labels, { key: 'Enter' })
  expect(await screen.findByText('Enter a label of 1 to 100 visible characters.')).toBeVisible()
  expect(screen.getByRole('grid', { name: 'Selected labels' })).toBeVisible()
  act(() => setLanguage('es'))
  expect(await screen.findByText('Escribe una etiqueta de entre 1 y 100 caracteres visibles.')).toBeVisible()
  expect(screen.getByRole('combobox', { name: 'Etiquetas' })).toBe(labels)
  expect(screen.getByRole('grid', { name: 'Etiquetas seleccionadas' })).toBeVisible()
  expect(screen.getByLabelText('Vista previa de etiqueta')).toBeInTheDocument()
})

test('comment tools respect ownership and withdrawn comments do not expose their body', async () => {
  const values = [
    comment,
    { ...comment, id: 2, author: { ...actor, user_id: 8, name: 'Ben' } },
    { ...comment, id: 3, body: null, withdrawn_at: stamp },
  ]
  vi.stubGlobal('fetch', vi.fn(async () => reply(page(values))))
  const onHistory = vi.fn()
  renderView(<ActionComments itemId={1} reader={reader} onHistory={onHistory} />)
  expect(await screen.findByRole('button', { name: 'Edit comment 1' })).toBeVisible()
  expect(screen.queryByRole('button', { name: 'Edit comment 2' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Withdraw comment 2' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Edit comment 3' })).toBeNull()
  expect(screen.getByText('Comment withdrawn. The text is kept in the history.')).toBeVisible()
  fireEvent.click(screen.getByRole('button', { name: 'View history' }))
  expect(onHistory).toHaveBeenCalledOnce()
  fireEvent.click(screen.getByRole('button', { name: 'Edit comment 1' }))
  const editor = await screen.findByRole('dialog', { name: 'Edit comment' })
  expect(within(editor).getByRole('textbox', { name: 'Comment' })).toHaveValue('My comment')
  expect(within(editor).getByText('The previous text will be kept in the history.')).toBeVisible()
})

test('history opens on demand in a paginated modal without replacing the comment draft', async () => {
  const changed: ActionEventOut = {
    id: 2, kind: 'updated', author: actor, created_at: stamp,
    changes: [{ field: 'title', before: 'Previous title', after: item.title }],
    comment_id: null, attachment_id: null,
  }
  const withdrawn: ActionEventOut = {
    ...changed, id: 1, kind: 'attachment_withdrawn', attachment_id: 'retired-pdf',
    changes: [{ field: 'filename', before: 'old-quote.pdf', after: null }],
  }
  const requests: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    requests.push(input)
    if (input === '/api/actions/items/1') return reply(item)
    if (input.startsWith('/api/actions/items/1/attachments?')) return reply(page([]))
    if (input === '/api/actions/items/1/attachments/retired-pdf') return reply({ ...attachment, id: 'retired-pdf', filename: 'old-quote.pdf', withdrawn_at: stamp })
    if (input.startsWith('/api/actions/items/1/comments?')) return reply(page([{ ...comment, body: null, withdrawn_at: stamp }]))
    if (input === '/api/actions/items/1/history?page=1') return reply(page([changed], 21))
    if (input === '/api/actions/items/1/history?page=2') return reply(page([withdrawn], 21, 2))
    throw new Error(`Unexpected request: ${input}`)
  }))
  renderView(<Routes><Route path="/actions/:itemId" element={<ActionDetailPage />} /></Routes>, '/actions/1')
  expect(await screen.findByRole('heading', { name: 'Attachments' })).toBeVisible()
  expect(screen.queryByText(/Everything published will be visible/)).toBeNull()
  expect(screen.queryByText(/Quotes and scanned documents are accepted/)).toBeNull()
  expect(screen.queryByText(/They will upload automatically/)).toBeNull()
  expect(screen.getByText('0 of 20 active PDFs. Up to 20 MiB per file.')).toBeVisible()
  expect(screen.getByText('You can select several documents.')).toBeVisible()
  expect(screen.getByText('ACTION #1')).toBeVisible()
  const description = screen.getByRole('heading', { name: 'Description' }).closest('section')
  const heading = screen.getByRole('heading', { name: item.title }).closest('.page-heading')
  if (!(description instanceof HTMLElement) || !(heading instanceof HTMLElement)) throw new Error('Missing action detail sections')
  expect(description).toHaveTextContent('Created by Alice · ')
  expect(description).toHaveTextContent('Last activity: ')
  expect(within(description).queryByRole('combobox')).toBeNull()
  expect(within(heading).getByRole('combobox', { name: `Status of ${item.title}` })).toBeVisible()
  expect(screen.queryByRole('checkbox', { name: 'Show withdrawn PDFs' })).toBeNull()
  expect(screen.queryByText(/You can skip stages and reopen actions/)).toBeNull()
  expect(screen.queryByRole('heading', { name: 'Change history' })).toBeNull()
  expect(requests.some(path => path.includes('/history'))).toBe(false)
  fireEvent.change(screen.getByLabelText('New comment'), { target: { value: 'Unpublished draft' } })
  const opener = screen.getByRole('button', { name: 'History' })
  opener.focus()
  fireEvent.click(opener)
  const dialog = await screen.findByRole('dialog', { name: 'Change history' })
  expect(await within(dialog).findByText('Updated the action')).toBeVisible()
  expect(requests).not.toContain('/api/actions/items/1/attachments/retired-pdf')
  fireEvent.click(within(dialog).getByRole('button', { name: 'Next: history' }))
  expect(await within(dialog).findByText('Withdrew a PDF')).toBeVisible()
  expect(await within(dialog).findByRole('button', { name: 'Download old-quote.pdf' })).toBeVisible()
  expect(requests).toContain('/api/actions/items/1/attachments/retired-pdf')
  expect(within(dialog).getByRole('link', { name: 'View old-quote.pdf (new tab)' })).toHaveAttribute('title', 'View PDF (new tab)')
  fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(opener).toHaveFocus()
  expect(screen.getByLabelText('New comment')).toHaveValue('Unpublished draft')
  fireEvent.click(screen.getByRole('button', { name: 'View history' }))
  const reopened = await screen.findByRole('dialog', { name: 'Change history' })
  expect(await within(reopened).findByText('Updated the action')).toBeVisible()
})

test.each([false, true])('history shows unified changes without repeating context (administration: %s)', async administration => {
  const before = 'Unchanged paragraph\n\nPrevious reference\nAnother unchanged paragraph\nRemove at the end'
  const after = 'Unchanged paragraph\n\nUpdated reference\nAnother unchanged paragraph\nNew reference\nAdded text'
  const dialog = await openHistory([{ field: 'description', before, after }], administration)
  const diff = within(dialog).getByRole('group', { name: 'Changes to description' })
  expect(within(diff).getByText('Unchanged paragraph')).toBeVisible()
  expect(within(diff).getByText('Another unchanged paragraph')).toBeVisible()
  const removed = within(diff).getByText('Previous reference'), added = within(diff).getByText('Updated reference')
  expect(removed.tagName).toBe('DEL')
  expect(removed.parentElement).toHaveClass('action-diff-removed')
  expect(added.tagName).toBe('INS')
  expect(added.parentElement).toHaveClass('action-diff-added')
  expect(within(added.parentElement!).getByText('+')).toHaveAttribute('aria-hidden', 'true')
  expect(within(removed.parentElement!).getByText('-')).toHaveAttribute('aria-hidden', 'true')
  expect(within(added.parentElement!).getByText('Added:')).toHaveClass('sr-only')
  expect(within(removed.parentElement!).getByText('Removed:')).toHaveClass('sr-only')
  expect(within(within(diff).getByText('Unchanged paragraph').parentElement!).getByText('Unchanged:')).toHaveClass('sr-only')
  expect(Array.from(diff.querySelectorAll('.action-diff-line:not(.action-diff-added) .action-diff-content'), line => line.textContent).join('\n')).toBe(before)
  expect(Array.from(diff.querySelectorAll('.action-diff-line:not(.action-diff-removed) .action-diff-content'), line => line.textContent).join('\n')).toBe(after)
  expect(within(dialog).getByText('Description', { selector: 'dt' })).toBeVisible()
  expect(within(dialog).queryByText('Before')).toBeNull()
  expect(within(dialog).queryByText('After')).toBeNull()
  expect(within(dialog).queryByText('+ Added')).toBeNull()
  expect(within(dialog).queryByText('- Removed')).toBeNull()
})

test.each<{ name: string; change: ActionChange; added: string[]; removed: string[]; context: string[] }>([
  {
    name: 'appended paragraphs without marking the original paragraph as changed',
    change: { field: 'description', before: 'Original description', after: 'Original description\n\nNew detail' },
    added: ['', 'New detail'], removed: [], context: ['Original description'],
  },
  {
    name: 'a removed line between unchanged lines',
    change: { field: 'description', before: 'Start\nRemove\nEnd', after: 'Start\nEnd' },
    added: [], removed: ['Remove'], context: ['Start', 'End'],
  },
  {
    name: 'a newly attached filename without a deleted placeholder',
    change: { field: 'filename', before: null, after: 'quote.pdf' },
    added: ['quote.pdf'], removed: [], context: [],
  },
  {
    name: 'withdrawn comments without an added placeholder',
    change: { field: 'comment', before: 'Previous comment', after: null },
    added: [], removed: ['Previous comment'], context: [],
  },
  {
    name: 'a cleared description',
    change: { field: 'description', before: 'Previous content', after: '' },
    added: [], removed: ['Previous content'], context: [],
  },
  {
    name: 'individual label additions and removals',
    change: { field: 'labels', before: ['elevator', 'lighting'], after: ['elevator', 'entrance'] },
    added: ['entrance'], removed: ['lighting'], context: ['elevator'],
  },
  {
    name: 'translated statuses',
    change: { field: 'status', before: 'detected', after: 'done' },
    added: ['Done'], removed: ['Detected'], context: [],
  },
  {
    name: 'formatted attachment sizes',
    change: { field: 'size', before: '1024', after: '2048' },
    added: ['2 KiB'], removed: ['1 KiB'], context: [],
  },
  {
    name: 'mixed line endings while preserving spaces and tabs',
    change: { field: 'description', before: 'Start\r\n \t\r\nEnd', after: 'Start\n \t\nNew\nEnd' },
    added: ['New'], removed: [], context: ['Start', ' \t', 'End'],
  },
  {
    name: 'an added trailing blank line',
    change: { field: 'comment', before: 'Comment', after: 'Comment\n' },
    added: [''], removed: [], context: ['Comment'],
  },
  {
    name: 'indentation-only edits',
    change: { field: 'comment', before: '  Comment', after: '    Comment' },
    added: ['    Comment'], removed: ['  Comment'], context: [],
  },
  {
    name: 'unchanged values',
    change: { field: 'title', before: 'Title', after: 'Title' },
    added: [], removed: [], context: ['Title'],
  },
])('history diffs $name', async ({ change, added, removed, context }) => {
  const dialog = await openHistory([change])
  for (const [kind, expected] of [['added', added], ['removed', removed], ['context', context]] as const) {
    expect(Array.from(dialog.querySelectorAll(`.action-diff-line.action-diff-${kind} .action-diff-content`), line => line.textContent)).toEqual(expected)
  }
})

test('history renders markup as plain text, not HTML', async () => {
  const text = '<img src="missing" onerror="alert(1)">\n<script>alert(2)</script>'
  const dialog = await openHistory([{ field: 'comment', before: null, after: text }])
  const diff = within(dialog).getByRole('group', { name: 'Changes to comment' })
  expect(diff.querySelectorAll('img, script')).toHaveLength(0)
  expect(Array.from(diff.querySelectorAll('ins'), line => line.textContent).join('\n')).toBe(text)
})

test.each<{ change: ActionChange; placeholder: string }>([
  { change: { field: 'description', before: null, after: '' }, placeholder: 'No content' },
  { change: { field: 'labels', before: null, after: [] }, placeholder: 'No labels' },
])('empty history values stay readable ($change.field)', async ({ change, placeholder }) => {
  const dialog = await openHistory([change])
  expect(within(dialog).getByText(placeholder)).toBeVisible()
  expect(dialog.querySelectorAll('ins, del')).toHaveLength(0)
})

test('large history edits keep both complete 20,000-character versions when alignment is bounded', async () => {
  const before = Array.from({ length: 551 }, (_, index) => `Original ${index}`.padEnd(35, 'a')).join('\n').padEnd(20_000, 'a')
  const after = Array.from({ length: 551 }, (_, index) => `New ${index}`.padEnd(35, 'b')).join('\n').padEnd(20_000, 'b')
  expect(before).toHaveLength(20_000)
  expect(after).toHaveLength(20_000)
  const dialog = await openHistory([{ field: 'description', before, after }])
  expect(within(dialog).getByText('The change is very large. Both complete versions are shown.')).toBeVisible()
  expect(Array.from(dialog.querySelectorAll('del'), line => line.textContent).join('\n')).toBe(before)
  expect(Array.from(dialog.querySelectorAll('ins'), line => line.textContent).join('\n')).toBe(after)
}, 10_000)

test('PDFs upload immediately without a queue and retry only failed files with the same upload ID', async () => {
  const uploads: { filename: string; id: string }[] = []
  const attachments: ActionAttachmentOut[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: string, options: RequestInit) => {
    if (options.method === 'POST') {
      expect(options.headers).toEqual({ 'X-Juntia-Request': '1' })
      if (!(options.body instanceof FormData)) throw new Error('Expected multipart')
      const file = options.body.get('file'), id = String(options.body.get('upload_id'))
      if (!(file instanceof File)) throw new Error('Expected a file')
      uploads.push({ filename: file.name, id })
      if (uploads.length === 2) return reply({ code: 'action_storage_error' }, 503)
      const attachment: ActionAttachmentOut = {
        id, filename: file.name, size: file.size, sha256: 'a'.repeat(64), author: actor,
        version: 1, created_at: stamp, withdrawn_at: null, purged_at: null,
      }
      attachments.push(attachment)
      return reply(attachment, 201)
    }
    if (input.startsWith('/api/actions/items/1/attachments?')) return reply(page(attachments))
    throw new Error(`Unexpected request: ${input}`)
  }))
  renderView(<ActionAttachments item={item} reader={reader} />)
  const files = [new File(['first'], 'first.pdf', { type: 'application/pdf' }), new File(['second'], 'second.pdf', { type: 'application/pdf' })]
  fireEvent.change(screen.getByLabelText('Upload PDF'), { target: { files } })
  expect(screen.getByRole('button', { name: 'Upload PDF' })).toBeDisabled()
  expect(screen.getByText('Uploading first.pdf… Keep this page open.')).toHaveAttribute('role', 'status')
  expect(screen.queryByRole('button', { name: 'Select PDFs' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Upload PDFs' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Clear queue' })).toBeNull()
  expect(screen.queryByRole('button', { name: /Remove from queue/ })).toBeNull()
  expect(await screen.findByRole('alert')).toHaveTextContent('second.pdf: The PDF storage could not be confirmed.')
  await waitFor(() => expect(screen.getByRole('button', { name: 'Retry second.pdf' })).toBeEnabled())
  expect(screen.getByRole('button', { name: 'Retry second.pdf' })).toHaveTextContent('Retry')
  fireEvent.click(screen.getByRole('button', { name: 'Retry second.pdf' }))
  await screen.findByRole('button', { name: 'Download second.pdf' })
  await waitFor(() => expect(screen.getByRole('button', { name: 'Upload PDF' })).toBeEnabled())
  expect(screen.queryByRole('alert')).toBeNull()
  expect(screen.queryByRole('button', { name: /Retry/ })).toBeNull()
  expect(uploads.map(upload => upload.filename)).toEqual(['first.pdf', 'second.pdf', 'second.pdf'])
  expect(uploads[1].id).toBe(uploads[2].id)
  expect(screen.getByRole('button', { name: 'Download first.pdf' })).toBeVisible()
  expect(screen.getByRole('button', { name: 'Download second.pdf' })).toBeVisible()
})

test('the file picker validates the complete selection before uploading and includes the exact size boundary', async () => {
  const uploads: number[] = []
  vi.stubGlobal('fetch', vi.fn(async (_input: string, options: RequestInit) => {
    if (options.method === 'POST') {
      if (!(options.body instanceof FormData)) throw new Error('Expected multipart')
      const file = options.body.get('file')
      if (!(file instanceof File)) throw new Error('Expected a file')
      uploads.push(file.size)
      return reply({ ...attachment, filename: file.name }, 201)
    }
    return reply(page([]))
  }))
  renderView(<ActionAttachments item={item} reader={reader} />)
  const file = new File([new Uint8Array(PDF_BYTES + 1)], 'large.pdf', { type: 'application/pdf' })
  const picker = screen.getByLabelText('Upload PDF')
  fireEvent.change(picker, { target: { files: [new File(['valid'], 'valid.pdf'), file] } })
  expect(await screen.findByRole('alert')).toHaveTextContent('large.pdf: The PDF exceeds the 20 MiB limit. This selection has not been uploaded.')
  expect(uploads).toEqual([])
  for (const invalid of [new File([], 'empty.pdf'), new File(['image'], 'image.png')]) {
    fireEvent.change(picker, { target: { files: [invalid] } })
    expect(screen.getByRole('alert')).toHaveTextContent(`${invalid.name}: Select a non-empty PDF. This selection has not been uploaded.`)
    expect(uploads).toEqual([])
  }
  fireEvent.change(picker, {
    target: { files: [new File([new Uint8Array(PDF_BYTES)], 'exact.pdf', { type: 'application/pdf' })] },
  })
  await waitFor(() => expect(uploads).toEqual([PDF_BYTES]))
  await waitFor(() => expect(screen.getByRole('button', { name: 'Upload PDF' })).toBeEnabled())
  expect(screen.queryByRole('alert')).toBeNull()
  expect(picker).toHaveAttribute('multiple')
  expect(picker).toHaveAttribute('accept', '.pdf,application/pdf')
})

test('the file picker enforces available slots and cancellation never uploads', async () => {
  let count = 19
  const writes = vi.fn()
  vi.stubGlobal('fetch', vi.fn(async (_input: string, options: RequestInit) => {
    if (options.method === 'POST') { writes(); count++; return reply(attachment, 201) }
    return reply(page([], count))
  }))
  renderView(<ActionAttachments item={{ ...item, attachment_count: 19 }} reader={reader} />)
  const picker = screen.getByLabelText('Upload PDF')
  fireEvent.change(picker, { target: { files: [] } })
  expect(writes).not.toHaveBeenCalled()
  fireEvent.change(picker, {
    target: { files: [new File(['a'], 'a.pdf'), new File(['b'], 'b.pdf')] },
  })
  expect(await screen.findByRole('alert')).toHaveTextContent('Only 1 PDF slot is left. This selection has not been uploaded; choose fewer files.')
  expect(writes).not.toHaveBeenCalled()
  fireEvent.change(picker, { target: { files: [new File(['a'], 'a.pdf')] } })
  await screen.findByText('20 of 20 active PDFs. Up to 20 MiB per file.')
  expect(writes).toHaveBeenCalledOnce()
  expect(screen.getByRole('button', { name: 'Upload PDF' })).toBeDisabled()
})

test.each([
  { code: 'action_attachment_limit', status: 409, message: 'The action already has 20 active PDFs.' },
  { code: 'action_storage_user_quota', status: 409, message: 'This PDF does not fit in your storage quota. Withdrawn PDFs also count: the administrator can free space by deleting them permanently.' },
  { code: 'action_storage_community_quota', status: 409, message: 'This PDF does not fit in the community storage quota. Withdrawn PDFs also count: the administrator can free space by deleting them permanently.' },
  { code: 'storage_low_space', status: 507, message: 'The server does not have enough free disk space, so nothing has been saved. Try again later or contact the administrator.' },
])('quota errors stop the automatic batch and identify files that were not sent ($code)', async ({ code, status, message }) => {
  const uploads = vi.fn()
  vi.stubGlobal('fetch', vi.fn(async (_input: string, options: RequestInit) => {
    if (options.method === 'POST') { uploads(); return reply({ code }, status) }
    return reply(page([]))
  }))
  renderView(<ActionAttachments item={item} reader={reader} />)
  fireEvent.change(screen.getByLabelText('Upload PDF'), {
    target: { files: [new File(['a'], 'a.pdf'), new File(['b'], 'b.pdf')] },
  })
  await screen.findByText('The upload was interrupted. The remaining files have not been sent; select them again once the error is resolved.')
  expect(screen.getByText(`a.pdf: ${message}`, { exact: false })).toHaveAttribute('role', 'alert')
  await waitFor(() => expect(screen.getByRole('button', { name: 'Upload PDF' })).toBeEnabled())
  expect(uploads).toHaveBeenCalledOnce()
  // Only a server-side failure can succeed later without a change: the full disk.
  if (status >= 500) expect(screen.getByRole('button', { name: 'Retry a.pdf' })).toBeEnabled()
  else expect(screen.queryByRole('button', { name: /Retry/ })).toBeNull()
})

test.each([reader, { ...reader, user_id: 8 }, { ...reader, kind: 'administrator' as const, user_id: null }])(
  'PDF icon controls show preview first and preserve moderation permissions (%s)', async currentReader => {
    vi.stubGlobal('fetch', vi.fn(async () => reply(page([attachment]))))
    renderView(<ActionAttachments item={item} reader={currentReader} />)
    const preview = await screen.findByRole('link', { name: 'View quote.pdf (new tab)' })
    expect(preview).toHaveAttribute('href', '/api/actions/items/1/attachments/pdf-id/preview')
    expect(preview).toHaveAttribute('target', '_blank')
    expect(preview).toHaveAttribute('rel', 'noopener noreferrer')
    expect(preview.parentElement?.firstElementChild).toBe(preview)
    expect(preview.querySelector('svg')).not.toBeNull()
    const download = screen.getByRole('button', { name: 'Download quote.pdf' })
    expect(download).toHaveAttribute('title', 'Download PDF')
    expect(download.querySelector('svg')).not.toBeNull()
    expect(download).toHaveTextContent('')
    expect(screen.getByText('1.46 KiB ·', { exact: false })).toHaveTextContent('1.46 KiB · Alice')
    for (const [name, title] of [['Rename quote.pdf', 'Rename PDF'], ['Withdraw quote.pdf', 'Withdraw PDF']]) {
      if (canModerate(actor, currentReader)) {
        const button = screen.getByRole('button', { name })
        expect(button).toHaveAttribute('title', title)
        expect(button.querySelector('svg')).not.toBeNull()
        expect(button).toHaveTextContent('')
      } else expect(screen.queryByRole('button', { name })).toBeNull()
    }
  },
)

test('withdrawn PDFs show when they were withdrawn and only keep the read-only controls', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => reply(page([{ ...attachment, withdrawn_at: stamp }]))))
  renderView(<ActionAttachments item={item} reader={reader} />)
  const withdrawnAt = await screen.findByText('Withdrawn:', { exact: false })
  expect(withdrawnAt.querySelector('time')).toHaveAttribute('datetime', stamp)
  expect(screen.getByRole('button', { name: 'Download quote.pdf' })).toBeVisible()
  expect(screen.queryByRole('button', { name: 'Rename quote.pdf' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Withdraw quote.pdf' })).toBeNull()
})

const purgedAt = '2026-10-12T09:30:00Z'

test.each([reader, { ...reader, kind: 'administrator' as const, user_id: null }])(
  'PDFs deleted permanently show when and never offer their file (%s)', async currentReader => {
    vi.stubGlobal('fetch', vi.fn(async () => reply(page([{ ...attachment, withdrawn_at: stamp, purged_at: purgedAt }]))))
    renderView(<ActionAttachments item={item} reader={currentReader} />)
    const purged = await screen.findByText('Permanently deleted:', { exact: false })
    expect(purged.querySelector('time')).toHaveAttribute('datetime', purgedAt)
    expect(screen.getByText('Withdrawn:', { exact: false }).querySelector('time')).toHaveAttribute('datetime', stamp)
    expect(screen.getByText('quote.pdf')).toBeVisible()
    expect(screen.queryByRole('link', { name: 'View quote.pdf (new tab)' })).toBeNull()
    for (const name of ['Download quote.pdf', 'Rename quote.pdf', 'Withdraw quote.pdf']) expect(screen.queryByRole('button', { name })).toBeNull()
    act(() => setLanguage('es'))
    expect(screen.getByText('Eliminado definitivamente:', { exact: false }).querySelector('time')).toHaveAttribute('datetime', purgedAt)
  },
)

test('history entries of a PDF deleted permanently never offer its file, wherever the purge is listed', async () => {
  const entry = (id: number, kind: ActionEventOut['kind'], attachmentId: string, filename: string): ActionEventOut => ({
    id, kind, author: actor, created_at: stamp, comment_id: null, attachment_id: attachmentId,
    changes: [kind === 'attachment_added' ? { field: 'filename', before: null, after: filename } : { field: 'filename', before: filename, after: null }],
  })
  const purge: ActionEventOut = {
    ...entry(5, 'attachment_purged', 'new-pdf', 'new.pdf'), author: administrator, created_at: purgedAt, changes: [
      { field: 'filename', before: 'new.pdf', after: null }, { field: 'size', before: '1500', after: null },
      { field: 'sha256', before: 'b'.repeat(64), after: null },
    ],
  }
  const requests: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    requests.push(input)
    if (input === '/api/actions/items/1') return reply(item)
    if (input.startsWith('/api/actions/items/1/attachments?') || input.startsWith('/api/actions/items/1/comments?')) return reply(page([]))
    // Its purge is on another page of the history: the PDF itself says so.
    if (input === '/api/actions/items/1/attachments/old-pdf') return reply({ ...attachment, id: 'old-pdf', filename: 'old.pdf', withdrawn_at: stamp, purged_at: purgedAt })
    if (input === '/api/actions/items/1/attachments/kept-pdf') return reply({ ...attachment, id: 'kept-pdf', filename: 'kept.pdf', withdrawn_at: stamp })
    if (input === '/api/actions/items/1/history?page=1') return reply(page([
      purge, entry(4, 'attachment_withdrawn', 'new-pdf', 'new.pdf'), entry(3, 'attachment_added', 'new-pdf', 'new.pdf'),
      entry(2, 'attachment_withdrawn', 'kept-pdf', 'kept.pdf'), entry(1, 'attachment_added', 'old-pdf', 'old.pdf'),
    ]))
    throw new Error(`Unexpected request: ${input}`)
  }))
  renderView(<Routes><Route path="/actions/:itemId" element={<ActionDetailPage />} /></Routes>, '/actions/1')
  fireEvent.click(await screen.findByRole('button', { name: 'History' }))
  const dialog = await screen.findByRole('dialog', { name: 'Change history' })
  const purgeEntry = (await within(dialog).findByText('Permanently deleted a withdrawn PDF')).closest('li')
  if (!purgeEntry) throw new Error('Missing purge entry')
  expect(purgeEntry).toHaveTextContent('Technical administrator')
  expect(await within(dialog).findByRole('button', { name: 'Download kept.pdf' })).toBeVisible()
  await waitFor(() => expect(within(dialog).getAllByText('Permanently deleted:', { exact: false })).toHaveLength(3))
  // The purge entry already says what happened: no repeated note there.
  expect(within(purgeEntry).queryByText('Permanently deleted:', { exact: false })).toBeNull()
  for (const filename of ['new.pdf', 'old.pdf']) {
    expect(within(dialog).queryByRole('button', { name: `Download ${filename}` })).toBeNull()
    expect(within(dialog).queryByRole('link', { name: `View ${filename} (new tab)` })).toBeNull()
  }
  // A purge listed on the page is enough: only the other PDFs are asked for their state.
  expect(requests).not.toContain('/api/actions/items/1/attachments/new-pdf')
  expect(requests).toContain('/api/actions/items/1/attachments/old-pdf')
  fireEvent.click(within(purgeEntry).getByText('View changes'))
  expect(await within(purgeEntry).findByText('SHA-256 checksum')).toBeVisible()
  expect(within(purgeEntry).getByText('1.46 KiB')).toBeVisible()
  expect(within(purgeEntry).getByText('b'.repeat(64))).toBeVisible()
})

test('a download of a PDF deleted permanently since the history loaded stops offering it', async () => {
  let purged = false
  const withdrawn: ActionEventOut = {
    id: 1, kind: 'attachment_withdrawn', author: actor, created_at: stamp, comment_id: null, attachment_id: 'pdf-id',
    changes: [{ field: 'filename', before: 'quote.pdf', after: null }],
  }
  const requests: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    requests.push(input)
    if (input === '/api/actions/items/1') return reply(item)
    if (input.startsWith('/api/actions/items/1/attachments?') || input.startsWith('/api/actions/items/1/comments?')) return reply(page([]))
    if (input === '/api/actions/items/1/attachments/pdf-id') return reply({ ...attachment, withdrawn_at: stamp, purged_at: purged ? purgedAt : null })
    if (input === '/api/actions/items/1/attachments/pdf-id/download') {
      purged = true
      return reply({ code: 'action_attachment_purged' }, 410)
    }
    if (input === '/api/actions/items/1/history?page=1') return reply(page([withdrawn]))
    throw new Error(`Unexpected request: ${input}`)
  }))
  renderView(<Routes><Route path="/actions/:itemId" element={<ActionDetailPage />} /></Routes>, '/actions/1')
  fireEvent.click(await screen.findByRole('button', { name: 'History' }))
  const dialog = await screen.findByRole('dialog', { name: 'Change history' })
  fireEvent.click(await within(dialog).findByRole('button', { name: 'Download quote.pdf' }))
  expect((await within(dialog).findByText('Permanently deleted:', { exact: false })).querySelector('time')).toHaveAttribute('datetime', purgedAt)
  expect(within(dialog).queryByRole('button', { name: 'Download quote.pdf' })).toBeNull()
  expect(within(dialog).queryByRole('link', { name: 'View quote.pdf (new tab)' })).toBeNull()
  expect(requests.filter(path => path === '/api/actions/items/1/attachments/pdf-id')).toHaveLength(2)
  expect(translate('en', 'errors.codes.action_attachment_purged')).toBe('This PDF has been deleted permanently. Its name, size and checksum remain in the history.')
})

test('withdrawing a PDF explains that it keeps counting until the administrator deletes it permanently', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => reply(page([attachment]))))
  renderView(<ActionAttachments item={item} reader={reader} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Withdraw quote.pdf' }))
  const dialog = within(await screen.findByRole('dialog', { name: 'Withdraw PDF' }))
  expect(dialog.getByText('quote.pdf')).toBeVisible()
  expect(dialog.getByText('The PDF stays available from the history and keeps counting towards the storage quotas until the administrator deletes it permanently.')).toBeVisible()
  expect(dialog.queryByText(/will not be permanently deleted/)).toBeNull()
})

test('renaming a PDF preserves its extension and refreshes the saved attachment', async () => {
  let current = attachment
  const writes: unknown[] = []
  vi.stubGlobal('fetch', vi.fn(async (_input: string, options: RequestInit) => {
    if (options.method === 'PATCH') {
      writes.push(JSON.parse(String(options.body)))
      current = { ...attachment, filename: 'Approved quote.pdf', version: 2 }
      return reply(current)
    }
    return reply(page([current]))
  }))
  renderView(<ActionAttachments item={item} reader={reader} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Rename quote.pdf' }))
  const dialog = await screen.findByRole('dialog', { name: 'Rename PDF' })
  const name = within(dialog).getByLabelText('PDF name')
  fireEvent.change(name, { target: { value: '../not-allowed.pdf' } })
  fireEvent.click(within(dialog).getByRole('button', { name: 'Save name' }))
  expect(within(dialog).getByRole('alert')).toHaveTextContent('Enter a name of up to 251 characters, without paths or control characters.')
  expect(name).toHaveAttribute('aria-invalid', 'true')
  expect(writes).toEqual([])
  fireEvent.change(name, { target: { value: 'Approved quote' } })
  expect(name).not.toHaveAttribute('aria-invalid')
  fireEvent.click(within(dialog).getByRole('button', { name: 'Save name' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(await screen.findByRole('button', { name: 'Download Approved quote.pdf' })).toBeVisible()
  expect(writes).toEqual([{ version: 1, filename: 'Approved quote.pdf' }])
})

test.each([false, true])('a stale PDF rename keeps the draft and checks the latest version (withdrawn: %s)', async withdrawn => {
  let current = attachment
  const writes: unknown[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: string, options: RequestInit) => {
    if (options.method === 'PATCH') {
      writes.push(JSON.parse(String(options.body)))
      if (writes.length === 1) {
        current = { ...attachment, filename: 'Other name.pdf', version: 2, withdrawn_at: withdrawn ? stamp : null }
        return reply({ code: 'action_stale' }, 409)
      }
      current = { ...current, filename: 'My name.pdf', version: 3 }
      return reply(current)
    }
    if (input === '/api/actions/items/1/attachments/pdf-id') return reply(current)
    return reply(page([current]))
  }))
  renderView(<ActionAttachments item={item} reader={reader} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Rename quote.pdf' }))
  const dialog = await screen.findByRole('dialog', { name: 'Rename PDF' })
  fireEvent.change(within(dialog).getByLabelText('PDF name'), { target: { value: 'My name' } })
  const save = within(dialog).getByRole('button', { name: 'Save name' })
  fireEvent.click(save)
  expect(await within(dialog).findByRole('alert')).toHaveTextContent('your draft is kept')
  expect(save).toBeDisabled()
  fireEvent.click(within(dialog).getByRole('button', { name: 'Check current name' }))
  await within(dialog).findByText('Other name.pdf')
  expect(within(dialog).getByRole('heading', { name: 'Current name' })).toBeVisible()
  expect(within(dialog).getByLabelText('PDF name')).toHaveValue('My name')
  if (withdrawn) {
    expect(save).toBeDisabled()
    expect(within(dialog).getByText('The PDF has been withdrawn. Its name can no longer be edited.')).toBeVisible()
    expect(within(dialog).queryByRole('button', { name: 'Keep my name over the current version' })).toBeNull()
  } else {
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep my name over the current version' }))
    fireEvent.click(save)
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(writes).toEqual([{ version: 1, filename: 'My name.pdf' }, { version: 2, filename: 'My name.pdf' }])
  }
})

test('a failed Kanban drop keeps the card in its persisted column', async () => {
  let mutation: unknown
  const columns = actionStatuses.map(status => ({
    ...page(status === 'detected' ? [item] : []), status,
  }))
  vi.stubGlobal('fetch', vi.fn(async (input: string, options: RequestInit) => {
    if (input.startsWith('/api/actions/board?')) return reply({ columns })
    if (options.method === 'PATCH') {
      mutation = JSON.parse(String(options.body)); return reply({ code: 'action_stale' }, 409)
    }
    throw new Error(`Unexpected request: ${input}`)
  }))
  renderView(<ActionsBoard filters="scope=all" basePath="/actions" search="?view=board&scope=all" />)
  const link = await screen.findByRole('link', { name: item.title })
  for (const status of actionStatuses) {
    const heading = screen.getByRole('heading', { name: statusNames[status] })
    expect(within(heading).getByText(statusNames[status])).toHaveClass('action-status', `action-status-${status}`)
  }
  const card = link.closest('li')
  if (!card) throw new Error('Missing card')
  expect(within(card).getByText('0 comments · 0 attachments')).toBeVisible()
  const source = screen.getByRole('region', { name: 'Detected' })
  const target = screen.getByRole('region', { name: 'Done' })
  const dataTransfer = { setData: vi.fn(), effectAllowed: '', dropEffect: '' }
  fireEvent.dragStart(card, { dataTransfer })
  fireEvent.dragOver(target, { dataTransfer })
  fireEvent.drop(target, { dataTransfer })
  expect(await screen.findByRole('alert')).toHaveTextContent('Someone else has changed this data.')
  expect(mutation).toEqual({ status: 'done', version: 1 })
  expect(within(source).getByRole('link', { name: item.title })).toBeVisible()
  expect(within(target).queryByRole('link', { name: item.title })).toBeNull()
  expect(screen.getByRole('button', { name: 'Refresh board' })).toBeVisible()
})

test('a Kanban drop saves the status and the board explains hidden closed columns', async () => {
  let current = item
  vi.stubGlobal('fetch', vi.fn(async (input: string, options: RequestInit) => {
    if (input.startsWith('/api/actions/board?')) return reply({
      columns: actionStatuses.map(status => ({ ...page(status === current.status ? [current] : []), status })),
    })
    if (options.method === 'PATCH') {
      current = { ...current, status: 'approved', version: 2 }; return reply(current)
    }
    throw new Error(`Unexpected request: ${input}`)
  }))
  renderView(<ActionsBoard filters="scope=open" basePath="/actions" search="?view=board" />)
  const board = screen.getByRole('region', { name: 'Actions board' })
  expect(within(board).getByText('Drag cards between columns or use the status selector on each card. On mobile or with a keyboard, use the selector.')).toBeVisible()
  const link = await screen.findByRole('link', { name: item.title })
  expect(screen.getByRole('region', { name: 'Board columns; scroll horizontally to see every status' })).toBeVisible()
  const detected = screen.getByRole('region', { name: 'Detected' })
  expect(within(detected).getByLabelText('1 action')).toHaveTextContent('1')
  expect(within(detected).getByRole('list', { name: 'Cards: Detected' })).toBeVisible()
  const approved = screen.getByRole('region', { name: 'Approved' })
  expect(within(approved).getByLabelText('0 actions')).toHaveTextContent('0')
  expect(within(approved).getByText('No actions on this page.')).toBeVisible()
  for (const status of ['done', 'discarded'] as const) {
    const column = screen.getByRole('region', { name: statusNames[status] })
    expect(within(column).getByText('Closed actions are hidden. You can drag a card here to close an action.')).toBeVisible()
    expect(within(column).queryByText('No actions on this page.')).toBeNull()
  }
  const card = link.closest('li')
  if (!card) throw new Error('Missing card')
  expect(within(card).getByTitle('Drag card')).toHaveAttribute('aria-hidden', 'true')
  const dataTransfer = { setData: vi.fn(), effectAllowed: '', dropEffect: '' }
  fireEvent.dragStart(card, { dataTransfer })
  fireEvent.dragOver(approved, { dataTransfer })
  fireEvent.drop(approved, { dataTransfer })
  expect(await screen.findByText('Status saved: Approved. The card is shown only if it matches the filters.')).toHaveAttribute('role', 'status')
  expect(await within(approved).findByRole('link', { name: item.title })).toBeVisible()
})

test('the actions list and board render in Spanish', async () => {
  setLanguage('es')
  const listed = { ...item, comment_count: 1, attachment_count: 2 }
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    if (input.startsWith('/api/actions/labels?')) return reply(page(item.labels))
    if (input.startsWith('/api/actions/items?')) return reply(page([listed, { ...listed, id: 2, title: 'Roof leak' }]))
    if (input.startsWith('/api/actions/board?')) return reply({
      columns: actionStatuses.map(status => ({ ...page(status === 'detected' ? [listed] : []), status })),
    })
    throw new Error(`Unexpected request: ${input}`)
  }))
  renderView(<ActionsPage />)
  expect(await screen.findByRole('heading', { name: 'Actuaciones' })).toBeVisible()
  expect(screen.getByText('TU COMUNIDAD')).toBeVisible()
  expect(await screen.findByText('2 actuaciones con estos filtros')).toBeVisible()
  const table = screen.getByRole('table', { name: 'Actuaciones de la comunidad' })
  expect(within(table).getByRole('columnheader', { name: 'Estado' })).toBeVisible()
  expect(within(table).getByRole('button', { name: 'Ordenar por actividad' })).toBeVisible()
  expect(within(table).getByRole('columnheader', { name: 'Comentarios y adjuntos' })).toBeVisible()
  const row = within(table).getByRole('link', { name: `#1 · ${item.title}` }).closest('tr')
  if (!row) throw new Error('Missing action row')
  expect(within(row).getByText('Creada por', { exact: false })).toHaveTextContent('Creada por Alice')
  expect(row).toHaveTextContent('1 comentario2 adjuntos')
  const status = within(row).getByRole('combobox', { name: `Estado de ${item.title}` })
  expect(status).toHaveDisplayValue('Detectado')
  expect(within(status).getByRole('option', { name: 'Pidiendo presupuestos' })).toBeInTheDocument()
  expect(screen.getByRole('searchbox', { name: 'Buscar actuaciones' })).toBeVisible()
  expect(screen.getByRole('combobox', { name: 'Mostrar' })).toHaveDisplayValue('Pendientes')
  expect(screen.getByRole('combobox', { name: 'Filtrar por estado' })).toHaveDisplayValue('Todos los estados')
  expect(screen.getByText('Filtrar por etiquetas')).toBeVisible()
  expect(screen.getByRole('button', { name: 'Limpiar filtros' })).toBeVisible()
  fireEvent.click(screen.getByRole('button', { name: 'Kanban' }))
  const board = await screen.findByRole('region', { name: 'Tablero de actuaciones' })
  expect(await within(board).findByRole('region', { name: 'Pidiendo presupuestos' })).toBeVisible()
  const detected = within(board).getByRole('region', { name: 'Detectado' })
  expect(await within(detected).findByText('1 comentario · 2 adjuntos')).toBeVisible()
  expect(within(detected).getByRole('list', { name: 'Tarjetas: Detectado' })).toBeVisible()
  expect(screen.getByRole('button', { name: 'Lista' })).toHaveAttribute('aria-pressed', 'false')
})

test('the action detail renders in Spanish with Spanish number formats', async () => {
  setLanguage('es')
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    if (input === '/api/actions/items/1') return reply(item)
    if (input.startsWith('/api/actions/items/1/attachments?')) return reply(page([attachment]))
    if (input.startsWith('/api/actions/items/1/comments?')) return reply(page([]))
    throw new Error(`Unexpected request: ${input}`)
  }))
  renderView(<Routes><Route path="/actions/:itemId" element={<ActionDetailPage />} /></Routes>, '/actions/1')
  expect(await screen.findByRole('heading', { name: 'Adjuntos' })).toBeVisible()
  expect(screen.getByRole('link', { name: 'Volver a actuaciones' })).toBeVisible()
  expect(screen.getByText('Creada por', { exact: false })).toHaveTextContent('Creada por Alice · ')
  expect(screen.getByRole('heading', { name: 'Comentarios' })).toBeVisible()
  expect(screen.getByLabelText('Nuevo comentario')).toBeVisible()
  expect(screen.getByRole('button', { name: 'Publicar comentario' })).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Subir PDF' })).toBeEnabled()
  expect(screen.getByText('Puedes seleccionar varios documentos.')).toBeVisible()
  expect(await screen.findByRole('button', { name: 'Descargar quote.pdf' })).toHaveAttribute('title', 'Descargar PDF')
  expect(screen.getByText(/^1 de 20 PDFs activos\./)).toBeVisible()
  expect(screen.getByText('1,46 KiB ·', { exact: false })).toHaveTextContent('1,46 KiB · Alice')
  expect(screen.getByRole('button', { name: 'Retirar quote.pdf' })).toHaveAttribute('title', 'Retirar PDF')
})

test('switching the language re-renders the actions page', async () => {
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    if (input.startsWith('/api/actions/labels?')) return reply(page([]))
    if (input.startsWith('/api/actions/items?')) return reply(page([item]))
    throw new Error(`Unexpected request: ${input}`)
  }))
  renderView(<ActionsPage />)
  expect(await screen.findByText('1 action matches these filters')).toBeVisible()
  expect(screen.getByRole('heading', { name: 'Actions' })).toBeVisible()
  expect(screen.getByRole('combobox', { name: `Status of ${item.title}` })).toHaveDisplayValue('Detected')
  expect(screen.getByText('0 comments', { exact: false })).toHaveTextContent('0 comments0 attachments')
  act(() => setLanguage('es'))
  expect(screen.getByRole('heading', { name: 'Actuaciones' })).toBeVisible()
  expect(screen.getByRole('combobox', { name: `Estado de ${item.title}` })).toHaveDisplayValue('Detectado')
  expect(screen.getByRole('button', { name: 'Ordenar por estado' })).toBeVisible()
  expect(screen.getByText('0 comentarios', { exact: false })).toHaveTextContent('0 comentarios0 adjuntos')
  act(() => setLanguage('en'))
  expect(screen.getByRole('heading', { name: 'Actions' })).toBeVisible()
  expect(screen.getByRole('button', { name: 'Sort by status' })).toBeVisible()
})

test('the actions list names administrator authors in the active language and keeps resident names', async () => {
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    if (input.startsWith('/api/actions/labels?')) return reply(page([]))
    if (input.startsWith('/api/actions/items?')) return reply(page([{ ...item, author: administrator }, { ...item, id: 2, title: 'Roof leak' }]))
    throw new Error(`Unexpected request: ${input}`)
  }))
  renderView(<ActionsPage />)
  const table = await screen.findByRole('table', { name: 'Community actions' })
  const row = (name: string) => within(table).getByRole('link', { name }).closest('tr')
  await within(table).findByRole('link', { name: `#1 · ${item.title}` })
  expect(row(`#1 · ${item.title}`)).toHaveTextContent('Created by Technical administrator')
  expect(row('#2 · Roof leak')).toHaveTextContent('Created by Alice')
  act(() => setLanguage('es'))
  expect(row(`#1 · ${item.title}`)).toHaveTextContent(`Creada por ${translate('es', 'common.technicalAdministrator')}`)
  expect(row('#2 · Roof leak')).toHaveTextContent('Creada por Alice')
  expect(table).not.toHaveTextContent('ops-admin')
  expect(table).not.toHaveTextContent(/· administra/)
})

test('administrator authors of an action, its comments, PDFs and history follow the reader language', async () => {
  const added: ActionEventOut = {
    id: 2, kind: 'comment_added', author: administrator, created_at: stamp,
    changes: [{ field: 'comment', before: null, after: 'My comment' }], comment_id: comment.id, attachment_id: null,
  }
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    if (input === '/api/actions/items/1') return reply({ ...item, author: administrator })
    if (input.startsWith('/api/actions/items/1/attachments?')) return reply(page([{ ...attachment, author: administrator }]))
    if (input.startsWith('/api/actions/items/1/comments?')) return reply(page([
      { ...comment, author: administrator }, { ...comment, id: 2, body: 'Resident reply', author: { ...actor, user_id: 8, name: 'Ben' } },
    ]))
    if (input === '/api/actions/items/1/history?page=1') return reply(page([added, { ...added, id: 1, kind: 'created', author: actor, changes: [], comment_id: null }]))
    throw new Error(`Unexpected request: ${input}`)
  }))
  renderView(<Routes><Route path="/actions/:itemId" element={<ActionDetailPage />} /></Routes>, '/actions/1')
  const description = (await screen.findByRole('heading', { name: 'Description' })).closest('section')
  const entry = (text: string) => screen.getByText(text).closest('li')
  expect(description).toHaveTextContent('Created by Technical administrator · ')
  expect((await screen.findByText('My comment')).closest('li')).toHaveTextContent('Technical administrator')
  expect(entry('Resident reply')).toHaveTextContent('Ben')
  expect(await screen.findByText('1.46 KiB ·', { exact: false })).toHaveTextContent('1.46 KiB · Technical administrator')
  fireEvent.click(screen.getByRole('button', { name: 'History' }))
  const history = await screen.findByRole('dialog', { name: 'Change history' })
  expect((await within(history).findByText('Added a comment')).closest('li')).toHaveTextContent('Technical administrator')
  expect(within(history).getByText('Created the action').closest('li')).toHaveTextContent('Alice')
  expect(document.body).not.toHaveTextContent('ops-admin')
  expect(document.body).not.toHaveTextContent(/· administration/)

  act(() => setLanguage('es'))
  const spanish = translate('es', 'common.technicalAdministrator')
  expect(description).toHaveTextContent(`Creada por ${spanish} · `)
  expect(entry('My comment')).toHaveTextContent(spanish)
  expect(entry('Resident reply')).toHaveTextContent('Ben')
  expect(screen.getByText('1,46 KiB ·', { exact: false })).toHaveTextContent(`1,46 KiB · ${spanish}`)
  expect(within(history).getByText(translate('es', 'actions.history.events.comment_added')).closest('li')).toHaveTextContent(spanish)
  expect(within(history).getByText(translate('es', 'actions.history.events.created')).closest('li')).toHaveTextContent('Alice')
  expect(document.body).not.toHaveTextContent('ops-admin')
  expect(document.body).not.toHaveTextContent(/· administraci/)
})
