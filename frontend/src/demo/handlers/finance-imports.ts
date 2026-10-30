/**
 * Bank statements and imports of the demo API (src/juntia/api.py, imports.py). The demo cannot read
 * real bank PDFs: any PDF the administrator uploads reads as the synthetic statement of the latest
 * movements (../scenario/finance.ts), so the review shows what is already recorded, what is new and
 * what the rules suggest. Confirming records the new movements and keeps the uploaded file as the
 * statement's original; removing a statement removes the movements no other statement backs. AI
 * suggestions need a real server.
 */
import type { AccountOut, DeleteImpact, ImportOut, PreviewOut, PreviewRow } from '../../api/schema.gen'
import { COMMUNITY } from '../cast'
import {
  DemoApiError, demoPdf, demoUnavailable, hoursFromNow, http, looksLikePdf, now, nowIso, parseBody, pdfResponse,
  readForm, readJson, route, type HttpHandler,
} from '../core'
import { coreStore } from '../store/core'
import { financeStore, type FinanceState } from '../store/finance'
import {
  bankOrder, compareText, groupedIban, money, normalizeIban, sourceKey, type DemoImport, type DemoPreview,
  type DemoPreviewRow, type DemoTransaction, type StatementRow,
} from '../store/finance-ledger'
import { applyRules } from '../store/finance-rules'
import { readDecision, uuidParam, type DecisionInput } from './finance-contracts'
import { resolveEnrichment, validateEnrichment } from './finance-admin'

/** Largest upload (backend `parser.MAX_BYTES`). */
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024
/** Hours a preview waits for confirmation (backend `PREVIEW_HOURS` default). */
export const PREVIEW_HOURS = 24
/** Name of the account a first import registers (server texts, English). */
const ACCOUNT_NAME = 'Community account'
/** AI classification needs a provider and a real server: the review offers rules and manual editing. */
const AI_ENABLED = false

export function importOut(record: DemoImport): ImportOut {
  return {
    id: record.id,
    filename: record.filename,
    created_at: record.createdAt,
    start_date: record.startDate,
    end_date: record.endDate,
    opening_balance: money(record.openingBalance),
    closing_balance: money(record.closingBalance),
    inserted: record.inserted,
    duplicates: record.duplicates,
    count: record.rows.length,
  }
}

function previewRowOut(row: DemoPreviewRow): PreviewRow {
  return {
    booking_date: row.bookingDate,
    value_date: row.valueDate,
    description: row.description,
    amount: money(row.amount),
    balance_after: money(row.balance),
    page: row.page,
    ordinal: row.ordinal,
    category_id: row.categoryId,
    merchant: row.merchant,
    tags: [...row.tags],
    status: row.status,
    candidates: [...row.candidates],
    matched_rule: row.matchedRule,
    classification_source: row.source,
    skip_ai: row.skipAi,
    ai_reviewed: row.aiReviewed,
  }
}

function previewOut(preview: DemoPreview): PreviewOut {
  return {
    id: preview.id,
    filename: preview.filename,
    iban: preview.iban,
    account_confirmed: preview.accountConfirmed,
    initial_account: coreStore().account === null,
    expires_at: preview.expiresAt,
    version: preview.version,
    rows: preview.rows.map(previewRowOut),
    ai_enabled: AI_ENABLED,
    ai_in_progress: false,
    committed_import_id: preview.committedImportId,
  }
}

/** Backend `check_account`: the registered account, which must be the statement's. */
function checkAccount(iban: string): AccountOut | null {
  const { account } = coreStore()
  if (account && account.iban !== iban) throw new DemoApiError('account_mismatch', 409)
  return account
}

/** Backend `clean_expired`: previews past their time are forgotten with their file. */
function cleanExpired(state: FinanceState): void {
  for (const [id, preview] of state.previews) if (Date.parse(preview.expiresAt) < now().getTime()) state.previews.delete(id)
}

/** Backend `get_preview`. */
function getPreview(state: FinanceState, id: string): DemoPreview {
  const preview = state.previews.get(id)
  if (!preview) throw new DemoApiError('preview_not_found', 404)
  if (!preview.committedImportId && Date.parse(preview.expiresAt) <= now().getTime()) throw new DemoApiError('preview_expired', 410)
  checkAccount(preview.iban)
  return preview
}

/** Backend `check_version`: the review must be the latest one and nothing may have changed since it was read. */
function checkVersion(preview: DemoPreview, version: number, state: FinanceState): void {
  if (preview.version !== version || preview.revision !== state.revision) throw new DemoApiError('preview_stale', 409)
}

/**
 * Backend `match_rows`: a line already recorded once is a duplicate (and keeps its classification);
 * one that resembles recorded movements, or repeats in the statement, needs a decision.
 */
function matchRows(state: FinanceState, rows: readonly StatementRow[]): DemoPreviewRow[] {
  const keys = rows.map(row => sourceKey(row)), weakKeys = rows.map(row => sourceKey(row, false))
  const wanted = new Set(keys), weakWanted = new Set(weakKeys)
  const byKey = new Map<string, DemoTransaction[]>(), byWeak = new Map<string, DemoTransaction[]>()
  for (const transaction of state.transactions.values()) {
    if (!wanted.has(transaction.sourceKey) && !weakWanted.has(transaction.weakKey)) continue
    byKey.set(transaction.sourceKey, [...byKey.get(transaction.sourceKey) ?? [], transaction])
    byWeak.set(transaction.weakKey, [...byWeak.get(transaction.weakKey) ?? [], transaction])
  }
  const counts = new Map<string, number>()
  for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1)
  return rows.map((row, index) => {
    const candidates = byKey.get(keys[index]) ?? []
    const base = { ...row, matchedRule: null, skipAi: false, aiReviewed: false }
    if (candidates.length === 1 && counts.get(keys[index]) === 1) {
      const [current] = candidates
      return {
        ...base, status: 'duplicate', candidates: [current.id],
        categoryId: current.categoryId, merchant: current.merchant, tags: [...current.tags], source: current.source,
      }
    }
    const review = candidates.length > 0 || counts.get(keys[index])! > 1 || (byWeak.get(weakKeys[index])?.length ?? 0) > 0
    return {
      ...base, status: review ? 'review' : 'new', candidates: candidates.map(item => item.id),
      categoryId: null, merchant: '', tags: [], source: 'unclassified',
    }
  })
}

/** A cheap fingerprint of an uploaded file (two FNV-1a lanes and its size): the same file, the same import. */
export function fingerprint(bytes: Uint8Array): string {
  let first = 0x811c9dc5, second = 0x050c5d1f
  for (const byte of bytes) {
    first = Math.imul(first ^ byte, 0x01000193)
    second = Math.imul(second ^ byte, 0x01000193) ^ (second >>> 13)
  }
  const hex = (value: number) => (value >>> 0).toString(16).padStart(8, '0')
  return `${hex(first)}${hex(second)}:${bytes.length}`
}

/** The upload's file name as the backend keeps it: base name, no control characters, 255 characters. */
function uploadName(raw: string): string {
  const base = (raw || 'statement.pdf').split('/').filter(part => part !== '' && part !== '.').at(-1) ?? ''
  return [...base].filter(character => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127).slice(0, 255).join('')
}

/** Backend `parse_pdf`'s first checks: a PDF header (`unsupported_pdf`), then a complete document (`invalid_pdf`). */
function checkPdf(bytes: Uint8Array): void {
  if (new TextDecoder('latin1').decode(bytes.subarray(0, 5)) !== '%PDF-') throw new DemoApiError('unsupported_pdf')
  if (!looksLikePdf(bytes)) throw new DemoApiError('invalid_pdf')
}

/** Backend `stage`: reads the (synthetic) statement against the ledger and keeps it for review. */
function stage(state: FinanceState, filename: string, fileHash: string, bytes: Uint8Array<ArrayBuffer>): DemoPreview {
  const { statement } = state
  const account = checkAccount(statement.iban)
  let rows = matchRows(state, statement.rows)
  const known = state.imports.find(record => record.fileHash === fileHash)
  if (known) {
    // The same file again: every line maps to what its first import recorded.
    const byOrdinal = new Map(known.rows.map(row => [row.ordinal, row.transactionId]))
    if (byOrdinal.size !== rows.length || rows.some(row => !byOrdinal.has(row.ordinal))) throw new DemoApiError('source_mapping_mismatch', 409)
    rows = rows.map(row => {
      const target = state.transactions.get(byOrdinal.get(row.ordinal)!)
      if (!target || sourceKey(row) !== target.sourceKey) throw new DemoApiError('source_mapping_mismatch', 409)
      return {
        ...row, status: 'duplicate', candidates: [target.id],
        categoryId: target.categoryId, merchant: target.merchant, tags: [...target.tags], source: target.source,
      }
    })
  }
  if (account) rows = applyRules(rows, state.rules, statement.iban)
  const preview: DemoPreview = {
    id: state.ids.uuid(),
    expiresAt: hoursFromNow(PREVIEW_HOURS),
    revision: state.revision,
    version: 1,
    filename,
    fileHash,
    iban: statement.iban,
    accountConfirmed: account !== null,
    rows,
    committedImportId: null,
    bytes,
  }
  state.previews.set(preview.id, preview)
  return preview
}

/** What `confirm` answers for an import: a file imported before reads as all already recorded. */
function confirmedOut(record: DemoImport, previewId: string): ImportOut {
  const result = importOut(record)
  return record.id === previewId ? result : { ...result, inserted: 0, duplicates: result.count }
}

interface Planned {
  row: DemoPreviewRow
  decision: DecisionInput | undefined
  existingId: number | null
}

/** Backend `confirm`'s checks of each line's decision, before anything is written. */
function planRows(rows: readonly DemoPreviewRow[], decisions: ReadonlyMap<number, DecisionInput>): Planned[] {
  const used = new Set<number>()
  return rows.map(row => {
    const decision = decisions.get(row.ordinal)
    let existingId: number | null = null
    if (row.status === 'duplicate') {
      if (decision && (decision.createNew || decision.enrichment)) throw new DemoApiError('invalid_decision')
      existingId = row.candidates[0]
    } else if (row.status === 'review') {
      if (!decision || Boolean(decision.existingId) === decision.createNew) throw new DemoApiError('review_required', 409)
      if (decision.existingId && !row.candidates.includes(decision.existingId)) throw new DemoApiError('invalid_decision')
      existingId = decision.existingId
    } else if (decision?.existingId) {
      throw new DemoApiError('invalid_decision')
    }
    if (existingId) {
      if (used.has(existingId)) throw new DemoApiError('duplicate_mapping', 409)
      used.add(existingId)
    }
    return { row, decision, existingId }
  })
}

const statementRow = ({ bookingDate, valueDate, description, amount, balance, page, ordinal }: DemoPreviewRow): StatementRow =>
  ({ bookingDate, valueDate, description, amount, balance, page, ordinal })

/** Backend `confirm`: records the reviewed statement (all or nothing) and returns its import. */
function confirm(state: FinanceState, preview: DemoPreview, decisions: readonly DecisionInput[]): DemoImport {
  const rows = preview.rows
  const byOrdinal = new Map(decisions.map(decision => [decision.ordinal, decision]))
  if (byOrdinal.size !== decisions.length || [...byOrdinal.keys()].some(ordinal => !rows.some(row => row.ordinal === ordinal))) {
    throw new DemoApiError('invalid_decision')
  }
  validateEnrichment(state, [...decisions.flatMap(decision => decision.enrichment ? [decision.enrichment] : []), ...rows])
  const plan = planRows(rows, byOrdinal)
  const oldest = rows.at(-1)!, newest = rows[0]
  const dates = rows.map(row => row.bookingDate).sort()
  const record: DemoImport = {
    id: preview.id, filename: preview.filename, fileHash: preview.fileHash, createdAt: nowIso(),
    startDate: dates[0], endDate: dates.at(-1)!, openingBalance: oldest.balance - oldest.amount, closingBalance: newest.balance,
    inserted: plan.filter(item => !item.existingId).length, duplicates: plan.filter(item => item.existingId).length,
    rows: [], original: preview.bytes,
  }
  const created = new Map<number, DemoTransaction>()
  for (const { row, decision, existingId } of plan) {
    let transactionId = existingId
    if (!transactionId) {
      transactionId = state.sequences.transaction.next()
      created.set(transactionId, {
        id: transactionId, sourceKey: sourceKey(row), weakKey: sourceKey(row, false), bookingDate: row.bookingDate,
        valueDate: row.valueDate, description: row.description, amount: row.amount, balance: row.balance,
        categoryId: row.categoryId, merchant: row.merchant, tags: [...row.tags],
        source: decision?.enrichment ? 'manual' : row.source, version: 1,
      })
    }
    record.rows.push({ ordinal: row.ordinal, page: row.page, source: statementRow(row), transactionId })
  }
  // The bank order is checked before anything changes: contradicting another statement writes nothing.
  const transactions = new Map([...state.transactions, ...created])
  const order = bankOrder(transactions, [...state.imports, record])
  for (const { decision, existingId } of plan) {
    if (existingId || !decision?.enrichment) continue
    const id = record.rows.find(row => row.ordinal === decision.ordinal)!.transactionId
    Object.assign(created.get(id)!, resolveEnrichment(state, decision.enrichment))
  }
  if (!checkAccount(preview.iban)) coreStore().account = { iban: preview.iban, name: ACCOUNT_NAME }
  state.transactions = transactions
  state.imports.push(record)
  state.order = order
  preview.committedImportId = record.id
  state.revision += 1
  return record
}

/** Backend `removal_impact`: the movements only this statement backs go with it. */
function removalImpact(state: FinanceState, id: string): { impact: DeleteImpact; record: DemoImport; orphans: number[] } {
  const record = state.imports.find(item => item.id === id)
  if (!record) throw new DemoApiError('import_not_found', 404)
  const own = new Set(record.rows.map(row => row.transactionId))
  const shared = new Set(state.imports.filter(item => item !== record).flatMap(item => item.rows.map(row => row.transactionId)).filter(key => own.has(key)))
  const orphans = [...own].filter(key => !shared.has(key)).sort((left, right) => left - right)
  return { impact: { revision: state.revision, removed_transactions: orphans.length, retained_transactions: shared.size }, record, orphans }
}

const shortDay = (day: string) => `${day.slice(8)}/${day.slice(5, 7)}/${day.slice(2, 4)}`
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

/** Cents as a statement prints them: `-1,210.00`. */
function printedAmount(cents: number): string {
  const [units, decimals] = money(Math.abs(cents)).split('.')
  return `${cents < 0 ? '-' : ''}${units.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${decimals}`
}

/** Lines a generated original has room for (the PDF helper prints up to 44). */
const PRINTED_LINES = 44
/** Characters of a description on the movement's line; the rest goes on the next one. */
const DESCRIPTION_WIDTH = 40

/** A movement as printed lines: dates, the start of its description, amount and balance, then the rest. */
function printedMovement(row: StatementRow): string[] {
  const { description } = row
  const space = description.length > DESCRIPTION_WIDTH ? description.lastIndexOf(' ', DESCRIPTION_WIDTH) : -1
  const cut = description.length <= DESCRIPTION_WIDTH ? description.length : space > 0 ? space : DESCRIPTION_WIDTH
  const rest = description.slice(cut).trim()
  const line = [shortDay(row.bookingDate), shortDay(row.valueDate), description.slice(0, cut), printedAmount(row.amount), printedAmount(row.balance)]
  return [line.join('   '), ...(rest ? [`${' '.repeat(36)}${rest}`] : [])]
}

/** The original of a scenario statement: a one-page PDF with its header and as many movements as fit. */
export function statementPdf(record: DemoImport): Uint8Array<ArrayBuffer> {
  const rows = [...record.rows].sort((left, right) => left.ordinal - right.ordinal).map(row => row.source)
  const [year, month] = record.endDate.split('-').map(Number)
  const lines = [
    `Account holder: ${COMMUNITY.name} residents' community`,
    `IBAN: ${groupedIban(COMMUNITY.account.iban)}    Currency: EUR`,
    `Period: ${shortDay(record.startDate)} - ${shortDay(record.endDate)}    Movements: ${rows.length}`,
    `Opening balance: ${printedAmount(record.openingBalance)}    Closing balance: ${printedAmount(record.closingBalance)}`,
    'Synthetic statement generated by the Juntia demo. Not a real bank document.',
    '',
    'Date            Value           Description                                                Amount        Balance',
  ]
  for (const [index, row] of rows.entries()) {
    const printed = printedMovement(row)
    const left = rows.length - index
    if (lines.length + printed.length > PRINTED_LINES - (left > 1 ? 1 : 0)) {
      lines.push(`... and ${left} earlier movements`)
      break
    }
    lines.push(...printed)
  }
  return demoPdf(`Community account statement - ${MONTH_NAMES[month - 1]} ${year}`, lines)
}

export const financeImportHandlers: HttpHandler[] = [
  http.get('/api/admin/statements', route('admin', (): ImportOut[] =>
    [...financeStore().imports].sort((left, right) => compareText(right.createdAt, left.createdAt)).map(importOut))),

  http.get('/api/admin/statements/:importId/original', route('admin', ({ params }) => {
    const id = uuidParam(params, 'importId')
    const record = financeStore().imports.find(item => item.id === id)
    if (!record) throw new DemoApiError('import_not_found', 404)
    return pdfResponse(record.original ?? statementPdf(record), record.filename, 'attachment')
  })),

  http.get('/api/admin/statements/:importId/removal', route('admin', ({ params }): DeleteImpact =>
    removalImpact(financeStore(), uuidParam(params, 'importId')).impact)),

  http.delete('/api/admin/statements/:importId', route('admin', async ({ request, params }) => {
    const id = uuidParam(params, 'importId')
    const { revision } = parseBody(await readJson(request), body => ({ revision: body.int('revision', { min: 0 }) }))
    const state = financeStore()
    if (state.revision !== revision) throw new DemoApiError('preview_stale', 409)
    const { record, orphans } = removalImpact(state, id)
    state.imports.splice(state.imports.indexOf(record), 1)
    for (const key of orphans) state.transactions.delete(key)
    state.order = bankOrder(state.transactions, state.imports)
    state.revision += 1
  }, { status: 204 })),

  http.post('/api/admin/imports/preview', route('admin', async ({ request }): Promise<PreviewOut> => {
    const state = financeStore()
    cleanExpired(state)
    const form = await readForm(request)
    const file = form.get('file')
    if (file === null || typeof file === 'string') throw new DemoApiError('invalid_request')
    if (file.size > MAX_UPLOAD_BYTES) throw new DemoApiError('upload_too_large', 413)
    const bytes = new Uint8Array(await file.arrayBuffer())
    checkPdf(bytes)
    return previewOut(stage(state, uploadName(file.name), fingerprint(bytes), bytes))
  })),

  http.get('/api/admin/imports/:previewId', route('admin', ({ params }): PreviewOut =>
    previewOut(getPreview(financeStore(), uuidParam(params, 'previewId'))))),

  http.post('/api/admin/imports/:previewId/account', route('admin', async ({ request, params }): Promise<PreviewOut> => {
    const id = uuidParam(params, 'previewId')
    const input = parseBody(await readJson(request), body => ({ iban: body.text('iban', { max: 1_000_000 }), version: body.int('version') }))
    const state = financeStore()
    const preview = getPreview(state, id)
    checkVersion(preview, input.version, state)
    if (preview.committedImportId) throw new DemoApiError('import_already_confirmed', 409)
    if (preview.iban !== normalizeIban(input.iban)) throw new DemoApiError('account_mismatch', 409)
    preview.accountConfirmed = true
    preview.rows = applyRules(preview.rows, state.rules, preview.iban)
    preview.version += 1
    return previewOut(preview)
  })),

  // AI classification needs a provider and a real server.
  http.post('/api/admin/imports/:previewId/ai', route('admin', () => demoUnavailable())),

  http.post('/api/admin/imports/:previewId/confirm', route('admin', async ({ request, params }): Promise<ImportOut> => {
    const id = uuidParam(params, 'previewId')
    const input = parseBody(await readJson(request), body => ({
      version: body.int('version'),
      decisions: body.list('decisions', { max: 10_000 }, readDecision),
    }))
    const state = financeStore()
    const preview = getPreview(state, id)
    if (preview.committedImportId) {
      const existing = state.imports.find(record => record.id === preview.committedImportId)
      if (!existing) throw new DemoApiError('import_removed', 410)
      return confirmedOut(existing, id)
    }
    checkVersion(preview, input.version, state)
    if (!preview.accountConfirmed) throw new DemoApiError('account_confirmation_required', 409)
    const sameFile = state.imports.find(record => record.fileHash === preview.fileHash)
    if (sameFile) {
      preview.committedImportId = sameFile.id
      return confirmedOut(sameFile, id)
    }
    return confirmedOut(confirm(state, preview, input.decisions), id)
  })),
]
