import { describe, expect, test } from 'vitest'
import { DemoApiError, zipArchive } from '../core'
import { checkContent, checkedName, documentName, nameKey, numbered, uploadName, versionFilename } from './shared-document-files'

const encoder = new TextEncoder()
const MODIFIED = { year: 2026, month: 10, day: 29, hour: 12, minute: 0, second: 0 }

function failure(action: () => unknown): { code: string; status: number; fields?: unknown } {
  try {
    action()
  } catch (error) {
    if (error instanceof DemoApiError) return { code: error.code, status: error.status, ...(error.fields ? { fields: error.fields } : {}) }
    throw error
  }
  throw new Error('Expected a DemoApiError')
}

function bytes(...parts: (string | number[] | Uint8Array)[]): Uint8Array<ArrayBuffer> {
  const chunks = parts.map(part => typeof part === 'string' ? Uint8Array.from(part, character => character.charCodeAt(0)) : Uint8Array.from(part))
  const output = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0))
  chunks.reduce((offset, chunk) => (output.set(chunk, offset), offset + chunk.length), 0)
  return output
}

function box(kind: string, body: string | Uint8Array): Uint8Array<ArrayBuffer> {
  const content = bytes(body)
  const length = 8 + content.length
  return bytes([length >>> 24, (length >>> 16) & 0xff, (length >>> 8) & 0xff, length & 0xff], kind, content)
}

const pdf = () => bytes('%PDF-1.7\n% Synthetic minutes\n\n%%EOF\n')
const png = () => bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13], 'IHDR', [0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0])
const mp4 = (brand = 'isom') => bytes(box('ftyp', `${brand}\0\0\0\0isomiso2mp41`), box('moov', '\0'.repeat(32)), box('mdat', 'v'.repeat(256)))
const heic = () => bytes(box('ftyp', 'heic\0\0\0\0mif1heic'), box('meta', '\0'.repeat(24)))
const archive = (...entries: (readonly [string, string])[]) =>
  zipArchive(entries.map(([path, data]) => ({ path, data: encoder.encode(data), modified: MODIFIED })))

function ooxml(kind = 'wordprocessingml.document', main = 'word/document.xml', ...extra: (readonly [string, string])[]) {
  const types = `<Types><Override PartName="/${main}" ContentType="application/vnd.openxmlformats-officedocument.${kind}.main+xml"/></Types>`
  return archive(['[Content_Types].xml', types], [main, '<document/>'], ...extra)
}

const odf = (kind = 'text', ...extra: (readonly [string, string])[]) =>
  archive(['mimetype', `application/vnd.oasis.opendocument.${kind}`], ['content.xml', '<office:document-content/>'], ...extra)

describe('names of shared documents', () => {
  test('uploaded names are made valid instead of refused, and their extension decides the type', () => {
    expect(uploadName('C:\\fakepath\\Meeting minutes.PDF')).toEqual({ name: 'Meeting minutes.PDF', extension: 'pdf' })
    expect(uploadName('../../etc/Budget: 2026?.xlsx')).toEqual({ name: 'Budget_ 2026_.xlsx', extension: 'xlsx' })
    expect(uploadName('con.pdf')).toEqual({ name: '_con.pdf', extension: 'pdf' })
    expect(uploadName('  .pdf')).toEqual({ name: 'document.pdf', extension: 'pdf' })
    expect(uploadName('IMG_0042.HEIC ')).toEqual({ name: 'IMG_0042.HEIC', extension: 'heic' })
    expect(uploadName(`${'x'.repeat(300)}.mov`)).toEqual({ name: `${'x'.repeat(196)}.mov`, extension: 'mov' })
    // A right-to-left override cannot disguise a program as a PDF.
    for (const name of [
      'invoice\u202efdp.exe', 'minutes', 'page.html', 'drawing.svg', 'photos.zip', 'macro.docm', 'old.doc', 'script.js', 'setup.msi',
      'notes.pdf.exe', 'x.constructor',
    ]) {
      expect(failure(() => uploadName(name)), name).toEqual({ code: 'document_type_unsupported', status: 415 })
    }
  })

  test('typed names must work on every system, and keep the extension of their file', () => {
    expect(checkedName('  Minutes \t of\n2026. ')).toBe('Minutes of 2026')
    for (const name of ['', ' . ', '..', 'a/b', 'a\\b', 'what?', 'AUX', 'com1.txt', 'lpt\u00b9', 'x'.repeat(201), '\u200b']) {
      expect(failure(() => checkedName(name)), JSON.stringify(name))
        .toEqual({ code: 'document_name_invalid', status: 422, fields: { name: 'document_name_invalid' } })
    }
    expect(documentName('New minutes', 'pdf')).toBe('New minutes.pdf')
    expect(documentName('New minutes.PDF', 'pdf')).toBe('New minutes.PDF')
    expect(documentName('minutes.docx', 'pdf')).toBe('minutes.docx.pdf')
    expect(failure(() => documentName(' .pdf', 'pdf'))).toMatchObject({ code: 'document_name_invalid' })
    // Unique ignoring case, spacing and Unicode forms.
    expect(nameKey('Minutes  2026')).toBe(nameKey('MINUTES 2026'))
    expect(nameKey('\uff2dinutes')).toBe(nameKey('minutes'))
  })

  test('numbered names and the names of earlier versions keep the extension', () => {
    expect(numbered('Report.pdf', 2, 'pdf')).toBe('Report (2).pdf')
    expect(numbered('Report.PDF', 3, 'pdf')).toBe('Report (3).PDF')
    expect(numbered('Photos', 3, null)).toBe('Photos (3)')
    expect(numbered('x'.repeat(200), 10, null)).toBe(`${'x'.repeat(195)} (10)`)
    expect(versionFilename('Report.pdf', 1, 3, 'pdf')).toBe('Report (version 1).pdf')
    expect(versionFilename('Report.pdf', 3, 3, 'pdf')).toBe('Report.pdf')
  })
})

describe('content checks', () => {
  test('accept files whose bytes match their extension', async () => {
    const accepted: (readonly [string, Uint8Array<ArrayBuffer>])[] = [
      ['pdf', pdf()], ['jpg', bytes([0xff, 0xd8, 0xff, 0xe0, 0, 16])], ['jpeg', bytes([0xff, 0xd8, 0xff, 0xdb])], ['png', png()],
      ['gif', bytes('GIF89a', [1, 0, 1, 0])], ['webp', bytes('RIFF', [26, 0, 0, 0], 'WEBPVP8 ')], ['heic', heic()], ['heif', heic()],
      ['docx', ooxml()], ['xlsx', ooxml('spreadsheetml.sheet', 'xl/workbook.xml')],
      ['pptx', ooxml('presentationml.presentation', 'ppt/presentation.xml')],
      // Embedded spreadsheets of charts are documents too, not programs.
      ['docx', ooxml('wordprocessingml.document', 'word/document.xml', ['word/embeddings/Microsoft_Excel_Worksheet.xlsx', 'PK'])],
      ['odt', odf()], ['ods', odf('spreadsheet')], ['odp', odf('presentation')],
      ['txt', encoder.encode('Minutes of the meeting\n')], ['csv', encoder.encode('flat,fee\n1A,30\n')],
      ['txt', bytes([0xff, 0xfe], 'T\0e\0x\0t\0')], ['mp4', mp4()], ['m4v', mp4()], ['mov', mp4('qt  ')],
      ['mov', bytes(box('moov', '\0'.repeat(8)), box('mdat', 'q'.repeat(9)))],
    ]
    for (const [extension, content] of accepted) await expect(checkContent(content, extension), extension).resolves.toBeUndefined()
  })

  test('refuse other files, and office files with macros, explaining why', async () => {
    const refused: (readonly [string, Uint8Array<ArrayBuffer>, string])[] = [
      ['pdf', png(), 'document_type_mismatch'], ['pdf', bytes('%PDF-1.7\nno end'), 'document_type_mismatch'],
      ['png', pdf(), 'document_type_mismatch'], ['jpg', png(), 'document_type_mismatch'], ['heic', mp4(), 'document_type_mismatch'],
      ['docx', odf(), 'document_type_mismatch'], ['xlsx', ooxml(), 'document_type_mismatch'],
      ['docx', bytes([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], '\0'.repeat(64)), 'document_type_mismatch'],
      ['odt', ooxml(), 'document_type_mismatch'], ['ods', odf(), 'document_type_mismatch'],
      ['txt', bytes('MZ', [0x90, 0, 3, 0, 0, 0]), 'document_type_mismatch'], ['csv', bytes('a,b\n', [0, 1]), 'document_type_mismatch'],
      ['mp4', mp4().subarray(0, mp4().length - 10), 'document_type_mismatch'],
      ['mp4', bytes(box('ftyp', 'isom\0\0\0\0isom'), box('mdat', 'v')), 'document_type_mismatch'],
      ['mp4', heic(), 'document_type_mismatch'], ['mov', png(), 'document_type_mismatch'],
      ['docx', ooxml('wordprocessingml.document', 'word/document.xml', ['word/vbaProject.bin', 'vba']), 'document_macros_unsupported'],
      ['xlsx', archive(['[Content_Types].xml', '<Types><Override ContentType="application/vnd.ms-excel.sheet.macroEnabled.main+xml"/></Types>']), 'document_macros_unsupported'],
      ['pptx', ooxml('presentationml.presentation', 'ppt/presentation.xml', ['ppt/activeX/activeX1.xml', '<ax/>']), 'document_macros_unsupported'],
      ['docx', ooxml('wordprocessingml.document', 'word/document.xml', ['word/embeddings/oleObject1.bin', 'ole']), 'document_macros_unsupported'],
      ['xlsx', ooxml('spreadsheetml.sheet', 'xl/workbook.xml', ['xl/macrosheets/sheet1.xml', '<xm/>']), 'document_macros_unsupported'],
      ['odt', odf('text', ['Basic/Standard/Module1.xml', '<script/>']), 'document_macros_unsupported'],
      ['ods', odf('spreadsheet', ['Scripts/python/macro.py', 'print()']), 'document_macros_unsupported'],
    ]
    for (const [extension, content, code] of refused) {
      await expect(checkContent(content, extension), `${extension} ${code}`).rejects.toMatchObject({ code, status: 415 })
    }
  })
})
