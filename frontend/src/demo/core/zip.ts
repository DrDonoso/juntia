/**
 * ZIP archives built and read in the browser, without dependencies. `zipArchive` writes what the
 * backend's `archive_chunks` (src/juntia/document_files.py) streams: every entry stored without
 * compression, named in UTF-8 (flag 0x800, folders included) and dated in MS-DOS time, which has
 * no time zone. `readZip` and `readZipMember` read an archive back, like Python's `zipfile` does
 * for the checks of uploaded office files (stored and deflated members, CRC-32 verified).
 * Neither writes nor reads ZIP64: archives stay under 4 GiB and 65,535 entries.
 */

/** A wall-clock date and time, as MS-DOS times store it (years before 1980 become 1980). */
export interface ZipTime {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
}

export interface ZipEntry {
  /** Path inside the archive; folders end with "/" and have no data. */
  path: string
  data: Uint8Array | null
  modified: ZipTime
}

/** An entry of the central directory. */
export interface ZipRecord {
  /** UTF-8 when flag 0x800 is set; other names are read as Latin-1 (close to the historical code page 437). */
  name: string
  flags: number
  method: number
  crc32: number
  compressedSize: number
  size: number
  /** Where its local header starts in the archive. */
  offset: number
}

const LOCAL_HEADER = 0x04034b50
const CENTRAL_HEADER = 0x02014b50
const END_OF_DIRECTORY = 0x06054b50
const LOCAL_HEADER_BYTES = 30
const CENTRAL_HEADER_BYTES = 46
const END_BYTES = 22
const UTF8_NAMES = 0x0800
// Encrypted, compressed patched data or strong encryption: Python's `zipfile` reads none of them.
const UNREADABLE = 0x0061
const STORED = 0
const DEFLATED = 8
const VERSION = 20
// Made by Unix (3), so that unzip tools apply the permissions below.
const MADE_BY = (3 << 8) | VERSION
// A directory readable by everyone, in Unix and MS-DOS terms, and a file readable by everyone.
const FOLDER_ATTRIBUTES = ((0o40755 << 16) | 0x10) >>> 0
const FILE_ATTRIBUTES = (0o644 << 16) >>> 0
const MAX_32 = 0xffffffff
const MAX_ENTRIES = 0xffff

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    table[index] = value >>> 0
  }
  return table
})()

/** CRC-32 of `bytes`, the checksum of ZIP entries (and of PNG chunks). */
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (let index = 0; index < bytes.length; index += 1) crc = CRC_TABLE[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function dosTime({ hour, minute, second }: ZipTime): number {
  return (hour << 11) | (minute << 5) | (second >> 1)
}

function dosDate({ year, month, day }: ZipTime): number {
  return ((Math.min(Math.max(year, 1980), 2107) - 1980) << 9) | (month << 5) | day
}

/** A ZIP of `entries`, in their order, with their data stored as is (RangeError beyond 4 GiB or 65,535 entries). */
export function zipArchive(entries: readonly ZipEntry[]): Uint8Array<ArrayBuffer> {
  const encoder = new TextEncoder()
  const items = entries.map(entry => {
    const data = entry.data ?? new Uint8Array(0)
    return {
      name: encoder.encode(entry.path), data, folder: entry.data === null, crc: crc32(data),
      time: dosTime(entry.modified), date: dosDate(entry.modified),
    }
  })
  const local = items.reduce((sum, item) => sum + LOCAL_HEADER_BYTES + item.name.length + item.data.length, 0)
  const central = items.reduce((sum, item) => sum + CENTRAL_HEADER_BYTES + item.name.length, 0)
  if (items.length > MAX_ENTRIES || local + central > MAX_32) throw new RangeError('The archive needs ZIP64')
  const output = new Uint8Array(local + central + END_BYTES)
  const view = new DataView(output.buffer)
  const offsets: number[] = []
  let position = 0
  for (const item of items) {
    offsets.push(position)
    view.setUint32(position, LOCAL_HEADER, true)
    view.setUint16(position + 4, VERSION, true)
    view.setUint16(position + 6, UTF8_NAMES, true)
    view.setUint16(position + 8, STORED, true)
    view.setUint16(position + 10, item.time, true)
    view.setUint16(position + 12, item.date, true)
    view.setUint32(position + 14, item.crc, true)
    view.setUint32(position + 18, item.data.length, true)
    view.setUint32(position + 22, item.data.length, true)
    view.setUint16(position + 26, item.name.length, true)
    output.set(item.name, position + LOCAL_HEADER_BYTES)
    output.set(item.data, position + LOCAL_HEADER_BYTES + item.name.length)
    position += LOCAL_HEADER_BYTES + item.name.length + item.data.length
  }
  const directory = position
  items.forEach((item, index) => {
    view.setUint32(position, CENTRAL_HEADER, true)
    view.setUint16(position + 4, MADE_BY, true)
    view.setUint16(position + 6, VERSION, true)
    view.setUint16(position + 8, UTF8_NAMES, true)
    view.setUint16(position + 10, STORED, true)
    view.setUint16(position + 12, item.time, true)
    view.setUint16(position + 14, item.date, true)
    view.setUint32(position + 16, item.crc, true)
    view.setUint32(position + 20, item.data.length, true)
    view.setUint32(position + 24, item.data.length, true)
    view.setUint16(position + 28, item.name.length, true)
    view.setUint32(position + 38, item.folder ? FOLDER_ATTRIBUTES : FILE_ATTRIBUTES, true)
    view.setUint32(position + 42, offsets[index], true)
    output.set(item.name, position + CENTRAL_HEADER_BYTES)
    position += CENTRAL_HEADER_BYTES + item.name.length
  })
  view.setUint32(position, END_OF_DIRECTORY, true)
  view.setUint16(position + 8, items.length, true)
  view.setUint16(position + 10, items.length, true)
  view.setUint32(position + 12, position - directory, true)
  view.setUint32(position + 16, directory, true)
  return output
}

function decodeName(bytes: Uint8Array, flags: number): string | null {
  if (!(flags & UTF8_NAMES)) return new TextDecoder('latin1').decode(bytes)
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}

/**
 * The central directory of a ZIP, found from its end record within the last 64 KiB, like Python's
 * `zipfile`: data prepended to the archive is allowed, and local offsets are corrected for it.
 * Null when the bytes are not a ZIP, or when it declares or holds more than `maxEntries` entries.
 */
export function readZip(bytes: Uint8Array, maxEntries = MAX_ENTRIES): ZipRecord[] | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let end = -1
  for (let position = bytes.length - END_BYTES; position >= Math.max(0, bytes.length - 65536 - END_BYTES); position -= 1) {
    if (view.getUint32(position, true) === END_OF_DIRECTORY) {
      end = position
      break
    }
  }
  if (end < 0 || view.getUint16(end + 10, true) > maxEntries) return null
  const directorySize = view.getUint32(end + 12, true)
  // Bytes before the archive shift every offset it records.
  const shift = end - directorySize - view.getUint32(end + 16, true)
  const start = end - directorySize
  if (start < 0) return null
  const records: ZipRecord[] = []
  let position = start
  while (position < end) {
    if (position + CENTRAL_HEADER_BYTES > end || view.getUint32(position, true) !== CENTRAL_HEADER) return null
    const flags = view.getUint16(position + 8, true)
    const nameLength = view.getUint16(position + 28, true)
    const next = position + CENTRAL_HEADER_BYTES + nameLength + view.getUint16(position + 30, true) + view.getUint16(position + 32, true)
    if (next > end) return null
    const name = decodeName(bytes.subarray(position + CENTRAL_HEADER_BYTES, position + CENTRAL_HEADER_BYTES + nameLength), flags)
    if (name === null) return null
    records.push({
      name, flags, method: view.getUint16(position + 10, true), crc32: view.getUint32(position + 16, true),
      compressedSize: view.getUint32(position + 20, true), size: view.getUint32(position + 24, true),
      offset: view.getUint32(position + 42, true) + shift,
    })
    if (records.length > maxEntries) return null
    position = next
  }
  return records
}

async function inflateRaw(data: Uint8Array<ArrayBuffer>, limit: number): Promise<Uint8Array<ArrayBuffer> | null> {
  const stream = new DecompressionStream('deflate-raw')
  const writer = stream.writable.getWriter()
  // Their failures surface when reading; a broken stream must not leave unhandled rejections.
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
      if (total > limit) {
        reader.cancel().catch(() => undefined)
        return null
      }
    }
  } catch {
    return null
  }
  const output = new Uint8Array(total)
  let position = 0
  for (const chunk of chunks) {
    output.set(chunk, position)
    position += chunk.length
  }
  return output
}

/**
 * The data of a member of at most `limit` bytes, stored or deflated, after checking its local
 * header and its CRC-32; null when it is larger, encrypted, compressed otherwise or damaged.
 */
export async function readZipMember(bytes: Uint8Array<ArrayBuffer>, record: ZipRecord, limit: number): Promise<Uint8Array<ArrayBuffer> | null> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const header = record.offset
  if (header < 0 || header + LOCAL_HEADER_BYTES > bytes.length || view.getUint32(header, true) !== LOCAL_HEADER) return null
  if (record.flags & UNREADABLE || record.size > limit) return null
  const nameLength = view.getUint16(header + 26, true)
  const start = header + LOCAL_HEADER_BYTES + nameLength + view.getUint16(header + 28, true)
  const name = decodeName(bytes.subarray(header + LOCAL_HEADER_BYTES, header + LOCAL_HEADER_BYTES + nameLength), view.getUint16(header + 6, true))
  if (name !== record.name || start + record.compressedSize > bytes.length) return null
  const compressed = bytes.subarray(start, start + record.compressedSize)
  const data = record.method === STORED ? compressed : record.method === DEFLATED ? await inflateRaw(compressed, limit) : null
  if (data === null || data.length < record.size) return null
  const member = data.subarray(0, record.size)
  return crc32(member) === record.crc32 ? member : null
}
