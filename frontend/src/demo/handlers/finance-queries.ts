/**
 * The reader's finance queries with the backend's semantics (src/juntia/queries.py): the filters of
 * Overview and Transactions, the canonical bank order and column sorting of the ledger (50 per
 * page), the summary's totals, monthly trend, category and merchant breakdowns and the balance of
 * the latest day, and the catalogs (tags by usage).
 */
import type {
  CatalogOut, CategoryBreakdown, MerchantBreakdown, MonthlyTotal, SummaryOut, TransactionPage,
} from '../../api/schema.gen'
import { DemoApiError, queryBool, queryChoice, queryDay } from '../core'
import type { FinanceState } from '../store/finance'
import {
  MERCHANT_COLOR, NEUTRAL_COLOR, casefold, compareText, money, transactionOut, type DemoTransaction,
} from '../store/finance-ledger'

/** Transactions per page (backend `transaction_page`). */
export const TRANSACTION_PAGE_SIZE = 50

/** An exact decimal: `units / 10^scale`. */
interface Decimal {
  units: bigint
  scale: number
}

export interface TransactionFilters {
  start: string | null
  end: string | null
  q: string
  category: number | null
  tags: number[]
  flow: '' | 'income' | 'expense'
  merchant: string
  minimum: Decimal | null
  maximum: Decimal | null
  uncategorized: boolean
  merchantExact: string | null
}

export const SORTS = ['date', 'description', 'category', 'amount', 'balance', 'newest', 'oldest'] as const
export type TransactionSort = (typeof SORTS)[number]

const invalidRequest = () => new DemoApiError('invalid_request', 422)

/** FastAPI's `int` query value (any size); null when absent. */
function integer(url: URL, name: string): number | null {
  const raw = url.searchParams.get(name)
  if (raw === null) return null
  if (!/^\s*[+-]?\d+\s*$/.test(raw)) throw invalidRequest()
  return Number(raw)
}

/** Pydantic's `Decimal` query value; null when absent. */
function decimal(url: URL, name: string): Decimal | null {
  const raw = url.searchParams.get(name)
  if (raw === null) return null
  const match = /^\s*([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d{1,3}))?\s*$/.exec(raw)
  if (!match || !(match[2] || match[3])) throw invalidRequest()
  const fraction = match[3] ?? ''
  let units = BigInt(`${match[2] || '0'}${fraction}`)
  let scale = fraction.length - Number(match[4] ?? 0)
  if (scale < 0) {
    units *= 10n ** BigInt(-scale)
    scale = 0
  }
  return { units: match[1] === '-' ? -units : units, scale }
}

/** Compares cents with a decimal exactly: negative, zero or positive like a comparator. */
function compareCents(amount: number, value: Decimal): number {
  const left = BigInt(amount) * 10n ** BigInt(value.scale)
  const right = value.units * 100n
  return left < right ? -1 : left > right ? 1 : 0
}

function compareDecimals(left: Decimal, right: Decimal): number {
  const scale = Math.max(left.scale, right.scale)
  const a = left.units * 10n ** BigInt(scale - left.scale), b = right.units * 10n ** BigInt(scale - right.scale)
  return a < b ? -1 : a > b ? 1 : 0
}

/** The filters of a request (backend `filtered`): 422 for malformed values, `invalid_range` for reversed ranges. */
export function readFilters(url: URL): TransactionFilters {
  const filters: TransactionFilters = {
    start: queryDay(url, 'start'),
    end: queryDay(url, 'end'),
    q: url.searchParams.get('q') ?? '',
    category: integer(url, 'category'),
    tags: url.searchParams.getAll('tag').map(raw => {
      if (!/^\s*[+-]?\d+\s*$/.test(raw)) throw invalidRequest()
      return Number(raw)
    }),
    flow: queryChoice(url, 'flow', ['', 'income', 'expense'] as const, ''),
    merchant: url.searchParams.get('merchant') ?? '',
    minimum: decimal(url, 'minimum'),
    maximum: decimal(url, 'maximum'),
    uncategorized: queryBool(url, 'uncategorized'),
    merchantExact: url.searchParams.get('merchant_exact'),
  }
  if ((filters.start && filters.end && filters.start > filters.end)
    || (filters.minimum && filters.maximum && compareDecimals(filters.minimum, filters.maximum) > 0)) {
    throw new DemoApiError('invalid_range')
  }
  return filters
}

/** The transactions the filters select (backend `queries.transactions`), in id order. */
export function filterTransactions(state: FinanceState, filters: TransactionFilters): DemoTransaction[] {
  const tags = [...new Set(filters.tags)]
  if (tags.length > 30 || tags.some(tag => tag < 1 || tag > 2_147_483_647)) return []
  const q = casefold(filters.q), merchant = casefold(filters.merchant)
  return [...state.transactions.values()].filter(item =>
    (!filters.start || item.bookingDate >= filters.start)
    && (!filters.end || item.bookingDate <= filters.end)
    && (!filters.category || item.categoryId === filters.category)
    && (!filters.uncategorized || item.categoryId === null)
    && (filters.merchantExact === null || item.merchant === filters.merchantExact)
    && (filters.flow !== 'income' || item.amount > 0)
    && (filters.flow !== 'expense' || item.amount < 0)
    && (!filters.minimum || compareCents(item.amount, filters.minimum) >= 0)
    && (!filters.maximum || compareCents(item.amount, filters.maximum) <= 0)
    && (!q || casefold(item.description).includes(q))
    && (!merchant || casefold(item.merchant).includes(merchant))
    && tags.every(tag => item.tags.includes(tag)))
}

function position(state: FinanceState, item: DemoTransaction): number {
  const place = state.order.get(item.id)
  if (!place) throw new DemoApiError('bank_order_missing', 503)
  return place.position
}

/** A page of the ledger (backend `transaction_page`): bank order by default, or a column. */
export function transactionPage(
  state: FinanceState, rows: readonly DemoTransaction[], page: number, sort: TransactionSort, requested: 'asc' | 'desc' | null,
): TransactionPage {
  const total = rows.length
  const pages = Math.max(1, Math.ceil(total / TRANSACTION_PAGE_SIZE))
  if (page > pages || total === 0) return { items: [], total, page, pages }
  let column: Exclude<TransactionSort, 'newest' | 'oldest'>, direction: 'asc' | 'desc'
  if (sort === 'newest' || sort === 'oldest') [column, direction] = ['date', sort === 'newest' ? 'desc' : 'asc']
  else [column, direction] = [sort, requested ?? (sort === 'date' ? 'desc' : 'asc')]
  const sign = direction === 'asc' ? 1 : -1
  const names = new Map(state.categories.map(category => [category.id, casefold(category.name)]))
  const compare = (left: DemoTransaction, right: DemoTransaction): number => {
    switch (column) {
      case 'date': return -sign * (position(state, left) - position(state, right))
      case 'category': {
        // Uncategorized transactions come last in both directions.
        if ((left.categoryId === null) !== (right.categoryId === null)) return left.categoryId === null ? 1 : -1
        if (left.categoryId === null || right.categoryId === null) return 0
        return sign * compareText(names.get(left.categoryId) ?? '', names.get(right.categoryId) ?? '')
      }
      case 'description': return sign * compareText(casefold(left.description), casefold(right.description))
      case 'amount': return sign * (left.amount - right.amount)
      case 'balance': return sign * (left.balance - right.balance)
    }
  }
  const sorted = [...rows].sort((left, right) => compare(left, right) || position(state, left) - position(state, right))
  const items = sorted.slice((page - 1) * TRANSACTION_PAGE_SIZE, page * TRANSACTION_PAGE_SIZE).map(transactionOut)
  return { items, total, page, pages }
}

interface Group {
  amount: number
  first: number
}

/** Expenses grouped by a key, largest first, ties in bank order (backend `summary`). */
function expenseGroups<K>(state: FinanceState, rows: readonly DemoTransaction[], key: (item: DemoTransaction) => K): [K, Group][] {
  const groups = new Map<K, Group>()
  for (const item of rows) {
    if (item.amount >= 0) continue
    const group = groups.get(key(item))
    const place = position(state, item)
    if (group) {
      group.amount -= item.amount
      group.first = Math.min(group.first, place)
    } else {
      groups.set(key(item), { amount: -item.amount, first: place })
    }
  }
  return [...groups].sort(([, left], [, right]) => right.amount - left.amount || left.first - right.first)
}

/** The backend's `summary` of the selected transactions (the balance and coverage are the whole ledger's). */
export function summaryOf(state: FinanceState, rows: readonly DemoTransaction[]): SummaryOut {
  let income = 0, expense = 0
  const months = new Map<string, { income: number; expense: number }>()
  const days = new Map<string, number>()
  for (const item of rows) {
    position(state, item)
    const month = months.get(item.bookingDate.slice(0, 7)) ?? { income: 0, expense: 0 }
    if (item.amount > 0) {
      income += item.amount
      month.income += item.amount
    } else if (item.amount < 0) {
      expense -= item.amount
      month.expense -= item.amount
      days.set(item.bookingDate, (days.get(item.bookingDate) ?? 0) - item.amount)
    }
    months.set(item.bookingDate.slice(0, 7), month)
  }
  const monthly: MonthlyTotal[] = [...months].sort(([left], [right]) => compareText(left, right)).map(([month, totals]) => ({
    month, income: money(totals.income), expense: money(totals.expense), net: money(totals.income - totals.expense),
  }))
  const categories: CategoryBreakdown[] = expenseGroups(state, rows, item => item.categoryId).map(([id, group]) => {
    const category = id === null ? undefined : state.categories.find(item => item.id === id)
    return { category_id: id, name: category?.name ?? 'Uncategorized', color: category?.color ?? NEUTRAL_COLOR, amount: money(group.amount) }
  })
  const merchants: MerchantBreakdown[] = expenseGroups(state, rows, item => item.merchant).slice(0, 10).map(([merchant, group]) => ({
    name: merchant || 'No merchant', merchant, color: MERCHANT_COLOR, amount: money(group.amount),
  }))
  const daily = [...days].sort(([left], [right]) => compareText(left, right)).map(([day, amount]) => ({ day, amount: money(amount) }))

  // Coverage and balance always describe the whole ledger: the newest day's balance, if its statements agree.
  const all = [...state.transactions.values()]
  const dates = all.map(item => item.bookingDate).sort(compareText)
  const first = dates[0] ?? null, latest = dates.at(-1) ?? null
  const latestDay = all.filter(item => item.bookingDate === latest)
  latestDay.forEach(item => position(state, item))
  const balances = new Set(latestDay.filter(item => state.order.get(item.id)?.root).map(item => item.balance))
  return {
    income: money(income),
    expense: money(expense),
    net: money(income - expense),
    count: rows.length,
    balance: balances.size === 1 ? money([...balances][0]) : null,
    balance_date: latest,
    coverage_start: first,
    coverage_end: latest,
    monthly,
    categories,
    merchants,
    daily,
  }
}

/** Categories by name; tags by how many transactions use them, then name (backend `tag_catalog`). */
export function catalogOf(state: FinanceState, kind: 'categories' | 'tags'): CatalogOut[] {
  if (kind === 'categories') return [...state.categories].sort((left, right) => compareText(left.name, right.name)).map(item => ({ ...item }))
  const uses = new Map<number, number>()
  for (const item of state.transactions.values()) for (const tag of new Set(item.tags)) uses.set(tag, (uses.get(tag) ?? 0) + 1)
  return [...state.tags].sort((left, right) => (uses.get(right.id) ?? 0) - (uses.get(left.id) ?? 0)
    || compareText(casefold(left.name), casefold(right.name)) || left.id - right.id).map(item => ({ ...item }))
}
