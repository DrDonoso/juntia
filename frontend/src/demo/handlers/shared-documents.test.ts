import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import type {
  DocumentBrowseOut, DocumentDeletionPage, DocumentFileMatch, DocumentFolderInfoOut, DocumentFolderOut, DocumentHistoryPage, DocumentInfoOut,
  DocumentOut, DocumentSearchPage, DocumentSettings, DocumentTextFilePage, DocumentTextSummaryOut, DocumentTreeFolderOut, DocumentUploadOut,
  StorageOut,
} from '../../api/schema.gen'
import { MUTATION_HEADER, readZip, readZipMember, setClock, zipArchive } from '../core'
import { resetDemo } from '../store'
import { sha256Hex } from '../store/community-sha256'
import { coreStore } from '../store/core'
import { ARCHIVE_MAX_BYTES, CHUNK_BYTES, DOCUMENT_QUOTA_LIMIT_MB, DOCUMENT_SIZE_LIMIT_MB, sharedDocumentsStore } from '../store/shared-documents'
import { demoFetch, demoRequest, demoUrl } from '../testing'

// Thursday 29 October 2026, midday (local time), like the other demo tests.
const NOW = new Date(2026, 9, 29, 12)
const MIB = 1024 * 1024
const OLIVIA = { kind: 'resident', name: 'Olivia Bennett', user_id: 6 }
const JAMES = { kind: 'resident', name: 'James Okafor', user_id: 1 }
const ADMIN = { kind: 'administrator', name: 'Technical administrator', user_id: null }
// The settings of a new installation, in MiB.
const LIMITS = { max_file_mb: 50, max_video_mb: 1024, user_quota_mb: 2048, community_quota_mb: 20480 }
const SETTINGS = '/api/admin/settings/documents'

beforeEach(() => resetDemo({ now: () => NOW }))
afterEach(() => resetDemo())

const encoder = new TextEncoder()
const get = <T = unknown>(path: string) => demoRequest<T>('GET', path)
const post = <T = unknown>(path: string, body?: unknown) => demoRequest<T>('POST', path, { body })
const patch = <T = unknown>(path: string, body: unknown) => demoRequest<T>('PATCH', path, { body })
const remove = (kind: 'files' | 'folders', item: { id: number; version: number }) =>
  demoRequest('DELETE', `/api/documents/${kind}/${item.id}`, { body: { version: item.version } })
const signIn = (email: string) => post('/api/auth/login', { email, password: 'demo' })
const adminLogin = () => post('/api/admin/auth/login', { username: 'demo', password: 'demo' })
const adminLogout = () => post('/api/admin/auth/logout')

/** The administrator changes some settings, then the visit goes on as the neighbor signed in. */
async function setLimits(values: Record<string, unknown>) {
  await adminLogin()
  const answer = await patch<DocumentSettings>(SETTINGS, values)
  await adminLogout()
  expect(answer.status, JSON.stringify(answer.body)).toBe(200)
  return answer.body
}
// Typed arrays of the test and of the demo may come from different realms: compare their bytes.
const bytesOf = (value: Uint8Array | null) => value && Array.from(value)

/** A PDF the backend accepts, of `size` bytes at least. */
function pdf(text = 'Synthetic minutes', size = 0): Uint8Array<ArrayBuffer> {
  const head = `%PDF-1.7\n% ${text}\n`
  return encoder.encode(head + ' '.repeat(Math.max(0, size - head.length - 7)) + '\n%%EOF\n')
}

const png = () => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0])

function box(kind: string, body: Uint8Array): Uint8Array<ArrayBuffer> {
  const output = new Uint8Array(8 + body.length)
  new DataView(output.buffer).setUint32(0, output.length)
  output.set(encoder.encode(kind), 4)
  output.set(body, 8)
  return output
}

function joined(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const output = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  parts.reduce((offset, part) => (output.set(part, offset), offset + part.length), 0)
  return output
}

const mp4 = () => joined(box('ftyp', encoder.encode('isom\0\0\0\0isomiso2mp41')), box('moov', new Uint8Array(32)), box('mdat', new Uint8Array(64)))

/** A Word document, with extra parts. */
function docx(...extra: (readonly [string, string])[]): Uint8Array<ArrayBuffer> {
  const modified = { year: 2026, month: 10, day: 29, hour: 12, minute: 0, second: 0 }
  const types = '<Types><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'
  return zipArchive([['[Content_Types].xml', types] as const, ['word/document.xml', '<document/>'] as const, ...extra]
    .map(([path, data]) => ({ path, data: encoder.encode(data), modified })))
}

interface Target {
  folder_id?: number | null
  document_id?: number | null
}

/** `POST /api/documents/uploads`. */
async function start(name: string, size: number, target: Target = {}, uploadId: string = crypto.randomUUID()) {
  return { uploadId, ...await post<DocumentUploadOut>('/api/documents/uploads', { upload_id: uploadId, name, size, ...target }) }
}

/** `PUT …/content` with raw bytes, as the app sends chunks. */
async function sendChunk(uploadId: string, offset: number | null, data: Uint8Array<ArrayBuffer>): Promise<{ status: number; body: DocumentUploadOut }> {
  const query = offset === null ? '' : `?offset=${offset}`
  const response = await demoFetch(new Request(demoUrl(`/api/documents/uploads/${uploadId}/content${query}`), {
    method: 'PUT', body: data, headers: { [MUTATION_HEADER]: '1', 'Content-Type': 'application/octet-stream' },
  }))
  return { status: response.status, body: await response.json() as DocumentUploadOut }
}

async function send(uploadId: string, content: Uint8Array<ArrayBuffer>, offset = 0, chunk = CHUNK_BYTES): Promise<void> {
  for (let position = offset; position < content.length; position += chunk) {
    expect((await sendChunk(uploadId, position, content.subarray(position, position + chunk))).status).toBe(200)
  }
}

async function upload(name: string, content: Uint8Array<ArrayBuffer>, target: Target = {}) {
  const { uploadId, status } = await start(name, content.length, target)
  expect(status).toBe(201)
  await send(uploadId, content)
  return post<DocumentOut>(`/api/documents/uploads/${uploadId}/complete`)
}

async function uploaded(name: string, content: Uint8Array<ArrayBuffer>, target: Target = {}): Promise<DocumentOut> {
  const answer = await upload(name, content, target)
  expect(answer.status, JSON.stringify(answer.body)).toBe(200)
  return answer.body
}

async function folder(name: string, parentId: number | null = null): Promise<DocumentFolderOut> {
  const answer = await post<DocumentFolderOut>('/api/documents/folders', { name, parent_id: parentId })
  expect(answer.status, JSON.stringify(answer.body)).toBe(201)
  return answer.body
}

async function browse(folderId?: number): Promise<DocumentBrowseOut> {
  const answer = await get<DocumentBrowseOut>(folderId === undefined ? '/api/documents/browse' : `/api/documents/browse?folder=${folderId}`)
  expect(answer.status).toBe(200)
  return answer.body
}

const history = async (kind: 'files' | 'folders', id: number) => (await get<DocumentHistoryPage>(`/api/documents/${kind}/${id}/history`)).body.items
const deletions = async () => (await get<DocumentDeletionPage>('/api/admin/documents/deleted')).body.items

/** A file download: status, headers and bytes. */
async function download(path: string, headers: Record<string, string> = {}) {
  const response = await demoFetch(new Request(demoUrl(path), { headers }))
  return { status: response.status, headers: response.headers, bytes: new Uint8Array(await response.arrayBuffer()) }
}

const errorCode = (bytes: Uint8Array) => (JSON.parse(new TextDecoder().decode(bytes)) as { code: string }).code

function scenarioFolder(name: string) {
  const found = sharedDocumentsStore().folders.find(item => item.name === name && item.deletedAt === null)
  if (!found) throw new Error(`No folder ${name}`)
  return found
}

describe('the Documents section', () => {
  test('is turned on in the demo; while it is off residents get documents_disabled and the administration keeps working', async () => {
    expect((await get('/api/features')).body).toMatchObject({ documents: true })
    coreStore().features.documents = false
    expect(await get('/api/documents/browse')).toMatchObject({ status: 404, body: { code: 'documents_disabled' } })
    expect(await post('/api/documents/folders', { name: 'Minutes' })).toMatchObject({ status: 404, body: { code: 'documents_disabled' } })
    expect(await sendChunk(crypto.randomUUID(), 0, encoder.encode('x'))).toMatchObject({ status: 404, body: { code: 'documents_disabled' } })
    await adminLogin()
    expect(await get('/api/documents/browse')).toMatchObject({ status: 404, body: { code: 'documents_disabled' } })
    expect((await get<DocumentDeletionPage>('/api/admin/documents/deleted')).body).toMatchObject({ total: 2, page: 1, pages: 1 })
    expect(await get(SETTINGS)).toMatchObject({ status: 200, body: { manage_policy: 'creator', ...LIMITS } })
    expect(await patch('/api/admin/settings/features/documents', { enabled: true })).toMatchObject({ status: 200, body: { documents: true } })
    expect((await get('/api/documents/browse')).status).toBe(200)
    await post('/api/auth/logout')
    expect(await get('/api/documents/browse')).toMatchObject({ status: 401, body: { code: 'authentication_required' } })
    expect(await post('/api/documents/folders', { name: 'Minutes' })).toMatchObject({ status: 401, body: { code: 'authentication_required' } })
  })

  test("the visitor browses the scenario with the backend's limits and manages only what they created", async () => {
    const root = await browse()
    expect(root).toMatchObject({ folder: null, path: [], policy: 'creator' })
    expect(root.folders.map(item => [item.name, item.can_manage, item.can_delete])).toEqual([
      ['Community rules', false, false], ['Garden', true, true], ['Insurance', false, false], ['Meeting minutes', false, false],
    ])
    expect(root.files.map(item => item.name)).toEqual(['Bike storage survey.csv', 'Lift maintenance contract.pdf', 'Welcome to Documents.txt'])
    expect(root.limits).toEqual({
      extensions: ['csv', 'docx', 'gif', 'heic', 'heif', 'jpeg', 'jpg', 'm4v', 'mov', 'mp4', 'odp', 'ods', 'odt', 'pdf', 'png', 'pptx', 'txt', 'webp', 'xlsx'],
      video_extensions: ['mp4', 'm4v', 'mov'], max_file_bytes: 50 * MIB, max_video_bytes: 1024 * MIB, chunk_bytes: 4 * MIB,
      max_folder_items: 1000, max_depth: 10, archive_max_items: 100, archive_max_files: 5000, archive_max_bytes: 10 * 1024 * MIB,
    })
    const minutes = root.folders.find(item => item.name === 'Meeting minutes')!
    expect(minutes).toMatchObject({ file_count: 2, folder_count: 2, author: JAMES })
    const years = await browse(minutes.id)
    expect(years.path).toEqual([{ id: minutes.id, name: 'Meeting minutes' }])
    expect(years.folders.map(item => item.name)).toEqual(['2025', '2026'])
    const latest = await browse(years.folders[1].id)
    expect(latest.path.map(item => item.name)).toEqual(['Meeting minutes', '2026'])
    expect(latest.files.map(item => [item.name, item.kind, item.previewable])).toEqual([['Minutes - ordinary meeting.pdf', 'pdf', true]])
    expect((await get<DocumentFolderInfoOut>(`/api/documents/folders/${years.folders[1].id}`)).body).toMatchObject({
      name: '2026', location: [{ id: minutes.id, name: 'Meeting minutes' }], deleted_at: null, deleted_by: null, purged_at: null,
    })
    // The roof claim photos were deleted: only the administrator sees them.
    const deleted = sharedDocumentsStore().folders.find(item => item.deletedAt !== null)!
    expect(await get(`/api/documents/browse?folder=${deleted.id}`)).toMatchObject({ status: 404, body: { code: 'document_folder_not_found' } })
    expect(await get(`/api/documents/folders/${deleted.id}`)).toMatchObject({ status: 404, body: { code: 'document_folder_not_found' } })
    for (const query of ['?folder=0', '?folder=x', '?folder=']) {
      expect(await get(`/api/documents/browse${query}`), query).toMatchObject({ status: 422, body: { code: 'invalid_request' } })
    }
  })
})

describe('the search', () => {
  const search = async (query: string) => (await get<DocumentSearchPage>(`/api/documents/search?${query}`)).body

  test('finds folders and files anywhere by name, ignoring case and accents, and says where they are', async () => {
    const found = await search(`q=${encodeURIComponent(' MÍNUTES ')}`)
    expect(found).toMatchObject({ total: 3, page: 1, pages: 1 })
    expect(found.folders.map(item => [item.name, item.location])).toEqual([['Meeting minutes', []]])
    expect(found.files.map(item => [item.name, item.location.map(folder => folder.name)])).toEqual([
      ['Minutes - annual general meeting.pdf', ['Meeting minutes', '2025']],
      ['Minutes - ordinary meeting.pdf', ['Meeting minutes', '2026']],
    ])
    // Each match is described as in its folder, with what the visitor may do.
    const minutes = scenarioFolder('Meeting minutes')
    const year = (await browse(minutes.id)).folders[1]
    const { location, excerpt, ...ordinary } = found.files[1]
    expect(ordinary).toEqual((await browse(year.id)).files[0])
    expect(location).toEqual([{ id: minutes.id, name: 'Meeting minutes' }, { id: year.id, name: '2026' }])
    expect(excerpt).toBeNull()
    // Deleted items stay hidden; the largest or the latest changed come first when asked, among the
    // files found by name and among those found by their text, which come after them.
    const deleted = sharedDocumentsStore().folders.find(item => item.deletedAt !== null)!
    expect((await search(`q=${encodeURIComponent(deleted.name)}`)).folders.map(item => item.id)).not.toContain(deleted.id)
    for (const [sort, value] of [['size', (item: DocumentFileMatch) => -item.current.size], ['modified', (item: DocumentFileMatch) => -Date.parse(item.updated_at)]] as const) {
      const files = (await search(`q=e&sort=${sort}`)).files
      const groups = [files.filter(item => item.excerpt === null), files.filter(item => item.excerpt !== null)]
      expect(groups[0].length).toBeGreaterThan(1)
      expect(groups[1].map(item => item.name)).toEqual(['Claims log.csv'])
      expect(files).toEqual([...groups[0], ...groups[1]])
      for (const group of groups) expect(group.map(value)).toEqual(group.map(value).sort((a, b) => a - b))
    }
    expect(await search('q=%20%20')).toEqual({ total: 0, page: 1, pages: 1, folders: [], files: [], pending: 0 })
    for (const query of ['', '?q=', `?q=${'x'.repeat(201)}`, '?q=a&sort=type', '?q=a&page=0']) {
      expect(await get(`/api/documents/search${query}`), query).toMatchObject({ status: 422, body: { code: 'invalid_request' } })
    }
    coreStore().features.documents = false
    expect(await get('/api/documents/search?q=a')).toMatchObject({ status: 404, body: { code: 'documents_disabled' } })
  })

  test('finds files by the words inside them, after those found by name, with the words around the match', async () => {
    const found = await search(`q=${encodeURIComponent('QUIET hours')}`)
    expect(found.files.map(item => item.name)).toEqual(['House rules.pdf', 'Minutes - ordinary meeting.pdf'])
    expect(found.files[0].excerpt?.match).toBe('Quiet hours')
    expect(found.files[0].excerpt?.before).toMatch(/^….+ 1\. $/)
    expect(found.files[0].excerpt?.after).toMatch(/^: from 22:00 to 08:00 every day\. 2\. Rubbish: .+[a-z]…$/)
    expect(found.pending).toBe(0)
    // Word documents, CSV files and the current versions only; deleted files stay hidden.
    expect((await search('q=mailbox')).files.map(item => item.name)).toEqual(['Welcome letter for new residents.docx'])
    expect((await search('q=downpipe')).files.map(item => item.name)).toEqual(['Claims log.csv'])
    expect((await search(`q=${encodeURIComponent('on weekdays')}`)).total).toBe(0)
    expect((await search(`q=${encodeURIComponent('to be discussed')}`)).total).toBe(0)
    // New files are read for the search at once.
    const notice = await uploaded('Notice.txt', encoder.encode('The lift is out of service on Friday.\n'))
    expect((await search(`q=${encodeURIComponent('out of service')}`)).files.map(item => item.id)).toEqual([notice.id])
    const info = (id: number) => get<DocumentInfoOut>(`/api/documents/files/${id}`).then(answer => answer.body.text)
    expect(await info(notice.id)).toEqual({ status: 'ready', ocr_pages: 0, partial: false })
    expect(await info((await uploaded('Hall.png', png())).id)).toEqual({ status: 'empty', ocr_pages: 0, partial: false })
    expect(await info((await uploaded('Visit.mp4', mp4())).id)).toEqual({ status: 'unsupported', ocr_pages: 0, partial: false })
  })
})

describe('reading the documents', () => {
  const summary = async () => (await get<DocumentTextSummaryOut>('/api/admin/documents/text')).body
  const files = async (query = '') => (await get<DocumentTextFilePage>(`/api/admin/documents/text/files${query}`)).body

  test('the administrator follows how the text of every file is read, without OCR in the demo', async () => {
    expect(await get('/api/admin/documents/text')).toMatchObject({ status: 401, body: { code: 'authentication_required' } })
    await adminLogin()
    expect(await summary()).toEqual({
      engine: { available: false, version: null, language: 'en' },
      counts: { files: 10, readable: 10, pending: 0, text: 10, empty: 0, failed: 0, partial: 0, ocr: 0, needs_ocr: 0 },
      reading: null,
    })
    const all = await files()
    expect(all).toMatchObject({ total: 10, page: 1, pages: 1 })
    expect(all.items.find(item => item.name === 'Watering rota.csv')).toMatchObject({
      kind: 'text', location: [{ name: 'Garden' }], status: 'ready', reading: false, error: null, ocr_pages: 0, partial: false,
      needs_ocr: false, read_at: NOW.toISOString(),
    })
    // A file that cannot be read says why; reading it again, alone or with every failed one.
    const broken = await uploaded('Broken.pdf', pdf())
    expect((await summary()).counts).toMatchObject({ files: 11, failed: 1 })
    expect((await files('?status=failed')).items.map(item => [item.document_id, item.error])).toEqual([[broken.id, 'damaged']])
    expect(await post(`/api/admin/documents/text/files/${broken.id}/read`)).toMatchObject({ status: 200, body: { status: 'pending' } })
    expect(await post('/api/admin/documents/text/retry')).toMatchObject({ status: 200, body: { queued: 0 } })
    expect((await summary()).counts).toMatchObject({ pending: 0, failed: 1 })
    expect(await post('/api/admin/documents/text/retry')).toMatchObject({ status: 200, body: { queued: 1 } })
    const video = await uploaded('Visit.mp4', mp4())
    expect(await post(`/api/admin/documents/text/files/${video.id}/read`))
      .toMatchObject({ status: 409, body: { code: 'document_text_unsupported' } })
    expect(await remove('files', broken)).toMatchObject({ status: 204 })
    expect(await post(`/api/admin/documents/text/files/${broken.id}/read`)).toMatchObject({ status: 404, body: { code: 'document_not_found' } })
    expect(await get('/api/admin/documents/text/files?status=x')).toMatchObject({ status: 422, body: { code: 'invalid_request' } })
    // It keeps working while Documents is turned off.
    coreStore().features.documents = false
    expect((await summary()).counts.files).toBe(11)
  })
})

describe('chunked uploads', () => {
  test('arrive in chunks, resume where they stopped and complete once', async () => {
    const content = pdf('Synthetic minutes', 2500)
    const { uploadId, ...started } = await start('Minutes 2026.pdf', content.length)
    expect(started).toMatchObject({
      status: 201, body: {
        id: uploadId, name: 'Minutes 2026.pdf', size: 2500, received: 0, folder_id: null, document_id: null,
        expires_at: new Date(NOW.getTime() + 24 * 3_600_000).toISOString(),
      },
    })
    // Starting again with the same id finds the same upload; other details are a conflict.
    expect((await start('Minutes 2026.pdf', content.length, {}, uploadId)).body).toEqual(started.body)
    expect(await start('Minutes 2026.pdf', content.length + 1, {}, uploadId)).toMatchObject({ status: 409, body: { code: 'document_upload_conflict' } })
    await send(uploadId, content.subarray(0, 1000))
    expect(await sendChunk(uploadId, 0, encoder.encode('%'))).toMatchObject({ status: 409, body: { code: 'document_upload_offset' } })
    expect(await post(`/api/documents/uploads/${uploadId}/complete`)).toMatchObject({ status: 409, body: { code: 'document_upload_incomplete' } })
    expect((await get<DocumentUploadOut>(`/api/documents/uploads/${uploadId}`)).body).toMatchObject({ received: 1000, size: 2500 })
    expect(await sendChunk(uploadId, 1000, new Uint8Array(1501))).toMatchObject({ status: 422, body: { code: 'document_upload_size' } })
    expect(await sendChunk(uploadId, 1000, new Uint8Array())).toMatchObject({ status: 422, body: { code: 'document_upload_size' } })
    expect(await sendChunk(uploadId, 1000, new Uint8Array(CHUNK_BYTES + 1))).toMatchObject({ status: 413, body: { code: 'request_too_large' } })
    expect(await sendChunk(uploadId, null, encoder.encode(' '))).toMatchObject({ status: 422, body: { code: 'invalid_request' } })
    await send(uploadId, content, 1000, 1000)
    const completed = await post<DocumentOut>(`/api/documents/uploads/${uploadId}/complete`)
    expect(completed).toMatchObject({
      status: 200, body: {
        name: 'Minutes 2026.pdf', folder_id: null, kind: 'pdf', previewable: true, version: 1, version_count: 1, author: OLIVIA,
        can_manage: true, created_at: NOW.toISOString(),
        current: { id: uploadId, number: 1, extension: 'pdf', media_type: 'application/pdf', size: 2500, sha256: sha256Hex(content), purged_at: null },
      },
    })
    // A completion repeated after a lost answer gets the same document.
    expect((await post(`/api/documents/uploads/${uploadId}/complete`)).body).toEqual(completed.body)
    expect(await get(`/api/documents/uploads/${uploadId}`)).toMatchObject({ status: 404, body: { code: 'document_upload_not_found' } })
    const file = await download(`/api/documents/versions/${uploadId}/download`)
    expect(bytesOf(file.bytes)).toEqual(bytesOf(content))
    expect(file.headers.get('Content-Type')).toBe('application/pdf')
    expect(file.headers.get('Content-Disposition')).toBe("attachment; filename*=utf-8''Minutes%202026.pdf")
    expect((await download(`/api/documents/versions/${uploadId}/preview`)).headers.get('Content-Disposition')).toMatch(/^inline;/)
    // Videos must be seekable: ranges are served.
    const part = await download(`/api/documents/versions/${uploadId}/preview`, { Range: 'bytes=0-7' })
    expect([part.status, part.headers.get('Content-Range'), bytesOf(part.bytes)]).toEqual([206, 'bytes 0-7/2500', bytesOf(content.subarray(0, 8))])
    expect((await download(`/api/documents/versions/${uploadId}/preview`, { Range: 'bytes=9999-' })).status).toBe(416)
    expect((await browse()).files).toContainEqual(completed.body)
    expect(await history('files', completed.body.id)).toEqual([{
      id: expect.any(Number), kind: 'created', author: OLIVIA, created_at: NOW.toISOString(), name: 'Minutes 2026.pdf', previous_name: null,
      location: [], previous_location: null, number: 1, size: 2500, folder: null,
    }])
  })

  test('are cancelled, discarded when their content does not match their type, and kept to four per person', async () => {
    const { uploadId } = await start('Notes.txt', 16)
    expect((await demoRequest('DELETE', `/api/documents/uploads/${uploadId}`)).status).toBe(204)
    expect((await demoRequest('DELETE', `/api/documents/uploads/${uploadId}`)).status).toBe(204)
    expect(await get(`/api/documents/uploads/${uploadId}`)).toMatchObject({ status: 404, body: { code: 'document_upload_not_found' } })
    for (const [name, content, code] of [
      ['Invoice.pdf', png(), 'document_type_mismatch'], ['Photo.png', pdf(), 'document_type_mismatch'],
      ['Notes.txt', encoder.encode('a,b\n\0\x01'), 'document_type_mismatch'], ['Clip.mp4', mp4().subarray(0, 50), 'document_type_mismatch'],
      ['Letter.docx', docx(['word/vbaProject.bin', 'vba']), 'document_macros_unsupported'],
      ['Letter.docx', docx(['word/embeddings/oleObject1.bin', 'ole']), 'document_macros_unsupported'],
    ] as const) {
      const refused = await start(name, content.length)
      await send(refused.uploadId, content)
      expect(await post(`/api/documents/uploads/${refused.uploadId}/complete`), name).toMatchObject({ status: 415, body: { code } })
      expect(await get(`/api/documents/uploads/${refused.uploadId}`)).toMatchObject({ status: 404 })
    }
    for (const [name, content] of [['Clip.mp4', mp4()], ['Letter.docx', docx()], ['Notes.txt', encoder.encode('Synthetic notes\n')]] as const) {
      expect((await uploaded(name, content)).name).toBe(name)
    }
    // A fifth upload discards the least recently active one.
    const ids: string[] = []
    for (let index = 0; index < 5; index += 1) ids.push((await start(`Video ${index}.mp4`, 1000)).uploadId)
    expect((await get(`/api/documents/uploads/${ids[0]}`)).status).toBe(404)
    for (const id of ids.slice(1)) expect((await get(`/api/documents/uploads/${id}`)).status).toBe(200)
    // Uploads expire a day after their last chunk.
    setClock(() => new Date(NOW.getTime() + 24 * 3_600_000))
    expect(await get(`/api/documents/uploads/${ids[1]}`)).toMatchObject({ status: 404, body: { code: 'document_upload_not_found' } })
    expect(await sendChunk(ids[1], 0, encoder.encode('x'))).toMatchObject({ status: 404, body: { code: 'document_upload_not_found' } })
    setClock(() => NOW)
    // Someone else's upload is not found.
    await signIn('james.okafor@example.com')
    expect(await get(`/api/documents/uploads/${ids[2]}`)).toMatchObject({ status: 404 })
    expect(await demoRequest('DELETE', `/api/documents/uploads/${ids[2]}`)).toMatchObject({ status: 404, body: { code: 'document_upload_not_found' } })
    expect(await post(`/api/documents/uploads/${ids[2]}/complete`)).toMatchObject({ status: 404, body: { code: 'document_upload_not_found' } })
    expect(await start('Video 2.mp4', 1000, {}, ids[2])).toMatchObject({ status: 409, body: { code: 'document_upload_conflict' } })
  })

  test('into a folder deleted meanwhile, or as a version of a deleted document, are refused and discarded', async () => {
    const target = await folder('Temporary')
    const content = pdf()
    const late = await start('Plan.pdf', content.length, { folder_id: target.id })
    await send(late.uploadId, content)
    expect((await remove('folders', target)).status).toBe(204)
    expect(await post(`/api/documents/uploads/${late.uploadId}/complete`)).toMatchObject({ status: 409, body: { code: 'document_folder_deleted' } })
    expect((await get(`/api/documents/uploads/${late.uploadId}`)).status).toBe(404)
    const original = await uploaded('Plan.pdf', content)
    const version = await start('Plan.pdf', content.length, { document_id: original.id })
    await send(version.uploadId, content)
    expect((await remove('files', original)).status).toBe(204)
    expect(await post(`/api/documents/uploads/${version.uploadId}/complete`)).toMatchObject({ status: 409, body: { code: 'document_deleted' } })
    expect(await start('Plan.pdf', content.length, { folder_id: target.id })).toMatchObject({ status: 404, body: { code: 'document_folder_not_found' } })
    expect(await start('Plan.pdf', content.length, { document_id: original.id })).toMatchObject({ status: 404, body: { code: 'document_not_found' } })
  })

  test('check the type, the size and the request', async () => {
    expect(await start('program.exe', 2)).toMatchObject({ status: 415, body: { code: 'document_type_unsupported' } })
    expect(await start('notes.pdf.exe', 2)).toMatchObject({ status: 415, body: { code: 'document_type_unsupported' } })
    expect(await start('empty.txt', 0)).toMatchObject({ status: 422, body: { code: 'document_file_empty' } })
    // The default limits: 50 MiB per file and 1 GiB per video.
    expect(await start('large.pdf', 50 * MIB + 1)).toMatchObject({ status: 413, body: { code: 'document_too_large' } })
    expect(await start('long.mov', 1024 * MIB)).toMatchObject({ status: 201 })
    expect(await start('longer.mp4', 1024 * MIB + 1)).toMatchObject({ status: 413, body: { code: 'document_too_large' } })
    // Names are made valid instead of refused.
    expect((await start('../../etc/Budget: 2026?.xlsx', 10)).body.name).toBe('Budget_ 2026_.xlsx')
    expect((await start('C:\\fakepath\\con.PDF', 10)).body.name).toBe('_con.PDF')
    for (const body of [
      { name: 'a.pdf', size: 1 }, { upload_id: 'not-a-uuid', name: 'a.pdf', size: 1 }, { upload_id: crypto.randomUUID(), name: '', size: 1 },
      { upload_id: crypto.randomUUID(), name: 'a.pdf', size: -1 }, { upload_id: crypto.randomUUID(), name: 'a.pdf', size: 1, folder_id: 1, document_id: 1 },
      { upload_id: crypto.randomUUID(), name: 'a.pdf', size: 1, note: '' },
    ]) {
      expect(await post('/api/documents/uploads', body), JSON.stringify(body)).toMatchObject({ status: 422, body: { code: 'invalid_request' } })
    }
    expect(await demoRequest('POST', '/api/documents/uploads', { body: { upload_id: crypto.randomUUID(), name: 'a.pdf', size: 1 }, mutationHeader: false }))
      .toMatchObject({ status: 403, body: { code: 'invalid_origin' } })
  })
})

describe('settings', () => {
  test('the administrator changes only the limits sent, within their ranges, also while Documents is off', async () => {
    coreStore().features.documents = false
    expect(await get(SETTINGS)).toMatchObject({ status: 401, body: { code: 'authentication_required' } })
    expect(await patch(SETTINGS, { max_file_mb: 5 })).toMatchObject({ status: 401, body: { code: 'authentication_required' } })
    await adminLogin()
    expect((await get<DocumentSettings>(SETTINGS)).body).toEqual({ manage_policy: 'creator', ...LIMITS })
    // Only what is sent changes, and the extremes are accepted.
    const changed = { ...LIMITS, max_file_mb: 1, community_quota_mb: DOCUMENT_QUOTA_LIMIT_MB }
    expect(await patch(SETTINGS, { max_file_mb: 1, community_quota_mb: DOCUMENT_QUOTA_LIMIT_MB }))
      .toMatchObject({ status: 200, body: { manage_policy: 'creator', ...changed } })
    expect((await patch(SETTINGS, { max_video_mb: DOCUMENT_SIZE_LIMIT_MB, user_quota_mb: 1 })).body)
      .toEqual({ manage_policy: 'creator', ...changed, max_video_mb: DOCUMENT_SIZE_LIMIT_MB, user_quota_mb: 1 })
    expect((await patch(SETTINGS, { manage_policy: 'everyone' })).body)
      .toEqual({ manage_policy: 'everyone', ...changed, max_video_mb: DOCUMENT_SIZE_LIMIT_MB, user_quota_mb: 1 })
    // A single file or video fits in a ZIP download.
    expect(DOCUMENT_SIZE_LIMIT_MB * MIB).toBe(ARCHIVE_MAX_BYTES)
    const saved = (await get<DocumentSettings>(SETTINGS)).body
    for (const body of [
      {}, { max_file_mb: null }, { manage_policy: null }, { max_file_mb: 0 }, { max_file_mb: DOCUMENT_SIZE_LIMIT_MB + 1 },
      { max_video_mb: -1 }, { user_quota_mb: 0 }, { community_quota_mb: DOCUMENT_QUOTA_LIMIT_MB + 1 }, { max_file_mb: 1.5 },
      { max_file_mb: '50' }, { max_file_mb: true }, { quota_mb: 5 }, { max_file_mb: 5, note: '' }, { manage_policy: 'nobody' },
    ]) {
      expect(await patch(SETTINGS, body), JSON.stringify(body)).toEqual({ status: 422, body: { code: 'invalid_request' }, headers: expect.anything() })
    }
    expect((await get<DocumentSettings>(SETTINGS)).body).toEqual(saved)
    expect(await demoRequest('PATCH', SETTINGS, { body: { max_file_mb: 5 }, mutationHeader: false })).toMatchObject({ status: 403, body: { code: 'invalid_origin' } })
  })

  test('the limits apply at once to browsing, new uploads, both quota checks and the storage summary', async () => {
    await setLimits({ max_file_mb: 1, max_video_mb: 2 })
    expect((await browse()).limits).toMatchObject({ max_file_bytes: MIB, max_video_bytes: 2 * MIB })
    expect(await start('large.pdf', MIB + 1)).toMatchObject({ status: 413, body: { code: 'document_too_large' } })
    expect(await start('video.mov', MIB + 100)).toMatchObject({ status: 201 })
    expect(await start('long.mp4', 2 * MIB + 1)).toMatchObject({ status: 413, body: { code: 'document_too_large' } })
    // Every stored version of a resident counts towards their quota.
    await setLimits({ user_quota_mb: 1 })
    await uploaded('One.pdf', pdf('one', 600_000))
    expect(await start('Two.pdf', 600_000)).toMatchObject({ status: 409, body: { code: 'document_storage_user_quota' } })
    // The community's quota is checked again on completion, with the limits of that moment.
    await signIn('james.okafor@example.com')
    const content = pdf('two', 600_000)
    const pending = await start('Two.pdf', content.length)
    expect(pending.status).toBe(201)
    await send(pending.uploadId, content)
    await setLimits({ community_quota_mb: 1 })
    expect(await post(`/api/documents/uploads/${pending.uploadId}/complete`)).toMatchObject({ status: 409, body: { code: 'document_storage_community_quota' } })
    await adminLogin()
    expect((await get<StorageOut>('/api/admin/storage')).body.documents).toMatchObject({ quota_bytes: MIB, resident_quota_bytes: MIB })
    await adminLogout()
    await setLimits({ community_quota_mb: 20480 })
    expect(await post(`/api/documents/uploads/${pending.uploadId}/complete`)).toMatchObject({ status: 200, body: { name: 'Two.pdf', author: JAMES } })
  })
})

describe('folders and files', () => {
  test('have names unique in their folder, move without loops or excess depth, and keep their history', async () => {
    await adminLogin()
    const archive = await folder('Minutes archive')
    let year = await folder('2027', archive.id)
    expect(year).toMatchObject({ author: ADMIN, parent_id: archive.id, file_count: 0, can_manage: true, can_delete: true })
    expect(await post('/api/documents/folders', { name: 'MINUTES ARCHIVE' }))
      .toMatchObject({ status: 409, body: { code: 'document_name_taken', fields: { name: 'document_name_taken' } } })
    // Folders and files share the names of a folder.
    expect(await post('/api/documents/folders', { name: 'welcome to documents.txt' })).toMatchObject({ status: 409 })
    for (const name of ['a/b', 'what?', 'AUX', 'com1.txt', ' . ', 'x'.repeat(201)]) {
      expect(await post('/api/documents/folders', { name }), name)
        .toMatchObject({ status: 422, body: { code: 'document_name_invalid', fields: { name: 'document_name_invalid' } } })
    }
    expect(await post('/api/documents/folders', { name: '' })).toMatchObject({ status: 422, body: { code: 'invalid_request' } })
    expect(await post('/api/documents/folders', { name: 'x', parent_id: 999 })).toMatchObject({ status: 404, body: { code: 'document_folder_not_found' } })
    expect((await folder('  Old \t minutes\n2026. ')).name).toBe('Old minutes 2026')
    const agenda = await uploaded('Agenda.pdf', pdf(), { folder_id: year.id })
    const second = await uploaded('agenda.pdf', pdf('other'), { folder_id: year.id })
    expect(second.name).toBe('agenda (2).pdf')
    // Ignoring case: the space of " (2)" comes before the dot of ".pdf".
    expect((await browse(year.id)).files.map(item => item.name)).toEqual(['agenda (2).pdf', 'Agenda.pdf'])
    expect((await browse()).folders.find(item => item.id === archive.id)).toMatchObject({ file_count: 2, folder_count: 1, size: agenda.current.size + second.current.size })

    const renamed = await patch<DocumentFolderOut>(`/api/documents/folders/${year.id}`, { version: year.version, name: 'Year 2027' })
    expect(renamed).toMatchObject({ status: 200, body: { name: 'Year 2027', version: 2 } })
    expect(await patch(`/api/documents/folders/${year.id}`, { version: year.version, name: 'Other' })).toMatchObject({ status: 409, body: { code: 'document_stale' } })
    year = renamed.body
    const moved = await patch<DocumentFolderOut>(`/api/documents/folders/${year.id}`, { version: year.version, folder_id: null })
    expect(moved.body).toMatchObject({ parent_id: null, version: 3 })
    expect((await history('folders', year.id)).map(entry => [entry.kind, entry.previous_name, entry.name, entry.previous_location, entry.location])).toEqual([
      ['moved', null, 'Year 2027', ['Minutes archive'], []],
      ['renamed', '2027', 'Year 2027', null, null],
      ['created', null, '2027', null, ['Minutes archive']],
    ])
    const inner = (await patch<DocumentFolderOut>(`/api/documents/folders/${archive.id}`, { version: archive.version, folder_id: year.id })).body
    expect(await patch(`/api/documents/folders/${year.id}`, { version: moved.body.version, folder_id: inner.id }))
      .toMatchObject({ status: 409, body: { code: 'document_move_into_itself' } })
    expect(await patch(`/api/documents/folders/${year.id}`, { version: moved.body.version, folder_id: year.id }))
      .toMatchObject({ status: 409, body: { code: 'document_move_into_itself' } })

    const renamedFile = await patch<DocumentOut>(`/api/documents/files/${second.id}`, { version: second.version, name: 'Notice of meeting' })
    expect(renamedFile.body.name).toBe('Notice of meeting.pdf')
    expect(await patch(`/api/documents/files/${second.id}`, { version: renamedFile.body.version, name: 'AGENDA.pdf' }))
      .toMatchObject({ status: 409, body: { code: 'document_name_taken' } })
    expect(await patch(`/api/documents/files/${second.id}`, { version: renamedFile.body.version, name: ' .pdf' }))
      .toMatchObject({ status: 422, body: { code: 'document_name_invalid' } })
    const movedFile = (await patch<DocumentOut>(`/api/documents/files/${second.id}`, { version: renamedFile.body.version, folder_id: inner.id })).body
    expect(movedFile.folder_id).toBe(inner.id)
    expect((await history('files', second.id))[0]).toMatchObject({ kind: 'moved', previous_location: ['Year 2027'], location: ['Year 2027', 'Minutes archive'] })
    expect((await browse(inner.id)).path.map(item => item.name)).toEqual(['Year 2027', 'Minutes archive'])
    const tree = (await get<DocumentTreeFolderOut[]>('/api/documents/folders')).body
    expect(tree.filter(item => [archive.id, year.id].includes(item.id))).toEqual([
      { id: archive.id, parent_id: year.id, name: 'Minutes archive' }, { id: year.id, parent_id: null, name: 'Year 2027' },
    ])

    // Ten levels at most.
    let parent: DocumentFolderOut | null = null
    for (let depth = 0; depth < 10; depth += 1) parent = await folder(`Level ${depth}`, parent?.id ?? null)
    expect(await post('/api/documents/folders', { name: 'Too deep', parent_id: parent!.id })).toMatchObject({ status: 409, body: { code: 'document_depth_limit' } })
    expect(await patch(`/api/documents/folders/${year.id}`, { version: moved.body.version, folder_id: parent!.id }))
      .toMatchObject({ status: 409, body: { code: 'document_depth_limit' } })
    for (const body of [{ name: 'x' }, { version: 0, name: 'x' }, { version: 1, name: '' }, { version: 1, color: 'red' }]) {
      expect(await patch(`/api/documents/folders/${year.id}`, body), JSON.stringify(body)).toMatchObject({ status: 422, body: { code: 'invalid_request' } })
    }
    expect(await demoRequest('DELETE', `/api/documents/files/${agenda.id}`)).toMatchObject({ status: 422, body: { code: 'invalid_request' } })
  })

  test("who manages items follows the administrator's policy", async () => {
    const shared = await folder('Shared')
    const own = await uploaded('Mine.pdf', pdf(), { folder_id: shared.id })
    await signIn('james.okafor@example.com')
    const other = await uploaded('Yours.pdf', pdf('other'), { folder_id: shared.id })
    const seen = await browse(shared.id)
    expect(seen.folder?.can_manage).toBe(false)
    expect(seen.files.map(item => [item.name, item.can_manage])).toEqual([['Mine.pdf', false], ['Yours.pdf', true]])
    expect(await patch(`/api/documents/files/${own.id}`, { version: own.version, name: 'Taken' })).toMatchObject({ status: 403, body: { code: 'document_permission_required' } })
    expect(await remove('files', own)).toMatchObject({ status: 403, body: { code: 'document_permission_required' } })
    expect(await start('Mine.pdf', 10, { document_id: own.id })).toMatchObject({ status: 403, body: { code: 'document_permission_required' } })
    expect((await patch(`/api/documents/files/${other.id}`, { version: other.version, name: 'Yours renamed' })).status).toBe(200)
    expect(await patch(SETTINGS, { manage_policy: 'everyone' })).toMatchObject({ status: 401 })

    await signIn('olivia.bennett@example.com')
    expect((await browse()).folders.find(item => item.id === shared.id)).toMatchObject({ can_manage: true, can_delete: false })
    expect(await remove('folders', shared)).toMatchObject({ status: 403, body: { code: 'document_folder_not_owned' } })
    // A new version started under one policy is refused if the policy changes before it completes.
    const version = await start('Mine.pdf', pdf('newer').length, { document_id: own.id })
    await send(version.uploadId, pdf('newer'))

    await adminLogin()
    expect(await patch(SETTINGS, { manage_policy: 'administrator' })).toMatchObject({ status: 200, body: { manage_policy: 'administrator', ...LIMITS } })
    expect(await patch(SETTINGS, { manage_policy: 'nobody' })).toMatchObject({ status: 422, body: { code: 'invalid_request' } })
    const renamedByAdmin = await patch<DocumentOut>(`/api/documents/files/${own.id}`, { version: own.version, name: 'Renamed by the administration' })
    expect(renamedByAdmin).toMatchObject({ status: 200, body: { can_manage: true } })
    await adminLogout()
    expect((await browse(shared.id)).policy).toBe('administrator')
    expect(await post(`/api/documents/uploads/${version.uploadId}/complete`)).toMatchObject({ status: 403, body: { code: 'document_permission_required' } })
    expect((await get(`/api/documents/uploads/${version.uploadId}`)).status).toBe(404)
    expect(await patch(`/api/documents/files/${own.id}`, { version: renamedByAdmin.body.version, name: 'Mine again' }))
      .toMatchObject({ status: 403, body: { code: 'document_permission_required' } })
    expect((await browse(shared.id)).files.some(item => item.can_manage)).toBe(false)
    // Anyone can still add folders and files.
    expect((await uploaded('New.pdf', pdf('new'), { folder_id: shared.id })).can_manage).toBe(false)

    await adminLogin()
    await patch(SETTINGS, { manage_policy: 'everyone' })
    await adminLogout()
    await signIn('james.okafor@example.com')
    const everyone = (await browse()).folders.find(item => item.id === shared.id)!
    expect(everyone).toMatchObject({ can_manage: true, can_delete: true })
    expect((await remove('folders', everyone)).status).toBe(204)
    expect((await browse()).folders.map(item => item.id)).not.toContain(shared.id)
    await adminLogin()
    expect((await deletions())[0]).toMatchObject({ name: 'Shared', author: JAMES, file_count: 3, folder_count: 0 })
  })
})

describe('deleted documents', () => {
  test('are hidden until the administrator restores them, where they were or at the top level, or purges them', async () => {
    const leases = await folder('Leases')
    const contracts = await folder('Contracts', leases.id)
    const lease = await uploaded('Lease.pdf', pdf('lease', 3000), { folder_id: contracts.id })
    const receipt = await uploaded('Receipt.pdf', pdf('receipt'), { folder_id: leases.id })
    expect((await remove('files', receipt)).status).toBe(204)
    expect((await remove('folders', (await browse()).folders.find(item => item.id === leases.id)!)).status).toBe(204)
    for (const email of ['james.okafor@example.com', 'olivia.bennett@example.com']) {
      await signIn(email)
      expect((await browse()).folders.map(item => item.name)).not.toContain('Leases')
      expect(await get(`/api/documents/folders/${contracts.id}`)).toMatchObject({ status: 404, body: { code: 'document_folder_not_found' } })
      expect(await get(`/api/documents/folders/${contracts.id}/history`)).toMatchObject({ status: 404, body: { code: 'document_folder_not_found' } })
      expect(await get(`/api/documents/files/${lease.id}`)).toMatchObject({ status: 404, body: { code: 'document_not_found' } })
      expect(await get(`/api/documents/files/${lease.id}/history`)).toMatchObject({ status: 404, body: { code: 'document_not_found' } })
      const file = await download(`/api/documents/versions/${lease.current.id}/download`)
      expect([file.status, errorCode(file.bytes)]).toEqual([404, 'document_not_found'])
      expect(await get('/api/admin/documents/deleted')).toMatchObject({ status: 401, body: { code: 'authentication_required' } })
    }
    await adminLogin()
    const listed = await deletions()
    expect(listed.map(item => [item.name, item.location, item.file_count, item.folder_count, item.file_kind, item.author])).toEqual([
      ['Leases', [], 1, 1, null, OLIVIA], ['Receipt.pdf', ['Leases'], 1, 0, 'pdf', OLIVIA],
      ['Roof claim photos', ['Insurance'], 1, 0, null, { kind: 'resident', name: 'Chloe Dubois', user_id: 14 }],
      ['Parking spaces - draft.pdf', [], 1, 0, 'pdf', { kind: 'resident', name: 'Daniel Mensah', user_id: 8 }],
    ])
    expect(listed[0]).toMatchObject({ folder_id: leases.id, document_id: null, stored_bytes: 3000, created_at: NOW.toISOString() })
    const info = (await get<DocumentInfoOut>(`/api/admin/documents/files/${lease.id}`)).body
    expect(info).toMatchObject({ deleted_by: OLIVIA, deleted_at: NOW.toISOString(), purged_at: null, can_manage: true })
    expect(info.location.map(item => item.name)).toEqual(['Leases', 'Contracts'])
    expect(bytesOf((await download(`/api/admin/documents/versions/${lease.current.id}/download`)).bytes)).toEqual(bytesOf(pdf('lease', 3000)))
    const folderHistory = (await get<DocumentHistoryPage>(`/api/admin/documents/folders/${contracts.id}/history`)).body.items
    expect(folderHistory.map(entry => [entry.kind, entry.folder])).toEqual([['deleted', 'Leases'], ['created', null]])
    expect((await get<DocumentHistoryPage>(`/api/admin/documents/files/${lease.id}/history`)).body.items[0]).toMatchObject({ kind: 'deleted', folder: 'Leases' })

    // The receipt's folder is still deleted, so it comes back at the top level.
    expect((await post(`/api/admin/documents/deletions/${listed[1].id}/restore`)).status).toBe(204)
    await adminLogout()
    expect((await browse()).files.map(item => item.name)).toContain('Receipt.pdf')
    await folder('Leases')
    await adminLogin()
    expect((await post(`/api/admin/documents/deletions/${listed[0].id}/restore`)).status).toBe(204)
    await adminLogout()
    const restored = (await browse()).folders.find(item => item.id === leases.id)!
    expect(restored).toMatchObject({ name: 'Leases (2)', file_count: 1, folder_count: 1, version: 3 })
    expect((await history('folders', leases.id))[0]).toEqual({
      id: expect.any(Number), kind: 'restored', author: ADMIN, created_at: NOW.toISOString(), name: 'Leases (2)', previous_name: 'Leases',
      location: [], previous_location: null, number: null, size: null, folder: null,
    })
    expect((await history('files', lease.id))[0]).toMatchObject({ kind: 'restored', name: 'Lease.pdf', folder: 'Leases (2)' })
    await adminLogin()
    expect(await post(`/api/admin/documents/deletions/${listed[0].id}/restore`)).toMatchObject({ status: 409, body: { code: 'document_deletion_closed' } })
    await adminLogout()

    expect((await remove('folders', restored)).status).toBe(204)
    await adminLogin()
    const [again] = await deletions()
    expect((await post(`/api/admin/documents/deletions/${again.id}/purge`)).status).toBe(204)
    const purged = await download(`/api/admin/documents/versions/${lease.current.id}/download`)
    expect([purged.status, errorCode(purged.bytes)]).toEqual([410, 'document_version_purged'])
    expect((await deletions()).map(item => item.id)).not.toContain(again.id)
    expect((await post(`/api/admin/documents/deletions/${again.id}/purge`)).status).toBe(204)
    expect(await post(`/api/admin/documents/deletions/${again.id}/restore`)).toMatchObject({ status: 409, body: { code: 'document_deletion_closed' } })
    expect(await post(`/api/admin/documents/deletions/${listed[1].id}/purge`)).toMatchObject({ status: 409, body: { code: 'document_deletion_closed' } })
    const after = (await get<DocumentInfoOut>(`/api/admin/documents/files/${lease.id}`)).body
    expect(after.purged_at).toBe(NOW.toISOString())
    expect(after.versions.map(item => item.purged_at)).toEqual([NOW.toISOString()])
    expect((await get<DocumentHistoryPage>(`/api/admin/documents/files/${lease.id}/history`)).body.items[0])
      .toMatchObject({ kind: 'purged', name: 'Lease.pdf', folder: 'Leases (2)' })
    expect(await post(`/api/admin/documents/deletions/${crypto.randomUUID()}/purge`)).toMatchObject({ status: 404, body: { code: 'document_deletion_not_found' } })
    expect(await post('/api/admin/documents/deletions/not-a-uuid/restore')).toMatchObject({ status: 422, body: { code: 'invalid_request' } })
    expect(await get('/api/admin/documents/files/9999')).toMatchObject({ status: 404, body: { code: 'document_not_found' } })
    expect(await get('/api/admin/documents/folders/9999/history')).toMatchObject({ status: 404, body: { code: 'document_folder_not_found' } })
  })
})

describe('versions', () => {
  test('a new version keeps the name and the earlier versions, which download with their number', async () => {
    const budget = await uploaded('Budget.csv', encoder.encode('item,amount\nlift,145\n'))
    expect(await start('Budget.pdf', 10, { document_id: budget.id })).toMatchObject({ status: 422, body: { code: 'document_version_extension' } })
    const newer = encoder.encode('item,amount\nlift,145\ncleaning,84\n')
    const updated = await uploaded('other name.CSV', newer, { document_id: budget.id })
    expect(updated).toMatchObject({ name: 'Budget.csv', version: 2, version_count: 2, current: { number: 2, size: newer.length }, previewable: true })
    const info = (await get<DocumentInfoOut>(`/api/documents/files/${budget.id}`)).body
    expect(info.versions.map(item => [item.number, item.author.name])).toEqual([[2, 'Olivia Bennett'], [1, 'Olivia Bennett']])
    const earlier = await download(`/api/documents/versions/${budget.current.id}/download`)
    expect(earlier.headers.get('Content-Disposition')).toBe("attachment; filename*=utf-8''Budget%20%28version%201%29.csv")
    expect(earlier.headers.get('Content-Type')).toBe('text/csv')
    // The portal shows text and CSV files itself, served as plain text.
    const preview = await download(`/api/documents/versions/${budget.current.id}/preview`)
    expect([preview.status, preview.headers.get('Content-Type')]).toEqual([200, 'text/plain'])
    const letter = await uploaded('Letter.docx', docx())
    const unavailable = await download(`/api/documents/versions/${letter.current.id}/preview`)
    expect([unavailable.status, errorCode(unavailable.bytes)]).toEqual([415, 'document_preview_unavailable'])
    expect((await history('files', budget.id)).map(entry => [entry.kind, entry.number, entry.size])).toEqual([
      ['version_added', 2, newer.length], ['created', 1, budget.current.size],
    ])
    const unknown = await download(`/api/documents/versions/${crypto.randomUUID()}/download`)
    expect([unknown.status, errorCode(unknown.bytes)]).toEqual([404, 'document_version_not_found'])
  })
})

describe('archives', () => {
  test('keep the folder structure and are named after what was chosen', async () => {
    await adminLogin()
    const community = await folder('Community')
    const plans = await folder('Plans', community.id)
    await folder('Empty \u00c5ngstr\u00f6m', community.id)
    const statutes = await uploaded('Statutes.pdf', pdf('statutes'), { folder_id: community.id })
    await uploaded('Floor plan.png', png(), { folder_id: plans.id })
    const rules = await uploaded('Rules.txt', encoder.encode('Synthetic rules\n'))
    const archive = async (query: string) => {
      const answer = await download(`/api/documents/archive?${query}`)
      expect(answer.status, query).toBe(200)
      const records = readZip(answer.bytes) ?? []
      return { ...answer, records, names: records.map(record => record.name) }
    }
    const whole = await archive(`folder=${community.id}`)
    expect(whole.headers.get('Content-Type')).toBe('application/zip')
    expect(whole.headers.get('Content-Disposition')).toBe('attachment; filename="Community.zip"')
    expect(whole.names).toEqual([
      'Community/', 'Community/Statutes.pdf', 'Community/Empty \u00c5ngstr\u00f6m/', 'Community/Plans/', 'Community/Plans/Floor plan.png',
    ])
    expect(whole.records.every(record => record.flags & 0x800)).toBe(true)
    const plan = whole.records.find(record => record.name === 'Community/Plans/Floor plan.png')!
    expect(bytesOf(await readZipMember(whole.bytes, plan, 1024))).toEqual(bytesOf(png()))
    // Items inside a chosen folder are not repeated.
    const mixed = await archive(`folder=${community.id}&file=${statutes.id}&file=${rules.id}`)
    expect(mixed.headers.get('Content-Disposition')).toBe('attachment; filename="Documents.zip"')
    expect(mixed.names.at(-1)).toBe('Rules.txt')
    expect(mixed.names.filter(name => name.endsWith('Statutes.pdf'))).toEqual(['Community/Statutes.pdf'])
    const single = await archive(`file=${statutes.id}`)
    expect(single.headers.get('Content-Disposition')).toBe('attachment; filename="Community.zip"')
    expect(single.names).toEqual(['Statutes.pdf'])
    // Names that collide at the top level are numbered.
    const copy = await uploaded('statutes.pdf', pdf('copy'))
    expect((await archive(`file=${statutes.id}&file=${copy.id}`)).names).toEqual(['Statutes.pdf', 'statutes (2).pdf'])
    expect((await archive(`folder=${plans.id}`)).headers.get('Content-Disposition')).toBe('attachment; filename="Plans.zip"')
    expect((await archive(`folder=${scenarioFolder('Garden').id}&folder=${community.id}`)).headers.get('Content-Disposition'))
      .toBe('attachment; filename="Documents.zip"')

    for (const [query, status, code] of [
      ['', 422, 'document_archive_items'], ['file=0', 422, 'document_archive_items'], ['file=2147483648', 422, 'document_archive_items'],
      [Array.from({ length: 101 }, () => `file=${rules.id}`).join('&'), 422, 'document_archive_items'], ['file=x', 422, 'invalid_request'],
      ['file=9999', 404, 'document_not_found'], ['folder=9999&file=9999', 404, 'document_folder_not_found'],
    ] as const) {
      const answer = await download(`/api/documents/archive?${query}`)
      expect([answer.status, errorCode(answer.bytes)], query).toEqual([status, code])
    }
    sharedDocumentsStore().versions.find(version => version.id === statutes.current.id)!.size = ARCHIVE_MAX_BYTES + 1
    const tooLarge = await download(`/api/documents/archive?folder=${community.id}`)
    expect([tooLarge.status, errorCode(tooLarge.bytes)]).toEqual([422, 'document_archive_too_large'])
  })
})
