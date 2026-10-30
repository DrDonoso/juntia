import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import type { CatalogOut, SummaryOut, TransactionOut, TransactionPage } from '../../api/schema.gen'
import { resetDemo } from '../store'
import { coreStore } from '../store/core'
import { financeStore } from '../store/finance'
import { money } from '../store/finance-ledger'
import { demoRequest } from '../testing'

// Thursday 29 October 2026, midday (local time).
const NOW = new Date(2026, 9, 29, 12, 0)

beforeEach(() => resetDemo({ now: () => NOW }))
afterEach(() => resetDemo())

const page = async (query = '') => {
  const answer = await demoRequest<TransactionPage>('GET', `/api/transactions${query}`)
  expect(answer.status).toBe(200)
  return answer.body
}
const summary = async (query = '') => {
  const answer = await demoRequest<SummaryOut>('GET', `/api/summary${query}`)
  expect(answer.status).toBe(200)
  return answer.body
}
const all = () => [...financeStore().transactions.values()]
const bankPosition = (id: number) => financeStore().order.get(id)!.position
const cents = (value: string) => Math.round(Number(value) * 100)

describe('GET /api/transactions', () => {
  test('pages of 50 in the bank order, newest first, with the API shape', async () => {
    const total = all().length
    const first = await page()
    expect(first).toMatchObject({ total, page: 1, pages: Math.ceil(total / 50) })
    expect(first.items).toHaveLength(50)
    expect(first.items.map(item => bankPosition(item.id))).toEqual(Array.from({ length: 50 }, (_, index) => index))
    const newest = first.items[0]
    expect(Object.keys(newest).sort()).toEqual([
      'amount', 'balance_after', 'booking_date', 'category_id', 'classification_source', 'description', 'id', 'merchant', 'tags',
      'value_date', 'version',
    ])
    expect(newest).toMatchObject({ booking_date: '2026-10-26', amount: '-6.05', merchant: 'Cloudnest Hosting', version: 1 })
    expect(newest.balance_after).toMatch(/^\d+\.\d{2}$/)
    const last = await page(`?page=${first.pages}`)
    expect(last.items.length).toBe(total - 50 * (first.pages - 1))
    expect(await page(`?page=${first.pages + 1}`)).toEqual({ items: [], total, page: first.pages + 1, pages: first.pages })
    expect((await page('?sort=oldest')).items[0].booking_date).toBe('2025-10-01')
    expect((await page('?sort=date&direction=asc')).items[0].booking_date).toBe('2025-10-01')
  })

  test('sorts by every column in both directions, ties in bank order', async () => {
    const byPosition = all().sort((left, right) => bankPosition(left.id) - bankPosition(right.id))
    const ids = (rows: { id: number }[]) => rows.slice(0, 50).map(row => row.id)
    const amountAsc = [...byPosition].sort((left, right) => left.amount - right.amount)
    expect(ids((await page('?sort=amount')).items)).toEqual(ids(amountAsc))
    expect(ids((await page('?sort=amount&direction=desc')).items)).toEqual(ids([...byPosition].sort((left, right) => right.amount - left.amount)))
    expect(ids((await page('?sort=balance&direction=desc')).items)).toEqual(ids([...byPosition].sort((left, right) => right.balance - left.balance)))
    const description = [...byPosition].sort((left, right) => left.description.toLowerCase() < right.description.toLowerCase() ? -1
      : left.description.toLowerCase() > right.description.toLowerCase() ? 1 : 0)
    expect(ids((await page('?sort=description')).items)).toEqual(ids(description))
    // Categories by name; uncategorized transactions last in both directions.
    const names = new Map(financeStore().categories.map(item => [item.id, item.name.toLowerCase()]))
    for (const direction of ['asc', 'desc'] as const) {
      const result = await page(`?sort=category&direction=${direction}&page=${Math.ceil(all().length / 50)}`)
      const last = result.items.at(-1)!
      expect(last.category_id).toBeNull()
      const first = (await page(`?sort=category&direction=${direction}`)).items[0]
      expect(names.get(first.category_id!)).toBe(direction === 'asc' ? 'administration' : 'water')
    }
  })

  test('filters by period, text, category, tags, flow, merchant, amounts and uncategorized', async () => {
    const october = await page('?start=2026-10-01&end=2026-10-31')
    expect(october.total).toBe(all().filter(item => item.bookingDate.startsWith('2026-10')).length)
    expect((await page('?q=monthly%20fee&flow=income&start=2026-10-01')).total).toBe(11)
    expect((await page('?q=MONTHLY fee 4c')).total).toBe(13)
    const cleaning = await page('?category=5')
    expect(cleaning.total).toBe(all().filter(item => item.categoryId === 5).length)
    expect(cleaning.items.every(item => item.category_id === 5 && item.merchant === 'Sparkle Cleaning Co.')).toBe(true)
    expect((await page('?category=0')).total).toBe(all().length)
    const tagged = await page('?tag=1&tag=5&tag=5')
    expect(tagged.items.every(item => item.tags.includes(1) && item.tags.includes(5))).toBe(true)
    expect(tagged.total).toBe(all().filter(item => item.tags.includes(1) && item.tags.includes(5)).length)
    expect((await page(`?${Array.from({ length: 31 }, (_, index) => `tag=${index + 1}`).join('&')}`)).total).toBe(0)
    expect((await page('?tag=0')).total).toBe(0)
    expect((await page('?flow=expense')).items.every(item => cents(item.amount) < 0)).toBe(true)
    expect((await page('?merchant=liftwell')).total).toBe(all().filter(item => item.merchant === 'Liftwell Maintenance').length)
    const exact = await page('?merchant_exact=&flow=expense')
    expect(exact.total).toBe(all().filter(item => item.merchant === '' && item.amount < 0).length)
    expect(exact.items.every(item => item.merchant === '')).toBe(true)
    const range = await page('?minimum=-250&maximum=-200')
    expect(range.items.every(item => cents(item.amount) >= -25_000 && cents(item.amount) <= -20_000)).toBe(true)
    expect(range.total).toBe(all().filter(item => item.amount >= -25_000 && item.amount <= -20_000).length)
    expect((await page('?minimum=0.1&maximum=0.1')).total).toBe(0)
    expect((await page('?minimum=-6.05&maximum=-6.05')).total).toBe(13)
    const uncategorized = await page('?uncategorized=true')
    expect(uncategorized.total).toBe(all().filter(item => item.categoryId === null).length)
    expect(uncategorized.total).toBeGreaterThanOrEqual(4)
  })

  test('refuses malformed parameters and reversed ranges', async () => {
    for (const query of ['?page=0', '?page=x', '?sort=size', '?direction=up', '?start=2026-13-01', '?flow=all', '?category=one',
      '?tag=x', '?minimum=abc', '?uncategorized=maybe']) {
      expect(await demoRequest('GET', `/api/transactions${query}`), query).toMatchObject({ status: 422, body: { code: 'invalid_request' } })
    }
    expect(await demoRequest('GET', '/api/transactions?start=2026-10-02&end=2026-10-01')).toMatchObject({ status: 422, body: { code: 'invalid_range' } })
    expect(await demoRequest('GET', '/api/transactions?minimum=10&maximum=-10')).toMatchObject({ status: 422, body: { code: 'invalid_range' } })
  })

  test('needs a session: a neighbor or the administrator', async () => {
    await demoRequest('POST', '/api/auth/logout')
    expect(await demoRequest('GET', '/api/transactions')).toMatchObject({ status: 401, body: { code: 'authentication_required' } })
    expect(await demoRequest('GET', '/api/summary')).toMatchObject({ status: 401 })
    expect(await demoRequest('GET', '/api/catalog/tags')).toMatchObject({ status: 401 })
    await demoRequest('POST', '/api/admin/auth/login', { body: { username: 'demo', password: 'demo' } })
    expect((await demoRequest('GET', '/api/transactions')).status).toBe(200)
  })
})

describe('GET /api/summary', () => {
  test('totals, months, categories, merchants and days of the period, like the backend', async () => {
    const result = await summary('?start=2026-01-01&end=2026-12-31')
    const rows = all().filter(item => item.bookingDate >= '2026-01-01')
    const income = rows.filter(item => item.amount > 0).reduce((total, item) => total + item.amount, 0)
    const expense = -rows.filter(item => item.amount < 0).reduce((total, item) => total + item.amount, 0)
    expect(result).toMatchObject({ income: money(income), expense: money(expense), net: money(income - expense), count: rows.length })
    expect(result.monthly.map(item => item.month)).toEqual(['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10'])
    for (const month of result.monthly) expect(cents(month.net)).toBe(cents(month.income) - cents(month.expense))
    expect(result.monthly.reduce((total, item) => total + cents(item.income), 0)).toBe(income)
    // Expenses by category: largest first, adding up to the expense, with the backend's fallbacks.
    expect(result.categories.reduce((total, item) => total + cents(item.amount), 0)).toBe(expense)
    expect(result.categories.map(item => cents(item.amount))).toEqual(result.categories.map(item => cents(item.amount)).sort((a, b) => b - a))
    expect(result.categories[0]).toEqual({ category_id: 7, name: 'Repairs', color: '#b43c32', amount: expect.any(String) })
    expect(result.categories.find(item => item.category_id === null)).toEqual({ category_id: null, name: 'Uncategorized', color: '#64748b', amount: expect.any(String) })
    expect(result.merchants).toHaveLength(10)
    expect(result.merchants[0]).toEqual({ name: 'Slatecrest Roofing Ltd.', merchant: 'Slatecrest Roofing Ltd.', color: '#21639f', amount: '12100.00' })
    expect(result.daily.reduce((total, item) => total + cents(item.amount), 0)).toBe(expense)
    expect(result.daily.map(item => item.day)).toEqual(result.daily.map(item => item.day).sort())
    // The balance and coverage describe the whole ledger.
    const newest = all().sort((left, right) => bankPosition(left.id) - bankPosition(right.id))[0]
    expect(result).toMatchObject({
      balance: money(newest.balance), balance_date: '2026-10-26', coverage_start: '2025-10-01', coverage_end: '2026-10-26',
    })
  })

  test('the filters of the drill-downs: a category, no merchant, a merchant', async () => {
    const water = await summary('?category=3')
    expect(water.categories).toEqual([{ category_id: 3, name: 'Water', color: '#007c91', amount: water.expense }])
    expect(water.merchants).toEqual([{ name: 'Brightwater Utilities', merchant: 'Brightwater Utilities', color: '#21639f', amount: water.expense }])
    const unnamed = await summary('?merchant_exact=&flow=expense')
    expect(unnamed.merchants).toEqual([{ name: 'No merchant', merchant: '', color: '#21639f', amount: unnamed.expense }])
    expect(unnamed.income).toBe('0.00')
    const nothing = await summary('?start=2020-01-01&end=2020-12-31')
    expect(nothing).toEqual({
      income: '0.00', expense: '0.00', net: '0.00', count: 0, balance: expect.any(String), balance_date: '2026-10-26',
      coverage_start: '2025-10-01', coverage_end: '2026-10-26', monthly: [], categories: [], merchants: [], daily: [],
    })
  })

  test('an empty ledger has no balance or coverage', async () => {
    const state = financeStore()
    state.transactions.clear()
    state.imports.length = 0
    state.order.clear()
    expect(await summary()).toEqual({
      income: '0.00', expense: '0.00', net: '0.00', count: 0, balance: null, balance_date: null, coverage_start: null,
      coverage_end: null, monthly: [], categories: [], merchants: [], daily: [],
    })
    expect(await page()).toEqual({ items: [], total: 0, page: 1, pages: 1 })
  })
})

describe('GET /api/catalog/{kind}', () => {
  test('categories by name, tags by use, with the seed colors', async () => {
    const categories = (await demoRequest<CatalogOut[]>('GET', '/api/catalog/categories')).body
    expect(categories.map(item => item.name)).toEqual(categories.map(item => item.name).sort())
    expect(categories).toHaveLength(13)
    expect(categories.find(item => item.id === 1)).toEqual({ id: 1, name: 'Regular fees', color: '#1a4d8f' })
    const tags = (await demoRequest<CatalogOut[]>('GET', '/api/catalog/tags')).body
    const uses = (id: number) => all().filter(item => item.tags.includes(id)).length
    expect(tags.map(item => uses(item.id))).toEqual(tags.map(item => uses(item.id)).sort((a, b) => b - a))
    expect(tags[0].name).toBe('Recurring')
    expect(tags).toHaveLength(6)
    expect(tags.every(item => item.color === '#64748b')).toBe(true)
    expect(await demoRequest('GET', '/api/catalog/labels')).toMatchObject({ status: 422, body: { code: 'invalid_request' } })
  })
})

describe('the account', () => {
  test('is the cast IBAN; the transactions are the community account\'s', async () => {
    expect((await demoRequest('GET', '/api/account')).body).toEqual({ iban: coreStore().account!.iban, name: 'Community account' })
    const row: TransactionOut = (await page()).items[0]
    expect(row.description).toMatch(/^[A-Z]/)
  })
})
