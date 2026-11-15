import type { MouseEvent } from 'react'
import { useQuery } from '@tanstack/react-query'
import { errorMessage, readBytes } from './api/client'
import { byteSize } from './community-action-shared'
import { formatNumber, useI18n } from './i18n'
import { Icon } from './icons'
import { Modal, Notice } from './shared'

// What the viewer reads of a file and shows of a table: enough for notes and lists, and quick on a phone.
export const PREVIEW_BYTES = 1024 * 1024
export const PREVIEW_ROWS = 500
const TEXT_EXTENSIONS = new Set(['txt', 'csv'])

/** Files the portal shows in its own viewer; PDFs, pictures and videos open in a new tab instead. */
export const isTextFile = (extension: string) => TEXT_EXTENSIONS.has(extension)

/** A plain click, which opens the viewer: other clicks keep the link's behavior, such as a new tab. */
export const plainClick = (event: MouseEvent) => event.button === 0 && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey

/**
 * Text in the encoding the file was saved with: UTF-8 or UTF-16 with a byte order mark, UTF-8, or
 * else Windows-1252, which spreadsheet programs often use for CSV files. A file read in part may
 * end in the middle of a character.
 */
export function decodeText(bytes: Uint8Array, partial = false): string {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return new TextDecoder('utf-8').decode(bytes.subarray(3))
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2))
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2))
  for (let cut = 0; cut <= (partial ? 3 : 0); cut++) {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, bytes.length - cut))
    } catch {
      // Not UTF-8, or cut inside a character: try without the last bytes.
    }
  }
  return new TextDecoder('windows-1252').decode(bytes)
}

/** The separator of a CSV file: the commonest on its first line of semicolon (Spanish spreadsheets), comma and tab. */
function separator(text: string): string {
  const line = text.split(/\r\n|\n|\r/, 1)[0] ?? ''
  let best = ',', count = 0
  for (const candidate of [';', ',', '\t']) {
    const found = line.split(candidate).length - 1
    if (found > count) { best = candidate; count = found }
  }
  return best
}

/** The rows of a CSV file; quoted fields may hold separators, line breaks and doubled quotes. Blank lines are skipped. */
export function parseCsv(text: string): string[][] {
  const delimiter = separator(text)
  const rows: string[][] = []
  let row: string[] = [], field = '', quoted = false
  const end = () => {
    row.push(field)
    if (row.length > 1 || row[0] !== '') rows.push(row)
    row = []; field = ''
  }
  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    if (quoted) {
      if (char !== '"') field += char
      else if (text[index + 1] === '"') { field += '"'; index++ }
      else quoted = false
    } else if (char === '"' && field === '') quoted = true
    else if (char === delimiter) { row.push(field); field = '' }
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[index + 1] === '\n') index++
      end()
    } else field += char
  }
  if (field !== '' || row.length > 0) end()
  return rows
}

type Preview = { text: string; partial: boolean }

function Table({ name, preview }: { name: string; preview: Preview }) {
  const { t } = useI18n()
  const rows = parseCsv(preview.text)
  // A file read in part may stop in the middle of its last row.
  if (preview.partial && rows.length > 1) rows.pop()
  const [header = [], ...body] = rows
  const shown = body.slice(0, PREVIEW_ROWS)
  const columns = Math.max(header.length, ...shown.map(row => row.length))
  const cells = (row: string[]) => Array.from({ length: columns }, (_, index) => row[index] ?? '')
  return <>
    {body.length > PREVIEW_ROWS && <p className="muted">{t('documents.viewer.rows', { count: formatNumber(PREVIEW_ROWS) })}</p>}
    <div className="table-scroll text-preview-table" role="region" aria-label={name} tabIndex={0}>
      <table><thead><tr>{cells(header).map((cell, index) => <th key={index} scope="col">
        {cell || <span className="muted">{t('documents.viewer.column', { number: index + 1 })}</span>}</th>)}</tr></thead>
        <tbody>{shown.map((row, index) => <tr key={index}>{cells(row).map((cell, column) => <td key={column}>{cell}</td>)}</tr>)}</tbody>
      </table>
    </div>
  </>
}

/** Text and CSV files, shown in the portal: CSV files as a table. Large files show their beginning. */
export function TextPreview({ name, extension, size, path, download, close }: {
  name: string; extension: string; size: number
  // The preview's address without /api, and the download's with it.
  path: string; download: string
  close: () => void
}) {
  const { t } = useI18n()
  const query = useQuery({
    queryKey: ['text-preview', path],
    queryFn: async ({ signal }): Promise<Preview> => {
      if (size === 0) return { text: '', partial: false }
      const bytes = await readBytes(path, PREVIEW_BYTES, signal)
      const partial = size > bytes.length
      return { text: decodeText(bytes, partial), partial }
    },
    staleTime: Infinity, gcTime: 0, retry: false,
  })
  const preview = query.data
  return <Modal title={name} close={close} className="text-preview-dialog"
    actions={<a className="button secondary" href={download} download=""><Icon name="download" size={16} />{t('documents.menu.download')}</a>}>
    {query.isPending && <Notice>{t('documents.viewer.loading')}</Notice>}
    {query.error && <Notice error>{errorMessage(query.error)}</Notice>}
    {preview && (preview.text.trim() === '' ? <p className="empty">{t('documents.viewer.empty')}</p> : <>
      {preview.partial && <p className="muted">{t('documents.viewer.partial', { size: byteSize(PREVIEW_BYTES) })}</p>}
      {extension === 'csv' ? <Table name={name} preview={preview} />
        : <div className="text-preview" role="region" aria-label={name} tabIndex={0}><pre>{preview.text}</pre></div>}
    </>)}
  </Modal>
}
