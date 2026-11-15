import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { ApiError } from './api/client'
import type { DocumentLimitsOut } from './api/schema.gen'
import { extensionOf, localProblem, uploadDocument } from './document-upload'

const KiB = 1024, MiB = 1024 * KiB

type Sent = { method: string; path: string; offset: number | null; bytes: number | null; headers: HeadersInit | undefined }
type Override = (request: Sent) => Response | undefined

let sent: Sent[] = []
let stored = 0
let clock = 0
// Bytes per second of the simulated connection: each chunk moves the clock forward.
let speed = 512 * KiB

function reply(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status })
}

function server(size: number, override: Override = () => undefined) {
  const status = () => ({
    id: 'upload-1', name: 'plan.pdf', size, received: stored, folder_id: null, document_id: null,
    expires_at: '2026-03-02T10:00:00Z',
  })
  vi.stubGlobal('fetch', vi.fn(async (input: string, options: RequestInit = {}) => {
    const url = new URL(input, 'https://juntia.test')
    const body = options.body instanceof Blob ? options.body : null
    const request: Sent = {
      method: options.method ?? 'GET', path: url.pathname, offset: url.searchParams.has('offset') ? Number(url.searchParams.get('offset')) : null,
      bytes: body?.size ?? null, headers: options.headers,
    }
    sent.push(request)
    const replaced = override(request)
    if (replaced) return replaced
    if (request.method === 'PUT' && body) {
      if (request.offset !== stored) return reply({ code: 'document_upload_offset' }, 409)
      clock += body.size / speed * 1000
      stored += body.size
      return reply(status())
    }
    if (request.path.endsWith('/complete')) return reply({ id: 9, name: 'plan.pdf' })
    if (request.method === 'POST' || request.method === 'GET') return reply(status())
    throw new Error(`Unexpected request: ${request.method} ${input}`)
  }))
}

function file(size: number, name = 'plan.pdf') {
  return new File([new Uint8Array(size)], name, { type: 'application/pdf' })
}

function chunks() {
  return sent.filter(request => request.method === 'PUT').map(request => [request.offset, request.bytes])
}

const sleep = vi.fn(async () => undefined)
const upload = (size: number, chunkBytes = 4 * MiB) => uploadDocument({
  file: file(size), uploadId: 'upload-1', target: { folderId: 3 }, chunkBytes, sleep, now: () => clock,
})

beforeEach(() => {
  sent = []
  stored = 0
  clock = 0
  speed = 512 * KiB
  sleep.mockClear()
})
afterEach(() => {
  vi.unstubAllGlobals()
})

test('files go up in raw chunks sized to take a few seconds each and are completed at the end', async () => {
  server(5 * MiB + 100)
  const progress = vi.fn()
  const result = await uploadDocument({
    file: file(5 * MiB + 100), uploadId: 'upload-1', target: { folderId: 3 }, chunkBytes: 4 * MiB,
    progress, sleep, now: () => clock,
  })
  expect(result).toEqual({ id: 9, name: 'plan.pdf' })
  expect(sent[0]).toMatchObject({ method: 'POST', path: '/api/documents/uploads' })
  // 1 MiB first; at 512 KiB/s the next chunk takes six seconds; the rest is what is left.
  expect(chunks()).toEqual([[0, MiB], [MiB, 3 * MiB], [4 * MiB, MiB + 100]])
  expect(sent.find(request => request.method === 'PUT')?.headers).toEqual({
    'X-Juntia-Request': '1', 'Content-Type': 'application/octet-stream',
  })
  expect(sent.at(-1)).toMatchObject({ method: 'POST', path: '/api/documents/uploads/upload-1/complete' })
  expect(progress.mock.calls).toEqual([[0], [MiB], [4 * MiB], [5 * MiB + 100]])
  expect(sleep).not.toHaveBeenCalled()
})

test('chunks never exceed the server limit nor shrink below 256 KiB', async () => {
  speed = 64 * MiB
  server(9 * MiB)
  await upload(9 * MiB, 2 * MiB)
  expect(chunks()).toEqual([[0, MiB], [MiB, 2 * MiB], [3 * MiB, 2 * MiB], [5 * MiB, 2 * MiB], [7 * MiB, 2 * MiB]])
  sent = []; stored = 0; speed = 8 * KiB
  server(2 * MiB)
  await upload(2 * MiB)
  expect(chunks()).toEqual([[0, MiB], [MiB, 256 * KiB], [1280 * KiB, 256 * KiB], [1536 * KiB, 256 * KiB], [1792 * KiB, 256 * KiB]])
})

test('an interrupted upload continues from the bytes the server already has', async () => {
  // A previous attempt stored 2 MiB; then a response is lost after the server kept the chunk.
  stored = 2 * MiB
  let lost = false
  server(4 * MiB, request => {
    if (request.method !== 'PUT' || lost) return undefined
    lost = true
    stored += request.bytes ?? 0
    return reply({ code: 'bad_gateway' }, 502)
  })
  await upload(4 * MiB)
  expect(chunks()).toEqual([[2 * MiB, MiB], [3 * MiB, MiB]])
  expect(sent.map(request => request.method)).toEqual(['POST', 'PUT', 'GET', 'PUT', 'POST'])
  expect(sleep).toHaveBeenCalledOnce()
})

test('a chunk the server already received resumes from its offset without waiting', async () => {
  let duplicate = false
  server(2 * MiB, request => {
    if (request.method !== 'PUT' || duplicate) return undefined
    // Another request carrying the same bytes arrived first.
    duplicate = true
    stored = MiB
    return reply({ code: 'document_upload_offset' }, 409)
  })
  await upload(2 * MiB)
  expect(chunks()).toEqual([[0, MiB], [MiB, MiB]])
  expect(sent.map(request => request.method)).toEqual(['POST', 'PUT', 'GET', 'PUT', 'POST'])
  expect(sleep).not.toHaveBeenCalled()
})

test('a timeout halves the next chunk and a discarded upload starts again from the beginning', async () => {
  let timedOut = false, forgotten = false
  server(2 * MiB, request => {
    if (request.method !== 'PUT') return undefined
    if (!timedOut) { timedOut = true; return reply({ code: 'request_timeout' }, 408) }
    if (!forgotten && request.offset === 512 * KiB) {
      forgotten = true
      stored = 0
      return reply({ code: 'document_upload_not_found' }, 404)
    }
    return undefined
  })
  await upload(2 * MiB)
  expect(chunks().slice(0, 4)).toEqual([[0, MiB], [0, 512 * KiB], [512 * KiB, expect.any(Number)], [0, expect.any(Number)]])
  expect(sent.filter(request => request.method === 'POST' && request.path === '/api/documents/uploads')).toHaveLength(2)
  expect(stored).toBe(2 * MiB)
})

test('refusals are final and repeated connection failures give up', async () => {
  server(MiB, request => request.path.endsWith('/complete') ? reply({ code: 'document_type_mismatch' }, 415) : undefined)
  const refused = await upload(MiB).catch((error: unknown) => error)
  expect(refused).toBeInstanceOf(ApiError)
  expect(refused).toMatchObject({ code: 'document_type_mismatch', status: 415 })
  expect(sent.filter(request => request.path.endsWith('/complete'))).toHaveLength(1)

  sent = []; stored = 0
  server(MiB, request => request.method === 'PUT' ? reply({ code: 'service_unavailable' }, 503) : undefined)
  const unavailable = await upload(MiB).catch((error: unknown) => error)
  expect(unavailable).toMatchObject({ status: 503 })
  expect(chunks()).toHaveLength(6)
  expect(sleep.mock.calls.map(call => (call as unknown[])[0])).toEqual([1000, 2000, 4000, 8000, 16000].map(wait => Math.min(wait, 15_000)))
})

test('files the server would refuse are recognised before sending anything', () => {
  const limits = {
    extensions: ['pdf', 'txt', 'mp4', 'mov'], video_extensions: ['mp4', 'mov'],
    max_file_bytes: 10 * MiB, max_video_bytes: 100 * MiB,
  } as DocumentLimitsOut
  const sized = (name: string, size: number) => {
    const value = file(0, name)
    Object.defineProperty(value, 'size', { value: size })
    return value
  }
  expect(extensionOf('Acta Junta.2024.PDF')).toBe('pdf')
  expect(extensionOf('.env')).toBe('')
  expect(extensionOf('README')).toBe('')
  expect(localProblem(sized('macro.docm', 10), limits)).toBe('unsupported')
  expect(localProblem(sized('script', 10), limits)).toBe('unsupported')
  expect(localProblem(sized('blank.txt', 0), limits)).toBe('empty')
  expect(localProblem(sized('scan.pdf', 10 * MiB + 1), limits)).toBe('too_large')
  expect(localProblem(sized('IMG_0001.MOV', 50 * MiB), limits)).toBeUndefined()
  expect(localProblem(sized('IMG_0002.mov', 100 * MiB + 1), limits)).toBe('too_large')
})
