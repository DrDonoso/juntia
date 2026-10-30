import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import type { CatalogOut, RuleImpact, RuleOut, TransactionOut } from '../../api/schema.gen'
import { resetDemo } from '../store'
import { coreStore } from '../store/core'
import { financeStore } from '../store/finance'
import { demoRequest } from '../testing'

// Thursday 29 October 2026, midday (local time).
const NOW = new Date(2026, 9, 29, 12, 0)

beforeEach(async () => {
  resetDemo({ now: () => NOW })
  expect((await demoRequest('POST', '/api/admin/auth/login', { body: { username: 'demo', password: 'demo' } })).status).toBe(200)
})
afterEach(() => resetDemo())

const transactions = () => [...financeStore().transactions.values()]
const revision = () => financeStore().revision
const tags = async () => (await demoRequest<CatalogOut[]>('GET', '/api/catalog/tags')).body

describe('finance administration access', () => {
  test('needs the administrator session and the write header', async () => {
    await demoRequest('POST', '/api/admin/auth/logout')
    for (const [method, path, body] of [
      ['GET', '/api/admin/rules'], ['POST', '/api/admin/rules', {}], ['PUT', '/api/admin/rules/1', {}], ['DELETE', '/api/admin/rules/1'],
      ['POST', '/api/admin/rules/preview', {}], ['POST', '/api/admin/rules/apply', {}], ['PATCH', '/api/admin/account', {}],
      ['POST', '/api/admin/catalog/tags', {}], ['PATCH', '/api/admin/catalog/tags/1', {}], ['DELETE', '/api/admin/catalog/tags/1'],
      ['PATCH', '/api/admin/transactions/1', {}],
    ] as const) {
      // The sample neighbor is signed in: neighbors get the administrator's 401 too.
      expect(await demoRequest(method, path, { body }), `${method} ${path}`).toMatchObject({ status: 401, body: { code: 'authentication_required' } })
    }
    await demoRequest('POST', '/api/admin/auth/login', { body: { username: 'demo', password: 'demo' } })
    expect(await demoRequest('PATCH', '/api/admin/account', { body: { name: 'X' }, mutationHeader: false }))
      .toMatchObject({ status: 403, body: { code: 'invalid_origin' } })
  })
})

describe('PATCH /api/admin/account', () => {
  test('renames the account (trimmed) and bumps the finance revision', async () => {
    const before = revision()
    expect(await demoRequest('PATCH', '/api/admin/account', { body: { name: '  Maple Court main account ' } }))
      .toMatchObject({ status: 200, body: { iban: 'ES3099990001230123456789', name: 'Maple Court main account' } })
    expect((await demoRequest('GET', '/api/account')).body).toEqual({ iban: 'ES3099990001230123456789', name: 'Maple Court main account' })
    expect(revision()).toBe(before + 1)
  })

  test('refuses blank, long or extra fields, and needs a registered account', async () => {
    for (const body of [{ name: '   ' }, { name: '' }, { name: 'x'.repeat(151) }, {}, { name: 'Ok', iban: 'ES00' }]) {
      expect(await demoRequest('PATCH', '/api/admin/account', { body }), JSON.stringify(body)).toMatchObject({ status: 422, body: { code: 'invalid_request' } })
    }
    coreStore().account = null
    expect(await demoRequest('PATCH', '/api/admin/account', { body: { name: 'Account' } }))
      .toMatchObject({ status: 409, body: { code: 'account_confirmation_required' } })
  })
})

describe('the catalog', () => {
  test('creates, renames and recolors categories and tags with unique names', async () => {
    const created = await demoRequest<CatalogOut>('POST', '/api/admin/catalog/categories', { body: { name: '  Garden   works ' } })
    expect(created).toMatchObject({ status: 201, body: { id: 14, name: 'Garden works', color: '#21639f' } })
    expect((await demoRequest<CatalogOut[]>('GET', '/api/catalog/categories')).body.map(item => item.name)).toContain('Garden works')
    expect(await demoRequest('POST', '/api/admin/catalog/categories', { body: { name: 'WATER' } })).toMatchObject({ status: 409, body: { code: 'name_exists' } })
    expect(await demoRequest('POST', '/api/admin/catalog/tags', { body: { name: '\uff32\uff45\uff46\uff55\uff4e\uff44' } }))
      .toMatchObject({ status: 409, body: { code: 'name_exists' } })
    expect(await demoRequest('POST', '/api/admin/catalog/tags', { body: { name: 'Insurance claim', color: '#ABCDEF' } }))
      .toMatchObject({ status: 201, body: { id: 7, name: 'Insurance claim', color: '#ABCDEF' } })
    for (const body of [{ name: '   ' }, { name: 'x'.repeat(101) }, { name: 'Bad', color: 'red' }, { name: 'Bad', extra: 1 }]) {
      expect(await demoRequest('POST', '/api/admin/catalog/tags', { body }), JSON.stringify(body)).toMatchObject({ status: 422, body: { code: 'invalid_request' } })
    }
    expect(await demoRequest('PATCH', '/api/admin/catalog/categories/14', { body: { name: 'Gardening', color: '#08735a' } }))
      .toMatchObject({ status: 200, body: { id: 14, name: 'Gardening', color: '#08735a' } })
    // A PATCH replaces the item: without a color it takes the default one.
    expect(await demoRequest('PATCH', '/api/admin/catalog/categories/14', { body: { name: 'gardening' } }))
      .toMatchObject({ status: 200, body: { id: 14, name: 'gardening', color: '#21639f' } })
    expect(await demoRequest('PATCH', '/api/admin/catalog/categories/14', { body: { name: 'Taxes' } })).toMatchObject({ status: 409, body: { code: 'name_exists' } })
    expect(await demoRequest('PATCH', '/api/admin/catalog/tags/99', { body: { name: 'Nope' } })).toMatchObject({ status: 404, body: { code: 'item_not_found' } })
    expect(await demoRequest('POST', '/api/admin/catalog/labels', { body: { name: 'Nope' } })).toMatchObject({ status: 422, body: { code: 'invalid_request' } })
  })

  test('deletes only what no transaction or rule uses', async () => {
    const before = revision()
    expect(await demoRequest('DELETE', '/api/admin/catalog/categories/5')).toMatchObject({ status: 409, body: { code: 'item_in_use' } })
    expect(await demoRequest('DELETE', '/api/admin/catalog/tags/3')).toMatchObject({ status: 409, body: { code: 'item_in_use' } })
    // Bank fees: no rule if every transaction moves elsewhere, still used by its rule.
    for (const item of transactions().filter(row => row.categoryId === 12)) item.categoryId = 13
    expect(await demoRequest('DELETE', '/api/admin/catalog/categories/12')).toMatchObject({ status: 409, body: { code: 'item_in_use' } })
    const created = await demoRequest<CatalogOut>('POST', '/api/admin/catalog/tags', { body: { name: 'Temporary' } })
    expect(await demoRequest('DELETE', `/api/admin/catalog/tags/${created.body.id}`)).toMatchObject({ status: 204, body: undefined })
    expect((await tags()).some(item => item.name === 'Temporary')).toBe(false)
    expect(await demoRequest('DELETE', `/api/admin/catalog/tags/${created.body.id}`)).toMatchObject({ status: 404, body: { code: 'item_not_found' } })
    expect(revision()).toBe(before + 2)
  })
})

describe('PATCH /api/admin/transactions/{id}', () => {
  const uncategorized = () => transactions().find(row => row.description === 'CARD PAYMENT HARTLEY HARDWARE 0412')!

  test('classifies a movement by hand, reusing or creating tags', async () => {
    const row = uncategorized()
    const answer = await demoRequest<TransactionOut>('PATCH', `/api/admin/transactions/${row.id}`, { body: {
      version: 1, category_id: 6, merchant: 'Hartley Hardware', tags: [1, 1],
      new_tags: [{ name: '  recurring ' }, { name: 'Light bulbs', color: '#2BCCB4' }],
    } })
    expect(answer.status).toBe(200)
    const created = (await tags()).find(item => item.name === 'Light bulbs')!
    expect(created).toEqual({ id: 7, name: 'Light bulbs', color: '#2bccb4' })
    expect(answer.body).toEqual({
      id: row.id, booking_date: row.bookingDate, value_date: row.valueDate, description: row.description, amount: '-37.85',
      balance_after: answer.body.balance_after, category_id: 6, merchant: 'Hartley Hardware', tags: [1, 7],
      classification_source: 'manual', version: 2,
    })
    // Omitted fields are cleared: the request replaces the classification.
    expect(await demoRequest('PATCH', `/api/admin/transactions/${row.id}`, { body: { version: 2, tags: [] } }))
      .toMatchObject({ status: 200, body: { category_id: null, merchant: '', tags: [], version: 3 } })
    expect((await demoRequest<{ items: TransactionOut[] }>('GET', '/api/transactions?q=hartley hardware 0412')).body.items[0])
      .toMatchObject({ id: row.id, version: 3 })
  })

  test('checks the version, the classification and the contract, without creating tags on failure', async () => {
    const row = uncategorized()
    const before = await tags()
    const draft = { new_tags: [{ name: 'Not saved' }] }
    expect(await demoRequest('PATCH', `/api/admin/transactions/${row.id}`, { body: { ...draft, version: 2 } }))
      .toMatchObject({ status: 409, body: { code: 'preview_stale' } })
    expect(await demoRequest('PATCH', `/api/admin/transactions/${row.id}`, { body: { ...draft, version: 1, category_id: 999 } }))
      .toMatchObject({ status: 409, body: { code: 'unknown_classification' } })
    expect(await demoRequest('PATCH', `/api/admin/transactions/${row.id}`, { body: { ...draft, version: 1, tags: [999] } }))
      .toMatchObject({ status: 409, body: { code: 'unknown_classification' } })
    for (const body of [
      { version: 1, amount: '100' }, { version: 0 }, { tags: [] }, { version: 1, merchant: 'x'.repeat(201) },
      { version: 1, tags: Array.from({ length: 31 }, (_, index) => index + 1) }, { version: 1, new_tags: [{ name: 'Fam' }, { name: 'FAM' }] },
      { version: 1, new_tags: [{ name: 'Bad\nname' }] }, { version: 1, new_tags: [{ name: 'Tag', color: 'red' }] },
    ]) {
      expect(await demoRequest('PATCH', `/api/admin/transactions/${row.id}`, { body }), JSON.stringify(body))
        .toMatchObject({ status: 422, body: { code: 'invalid_request' } })
    }
    expect(await demoRequest('PATCH', '/api/admin/transactions/999999', { body: { version: 1 } }))
      .toMatchObject({ status: 404, body: { code: 'transaction_not_found' } })
    expect(await tags()).toEqual(before)
    expect(row.version).toBe(1)
  })
})

describe('classification rules', () => {
  const rule = { name: 'Plumbing', description_value: 'swiftflow', set_category: 7, set_merchant: 'Swiftflow Plumbing', add_tags: [4] }

  test('lists, creates, updates and deletes rules with the backend contract', async () => {
    const listed = (await demoRequest<RuleOut[]>('GET', '/api/admin/rules')).body
    expect(listed.map(item => item.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect(listed[3]).toEqual({
      id: 4, name: 'Lift maintenance', priority: 50, enabled: true, description_mode: 'contains', description_value: 'LIFTWELL',
      detail_mode: null, detail_value: null, amount_sign: null, amount_min: null, amount_max: null, account_ref: null, currency: null,
      set_category: 6, set_merchant: 'Liftwell Maintenance', add_tags: [1, 5], skip_ai: true,
    })
    const created = await demoRequest<RuleOut>('POST', '/api/admin/rules', { body: {
      ...rule, amount_min: 10, amount_max: '500.5', account_ref: 'es30 9999 0001 2301 2345 6789',
    } })
    expect(created).toMatchObject({ status: 201, body: {
      id: 9, priority: 100, enabled: true, description_mode: 'contains', amount_min: '10.00', amount_max: '500.50',
      account_ref: 'ES3099990001230123456789', skip_ai: true, add_tags: [4],
    } })
    expect(await demoRequest('PUT', '/api/admin/rules/9', { body: { ...rule, priority: 20, enabled: false } }))
      .toMatchObject({ status: 200, body: { id: 9, priority: 20, enabled: false, amount_min: null, account_ref: null } })
    expect((await demoRequest<RuleOut[]>('GET', '/api/admin/rules')).body.at(-1)).toMatchObject({ id: 9, priority: 20 })
    expect(await demoRequest('DELETE', '/api/admin/rules/9')).toMatchObject({ status: 204 })
    expect(await demoRequest('DELETE', '/api/admin/rules/9')).toMatchObject({ status: 404, body: { code: 'rule_not_found' } })
    expect(await demoRequest('PUT', '/api/admin/rules/9', { body: rule })).toMatchObject({ status: 404, body: { code: 'rule_not_found' } })
  })

  test('validates patterns, classifications, IBANs and conditions (before looking the rule up)', async () => {
    const cases: [object, number, string][] = [
      [{ ...rule, description_mode: 'regex', description_value: '(unclosed' }, 422, 'invalid_regex'],
      [{ ...rule, set_category: 99 }, 409, 'unknown_classification'],
      [{ ...rule, add_tags: [99] }, 409, 'unknown_classification'],
      [{ ...rule, account_ref: 'ES0099990001230123456789' }, 422, 'invalid_iban'],
      [{ ...rule, detail_mode: 'contains' }, 422, 'invalid_request'],
      [{ ...rule, amount_min: '10', amount_max: '5' }, 422, 'invalid_request'],
      [{ ...rule, amount_min: '1.234' }, 422, 'invalid_request'],
      [{ ...rule, description_value: '' }, 422, 'invalid_request'],
      [{ ...rule, priority: 100_001 }, 422, 'invalid_request'],
      [{ ...rule, unknown: true }, 422, 'invalid_request'],
    ]
    for (const [body, status, code] of cases) {
      expect(await demoRequest('POST', '/api/admin/rules', { body }), JSON.stringify(body)).toMatchObject({ status, body: { code } })
      expect(await demoRequest('PUT', '/api/admin/rules/999', { body }), JSON.stringify(body)).toMatchObject({ status, body: { code } })
    }
    expect(financeStore().rules).toHaveLength(8)
  })

  test('previews a rule on the history and applies it, overriding manual corrections', async () => {
    const lift = { name: 'Lift maintenance', description_value: 'LIFTWELL', set_category: 6, set_merchant: 'Liftwell Maintenance', add_tags: [1, 5] }
    const preview = await demoRequest<RuleImpact>('POST', '/api/admin/rules/preview', { body: lift })
    const matching = transactions().filter(row => row.description.includes('LIFTWELL'))
    expect(preview).toMatchObject({ status: 200, body: { revision: revision(), count: matching.length } })
    expect(preview.body.sample.map(row => row.id)).toEqual(matching.slice(0, 10).map(row => row.id))
    const repair = matching.find(row => row.categoryId === 7)!
    expect(repair).toMatchObject({ source: 'manual', tags: [4] })

    expect(await demoRequest('POST', '/api/admin/rules/apply', { body: { revision: preview.body.revision - 1, rule: lift } }))
      .toMatchObject({ status: 409, body: { code: 'preview_stale' } })
    expect(await demoRequest('POST', '/api/admin/rules/apply', { body: { revision: preview.body.revision } }))
      .toMatchObject({ status: 422, body: { code: 'invalid_request' } })
    const applied = await demoRequest<RuleImpact>('POST', '/api/admin/rules/apply', { body: { revision: preview.body.revision, rule: lift } })
    expect(applied).toMatchObject({ status: 200, body: { revision: preview.body.revision + 1, count: matching.length } })
    expect(applied.body.sample.every(row => row.classification_source === 'rule' && row.version === 2)).toBe(true)
    expect(repair).toMatchObject({ categoryId: 6, merchant: 'Liftwell Maintenance', tags: [1, 4, 5], source: 'rule', version: 2 })
    // Applying again needs a fresh preview.
    expect(await demoRequest('POST', '/api/admin/rules/apply', { body: { revision: preview.body.revision, rule: lift } }))
      .toMatchObject({ status: 409, body: { code: 'preview_stale' } })
  })

  test('disabled rules, other accounts and amount limits narrow the matches', async () => {
    const count = async (body: object) => (await demoRequest<RuleImpact>('POST', '/api/admin/rules/preview', { body })).body.count
    const fees = { name: 'Fees', description_value: 'monthly fee', amount_sign: 'positive' }
    expect(await count(fees)).toBe(transactions().filter(row => row.description.includes('MONTHLY FEE')).length)
    expect(await count({ ...fees, enabled: false })).toBe(0)
    expect(await count({ ...fees, account_ref: 'ES7999990001230987654321' })).toBe(0)
    expect(await count({ ...fees, amount_min: '330', description_mode: 'starts_with', description_value: 'transfer from' }))
      .toBe(transactions().filter(row => row.description.startsWith('TRANSFER FROM') && row.amount >= 33_000).length)
    expect(await count({ name: 'Exact', description_mode: 'exact', description_value: 'cash deposit branch 0231' })).toBe(1)
    expect(await count({ name: 'Regex', description_mode: 'regex', description_value: '^card payment .* (?P<ref>\\d{4})$' }))
      .toBe(transactions().filter(row => /^CARD PAYMENT .* \d{4}$/.test(row.description)).length)
    expect(await count({ name: 'Detail', description_value: 'fee', detail_mode: 'contains', detail_value: 'x' })).toBe(0)
    coreStore().account = null
    expect(await count(fees)).toBe(0)
  })
})
