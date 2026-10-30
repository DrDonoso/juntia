/**
 * The finance ledger of the demo: the shape of its data (transactions, imported statements, import
 * previews, catalogs and rules) and the backend rules every finance module shares — money in cents,
 * the deduplication keys of src/juntia/identity.py, the bank order of src/juntia/bank_order.py and
 * the text folding of src/juntia/query_sql.py.
 */
import type { CatalogOut, RuleOut, TransactionOut } from '../../api/schema.gen'
import { DemoApiError } from '../core/errors'
import type { IdSequence } from '../core/ids'
import type { Random } from '../core/random'

/** A movement as a bank statement prints it (backend `ParsedRow`); amounts in cents. */
export interface StatementRow {
  bookingDate: string
  valueDate: string
  description: string
  /** Signed cents. */
  amount: number
  /** Cents in the account after the movement. */
  balance: number
  page: number
  /** Position in the statement, 0 for its newest movement. */
  ordinal: number
}

export interface DemoTransaction {
  id: number
  /** Deduplication keys (backend `source_key` with and without the balance). */
  sourceKey: string
  weakKey: string
  bookingDate: string
  valueDate: string
  description: string
  amount: number
  balance: number
  categoryId: number | null
  merchant: string
  /** Tag ids, sorted and unique. */
  tags: number[]
  /** `classification_source`: `manual`, `rule`, `ai` or `unclassified`. */
  source: string
  version: number
}

/** One line of an imported statement and the transaction it recorded or matched (backend `ImportRow`). */
export interface DemoImportRow {
  ordinal: number
  page: number
  source: StatementRow
  transactionId: number
}

/** An imported statement (backend `ImportRun`). */
export interface DemoImport {
  /** UUID, the id of the preview it was confirmed from. */
  id: string
  filename: string
  /** Fingerprint of the uploaded file: importing the same file twice links to the first import. */
  fileHash: string
  createdAt: string
  startDate: string
  endDate: string
  openingBalance: number
  closingBalance: number
  inserted: number
  duplicates: number
  rows: DemoImportRow[]
  /** The uploaded PDF; null for the scenario's statements, whose original is generated on download. */
  original: Uint8Array<ArrayBuffer> | null
}

export type PreviewStatus = 'new' | 'duplicate' | 'review'

/** A statement line under review (backend `PreviewRow`). */
export interface DemoPreviewRow extends StatementRow {
  status: PreviewStatus
  candidates: number[]
  categoryId: number | null
  merchant: string
  tags: number[]
  matchedRule: string | null
  source: string
  skipAi: boolean
  aiReviewed: boolean
}

/** An uploaded statement waiting for confirmation (backend `Preview`). */
export interface DemoPreview {
  id: string
  expiresAt: string
  /** Finance revision when it was read: any later finance change makes it stale. */
  revision: number
  version: number
  filename: string
  fileHash: string
  iban: string
  accountConfirmed: boolean
  rows: DemoPreviewRow[]
  committedImportId: string | null
  /** The uploaded PDF, kept as the original of the statement it becomes. */
  bytes: Uint8Array<ArrayBuffer>
}

/** Place of a transaction in the bank's order (backend `TransactionOrder`): 0 is the newest. */
export interface BankPosition {
  position: number
  /** The newest movement of its day in its statement. */
  root: boolean
}

/** The synthetic statement every upload of the demo reads (the demo does not parse real PDFs). */
export interface CannedStatement {
  iban: string
  /** Newest first, like the bank prints them. */
  rows: StatementRow[]
}

export interface FinanceState {
  /** Finance revision (backend `state.revision`): every finance write increments it. */
  revision: number
  categories: CatalogOut[]
  tags: CatalogOut[]
  /** Rules in id order, amounts written with two decimals. */
  rules: RuleOut[]
  /** Transactions by id, in id order. */
  transactions: Map<number, DemoTransaction>
  imports: DemoImport[]
  previews: Map<string, DemoPreview>
  order: Map<number, BankPosition>
  statement: CannedStatement
  sequences: { category: IdSequence; tag: IdSequence; rule: IdSequence; transaction: IdSequence }
  /** UUIDs of new previews. */
  ids: Random
}

/** Fallback color of categories, tags and uncategorized expenses (backend default). */
export const NEUTRAL_COLOR = '#64748b'

/** Default color of new categories and tags (backend `CatalogIn` / `TagIn`). */
export const DEFAULT_COLOR = '#21639f'

/** Color of the merchant breakdown (backend `summary`). */
export const MERCHANT_COLOR = '#21639f'

/** Cents as the API writes decimals: `-12.30`, `1234.56`. */
export function money(cents: number): string {
  const absolute = Math.abs(cents)
  return `${cents < 0 ? '-' : ''}${Math.floor(absolute / 100)}.${String(absolute % 100).padStart(2, '0')}`
}

/** Cents of a decimal with at most two decimals (`'50.00'`, `'-7.5'`). */
export function cents(value: string): number {
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim())
  if (!match) throw new Error(`Not an amount: ${value}`)
  const total = Number(match[2]) * 100 + Number((match[3] ?? '').padEnd(2, '0'))
  return match[1] ? -total : total
}

/** Python's `str.casefold` for the texts of the demo (lower case, plus the few full foldings that matter). */
export function casefold(value: string): string {
  return value.toLowerCase().replace(/\u00df/g, 'ss').replace(/\u03c2/g, '\u03c3')
}

/** Python's `" ".join(value.split())`: runs of whitespace become one space, none at the ends. */
export function collapse(value: string): string {
  return value.split(/\s+/).filter(Boolean).join(' ')
}

/** Backend `tag_name_key`: tag names compare without case, width or spacing differences. */
export function tagNameKey(value: string): string {
  return casefold(collapse(value.normalize('NFKC')))
}

/** Binary order of two texts (PostgreSQL `C` / SQLite `BINARY` collation). */
export function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

/** Backend `normalize_iban`: a Spanish IBAN without spaces, upper case, with valid check digits. */
export function normalizeIban(value: string): string {
  const iban = value.replace(/\s+/g, '').toUpperCase()
  if (!/^ES\d{22}$/.test(iban)) throw new DemoApiError('invalid_iban')
  const rotated = iban.slice(4) + iban.slice(0, 4)
  const digits = [...rotated].map(character => /[A-Z]/.test(character) ? String(character.charCodeAt(0) - 55) : character).join('')
  if (BigInt(digits) % 97n !== 1n) throw new DemoApiError('invalid_iban')
  return iban
}

/** The IBAN in groups of four, as people write it. */
export function groupedIban(iban: string): string {
  return iban.match(/.{1,4}/g)?.join(' ') ?? iban
}

type KeyedRow = Pick<StatementRow, 'bookingDate' | 'valueDate' | 'description' | 'amount' | 'balance'>

/**
 * Backend `source_key`: what identifies a bank movement across statements (dates, description,
 * amount, currency and, unless `includeBalance` is false, the balance after it). The demo keeps the
 * canonical text instead of its SHA-256: only equality matters.
 */
export function sourceKey(row: KeyedRow, includeBalance = true): string {
  const values = ['statement-v1', '1', row.bookingDate, row.valueDate, collapse(row.description.normalize('NFKC')), money(row.amount), 'EUR']
  if (includeBalance) values.push(money(row.balance))
  return JSON.stringify(values)
}

/**
 * Python's `graphlib.TopologicalSorter(graph).static_order()`: ready nodes in insertion order,
 * then the nodes they release, level by level. A cycle is the backend's `conflicting_order`.
 */
function staticOrder(graph: ReadonlyMap<number, ReadonlySet<number>>): number[] {
  const nodes = new Map<number, { predecessors: number; successors: number[] }>()
  const info = (node: number) => {
    let value = nodes.get(node)
    if (!value) nodes.set(node, value = { predecessors: 0, successors: [] })
    return value
  }
  for (const [node, predecessors] of graph) {
    info(node).predecessors += predecessors.size
    for (const predecessor of [...predecessors].sort((left, right) => left - right)) info(predecessor).successors.push(node)
  }
  const result: number[] = []
  let ready = [...nodes].filter(([, value]) => value.predecessors === 0).map(([node]) => node)
  while (ready.length > 0) {
    const group = ready
    ready = []
    result.push(...group)
    for (const node of group) {
      for (const successor of info(node).successors) {
        const value = info(successor)
        value.predecessors -= 1
        if (value.predecessors === 0) ready.push(successor)
      }
    }
  }
  if (result.length !== nodes.size) throw new DemoApiError('conflicting_order', 409)
  return result
}

/**
 * Backend `rebuild_bank_order`: newest day first and, within a day, the order the statements print
 * (consecutive lines of one statement on the same day). Transactions in id order stand in for the
 * backend's identity keys when nothing else orders two movements.
 */
export function bankOrder(transactions: ReadonlyMap<number, DemoTransaction>, imports: readonly DemoImport[]): Map<number, BankPosition> {
  const ids = [...transactions.keys()].sort((left, right) => left - right)
  const dates = new Map(ids.map(id => [id, transactions.get(id)!.bookingDate]))
  const predecessors = new Map(ids.map(id => [id, new Set<number>()]))
  const lines = [...imports].sort((left, right) => compareText(left.id, right.id)).flatMap(record =>
    [...record.rows].sort((left, right) => left.ordinal - right.ordinal).map(row => ({ importId: record.id, transactionId: row.transactionId })))
  let previous: (typeof lines)[number] | null = null
  for (const line of lines) {
    if (previous && previous.importId === line.importId) {
      const newer = previous.transactionId, older = line.transactionId
      if (dates.get(newer) === dates.get(older)) predecessors.get(older)?.add(newer)
    }
    previous = line
  }
  const ordered = staticOrder(predecessors).sort((left, right) => compareText(dates.get(right)!, dates.get(left)!))
  return new Map(ordered.map((id, position) => [id, { position, root: predecessors.get(id)!.size === 0 }]))
}

/** `TransactionOut` of a stored transaction. */
export function transactionOut(transaction: DemoTransaction): TransactionOut {
  return {
    category_id: transaction.categoryId,
    merchant: transaction.merchant,
    tags: [...transaction.tags],
    id: transaction.id,
    booking_date: transaction.bookingDate,
    value_date: transaction.valueDate,
    description: transaction.description,
    amount: money(transaction.amount),
    balance_after: money(transaction.balance),
    classification_source: transaction.source,
    version: transaction.version,
  }
}

/** Sorted, unique ids (backend `Enrichment.tags`). */
export function uniqueSorted(values: Iterable<number>): number[] {
  return [...new Set(values)].sort((left, right) => left - right)
}
