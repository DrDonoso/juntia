/**
 * Shared documents (src/juntia/community_documents.py): folders and files that every member reads
 * and downloads, kept in memory with their bytes. Anyone adds folders and files; who may rename,
 * move, replace (upload a new version of) and delete an item follows the administrator's policy:
 * whoever created it, only the administrator, or everyone, and the administrator always may.
 * Deleting hides an item, and everything inside a folder, as one deletion that only the
 * administrator sees, restores or purges. Every item keeps a history of who created, uploaded,
 * renamed, moved, deleted, restored and purged it. Files arrive in resumable chunks of at most
 * 4 MiB, within the largest file and video sizes and the byte quotas the administrator sets.
 *
 * The handlers parse a request and call an operation, which checks the rest in the backend's
 * order. The data of a page load replays ../scenario/shared-documents.ts through the same
 * operations, so its history matches its data.
 */
import type {
  ActorOut, DocumentBrowseOut, DocumentDeletionOut, DocumentEventOut, DocumentFolderInfoOut, DocumentFolderOut,
  DocumentFolderRef, DocumentHistoryPage, DocumentInfoOut, DocumentLimitsOut, DocumentOut, DocumentSearchPage, DocumentSettings,
  DocumentTextFileOut, DocumentTextFilePage, DocumentTextOut, DocumentTextQueueOut, DocumentTextSummaryOut,
  DocumentTreeFolderOut, DocumentUploadOut, DocumentVersionOut,
} from '../../api/schema.gen'
import { DemoApiError } from '../core/errors'
import { IdSequence } from '../core/ids'
import { paginate } from '../core/pagination'
import { demoRandom, type Random } from '../core/random'
import { MAX_ID, characterCount } from '../core/validation'
import { zipArchive, type ZipEntry, type ZipTime } from '../core/zip'
import { sharedDocumentsScenario } from '../scenario/shared-documents'
import { actorOut, compareText } from './community-model'
import { sha256Hex } from './community-sha256'
import { foldText } from './community-text'
import { wallClock } from './community-time'
import {
  DOCUMENT_TYPES, VIDEO_EXTENSIONS, checkContent, checkedName, documentName, documentType, nameKey, numbered, uploadName,
  versionFilename, type DocumentKind,
} from './shared-document-files'
import { READABLE_EXTENSIONS, queuedText, readText, textExcerpt, type DemoText } from './shared-document-text'

export type DocumentPolicy = DocumentSettings['manage_policy']
export type DocumentEventKind = DocumentEventOut['kind']

const MIB = 1024 * 1024

/** `PAGE_SIZE` of the histories and of the deleted documents. */
export const DOCUMENT_PAGE_SIZE = 20

/** Largest chunk of an upload (`CHUNK_BYTES`). */
export const CHUNK_BYTES = 4 * MIB

/**
 * The settings of a new installation: who manages items, the largest file (videos excepted) and the
 * largest video, and the byte budgets of each resident author and of the community, in whole MiB.
 * Every stored version counts towards the budgets, current, earlier or deleted, until it is purged.
 */
export const DEFAULT_DOCUMENT_SETTINGS: Readonly<DocumentSettings> = {
  manage_policy: 'creator', max_file_mb: 50, max_video_mb: 1024, user_quota_mb: 2048, community_quota_mb: 20480,
}

/** The largest file or video limit the administrator may choose, 10 GiB: a single file always fits in a ZIP download. */
export const DOCUMENT_SIZE_LIMIT_MB = 10 * 1024

/** The largest quota the administrator may choose, 10 TiB. */
export const DOCUMENT_QUOTA_LIMIT_MB = 10 * 1024 * 1024

export const ARCHIVE_MAX_ITEMS = 100
export const ARCHIVE_MAX_FILES = 5000
export const ARCHIVE_MAX_BYTES = 10 * 1024 * MIB

export const DOCUMENT_POLICIES = ['creator', 'administrator', 'everyone'] as const satisfies readonly DocumentPolicy[]

const MAX_FOLDER_ITEMS = 1000
const MAX_DEPTH = 10
const MAX_OPEN_UPLOADS = 4
const UPLOAD_LIFETIME_MS = 24 * 3_600_000

export interface DemoDocumentFolder {
  id: number
  /** Null: at the top level of Documents. */
  parentId: number | null
  name: string
  author: ActorOut
  version: number
  createdAt: string
  updatedAt: string
  deletedAt: string | null
  /** The deletion that removed it, together with everything deleted at the same time. */
  deletionId: string | null
  purgedAt: string | null
}

export interface DemoDocument {
  id: number
  folderId: number | null
  name: string
  kind: DocumentKind
  /** Number of the version shown, downloaded and archived; versions are numbered from 1. */
  currentNumber: number
  /** Who uploaded the first version. */
  author: ActorOut
  version: number
  createdAt: string
  updatedAt: string
  deletedAt: string | null
  deletionId: string | null
  purgedAt: string | null
}

export interface DemoDocumentVersion {
  /** The upload id the browser chose (a UUID). */
  id: string
  documentId: number
  number: number
  extension: string
  mediaType: string
  size: number
  sha256: string
  /** The file; a purge deletes it (empty), while its size and fingerprint stay. */
  bytes: Uint8Array<ArrayBuffer>
  author: ActorOut
  createdAt: string
  purgedAt: string | null
  /**
   * What the search knows of its text (`document_texts`): null for videos and HEIC pictures, and
   * once a newer version replaces it or it is purged.
   */
  text: DemoText | null
}

/** One deletion: a file, or a folder with everything it held. The author deleted it. */
export interface DemoDocumentDeletion {
  id: string
  folderId: number | null
  documentId: number | null
  /** Snapshots taken when it was deleted: its name and the names of the folders above it. */
  name: string
  location: string[]
  author: ActorOut
  createdAt: string
  restoredAt: string | null
  purgedAt: string | null
}

/** The details that apply to each kind of history entry (the others are null in the API). */
export interface DocumentEventDetails {
  name?: string
  previous_name?: string
  /** Names of the folders above the item, from the top level. */
  location?: string[]
  previous_location?: string[]
  number?: number
  size?: number
  /** Deleted, restored or purged together with this folder. */
  folder?: string
}

export interface DemoDocumentEvent {
  id: number
  folderId: number | null
  documentId: number | null
  kind: DocumentEventKind
  author: ActorOut
  createdAt: string
  details: DocumentEventDetails
}

/** A file being received in chunks; it becomes a version when completed. */
export interface DemoDocumentUpload {
  /** The upload id the browser chose (a UUID). */
  id: string
  /** A new document in this folder (null: the top level), or a new version of `documentId`. */
  folderId: number | null
  documentId: number | null
  name: string
  extension: string
  size: number
  received: number
  chunks: Uint8Array<ArrayBuffer>[]
  author: ActorOut
  createdAt: string
  updatedAt: string
  /** A day after its last chunk. */
  expiresAt: string
  /** Order of the latest activity, for uploads active in the same instant. */
  activity: number
}

export interface SharedDocumentsState {
  /** The administrator's policy and limits, which apply at once to browsing, uploads and quotas. */
  settings: DocumentSettings
  folders: DemoDocumentFolder[]
  documents: DemoDocument[]
  versions: DemoDocumentVersion[]
  deletions: DemoDocumentDeletion[]
  events: DemoDocumentEvent[]
  uploads: DemoDocumentUpload[]
  sequences: { folder: IdSequence; document: IdSequence; event: IdSequence; activity: IdSequence }
  /** Ids of the deletions. */
  random: Random
}

type Item = DemoDocumentFolder | DemoDocument

/** A file of the scenario, uploaded under the id its browser chose. */
export interface ScenarioFile {
  uploadId: string
  name: string
  bytes: Uint8Array<ArrayBuffer>
}

/** One change of the scenario, made through the operations of the API; items are named by key. */
export type SharedDocumentChange =
  | { createFolder: string; name: string; parent?: string }
  | { upload: string; file: ScenarioFile; folder?: string }
  | { newVersion: string; file: ScenarioFile }
  | { rename: string; name: string }
  | { move: string; into: string | null }
  | { remove: string }

/** A dated change of the scenario, and who made it. */
export type SharedDocumentStep = { at: string; by: ActorOut } & SharedDocumentChange

let state: SharedDocumentsState | null = null

/** The shared documents of this page load, built from the scenario on first use. */
export function sharedDocumentsStore(): SharedDocumentsState {
  return (state ??= replaySharedDocuments(sharedDocumentsScenario()))
}

/** Back to the scenario (tests; a page reload does the same). */
export function resetSharedDocumentsStore(): void {
  state = null
}

// --- Lookups ---

function isFolder(item: Item): item is DemoDocumentFolder {
  return 'parentId' in item
}

function parentOf(item: Item): number | null {
  return isFolder(item) ? item.parentId : item.folderId
}

function owns(item: { author: ActorOut }, actor: ActorOut): boolean {
  return item.author.kind === actor.kind && item.author.user_id === actor.user_id
}

export function findFolder(documents: SharedDocumentsState, id: number): DemoDocumentFolder | undefined {
  return documents.folders.find(folder => folder.id === id)
}

export function findDocument(documents: SharedDocumentsState, id: number): DemoDocument | undefined {
  return documents.documents.find(document => document.id === id)
}

/** A folder residents can see (404 `document_folder_not_found` otherwise). */
export function activeFolder(documents: SharedDocumentsState, id: number): DemoDocumentFolder {
  const folder = findFolder(documents, id)
  if (!folder || folder.deletedAt !== null) throw new DemoApiError('document_folder_not_found', 404)
  return folder
}

/** A file residents can see (404 `document_not_found` otherwise). */
export function activeDocument(documents: SharedDocumentsState, id: number): DemoDocument {
  const document = findDocument(documents, id)
  if (!document || document.deletedAt !== null) throw new DemoApiError('document_not_found', 404)
  return document
}

export function currentVersion(documents: SharedDocumentsState, document: DemoDocument): DemoDocumentVersion {
  const version = documents.versions.find(item => item.documentId === document.id && item.number === document.currentNumber)
  if (!version) throw new Error(`The document ${document.id} has no current version`)
  return version
}

/** By name ignoring case and Unicode forms, then id: the order of every list. */
function byName<T extends Item>(items: T[]): T[] {
  return items.sort((a, b) => compareText(nameKey(a.name), nameKey(b.name)) || a.id - b.id)
}

function childFolders(documents: SharedDocumentsState, parentId: number | null): DemoDocumentFolder[] {
  return byName(documents.folders.filter(folder => folder.deletedAt === null && folder.parentId === parentId))
}

function folderFiles(documents: SharedDocumentsState, folderId: number | null): DemoDocument[] {
  return byName(documents.documents.filter(document => document.deletedAt === null && document.folderId === folderId))
}

/** The folder and the folders above it, from the top level down, through deleted folders too (`chain`). */
export function folderPath(documents: SharedDocumentsState, folderId: number | null): DemoDocumentFolder[] {
  const path: DemoDocumentFolder[] = []
  const seen = new Set<number>()
  for (let id = folderId; id !== null && !seen.has(id);) {
    seen.add(id)
    const folder = findFolder(documents, id)
    if (!folder) break
    path.unshift(folder)
    id = folder.parentId
  }
  return path
}

export function folderNames(folders: readonly DemoDocumentFolder[]): string[] {
  return folders.map(folder => folder.name)
}

function refs(folders: readonly DemoDocumentFolder[]): DocumentFolderRef[] {
  return folders.map(folder => ({ id: folder.id, name: folder.name }))
}

/** Name keys of a folder's active items, folders and files alike. */
function siblingKeys(documents: SharedDocumentsState, parentId: number | null, except?: Item): Set<string> {
  const folders = documents.folders.filter(folder => folder.deletedAt === null && folder.parentId === parentId && folder !== except)
  const files = documents.documents.filter(document => document.deletedAt === null && document.folderId === parentId && document !== except)
  return new Set([...folders, ...files].map(item => nameKey(item.name)))
}

function requireFreeName(documents: SharedDocumentsState, parentId: number | null, name: string, except?: Item): void {
  if (siblingKeys(documents, parentId, except).has(nameKey(name))) {
    throw new DemoApiError('document_name_taken', 409, { name: 'document_name_taken' })
  }
}

/** `free_name`: the name, or the first free `name (2)`, `name (3)`… among the folder's active items. */
function freeName(documents: SharedDocumentsState, parentId: number | null, name: string, extension: string | null): string {
  const taken = siblingKeys(documents, parentId)
  let candidate = name
  for (let number = 2; taken.has(nameKey(candidate)); number += 1) candidate = numbered(name, number, extension)
  return candidate
}

/** At most a thousand active items per folder (409 `document_folder_full`). */
function requireRoom(documents: SharedDocumentsState, parentId: number | null): void {
  const count = documents.folders.filter(folder => folder.deletedAt === null && folder.parentId === parentId).length
    + documents.documents.filter(document => document.deletedAt === null && document.folderId === parentId).length
  if (count >= MAX_FOLDER_ITEMS) throw new DemoApiError('document_folder_full', 409)
}

/** The folder and every active item inside it, and how many levels of folders it spans. */
function subtree(documents: SharedDocumentsState, root: DemoDocumentFolder): { folders: DemoDocumentFolder[]; files: DemoDocument[]; levels: number } {
  const folders = [root], files: DemoDocument[] = []
  let levels = 0
  for (let level = [root]; level.length > 0;) {
    levels += 1
    const ids = new Set(level.map(folder => folder.id))
    files.push(...documents.documents.filter(document => document.deletedAt === null && document.folderId !== null && ids.has(document.folderId)))
    level = documents.folders.filter(folder => folder.deletedAt === null && folder.parentId !== null && ids.has(folder.parentId))
    folders.push(...level)
  }
  return { folders, files, levels }
}

// --- Permissions ---

/** `may_manage`: rename, move, replace and delete, following the policy; the administrator always may. */
export function mayManage(item: { author: ActorOut }, actor: ActorOut, policy: DocumentPolicy): boolean {
  if (actor.kind === 'administrator' || policy === 'everyone') return true
  return policy === 'creator' && owns(item, actor)
}

function requireManage(item: { author: ActorOut }, actor: ActorOut, policy: DocumentPolicy): void {
  if (!mayManage(item, actor, policy)) throw new DemoApiError('document_permission_required', 403)
}

function stale(): DemoApiError {
  return new DemoApiError('document_stale', 409)
}

// --- Views ---

interface Stats {
  files: number
  folders: number
  size: number
  /** Everything inside was created by the person browsing. */
  owned: boolean
}

/** Everything active inside a folder, at any depth: files, their current versions' bytes and folders. */
function folderStats(documents: SharedDocumentsState, folder: DemoDocumentFolder, actor: ActorOut): Stats {
  const stats: Stats = { files: 0, folders: 0, size: 0, owned: true }
  for (const document of folderFiles(documents, folder.id)) {
    stats.files += 1
    stats.size += currentVersion(documents, document).size
    stats.owned &&= owns(document, actor)
  }
  for (const child of childFolders(documents, folder.id)) {
    const inner = folderStats(documents, child, actor)
    stats.files += inner.files
    stats.folders += inner.folders + 1
    stats.size += inner.size
    stats.owned &&= inner.owned && owns(child, actor)
  }
  return stats
}

export function folderOut(documents: SharedDocumentsState, folder: DemoDocumentFolder, actor: ActorOut): DocumentFolderOut {
  const stats = folderStats(documents, folder, actor)
  const manage = mayManage(folder, actor, documents.settings.manage_policy)
  return {
    id: folder.id, parent_id: folder.parentId, name: folder.name, version: folder.version, author: actorOut(folder.author),
    created_at: folder.createdAt, updated_at: folder.updatedAt, file_count: stats.files, folder_count: stats.folders,
    size: stats.size, can_manage: manage,
    // Under the "creator" policy a resident deletes a folder only if they created all it holds.
    can_delete: manage && (actor.kind === 'administrator' || documents.settings.manage_policy !== 'creator' || stats.owned),
  }
}

export function folderInfo(documents: SharedDocumentsState, folder: DemoDocumentFolder, actor: ActorOut): DocumentFolderInfoOut {
  return {
    ...folderOut(documents, folder, actor), location: refs(folderPath(documents, folder.parentId)),
    deleted_at: null, deleted_by: null, purged_at: null,
  }
}

export function versionOut(version: DemoDocumentVersion): DocumentVersionOut {
  return {
    id: version.id, number: version.number, extension: version.extension, media_type: version.mediaType, size: version.size,
    sha256: version.sha256, author: actorOut(version.author), created_at: version.createdAt, purged_at: version.purgedAt,
  }
}

export function documentOut(documents: SharedDocumentsState, document: DemoDocument, actor: ActorOut): DocumentOut {
  const current = currentVersion(documents, document)
  return {
    id: document.id, folder_id: document.folderId, name: document.name, kind: document.kind,
    previewable: documentType(current.extension).previewType !== null, version: document.version,
    author: actorOut(document.author), created_at: document.createdAt, updated_at: document.updatedAt,
    current: versionOut(current), version_count: document.currentNumber,
    can_manage: mayManage(document, actor, documents.settings.manage_policy),
  }
}

export function documentInfo(documents: SharedDocumentsState, document: DemoDocument, actor: ActorOut): DocumentInfoOut {
  const deletion = document.deletionId === null ? undefined : documents.deletions.find(item => item.id === document.deletionId)
  return {
    ...documentOut(documents, document, actor), location: refs(folderPath(documents, document.folderId)),
    versions: documents.versions.filter(version => version.documentId === document.id).sort((a, b) => b.number - a.number).map(versionOut),
    deleted_at: document.deletedAt, deleted_by: deletion ? actorOut(deletion.author) : null, purged_at: document.purgedAt,
    text: textOut(currentVersion(documents, document)),
  }
}

// --- The text the search reads (document_index.py, document_reading.py) ---

function textStatus(text: DemoText): DocumentTextOut['status'] {
  if (text.status !== 'ready') return text.status
  return text.content ? 'ready' : 'empty'
}

/** `text_info`: what the search knows of a version's text; nothing once it is purged. */
function textOut(version: DemoDocumentVersion): DocumentTextOut | null {
  if (!READABLE_EXTENSIONS.has(version.extension)) return { status: 'unsupported', ocr_pages: 0, partial: false }
  return version.text && { status: textStatus(version.text), ocr_pages: version.text.ocrPages, partial: version.text.partial }
}

interface ReadableFile { document: DemoDocument; version: DemoDocumentVersion; text: DemoText }

/** The active documents whose current version has a text to read. */
function readableFiles(documents: SharedDocumentsState): ReadableFile[] {
  return documents.documents.flatMap(document => {
    if (document.deletedAt !== null) return []
    const version = currentVersion(documents, document)
    return version.text ? [{ document, version, text: version.text }] : []
  })
}

/** The server's reader, at once: what waits is read when a request needs it. */
export async function readTexts(documents: SharedDocumentsState, at: string): Promise<void> {
  for (const { version, text } of readableFiles(documents)) {
    if (text.status === 'pending') await readText(text, version.bytes, version.extension, at)
  }
}

export type DocumentTextFilter = 'all' | 'pending' | 'failed' | 'empty' | 'partial' | 'ocr' | 'text'
export const DOCUMENT_TEXT_FILTERS = [
  'all', 'pending', 'failed', 'empty', 'partial', 'ocr', 'text',
] as const satisfies readonly DocumentTextFilter[]

function selected(filter: DocumentTextFilter): (file: ReadableFile) => boolean {
  return ({ text }) => {
    const ready = text.status === 'ready'
    switch (filter) {
      case 'all': return true
      case 'pending': return text.status === 'pending'
      case 'failed': return text.status === 'failed'
      case 'empty': return ready && !text.content
      case 'text': return ready && text.content !== ''
      case 'partial': return ready && text.partial
      case 'ocr': return ready && text.ocrPages > 0
    }
  }
}

/** `reading_summary`: the demo has no OCR, like a server without Tesseract; nothing is ever left being read. */
export function readingSummary(documents: SharedDocumentsState): DocumentTextSummaryOut {
  const files = readableFiles(documents)
  const count = (filter: DocumentTextFilter) => files.filter(selected(filter)).length
  return {
    engine: { available: false, version: null, language: 'en' },
    counts: {
      files: documents.documents.filter(document => document.deletedAt === null).length, readable: files.length,
      pending: count('pending'), text: count('text'), empty: count('empty'), failed: count('failed'), partial: count('partial'),
      ocr: count('ocr'), needs_ocr: files.filter(({ text }) => text.status === 'ready' && text.needsOcr).length,
    },
    reading: null,
  }
}

function textFileOut(documents: SharedDocumentsState, { document, text }: ReadableFile): DocumentTextFileOut {
  const status = textStatus(text)
  return {
    document_id: document.id, name: document.name, kind: document.kind, location: refs(folderPath(documents, document.folderId)), status,
    reading: false, error: status === 'failed' ? text.error : null, characters: characterCount(text.content), ocr_pages: text.ocrPages,
    partial: text.partial, needs_ocr: text.needsOcr, read_at: text.readAt,
  }
}

/** Newest first by `newest`, then by version id, as SQL orders them. */
function byNewest(newest: (file: ReadableFile) => string): (a: ReadableFile, b: ReadableFile) => number {
  return (a, b) => newest(a) !== newest(b) ? (newest(a) < newest(b) ? 1 : -1) : a.version.id < b.version.id ? -1 : a.version.id > b.version.id ? 1 : 0
}

/** `reading_files`: those waiting in the order they will be read, the newest first; the others the latest read first. */
export function readingFiles(documents: SharedDocumentsState, filter: DocumentTextFilter, page: number): DocumentTextFilePage {
  const order = byNewest(filter === 'pending' ? file => file.version.createdAt : file => file.text.updatedAt)
  const { items, ...info } = paginate(readableFiles(documents).filter(selected(filter)).sort(order), page, DOCUMENT_PAGE_SIZE)
  return { ...info, items: items.map(file => textFileOut(documents, file)) }
}

/** `read_again`: a file waiting already keeps its place. */
export function readAgain(documents: SharedDocumentsState, documentId: number, at: string): DocumentTextFileOut {
  const document = activeDocument(documents, documentId)
  const version = currentVersion(documents, document)
  if (!READABLE_EXTENSIONS.has(version.extension)) throw new DemoApiError('document_text_unsupported', 409)
  version.text ??= queuedText(at)
  if (version.text.status !== 'pending') Object.assign(version.text, { status: 'pending', updatedAt: at })
  return textFileOut(documents, { document, version, text: version.text })
}

/** `retry_failed`: every active file that could not be read is read again. */
export function retryFailed(documents: SharedDocumentsState, at: string): DocumentTextQueueOut {
  const failed = readableFiles(documents).filter(selected('failed'))
  for (const { text } of failed) Object.assign(text, { status: 'pending', updatedAt: at })
  return { queued: failed.length }
}

export function eventOut(event: DemoDocumentEvent): DocumentEventOut {
  const { details } = event
  return {
    id: event.id, kind: event.kind, author: actorOut(event.author), created_at: event.createdAt, name: details.name ?? null,
    previous_name: details.previous_name ?? null, location: details.location ? [...details.location] : null,
    previous_location: details.previous_location ? [...details.previous_location] : null, number: details.number ?? null,
    size: details.size ?? null, folder: details.folder ?? null,
  }
}

/** An item's history, newest first. */
export function historyPage(documents: SharedDocumentsState, item: Item, page: number): DocumentHistoryPage {
  const events = documents.events
    .filter(event => (isFolder(item) ? event.folderId : event.documentId) === item.id)
    .sort((a, b) => b.id - a.id)
  const { items, ...info } = paginate(events, page, DOCUMENT_PAGE_SIZE)
  return { ...info, items: items.map(eventOut) }
}

/** `limits`: the fixed limits, and the largest file and video the administrator chose. */
export function documentLimits(settings: DocumentSettings): DocumentLimitsOut {
  return {
    extensions: [...DOCUMENT_TYPES.keys()].sort(), video_extensions: [...VIDEO_EXTENSIONS], max_file_bytes: settings.max_file_mb * MIB,
    max_video_bytes: settings.max_video_mb * MIB, chunk_bytes: CHUNK_BYTES, max_folder_items: MAX_FOLDER_ITEMS, max_depth: MAX_DEPTH,
    archive_max_items: ARCHIVE_MAX_ITEMS, archive_max_files: ARCHIVE_MAX_FILES, archive_max_bytes: ARCHIVE_MAX_BYTES,
  }
}

/** `browse`: a folder (null: the top level), the path to it and its folders and files. */
export function browse(documents: SharedDocumentsState, folderId: number | null, actor: ActorOut): DocumentBrowseOut {
  const folder = folderId === null ? null : activeFolder(documents, folderId)
  return {
    folder: folder && folderOut(documents, folder, actor), path: refs(folderPath(documents, folderId)),
    folders: childFolders(documents, folderId).map(child => folderOut(documents, child, actor)),
    files: folderFiles(documents, folderId).map(document => documentOut(documents, document, actor)),
    policy: documents.settings.manage_policy, limits: documentLimits(documents.settings),
  }
}

/** Every active folder, to pick where to move or upload something. */
export function folderTree(documents: SharedDocumentsState): DocumentTreeFolderOut[] {
  return byName(documents.folders.filter(folder => folder.deletedAt === null))
    .map(folder => ({ id: folder.id, parent_id: folder.parentId, name: folder.name }))
}

export type DocumentSort = 'name' | 'modified' | 'size'
export const DOCUMENT_SORTS = ['name', 'modified', 'size'] as const satisfies readonly DocumentSort[]

/** `search_order`: the latest change or the largest first, then by name, like the folder views. */
function searchOrder(sort: DocumentSort, size: (item: Item) => number): (a: Item, b: Item) => number {
  return (a, b) => {
    if (sort === 'modified' && a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? 1 : -1
    if (sort === 'size' && size(a) !== size(b)) return size(b) - size(a)
    return compareText(nameKey(a.name), nameKey(b.name)) || a.id - b.id
  }
}

/**
 * `search`: active folders and files anywhere whose name contains `q`, ignoring case and accents,
 * folders first; then the files whose text contains it, with the words around the first place.
 */
export function searchDocuments(
  documents: SharedDocumentsState, q: string, sort: DocumentSort, page: number, actor: ActorOut,
): DocumentSearchPage {
  const needle = foldText(q.trim())
  // The text is kept on one line with single spaces.
  const words = foldText(q.split(/\s+/u).filter(Boolean).join(' '))
  const named = (item: Item) => item.deletedAt === null && needle !== '' && foldText(item.name).includes(needle)
  const read = (document: DemoDocument) => document.deletedAt === null && words !== '' && !named(document)
    && (currentVersion(documents, document).text?.key.includes(words) ?? false)
  const size = (item: Item) => isFolder(item) ? folderStats(documents, item, actor).size : currentVersion(documents, item).size
  const order = searchOrder(sort, size)
  const byText = documents.documents.filter(read).sort(order)
  const { items, ...info } = paginate<Item>([
    ...documents.folders.filter(named).sort(order), ...documents.documents.filter(named).sort(order), ...byText,
  ], page, DOCUMENT_PAGE_SIZE)
  const found = new Set(byText.map(document => document.id))
  return {
    ...info,
    folders: items.filter(isFolder).map(folder => ({ ...folderOut(documents, folder, actor), location: refs(folderPath(documents, folder.parentId)) })),
    files: items.filter((item): item is DemoDocument => !isFolder(item)).map(document => ({
      ...documentOut(documents, document, actor), location: refs(folderPath(documents, document.folderId)),
      excerpt: found.has(document.id) ? textExcerpt(currentVersion(documents, document).text?.content ?? '', words) : null,
    })),
    pending: readableFiles(documents).filter(({ text }) => text.status === 'pending' && text.readAt === null).length,
  }
}

export function uploadOut(upload: DemoDocumentUpload): DocumentUploadOut {
  return {
    id: upload.id, name: upload.name, size: upload.size, received: upload.received, folder_id: upload.folderId,
    document_id: upload.documentId, expires_at: upload.expiresAt,
  }
}

// --- History ---

function record(documents: SharedDocumentsState, actor: ActorOut, kind: DocumentEventKind, item: Item, at: string, details: DocumentEventDetails): void {
  documents.events.push({
    id: documents.sequences.event.next(), folderId: isFolder(item) ? item.id : null, documentId: isFolder(item) ? null : item.id,
    kind, author: { ...actor }, createdAt: at, details,
  })
}

// --- Folders and files ---

/** `create_folder`: anyone adds a folder, at most ten levels deep. */
export function createFolder(documents: SharedDocumentsState, actor: ActorOut, name: string, parentId: number | null, at: string): DemoDocumentFolder {
  const checked = checkedName(name)
  let above: DemoDocumentFolder[] = []
  if (parentId !== null) {
    activeFolder(documents, parentId)
    above = folderPath(documents, parentId)
    if (above.length >= MAX_DEPTH) throw new DemoApiError('document_depth_limit', 409)
  }
  requireRoom(documents, parentId)
  requireFreeName(documents, parentId, checked)
  const folder: DemoDocumentFolder = {
    id: documents.sequences.folder.next(), parentId, name: checked, author: { ...actor }, version: 1, createdAt: at, updatedAt: at,
    deletedAt: null, deletionId: null, purgedAt: null,
  }
  documents.folders.push(folder)
  record(documents, actor, 'created', folder, at, { name: checked, location: folderNames(above) })
  return folder
}

/** `DocumentItemEdit`. */
export interface ItemEdit {
  version: number
  /** The new name as typed; null keeps it. */
  name: string | null
  /** The folder to move it into (null: the top level); absent keeps it where it is. */
  folderId?: number | null
}

/** Renames and moves an item that passed the checks, with their history entries. */
function applyEdit(
  documents: SharedDocumentsState, actor: ActorOut, item: Item, name: string, destination: number | null,
  moved: { before: DemoDocumentFolder[]; after: DemoDocumentFolder[] } | null, at: string,
): void {
  if (name !== item.name) record(documents, actor, 'renamed', item, at, { previous_name: item.name, name })
  if (moved) record(documents, actor, 'moved', item, at, { name, previous_location: folderNames(moved.before), location: folderNames(moved.after) })
  item.name = name
  if (isFolder(item)) item.parentId = destination
  else item.folderId = destination
  item.version += 1
  item.updatedAt = at
}

/** `edit_folder`: a new name or another place, never inside itself nor deeper than ten levels. */
export function editFolder(documents: SharedDocumentsState, actor: ActorOut, folderId: number, edit: ItemEdit, at: string): DemoDocumentFolder {
  const folder = activeFolder(documents, folderId)
  if (folder.version !== edit.version) throw stale()
  requireManage(folder, actor, documents.settings.manage_policy)
  const name = edit.name === null ? folder.name : checkedName(edit.name)
  const moving = edit.folderId !== undefined && edit.folderId !== folder.parentId
  const destination = moving ? edit.folderId ?? null : folder.parentId
  const before = folderPath(documents, folder.parentId)
  let after = before
  if (moving) {
    after = []
    if (destination !== null) {
      activeFolder(documents, destination)
      after = folderPath(documents, destination)
      if (after.some(item => item.id === folder.id)) throw new DemoApiError('document_move_into_itself', 409)
    }
    if (after.length + subtree(documents, folder).levels > MAX_DEPTH) throw new DemoApiError('document_depth_limit', 409)
    requireRoom(documents, destination)
  }
  if (moving || nameKey(name) !== nameKey(folder.name)) requireFreeName(documents, destination, name, folder)
  if (moving || name !== folder.name) applyEdit(documents, actor, folder, name, destination, moving ? { before, after } : null, at)
  return folder
}

/** `edit_file`: a new name (its extension, and so its type, never changes) or another folder. */
export function editDocument(documents: SharedDocumentsState, actor: ActorOut, documentId: number, edit: ItemEdit, at: string): DemoDocument {
  const document = activeDocument(documents, documentId)
  if (document.version !== edit.version) throw stale()
  requireManage(document, actor, documents.settings.manage_policy)
  const name = edit.name === null ? document.name : documentName(edit.name, currentVersion(documents, document).extension)
  const moving = edit.folderId !== undefined && edit.folderId !== document.folderId
  const destination = moving ? edit.folderId ?? null : document.folderId
  const before = folderPath(documents, document.folderId)
  let after = before
  if (moving) {
    after = []
    if (destination !== null) {
      activeFolder(documents, destination)
      after = folderPath(documents, destination)
    }
    requireRoom(documents, destination)
  }
  if (moving || nameKey(name) !== nameKey(document.name)) requireFreeName(documents, destination, name, document)
  if (moving || name !== document.name) applyEdit(documents, actor, document, name, destination, moving ? { before, after } : null, at)
  return document
}

/** `delete_items`: hides the item and everything in it as one deletion, which the administrator can undo. */
function deleteItems(
  documents: SharedDocumentsState, actor: ActorOut, root: Item, folders: readonly DemoDocumentFolder[], files: readonly DemoDocument[], at: string,
): void {
  const location = folderNames(folderPath(documents, parentOf(root)))
  const deletion: DemoDocumentDeletion = {
    id: documents.random.uuid(), folderId: isFolder(root) ? root.id : null, documentId: isFolder(root) ? null : root.id,
    name: root.name, location, author: { ...actor }, createdAt: at, restoredAt: null, purgedAt: null,
  }
  documents.deletions.push(deletion)
  for (const item of [...folders, ...files]) {
    item.deletedAt = at
    item.deletionId = deletion.id
    item.version += 1
    record(documents, actor, 'deleted', item, at, item === root ? { name: item.name, location: [...location] } : { name: item.name, folder: root.name })
  }
}

/** `delete_folder`: under the "creator" policy a resident deletes only a folder whose whole content they created. */
export function deleteFolder(documents: SharedDocumentsState, actor: ActorOut, folderId: number, expected: number, at: string): void {
  const folder = activeFolder(documents, folderId)
  if (folder.version !== expected) throw stale()
  requireManage(folder, actor, documents.settings.manage_policy)
  const { folders, files } = subtree(documents, folder)
  if (actor.kind !== 'administrator' && documents.settings.manage_policy === 'creator' && ![...folders, ...files].every(item => owns(item, actor))) {
    throw new DemoApiError('document_folder_not_owned', 403)
  }
  deleteItems(documents, actor, folder, folders, files, at)
}

export function deleteDocument(documents: SharedDocumentsState, actor: ActorOut, documentId: number, expected: number, at: string): void {
  const document = activeDocument(documents, documentId)
  if (document.version !== expected) throw stale()
  requireManage(document, actor, documents.settings.manage_policy)
  deleteItems(documents, actor, document, [], [document], at)
}

// --- Uploads ---

function totalSize(versions: readonly DemoDocumentVersion[]): number {
  return versions.reduce((sum, version) => sum + version.size, 0)
}

/** `check_quota`: the uploader's budget (residents only), then the community's, as the administrator set them now. */
export function checkDocumentQuota(documents: SharedDocumentsState, actor: ActorOut, size: number): void {
  const stored = documents.versions.filter(version => version.purgedAt === null)
  const { user_quota_mb, community_quota_mb } = documents.settings
  if (actor.kind === 'resident' && actor.user_id !== null) {
    const own = stored.filter(version => version.author.kind === 'resident' && version.author.user_id === actor.user_id)
    if (totalSize(own) + size > user_quota_mb * MIB) throw new DemoApiError('document_storage_user_quota', 409)
  }
  if (totalSize(stored) + size > community_quota_mb * MIB) throw new DemoApiError('document_storage_community_quota', 409)
}

/** `DocumentUploadIn`, validated. */
export interface UploadInput {
  uploadId: string
  /** The file's name on the device; its extension decides the type. */
  name: string
  size: number
  folderId: number | null
  documentId: number | null
}

function expired(upload: DemoDocumentUpload, at: string): boolean {
  return Date.parse(upload.expiresAt) <= Date.parse(at)
}

function touch(documents: SharedDocumentsState, upload: DemoDocumentUpload, at: string): void {
  upload.updatedAt = at
  upload.expiresAt = new Date(Date.parse(at) + UPLOAD_LIFETIME_MS).toISOString()
  upload.activity = documents.sequences.activity.next()
}

function discard(documents: SharedDocumentsState, upload: DemoDocumentUpload): void {
  const index = documents.uploads.indexOf(upload)
  if (index >= 0) documents.uploads.splice(index, 1)
}

/** `create_upload`: starts an upload, or finds the one already started with this id; its chunks follow. */
export function startUpload(documents: SharedDocumentsState, actor: ActorOut, input: UploadInput, at: string): DemoDocumentUpload {
  const { name, extension } = uploadName(input.name)
  if (input.size === 0) throw new DemoApiError('document_file_empty', 422)
  const { max_file_mb, max_video_mb } = documents.settings
  if (input.size > (documentType(extension).kind === 'video' ? max_video_mb : max_file_mb) * MIB) throw new DemoApiError('document_too_large', 413)
  const existing = documents.uploads.find(upload => upload.id === input.uploadId)
  if (existing) {
    const same = owns(existing, actor) && existing.name === name && existing.size === input.size
      && existing.folderId === input.folderId && existing.documentId === input.documentId
    if (!same) throw new DemoApiError('document_upload_conflict', 409)
    return existing
  }
  if (documents.versions.some(version => version.id === input.uploadId)) throw new DemoApiError('document_upload_conflict', 409)
  if (input.documentId !== null) {
    const document = activeDocument(documents, input.documentId)
    requireManage(document, actor, documents.settings.manage_policy)
    if (currentVersion(documents, document).extension !== extension) throw new DemoApiError('document_version_extension', 422)
  } else {
    if (input.folderId !== null) activeFolder(documents, input.folderId)
    requireRoom(documents, input.folderId)
  }
  checkDocumentQuota(documents, actor, input.size)
  // Expired uploads, and this person's least recently active ones beyond the limit.
  const open = documents.uploads
    .filter(upload => owns(upload, actor) && !expired(upload, at))
    .sort((a, b) => compareText(b.updatedAt, a.updatedAt) || b.activity - a.activity)
  for (const upload of [...documents.uploads.filter(item => expired(item, at)), ...open.slice(MAX_OPEN_UPLOADS - 1)]) discard(documents, upload)
  const upload: DemoDocumentUpload = {
    id: input.uploadId, folderId: input.folderId, documentId: input.documentId, name, extension, size: input.size, received: 0,
    chunks: [], author: { ...actor }, createdAt: at, updatedAt: at, expiresAt: at, activity: 0,
  }
  touch(documents, upload, at)
  documents.uploads.push(upload)
  return upload
}

/** One's own upload, while it has not expired (404 `document_upload_not_found`). */
export function ownUpload(documents: SharedDocumentsState, actor: ActorOut, uploadId: string, at: string): DemoDocumentUpload {
  const upload = documents.uploads.find(item => item.id === uploadId)
  if (!upload || !owns(upload, actor) || expired(upload, at)) throw new DemoApiError('document_upload_not_found', 404)
  return upload
}

/** `upload_chunk`: the next bytes of an upload, starting where the received ones end. */
export function receiveChunk(
  documents: SharedDocumentsState, actor: ActorOut, uploadId: string, offset: number, data: Uint8Array<ArrayBuffer>, at: string,
): DemoDocumentUpload {
  const upload = ownUpload(documents, actor, uploadId, at)
  if (offset !== upload.received) throw new DemoApiError('document_upload_offset', 409)
  if (upload.received + data.length > upload.size) throw new DemoApiError('document_upload_size', 422)
  upload.chunks.push(data)
  upload.received += data.length
  touch(documents, upload, at)
  return upload
}

/** `cancel_upload`: cancelling an unknown upload succeeds, someone else's is not found. */
export function cancelUpload(documents: SharedDocumentsState, actor: ActorOut, uploadId: string): void {
  const upload = documents.uploads.find(item => item.id === uploadId)
  if (!upload) return
  if (!owns(upload, actor)) throw new DemoApiError('document_upload_not_found', 404)
  discard(documents, upload)
}

/** The bytes received, joined once. */
function uploadedBytes(upload: DemoDocumentUpload): Uint8Array<ArrayBuffer> {
  if (upload.chunks.length !== 1) {
    const bytes = new Uint8Array(upload.received)
    let offset = 0
    for (const chunk of upload.chunks) {
      bytes.set(chunk, offset)
      offset += chunk.length
    }
    upload.chunks = [bytes]
  }
  return upload.chunks[0]
}

/** `completed`: a completion retried after it succeeded is answered from the stored version. */
function completed(documents: SharedDocumentsState, uploadId: string, actor: ActorOut): DemoDocument {
  const version = documents.versions.find(item => item.id === uploadId)
  if (!version || !owns(version, actor)) throw new DemoApiError('document_upload_not_found', 404)
  const document = findDocument(documents, version.documentId)
  if (!document || document.deletedAt !== null) throw new DemoApiError('document_not_found', 404)
  return document
}

/**
 * `complete_upload`: checks the received file and adds it as a new document or a new version. A
 * file whose content does not match its type is refused and its upload discarded.
 */
export async function completeUpload(documents: SharedDocumentsState, actor: ActorOut, uploadId: string, at: string): Promise<DemoDocument> {
  const upload = documents.uploads.find(item => item.id === uploadId)
  if (!upload || !owns(upload, actor)) return completed(documents, uploadId, actor)
  if (upload.received !== upload.size) throw new DemoApiError('document_upload_incomplete', 409)
  try {
    await checkContent(uploadedBytes(upload), upload.extension)
  } catch (error) {
    if (error instanceof DemoApiError && error.status === 415) discard(documents, upload)
    throw error
  }
  return publishUpload(documents, actor, uploadId, at)
}

/**
 * The end of `complete_upload`, for a file whose content is known to match its type (the
 * scenario's): a new version of a document, or a new document named like the file, numbered when
 * the name is taken. The policy and the quotas are the administrator's current ones, which may have
 * changed since the upload began.
 */
export function publishUpload(documents: SharedDocumentsState, actor: ActorOut, uploadId: string, at: string): DemoDocument {
  const upload = documents.uploads.find(item => item.id === uploadId)
  // Completed or cancelled by another request meanwhile.
  if (!upload || !owns(upload, actor)) return completed(documents, uploadId, actor)
  if (upload.received !== upload.size) throw new DemoApiError('document_upload_incomplete', 409)
  const type = documentType(upload.extension)
  let document: DemoDocument
  if (upload.documentId !== null) {
    const target = findDocument(documents, upload.documentId)
    if (!target || target.deletedAt !== null) {
      discard(documents, upload)
      throw new DemoApiError('document_deleted', 409)
    }
    if (!mayManage(target, actor, documents.settings.manage_policy)) {
      discard(documents, upload)
      throw new DemoApiError('document_permission_required', 403)
    }
    checkDocumentQuota(documents, actor, upload.size)
    target.currentNumber += 1
    target.version += 1
    target.updatedAt = at
    record(documents, actor, 'version_added', target, at, { name: target.name, number: target.currentNumber, size: upload.size })
    document = target
  } else {
    if (upload.folderId !== null) {
      const folder = findFolder(documents, upload.folderId)
      if (!folder || folder.deletedAt !== null) {
        discard(documents, upload)
        throw new DemoApiError('document_folder_deleted', 409)
      }
    }
    requireRoom(documents, upload.folderId)
    checkDocumentQuota(documents, actor, upload.size)
    const name = freeName(documents, upload.folderId, upload.name, upload.extension)
    document = {
      id: documents.sequences.document.next(), folderId: upload.folderId, name, kind: type.kind, currentNumber: 1, author: { ...actor },
      version: 1, createdAt: at, updatedAt: at, deletedAt: null, deletionId: null, purgedAt: null,
    }
    documents.documents.push(document)
    record(documents, actor, 'created', document, at, {
      name, location: folderNames(folderPath(documents, upload.folderId)), number: 1, size: upload.size,
    })
  }
  const bytes = uploadedBytes(upload)
  // The search knows the text of current versions only.
  for (const version of documents.versions) if (version.documentId === document.id) version.text = null
  documents.versions.push({
    id: upload.id, documentId: document.id, number: document.currentNumber, extension: upload.extension, mediaType: type.mediaType,
    size: upload.size, sha256: sha256Hex(bytes), bytes, author: { ...actor }, createdAt: at, purgedAt: null,
    text: READABLE_EXTENSIONS.has(upload.extension) ? queuedText(at) : null,
  })
  discard(documents, upload)
  return document
}

// --- Downloads and archives ---

export interface VersionFile {
  bytes: Uint8Array<ArrayBuffer>
  mediaType: string
  filename: string
}

/**
 * `version_response`: a stored version to download (`attachment`) or preview (`inline`: PDFs,
 * pictures and videos); the administrator's copy (`deleted`) also of deleted documents.
 */
export function versionFile(
  documents: SharedDocumentsState, versionId: string, disposition: 'attachment' | 'inline', { deleted = false } = {},
): VersionFile {
  const version = documents.versions.find(item => item.id === versionId)
  if (!version) throw new DemoApiError('document_version_not_found', 404)
  const document = findDocument(documents, version.documentId)
  if (!document || (document.deletedAt !== null && !deleted)) throw new DemoApiError('document_not_found', 404)
  if (version.purgedAt !== null) throw new DemoApiError('document_version_purged', 410)
  const type = documentType(version.extension)
  if (disposition === 'inline' && type.previewType === null) throw new DemoApiError('document_preview_unavailable', 415)
  return {
    bytes: version.bytes, mediaType: disposition === 'inline' && type.previewType !== null ? type.previewType : type.mediaType,
    filename: versionFilename(document.name, version.number, document.currentNumber, version.extension),
  }
}

/** MS-DOS time of an instant: the wall-clock time of the community. */
function zipTime(instant: string): ZipTime {
  const { year, month, day, hour, minute, second } = wallClock(Date.parse(instant))
  return { year, month, day, hour, minute, second }
}

/**
 * `archive`: folders and files (1 to 100 of them) as one ZIP that keeps the folder structure.
 * Items inside a chosen folder are not repeated, top-level names that collide get a number, and the
 * ZIP is named after the single folder chosen, the folder all the items are in, or "Documents".
 */
export function documentArchive(documents: SharedDocumentsState, folderIds: readonly number[], fileIds: readonly number[]): { filename: string; bytes: Uint8Array<ArrayBuffer> } {
  const count = folderIds.length + fileIds.length
  if (count < 1 || count > ARCHIVE_MAX_ITEMS || [...folderIds, ...fileIds].some(id => id < 1 || id > MAX_ID)) {
    throw new DemoApiError('document_archive_items', 422)
  }
  const chosenFolders = [...new Set(folderIds)].map(id => activeFolder(documents, id))
  const chosenFiles = [...new Set(fileIds)].map(id => activeDocument(documents, id))
  const chosen = new Set(folderIds)
  const inside = (folderId: number | null) => folderPath(documents, folderId).some(folder => chosen.has(folder.id))
  const roots = byName(chosenFolders.filter(folder => !inside(folder.parentId)))
  const loose = byName(chosenFiles.filter(document => !inside(document.folderId)))
  const entries: ZipEntry[] = []
  const used = new Set<string>()
  let files = 0, size = 0
  const top = (name: string, extension: string | null) => {
    let candidate = name
    for (let number = 2; used.has(nameKey(candidate)); number += 1) candidate = numbered(name, number, extension)
    used.add(nameKey(candidate))
    return candidate
  }
  const addFile = (path: string, document: DemoDocument) => {
    const current = currentVersion(documents, document)
    files += 1
    size += current.size
    if (files > ARCHIVE_MAX_FILES || size > ARCHIVE_MAX_BYTES) throw new DemoApiError('document_archive_too_large', 422)
    entries.push({ path, data: current.bytes, modified: zipTime(current.createdAt) })
  }
  const addFolder = (prefix: string, folder: DemoDocumentFolder) => {
    entries.push({ path: prefix, data: null, modified: zipTime(folder.updatedAt) })
    for (const document of folderFiles(documents, folder.id)) addFile(prefix + document.name, document)
    for (const child of childFolders(documents, folder.id)) addFolder(`${prefix}${child.name}/`, child)
  }
  for (const folder of roots) addFolder(`${top(folder.name, null)}/`, folder)
  for (const document of loose) addFile(top(document.name, currentVersion(documents, document).extension), document)
  const parents = new Set([...roots.map(folder => folder.parentId), ...loose.map(document => document.folderId)])
  const [parent] = parents
  const title = roots.length === 1 && loose.length === 0 ? roots[0].name
    : parents.size === 1 && parent !== null ? activeFolder(documents, parent).name : 'Documents'
  try {
    return { filename: `${title}.zip`, bytes: zipArchive(entries) }
  } catch (error) {
    // The demo writes no ZIP64: beyond 4 GiB in memory the archive is refused.
    if (error instanceof RangeError) throw new DemoApiError('document_archive_too_large', 422)
    throw error
  }
}

// --- Administration ---

/** Deletions the administrator can still restore or purge, newest first. */
export function openDeletions(documents: SharedDocumentsState): DemoDocumentDeletion[] {
  return documents.deletions
    .map((deletion, index) => ({ deletion, index }))
    .filter(({ deletion }) => deletion.restoredAt === null && deletion.purgedAt === null)
    .sort((a, b) => compareText(b.deletion.createdAt, a.deletion.createdAt) || b.index - a.index)
    .map(({ deletion }) => deletion)
}

function deletionItems(documents: SharedDocumentsState, deletion: DemoDocumentDeletion): { folders: DemoDocumentFolder[]; files: DemoDocument[] } {
  return {
    folders: documents.folders.filter(folder => folder.deletionId === deletion.id),
    files: documents.documents.filter(document => document.deletionId === deletion.id),
  }
}

export function deletionOut(documents: SharedDocumentsState, deletion: DemoDocumentDeletion): DocumentDeletionOut {
  const { folders, files } = deletionItems(documents, deletion)
  const ids = new Set(files.map(document => document.id))
  return {
    id: deletion.id, folder_id: deletion.folderId, document_id: deletion.documentId, name: deletion.name, location: [...deletion.location],
    file_kind: deletion.documentId === null ? null : findDocument(documents, deletion.documentId)?.kind ?? null,
    file_count: files.length, folder_count: Math.max(0, folders.length - (deletion.folderId === null ? 0 : 1)),
    stored_bytes: totalSize(documents.versions.filter(version => ids.has(version.documentId) && version.purgedAt === null)),
    author: actorOut(deletion.author), created_at: deletion.createdAt,
  }
}

function openDeletion(documents: SharedDocumentsState, deletionId: string): DemoDocumentDeletion {
  const deletion = documents.deletions.find(item => item.id === deletionId)
  if (!deletion) throw new DemoApiError('document_deletion_not_found', 404)
  return deletion
}

/**
 * `restore_deletion`: brings back everything deleted together, where it was, or at the top level
 * if that folder is gone; a name already in use gets a number.
 */
export function restoreDeletion(documents: SharedDocumentsState, actor: ActorOut, deletionId: string, at: string): void {
  const deletion = openDeletion(documents, deletionId)
  if (deletion.restoredAt !== null || deletion.purgedAt !== null) throw new DemoApiError('document_deletion_closed', 409)
  const { folders, files } = deletionItems(documents, deletion)
  const root: Item | undefined = deletion.folderId !== null
    ? folders.find(folder => folder.id === deletion.folderId)
    : files.find(document => document.id === deletion.documentId)
  if (!root) throw new Error(`The document deletion ${deletion.id} lost its item`)
  let parent = parentOf(root)
  if (parent !== null) {
    const container = findFolder(documents, parent)
    if (!container || container.deletedAt !== null) parent = null
  }
  const name = freeName(documents, parent, root.name, isFolder(root) ? null : currentVersion(documents, root).extension)
  const location = folderNames(folderPath(documents, parent))
  for (const item of [...folders, ...files]) {
    item.deletedAt = null
    item.deletionId = null
    item.version += 1
    record(documents, actor, 'restored', item, at, item === root
      ? { name, location: [...location], previous_name: name === root.name ? undefined : root.name }
      : { name: item.name, folder: name })
  }
  root.name = name
  if (isFolder(root)) root.parentId = parent
  else root.folderId = parent
  root.updatedAt = at
  deletion.restoredAt = at
}

/** `purge_deletion`: deletes the files of everything deleted together, for good; records and history remain. */
export function purgeDeletion(documents: SharedDocumentsState, actor: ActorOut, deletionId: string, at: string): void {
  const deletion = openDeletion(documents, deletionId)
  if (deletion.restoredAt !== null) throw new DemoApiError('document_deletion_closed', 409)
  // Repeating a purge succeeds unchanged.
  if (deletion.purgedAt !== null) return
  const { folders, files } = deletionItems(documents, deletion)
  const ids = new Set(files.map(document => document.id))
  for (const version of documents.versions) {
    if (ids.has(version.documentId) && version.purgedAt === null) {
      version.purgedAt = at
      version.bytes = new Uint8Array(0)
      version.text = null
    }
  }
  for (const item of [...folders, ...files]) {
    item.purgedAt = at
    const root = isFolder(item) ? deletion.folderId === item.id : deletion.documentId === item.id
    record(documents, actor, 'purged', item, at, { name: item.name, folder: root ? undefined : deletion.name })
  }
  deletion.purgedAt = at
}

/**
 * `purge_document_version` (storage_admin.py): deletes an earlier version's file and frees its
 * bytes; the document, its other versions and the history remain. Purging again answers the purged
 * version unchanged; current versions (409 `document_version_current`) and deleted documents (409
 * `document_deleted`, purged from Deleted documents instead) are refused.
 */
export function purgeDocumentVersion(documents: SharedDocumentsState, actor: ActorOut, versionId: string, at: string): DemoDocumentVersion {
  const version = documents.versions.find(item => item.id === versionId)
  if (!version) throw new DemoApiError('document_version_not_found', 404)
  const document = findDocument(documents, version.documentId)
  if (!document) throw new Error(`The document version ${version.id} has no document`)
  if (version.purgedAt !== null) return version
  if (version.number === document.currentNumber) throw new DemoApiError('document_version_current', 409)
  if (document.deletedAt !== null) throw new DemoApiError('document_deleted', 409)
  version.purgedAt = at
  version.bytes = new Uint8Array(0)
  version.text = null
  record(documents, actor, 'version_purged', document, at, { name: document.name, number: version.number, size: version.size })
  return version
}

// --- The scenario ---

function emptySharedDocuments(): SharedDocumentsState {
  return {
    settings: { ...DEFAULT_DOCUMENT_SETTINGS }, folders: [], documents: [], versions: [], deletions: [], events: [], uploads: [],
    sequences: { folder: new IdSequence(), document: new IdSequence(), event: new IdSequence(), activity: new IdSequence() },
    random: demoRandom('documents:deletions'),
  }
}

/** Replays the scenario's steps in chronological order (steps at the same instant keep their order). */
export function replaySharedDocuments(steps: readonly SharedDocumentStep[]): SharedDocumentsState {
  const documents = emptySharedDocuments()
  const folders = new Map<string, DemoDocumentFolder>(), files = new Map<string, DemoDocument>()
  const folderId = (key: string | undefined) => {
    if (key === undefined) return null
    const folder = folders.get(key)
    if (!folder) throw new Error(`The documents scenario has no folder "${key}" yet`)
    return folder.id
  }
  const item = (key: string): Item => {
    const found = folders.get(key) ?? files.get(key)
    if (!found) throw new Error(`The documents scenario has no item "${key}" yet`)
    return found
  }
  const upload = (by: ActorOut, file: ScenarioFile, target: { folderId: number | null; documentId: number | null }, at: string) => {
    startUpload(documents, by, { uploadId: file.uploadId, name: file.name, size: file.bytes.length, ...target }, at)
    receiveChunk(documents, by, file.uploadId, 0, file.bytes, at)
    return publishUpload(documents, by, file.uploadId, at)
  }
  for (const step of [...steps].sort((a, b) => compareText(a.at, b.at))) {
    const { at, by } = step
    if ('createFolder' in step) {
      folders.set(step.createFolder, createFolder(documents, by, step.name, folderId(step.parent), at))
    } else if ('upload' in step) {
      files.set(step.upload, upload(by, step.file, { folderId: folderId(step.folder), documentId: null }, at))
    } else if ('newVersion' in step) {
      const target = item(step.newVersion)
      upload(by, step.file, { folderId: null, documentId: target.id }, at)
    } else if ('remove' in step) {
      const target = item(step.remove)
      if (isFolder(target)) deleteFolder(documents, by, target.id, target.version, at)
      else deleteDocument(documents, by, target.id, target.version, at)
    } else {
      const target = item('rename' in step ? step.rename : step.move)
      const edit: ItemEdit = 'rename' in step
        ? { version: target.version, name: step.name }
        : { version: target.version, name: null, folderId: step.into === null ? null : folderId(step.into) }
      if (isFolder(target)) editFolder(documents, by, target.id, edit, at)
      else editDocument(documents, by, target.id, edit, at)
    }
  }
  return documents
}
