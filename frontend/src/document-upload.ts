import { useSyncExternalStore } from 'react'
import { ApiError, api, cache } from './api/client'
import type { DocumentLimitsOut, DocumentOut, DocumentUploadIn, DocumentUploadOut } from './api/schema.gen'
import { createUploadId } from './community-action-shared'

// Shared documents are sent in chunks: the server must receive each request within 30 seconds and
// proxies often refuse large bodies, while phone videos can take a gigabyte. Chunks grow or shrink
// so that each takes a few seconds, and an interrupted upload resumes where the server stopped.
export const MIN_CHUNK_BYTES = 256 * 1024
const FIRST_CHUNK_BYTES = 1024 * 1024
const TARGET_SECONDS = 6
const MAX_FAILURES = 6

export type UploadTarget = { folderId: number | null } | { documentId: number }
export type UploadOptions = {
  file: Blob & { name: string }
  uploadId: string
  target: UploadTarget
  chunkBytes: number
  progress?: (sent: number) => void
  signal?: AbortSignal
  now?: () => number
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>
}

function pause(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve() }, milliseconds)
    function abort() { clearTimeout(timer); reject(signal?.reason) }
    signal?.addEventListener('abort', abort, { once: true })
  })
}

/** Lost connections and an overloaded server are worth another attempt; anything else is final. */
function transient(error: unknown): boolean {
  if (error instanceof ApiError) return error.status === 408 || error.status === 502 || error.status === 503 || error.status === 504
  return error instanceof TypeError
}

function nextChunk(bytes: number, seconds: number, limit: number): number {
  const speed = bytes / Math.max(seconds, 0.05)
  const target = Math.floor(speed * TARGET_SECONDS / 65536) * 65536
  return Math.max(MIN_CHUNK_BYTES, Math.min(limit, target))
}

export async function uploadDocument(options: UploadOptions): Promise<DocumentOut> {
  const { file, uploadId, target, progress, signal } = options
  const now = options.now ?? (() => performance.now()), sleep = options.sleep ?? pause
  const limit = Math.max(MIN_CHUNK_BYTES, options.chunkBytes)
  const body: DocumentUploadIn = 'documentId' in target
    ? { upload_id: uploadId, name: file.name, size: file.size, document_id: target.documentId }
    : { upload_id: uploadId, name: file.name, size: file.size, folder_id: target.folderId }
  // Only a stored chunk resets this: checking the status after a failure is not progress.
  let failures = 0
  async function attempt<T>(request: () => Promise<T>): Promise<T> {
    for (;;) {
      try {
        return await request()
      } catch (error) {
        if (signal?.aborted || !transient(error) || ++failures >= MAX_FAILURES) throw error
        await sleep(Math.min(1000 * 2 ** (failures - 1), 15_000), signal)
      }
    }
  }
  const start = () => attempt(() => api<DocumentUploadOut>('/documents/uploads', 'POST', body, signal))
  let offset = (await start()).received
  let size = Math.min(FIRST_CHUNK_BYTES, limit)
  progress?.(offset)
  while (offset < file.size) {
    const end = Math.min(file.size, offset + size), started = now()
    try {
      const status = await api<DocumentUploadOut>(
        `/documents/uploads/${uploadId}/content?offset=${offset}`, 'PUT', file.slice(offset, end), signal,
      )
      size = nextChunk(status.received - offset, (now() - started) / 1000, limit)
      offset = status.received
      failures = 0
      progress?.(offset)
    } catch (error) {
      if (signal?.aborted) throw error
      if (error instanceof ApiError && error.code === 'document_upload_offset') {
        // Another attempt already stored these bytes: continue from what the server has.
        if (++failures >= MAX_FAILURES) throw error
        offset = (await attempt(() => api<DocumentUploadOut>(`/documents/uploads/${uploadId}`, 'GET', undefined, signal))).received
      } else if (error instanceof ApiError && error.code === 'document_upload_not_found') {
        // Expired or replaced by newer uploads: start this one again from the beginning.
        if (++failures >= MAX_FAILURES) throw error
        offset = (await start()).received
      } else if (transient(error)) {
        if (++failures >= MAX_FAILURES) throw error
        // A timeout means the connection is slower than measured: send less at a time.
        if (error instanceof ApiError && error.status === 408) size = Math.max(MIN_CHUNK_BYTES, Math.floor(size / 2))
        await sleep(Math.min(1000 * 2 ** (failures - 1), 15_000), signal)
        offset = (await attempt(() => api<DocumentUploadOut>(`/documents/uploads/${uploadId}`, 'GET', undefined, signal))).received
      } else throw error
      progress?.(offset)
    }
  }
  return attempt(() => api<DocumentOut>(`/documents/uploads/${uploadId}/complete`, 'POST', undefined, signal))
}

export type UploadState = 'waiting' | 'uploading' | 'checking' | 'done' | 'failed' | 'cancelled'
// Refused before sending anything: the server would refuse it too.
export type LocalProblem = 'unsupported' | 'empty' | 'too_large'
export type UploadEntry = {
  key: string
  uploadId: string
  file: File
  target: UploadTarget
  // Where it goes, for the queue: a folder name or the document receiving a new version.
  destination: string
  chunkBytes: number
  state: UploadState
  sent: number
  error?: unknown
  problem?: LocalProblem
  // The size limit for this kind of file, to explain a 'too_large' problem.
  limitBytes: number
  result?: DocumentOut
  controller?: AbortController
}

let entries: UploadEntry[] = []
let running = false
// Whose uploads these are: the queue is emptied when someone else signs in on this browser.
let owner = ''
const listeners = new Set<() => void>()

function publish(next: UploadEntry[]) {
  entries = next
  const busy = entries.some(entry => entry.state === 'waiting' || entry.state === 'uploading' || entry.state === 'checking')
  if (typeof window !== 'undefined') {
    window.removeEventListener('beforeunload', warnBeforeLeaving)
    if (busy) window.addEventListener('beforeunload', warnBeforeLeaving)
  }
  listeners.forEach(listener => listener())
}

function warnBeforeLeaving(event: BeforeUnloadEvent) {
  event.preventDefault()
}

function update(key: string, change: Partial<UploadEntry>) {
  publish(entries.map(entry => entry.key === key ? { ...entry, ...change } : entry))
}

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

export function localProblem(file: File, limits: DocumentLimitsOut): LocalProblem | undefined {
  const extension = extensionOf(file.name)
  if (!limits.extensions.includes(extension)) return 'unsupported'
  if (file.size === 0) return 'empty'
  const limit = limits.video_extensions.includes(extension) ? limits.max_video_bytes : limits.max_file_bytes
  return file.size > limit ? 'too_large' : undefined
}

async function work() {
  if (running) return
  running = true
  try {
    for (let entry = entries.find(item => item.state === 'waiting'); entry; entry = entries.find(item => item.state === 'waiting')) {
      const key = entry.key, controller = new AbortController()
      update(key, { state: 'uploading', controller, error: undefined })
      try {
        const result = await uploadDocument({
          file: entry.file, uploadId: entry.uploadId, target: entry.target, chunkBytes: entry.chunkBytes,
          signal: controller.signal, progress: sent => update(key, {
            sent, state: sent >= entry.file.size ? 'checking' : 'uploading',
          }),
        })
        update(key, { state: 'done', sent: entry.file.size, result, controller: undefined })
        void cache.invalidateQueries({ queryKey: ['documents'] })
      } catch (error) {
        if (controller.signal.aborted) continue
        update(key, { state: 'failed', error, controller: undefined })
      }
    }
  } finally {
    running = false
  }
}

export const uploads = {
  claim(identity: string) {
    if (identity === owner) return
    owner = identity
    uploads.reset()
  },
  add(files: File[], target: UploadTarget, destination: string, limits: DocumentLimitsOut) {
    publish([...entries, ...files.map(file => {
      const problem = localProblem(file, limits)
      const extension = extensionOf(file.name)
      return {
        key: createUploadId(), uploadId: createUploadId(), file, target, destination, chunkBytes: limits.chunk_bytes,
        state: problem ? 'failed' as const : 'waiting' as const, sent: 0, problem,
        limitBytes: limits.video_extensions.includes(extension) ? limits.max_video_bytes : limits.max_file_bytes,
      }
    })])
    void work()
  },
  retry(key: string) {
    // The same upload ID: the server keeps what it received and the upload resumes.
    update(key, { state: 'waiting', error: undefined })
    void work()
  },
  cancel(key: string) {
    const entry = entries.find(item => item.key === key)
    if (!entry) return
    entry.controller?.abort()
    update(key, { state: 'cancelled', controller: undefined })
    if (!entry.problem) {
      void api(`/documents/uploads/${entry.uploadId}`, 'DELETE').catch(() => {
        console.warn('A cancelled upload could not be discarded; the server removes it within a day.')
      })
    }
  },
  dismiss(key: string) {
    publish(entries.filter(entry => entry.key !== key))
  },
  clearFinished() {
    publish(entries.filter(entry => entry.state !== 'done' && entry.state !== 'cancelled'))
  },
  reset() {
    entries.forEach(entry => entry.controller?.abort())
    publish([])
  },
}

export function useUploads(): UploadEntry[] {
  return useSyncExternalStore(listener => {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  }, () => entries)
}
