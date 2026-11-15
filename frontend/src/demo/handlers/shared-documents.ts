/**
 * Shared documents routes of the demo API (src/juntia/community_documents.py): folders and files
 * with their details, edits, deletions and history, chunked uploads, downloads, previews and ZIP
 * archives for every member while Documents is on (404 `documents_disabled` otherwise); and the
 * administrator's deleted documents (restore and purge), copies of any stored version and the
 * management policy, which keep working while the feature is off.
 */
import type { ActorOut, DocumentDeletionPage, DocumentSettings } from '../../api/schema.gen'
import {
  DemoApiError, HttpResponse, actorOf, fileDisposition, http, idParam, nowIso, pageParam, paginate, parseBody, queryInt, readJson,
  route, type Body, type HttpHandler, type RouteContext,
} from '../core'
import { canonicalUuid } from '../store/community-text'
import {
  CHUNK_BYTES, DOCUMENT_PAGE_SIZE, DOCUMENT_POLICIES, activeDocument, activeFolder, browse, cancelUpload, completeUpload, createFolder,
  deleteDocument, deleteFolder, deletionOut, documentArchive, documentInfo, documentOut, editDocument, editFolder, findDocument,
  findFolder, folderInfo, folderOut, folderTree, historyPage, openDeletions, ownUpload, purgeDeletion, receiveChunk, restoreDeletion,
  sharedDocumentsStore, startUpload, uploadOut, versionFile, type DemoDocument, type DemoDocumentFolder, type ItemEdit,
  type SharedDocumentsState, type UploadInput, type VersionFile,
} from '../store/shared-documents'
import { MODEL, uuidParam, valid, version } from './community-contracts'

const DOCUMENTS = { feature: 'documents' } as const

function author({ identity }: RouteContext): ActorOut {
  if (!identity) throw new DemoApiError('authentication_required', 401)
  return actorOf(identity)
}

/** `DocumentFolderIn`. */
function folderInput(body: Body): { name: string; parentId: number | null } {
  return { name: body.text('name', { min: 1, max: 1000 }), parentId: body.optionalInt('parent_id') }
}

/** `DocumentItemEdit`: `folder_id` moves the item (null: to the top level) only when the body has it. */
function itemEdit(body: Body): ItemEdit {
  const edit: ItemEdit = { version: version(body), name: body.optionalText('name', { min: 1, max: 1000 }) }
  if (body.present.has('folder_id')) edit.folderId = body.optionalInt('folder_id')
  return edit
}

const UPLOAD_FIELDS = ['upload_id', 'name', 'size', 'folder_id', 'document_id']

/** `DocumentUploadIn`: a new file in a folder, or a new version of a document, not both. */
function uploadInput(body: Body): UploadInput {
  const raw = body.raw('upload_id')
  const uploadId = typeof raw === 'string' ? canonicalUuid(raw) : null
  if (uploadId === null) body.fail('upload_id', raw === undefined ? 'missing' : 'uuid_parsing')
  const input: UploadInput = {
    uploadId: uploadId ?? '', name: body.text('name', { min: 1, max: 1000 }), size: body.int('size', { min: 0, max: Number.MAX_SAFE_INTEGER }),
    folderId: body.optionalInt('folder_id'), documentId: body.optionalInt('document_id'),
  }
  if (valid(body, UPLOAD_FIELDS) && input.folderId !== null && input.documentId !== null) body.fail(MODEL, 'value_error')
  return input
}

/** Repeated integer query parameter whose range the route checks itself (`list[int]`). */
function queryIdList(url: URL, name: string): number[] {
  return url.searchParams.getAll(name).map(raw => {
    if (!/^\s*[+-]?\d+\s*$/.test(raw)) throw new DemoApiError('invalid_request', 422)
    return Number(raw)
  })
}

/** A single `bytes=` range as Starlette reads it: the range, `unsatisfiable`, or null to send the whole file. */
function byteRange(header: string | null, size: number): [number, number] | 'unsatisfiable' | null {
  const match = header === null ? null : /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(header)
  if (!match || (match[1] === '' && match[2] === '')) return null
  const [, first, last] = match
  const start = first === '' ? Math.max(size - Number(last), 0) : Number(first)
  const end = first !== '' && last !== '' && Number(last) < size ? Number(last) + 1 : size
  if (start >= size) return 'unsatisfiable'
  return start < end ? [start, end] : null
}

/** A stored file like the backend's FileResponse: a single byte range is answered with 206, so videos can be sought. */
function fileResponse(request: Request, file: VersionFile, disposition: 'attachment' | 'inline'): Response {
  const headers = { 'Content-Type': file.mediaType, 'Content-Disposition': fileDisposition(disposition, file.filename), 'Accept-Ranges': 'bytes' }
  const range = byteRange(request.headers.get('Range'), file.bytes.length)
  if (range === 'unsatisfiable') return new HttpResponse(null, { status: 416, headers: { 'Content-Range': `bytes */${file.bytes.length}` } })
  if (range === null) return new HttpResponse(file.bytes.slice(), { headers })
  const [start, end] = range
  return new HttpResponse(file.bytes.slice(start, end), {
    status: 206, headers: { ...headers, 'Content-Range': `bytes ${start}-${end - 1}/${file.bytes.length}` },
  })
}

function download(context: RouteContext, disposition: 'attachment' | 'inline', options: { deleted?: boolean } = {}): Response {
  const file = versionFile(sharedDocumentsStore(), uuidParam(context.params, 'versionId'), disposition, options)
  return fileResponse(context.request, file, disposition)
}

/** Any folder, deleted ones included (the administrator's history). */
function anyFolder(documents: SharedDocumentsState, id: number): DemoDocumentFolder {
  const folder = findFolder(documents, id)
  if (!folder) throw new DemoApiError('document_folder_not_found', 404)
  return folder
}

/** Any file, deleted ones included (the administrator's details and history). */
function anyDocument(documents: SharedDocumentsState, id: number): DemoDocument {
  const document = findDocument(documents, id)
  if (!document) throw new DemoApiError('document_not_found', 404)
  return document
}

const residentHandlers: HttpHandler[] = [
  http.get('/api/documents/browse', route('session', context => browse(sharedDocumentsStore(), queryInt(context.url, 'folder'), author(context)), DOCUMENTS)),
  http.get('/api/documents/folders', route('session', () => folderTree(sharedDocumentsStore()), DOCUMENTS)),
  http.post('/api/documents/folders', route('session', async context => {
    const input = parseBody(await readJson(context.request), folderInput)
    const documents = sharedDocumentsStore(), actor = author(context)
    return folderOut(documents, createFolder(documents, actor, input.name, input.parentId, nowIso()), actor)
  }, { ...DOCUMENTS, status: 201 })),
  http.get('/api/documents/folders/:folderId', route('session', context => {
    const documents = sharedDocumentsStore()
    return folderInfo(documents, activeFolder(documents, idParam(context.params, 'folderId')), author(context))
  }, DOCUMENTS)),
  http.patch('/api/documents/folders/:folderId', route('session', async context => {
    const folderId = idParam(context.params, 'folderId')
    const edit = parseBody(await readJson(context.request), itemEdit)
    const documents = sharedDocumentsStore(), actor = author(context)
    return folderOut(documents, editFolder(documents, actor, folderId, edit, nowIso()), actor)
  }, DOCUMENTS)),
  http.delete('/api/documents/folders/:folderId', route('session', async context => {
    const folderId = idParam(context.params, 'folderId')
    const expected = parseBody(await readJson(context.request), version)
    deleteFolder(sharedDocumentsStore(), author(context), folderId, expected, nowIso())
  }, { ...DOCUMENTS, status: 204 })),
  http.get('/api/documents/folders/:folderId/history', route('session', ({ params, url }) => {
    const folderId = idParam(params, 'folderId'), page = pageParam(url)
    const documents = sharedDocumentsStore()
    return historyPage(documents, activeFolder(documents, folderId), page)
  }, DOCUMENTS)),
  http.get('/api/documents/files/:documentId', route('session', context => {
    const documents = sharedDocumentsStore()
    return documentInfo(documents, activeDocument(documents, idParam(context.params, 'documentId')), author(context))
  }, DOCUMENTS)),
  http.patch('/api/documents/files/:documentId', route('session', async context => {
    const documentId = idParam(context.params, 'documentId')
    const edit = parseBody(await readJson(context.request), itemEdit)
    const documents = sharedDocumentsStore(), actor = author(context)
    return documentOut(documents, editDocument(documents, actor, documentId, edit, nowIso()), actor)
  }, DOCUMENTS)),
  http.delete('/api/documents/files/:documentId', route('session', async context => {
    const documentId = idParam(context.params, 'documentId')
    const expected = parseBody(await readJson(context.request), version)
    deleteDocument(sharedDocumentsStore(), author(context), documentId, expected, nowIso())
  }, { ...DOCUMENTS, status: 204 })),
  http.get('/api/documents/files/:documentId/history', route('session', ({ params, url }) => {
    const documentId = idParam(params, 'documentId'), page = pageParam(url)
    const documents = sharedDocumentsStore()
    return historyPage(documents, activeDocument(documents, documentId), page)
  }, DOCUMENTS)),
  http.get('/api/documents/versions/:versionId/download', route('session', context => download(context, 'attachment'), DOCUMENTS)),
  // PDFs, pictures and videos, in a new tab; videos can be sought.
  http.get('/api/documents/versions/:versionId/preview', route('session', context => download(context, 'inline'), DOCUMENTS)),
  http.get('/api/documents/archive', route('session', ({ url }) => {
    const { filename, bytes } = documentArchive(sharedDocumentsStore(), queryIdList(url, 'folder'), queryIdList(url, 'file'))
    return new HttpResponse(bytes, { headers: { 'Content-Type': 'application/zip', 'Content-Disposition': fileDisposition('attachment', filename) } })
  }, DOCUMENTS)),
  http.post('/api/documents/uploads', route('session', async context => {
    const input = parseBody(await readJson(context.request), uploadInput)
    return uploadOut(startUpload(sharedDocumentsStore(), author(context), input, nowIso()))
  }, { ...DOCUMENTS, status: 201 })),
  // How much of an upload arrived, to resume it after an interruption.
  http.get('/api/documents/uploads/:uploadId', route('session', context =>
    uploadOut(ownUpload(sharedDocumentsStore(), author(context), uuidParam(context.params, 'uploadId'), nowIso())), DOCUMENTS)),
  http.put('/api/documents/uploads/:uploadId/content', route('session', async context => {
    const uploadId = uuidParam(context.params, 'uploadId')
    const offset = queryInt(context.url, 'offset', { min: 0, max: Number.MAX_SAFE_INTEGER })
    if (offset === null) throw new DemoApiError('invalid_request', 422)
    const data = new Uint8Array(await context.request.arrayBuffer())
    // The server's body limit of the chunks' route.
    if (data.length > CHUNK_BYTES) throw new DemoApiError('request_too_large', 413)
    if (data.length === 0) throw new DemoApiError('document_upload_size', 422)
    return uploadOut(receiveChunk(sharedDocumentsStore(), author(context), uploadId, offset, data, nowIso()))
  }, DOCUMENTS)),
  http.delete('/api/documents/uploads/:uploadId', route('session', context => {
    cancelUpload(sharedDocumentsStore(), author(context), uuidParam(context.params, 'uploadId'))
  }, { ...DOCUMENTS, status: 204 })),
  http.post('/api/documents/uploads/:uploadId/complete', route('session', async context => {
    const uploadId = uuidParam(context.params, 'uploadId')
    const documents = sharedDocumentsStore(), actor = author(context)
    return documentOut(documents, await completeUpload(documents, actor, uploadId, nowIso()), actor)
  }, DOCUMENTS)),
]

const administrationHandlers: HttpHandler[] = [
  // What residents deleted and the administrator can still restore or purge, newest first.
  http.get('/api/admin/documents/deleted', route('admin', ({ url }): DocumentDeletionPage => {
    const page = pageParam(url)
    const documents = sharedDocumentsStore()
    const { items, ...info } = paginate(openDeletions(documents), page, DOCUMENT_PAGE_SIZE)
    return { ...info, items: items.map(deletion => deletionOut(documents, deletion)) }
  })),
  http.get('/api/admin/documents/files/:documentId', route('admin', context => {
    const documents = sharedDocumentsStore()
    return documentInfo(documents, anyDocument(documents, idParam(context.params, 'documentId')), author(context))
  })),
  http.get('/api/admin/documents/files/:documentId/history', route('admin', ({ params, url }) => {
    const documentId = idParam(params, 'documentId'), page = pageParam(url)
    const documents = sharedDocumentsStore()
    return historyPage(documents, anyDocument(documents, documentId), page)
  })),
  http.get('/api/admin/documents/folders/:folderId/history', route('admin', ({ params, url }) => {
    const folderId = idParam(params, 'folderId'), page = pageParam(url)
    const documents = sharedDocumentsStore()
    return historyPage(documents, anyFolder(documents, folderId), page)
  })),
  // The administrator's copy of any stored version, deleted documents' included.
  http.get('/api/admin/documents/versions/:versionId/download', route('admin', context => download(context, 'attachment', { deleted: true }))),
  http.post('/api/admin/documents/deletions/:deletionId/restore', route('admin', context => {
    restoreDeletion(sharedDocumentsStore(), author(context), uuidParam(context.params, 'deletionId'), nowIso())
  }, { status: 204 })),
  http.post('/api/admin/documents/deletions/:deletionId/purge', route('admin', context => {
    purgeDeletion(sharedDocumentsStore(), author(context), uuidParam(context.params, 'deletionId'), nowIso())
  }, { status: 204 })),
  http.get('/api/admin/settings/documents', route('admin', (): DocumentSettings => ({ manage_policy: sharedDocumentsStore().policy }))),
  http.patch('/api/admin/settings/documents', route('admin', async ({ request }): Promise<DocumentSettings> => {
    const policy = parseBody(await readJson(request), body => body.literal('manage_policy', DOCUMENT_POLICIES))
    const documents = sharedDocumentsStore()
    documents.policy = policy
    return { manage_policy: documents.policy }
  })),
]

export const sharedDocumentHandlers: HttpHandler[] = [...residentHandlers, ...administrationHandlers]
