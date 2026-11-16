/**
 * The text of shared documents for the search (src/juntia/document_text.py and
 * document_index.py). The server reads each new current version in the background; the demo reads
 * what waits as soon as a request needs it, so files are found by their text at once. Like a server
 * without Tesseract, it does not read scanned pages or pictures: they wait for OCR.
 *
 * - Text and CSV files, in the encoding the portal's viewer recognizes.
 * - Word, Excel and PowerPoint (OOXML) and OpenDocument files: the text of their XML parts.
 * - PDFs: the text their pages draw with simple fonts, such as the demo's own PDFs.
 */
import type { DocumentExcerpt, DocumentTextFileOut } from '../../api/schema.gen'
import { readZip, readZipMember, type ZipRecord } from '../core/zip'
import { foldText } from './community-text'

export type DocumentTextError = NonNullable<DocumentTextFileOut['error']>

/** `READABLE`: videos and HEIC pictures are only found by their names. */
export const READABLE_EXTENSIONS: ReadonlySet<string> = new Set([
  'pdf', 'txt', 'csv', 'docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp', 'jpg', 'jpeg', 'png', 'gif', 'webp',
])
const PICTURES = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp'])
export const MAX_TEXT_CHARACTERS = 500_000
const MAX_TEXT_BYTES = 2 * 1024 * 1024
const MAX_XML_BYTES = 64 * 1024 * 1024
const MAX_PDF_STREAM_BYTES = 16 * 1024 * 1024
const EXCERPT_BEFORE = 80
const EXCERPT_AFTER = 160

/** A version's row of `document_texts`. */
export interface DemoText {
  status: 'pending' | 'ready' | 'failed'
  /** On one line; a reading that fails keeps the earlier text. */
  content: string
  /** `content_key`: the content without case and accents, which the search compares. */
  key: string
  ocrPages: number
  /** Scanned pages or a picture went unread: the demo has no OCR. */
  needsOcr: boolean
  partial: boolean
  error: DocumentTextError | null
  createdAt: string
  updatedAt: string
  /** The latest reading; null until it is first read. */
  readAt: string | null
}

/** A new version waits to be read. */
export function queuedText(at: string): DemoText {
  return {
    status: 'pending', content: '', key: '', ocrPages: 0, needsOcr: false, partial: false, error: null, createdAt: at, updatedAt: at,
    readAt: null,
  }
}

/** `clean`: NFC text on one line, without control, invisible or private characters; split words joined again. */
export function cleanText(text: string): string {
  return text
    .replace(/\(cid:\d+\)/g, ' ')
    .replace(/\p{Cf}+/gu, '')
    .replace(/(\p{L})-[ \t]*\r?\n\s*(\p{L})/gu, (match, left: string, right: string) =>
      right === right.toLowerCase() && right !== right.toUpperCase() ? left + right : match)
    .replace(/[\p{Cc}\p{Cs}\p{Co}\p{Cn}\uFFFD]+/gu, ' ')
    .normalize('NFC')
    .split(/\s+/u).filter(Boolean).join(' ')
}

class Reading {
  parts: string[] = []
  length = 0
  needsOcr = false
  partial = false
  full = false

  /** Keeps the text; false once it is full. */
  add(text: string): boolean {
    let clean = cleanText(text)
    if (!clean) return !this.full
    const room = MAX_TEXT_CHARACTERS - this.length - (this.parts.length ? 1 : 0)
    if (clean.length > room) {
      this.partial = this.full = true
      clean = clean.slice(0, Math.max(room, 0))
      const cut = clean.lastIndexOf(' ')
      if (cut > 0) clean = clean.slice(0, cut)
    }
    if (clean) {
      this.length += clean.length + (this.parts.length ? 1 : 0)
      this.parts.push(clean)
    }
    return !this.full
  }
}

class Unreadable extends Error {
  constructor(readonly reason: DocumentTextError) {
    super(reason)
  }
}

/** Like the viewer (`decodeText`): UTF-8 or UTF-16 with a byte order mark, UTF-8, or else Windows-1252. */
function decode(bytes: Uint8Array, partial: boolean): string {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return new TextDecoder('utf-8').decode(bytes.subarray(3))
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2))
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2))
  for (let cut = 0; cut <= (partial ? 3 : 0); cut++) {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, bytes.length - cut))
    } catch {
      // Not UTF-8, or cut inside a character.
    }
  }
  return new TextDecoder('windows-1252').decode(bytes)
}

// --- XML parts of office files ---

type XmlToken = { kind: 'start'; name: string; attributes: string; empty: boolean } | { kind: 'end'; name: string } | { kind: 'text'; text: string }

const ENTITIES: Readonly<Record<string, string>> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }

function unescapeXml(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (match, entity: string) => {
    if (entity[0] !== '#') return ENTITIES[entity] ?? match
    const code = entity[1] === 'x' || entity[1] === 'X' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10)
    return code <= 0x10ffff ? String.fromCodePoint(code) : match
  })
}

/** Elements by their local names, whatever prefix the producer chose; declarations and DTDs are refused. */
function* xmlTokens(xml: string): Generator<XmlToken> {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Unreadable('damaged')
  for (const match of xml.matchAll(/<(\/?)([^\s/>!?]+)([^>]*?)(\/?)>|<[!?][^>]*>|([^<]+)/g)) {
    const [, closing, qualified, attributes, empty, text] = match
    if (text !== undefined) yield { kind: 'text', text: unescapeXml(text) }
    else if (qualified !== undefined) {
      const name = qualified.slice(qualified.indexOf(':') + 1)
      if (closing) yield { kind: 'end', name }
      else {
        yield { kind: 'start', name, attributes: attributes ?? '', empty: Boolean(empty) }
        if (empty) yield { kind: 'end', name }
      }
    }
  }
}

/** Word documents and PowerPoint slides: the text runs of their paragraphs. */
function runText(xml: string): string {
  let depth = 0, text = ''
  for (const token of xmlTokens(xml)) {
    if (token.kind === 'start') {
      if (token.name === 't' && !token.empty) depth += 1
      else if (token.name === 'tab' || token.name === 'ptab') text += ' '
      else if (token.name === 'br' || token.name === 'cr') text += '\n'
    } else if (token.kind === 'end') {
      if (token.name === 't' && depth > 0) depth -= 1
      else if (token.name === 'p') text += '\n'
    } else if (depth > 0) text += token.text
  }
  return text
}

/** The strings of an Excel workbook, which its cells refer to by number (phonetic guides left out). */
function sharedStrings(xml: string): string[] {
  const strings: string[] = []
  let current = '', depth = 0, phonetic = 0
  for (const token of xmlTokens(xml)) {
    if (token.kind === 'start') {
      if (token.name === 'si') current = ''
      else if (token.name === 't' && !token.empty) depth += 1
      else if (token.name === 'rPh' && !token.empty) phonetic += 1
    } else if (token.kind === 'end') {
      if (token.name === 'si') strings.push(current)
      else if (token.name === 't' && depth > 0) depth -= 1
      else if (token.name === 'rPh' && phonetic > 0) phonetic -= 1
    } else if (depth > 0 && !phonetic) current += token.text
  }
  return strings
}

/** The values of an Excel worksheet's cells, row by row: texts and numbers, not formulas. */
function sheetText(xml: string, strings: readonly string[]): string {
  let text = '', kind = '', value = '', inside = false
  for (const token of xmlTokens(xml)) {
    if (token.kind === 'start') {
      if (token.name === 'c') {
        kind = /(?:^|\s)t\s*=\s*["']([^"']*)["']/.exec(token.attributes)?.[1] ?? ''
        value = ''
      } else if ((token.name === 'v' || token.name === 't') && !token.empty) inside = true
    } else if (token.kind === 'end') {
      if (token.name === 'v' || token.name === 't') inside = false
      else if (token.name === 'c') {
        let cell = value.trim()
        if (kind === 's') cell = /^\d+$/.test(cell) ? strings[Number(cell)] ?? '' : ''
        else if (kind === 'b' || kind === 'e') cell = ''
        if (cell) text += `${cell} `
      } else if (token.name === 'row') text += '\n'
    } else if (inside) value += token.text
  }
  return text
}

/** The paragraphs and headings of an OpenDocument text, spreadsheet or presentation. */
function openDocumentText(xml: string): string {
  let depth = 0, text = ''
  for (const token of xmlTokens(xml)) {
    if (token.kind === 'start') {
      if ((token.name === 'p' || token.name === 'h') && !token.empty) depth += 1
      else if (depth && (token.name === 's' || token.name === 'tab')) text += ' '
      else if (depth && token.name === 'line-break') text += '\n'
    } else if (token.kind === 'end') {
      if ((token.name === 'p' || token.name === 'h') && depth > 0) {
        depth -= 1
        text += '\n'
      }
    } else if (depth > 0) text += token.text
  }
  return text
}

function natural(left: string, right: string): number {
  return left.localeCompare(right, 'en', { numeric: true })
}

async function readOffice(bytes: Uint8Array<ArrayBuffer>, extension: string, reading: Reading): Promise<void> {
  const records = readZip(bytes)
  if (records === null) throw new Unreadable('damaged')
  const named = new Map(records.map(record => [record.name.toLowerCase(), record]))
  const parts = (pattern: RegExp): ZipRecord[] =>
    [...named.keys()].filter(name => pattern.test(name)).sort(natural).map(name => named.get(name) as ZipRecord)
  let budget = MAX_XML_BYTES
  // What exceeds the XML read of one file is left out, like on the server.
  const member = async (record: ZipRecord): Promise<string | null> => {
    if (record.size > budget) {
      reading.partial = true
      return null
    }
    const data = await readZipMember(bytes, record, budget)
    if (data === null) throw new Unreadable('damaged')
    budget -= data.length
    return new TextDecoder('utf-8').decode(data)
  }
  let read: (xml: string) => string = runText
  let chosen: ZipRecord[]
  if (extension === 'docx') {
    chosen = [...parts(/^word\/document\.xml$/), ...parts(/^word\/(?:header|footer)\d*\.xml$/), ...parts(/^word\/(?:footnotes|endnotes)\.xml$/)]
  } else if (extension === 'pptx') {
    chosen = parts(/^ppt\/slides\/slide\d+\.xml$/)
  } else if (extension === 'xlsx') {
    const strings: string[] = []
    for (const record of parts(/^xl\/sharedstrings\.xml$/)) {
      const xml = await member(record)
      if (xml !== null) strings.push(...sharedStrings(xml))
    }
    chosen = parts(/^xl\/worksheets\/sheet\d+\.xml$/)
    read = xml => sheetText(xml, strings)
  } else {
    chosen = parts(/^content\.xml$/)
    read = openDocumentText
  }
  for (const record of chosen) {
    const xml = await member(record)
    if (xml === null || !reading.add(read(xml))) break
  }
}

// --- PDFs ---

/** A FlateDecode stream, as much of it as inflates (streams often end with stray bytes). */
async function inflatePdfStream(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new DecompressionStream('deflate')
  const writer = stream.writable.getWriter()
  writer.write(data).catch(() => undefined)
  writer.close().catch(() => undefined)
  const reader = stream.readable.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      total += value.length
      if (total > MAX_PDF_STREAM_BYTES) {
        reader.cancel().catch(() => undefined)
        break
      }
    }
  } catch {
    // Keep what inflated before the error.
  }
  const output = new Uint8Array(total)
  let position = 0
  for (const chunk of chunks) {
    output.set(chunk, position)
    position += chunk.length
  }
  return output
}

const PDF_ESCAPES: Readonly<Record<string, string>> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' }

/** A PDF literal string, in the WinAnsi encoding of simple fonts. */
function pdfString(value: string): string {
  return value.replace(/\\([0-7]{1,3}|[\s\S])/g, (_, escaped: string) =>
    /^[0-7]/.test(escaped) ? String.fromCharCode(parseInt(escaped, 8) & 0xff) : PDF_ESCAPES[escaped] ?? (escaped === '\n' ? '' : escaped))
}

/** The text a content stream draws: strings shown with Tj, ' and " on lines, and the strings of TJ arrays. */
function pageText(content: string): string {
  const lines: string[] = []
  const operators = /\[((?:\((?:\\[\s\S]|[^\\)])*\)|[^\]])*)\]\s*TJ|\(((?:\\[\s\S]|[^\\)])*)\)\s*(?:Tj|'|")|(T\*|ET)\b/g
  let line = ''
  for (const [, array, single, breaks] of content.matchAll(operators)) {
    if (breaks !== undefined) {
      lines.push(line)
      line = ''
    } else if (single !== undefined) {
      line += pdfString(single)
      lines.push(line)
      line = ''
    } else if (array !== undefined) {
      line += [...array.matchAll(/\(((?:\\[\s\S]|[^\\)])*)\)/g)].map(([, part]) => pdfString(part)).join('')
    }
  }
  lines.push(line)
  return lines.filter(Boolean).join('\n')
}

async function readPdf(bytes: Uint8Array<ArrayBuffer>, reading: Reading): Promise<void> {
  const raw = new TextDecoder('latin1').decode(bytes)
  if (/\/Encrypt\b/.test(raw)) throw new Unreadable('encrypted')
  if (!/\/Type\s*\/Page\b/.test(raw)) throw new Unreadable('damaged')
  let found = false
  const keyword = /\bstream\r?\n/g
  for (let match = keyword.exec(raw); match !== null; match = keyword.exec(raw)) {
    const start = match.index + match[0].length
    const end = raw.indexOf('endstream', start)
    if (end < 0) break
    // The next search starts after this stream, whose bytes may look like anything.
    keyword.lastIndex = end + 'endstream'.length
    const object = raw.lastIndexOf(' obj', match.index)
    const dictionary = raw.slice(Math.max(object, 0), match.index)
    if (/\/Subtype\s*\/Image\b/.test(dictionary)) continue
    let content = raw.slice(start, end)
    if (/\/FlateDecode\b/.test(dictionary)) {
      content = new TextDecoder('latin1').decode(await inflatePdfStream(bytes.slice(start, end)))
    } else if (/\/Filter\b/.test(dictionary)) continue
    const text = pageText(content)
    if (text) {
      found = true
      if (!reading.add(text)) return
    }
  }
  // Scanned pages, or text the demo cannot decode: what a server without OCR leaves for later.
  if (!found) reading.needsOcr = true
}

/** `extract`: the text of a stored file, or why it could not be read. */
export async function readDocumentText(
  bytes: Uint8Array<ArrayBuffer>, extension: string,
): Promise<{ content: string; needsOcr: boolean; partial: boolean } | { error: DocumentTextError }> {
  const reading = new Reading()
  try {
    if (bytes.length === 0) throw new Unreadable('missing')
    if (extension === 'txt' || extension === 'csv') {
      const partial = bytes.length > MAX_TEXT_BYTES
      reading.partial = partial
      reading.add(decode(bytes.subarray(0, MAX_TEXT_BYTES), partial))
    } else if (['docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp'].includes(extension)) {
      await readOffice(bytes, extension, reading)
    } else if (extension === 'pdf') {
      await readPdf(bytes, reading)
    } else if (PICTURES.has(extension)) {
      reading.needsOcr = true
    } else {
      throw new Unreadable('failed')
    }
  } catch (error) {
    return { error: error instanceof Unreadable ? error.reason : 'damaged' }
  }
  return { content: reading.parts.join(' '), needsOcr: reading.needsOcr, partial: reading.partial }
}

/** Reads a waiting version's text, like the server's reader: a failure keeps the earlier text. */
export async function readText(text: DemoText, bytes: Uint8Array<ArrayBuffer>, extension: string, at: string): Promise<void> {
  const result = await readDocumentText(bytes, extension)
  text.readAt = text.updatedAt = at
  if ('error' in result) {
    Object.assign(text, { status: 'failed', error: result.error })
    return
  }
  Object.assign(text, {
    status: 'ready', error: null, content: result.content, key: foldText(result.content), ocrPages: 0, needsOcr: result.needsOcr,
    partial: result.partial,
  })
}

/**
 * `excerpt`: the first place where the text contains the folded needle, with the words around it.
 * Folding works character by character, so each character's folded length maps the match back.
 */
export function textExcerpt(content: string, needle: string): DocumentExcerpt | null {
  if (!needle || !content) return null
  const characters = Array.from(content)
  const folded: string[] = []
  const starts: number[] = []
  let length = 0
  for (const character of characters) {
    starts.push(length)
    const part = foldText(character)
    folded.push(part)
    length += part.length
  }
  const position = folded.join('').indexOf(needle)
  if (position < 0) return null
  const at = (offset: number) => {
    let index = 0
    while (index + 1 < characters.length && starts[index + 1] <= offset) index += 1
    return index
  }
  const start = at(position), end = at(position + needle.length - 1) + 1
  let left = Math.max(0, start - EXCERPT_BEFORE)
  if (left > 0) {
    const space = characters.indexOf(' ', left)
    if (space >= 0 && space < start) left = space + 1
  }
  let right = Math.min(characters.length, end + EXCERPT_AFTER)
  if (right < characters.length) {
    const space = characters.lastIndexOf(' ', right - 1)
    if (space > end) right = space
  }
  return {
    before: (left > 0 ? '…' : '') + characters.slice(left, start).join(''), match: characters.slice(start, end).join(''),
    after: characters.slice(end, right).join('') + (right < characters.length ? '…' : ''),
  }
}
