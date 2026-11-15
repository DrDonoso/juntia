import { describe, expect, test } from 'vitest'
import { crc32, readZip, readZipMember, zipArchive, type ZipEntry } from './zip'

const encoder = new TextEncoder()
const MODIFIED = { year: 2026, month: 10, day: 29, hour: 13, minute: 45, second: 58 }
// Typed arrays of the test and of the module may come from different realms: compare their bytes.
const bytes = (value: Uint8Array | null) => value && Array.from(value)

/** The central directory as an unzip tool reads it: from the end record, independently of `readZip`. */
function centralDirectory(archive: Uint8Array) {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength)
  const end = archive.length - 22
  expect(view.getUint32(end, true)).toBe(0x06054b50)
  const count = view.getUint16(end + 10, true), size = view.getUint32(end + 12, true)
  let position = view.getUint32(end + 16, true)
  expect(position + size).toBe(end)
  return Array.from({ length: count }, () => {
    expect(view.getUint32(position, true)).toBe(0x02014b50)
    const nameLength = view.getUint16(position + 28, true)
    const entry = {
      flags: view.getUint16(position + 8, true), method: view.getUint16(position + 10, true),
      time: view.getUint16(position + 12, true), date: view.getUint16(position + 14, true), crc: view.getUint32(position + 16, true),
      compressed: view.getUint32(position + 20, true), size: view.getUint32(position + 24, true),
      attributes: view.getUint32(position + 38, true), offset: view.getUint32(position + 42, true),
      name: new TextDecoder().decode(archive.subarray(position + 46, position + 46 + nameLength)),
    }
    position += 46 + nameLength + view.getUint16(position + 30, true) + view.getUint16(position + 32, true)
    return entry
  })
}

/** Deflated bytes, as office files store their parts. */
async function deflate(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new CompressionStream('deflate-raw')
  const writer = stream.writable.getWriter()
  void writer.write(data)
  void writer.close()
  return new Uint8Array(await new Response(stream.readable).arrayBuffer())
}

/** The archive of one member, deflated instead of stored, as office files keep their parts. */
async function deflated(name: string, data: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const stored = zipArchive([{ path: name, data, modified: MODIFIED }])
  const compressed = await deflate(data)
  const header = 30 + encoder.encode(name).length
  const output = new Uint8Array(stored.length - data.length + compressed.length)
  output.set(stored.subarray(0, header))
  output.set(compressed, header)
  output.set(stored.subarray(header + data.length), header + compressed.length)
  const view = new DataView(output.buffer)
  const directory = header + compressed.length
  view.setUint16(8, 8, true)
  view.setUint32(18, compressed.length, true)
  view.setUint16(directory + 10, 8, true)
  view.setUint32(directory + 20, compressed.length, true)
  view.setUint32(output.length - 6, directory, true)
  return output
}

describe('ZIP archives', () => {
  test('CRC-32 is the standard checksum', () => {
    expect(crc32(encoder.encode('123456789'))).toBe(0xcbf43926)
    expect(crc32(new Uint8Array())).toBe(0)
  })

  test('store every entry with its CRC, UTF-8 names and the folder structure, readable by any unzip tool', () => {
    const minutes = encoder.encode('%PDF-1.4 synthetic minutes %%EOF\n'), notes = encoder.encode('Zo\u00eb took the notes.\n')
    const entries: ZipEntry[] = [
      { path: 'Maple Court/', data: null, modified: MODIFIED },
      { path: 'Maple Court/Minutes.pdf', data: minutes, modified: MODIFIED },
      { path: 'Maple Court/Zo\u00eb/', data: null, modified: { ...MODIFIED, year: 1975 } },
      { path: 'Maple Court/Zo\u00eb/\u00c5ngstr\u00f6m notes.txt', data: notes, modified: MODIFIED },
    ]
    const archive = zipArchive(entries)
    const directory = centralDirectory(archive)
    expect(directory.map(entry => entry.name)).toEqual(entries.map(entry => entry.path))
    const view = new DataView(archive.buffer)
    directory.forEach((entry, index) => {
      const data = entries[index].data ?? new Uint8Array()
      expect(entry).toMatchObject({ flags: 0x800, method: 0, crc: crc32(data), compressed: data.length, size: data.length })
      expect(entry.attributes).toBe(entries[index].data === null ? ((0o40755 << 16) | 0x10) >>> 0 : 0o644 << 16)
      // The local header repeats the name and the CRC, and the data follows it.
      expect(view.getUint32(entry.offset, true)).toBe(0x04034b50)
      expect(view.getUint32(entry.offset + 14, true)).toBe(entry.crc)
      const name = entry.offset + 30, length = view.getUint16(entry.offset + 26, true)
      expect(new TextDecoder().decode(archive.subarray(name, name + length))).toBe(entry.name)
      expect(bytes(archive.subarray(name + length, name + length + data.length))).toEqual(bytes(data))
    })
    // MS-DOS times have two-second steps and start in 1980.
    expect(directory[1]).toMatchObject({ time: (13 << 11) | (45 << 5) | 29, date: (46 << 9) | (10 << 5) | 29 })
    expect(directory[2].date).toBe((0 << 9) | (10 << 5) | 29)
  })

  test('read back stored and deflated members, checking their CRC', async () => {
    const data = encoder.encode('<Types><Override ContentType="main+xml"/></Types>'.repeat(20))
    const stored = zipArchive([{ path: '[Content_Types].xml', data, modified: MODIFIED }])
    const [record] = readZip(stored) ?? []
    expect(record).toMatchObject({ name: '[Content_Types].xml', method: 0, size: data.length, offset: 0 })
    expect(bytes(await readZipMember(stored, record, 1024 * 1024))).toEqual(bytes(data))
    expect(await readZipMember(stored, record, data.length - 1)).toBeNull()
    const compressed = await deflated('[Content_Types].xml', data)
    const [inflated] = readZip(compressed) ?? []
    expect(inflated).toMatchObject({ method: 8, size: data.length })
    expect(inflated.compressedSize).toBeLessThan(data.length)
    expect(bytes(await readZipMember(compressed, inflated, 1024 * 1024))).toEqual(bytes(data))
    expect(await readZipMember(compressed, { ...inflated, crc32: inflated.crc32 ^ 1 }, 1024 * 1024)).toBeNull()
    // Bytes before the archive (a self-extracting stub) shift the offsets it records.
    const prefixed = new Uint8Array(16 + stored.length)
    prefixed.set(stored, 16)
    const [shifted] = readZip(prefixed) ?? []
    expect(shifted.offset).toBe(16)
    expect(bytes(await readZipMember(prefixed, shifted, 1024 * 1024))).toEqual(bytes(data))
  })

  test('refuse what is not a readable archive', () => {
    const archive = zipArchive([{ path: 'a.txt', data: encoder.encode('a'), modified: MODIFIED }, { path: 'b.txt', data: encoder.encode('b'), modified: MODIFIED }])
    expect(readZip(encoder.encode('not an archive at all, just text'))).toBeNull()
    expect(readZip(archive.subarray(0, archive.length - 1))).toBeNull()
    expect(readZip(archive, 1)).toBeNull()
    expect(readZip(archive)?.map(record => record.name)).toEqual(['a.txt', 'b.txt'])
  })
})
