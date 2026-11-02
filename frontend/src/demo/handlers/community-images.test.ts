// Uploads are multipart requests like the app's. jsdom replaces `File` and `FormData`, which
// Node's Request cannot use: the body is written by hand and Node's `File` is restored meanwhile.
import { File as NodeFile } from 'node:buffer'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { CommunityImageOut, StorageOut, StoredImageOut, StoredImagePage } from '../../api/schema.gen'
import { DemoApiError, MUTATION_HEADER } from '../core'
import { resetDemo } from '../store'
import { communityStore } from '../store/community'
import { MAX_IMAGE_BYTES, imageFormat, uploadedImageName } from '../store/community-images'
import { coreStore } from '../store/core'
import { sha256Hex } from '../store/community-sha256'
import { USER_QUOTA_BYTES } from '../store/storage'
import { demoFetch, demoRequest, demoUrl } from '../testing'

const NOW = new Date(2026, 9, 29, 12)
const OLIVIA = { kind: 'resident', name: 'Olivia Bennett', user_id: 6 }
const BOUNDARY = '----juntia-demo-image-boundary'

beforeEach(() => resetDemo({ now: () => NOW }))
afterEach(() => resetDemo())

const adminLogin = () => demoRequest('POST', '/api/admin/auth/login', { body: { username: 'demo', password: 'demo' } })
const adminLogout = () => demoRequest('POST', '/api/admin/auth/logout')

/** A PNG header of the given size, padded with `extra` bytes: the demo reads headers only, like the backend. */
function png(width = 32, height = 24, extra = 0): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(33 + extra)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
  const view = new DataView(bytes.buffer)
  view.setUint32(16, width)
  view.setUint32(20, height)
  bytes.set([8, 2, 0, 0, 0], 24)
  return bytes
}

function bytesOf(...parts: (number[] | string)[]): Uint8Array {
  return new Uint8Array(parts.flatMap(part => typeof part === 'string' ? Array.from(part, character => character.charCodeAt(0)) : part))
}

const word = (value: number) => [value & 0xff, value >> 8]

/** A GIF89a with a 2-colour table, optional blocks before its first image, and that image (like the backend tests'). */
function gif([width, height] = [1, 1], [left, top, frameWidth, frameHeight] = [0, 0, 1, 1], before: number[] = []): Uint8Array {
  return bytesOf('GIF89a', word(width), word(height), [0x80, 0, 0, 0, 0, 0, 0xff, 0xff, 0xff], before,
    [0x2c], word(left), word(top), word(frameWidth), word(frameHeight), [0, 2, 2, 0x44, 1, 0, 0x3b])
}

/** SOI, the given segments, then a 640×480 frame header. */
function jpeg(...segments: Uint8Array[]): Uint8Array {
  const frame = [0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0xe0, 0x02, 0x80, 0x03, ...Array.from({ length: 9 }, () => 0)]
  const size = segments.reduce((sum, segment) => sum + segment.length, 0)
  const bytes = new Uint8Array(2 + size + frame.length)
  bytes.set([0xff, 0xd8])
  let offset = 2
  for (const segment of segments) {
    bytes.set(segment, offset)
    offset += segment.length
  }
  bytes.set(frame, offset)
  return bytes
}

function repeated(pattern: number[], times: number): Uint8Array {
  const bytes = new Uint8Array(pattern.length * times)
  for (let index = 0; index < times; index++) bytes.set(pattern, index * pattern.length)
  return bytes
}

function concat(...parts: (Uint8Array | number[])[]): Uint8Array {
  const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let offset = 0
  for (const part of parts) {
    bytes.set(part, offset)
    offset += part.length
  }
  return bytes
}

/** `multipart/form-data` with the app's fields (`file` and `upload_id`). */
function multipart(file: { name: string; bytes: Uint8Array } | null, uploadId: string | null): Uint8Array<ArrayBuffer> {
  const encoder = new TextEncoder()
  const parts: Uint8Array[] = []
  if (file) {
    parts.push(encoder.encode(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: image/png\r\n\r\n`), file.bytes, encoder.encode('\r\n'))
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

/** `POST /api/{scope}/images` as the app sends it. */
async function upload<T = CommunityImageOut>(
  file: { name: string; bytes: Uint8Array } | null, { uploadId = crypto.randomUUID() as string | null, scope = 'actions', mutationHeader = true } = {},
): Promise<{ status: number; body: T }> {
  const headers: Record<string, string> = { 'Content-Type': `multipart/form-data; boundary=${BOUNDARY}` }
  if (mutationHeader) headers[MUTATION_HEADER] = '1'
  vi.stubGlobal('File', NodeFile)
  try {
    const response = await demoFetch(new Request(demoUrl(`/api/${scope}/images`), { method: 'POST', body: multipart(file, uploadId), headers }))
    return { status: response.status, body: await response.json() as T }
  } finally {
    vi.unstubAllGlobals()
  }
}

async function file(path: string): Promise<Response> {
  return demoFetch(new Request(demoUrl(path)))
}

function problem(bytes: Uint8Array): string {
  try {
    imageFormat(bytes)
  } catch (error) {
    if (error instanceof DemoApiError) return `${error.status} ${error.payload.code}`
    throw error
  }
  return 'valid'
}

describe('formats', () => {
  test('come from the bytes, with the size of the header, like the backend', () => {
    expect(imageFormat(png(300, 200))).toEqual({ mediaType: 'image/png', width: 300, height: 200 })
    expect(imageFormat(gif([17, 9], [0, 0, 17, 9]))).toEqual({ mediaType: 'image/gif', width: 17, height: 9 })
    const jpeg = bytesOf([0xff, 0xd8, 0xff, 0xe1, 0, 6], 'Exif', [0xff, 0xc2, 0, 11, 8, 0x01, 0xe0, 0x02, 0x80, 3, 1, 0x22, 0])
    expect(imageFormat(jpeg)).toEqual({ mediaType: 'image/jpeg', width: 640, height: 480 })
    const riff = (chunk: string, data: number[]) => bytesOf('RIFF', [0, 0, 0, 0], 'WEBP', chunk, [10, 0, 0, 0], data)
    expect(imageFormat(riff('VP8 ', [0, 0, 0, 0x9d, 0x01, 0x2a, 0x41, 0x01, 0x7b, 0x00]))).toEqual({ mediaType: 'image/webp', width: 321, height: 123 })
    const lossless = (320 | (122 << 14)) >>> 0
    expect(imageFormat(riff('VP8L', [0x2f, lossless & 0xff, (lossless >> 8) & 0xff, (lossless >> 16) & 0xff, lossless >>> 24, 0, 0, 0, 0, 0])))
      .toEqual({ mediaType: 'image/webp', width: 321, height: 123 })
    expect(imageFormat(riff('VP8X', [0, 0, 0, 0, 98, 0, 0, 76, 0, 0]))).toEqual({ mediaType: 'image/webp', width: 99, height: 77 })
    for (const bytes of [
      new Uint8Array(0), bytesOf('<svg xmlns="http://www.w3.org/2000/svg"/>'), bytesOf('%PDF-1.7'), png().subarray(0, 20),
      bytesOf([0xff, 0xd8, 0xff, 0xd9]), bytesOf([0xff, 0xd8, 0xff, 0xda, 0, 8]), bytesOf('GIF89a', [1]), png(0, 10),
      riff('VP8 ', [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), bytesOf('RIFF', [0, 0, 0, 0], 'WAVEfmt ', Array.from({ length: 18 }, () => 0)),
    ]) expect(problem(bytes)).toBe('415 image_invalid')
    expect(problem(png(16384, 2441))).toBe('valid')
    for (const [width, height] of [[16385, 1], [1, 16385], [6400, 6400]]) expect(problem(png(width, height))).toBe('422 image_dimensions_too_large')
  })

  test('GIF sizes include the first frame that browsers make room for', () => {
    const control = [0x21, 0xf9, 0x04, 0, 0, 0, 0, 0], comment = [0x21, 0xfe, 0x05, ...Array.from('hello', c => c.charCodeAt(0)), 0]
    expect(imageFormat(gif([10, 8], [0, 0, 10, 8], [...control, ...comment]))).toEqual({ mediaType: 'image/gif', width: 10, height: 8 })
    expect(imageFormat(gif([10, 8], [5, 6, 20, 4]))).toEqual({ mediaType: 'image/gif', width: 25, height: 10 })
    expect(problem(gif([1, 1], [30000, 30000, 1, 1]))).toBe('422 image_dimensions_too_large')
    for (const bytes of [bytesOf('GIF89a', [1, 0, 1, 0, 0, 0, 0, 0x3b]), gif().subarray(0, 20), gif([1, 1], [0, 0, 1, 1], [0x21, 0xfe, 0xff])]) {
      expect(problem(bytes)).toBe('415 image_invalid')
    }
  })

  test('header scans are bounded, like the backend', () => {
    const restart = [0xff, 0xd0]
    expect(problem(jpeg(repeated(restart, 9_000)))).toBe('valid')
    expect(problem(jpeg(concat(repeated([0xff], 500_000), [0xe1, 0x00, 0x02])))).toBe('valid')
    const application = concat([0xff, 0xe1, 0xff, 0xff], new Uint8Array(65533))
    const applications = (times: number) => concat(...Array.from({ length: times }, () => application))
    expect(problem(jpeg(applications(15)))).toBe('valid')
    for (const bytes of [
      jpeg(repeated(restart, 10_001)), jpeg(applications(17)), concat([0xff, 0xd8], repeated([0xff], 2 * 1024 * 1024)),
      gif([1, 1], [0, 0, 1, 1], [0x21, 0xfe, ...repeated([1, 0], 20_000), 0]),
    ]) expect(problem(bytes)).toBe('415 image_invalid')
  })

  test('names lose folders and control characters and take the format extension', () => {
    expect(uploadedImageName('../../Roof leak.HEIC', 'image/jpeg')).toBe('Roof leak.jpg')
    expect(uploadedImageName('C:\\captura\u202e.png', 'image/png')).toBe('captura.png')
    expect(uploadedImageName(' .png', 'image/gif')).toBe('image.gif')
    expect(uploadedImageName(`${'x'.repeat(300)}.png`, 'image/webp')).toBe(`${'x'.repeat(250)}.webp`)
  })
})

describe('uploads', () => {
  test('store the image, serve it inline to members and answer retries from the stored record', async () => {
    const bytes = png(640, 480, 100), uploadId = crypto.randomUUID()
    const created = await upload({ name: '../../Roof leak.PNG', bytes }, { uploadId })
    expect(created).toEqual({
      status: 201,
      body: {
        id: uploadId, url: `/api/actions/images/${uploadId}`, filename: 'Roof leak.png', media_type: 'image/png', size: bytes.length,
        width: 640, height: 480, created_at: NOW.toISOString(),
      },
    })
    expect(communityStore().images.at(-1)).toMatchObject({ author: OLIVIA, sha256: sha256Hex(bytes), scope: 'actions' })
    const served = await file(created.body.url)
    expect(served.status).toBe(200)
    expect(served.headers.get('Content-Type')).toBe('image/png')
    expect(served.headers.get('Content-Disposition')).toBe("inline; filename*=utf-8''Roof%20leak.png")
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(bytes)
    expect(await upload({ name: '../../Roof leak.PNG', bytes }, { uploadId })).toEqual(created)
    for (const retry of [
      { name: 'Roof leak.png', bytes: png(10, 10) }, { name: 'Other.png', bytes },
    ]) expect(await upload(retry, { uploadId })).toMatchObject({ status: 409, body: { code: 'image_upload_conflict' } })
    expect(await upload({ name: 'Roof leak.png', bytes }, { uploadId, scope: 'events' })).toMatchObject({ status: 409, body: { code: 'image_upload_conflict' } })
    await adminLogin()
    expect(await upload({ name: 'Roof leak.png', bytes }, { uploadId })).toMatchObject({ status: 409, body: { code: 'image_upload_conflict' } })
    expect(communityStore().images).toHaveLength(1)
  })

  test('refuse other formats, oversized images, bad requests and missing headers', async () => {
    expect(await upload({ name: 'logo.svg', bytes: bytesOf('<svg/>') })).toMatchObject({ status: 415, body: { code: 'image_invalid' } })
    expect(await upload({ name: 'huge.png', bytes: png(20000, 10) })).toMatchObject({ status: 422, body: { code: 'image_dimensions_too_large' } })
    expect(await upload({ name: 'heavy.png', bytes: png(10, 10, MAX_IMAGE_BYTES) })).toMatchObject({ status: 413, body: { code: 'image_too_large' } })
    expect(await upload(null)).toMatchObject({ status: 422, body: { code: 'invalid_request' } })
    expect(await upload({ name: 'a.png', bytes: png() }, { uploadId: 'not-a-uuid' })).toMatchObject({ status: 422, body: { code: 'invalid_request' } })
    expect(await upload({ name: 'a.png', bytes: png() }, { mutationHeader: false })).toMatchObject({ status: 403, body: { code: 'invalid_origin' } })
    expect(communityStore().images).toEqual([])
  })

  test('each section serves only its own images, under its feature switch', async () => {
    const action = (await upload({ name: 'a.png', bytes: png() })).body
    const event = (await upload({ name: 'e.png', bytes: png() }, { scope: 'events' })).body
    expect(event.url).toBe(`/api/events/images/${event.id}`)
    expect((await demoRequest('GET', `/api/events/images/${action.id}`)).body).toEqual({ code: 'image_not_found' })
    expect((await demoRequest('GET', `/api/actions/images/${event.id}`)).body).toEqual({ code: 'image_not_found' })
    expect(await demoRequest('GET', '/api/actions/images/nope')).toMatchObject({ status: 422, body: { code: 'invalid_request' } })
    coreStore().features.actions = false
    expect(await demoRequest('GET', action.url)).toMatchObject({ status: 404, body: { code: 'actions_disabled' } })
    expect(await upload({ name: 'a.png', bytes: png() })).toMatchObject({ status: 404, body: { code: 'actions_disabled' } })
    expect((await file(event.url)).status).toBe(200)
    coreStore().features.events = false
    expect(await demoRequest('GET', event.url)).toMatchObject({ status: 404, body: { code: 'events_disabled' } })
  })

  test('images share the storage quotas with the PDFs', async () => {
    const own = communityStore().attachments.find(item => item.author.user_id === 6 && item.purgedAt === null)
    if (!own) throw new Error('No PDF of the sample neighbor')
    const stored = () => communityStore().attachments.filter(item => item.author.user_id === 6 && item.purgedAt === null)
      .reduce((sum, item) => sum + item.size, 0)
    const bytes = png(10, 10, 100)
    own.size += USER_QUOTA_BYTES - stored() - bytes.length
    expect((await upload({ name: 'fits.png', bytes })).status).toBe(201)
    expect(await upload({ name: 'over.png', bytes })).toMatchObject({ status: 409, body: { code: 'action_storage_user_quota' } })
  })
})

describe('administration', () => {
  test('lists, shows and purges images, also while their section is off', async () => {
    const first = (await upload({ name: 'first.png', bytes: png(10, 10, 500) })).body
    await demoRequest('POST', '/api/auth/login', { body: { email: 'james.okafor@example.com', password: 'demo' } })
    const second = (await upload({ name: 'second.png', bytes: png(10, 10, 50) }, { scope: 'events' })).body
    communityStore().images[1].createdAt = new Date(NOW.getTime() + 1000).toISOString()
    for (const path of ['/api/admin/storage/images', `/api/admin/storage/images/${first.id}/file`]) {
      expect((await demoRequest('GET', path)).status, path).toBe(401)
    }
    await adminLogin()
    const page = (await demoRequest<StoredImagePage>('GET', '/api/admin/storage/images')).body
    expect(page).toMatchObject({ total: 2, page: 1, pages: 1 })
    expect(page.items.map(item => item.id)).toEqual([second.id, first.id])
    expect(page.items[1]).toEqual({ ...first, scope: 'actions', sha256: sha256Hex(png(10, 10, 500)), author: OLIVIA, purged_at: null })
    expect((await demoRequest<StoredImagePage>('GET', '/api/admin/storage/images?sort=largest')).body.items.map(item => item.id)).toEqual([first.id, second.id])
    expect((await demoRequest<StoredImagePage>('GET', '/api/admin/storage/images?user_id=6')).body.items.map(item => item.id)).toEqual([first.id])
    expect((await demoRequest('GET', '/api/admin/storage/images?sort=oldest')).status).toBe(422)
    const summary = (await demoRequest<StorageOut>('GET', '/api/admin/storage')).body
    expect(summary.community).toMatchObject({ image_files: 2, image_bytes: first.size + second.size })
    expect(summary.residents.find(row => row.user_id === 6)).toMatchObject({ image_files: 1, image_bytes: first.size })
    coreStore().features.actions = false
    expect((await file(`/api/admin/storage/images/${first.id}/file`)).headers.get('Content-Type')).toBe('image/png')
    const purged = await demoRequest<StoredImageOut>('POST', `/api/admin/storage/images/${first.id}/purge`)
    expect(purged).toMatchObject({ status: 200, body: { id: first.id, purged_at: NOW.toISOString() } })
    expect(await demoRequest('POST', `/api/admin/storage/images/${first.id}/purge`)).toEqual({ ...purged, headers: expect.any(Headers) })
    expect(await demoRequest('GET', `/api/admin/storage/images/${first.id}/file`)).toMatchObject({ status: 410, body: { code: 'image_purged' } })
    coreStore().features.actions = true
    await adminLogout()
    expect(await demoRequest('GET', first.url)).toMatchObject({ status: 410, body: { code: 'image_purged' } })
    await adminLogin()
    expect((await demoRequest<StoredImagePage>('GET', '/api/admin/storage/images')).body.total).toBe(1)
    expect((await demoRequest<StorageOut>('GET', '/api/admin/storage')).body.community.image_bytes).toBe(second.size)
    expect(await demoRequest('POST', `/api/admin/storage/images/${crypto.randomUUID()}/purge`)).toMatchObject({ status: 404, body: { code: 'image_not_found' } })
  })
})
