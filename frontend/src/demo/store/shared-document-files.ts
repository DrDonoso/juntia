/**
 * The files of the shared documents (src/juntia/document_files.py): the accepted types, the rules
 * of folder and file names, and the checks that an uploaded file's bytes are of the type its
 * extension promises: PDF; JPEG, PNG, GIF, WebP and HEIC/HEIF pictures; Word, Excel and PowerPoint
 * (OOXML) and OpenDocument files without macros, ActiveX controls or embedded binaries; plain text
 * and CSV; and the MP4 and QuickTime videos phones record. Programs, scripts, web pages, SVG,
 * archives and older Office formats are refused.
 */
import type { DocumentOut } from '../../api/schema.gen'
import { DemoApiError } from '../core/errors'
import { looksLikePdf } from '../core/pdf'
import { characterCount } from '../core/validation'
import { readZip, readZipMember, type ZipRecord } from '../core/zip'
import { casefold } from './community-text'

export type DocumentKind = DocumentOut['kind']

export interface DocumentType {
  kind: DocumentKind
  mediaType: string
  /** Type of the preview the eye icon opens (phones' QuickTime videos play as MP4); null: download only. */
  previewType: string | null
}

const OOXML = 'application/vnd.openxmlformats-officedocument.'
const ODF = 'application/vnd.oasis.opendocument.'

/** `TYPES`, by extension, in the backend's order. */
export const DOCUMENT_TYPES: ReadonlyMap<string, DocumentType> = new Map<string, DocumentType>([
  ['pdf', { kind: 'pdf', mediaType: 'application/pdf', previewType: 'application/pdf' }],
  ['jpg', { kind: 'image', mediaType: 'image/jpeg', previewType: 'image/jpeg' }],
  ['jpeg', { kind: 'image', mediaType: 'image/jpeg', previewType: 'image/jpeg' }],
  ['png', { kind: 'image', mediaType: 'image/png', previewType: 'image/png' }],
  ['gif', { kind: 'image', mediaType: 'image/gif', previewType: 'image/gif' }],
  ['webp', { kind: 'image', mediaType: 'image/webp', previewType: 'image/webp' }],
  ['heic', { kind: 'image', mediaType: 'image/heic', previewType: 'image/heic' }],
  ['heif', { kind: 'image', mediaType: 'image/heif', previewType: 'image/heif' }],
  ['docx', { kind: 'document', mediaType: `${OOXML}wordprocessingml.document`, previewType: null }],
  ['xlsx', { kind: 'spreadsheet', mediaType: `${OOXML}spreadsheetml.sheet`, previewType: null }],
  ['pptx', { kind: 'presentation', mediaType: `${OOXML}presentationml.presentation`, previewType: null }],
  ['odt', { kind: 'document', mediaType: `${ODF}text`, previewType: null }],
  ['ods', { kind: 'spreadsheet', mediaType: `${ODF}spreadsheet`, previewType: null }],
  ['odp', { kind: 'presentation', mediaType: `${ODF}presentation`, previewType: null }],
  ['txt', { kind: 'text', mediaType: 'text/plain', previewType: null }],
  ['csv', { kind: 'text', mediaType: 'text/csv', previewType: null }],
  ['mp4', { kind: 'video', mediaType: 'video/mp4', previewType: 'video/mp4' }],
  ['m4v', { kind: 'video', mediaType: 'video/x-m4v', previewType: 'video/mp4' }],
  ['mov', { kind: 'video', mediaType: 'video/quicktime', previewType: 'video/mp4' }],
])

export const VIDEO_EXTENSIONS: readonly string[] = [...DOCUMENT_TYPES].filter(([, type]) => type.kind === 'video').map(([extension]) => extension)

/** The type of a stored version's extension (always an accepted one). */
export function documentType(extension: string): DocumentType {
  const type = DOCUMENT_TYPES.get(extension)
  if (!type) throw new Error(`Unknown document extension: ${extension}`)
  return type
}

// --- Names ---

const MAX_NAME = 200
const MAX_NAME_KEY = 600
const FORBIDDEN = /[/\\:*?"<>|]/
const FORBIDDEN_CHARACTERS = /[/\\:*?"<>|]/g
// Device names Windows refuses as file names, also with an extension.
const RESERVED = /^(?:con|prn|aux|nul|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3])(?:\..*)?$/i
const TRAILING_DOTS = /[ .]+$/
const OUTER_DOTS = /^[ .]+|[ .]+$/g
// Control and invisible format characters, and lone surrogates.
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Cs}]/u

/** Python's `str.isspace()`: JavaScript's white space but the byte order mark, and U+001C to U+001F and U+0085. */
function isSpace(character: string): boolean {
  const code = character.codePointAt(0) ?? 0
  return (code >= 0x1c && code <= 0x1f) || code === 0x85 || (code !== 0xfeff && /\s/u.test(character))
}

/** Python's `" ".join(value.split())`: whitespace runs as single spaces, none at the ends. */
function singleSpaces(value: string): string {
  return Array.from(value, character => (isSpace(character) ? ' ' : character)).join('').split(' ').filter(Boolean).join(' ')
}

/**
 * `clean_name`: NFC, without control or invisible format characters (such as right-to-left
 * overrides that disguise an extension), single spaces, and no trailing dots or spaces, which
 * Windows drops.
 */
export function cleanName(value: string): string {
  const visible = Array.from(value.normalize('NFC')).filter(character => isSpace(character) || !INVISIBLE.test(character)).join('')
  return singleSpaces(visible).replace(TRAILING_DOTS, '')
}

/** `name_key`: names are unique among a folder's items ignoring case, spacing and Unicode forms. */
export function nameKey(name: string): string {
  return casefold(singleSpaces(name.normalize('NFKC')))
}

function invalidName(): DemoApiError {
  return new DemoApiError('document_name_invalid', 422, { name: 'document_name_invalid' })
}

/** `checked_name`: a typed folder or file name, which must work on every system it is downloaded to. */
export function checkedName(value: string): string {
  const name = cleanName(value)
  if (
    !name || characterCount(name) > MAX_NAME || FORBIDDEN.test(name) || RESERVED.test(name)
    || characterCount(nameKey(name)) > MAX_NAME_KEY
  ) throw invalidName()
  return name
}

/** `document_name`: a file's new name keeps its extension, and so its type. */
export function documentName(value: string, extension: string): string {
  const suffix = `.${extension}`
  let name = cleanName(value)
  if (!name.toLowerCase().endsWith(suffix)) name += suffix
  if (!name.slice(0, -suffix.length).replace(OUTER_DOTS, '')) throw invalidName()
  return checkedName(name)
}

/** `upload_name`: an uploaded file's name, made valid instead of refused, and its extension (415 `document_type_unsupported`). */
export function uploadName(filename: string): { name: string; extension: string } {
  const name = cleanName(filename.split(/[/\\]/).at(-1) ?? '')
  const dot = name.lastIndexOf('.')
  const original = name.slice(dot + 1)
  const extension = original.toLowerCase()
  if (dot < 0 || !DOCUMENT_TYPES.has(extension)) throw new DemoApiError('document_type_unsupported', 415)
  let stem = name.slice(0, dot).replace(FORBIDDEN_CHARACTERS, '_').replace(OUTER_DOTS, '')
  if (!stem) stem = 'document'
  else if (RESERVED.test(stem)) stem = `_${stem}`
  stem = Array.from(stem).slice(0, MAX_NAME - characterCount(original) - 1).join('').replace(TRAILING_DOTS, '') || 'document'
  const result = `${stem}.${original}`
  return { name: characterCount(nameKey(result)) > MAX_NAME_KEY ? `document.${original}` : result, extension }
}

/** `numbered`: `Report (2).pdf` for the second item called `Report.pdf` in a folder. */
export function numbered(name: string, number: number, extension: string | null): string {
  const tail = extension && name.toLowerCase().endsWith(`.${extension}`) ? extension.length + 1 : 0
  const characters = Array.from(name)
  const suffix = ` (${number})`
  const stem = characters.slice(0, characters.length - tail).slice(0, MAX_NAME - suffix.length - tail).join('').replace(TRAILING_DOTS, '')
  return stem + suffix + characters.slice(characters.length - tail).join('')
}

/** `version_filename`: earlier versions download as `Report (version 2).pdf` (the server's language is English). */
export function versionFilename(name: string, number: number, current: number, extension: string): string {
  if (number === current) return name
  const tail = name.toLowerCase().endsWith(`.${extension}`) ? extension.length + 1 : 0
  const characters = Array.from(name)
  return `${characters.slice(0, characters.length - tail).join('')} (version ${number})${characters.slice(characters.length - tail).join('')}`
}

// --- Content checks ---

// Bounds that keep a crafted file from making the checks scan or allocate without limit.
const MAX_ZIP_ENTRIES = 10_000
const MAX_ZIP_MEMBER_BYTES = 1024 * 1024
const MAX_BOXES = 10_000
const HEIF_BRANDS = new Set(['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'hevm', 'hevs', 'mif1', 'msf1'])
// The first box of an MP4 or QuickTime file; old QuickTime files have no ftyp box.
const VIDEO_FIRST_BOXES = new Set(['ftyp', 'moov', 'mdat', 'wide', 'free', 'skip', 'pnot'])
// The content type that [Content_Types].xml declares for the main part of each format.
const OOXML_MAIN: ReadonlyMap<string, string> = new Map([
  ['docx', 'wordprocessingml.document.main+xml'],
  ['xlsx', 'spreadsheetml.sheet.main+xml'],
  ['pptx', 'presentationml.presentation.main+xml'],
])
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

function mismatch(): DemoApiError {
  return new DemoApiError('document_type_mismatch', 415)
}

function macros(): DemoApiError {
  return new DemoApiError('document_macros_unsupported', 415)
}

/** Bytes as text, one character per byte (tags, brands and the XML the checks search). */
function latin1(bytes: Uint8Array, start = 0, end = bytes.length): string {
  return new TextDecoder('latin1').decode(bytes.subarray(start, end))
}

/** Python's `bytes.lower()`: ASCII letters only. */
function asciiLower(value: string): string {
  return value.replace(/[A-Z]+/g, letters => letters.toLowerCase())
}

/** The major and compatible brands of the leading ftyp box. */
function brands(bytes: Uint8Array, view: DataView): Set<string> {
  if (bytes.length < 8 || latin1(bytes, 4, 8) !== 'ftyp') return new Set()
  const length = view.getUint32(0)
  if (length < 16 || length > Math.min(bytes.length, 4096)) return new Set()
  const found = new Set([latin1(bytes, 8, 12)])
  for (let offset = 16; offset + 4 <= length; offset += 4) found.add(latin1(bytes, offset, offset + 4))
  return found
}

function checkImage(extension: string, bytes: Uint8Array, view: DataView): void {
  let valid: boolean
  if (extension === 'jpg' || extension === 'jpeg') valid = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
  else if (extension === 'png') valid = PNG_SIGNATURE.every((byte, index) => bytes[index] === byte) && latin1(bytes, 12, 16) === 'IHDR'
  else if (extension === 'gif') valid = ['GIF87a', 'GIF89a'].includes(latin1(bytes, 0, 6))
  else if (extension === 'webp') valid = latin1(bytes, 0, 4) === 'RIFF' && latin1(bytes, 8, 12) === 'WEBP'
  else valid = [...brands(bytes, view)].some(brand => HEIF_BRANDS.has(brand))
  if (!valid) throw mismatch()
}

/**
 * The kinds of the top-level boxes of an ISO base media file (MP4, QuickTime, HEIF). They must
 * cover the file exactly, so a truncated upload is refused.
 */
function boxes(bytes: Uint8Array, view: DataView): string[] {
  const kinds: string[] = []
  let position = 0
  for (let count = 0; count < MAX_BOXES; count += 1) {
    if (position === bytes.length) return kinds
    if (position + 8 > bytes.length) throw mismatch()
    let length = view.getUint32(position)
    let minimum = 8
    if (length === 1) {
      if (position + 16 > bytes.length) throw mismatch()
      length = Number(view.getBigUint64(position + 8))
      minimum = 16
    } else if (length === 0) {
      length = bytes.length - position
    }
    const kind = bytes.subarray(position + 4, position + 8)
    if (length < minimum || position + length > bytes.length || kind.some(byte => byte < 0x20 || byte > 0x7e)) throw mismatch()
    kinds.push(latin1(kind))
    position += length
  }
  throw mismatch()
}

function checkVideo(bytes: Uint8Array, view: DataView): void {
  const kinds = boxes(bytes, view)
  if (kinds.length === 0 || !VIDEO_FIRST_BOXES.has(kinds[0]) || !kinds.includes('moov')) throw mismatch()
  if (kinds[0] === 'ftyp' && HEIF_BRANDS.has(latin1(bytes, 8, 12))) throw mismatch()
}

/** The entries of an OOXML or OpenDocument file, after bounding their number. */
function zipEntries(bytes: Uint8Array): ZipRecord[] {
  const records = readZip(bytes, MAX_ZIP_ENTRIES)
  if (records === null || records.length === 0) throw mismatch()
  return records
}

/** An entry's name as `zipfile` reports it: up to its first NUL character. */
function entryName(record: ZipRecord): string {
  return record.name.split('\0')[0]
}

async function memberText(bytes: Uint8Array<ArrayBuffer>, record: ZipRecord): Promise<string> {
  const data = await readZipMember(bytes, record, MAX_ZIP_MEMBER_BYTES)
  if (data === null) throw mismatch()
  return latin1(data)
}

async function checkOoxml(main: string, bytes: Uint8Array<ArrayBuffer>): Promise<void> {
  const entries = new Map(zipEntries(bytes).map(record => [entryName(record).toLowerCase(), record]))
  const types = entries.get('[content_types].xml')
  if (!types) throw mismatch()
  const declared = asciiLower(await memberText(bytes, types))
  if (declared.includes('macroenabled') || declared.includes('vbaproject')) throw macros()
  if (!declared.includes(main)) throw mismatch()
  for (const name of entries.keys()) {
    const path = `/${name}`
    if (
      name.endsWith('vbaproject.bin') || name.endsWith('vbadata.xml') || path.includes('/activex/')
      || path.includes('/macrosheets/') || (path.includes('/embeddings/') && name.endsWith('.bin'))
    ) throw macros()
  }
}

async function checkOdf(mediaType: string, bytes: Uint8Array<ArrayBuffer>): Promise<void> {
  const entries = zipEntries(bytes)
  const [first] = entries
  if (entryName(first) !== 'mimetype' || (await memberText(bytes, first)).replace(/^[ \t\n\r\v\f]+|[ \t\n\r\v\f]+$/g, '') !== mediaType) {
    throw mismatch()
  }
  for (const record of entries) {
    const folders = entryName(record).toLowerCase().split('/').slice(0, -1)
    if (folders.includes('basic') || folders.includes('scripts')) throw macros()
  }
}

/** Text files may be UTF-16 (with its byte order mark); otherwise a NUL byte gives a binary file away. */
function checkText(bytes: Uint8Array): void {
  const utf16 = (bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff)
  if (!utf16 && bytes.includes(0)) throw mismatch()
}

/**
 * `check_content`: refuses a file whose bytes are not of the type its extension promises (415
 * `document_type_mismatch`), and office files with macros, ActiveX controls or embedded programs
 * (415 `document_macros_unsupported`). These checks are not antivirus scanning.
 */
export async function checkContent(bytes: Uint8Array<ArrayBuffer>, extension: string): Promise<void> {
  const type = documentType(extension)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const main = OOXML_MAIN.get(extension)
  if (type.kind === 'pdf') {
    if (!looksLikePdf(bytes)) throw mismatch()
  } else if (type.kind === 'image') {
    checkImage(extension, bytes, view)
  } else if (type.kind === 'video') {
    checkVideo(bytes, view)
  } else if (main !== undefined) {
    await checkOoxml(main, bytes)
  } else if (type.mediaType.startsWith(ODF)) {
    await checkOdf(type.mediaType, bytes)
  } else {
    checkText(bytes)
  }
}
