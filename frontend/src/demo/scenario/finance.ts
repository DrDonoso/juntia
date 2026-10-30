/**
 * Finance data of the demo: Maple Court's account over the last thirteen months (./finance-schedule.ts),
 * imported as one statement a month and classified with the backend's default categories and tags,
 * a handful of rules and the administrator's corrections, plus the synthetic statement any upload
 * reads: the latest movements, some already imported and a few new ones. Deterministic
 * (`demoRandom('finance:…')`) and relative to `today()`.
 */
import type { CatalogOut, RuleOut } from '../../api/schema.gen'
import { COMMUNITY } from '../cast'
import { addDays, endOfMonth, instant, today } from '../core/clock'
import { sequenceAfter } from '../core/ids'
import { demoRandom } from '../core/random'
import {
  NEUTRAL_COLOR, bankOrder, sourceKey, uniqueSorted, type DemoImport, type DemoTransaction, type FinanceState,
  type StatementRow,
} from '../store/finance-ledger'
import { firstMatchingRule } from '../store/finance-rules'
import { CATEGORY, TAG, bankTimeline, type BankMovement } from './finance-schedule'

export type FinanceScenario = FinanceState

/** The backend's English first-run categories with their colors (src/juntia/bootstrap.py). */
export const CATEGORIES: readonly CatalogOut[] = [
  { id: CATEGORY.regularFees, name: 'Regular fees', color: '#1a4d8f' },
  { id: CATEGORY.specialAssessments, name: 'Special assessments', color: '#7755ad' },
  { id: CATEGORY.water, name: 'Water', color: '#007c91' },
  { id: CATEGORY.electricity, name: 'Electricity', color: '#b7791f' },
  { id: CATEGORY.cleaning, name: 'Cleaning', color: '#08735a' },
  { id: CATEGORY.maintenance, name: 'Maintenance', color: '#21639f' },
  { id: CATEGORY.repairs, name: 'Repairs', color: '#b43c32' },
  { id: CATEGORY.administration, name: 'Administration', color: '#6b568e' },
  { id: CATEGORY.insurance, name: 'Insurance', color: '#94673d' },
  { id: CATEGORY.professionalServices, name: 'Professional services', color: '#9f477b' },
  { id: CATEGORY.taxes, name: 'Taxes', color: '#696c38' },
  { id: CATEGORY.bankFees, name: 'Bank fees', color: '#64748b' },
  { id: CATEGORY.other, name: 'Other', color: '#525d6d' },
]

/** The backend's English first-run tags (all in the neutral color). */
export const TAGS: readonly CatalogOut[] = [
  { id: TAG.recurring, name: 'Recurring', color: NEUTRAL_COLOR },
  { id: TAG.extraordinary, name: 'Extraordinary', color: NEUTRAL_COLOR },
  { id: TAG.refund, name: 'Refund', color: NEUTRAL_COLOR },
  { id: TAG.transfer, name: 'Transfer', color: NEUTRAL_COLOR },
  { id: TAG.directDebit, name: 'Direct debit', color: NEUTRAL_COLOR },
  { id: TAG.review, name: 'Review', color: NEUTRAL_COLOR },
]

type RuleDraft = Pick<RuleOut, 'name' | 'priority' | 'description_mode' | 'description_value'> & Partial<RuleOut>

function rule(id: number, draft: RuleDraft): RuleOut {
  return {
    id, enabled: true, detail_mode: null, detail_value: null, amount_sign: null, amount_min: null, amount_max: null,
    account_ref: null, currency: null, set_category: null, set_merchant: null, add_tags: [], skip_ai: true, ...draft,
  }
}

/** The administrator's classification rules, in the order they were created. */
export function scenarioRules(): RuleOut[] {
  return [
    rule(1, { name: 'Monthly fees', priority: 10, description_mode: 'contains', description_value: 'MONTHLY FEE',
      amount_sign: 'positive', set_category: CATEGORY.regularFees, add_tags: [TAG.recurring] }),
    rule(2, { name: 'Electricity', priority: 50, description_mode: 'starts_with', description_value: 'DIRECT DEBIT LUMENVALE',
      set_category: CATEGORY.electricity, set_merchant: 'Lumenvale Energy', add_tags: [TAG.recurring, TAG.directDebit] }),
    rule(3, { name: 'Water', priority: 50, description_mode: 'contains', description_value: 'BRIGHTWATER',
      set_category: CATEGORY.water, set_merchant: 'Brightwater Utilities', add_tags: [TAG.recurring, TAG.directDebit] }),
    rule(4, { name: 'Lift maintenance', priority: 50, description_mode: 'contains', description_value: 'LIFTWELL',
      set_category: CATEGORY.maintenance, set_merchant: 'Liftwell Maintenance', add_tags: [TAG.recurring, TAG.directDebit] }),
    rule(5, { name: 'Cleaning', priority: 50, description_mode: 'contains', description_value: 'SPARKLE CLEANING',
      set_category: CATEGORY.cleaning, set_merchant: 'Sparkle Cleaning Co.', add_tags: [TAG.recurring] }),
    rule(6, { name: 'Garden care', priority: 60, description_mode: 'contains', description_value: 'GREENLEAF',
      set_category: CATEGORY.maintenance, set_merchant: 'Greenleaf Gardens', add_tags: [TAG.recurring] }),
    rule(7, { name: 'Bank fees', priority: 5, description_mode: 'regex', description_value: '^(ACCOUNT MAINTENANCE|TRANSFER) FEES?\\b',
      amount_sign: 'negative', amount_max: '50.00', set_category: CATEGORY.bankFees }),
    rule(8, { name: 'Roof special assessment', priority: 10, description_mode: 'contains', description_value: 'ROOF ASSESSMENT',
      amount_sign: 'positive', set_category: CATEGORY.specialAssessments, add_tags: [TAG.extraordinary] }),
  ]
}

/** Lines per page of the bank's statements. */
const ROWS_PER_PAGE = 30
/** Movements already imported that the synthetic statement repeats, at least (whole days). */
const REPEATED_ROWS = 6

type Classified = Pick<DemoTransaction, 'categoryId' | 'merchant' | 'tags' | 'source'>

/** The classification a movement got when its statement was imported: by a rule, by hand or none. */
function classify(movement: BankMovement, rules: readonly RuleOut[], iban: string): Classified {
  const { classification } = movement
  if (classification.kind === 'manual') {
    return { categoryId: classification.categoryId, merchant: classification.merchant, tags: uniqueSorted(classification.tags), source: 'manual' }
  }
  if (classification.kind === 'unclassified') return { categoryId: null, merchant: '', tags: [], source: 'unclassified' }
  const match = firstMatchingRule(rules, movement, iban)
  if (!match) throw new Error(`No rule classifies "${movement.description}"`)
  return { categoryId: match.set_category, merchant: match.set_merchant ?? '', tags: uniqueSorted(match.add_tags), source: 'rule' }
}

function statementRow(movement: BankMovement, ordinal: number): StatementRow {
  return {
    bookingDate: movement.bookingDate, valueDate: movement.valueDate, description: movement.description,
    amount: movement.amount, balance: movement.balance, page: Math.floor(ordinal / ROWS_PER_PAGE) + 1, ordinal,
  }
}

/** Movements grouped by booking month, oldest month first. */
function byMonth(movements: readonly BankMovement[]): BankMovement[][] {
  const months = new Map<string, BankMovement[]>()
  for (const movement of movements) {
    const key = movement.bookingDate.slice(0, 7)
    months.set(key, [...months.get(key) ?? [], movement])
  }
  return [...months.values()]
}

/**
 * When each statement was imported: one to three days after its month ended, the latest one the
 * evening of its last day, each before the next one.
 */
function importTimes(records: readonly DemoImport[], recordedUntil: string): string[] {
  const random = demoRandom('finance:import-times')
  const times: string[] = []
  let next = instant(recordedUntil, '19:40')
  for (let index = records.length - 1; index >= 0; index -= 1) {
    if (index < records.length - 1) {
      const end = endOfMonth(records[index].endDate)
      const candidate = instant(addDays(end, 1 + random.below(3)), `09:${String(10 + random.below(40)).padStart(2, '0')}`)
      next = candidate < next ? candidate : instant(end, '20:00')
    }
    times[index] = next
  }
  return times
}

/** The movements since the last import, with the last whole days already imported before them. */
function latestMovements(movements: readonly BankMovement[], recordedUntil: string): BankMovement[] {
  let repeated = 0, start = recordedUntil
  for (const movement of movements.filter(item => item.bookingDate <= recordedUntil).reverse()) {
    if (repeated >= REPEATED_ROWS && movement.bookingDate < start) break
    repeated += 1
    start = movement.bookingDate
  }
  return movements.filter(movement => movement.bookingDate >= start)
}

export function financeScenario(): FinanceScenario {
  const timeline = bankTimeline(today())
  const rules = scenarioRules()
  const iban = COMMUNITY.account.iban
  const statementIds = demoRandom('finance:statements')
  const transactions = new Map<number, DemoTransaction>()
  const recorded = timeline.movements.filter(movement => movement.bookingDate <= timeline.recordedUntil)
  const imports: DemoImport[] = byMonth(recorded).map(month => {
    const newestFirst = [...month].reverse()
    const id = statementIds.uuid()
    // Statements were imported in turn, newest line first: transaction ids follow that order.
    const rows = newestFirst.map((movement, ordinal) => {
      const transactionId = transactions.size + 1
      transactions.set(transactionId, {
        id: transactionId,
        sourceKey: sourceKey(movement),
        weakKey: sourceKey(movement, false),
        bookingDate: movement.bookingDate,
        valueDate: movement.valueDate,
        description: movement.description,
        amount: movement.amount,
        balance: movement.balance,
        ...classify(movement, rules, iban),
        version: 1,
      })
      return { ordinal, page: Math.floor(ordinal / ROWS_PER_PAGE) + 1, source: statementRow(movement, ordinal), transactionId }
    })
    const oldest = newestFirst.at(-1)!, newest = newestFirst[0]
    return {
      id,
      filename: `statement-${newest.bookingDate.slice(0, 7)}.pdf`,
      fileHash: `scenario:${id}`,
      createdAt: '',
      startDate: oldest.bookingDate,
      endDate: newest.bookingDate,
      openingBalance: oldest.balance - oldest.amount,
      closingBalance: newest.balance,
      inserted: rows.length,
      duplicates: 0,
      rows,
      original: null,
    }
  })
  importTimes(imports, timeline.recordedUntil).forEach((time, index) => { imports[index].createdAt = time })

  const manual = [...transactions.values()].filter(transaction => transaction.source === 'manual').length
  const categories = CATEGORIES.map(item => ({ ...item }))
  const tags = TAGS.map(item => ({ ...item }))
  return {
    // Every import, rule and correction of the past year changed the finance revision.
    revision: imports.length + rules.length + manual,
    categories,
    tags,
    rules,
    transactions,
    imports,
    previews: new Map(),
    order: bankOrder(transactions, imports),
    statement: { iban, rows: latestMovements(timeline.movements, timeline.recordedUntil).reverse().map(statementRow) },
    sequences: {
      category: sequenceAfter(categories.map(item => item.id)),
      tag: sequenceAfter(tags.map(item => item.id)),
      rule: sequenceAfter(rules.map(item => item.id)),
      transaction: sequenceAfter(transactions.keys()),
    },
    ids: demoRandom('finance:previews'),
  }
}
