/**
 * Tiny, valid single-page PDFs for the demo's statement originals and action attachments: a title
 * and a few lines of Helvetica text, built in the browser without dependencies. Text is ASCII only
 * (other characters become "?"), so string lengths equal byte offsets.
 */
import { HttpResponse } from 'msw'

const MAX_LINES = 44
const encoder = new TextEncoder()

function pdfText(value: string): string {
  return value.replace(/[^\x20-\x7e]/g, '?').replace(/[\\()]/g, match => `\\${match}`)
}

/** A valid PDF 1.4 document whose first page shows `title` and up to 44 `lines`. */
export function demoPdf(title: string, lines: readonly string[] = []): Uint8Array<ArrayBuffer> {
  const content = [
    'BT', '/F1 18 Tf', '56 780 Td', `(${pdfText(title)}) Tj`, '/F1 11 Tf', '0 -30 Td',
    ...lines.slice(0, MAX_LINES).flatMap(line => [`(${pdfText(line)}) Tj`, '0 -16 Td']),
    'ET',
  ].join('\n')
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ]
  let body = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((object, index) => {
    offsets.push(body.length)
    body += `${index + 1} 0 obj\n${object}\nendobj\n`
  })
  const xref = body.length
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  body += offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return encoder.encode(body)
}

/** The backend's (Starlette's) Content-Disposition: quoted ASCII names, RFC 5987 otherwise. */
export function fileDisposition(kind: 'attachment' | 'inline', filename: string): string {
  const encoded = encodeURIComponent(filename)
  return encoded === filename ? `${kind}; filename="${filename}"` : `${kind}; filename*=utf-8''${encoded}`
}

/** A PDF download (`attachment`) or preview (`inline`) answered like the backend's FileResponse. */
export function pdfResponse(
  bytes: Uint8Array<ArrayBuffer>, filename: string, kind: 'attachment' | 'inline' = 'attachment',
): HttpResponse<Uint8Array<ArrayBuffer>> {
  return new HttpResponse(bytes, {
    headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': fileDisposition(kind, filename) },
  })
}

/** Whether uploaded bytes look like the PDFs the backend accepts (`%PDF-1.x` header, `%%EOF` tail). */
export function looksLikePdf(bytes: Uint8Array): boolean {
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 8))
  const tail = new TextDecoder('latin1').decode(bytes.subarray(Math.max(0, bytes.length - 65536)))
  return /^%PDF-[12]\.\d/.test(head) && tail.includes('%%EOF')
}
