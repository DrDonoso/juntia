import { describe, expect, test } from 'vitest'
import { demoPdf, fileDisposition, looksLikePdf, pdfResponse } from './pdf'

const text = (bytes: Uint8Array) => new TextDecoder('latin1').decode(bytes)

describe('demo PDFs', () => {
  test('are complete PDF documents whose cross-reference table points at every object', () => {
    const body = text(demoPdf('Statement September', ['01/09 Cleaning -84.00', '15/09 Water -112.40']))
    expect(body.startsWith('%PDF-1.4\n')).toBe(true)
    expect(body.endsWith('%%EOF\n')).toBe(true)
    const xref = Number(body.match(/startxref\n(\d+)\n/)?.[1])
    expect(body.slice(xref, xref + 4)).toBe('xref')
    const offsets = [...body.slice(xref).matchAll(/^(\d{10}) 00000 n $/gm)].map(match => Number(match[1]))
    expect(offsets).toHaveLength(5)
    offsets.forEach((offset, index) => expect(body.slice(offset).startsWith(`${index + 1} 0 obj`)).toBe(true))
    const stream = body.match(/<< \/Length (\d+) >>\nstream\n([\s\S]*?)\nendstream/)
    expect(Number(stream?.[1])).toBe(stream?.[2].length)
    expect(body).toContain('(15/09 Water -112.40) Tj')
  })

  test('escape PDF string delimiters and replace characters outside ASCII', () => {
    const body = text(demoPdf('Quote (draft) \\ v2', ['Caf\u00e9 \u20ac12']))
    expect(body).toContain('(Quote \\(draft\\) \\\\ v2) Tj')
    expect(body).toContain('(Caf? ?12) Tj')
  })

  test('pass the backend upload check', () => {
    expect(looksLikePdf(demoPdf('Minutes'))).toBe(true)
    expect(looksLikePdf(new TextEncoder().encode('not a pdf %%EOF'))).toBe(false)
    expect(looksLikePdf(new TextEncoder().encode('%PDF-1.7 truncated'))).toBe(false)
  })

  test('are served with the backend Content-Disposition forms', async () => {
    expect(fileDisposition('attachment', 'statement-2026-09.pdf')).toBe('attachment; filename="statement-2026-09.pdf"')
    expect(fileDisposition('inline', 'roof quote.pdf')).toBe("inline; filename*=utf-8''roof%20quote.pdf")
    const response = pdfResponse(demoPdf('Roof quote'), 'roof quote.pdf', 'inline')
    expect(response.headers.get('Content-Type')).toBe('application/pdf')
    expect(response.headers.get('Content-Disposition')).toBe("inline; filename*=utf-8''roof%20quote.pdf")
    expect(looksLikePdf(new Uint8Array(await response.arrayBuffer()))).toBe(true)
  })
})
