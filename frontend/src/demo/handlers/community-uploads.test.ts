// Uploads are multipart requests like the app's. jsdom replaces `File` and `FormData`, which
// Node's Request cannot use: the body is written by hand and Node's `File` is restored meanwhile.
import { File as NodeFile } from 'node:buffer'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { ActionAttachmentOut, ActionAttachmentPage, ActionHistoryPage, ActionOut } from '../../api/schema.gen'
import { MUTATION_HEADER, demoPdf } from '../core'
import { resetDemo } from '../store'
import { communityStore } from '../store/community'
import type { DemoActionAttachment } from '../store/community-model'
import { sha256Hex } from '../store/community-sha256'
import { COMMUNITY_QUOTA_BYTES, USER_QUOTA_BYTES } from '../store/storage'
import { demoFetch, demoRequest, demoUrl } from '../testing'

const NOW = new Date(2026, 9, 29, 12)
const OLIVIA = { kind: 'resident', name: 'Olivia Bennett', user_id: 6 }
const BOUNDARY = '----juntia-demo-upload-boundary'

beforeEach(() => resetDemo({ now: () => NOW }))
afterEach(() => resetDemo())

function actionId(title: string): number {
  const action = communityStore().actions.find(item => item.title.startsWith(title))
  if (!action) throw new Error(`No action "${title}"`)
  return action.id
}

/** `multipart/form-data` with the app's fields (`file` and `upload_id`). */
function multipart(file: { name: string; bytes: Uint8Array } | null, uploadId: string | null): Uint8Array<ArrayBuffer> {
  const encoder = new TextEncoder()
  const parts: Uint8Array[] = []
  if (file) {
    parts.push(encoder.encode(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: application/pdf\r\n\r\n`), file.bytes, encoder.encode('\r\n'))
  }
  if (uploadId !== null) parts.push(encoder.encode(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="upload_id"\r\n\r\n${uploadId}\r\n`))
  parts.push(encoder.encode(`--${BOUNDARY}--\r\n`))
  const body = new Uint8Array(parts.reduce((size, part) => size + part.length, 0))
  let offset = 0
  for (const part of parts) {
    body.set(part, offset)
    offset += part.length
  }
  return body
}

/** `POST …/attachments` as the app sends it. */
async function upload<T = ActionAttachmentOut>(
  itemId: number, file: { name: string; bytes: Uint8Array } | null, uploadId: string | null = crypto.randomUUID(),
  { mutationHeader = true } = {},
): Promise<{ status: number; body: T }> {
  const headers: Record<string, string> = { 'Content-Type': `multipart/form-data; boundary=${BOUNDARY}` }
  if (mutationHeader) headers[MUTATION_HEADER] = '1'
  vi.stubGlobal('File', NodeFile)
  try {
    const response = await demoFetch(new Request(demoUrl(`/api/actions/items/${itemId}/attachments`), {
      method: 'POST', body: multipart(file, uploadId), headers,
    }))
    return { status: response.status, body: await response.json() as T }
  } finally {
    vi.unstubAllGlobals()
  }
}

const quote = (title = 'Synthetic quote') => demoPdf(title, ['Line one', 'Line two'])

describe('PDF uploads', () => {
  test('store the PDF with its fingerprint, record the history and can be retried safely', async () => {
    const id = actionId('Bike storage')
    const path = `/api/actions/items/${id}`
    const before = (await demoRequest<ActionOut>('GET', path)).body
    const bytes = quote('Bike rack quote')
    const uploadId = crypto.randomUUID()
    const created = await upload(id, { name: '../../Bike rack quote.PDF', bytes }, uploadId)
    expect(created).toEqual({
      status: 201,
      body: {
        id: uploadId, filename: 'Bike rack quote.pdf', size: bytes.length, sha256: sha256Hex(bytes), author: OLIVIA, version: 1,
        created_at: NOW.toISOString(), withdrawn_at: null, purged_at: null,
      },
    })
    expect(await upload(id, { name: 'Bike rack quote.pdf', bytes }, uploadId.toUpperCase())).toEqual(created)
    expect(await upload(id, { name: 'Other name.pdf', bytes }, uploadId)).toMatchObject({ status: 409, body: { code: 'action_upload_conflict' } })
    expect(await upload(actionId('Roof leak'), { name: 'Bike rack quote.pdf', bytes }, uploadId)).toMatchObject({ status: 409, body: { code: 'action_upload_conflict' } })
    const [event] = (await demoRequest<ActionHistoryPage>('GET', `${path}/history`)).body.items
    expect(event).toMatchObject({
      kind: 'attachment_added', attachment_id: uploadId, author: OLIVIA,
      changes: [{ field: 'filename', before: null, after: 'Bike rack quote.pdf' }, { field: 'size', before: null, after: String(bytes.length) }],
    })
    expect((await demoRequest<ActionOut>('GET', path)).body).toMatchObject({
      version: before.version, attachment_count: before.attachment_count + 1, updated_at: NOW.toISOString(),
    })
    const download = await demoFetch(new Request(demoUrl(`${path}/attachments/${uploadId}/download`)))
    expect(sha256Hex(new Uint8Array(await download.arrayBuffer()))).toBe(sha256Hex(bytes))
    expect(download.headers.get('Content-Disposition')).toBe("attachment; filename*=utf-8''Bike%20rack%20quote.pdf")
  })

  test('refuse anything but a PDF of at most 20 MiB', async () => {
    const id = actionId('Bike storage')
    const bytes = quote()
    expect(await upload(id, { name: 'quote.pdf', bytes: new TextEncoder().encode('<html>Not a PDF</html>') })).toMatchObject({ status: 415, body: { code: 'action_pdf_required' } })
    expect(await upload(id, { name: 'quote.pdf', bytes: new TextEncoder().encode('%PDF-1.7\ntruncated') })).toMatchObject({ status: 415 })
    expect(await upload(id, { name: 'quote.png', bytes })).toMatchObject({ status: 415, body: { code: 'action_pdf_required' } })
    expect(await upload(id, { name: 'quote.pdf', bytes: new Uint8Array() })).toMatchObject({ status: 415 })
    const largest = new Uint8Array(20 * 1024 * 1024)
    largest.set(bytes)
    largest.set(new TextEncoder().encode('\n%%EOF\n'), largest.length - 7)
    expect(await upload(id, { name: 'largest.pdf', bytes: largest })).toMatchObject({ status: 201, body: { size: 20 * 1024 * 1024 } })
    const tooLarge = new Uint8Array(20 * 1024 * 1024 + 1)
    tooLarge.set(largest)
    expect(await upload(id, { name: 'too large.pdf', bytes: tooLarge })).toMatchObject({ status: 413, body: { code: 'upload_too_large' } })
    expect(await upload(id, null)).toMatchObject({ status: 422, body: { code: 'invalid_request' } })
    expect(await upload(id, { name: 'quote.pdf', bytes }, null)).toMatchObject({ status: 422 })
    expect(await upload(id, { name: 'quote.pdf', bytes }, 'not-a-uuid')).toMatchObject({ status: 422 })
    expect(await upload(9999, { name: 'quote.pdf', bytes })).toMatchObject({ status: 404, body: { code: 'action_not_found' } })
    expect(await upload(id, { name: 'quote.pdf', bytes }, crypto.randomUUID(), { mutationHeader: false })).toMatchObject({ status: 403, body: { code: 'invalid_origin' } })
    await demoRequest('POST', '/api/auth/logout')
    expect(await upload(id, { name: 'quote.pdf', bytes })).toMatchObject({ status: 401, body: { code: 'authentication_required' } })
  })

  test('allow 20 active PDFs per action; withdrawing one frees a place but not its upload id', async () => {
    const id = actionId('Cracked tiles')
    const ids: string[] = []
    for (let index = 0; index < 20; index += 1) {
      const result = await upload(id, { name: `Photo ${index + 1}.pdf`, bytes: quote(`Photo ${index + 1}`) })
      expect(result.status).toBe(201)
      ids.push(result.body.id)
    }
    expect(await upload(id, { name: 'One more.pdf', bytes: quote() })).toMatchObject({ status: 409, body: { code: 'action_attachment_limit' } })
    const path = `/api/actions/items/${id}/attachments`
    expect((await demoRequest('DELETE', `${path}/${ids[0]}`, { body: { version: 1 } })).status).toBe(204)
    expect(await upload(id, { name: 'Photo 1.pdf', bytes: quote('Photo 1') }, ids[0])).toMatchObject({ status: 409, body: { code: 'action_upload_conflict' } })
    expect((await upload(id, { name: 'One more.pdf', bytes: quote() })).status).toBe(201)
    expect((await demoRequest<ActionAttachmentPage>('GET', path)).body.total).toBe(20)
    const all = await demoRequest<ActionAttachmentPage>('GET', `${path}?include_withdrawn=true&page=2`)
    expect(all.body).toMatchObject({ total: 21, pages: 2, page: 2 })
    expect(all.body.items).toHaveLength(1)
  })
})

describe('storage quotas', () => {
  const adminLogin = () => demoRequest('POST', '/api/admin/auth/login', { body: { username: 'demo', password: 'demo' } })
  const adminLogout = () => demoRequest('POST', '/api/admin/auth/logout')

  /** The sample neighbor's PDF: the bike rack catalogue. */
  function catalogue(): DemoActionAttachment {
    const attachment = communityStore().attachments.find(item => item.filename === 'Bike rack catalogue.pdf')
    if (!attachment) throw new Error('No bike rack catalogue')
    return attachment
  }

  /** Bytes still stored (active and withdrawn PDFs) of the PDFs `matching`. */
  function stored(matching: (attachment: DemoActionAttachment) => boolean = () => true): number {
    return communityStore().attachments.filter(item => item.purgedAt === null && matching(item)).reduce((sum, item) => sum + item.size, 0)
  }

  test("a neighbor's PDFs, withdrawn ones included, must fit their quota until the administrator purges some", async () => {
    const id = actionId('Bike storage')
    const bytes = quote('Quota check')
    // Olivia's PDFs leave exactly the size of this one.
    catalogue().size += USER_QUOTA_BYTES - stored(item => item.author.user_id === 6) - bytes.length
    expect((await upload(id, { name: 'Fits exactly.pdf', bytes })).status).toBe(201)
    const { attachments, actionHistory } = communityStore()
    const counts = [attachments.length, actionHistory.length]
    expect(await upload(id, { name: 'One more.pdf', bytes: quote() })).toMatchObject({ status: 409, body: { code: 'action_storage_user_quota' } })
    expect([attachments.length, actionHistory.length]).toEqual(counts)

    // A withdrawn PDF keeps its file, so it still counts; a purge frees it.
    const path = `/api/actions/items/${id}/attachments/${catalogue().id}`
    expect((await demoRequest('DELETE', path, { body: { version: 1 } })).status).toBe(204)
    expect(await upload(id, { name: 'One more.pdf', bytes: quote() })).toMatchObject({ status: 409, body: { code: 'action_storage_user_quota' } })
    await adminLogin()
    expect(await demoRequest('POST', `/api/admin/storage/attachments/${catalogue().id}/purge`, { body: { version: 2 } })).toMatchObject({ status: 200 })
    await adminLogout()
    expect(await upload(id, { name: 'One more.pdf', bytes: quote() })).toMatchObject({ status: 201, body: { author: OLIVIA } })
  })

  test("each neighbor has their own quota; the community's counts everybody, the administrator included", async () => {
    const id = actionId('Bike storage')
    const bytes = quote('Quota check')
    catalogue().size += USER_QUOTA_BYTES
    expect(await upload(id, { name: 'Mine.pdf', bytes })).toMatchObject({ status: 409, body: { code: 'action_storage_user_quota' } })
    await demoRequest('POST', '/api/auth/login', { body: { email: 'james.okafor@example.com', password: 'demo' } })
    expect((await upload(id, { name: 'James.pdf', bytes })).status).toBe(201)

    // The community quota leaves exactly the size of one more PDF.
    const draft = communityStore().attachments.find(item => item.author.kind === 'administrator')
    if (!draft) throw new Error('No PDF of the administrator')
    draft.size += COMMUNITY_QUOTA_BYTES - stored() - bytes.length
    expect((await upload(id, { name: 'Last one.pdf', bytes })).status).toBe(201)
    expect(await upload(id, { name: 'Over.pdf', bytes })).toMatchObject({ status: 409, body: { code: 'action_storage_community_quota' } })
    await adminLogin()
    expect(await upload(id, { name: 'Over.pdf', bytes })).toMatchObject({ status: 409, body: { code: 'action_storage_community_quota' } })
    await demoRequest('POST', '/api/auth/login', { body: { email: 'olivia.bennett@example.com', password: 'demo' } })
    await adminLogout()
    // Over both quotas, the uploader's is reported first.
    expect(await upload(id, { name: 'Over.pdf', bytes })).toMatchObject({ status: 409, body: { code: 'action_storage_user_quota' } })
  })

  test('a retried upload is answered from the stored PDF, never counted twice', async () => {
    const id = actionId('Bike storage')
    const bytes = quote('Retry')
    const uploadId = crypto.randomUUID()
    const created = await upload(id, { name: 'Retry.pdf', bytes }, uploadId)
    expect(created.status).toBe(201)
    catalogue().size += USER_QUOTA_BYTES
    expect(await upload(id, { name: 'Retry.pdf', bytes }, uploadId)).toEqual(created)
  })
})
