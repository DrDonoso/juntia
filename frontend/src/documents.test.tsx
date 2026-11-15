import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest'
import { ApiError, api, cache } from './api/client'
import type {
  ActorOut, DocumentBrowseOut, DocumentDeletionOut, DocumentEventOut, DocumentFolderOut, DocumentInfoOut, DocumentLimitsOut,
  DocumentOut, DocumentTreeFolderOut, DocumentUploadIn, DocumentVersionOut, FeatureFlagsOut, UserAuthOut,
} from './api/schema.gen'
import { uploads } from './document-upload'
import { DocumentsPage, eventText, folderOptions } from './documents'
import { DeletedDocumentsPage } from './documents-admin'
import { I18nRoot, t } from './i18n'

vi.mock('./api/client', async original => {
  const actual = await original<typeof import('./api/client')>()
  return { ...actual, api: vi.fn() }
})

const KiB = 1024, MiB = 1024 * KiB
const ana: ActorOut = { kind: 'resident', name: 'Ana López', user_id: 2 }
const bob: ActorOut = { kind: 'resident', name: 'Bob Smith', user_id: 3 }
const time = '2026-02-01T10:00:00Z'
const session: UserAuthOut = {
  authenticated: true, kind: 'resident', name: 'Ana López', email: 'ana@example.org', user_id: 2, dwelling_id: 1,
  expires_at: '2026-12-31T00:00:00Z',
}
const limits: DocumentLimitsOut = {
  extensions: ['csv', 'docx', 'jpg', 'mov', 'mp4', 'pdf', 'txt'], video_extensions: ['mp4', 'mov'],
  max_file_bytes: 50 * MiB, max_video_bytes: 1024 * MiB, chunk_bytes: 4 * MiB, max_folder_items: 1000, max_depth: 10,
  archive_max_items: 200, archive_max_files: 2000, archive_max_bytes: 4096 * MiB,
}

function version(id: string, number: number, size: number, author = ana, extension = 'pdf'): DocumentVersionOut {
  return { id, number, size, extension, author, media_type: 'application/pdf', sha256: '0'.repeat(64), created_at: time, purged_at: null }
}

function event(id: number, kind: DocumentEventOut['kind'], author: ActorOut, details: Partial<DocumentEventOut> = {}): DocumentEventOut {
  return {
    id, kind, author, created_at: time, folder: null, location: null, previous_location: null, name: null,
    previous_name: null, number: null, size: null, ...details,
  }
}

const folder: DocumentFolderOut = {
  id: 4, parent_id: null, name: 'Minutes', version: 1, author: bob, created_at: time, updated_at: time,
  file_count: 3, folder_count: 1, size: 3 * MiB, can_manage: true, can_delete: false,
}
const pdf: DocumentOut = {
  id: 7, folder_id: null, name: 'Acta.pdf', kind: 'pdf', previewable: true, version: 2, version_count: 2, author: ana,
  created_at: time, updated_at: '2026-02-03T10:00:00Z', current: version('v7-2', 2, 2 * MiB, bob), can_manage: true,
}
const docx: DocumentOut = {
  id: 8, folder_id: null, name: 'Budget.docx', kind: 'document', previewable: false, version: 1, version_count: 1,
  author: bob, created_at: time, updated_at: time, current: version('v8-1', 1, 20 * KiB, bob, 'docx'), can_manage: false,
}
const info: DocumentInfoOut = {
  ...pdf, location: [], deleted_at: null, deleted_by: null, purged_at: null,
  versions: [version('v7-2', 2, 2 * MiB, bob), { ...version('v7-1', 1, MiB), purged_at: '2026-02-02T10:00:00Z' }],
}
const tree: DocumentTreeFolderOut[] = [
  { id: 4, name: 'Minutes', parent_id: null }, { id: 6, name: '2026', parent_id: 4 }, { id: 5, name: 'Plans', parent_id: null },
]

let features: FeatureFlagsOut, browse: DocumentBrowseOut, events: DocumentEventOut[], deletions: DocumentDeletionOut[]
// Replies to writes, by "METHOD /path".
let writes: Record<string, (body: unknown) => unknown>
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
  cache.clear()
  cache.setDefaultOptions({ queries: { retry: false }, mutations: { retry: false } })
  features = { coefficient: true, actions: true, events: true, documents: true, google_login: false }
  browse = { folder: null, path: [], folders: [folder], files: [docx, pdf], limits, policy: 'creator' }
  events = []
  deletions = []
  writes = {}
  vi.mocked(api).mockImplementation(async (url, method = 'GET', body) => {
    const write = writes[`${method} ${url}`]
    if (write) return write(body)
    if (method === 'POST' && url === '/documents/uploads') {
      const input = body as DocumentUploadIn
      return {
        id: input.upload_id, name: input.name, size: input.size, received: 0, folder_id: input.folder_id ?? null,
        document_id: input.document_id ?? null, expires_at: time,
      }
    }
    const chunk = /^\/documents\/uploads\/([^/]+)\/content\?offset=(\d+)$/.exec(url)
    if (method === 'PUT' && chunk) return { id: chunk[1], received: Number(chunk[2]) + (body as Blob).size }
    if (method === 'POST' && /^\/documents\/uploads\/[^/]+\/complete$/.test(url)) return { ...pdf, id: 20, name: 'Plan.pdf' }
    if (method !== 'GET') throw new Error(`Unexpected API request: ${method} ${url}`)
    if (url === '/features') return features
    if (url === '/auth/session') return session
    if (url === '/documents/browse') return browse
    if (url === '/documents/browse?folder=4') return { ...browse, folder, path: [{ id: 4, name: 'Minutes' }], folders: [], files: [] }
    if (url === '/documents/folders') return tree
    if (url === '/documents/files/7') return info
    if (/^\/(admin\/)?documents\/(files|folders)\/\d+\/history\?page=1$/.test(url)) {
      return { items: events, page: 1, pages: 1, total: events.length }
    }
    if (url === '/admin/documents/deleted?page=1') return { items: deletions, page: 1, pages: 1, total: deletions.length }
    throw new Error(`Unexpected API request: ${method} ${url}`)
  })
})
afterEach(() => { cleanup(); uploads.reset(); cache.clear(); cache.setDefaultOptions(defaults); vi.restoreAllMocks() })

function page(children: ReactNode = null) {
  render(<I18nRoot><QueryClientProvider client={cache}><MemoryRouter initialEntries={['/documents']}>
    {children ?? <Routes>
      <Route path="/documents" element={<DocumentsPage />} />
      <Route path="/documents/folders/:folderId" element={<DocumentsPage />} />
    </Routes>}
  </MemoryRouter></QueryClientProvider></I18nRoot>)
}

async function grid() {
  return within(await screen.findByRole('list', { name: 'Folders and files in Documents' }))
}

async function choose(user: ReturnType<typeof userEvent.setup>, name: string, option: string) {
  await user.click((await grid()).getByRole('button', { name: `Options for ${name}` }))
  await user.click(within(screen.getByRole('menu', { name: `Options for ${name}` })).getByRole('menuitem', { name: option }))
}

function options(name: string) {
  return within(screen.getByRole('menu', { name: `Options for ${name}` })).getAllByRole('menuitem').map(item => item.textContent)
}

test('folders come first, files show their size and only previewable files have the eye, opening a new tab', async () => {
  const user = userEvent.setup()
  page()
  const list = await grid()
  expect(list.getAllByRole('checkbox').map(box => box.getAttribute('aria-label')))
    .toEqual(['Select Minutes', 'Select Acta.pdf', 'Select Budget.docx'])
  expect(screen.getByRole('heading', { name: '3 items' })).toBeVisible()
  expect(screen.getByText(/Everything here is visible to every neighbor/)).toBeVisible()
  const eye = list.getByRole('link', { name: 'Preview Acta.pdf' })
  expect(eye).toHaveAttribute('href', '/api/documents/versions/v7-2/preview')
  expect(eye).toHaveAttribute('target', '_blank')
  expect(eye).toHaveAttribute('rel', 'noopener noreferrer')
  expect(list.queryByRole('link', { name: 'Preview Budget.docx' })).toBeNull()
  expect(list.getByRole('link', { name: 'Budget.docx' })).toHaveAttribute('href', '/api/documents/versions/v8-1/download')
  expect(list.getByText('Version 2')).toBeVisible()
  expect(list.getByText('3 files · 3 MiB')).toBeVisible()
  await user.click(list.getByRole('link', { name: 'Minutes' }))
  expect(await screen.findByRole('heading', { name: 'Minutes', level: 1 })).toBeVisible()
  expect(await screen.findByText('This folder is empty.')).toBeVisible()
  const path = within(screen.getByRole('navigation', { name: 'Folder path' }))
  expect(path.getByRole('link', { name: 'Documents' })).toHaveAttribute('href', '/documents')
  expect(path.getByText('Minutes')).toHaveAttribute('aria-current', 'page')
})

test('the options menu offers what each person may do, with Delete last and in red', async () => {
  const user = userEvent.setup()
  page()
  await user.click((await grid()).getByRole('button', { name: 'Options for Acta.pdf' }))
  expect(options('Acta.pdf')).toEqual(['Preview', 'Download', 'Select', 'Rename', 'Move to…', 'Upload new version', 'Info', 'Delete'])
  const menu = within(screen.getByRole('menu', { name: 'Options for Acta.pdf' }))
  expect(menu.getByRole('menuitem', { name: 'Preview' })).toHaveFocus()
  expect(menu.getByRole('menuitem', { name: 'Preview' })).toHaveAttribute('target', '_blank')
  expect(menu.getByRole('menuitem', { name: 'Download' })).toHaveAttribute('href', '/api/documents/versions/v7-2/download')
  expect(menu.getByRole('menuitem', { name: 'Delete' })).toHaveClass('danger')
  await user.keyboard('{End}')
  expect(menu.getByRole('menuitem', { name: 'Delete' })).toHaveFocus()
  await user.keyboard('{Escape}')
  expect(screen.queryByRole('menu')).toBeNull()
  expect(screen.getByRole('button', { name: 'Options for Acta.pdf' })).toHaveFocus()
  // Someone else's file, with the default policy: only reading.
  await user.click(screen.getByRole('button', { name: 'Options for Budget.docx' }))
  expect(options('Budget.docx')).toEqual(['Download', 'Select', 'Info'])
  await user.keyboard('{Escape}')
  // A folder holding files of other neighbors can be renamed or moved, but not deleted.
  await user.click(screen.getByRole('button', { name: 'Options for Minutes' }))
  expect(options('Minutes')).toEqual(['Download as ZIP', 'Select', 'Rename', 'Move to…', 'Info'])
  expect(screen.getByRole('menuitem', { name: 'Download as ZIP' })).toHaveAttribute('href', '/api/documents/archive?folder=4')
})

test('several selected items download together as one ZIP within the limits', async () => {
  browse.limits = { ...limits, archive_max_files: 4 }
  const user = userEvent.setup()
  page()
  await user.click((await grid()).getByRole('checkbox', { name: 'Select Minutes' }))
  await user.click(screen.getByRole('checkbox', { name: 'Select Acta.pdf' }))
  const bar = within(screen.getByRole('region', { name: 'Selection' }))
  expect(bar.getByRole('status')).toHaveTextContent('2 selected · 4 files · 5 MiB')
  expect(bar.getByRole('link', { name: 'Download ZIP' })).toHaveAttribute('href', '/api/documents/archive?folder=4&file=7')
  await user.click(screen.getByRole('button', { name: 'Options for Acta.pdf' }))
  expect(options('Acta.pdf')).toContain('Deselect')
  await user.keyboard('{Escape}')
  await choose(user, 'Budget.docx', 'Select')
  expect(screen.getByRole('checkbox', { name: 'Select Budget.docx' })).toBeChecked()
  expect(bar.getByRole('status')).toHaveTextContent(/^3 selected · 5 files · /)
  expect(bar.queryByRole('link', { name: 'Download ZIP' })).toBeNull()
  expect(bar.getByRole('button', { name: 'Download ZIP' })).toBeDisabled()
  expect(bar.getByText('The selection is too large to download at once: at most 4 files and 4 GiB.')).toBeVisible()
  await user.click(bar.getByRole('button', { name: 'Clear selection' }))
  expect(screen.queryByRole('region', { name: 'Selection' })).toBeNull()
  expect(screen.getByRole('checkbox', { name: 'Select Minutes' })).not.toBeChecked()
})

test('renaming keeps the extension and explains a name already in use next to the field', async () => {
  let attempts = 0
  writes['PATCH /documents/files/7'] = () => {
    if (++attempts === 1) throw new ApiError('document_name_taken', 409, { name: 'document_name_taken' })
    return { ...pdf, name: 'Acta 2026.pdf', version: 3 }
  }
  const user = userEvent.setup()
  page()
  await choose(user, 'Acta.pdf', 'Rename')
  const dialog = within(screen.getByRole('dialog', { name: 'Rename “Acta.pdf”' }))
  const field = dialog.getByLabelText('New name')
  expect(field).toHaveValue('Acta')
  expect(dialog.getByText('.pdf')).toBeVisible()
  await user.clear(field)
  await user.type(field, 'Acta 2026')
  await user.click(dialog.getByRole('button', { name: 'Rename' }))
  expect(await dialog.findByText(t('errors.codes.document_name_taken'))).toBeVisible()
  expect(field).toHaveAttribute('aria-invalid', 'true')
  await user.click(dialog.getByRole('button', { name: 'Rename' }))
  expect(await screen.findByText('Renamed to “Acta 2026.pdf”.')).toBeVisible()
  expect(api).toHaveBeenCalledWith('/documents/files/7', 'PATCH', { version: 2, name: 'Acta 2026.pdf' })
  expect(screen.queryByRole('dialog')).toBeNull()
})

test('moving offers every folder except the item itself, the folders inside it and where it already is', async () => {
  const moving = folderOptions(tree, { kind: 'folder', value: folder })
  expect(moving.map(option => [option.id, option.depth, option.disabled, option.current])).toEqual([
    [null, 0, true, true], [4, 1, true, false], [6, 2, true, false], [5, 1, false, false],
  ])
  const nested = folderOptions(tree, { kind: 'file', value: { ...pdf, folder_id: 6 } })
  expect(nested.map(option => [option.id, option.disabled, option.current])).toEqual([
    [null, false, false], [4, false, false], [6, true, true], [5, false, false],
  ])
  writes['PATCH /documents/files/7'] = () => ({ ...pdf, folder_id: 5, version: 3 })
  const user = userEvent.setup()
  page()
  await choose(user, 'Acta.pdf', 'Move to…')
  const dialog = within(screen.getByRole('dialog', { name: 'Move “Acta.pdf”' }))
  expect(await dialog.findByRole('radio', { name: 'Documents (current location)' })).toBeDisabled()
  expect(dialog.getByRole('button', { name: 'Move here' })).toBeDisabled()
  await user.click(dialog.getByRole('radio', { name: 'Plans' }))
  await user.click(dialog.getByRole('button', { name: 'Move here' }))
  expect(await screen.findByText('“Acta.pdf” moved.')).toBeVisible()
  expect(api).toHaveBeenCalledWith('/documents/files/7', 'PATCH', { version: 2, folder_id: 5 })
})

test('deleting asks for confirmation and explains that only the administrator can restore it', async () => {
  writes['DELETE /documents/files/7'] = () => undefined
  const user = userEvent.setup()
  page()
  await choose(user, 'Acta.pdf', 'Delete')
  const dialog = within(screen.getByRole('dialog', { name: 'Delete “Acta.pdf”?' }))
  expect(dialog.getByText('The file will disappear for every neighbor.')).toBeVisible()
  expect(dialog.getByText(/^Only the administrator can see deleted documents/)).toBeVisible()
  await user.click(dialog.getByRole('button', { name: 'Delete' }))
  expect(await screen.findByText('“Acta.pdf” deleted.')).toBeVisible()
  expect(api).toHaveBeenCalledWith('/documents/files/7', 'DELETE', { version: 2 })
})

test('info shows who uploaded the file, its versions and the history of changes', async () => {
  events = [
    event(4, 'moved', bob, { previous_location: ['Minutes'], location: [] }),
    event(3, 'renamed', ana, { previous_name: 'acta.pdf', name: 'Acta.pdf' }),
    event(2, 'version_added', bob, { number: 2, size: 2 * MiB }),
    event(1, 'created', ana, { location: ['Minutes'], size: MiB }),
  ]
  const user = userEvent.setup()
  page()
  await choose(user, 'Acta.pdf', 'Info')
  const dialog = within(screen.getByRole('dialog', { name: 'Info: Acta.pdf' }))
  expect(await dialog.findByText('PDF · .pdf')).toBeVisible()
  expect(dialog.getByText('Uploaded by').nextElementSibling).toHaveTextContent(/^Ana López · /)
  expect(dialog.getByRole('link', { name: 'Download version 2' })).toHaveAttribute('href', '/api/documents/versions/v7-2/download')
  expect(dialog.queryByRole('link', { name: 'Download version 1' })).toBeNull()
  expect(dialog.getByText(/^Deleted permanently:/)).toBeVisible()
  expect(dialog.getByText('You can rename, move, replace and delete this item.')).toBeVisible()
  expect(dialog.getByRole('button', { name: 'Upload new version' })).toBeVisible()
  const history = within(dialog.getByRole('region', { name: 'History' }))
  expect((await history.findAllByRole('listitem')).map(item => item.querySelector('p')?.textContent)).toEqual([
    'Moved it from Documents / Minutes to Documents.',
    'Renamed it from “acta.pdf” to “Acta.pdf”.',
    'Uploaded version 2 (2 MiB).',
    'Uploaded the file (1 MiB) to Documents / Minutes.',
  ])
  expect(history.getAllByText('Bob Smith')).toHaveLength(2)
})

test('history entries explain what happened together with a folder', () => {
  expect(eventText(event(1, 'created', ana, { location: ['Minutes'] }), true, t)).toBe('Created the folder in Documents / Minutes.')
  expect(eventText(event(2, 'deleted', ana, { folder: 'Minutes' }), false, t)).toBe('Deleted it together with the folder “Minutes”.')
  expect(eventText(event(3, 'restored', ana, { location: [], name: 'Acta (2).pdf', previous_name: 'Acta.pdf' }), false, t))
    .toBe('Restored it in Documents as “Acta (2).pdf”, because “Acta.pdf” was already in use.')
  expect(eventText(event(4, 'purged', ana, { folder: 'Minutes' }), false, t)).toBe('Deleted it permanently together with the folder “Minutes”.')
  expect(eventText(event(5, 'version_purged', ana, { number: 1, size: KiB }), false, t)).toBe('Deleted version 1 (1 KiB) permanently.')
})

test('chosen files join the upload queue, and files that would be refused are explained without sending them', async () => {
  const user = userEvent.setup()
  page()
  await grid()
  const video = new File(['x'], 'party.mov')
  Object.defineProperty(video, 'size', { value: 2048 * MiB })
  fireEvent.change(screen.getByLabelText('Files to upload'), { target: { files: [
    new File(['%PDF-1.7 plan'], 'Plan.pdf'), new File(['MZ'], 'setup.exe'), new File([], 'empty.txt'), video,
  ] } })
  const queue = within(screen.getByRole('region', { name: 'Uploads' }))
  expect(await queue.findByText('Uploaded as “Plan.pdf”.')).toBeVisible()
  expect(queue.getByText(/^This type of file is not accepted/)).toBeVisible()
  expect(queue.getByText('The file is empty.')).toBeVisible()
  expect(queue.getByText('The file is larger than 1 GiB, the limit for this type of file.')).toBeVisible()
  expect(queue.getAllByText('To Documents')).toHaveLength(4)
  const started = vi.mocked(api).mock.calls.filter(([url]) => url === '/documents/uploads')
  expect(started).toEqual([['/documents/uploads', 'POST', {
    upload_id: expect.any(String), name: 'Plan.pdf', size: 13, folder_id: null,
  }, expect.any(AbortSignal)]])
  expect(queue.queryByRole('button', { name: 'Retry' })).toBeNull()
  await user.click(queue.getByRole('button', { name: 'Clear finished' }))
  expect(queue.queryByText('Plan.pdf')).toBeNull()
  await user.click(queue.getByRole('button', { name: 'Dismiss setup.exe' }))
  expect(queue.queryByText('setup.exe')).toBeNull()
})

test('with Documents turned off the page explains it instead of loading documents', async () => {
  features = { ...features, documents: false }
  page()
  expect(await screen.findByRole('heading', { name: 'Documents turned off' })).toBeVisible()
  expect(vi.mocked(api).mock.calls.some(([url]) => url.startsWith('/documents'))).toBe(false)
})

test('the administrator restores deleted documents or deletes them permanently', async () => {
  deletions = [
    {
      id: 'd1', name: 'Old minutes', folder_id: 9, document_id: null, file_kind: null, file_count: 2, folder_count: 1,
      stored_bytes: 3 * MiB, location: ['Archive'], author: bob, created_at: time,
    },
    {
      id: 'd2', name: 'Plan.pdf', folder_id: null, document_id: 11, file_kind: 'pdf', file_count: 1, folder_count: 0,
      stored_bytes: MiB, location: [], author: ana, created_at: time,
    },
  ]
  const settle = (id: string) => () => { deletions = deletions.filter(item => item.id !== id) }
  writes['POST /admin/documents/deletions/d1/restore'] = settle('d1')
  writes['POST /admin/documents/deletions/d2/purge'] = settle('d2')
  const user = userEvent.setup()
  page(<DeletedDocumentsPage />)
  const list = within(await screen.findByRole('list', { name: 'Deleted documents' }))
  expect(list.getByText('Folder · 2 files · 1 folders · 3 MiB')).toBeVisible()
  expect(list.getByText('Was in Documents / Archive')).toBeVisible()
  expect(list.getByText(/^Deleted by Bob Smith/)).toBeVisible()
  await user.click(list.getByRole('button', { name: 'Restore Old minutes' }))
  const restore = within(screen.getByRole('dialog', { name: 'Restore “Old minutes”?' }))
  await user.click(restore.getByRole('button', { name: 'Restore' }))
  expect(await screen.findByText('“Old minutes” restored.')).toBeVisible()
  expect(api).toHaveBeenCalledWith('/admin/documents/deletions/d1/restore', 'POST')
  await user.click(await screen.findByRole('button', { name: 'Delete permanently: Plan.pdf' }))
  const purge = within(screen.getByRole('dialog', { name: 'Delete “Plan.pdf” permanently?' }))
  expect(purge.getByText('It frees 1 MiB of the documents quotas.')).toBeVisible()
  await user.click(purge.getByRole('button', { name: 'Delete permanently' }))
  expect(await screen.findByText('“Plan.pdf” has been deleted permanently. 1 MiB freed.')).toBeVisible()
  expect(await screen.findByText('There are no deleted documents waiting to be restored or purged.')).toBeVisible()
})
