import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import type {
  ActionAttachmentOut, ActionHistoryPage, ActionOut, ActorOut, DocumentHistoryPage, StorageOut, StoredAttachmentPage, StoredDocumentVersionOut,
  StoredDocumentVersionPage,
} from '../../api/schema.gen'
import { resetDemo } from '../store'
import { communityStore } from '../store/community'
import type { DemoActionAttachment } from '../store/community-model'
import { coreStore } from '../store/core'
import {
  DOCUMENT_COMMUNITY_QUOTA_BYTES, DOCUMENT_USER_QUOTA_BYTES, deleteDocument, publishUpload, receiveChunk, sharedDocumentsStore, startUpload,
  type DemoDocument, type DemoDocumentVersion,
} from '../store/shared-documents'
import { COMMUNITY_QUOTA_BYTES, DISK_RESERVE_BYTES, DISK_TOTAL_BYTES, MIB, USER_QUOTA_BYTES } from '../store/storage'
import { demoFetch, demoRequest, demoUrl } from '../testing'

// Thursday 29 October 2026, midday (local time), like the other demo tests.
const NOW = new Date(2026, 9, 29, 12)
const ADMIN = { kind: 'administrator', name: 'Technical administrator', user_id: null }

beforeEach(() => resetDemo({ now: () => NOW }))
afterEach(() => resetDemo())

const get = <T = unknown>(path: string) => demoRequest<T>('GET', path)
const adminLogin = () => demoRequest('POST', '/api/admin/auth/login', { body: { username: 'demo', password: 'demo' } })
const purge = <T = ActionAttachmentOut>(id: string, body: unknown) => demoRequest<T>('POST', `/api/admin/storage/attachments/${id}/purge`, { body })
const summary = async () => (await get<StorageOut>('/api/admin/storage')).body
const withdrawn = async (query = '') => (await get<StoredAttachmentPage>(`/api/admin/storage/withdrawn${query}`)).body

const bytes = (rows: readonly DemoActionAttachment[]) => rows.reduce((sum, row) => sum + row.size, 0)

function withdrawnPdf(author: string): DemoActionAttachment {
  const attachment = communityStore().attachments.find(item => item.withdrawnAt !== null && item.author.name === author)
  if (!attachment) throw new Error(`No withdrawn PDF of ${author}`)
  return attachment
}

describe('access', () => {
  test('only the administrator sees and purges storage, even with Actions off', async () => {
    const { id } = withdrawnPdf('Daniel Mensah')
    for (const path of ['/api/admin/storage', '/api/admin/storage/withdrawn']) {
      expect(await get(path), path).toMatchObject({ status: 401, body: { code: 'authentication_required' } })
    }
    expect(await purge(id, { version: 2 })).toMatchObject({ status: 401, body: { code: 'authentication_required' } })
    await adminLogin()
    expect(await demoRequest('POST', `/api/admin/storage/attachments/${id}/purge`, { body: { version: 2 }, mutationHeader: false }))
      .toMatchObject({ status: 403, body: { code: 'invalid_origin' } })
    coreStore().features.actions = false
    expect((await get('/api/admin/storage')).status).toBe(200)
    expect((await withdrawn()).total).toBe(3)
    expect(await purge(id, { version: 2 })).toMatchObject({ status: 200, body: { id, purged_at: NOW.toISOString() } })
  })
})

describe('usage', () => {
  test('counts active and withdrawn PDFs per resident and for the community, with the default quotas', async () => {
    await adminLogin()
    const { attachments } = communityStore()
    const usage = await summary()
    const active = attachments.filter(item => item.withdrawnAt === null)
    expect(usage.community).toEqual({
      quota_bytes: COMMUNITY_QUOTA_BYTES, stored_bytes: bytes(attachments), active_bytes: bytes(active),
      withdrawn_bytes: bytes(attachments) - bytes(active), active_files: active.length, withdrawn_files: 3,
      image_bytes: 0, image_files: 0,
    })
    expect([COMMUNITY_QUOTA_BYTES, USER_QUOTA_BYTES]).toEqual([2048 * MIB, 250 * MIB])
    const administrator = attachments.filter(item => item.author.kind === 'administrator')
    expect(usage.administrator).toMatchObject({ stored_bytes: bytes(administrator), active_files: administrator.length - 1, withdrawn_files: 1 })
    expect(usage.resident_quota_bytes).toBe(USER_QUOTA_BYTES)
    expect(usage.residents.map(row => row.stored_bytes)).toEqual(usage.residents.map(row => row.stored_bytes).sort((a, b) => b - a))
    expect(usage.residents.map(row => row.name).sort()).toEqual([
      'Chloe Dubois', 'Daniel Mensah', 'Emily Clarke', 'Grace Liu', 'James Okafor', 'Olivia Bennett',
    ])
    for (const row of usage.residents) {
      const own = attachments.filter(item => item.author.user_id === row.user_id)
      expect(row).toMatchObject({ quota_bytes: USER_QUOTA_BYTES, account_deleted: false, stored_bytes: bytes(own) })
      expect(row.active_files + row.withdrawn_files).toBe(own.length)
    }
    expect(usage.residents.find(row => row.name === 'Grace Liu')).toMatchObject({ active_files: 0, withdrawn_files: 1, active_bytes: 0 })
    expect(usage.community.stored_bytes).toBe(usage.administrator.stored_bytes + usage.residents.reduce((sum, row) => sum + row.stored_bytes, 0))
  })

  test('a synthetic upload volume whose free space follows the stored PDFs', async () => {
    await adminLogin()
    const { disk, community } = await summary()
    expect(disk).toMatchObject({ total_bytes: DISK_TOTAL_BYTES, reserve_bytes: DISK_RESERVE_BYTES })
    expect(DISK_TOTAL_BYTES).toBe(64 * 1024 * MIB)
    expect(disk.free_bytes! / 1024 / MIB).toBeCloseTo(41.3, 1)
    const pdf = withdrawnPdf('Grace Liu')
    await purge(pdf.id, { version: pdf.version })
    const after = await summary()
    expect(after.disk.free_bytes).toBe(disk.free_bytes! + pdf.size)
    expect(after.community.stored_bytes).toBe(community.stored_bytes - pdf.size)
  })

  test('residents follow their account: renamed ones by their new name, deleted ones by their last PDF', async () => {
    await adminLogin()
    expect(await demoRequest('PATCH', '/api/admin/users/9', {
      body: { name: 'Emily Clarke-Hughes', email: 'emily.clarke@example.com', dwelling_id: 7, version: 1 },
    })).toMatchObject({ status: 200 })
    expect(await demoRequest('DELETE', '/api/admin/users/8', { body: { email: 'daniel.mensah@example.com', version: 1 } })).toMatchObject({ status: 204 })
    const { residents } = await summary()
    expect(residents.find(row => row.user_id === 9)).toMatchObject({ name: 'Emily Clarke-Hughes', account_deleted: false })
    expect(residents.find(row => row.user_id === 8)).toMatchObject({ name: 'Daniel Mensah', account_deleted: true, withdrawn_files: 1 })
  })

  test('residents with the same storage are sorted by name', async () => {
    await adminLogin()
    for (const attachment of communityStore().attachments) attachment.size = 1000
    expect((await summary()).residents.map(row => [row.name, row.stored_bytes])).toEqual([
      ['James Okafor', 3000], ['Daniel Mensah', 2000], ['Chloe Dubois', 1000], ['Emily Clarke', 1000], ['Grace Liu', 1000], ['Olivia Bennett', 1000],
    ])
  })
})

describe('withdrawn PDFs', () => {
  test('lists the withdrawn PDFs still stored, largest first, with their action', async () => {
    await adminLogin()
    const page = await withdrawn()
    expect(page).toMatchObject({ page: 1, pages: 1, total: 3 })
    expect(page.items.map(item => item.size)).toEqual(page.items.map(item => item.size).sort((a, b) => b - a))
    const draft = page.items.find(item => item.author.kind === 'administrator')
    expect(draft).toMatchObject({
      filename: 'Quote - Apex Lifts (draft).pdf', author: ADMIN, version: 2, purged_at: null, withdrawn_at: expect.any(String),
      action_title: 'Lift modernisation: controller, doors and cabin',
    })
    const lift = communityStore().actions.find(action => action.title.startsWith('Lift modernisation'))
    expect(draft?.action_id).toBe(lift?.id)
    expect(page.items.map(item => item.author.name).sort()).toEqual(['Daniel Mensah', 'Grace Liu', 'Technical administrator'])
  })

  test('sorts by the oldest withdrawal, filters by resident and checks its parameters', async () => {
    await adminLogin()
    const oldest = await withdrawn('?sort=oldest')
    expect(oldest.items.map(item => item.author.name)).toEqual(['Daniel Mensah', 'Technical administrator', 'Grace Liu'])
    expect(oldest.items.map(item => item.withdrawn_at)).toEqual(oldest.items.map(item => item.withdrawn_at).sort())
    expect((await withdrawn('?user_id=8')).items).toEqual([expect.objectContaining({ filename: 'Quote - Fortis Security (single camera).pdf' })])
    expect((await withdrawn('?user_id=6&sort=oldest')).items).toEqual([])
    expect(await withdrawn('?page=2')).toMatchObject({ items: [], page: 2, pages: 1, total: 3 })
    for (const query of ['?sort=newest', '?user_id=0', '?user_id=me', '?page=0', '?page=1000001']) {
      expect(await get(`/api/admin/storage/withdrawn${query}`), query).toMatchObject({ status: 422, body: { code: 'invalid_request' } })
    }
  })

  test('pages by 20', async () => {
    await adminLogin()
    const { attachments } = communityStore()
    for (const attachment of attachments) attachment.withdrawnAt ??= NOW.toISOString()
    const first = await withdrawn('?sort=oldest'), second = await withdrawn('?sort=oldest&page=2')
    expect(first).toMatchObject({ page: 1, pages: Math.ceil(attachments.length / 20), total: attachments.length })
    expect(first.items).toHaveLength(20)
    const ids = [...first.items, ...second.items].map(item => item.id)
    expect(new Set(ids).size).toBe(attachments.length)
  })
})

describe('purging a withdrawn PDF', () => {
  test('deletes the file, keeps the record and its history, and frees the storage', async () => {
    await adminLogin()
    const pdf = withdrawnPdf('Grace Liu')
    const path = `/api/actions/items/${pdf.actionId}`
    const action = (await get<ActionOut>(path)).body
    const purged = await purge(pdf.id, { version: 2 })
    expect(purged.status).toBe(200)
    expect(purged.body).toEqual({
      id: pdf.id, filename: 'Solar subsidies - summary.pdf', size: pdf.size, sha256: pdf.sha256,
      author: { kind: 'resident', name: 'Grace Liu', user_id: 7 }, version: 3, created_at: pdf.createdAt,
      withdrawn_at: pdf.withdrawnAt, purged_at: NOW.toISOString(),
    })
    const [event] = (await get<ActionHistoryPage>(`${path}/history`)).body.items
    expect(event).toEqual({
      id: expect.any(Number), kind: 'attachment_purged', author: ADMIN, created_at: NOW.toISOString(), comment_id: null, attachment_id: pdf.id,
      changes: [
        { field: 'filename', before: 'Solar subsidies - summary.pdf', after: null },
        { field: 'size', before: String(pdf.size), after: null },
        { field: 'sha256', before: pdf.sha256, after: null },
      ],
    })
    expect((await get<ActionOut>(path)).body).toMatchObject({ version: action.version, updated_at: NOW.toISOString() })
    for (const kind of ['download', 'preview']) {
      expect(await get(`${path}/attachments/${pdf.id}/${kind}`), kind).toMatchObject({ status: 410, body: { code: 'action_attachment_purged' } })
    }
    expect((await get<ActionAttachmentOut>(`${path}/attachments/${pdf.id}`)).body).toMatchObject({ purged_at: NOW.toISOString(), version: 3 })
    expect((await withdrawn()).items.map(item => item.id)).not.toContain(pdf.id)
    expect((await summary()).residents.find(row => row.user_id === 7)).toBeUndefined()
    expect(pdf.bytes).toHaveLength(0)
  })

  test('purging again answers the purged PDF unchanged', async () => {
    await adminLogin()
    const pdf = withdrawnPdf('Daniel Mensah')
    const first = await purge(pdf.id, { version: 2 })
    expect(first).toMatchObject({ status: 200, body: { version: 3, purged_at: NOW.toISOString() } })
    const events = communityStore().actionHistory.length
    for (const version of [3, 2, 99]) expect(await purge(pdf.id, { version }), String(version)).toMatchObject({ status: 200, body: first.body })
    expect(communityStore().actionHistory).toHaveLength(events)
  })

  test('active PDFs cannot be purged, and the version must be the current one', async () => {
    await adminLogin()
    const active = communityStore().attachments.find(item => item.withdrawnAt === null)!
    expect(await purge(active.id, { version: active.version })).toMatchObject({ status: 409, body: { code: 'action_attachment_active' } })
    expect(await purge(active.id, { version: active.version + 1 })).toMatchObject({ status: 409, body: { code: 'action_stale' } })
    const pdf = withdrawnPdf('Technical administrator')
    expect(await purge(pdf.id, { version: 1 })).toMatchObject({ status: 409, body: { code: 'action_stale' } })
    expect(active.purgedAt).toBeNull()
    expect(pdf.purgedAt).toBeNull()
  })

  test('unknown PDFs are not found, and the request follows the contract', async () => {
    await adminLogin()
    const { id } = withdrawnPdf('Grace Liu')
    expect(await purge(crypto.randomUUID(), { version: 1 })).toMatchObject({ status: 404, body: { code: 'action_attachment_not_found' } })
    for (const [target, body] of [
      ['not-a-uuid', { version: 2 }], [id, {}], [id, { version: 0 }], [id, { version: 2, reason: 'old' }],
    ] as const) {
      expect(await purge(target, body), JSON.stringify([target, body])).toMatchObject({ status: 422, body: { code: 'invalid_request' } })
    }
    expect(await purge(id.toUpperCase(), { version: 2 })).toMatchObject({ status: 200, body: { id } })
  })
})

describe('shared documents', () => {
  const OLIVIA: ActorOut = { kind: 'resident', name: 'Olivia Bennett', user_id: 6 }
  const versions = async (query = '') => (await get<StoredDocumentVersionPage>(`/api/admin/storage/document-versions${query}`)).body
  const purgeVersion = (id: string) => demoRequest<StoredDocumentVersionOut>('POST', `/api/admin/storage/document-versions/${id}/purge`)
  const size = (rows: readonly DemoDocumentVersion[]) => rows.reduce((sum, row) => sum + row.size, 0)

  /** A file of `bytes` stored by `actor` through the upload operations, or a new version of `document`. */
  function store(actor: ActorOut, name: string, bytes: Uint8Array<ArrayBuffer>, document?: DemoDocument): DemoDocument {
    const documents = sharedDocumentsStore(), uploadId = crypto.randomUUID(), at = NOW.toISOString()
    startUpload(documents, actor, { uploadId, name, size: bytes.length, folderId: null, documentId: document?.id ?? null }, at)
    receiveChunk(documents, actor, uploadId, 0, bytes, at)
    return publishUpload(documents, actor, uploadId, at)
  }

  function version(name: string, number: number): DemoDocumentVersion {
    const { documents, versions: all } = sharedDocumentsStore()
    const document = documents.find(item => item.name === name)
    const found = all.find(item => item.documentId === document?.id && item.number === number)
    if (!found) throw new Error(`No version ${number} of ${name}`)
    return found
  }

  test('the summary counts every stored version by state and by uploader, with their own quotas', async () => {
    await adminLogin()
    const before = await summary()
    const documents = sharedDocumentsStore()
    const stored = documents.versions.filter(item => item.purgedAt === null)
    expect(before.documents).toMatchObject({
      quota_bytes: DOCUMENT_COMMUNITY_QUOTA_BYTES, resident_quota_bytes: DOCUMENT_USER_QUOTA_BYTES, stored_bytes: size(stored),
      files: 10, previous_versions: 2, deleted_files: 2, upload_bytes: 0, uploads: 0,
      administrator_bytes: size(stored.filter(item => item.author.kind === 'administrator')),
    })
    expect([DOCUMENT_COMMUNITY_QUOTA_BYTES, DOCUMENT_USER_QUOTA_BYTES]).toEqual([20480 * MIB, 2048 * MIB])
    const { current_bytes, previous_bytes, deleted_bytes } = before.documents
    expect(current_bytes + previous_bytes + deleted_bytes).toBe(before.documents.stored_bytes)
    expect(previous_bytes).toBe(version('House rules.pdf', 1).size + version('Claims log.csv', 1).size)
    expect(before.documents.residents.map(row => row.stored_bytes)).toEqual(before.documents.residents.map(row => row.stored_bytes).sort((a, b) => b - a))
    for (const row of before.documents.residents) {
      const own = stored.filter(item => item.author.user_id === row.user_id)
      expect(row).toMatchObject({ account_deleted: false, stored_bytes: size(own), versions: own.length })
    }
    expect(before.documents.residents.find(row => row.user_id === 9)).toMatchObject({ name: 'Emily Clarke', versions: 2 })

    // Uploads in progress count, and the volume's free space follows them.
    const uploadId = crypto.randomUUID()
    startUpload(documents, OLIVIA, { uploadId, name: 'Plan.pdf', size: 900, folderId: null, documentId: null }, NOW.toISOString())
    receiveChunk(documents, OLIVIA, uploadId, 0, new Uint8Array(300), NOW.toISOString())
    // Deleted accounts keep their stored versions, named by the latest one.
    expect(await demoRequest('DELETE', '/api/admin/users/8', { body: { email: 'daniel.mensah@example.com', version: 1 } })).toMatchObject({ status: 204 })
    const after = await summary()
    expect(after.documents).toMatchObject({ upload_bytes: 300, uploads: 1, stored_bytes: before.documents.stored_bytes })
    expect(after.disk.free_bytes).toBe(before.disk.free_bytes! - 300)
    expect(after.documents.residents.find(row => row.user_id === 8)).toMatchObject({ name: 'Daniel Mensah', account_deleted: true, versions: 1 })
  })

  test('lists the earlier versions still stored, largest or oldest first, of everyone or of a resident', async () => {
    const big = store(OLIVIA, 'Survey results.csv', new Uint8Array(5000).fill(0x41))
    store(OLIVIA, 'Survey results.csv', new TextEncoder().encode('fixed\n'), big)
    await adminLogin()
    const largest = await versions()
    expect(largest).toMatchObject({ total: 3, page: 1, pages: 1 })
    expect(largest.items.map(item => [item.document_name, item.number, item.location])).toEqual([
      ['Survey results.csv', 1, []], ['House rules.pdf', 1, ['Community rules']], ['Claims log.csv', 1, ['Insurance']],
    ])
    expect(largest.items[1]).toMatchObject({ author: ADMIN, extension: 'pdf', media_type: 'application/pdf', purged_at: null })
    expect((await versions('?sort=oldest')).items.map(item => item.document_name)).toEqual(['House rules.pdf', 'Claims log.csv', 'Survey results.csv'])
    expect((await versions('?user_id=9')).items.map(item => item.document_name)).toEqual(['Claims log.csv'])
    expect((await versions('?user_id=1')).items).toEqual([])
    expect(await versions('?page=2')).toMatchObject({ items: [], page: 2, pages: 1, total: 3 })
    for (const query of ['?sort=newest', '?user_id=0', '?page=0']) {
      expect(await get(`/api/admin/storage/document-versions${query}`), query).toMatchObject({ status: 422, body: { code: 'invalid_request' } })
    }
  })

  test("purging an earlier version frees its bytes and keeps the document's history", async () => {
    await adminLogin()
    const earlier = version('House rules.pdf', 1)
    const before = await summary()
    const purged = await purgeVersion(earlier.id)
    expect(purged).toMatchObject({
      status: 200, body: {
        id: earlier.id, number: 1, document_name: 'House rules.pdf', location: ['Community rules'], size: earlier.size, sha256: earlier.sha256,
        purged_at: NOW.toISOString(),
      },
    })
    expect((await purgeVersion(earlier.id)).body).toEqual(purged.body)
    expect(earlier.bytes).toHaveLength(0)
    const after = await summary()
    expect(after.documents.previous_bytes).toBe(before.documents.previous_bytes - earlier.size)
    expect(after.disk.free_bytes).toBe(before.disk.free_bytes! + earlier.size)
    expect((await versions()).items.map(item => item.id)).not.toContain(earlier.id)
    const [event] = (await get<DocumentHistoryPage>(`/api/admin/documents/files/${earlier.documentId}/history`)).body.items
    expect(event).toMatchObject({ kind: 'version_purged', author: ADMIN, name: 'House rules.pdf', number: 1, size: earlier.size })
    const download = await demoFetch(new Request(demoUrl(`/api/documents/versions/${earlier.id}/download`)))
    expect([download.status, (await download.json() as { code: string }).code]).toEqual([410, 'document_version_purged'])

    expect(await purgeVersion(version('House rules.pdf', 2).id)).toMatchObject({ status: 409, body: { code: 'document_version_current' } })
    // A deleted document's versions are purged together, from Deleted documents.
    const draft = store(OLIVIA, 'Draft.txt', new TextEncoder().encode('one\n'))
    store(OLIVIA, 'Draft.txt', new TextEncoder().encode('two\n'), draft)
    deleteDocument(sharedDocumentsStore(), OLIVIA, draft.id, draft.version, NOW.toISOString())
    expect(await purgeVersion(version('Draft.txt', 1).id)).toMatchObject({ status: 409, body: { code: 'document_deleted' } })
    expect(await purgeVersion(crypto.randomUUID())).toMatchObject({ status: 404, body: { code: 'document_version_not_found' } })
    expect(await purgeVersion('not-a-uuid')).toMatchObject({ status: 422, body: { code: 'invalid_request' } })
  })

  test('only the administrator sees and purges them, also while Documents is off', async () => {
    const { id } = version('Claims log.csv', 1)
    expect(await get('/api/admin/storage/document-versions')).toMatchObject({ status: 401, body: { code: 'authentication_required' } })
    expect(await purgeVersion(id)).toMatchObject({ status: 401, body: { code: 'authentication_required' } })
    await adminLogin()
    coreStore().features.documents = false
    expect((await versions()).total).toBe(2)
    expect(await demoRequest('POST', `/api/admin/storage/document-versions/${id}/purge`, { mutationHeader: false }))
      .toMatchObject({ status: 403, body: { code: 'invalid_origin' } })
    expect(await purgeVersion(id)).toMatchObject({ status: 200, body: { id, purged_at: NOW.toISOString(), author: { name: 'Emily Clarke' } } })
  })
})
