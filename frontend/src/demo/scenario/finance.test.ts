import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { COMMUNITY, DWELLINGS } from '../cast'
import { addDays, addMonths, instant, startOfMonth } from '../core/clock'
import { resetDemo } from '../store'
import { financeStore } from '../store/finance'
import { bankOrder, money, sourceKey, type FinanceState } from '../store/finance-ledger'
import { firstMatchingRule } from '../store/finance-rules'
import { financeScenario } from './finance'
import { IMPORT_LAG_DAYS, MONTHLY_BUDGET, bankTimeline, share } from './finance-schedule'

// Thursday 29 October 2026, midday (local time).
const NOW = new Date(2026, 9, 29, 12, 0)

beforeEach(() => resetDemo({ now: () => NOW }))
afterEach(() => resetDemo())

const inBankOrder = (state: FinanceState) =>
  [...state.transactions.values()].sort((left, right) => state.order.get(left.id)!.position - state.order.get(right.id)!.position)

function expectConsistent(state: FinanceState, today: string, now = NOW) {
  const transactions = [...state.transactions.values()]
  // Ids are unique, amounts are cents and dates are real days up to today.
  expect(new Set(transactions.map(item => item.id)).size).toBe(transactions.length)
  for (const item of transactions) {
    expect(Number.isInteger(item.amount) && item.amount !== 0).toBe(true)
    expect(money(item.amount)).toMatch(/^-?\d+\.\d{2}$/)
    expect(item.bookingDate <= today).toBe(true)
    expect(item.valueDate <= item.bookingDate).toBe(true)
    expect(item.description).toMatch(/^[A-Z0-9 .,'/%&()+-]+$/)
    expect(item.categoryId === null || state.categories.some(category => category.id === item.categoryId)).toBe(true)
    expect(item.tags.every(tag => state.tags.some(known => known.id === tag))).toBe(true)
    expect(item.balance).toBeGreaterThan(0)
  }
  // The balances chain from the oldest movement to the newest.
  const chronological = inBankOrder(state).reverse()
  chronological.slice(1).forEach((item, index) => expect(item.balance).toBe(chronological[index].balance + item.amount))
  // Every movement belongs to exactly one statement, whose period and balances it matches.
  const owners = new Map<number, number>()
  for (const record of state.imports) {
    expect(record.rows.map(row => row.ordinal)).toEqual(record.rows.map((_, index) => index))
    for (const row of record.rows) {
      owners.set(row.transactionId, (owners.get(row.transactionId) ?? 0) + 1)
      const transaction = state.transactions.get(row.transactionId)!
      expect(sourceKey(row.source)).toBe(transaction.sourceKey)
      expect(row.source.bookingDate >= record.startDate && row.source.bookingDate <= record.endDate).toBe(true)
    }
    const [newest, oldest] = [record.rows[0].source, record.rows.at(-1)!.source]
    expect(record.closingBalance).toBe(newest.balance)
    expect(record.openingBalance).toBe(oldest.balance - oldest.amount)
    expect(record.startDate.slice(0, 7)).toBe(record.endDate.slice(0, 7))
    expect(record.createdAt < now.toISOString() && record.createdAt > instant(record.endDate, '00:00')).toBe(true)
  }
  expect([...owners.values()].every(count => count === 1)).toBe(true)
  expect(owners.size).toBe(transactions.length)
}

describe('the finance scenario', () => {
  test('thirteen monthly statements up to a few days ago, consistent with their movements', () => {
    const state = financeStore()
    expect(state.imports).toHaveLength(13)
    expect(state.imports.map(record => record.filename)).toEqual(
      Array.from({ length: 13 }, (_, index) => `statement-${addMonths('2025-10-01', index).slice(0, 7)}.pdf`))
    expect(state.imports.map(record => record.createdAt)).toEqual(state.imports.map(record => record.createdAt).sort())
    expectConsistent(state, '2026-10-29')
    const latest = inBankOrder(state)[0]
    expect(latest.bookingDate <= addDays('2026-10-29', -IMPORT_LAG_DAYS)).toBe(true)
    for (const record of state.imports.slice(0, -1)) expect(record.rows.length).toBeGreaterThanOrEqual(20)
  })

  test('fees follow the ownership coefficients, with late, missing and pending payments', () => {
    const state = financeStore()
    const fees = [...state.transactions.values()].filter(item => item.description.includes('MONTHLY FEE'))
    expect(DWELLINGS.reduce((total, dwelling) => total + share(dwelling, MONTHLY_BUDGET), 0)).toBe(MONTHLY_BUDGET)
    expect(fees.every(item => item.categoryId === 1 && item.source === 'rule')).toBe(true)
    expect(fees.find(item => item.description.includes('MONTHLY FEE 1A'))?.amount).toBe(32_040)
    // 4C missed one month and paid it the next one; 1B's latest fee waits in the next statement.
    expect(fees.filter(item => item.description.includes(' 4C '))).toHaveLength(13)
    expect(fees.filter(item => item.description.includes(' 1B '))).toHaveLength(12)
    expect(fees.filter(item => item.description.includes(' 3C ') && Number(item.bookingDate.slice(8)) > 15)).toHaveLength(2)
  })

  test('rules classified what they match, and the rest was classified by hand or not at all', () => {
    const state = financeStore()
    const transactions = [...state.transactions.values()]
    for (const item of transactions.filter(transaction => transaction.source === 'rule')) {
      const rule = firstMatchingRule(state.rules, item, COMMUNITY.account.iban)!
      expect({ category: item.categoryId, merchant: item.merchant, tags: item.tags })
        .toEqual({ category: rule.set_category, merchant: rule.set_merchant ?? '', tags: [...rule.add_tags].sort() })
    }
    expect(new Set(transactions.map(item => item.categoryId))).toEqual(new Set([null, ...state.categories.map(item => item.id)]))
    expect(new Set(transactions.flatMap(item => item.tags))).toEqual(new Set(state.tags.map(item => item.id)))
    expect(transactions.filter(item => item.categoryId === null).length).toBeGreaterThanOrEqual(3)
    expect(state.rules.length).toBeGreaterThanOrEqual(5)
  })

  test('the synthetic statement repeats the latest imported days and adds the movements since', () => {
    const state = financeStore()
    const { rows } = state.statement
    const known = new Set([...state.transactions.values()].map(item => item.sourceKey))
    const repeated = rows.filter(row => known.has(sourceKey(row)))
    const fresh = rows.filter(row => !known.has(sourceKey(row)))
    expect(repeated.length).toBeGreaterThanOrEqual(6)
    expect(fresh.length).toBeGreaterThanOrEqual(3)
    expect(rows.length).toBeLessThanOrEqual(30)
    expect(rows.map(row => row.ordinal)).toEqual(rows.map((_, index) => index))
    // Newest first, and its balances continue the account's.
    rows.slice(0, -1).forEach((row, index) => expect(row.balance - row.amount).toBe(rows[index + 1].balance))
    expect(fresh.every(row => row.bookingDate > addDays('2026-10-29', -IMPORT_LAG_DAYS) && row.bookingDate <= '2026-10-29')).toBe(true)
    expect(state.statement.iban).toBe(COMMUNITY.account.iban)
  })

  test('is the same on every visit and works whatever day today is', () => {
    expect(JSON.stringify([...financeScenario().transactions.values()])).toBe(JSON.stringify([...financeStore().transactions.values()]))
    for (const day of [new Date(2027, 0, 1, 9), new Date(2028, 1, 29, 18), new Date(2026, 4, 31, 23, 30), new Date(2026, 10, 1, 8), new Date(2026, 6, 4, 12)]) {
      resetDemo({ now: () => day })
      const state = financeStore()
      const today = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`
      expect(state.imports).toHaveLength(13)
      expect(state.imports[0].startDate >= addMonths(startOfMonth(addDays(today, -IMPORT_LAG_DAYS)), -12)).toBe(true)
      expectConsistent(state, today, day)
      expect(bankOrder(state.transactions, state.imports)).toEqual(state.order)
      const timeline = bankTimeline(today)
      expect(timeline.movements.every(item => item.balance > 0)).toBe(true)
      expect(state.statement.rows.filter(row => row.bookingDate > timeline.recordedUntil).length).toBeGreaterThanOrEqual(3)
    }
  })
})
