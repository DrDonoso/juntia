import { describe, expect, test } from 'vitest'
import { demoPdf, zipArchive } from '../core'
import { foldText } from './community-text'
import { cleanText, readDocumentText, textExcerpt } from './shared-document-text'

const encoder = new TextEncoder()
const modified = { year: 2026, month: 10, day: 29, hour: 12, minute: 0, second: 0 }
const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'

function zipped(parts: Record<string, string>): Uint8Array<ArrayBuffer> {
  return zipArchive(Object.entries(parts).map(([path, data]) => ({ path, data: encoder.encode(data), modified })))
}

async function deflated(text: string): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new CompressionStream('deflate')
  const writer = stream.writable.getWriter()
  void writer.write(encoder.encode(text))
  void writer.close()
  const chunks: Uint8Array[] = []
  const reader = stream.readable.getReader()
  for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) chunks.push(chunk.value)
  const bytes = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0))
  chunks.reduce((offset, chunk) => (bytes.set(chunk, offset), offset + chunk.length), 0)
  return bytes
}

/** A PDF whose page draws its text from a compressed content stream, as most PDF producers do. */
async function compressedPdf(text: string): Promise<Uint8Array<ArrayBuffer>> {
  const content = await deflated(`BT /F1 12 Tf 72 720 Td (${text}) Tj ET`)
  const head = encoder.encode('%PDF-1.7\n1 0 obj\n<< /Type /Page >>\nendobj\n2 0 obj\n<< /Length ' + content.length + ' /Filter /FlateDecode >>\nstream\n')
  const tail = encoder.encode('\nendstream\nendobj\n%%EOF\n')
  const bytes = new Uint8Array(head.length + content.length + tail.length)
  bytes.set(head)
  bytes.set(content, head.length)
  bytes.set(tail, head.length + content.length)
  return bytes
}

describe('the text of shared documents', () => {
  test('is cleaned onto one line like the server does', () => {
    expect(cleanText('Comu-\nnidad de\u00a0pro\u00adpietarios (cid:12)\tAlfa-\nBeta\u0000\ufffd\ue000 cuota')).toBe('Comunidad de propietarios Alfa- Beta cuota')
    expect(cleanText('Reunio\u0301n')).toBe('Reunión')
  })

  test('is read from text files, office files and PDFs; pictures wait for OCR', async () => {
    expect(await readDocumentText(Uint8Array.from('Reuni\xf3n de vecinos\n', character => character.charCodeAt(0)), 'txt'))
      .toEqual({ content: 'Reunión de vecinos', needsOcr: false, partial: false })
    const word = zipped({
      'word/document.xml': `<w:document ${W}><w:body><w:p><w:r><w:t>Presupuesto del </w:t></w:r><w:r><w:t>ascensor</w:t></w:r></w:p>`
        + '<w:p><w:r><w:t>Segunda</w:t><w:tab/><w:t>l&#237;nea &amp; m&#xE1;s</w:t></w:r></w:p>'
        + '<w:p><w:r><w:instrText>PAGE</w:instrText><w:delText>borrado</w:delText></w:r></w:p></w:body></w:document>',
    })
    expect(await readDocumentText(word, 'docx')).toEqual({ content: 'Presupuesto del ascensor Segunda línea & más', needsOcr: false, partial: false })
    const sheet = zipped({
      'xl/sharedStrings.xml': '<sst><si><t>Fontanería</t></si><si><r><t>Agua </t></r><r><t>caliente</t></r><rPh><t>x</t></rPh></si></sst>',
      'xl/worksheets/sheet2.xml': '<worksheet><sheetData><row><c t="inlineStr"><is><t>Portal</t></is></c><c t="b"><v>1</v></c></row></sheetData></worksheet>',
      'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row><c t="s"><v>0</v></c><c><v>620.5</v></c><c><f>B1*2</f><v>1241</v></c></row>'
        + '<row><c t="s"><v>1</v></c><c t="s"><v>9</v></c></row></sheetData></worksheet>',
    })
    expect((await readDocumentText(sheet, 'xlsx') as { content: string }).content).toBe('Fontanería 620.5 1241 Agua caliente Portal')
    const slides = zipped(Object.fromEntries([10, 2, 1].map(number => [
      `ppt/slides/slide${number}.xml`, `<p:sld><a:p><a:r><a:t>Diapositiva</a:t></a:r><a:br/><a:r><a:t>${number}</a:t></a:r></a:p></p:sld>`,
    ])))
    expect((await readDocumentText(slides, 'pptx') as { content: string }).content).toBe('Diapositiva 1 Diapositiva 2 Diapositiva 10')
    const text = zipped({
      'content.xml': '<office:document-content><office:body><office:text><text:h>Normas</text:h>'
        + '<text:p>Horario<text:s/>de<text:tab/><text:span>silencio</text:span></text:p></office:text></office:body></office:document-content>',
    })
    expect((await readDocumentText(text, 'odt') as { content: string }).content).toBe('Normas Horario de silencio')
    expect(await readDocumentText(zipped({ 'word/document.xml': '<!DOCTYPE w [<!ENTITY x "boom">]><w:t>&x;</w:t>' }), 'docx'))
      .toEqual({ error: 'damaged' })
    expect((await readDocumentText(demoPdf('House rules', ['1. Quiet hours (22:00)', '', '2. Rubbish']), 'pdf') as { content: string }).content)
      .toBe('House rules 1. Quiet hours (22:00) 2. Rubbish')
    expect(await readDocumentText(await compressedPdf('Compressed minutes'), 'pdf')).toEqual({ content: 'Compressed minutes', needsOcr: false, partial: false })
    expect(await readDocumentText(encoder.encode('%PDF-1.7\n<< /Type /Page >>\n%%EOF\n'), 'pdf')).toEqual({ content: '', needsOcr: true, partial: false })
    expect(await readDocumentText(encoder.encode('%PDF-1.7\n<< /Encrypt 5 0 R >>\n%%EOF\n'), 'pdf')).toEqual({ error: 'encrypted' })
    expect(await readDocumentText(encoder.encode('%PDF-1.7\n% not really a PDF\n%%EOF\n'), 'pdf')).toEqual({ error: 'damaged' })
    expect(await readDocumentText(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), 'png')).toEqual({ content: '', needsOcr: true, partial: false })
  })

  test.each([
    ['La Reunión de VECINOS será el lunes.', 'reunion de vecinos', ['La ', 'Reunión de VECINOS', ' será el lunes.']],
    ['Die Straße ist lang', 'strasse', ['Die ', 'Straße', ' ist lang']],
    ['sin coincidencias', 'ascensor', null],
  ])('excerpts show the original text around the match: %s', (content, needle, expected) => {
    const found = textExcerpt(content, foldText(needle))
    expect(found && [found.before, found.match, found.after]).toEqual(expected)
  })

  test('long excerpts are cut at words', () => {
    const content = `${Array.from({ length: 600 }, (_, number) => `palabra${number}`).join(' ')} Ascensor averiado ${Array.from({ length: 200 }, (_, number) => `final${number}`).join(' ')}`
    const found = textExcerpt(content, 'ascensor averiado')!
    expect(found.match).toBe('Ascensor averiado')
    expect(found.before).toMatch(/^…palabra\d+ .* palabra599 $/)
    expect(found.after).toMatch(/^ final0 .* final\d+…$/)
    expect(found.before.length).toBeLessThanOrEqual(82)
    expect(found.after.length).toBeLessThanOrEqual(162)
  })
})
