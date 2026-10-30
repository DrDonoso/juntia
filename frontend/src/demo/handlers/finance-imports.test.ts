import { File as NodeFile } from 'node:buffer'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import type { DeleteImpact, ImportOut, PreviewOut, SummaryOut, TransactionPage } from '../../api/schema.gen'
import { demoPdf, looksLikePdf, setClock } from '../core'
import { resetDemo } from '../store'
import { coreStore } from '../store/core'
import { financeStore } from '../store/finance'
import { money } from '../store/finance-ledger'
import { demoFetch, demoRequest, demoUrl } from '../testing'
import { MAX_UPLOAD_BYTES, fingerprint } from './finance-imports'

// Thursday 29 October 2026, midday (local time).
const NOW = new Date(2026, 9, 29, 12, 0)

beforeEach(async () => {
  resetDemo({ now: () => NOW })
  expect((await demoRequest('POST', '/api/admin/auth/login', { body: { username: 'demo', password: 'demo' } })).status).toBe(200)
})
afterEach(() => resetDemo())

const encoder = new TextEncoder()

/** A multipart upload of `bytes` as the `file` field, like the Import page's FormData. */
async function upload<T = PreviewOut>(bytes: Uint8Array | string, filename = 'statement-october.pdf', { field = 'file', header = true } = {}) {
  const content = typeof bytes === 'string' ? encoder.encode(bytes) : bytes
  const boundary = '----demo-finance-test'
  const head = encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${filename}"\r\nContent-Type: application/pdf\r\n\r\n`)
  const tail = encoder.encode(`\r\n--${boundary}--\r\n`)
  const body = new Uint8Array(head.length + content.length + tail.length)
  body.set(head)
  body.set(content, head.length)
  body.set(tail, head.length + content.length)
  // Node's multipart parser builds files with the global File, which jsdom replaces in these tests.
  const jsdomFile = globalThis.File
  globalThis.File = NodeFile as unknown as typeof File
  try {
    const response = await demoFetch(new Request(demoUrl('/api/admin/imports/preview'), {
      method: 'POST', body, headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, ...(header ? { 'X-Juntia-Request': '1' } : {}) },
    }))
    const text = await response.text()
    return { status: response.status, body: (text ? JSON.parse(text) : undefined) as T }
  } finally {
    globalThis.File = jsdomFile
  }
}

const statements = async () => (await demoRequest<ImportOut[]>('GET', '/api/admin/statements')).body
const confirm = (preview: { id: string; version: number }, decisions: object[] = []) =>
  demoRequest<ImportOut>('POST', `/api/admin/imports/${preview.id}/confirm`, { body: { version: preview.version, decisions } })
const total = async () => (await demoRequest<TransactionPage>('GET', '/api/transactions')).body.total
const pdf = (title = 'Any statement') => demoPdf(title, ['A visitor picked this file.'])

describe('statements', () => {
  test('one import a month, newest first, with periods, balances and counts', async () => {
    const list = await statements()
    expect(list).toHaveLength(13)
    expect(list.map(item => item.filename)).toEqual(Array.from({ length: 13 }, (_, index) => {
      const month = new Date(2026, 9 - index, 1)
      return `statement-${month.getFullYear()}-${String(month.getMonth() + 1).padStart(2, '0')}.pdf`
    }))
    const latest = list[0]
    expect(latest).toMatchObject({ start_date: '2026-10-01', end_date: '2026-10-26', duplicates: 0 })
    expect(latest.count).toBe(latest.inserted)
    expect(latest.created_at < NOW.toISOString()).toBe(true)
    // Each statement opens with the previous one's closing balance.
    list.slice(0, -1).forEach((item, index) => expect(item.opening_balance).toBe(list[index + 1].closing_balance))
    expect(list.reduce((sum, item) => sum + item.count, 0)).toBe(financeStore().transactions.size)
  })

  test('downloads a generated original of a scenario statement', async () => {
    const [latest] = await statements()
    const response = await demoFetch(new Request(demoUrl(`/api/admin/statements/${latest.id}/original`)))
    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('application/pdf')
    expect(response.headers.get('Content-Disposition')).toBe('attachment; filename="statement-2026-10.pdf"')
    const bytes = new Uint8Array(await response.arrayBuffer())
    expect(looksLikePdf(bytes)).toBe(true)
    const text = new TextDecoder('latin1').decode(bytes)
    expect(text).toContain('Community account statement - October 2026')
    expect(text).toContain('IBAN: ES30 9999 0001 2301 2345 6789')
    expect(text).toContain('(23/10/26   23/10/26   DIRECT DEBIT RINGWISE TELECOM LIFT ALARM   -18.15   17,181.60) Tj')
    expect(text).toContain('LINE OCT 26) Tj')
    expect(text).toContain('... and 2 earlier movements')
    expect(await demoRequest('GET', '/api/admin/statements/00000000-0000-4000-8000-000000000000/original'))
      .toMatchObject({ status: 404, body: { code: 'import_not_found' } })
    expect(await demoRequest('GET', '/api/admin/statements/not-a-uuid/original')).toMatchObject({ status: 422, body: { code: 'invalid_request' } })
  })

  test('removal preview and removal with the finance revision', async () => {
    const [latest, previous] = await statements()
    const impact = await demoRequest<DeleteImpact>('GET', `/api/admin/statements/${latest.id.toUpperCase()}/removal`)
    expect(impact).toMatchObject({ status: 200, body: { revision: financeStore().revision, removed_transactions: latest.count, retained_transactions: 0 } })
    const path = `/api/admin/statements/${latest.id}`
    expect(await demoRequest('DELETE', path, { body: { revision: impact.body.revision + 1 } })).toMatchObject({ status: 409, body: { code: 'preview_stale' } })
    expect(await demoRequest('DELETE', path)).toMatchObject({ status: 422, body: { code: 'invalid_request' } })
    const before = await total()
    expect(await demoRequest('DELETE', path, { body: { revision: impact.body.revision } })).toMatchObject({ status: 204, body: undefined })
    expect(await total()).toBe(before - latest.count)
    expect(await statements()).toHaveLength(12)
    const summary = (await demoRequest<SummaryOut>('GET', '/api/summary')).body
    expect(summary).toMatchObject({ coverage_end: previous.end_date, balance: previous.closing_balance })
    expect(await demoRequest('GET', `/api/admin/statements/${latest.id}/removal`)).toMatchObject({ status: 404, body: { code: 'import_not_found' } })
    expect(await demoRequest('DELETE', path, { body: { revision: financeStore().revision } })).toMatchObject({ status: 404, body: { code: 'import_not_found' } })
  })
})

describe('importing a statement', () => {
  test('any PDF reads as the latest movements: duplicates, new rows and rule suggestions', async () => {
    const { rows } = financeStore().statement
    const answer = await upload(pdf())
    expect(answer.status).toBe(200)
    const preview = answer.body
    expect(preview).toMatchObject({
      filename: 'statement-october.pdf', iban: 'ES3099990001230123456789', account_confirmed: true, initial_account: false,
      version: 1, ai_enabled: false, ai_in_progress: false, committed_import_id: null,
      expires_at: new Date(NOW.getTime() + 24 * 3_600_000).toISOString(),
    })
    expect(preview.rows).toHaveLength(rows.length)
    expect(preview.rows.map(row => row.ordinal)).toEqual(rows.map((_, index) => index))
    const fresh = preview.rows.filter(row => row.status === 'new')
    const duplicates = preview.rows.filter(row => row.status === 'duplicate')
    expect(fresh.length).toBeGreaterThanOrEqual(3)
    expect(duplicates.length).toBe(rows.length - fresh.length)
    expect(fresh.every(row => row.booking_date > '2026-10-26')).toBe(true)
    expect(duplicates.every(row => row.candidates.length === 1 && row.classification_source !== 'unclassified')).toBe(true)
    expect(preview.rows.find(row => row.description.startsWith("TRANSFER FROM O'CONNOR LIAM MONTHLY FEE 1B"))).toMatchObject({
      status: 'new', amount: '273.60', category_id: 1, tags: [1], matched_rule: 'Monthly fees', classification_source: 'rule', skip_ai: true,
    })
    expect(preview.rows.find(row => row.description === 'TRANSFER TO SPARKLE CLEANING CO INV SC-2610')).toMatchObject({
      status: 'new', category_id: 5, merchant: 'Sparkle Cleaning Co.', matched_rule: 'Cleaning',
    })
    expect(preview.rows.find(row => row.description === 'CARD PAYMENT HARTLEY HARDWARE 0731')).toMatchObject({
      status: 'new', category_id: null, merchant: '', tags: [], matched_rule: null, classification_source: 'unclassified', skip_ai: false,
    })
    expect(preview.rows[0]).toMatchObject({ booking_date: '2026-10-29', balance_after: money(rows[0].balance) })
    expect((await demoRequest<PreviewOut>('GET', `/api/admin/imports/${preview.id}`)).body).toEqual(preview)
    expect(await demoRequest('POST', `/api/admin/imports/${preview.id}/ai`, { body: { version: 1 } }))
      .toMatchObject({ status: 403, body: { code: 'demo_unavailable' } })
  })

  test('confirming records the new movements, the statement and its original', async () => {
    const bytes = pdf('October so far')
    const preview = (await upload(bytes, 'october.pdf')).body
    const fresh = preview.rows.filter(row => row.status === 'new')
    const hardware = fresh.find(row => row.description.includes('HARTLEY'))!
    const before = await total()
    const answer = await confirm(preview, [{
      ordinal: hardware.ordinal, create_new: true,
      enrichment: { category_id: 6, merchant: 'Hartley Hardware', tags: [1], new_tags: [{ name: 'Light bulbs', color: '#2bccb4' }] },
    }])
    expect(answer).toMatchObject({ status: 200, body: {
      id: preview.id, filename: 'october.pdf', inserted: fresh.length, duplicates: preview.rows.length - fresh.length, count: preview.rows.length,
      start_date: preview.rows.at(-1)!.booking_date, end_date: '2026-10-29', closing_balance: preview.rows[0].balance_after,
    } })
    expect(await total()).toBe(before + fresh.length)
    const list = await statements()
    expect(list).toHaveLength(14)
    expect(list[0]).toEqual(answer.body)
    const summary = (await demoRequest<SummaryOut>('GET', '/api/summary')).body
    expect(summary).toMatchObject({ coverage_end: '2026-10-29', balance_date: '2026-10-29', balance: preview.rows[0].balance_after })
    const newest = (await demoRequest<TransactionPage>('GET', '/api/transactions')).body.items
    expect(newest.slice(0, 3).map(row => row.description)).toEqual(preview.rows.slice(0, 3).map(row => row.description))
    const classified = newest.find(row => row.description.includes('HARTLEY'))!
    const tag = financeStore().tags.find(item => item.name === 'Light bulbs')!
    expect(classified).toMatchObject({ category_id: 6, merchant: 'Hartley Hardware', tags: [1, tag.id], classification_source: 'manual' })
    expect(newest.find(row => row.description.includes("O'CONNOR"))).toMatchObject({ category_id: 1, classification_source: 'rule' })
    // The original is the uploaded file.
    const original = await demoFetch(new Request(demoUrl(`/api/admin/statements/${preview.id}/original`)))
    expect(original.headers.get('Content-Disposition')).toBe('attachment; filename="october.pdf"')
    expect([...new Uint8Array(await original.arrayBuffer())]).toEqual([...bytes])
    // Confirming again answers the same import.
    expect(await confirm(preview)).toMatchObject({ status: 200, body: answer.body })
    // The rows shared with October's statement stay when the new one is removed.
    const impact = (await demoRequest<DeleteImpact>('GET', `/api/admin/statements/${preview.id}/removal`)).body
    expect(impact).toMatchObject({ removed_transactions: fresh.length, retained_transactions: preview.rows.length - fresh.length })
    const october = list.find(item => item.filename === 'statement-2026-10.pdf')!
    expect((await demoRequest<DeleteImpact>('GET', `/api/admin/statements/${october.id}/removal`)).body)
      .toMatchObject({ removed_transactions: october.count - impact.retained_transactions, retained_transactions: impact.retained_transactions })
    expect(await demoRequest('DELETE', `/api/admin/statements/${preview.id}`, { body: { revision: impact.revision } })).toMatchObject({ status: 204 })
    expect(await confirm(preview)).toMatchObject({ status: 410, body: { code: 'import_removed' } })
  })

  test('the same file again links to its first import; another file records nothing new', async () => {
    const bytes = pdf()
    const first = (await upload(bytes)).body
    const saved = (await confirm(first)).body
    const again = (await upload(bytes, 'renamed.pdf')).body
    expect(again.rows.every(row => row.status === 'duplicate')).toBe(true)
    expect(await confirm(again)).toMatchObject({ status: 200, body: { id: saved.id, filename: saved.filename, inserted: 0, duplicates: saved.count } })
    // Nothing changed, so the second preview is still current: it was saved as the first import.
    expect(await demoRequest('POST', `/api/admin/imports/${again.id}/account`, { body: { iban: again.iban, version: again.version } }))
      .toMatchObject({ status: 409, body: { code: 'import_already_confirmed' } })
    expect(await statements()).toHaveLength(14)
    const other = (await upload(pdf('Another file'), 'other.pdf')).body
    expect(other.rows.every(row => row.status === 'duplicate')).toBe(true)
    const totalBefore = await total()
    expect(await confirm(other)).toMatchObject({ status: 200, body: { id: other.id, inserted: 0, duplicates: other.rows.length } })
    expect(await total()).toBe(totalBefore)
    expect(await statements()).toHaveLength(15)
  })

  test('a preview goes stale when the finances change, and expires after a day', async () => {
    const preview = (await upload(pdf())).body
    expect(await confirm({ ...preview, version: 2 })).toMatchObject({ status: 409, body: { code: 'preview_stale' } })
    await demoRequest('POST', '/api/admin/catalog/tags', { body: { name: 'New tag' } })
    expect(await confirm(preview)).toMatchObject({ status: 409, body: { code: 'preview_stale' } })
    const later = (await upload(pdf('Later'))).body
    setClock(() => new Date(NOW.getTime() + 25 * 3_600_000))
    // Sessions last 12 hours: sign in again the next day.
    await demoRequest('POST', '/api/admin/auth/login', { body: { username: 'demo', password: 'demo' } })
    expect(await demoRequest('GET', `/api/admin/imports/${later.id}`)).toMatchObject({ status: 410, body: { code: 'preview_expired' } })
    expect(await confirm(later)).toMatchObject({ status: 410, body: { code: 'preview_expired' } })
    // The next upload forgets expired previews.
    await upload(pdf('Next day'))
    expect(await demoRequest('GET', `/api/admin/imports/${later.id}`)).toMatchObject({ status: 404, body: { code: 'preview_not_found' } })
    expect(await demoRequest('GET', '/api/admin/imports/00000000-0000-4000-8000-000000000000')).toMatchObject({ status: 404, body: { code: 'preview_not_found' } })
    expect(await demoRequest('GET', '/api/admin/imports/123')).toMatchObject({ status: 422, body: { code: 'invalid_request' } })
  })

  test('decisions follow the backend rules, and nothing is written when one is wrong', async () => {
    const preview = (await upload(pdf())).body
    const fresh = preview.rows.find(row => row.status === 'new')!
    const duplicate = preview.rows.find(row => row.status === 'duplicate')!
    const cases: [object[], number, string][] = [
      [[{ ordinal: fresh.ordinal }, { ordinal: fresh.ordinal }], 422, 'invalid_decision'],
      [[{ ordinal: 999 }], 422, 'invalid_decision'],
      [[{ ordinal: duplicate.ordinal, create_new: true }], 422, 'invalid_decision'],
      [[{ ordinal: fresh.ordinal, existing_id: duplicate.candidates[0] }], 422, 'invalid_decision'],
      [[{ ordinal: fresh.ordinal, enrichment: { category_id: 99 } }], 409, 'unknown_classification'],
      [[{ ordinal: fresh.ordinal, amount: '1.00' }], 422, 'invalid_request'],
    ]
    const before = await total(), tags = financeStore().tags.length
    for (const [decisions, status, code] of cases) {
      expect(await confirm(preview, decisions), JSON.stringify(decisions)).toMatchObject({ status, body: { code } })
    }
    expect(await total()).toBe(before)
    expect(financeStore().tags).toHaveLength(tags)
    expect(await confirm(preview)).toMatchObject({ status: 200 })
  })

  test('ambiguous lines need a decision: link to the recorded movement or keep as new', async () => {
    // A statement that prints an already recorded line twice: both copies are ambiguous.
    const state = financeStore()
    const recorded = state.statement.rows.find(row => row.bookingDate <= '2026-10-26')!
    state.statement.rows = [...state.statement.rows, { ...recorded, ordinal: state.statement.rows.length }]
    const preview = (await upload(pdf())).body
    const ambiguous = preview.rows.filter(row => row.status === 'review')
    expect(ambiguous).toHaveLength(2)
    const existing = ambiguous[0].candidates[0]
    expect(ambiguous.every(row => row.candidates.length === 1 && row.candidates[0] === existing)).toBe(true)
    const [first, second] = ambiguous.map(row => row.ordinal)
    expect(await confirm(preview)).toMatchObject({ status: 409, body: { code: 'review_required' } })
    expect(await confirm(preview, [{ ordinal: first, existing_id: existing, create_new: true }, { ordinal: second, create_new: true }]))
      .toMatchObject({ status: 409, body: { code: 'review_required' } })
    expect(await confirm(preview, [{ ordinal: first, existing_id: existing }, { ordinal: second, existing_id: existing }]))
      .toMatchObject({ status: 409, body: { code: 'duplicate_mapping' } })
    expect(await confirm(preview, [{ ordinal: first, existing_id: 1 }, { ordinal: second, create_new: true }]))
      .toMatchObject({ status: 422, body: { code: 'invalid_decision' } })
    const saved = await confirm(preview, [{ ordinal: first, existing_id: existing }, { ordinal: second, create_new: true }])
    expect(saved).toMatchObject({ status: 200, body: { count: preview.rows.length } })
    expect(saved.body.duplicates).toBe(preview.rows.filter(row => row.status === 'duplicate').length + 1)
  })

  test('a first import registers the account after the administrator confirms its IBAN', async () => {
    coreStore().account = null
    const preview = (await upload(pdf())).body
    expect(preview).toMatchObject({ account_confirmed: false, initial_account: true })
    expect(preview.rows.filter(row => row.status === 'new').every(row => row.matched_rule === null && row.category_id === null)).toBe(true)
    expect(await confirm(preview)).toMatchObject({ status: 409, body: { code: 'account_confirmation_required' } })
    const account = (iban: string, version = preview.version) =>
      demoRequest<PreviewOut>('POST', `/api/admin/imports/${preview.id}/account`, { body: { iban, version } })
    expect(await account('ES7999990001230987654321')).toMatchObject({ status: 409, body: { code: 'account_mismatch' } })
    expect(await account('ES0099990001230123456789')).toMatchObject({ status: 422, body: { code: 'invalid_iban' } })
    expect(await account(preview.iban, 2)).toMatchObject({ status: 409, body: { code: 'preview_stale' } })
    const confirmed = await account('es30 9999 0001 2301 2345 6789')
    expect(confirmed).toMatchObject({ status: 200, body: { account_confirmed: true, version: 2, initial_account: true } })
    expect(confirmed.body.rows.find(row => row.description.includes("O'CONNOR"))).toMatchObject({ matched_rule: 'Monthly fees', category_id: 1 })
    expect(await demoRequest('GET', '/api/account')).toMatchObject({ status: 200, body: null })
    expect(await confirm(confirmed.body)).toMatchObject({ status: 200 })
    expect((await demoRequest('GET', '/api/account')).body).toEqual({ iban: 'ES3099990001230123456789', name: 'Community account' })
  })

  test('refuses files that are not complete PDFs, large files and malformed uploads', async () => {
    expect(await upload('Not a PDF at all', 'notes.pdf')).toMatchObject({ status: 422, body: { code: 'unsupported_pdf' } })
    expect(await upload('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n', 'cut.pdf')).toMatchObject({ status: 422, body: { code: 'invalid_pdf' } })
    expect(await upload(new Uint8Array(MAX_UPLOAD_BYTES + 1), 'large.pdf')).toMatchObject({ status: 413, body: { code: 'upload_too_large' } })
    expect(await upload(pdf(), 'x.pdf', { field: 'document' })).toMatchObject({ status: 422, body: { code: 'invalid_request' } })
    expect(await upload(pdf(), 'x.pdf', { header: false })).toMatchObject({ status: 403, body: { code: 'invalid_origin' } })
    expect(await demoRequest('POST', '/api/admin/imports/preview', { body: { file: 'x' } })).toMatchObject({ status: 422, body: { code: 'invalid_request' } })
    expect(financeStore().previews.size).toBe(0)
    // Directories and control characters never reach the stored name.
    expect((await upload(pdf(), 'folder/sub/state\u0007ment.pdf')).body.filename).toBe('statement.pdf')
    await demoRequest('POST', '/api/admin/auth/logout')
    expect(await upload(pdf())).toMatchObject({ status: 401, body: { code: 'authentication_required' } })
  })

  test('fingerprints tell files apart', () => {
    expect(fingerprint(pdf('One'))).toBe(fingerprint(pdf('One')))
    expect(fingerprint(pdf('One'))).not.toBe(fingerprint(pdf('Two')))
  })
})
