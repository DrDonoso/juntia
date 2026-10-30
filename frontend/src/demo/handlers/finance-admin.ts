/**
 * Finance administration of the demo API: the account's name, the catalog of categories and tags,
 * manual classification of transactions and the classification rules with their preview and
 * application to the history. Same contracts, checks, error codes and revision bumps as
 * src/juntia/api.py; every write bumps the finance revision, which makes open previews stale.
 */
import type { AccountOut, CatalogOut, RuleImpact, RuleOut, TransactionOut } from '../../api/schema.gen'
import { DemoApiError, http, parseBody, readJson, route, type HttpHandler, type PathParams } from '../core'
import { coreStore } from '../store/core'
import { financeStore, type FinanceState } from '../store/finance'
import { casefold, normalizeIban, tagNameKey, transactionOut, uniqueSorted, type DemoTransaction } from '../store/finance-ledger'
import { ruleMatches, ruleMetadata, validatePatterns } from '../store/finance-rules'
import { integerParam, readCatalog, readEnrichment, readRule, type EnrichmentInput, type RuleInput } from './finance-contracts'

type Kind = 'categories' | 'tags'

/** The `{kind}` path parameter (`Literal["categories", "tags"]`). */
export function kindParam(params: PathParams): Kind {
  const kind = params.kind
  if (kind !== 'categories' && kind !== 'tags') throw new DemoApiError('invalid_request')
  return kind
}

function catalog(state: FinanceState, kind: Kind): CatalogOut[] {
  return kind === 'categories' ? state.categories : state.tags
}

/** How names compare for uniqueness: tags like `tag_name_key`, categories without case. */
function nameKey(kind: Kind, name: string): string {
  return kind === 'tags' ? tagNameKey(name) : casefold(name)
}

/** Backend `validate_enrichment`: 409 `unknown_classification` for a category or tag that does not exist. */
export function validateEnrichment(state: FinanceState, values: readonly Pick<EnrichmentInput, 'categoryId' | 'tags'>[]): void {
  const categories = new Set(state.categories.map(item => item.id)), tags = new Set(state.tags.map(item => item.id))
  if (values.some(value => (value.categoryId !== null && !categories.has(value.categoryId)) || value.tags.some(tag => !tags.has(tag)))) {
    throw new DemoApiError('unknown_classification', 409)
  }
}

/**
 * Backend `resolve_enrichment`: new tags reuse an existing tag with the same name (`tag_name_key`)
 * or are created. Creating them is the caller's last step, after every check passed.
 */
export function resolveEnrichment(state: FinanceState, value: EnrichmentInput): Pick<DemoTransaction, 'categoryId' | 'merchant' | 'tags'> {
  const ids = new Set(value.tags)
  for (const draft of value.newTags) {
    const key = tagNameKey(draft.name)
    let tag = [...state.tags].sort((left, right) => left.id - right.id).find(item => tagNameKey(item.name) === key)
    if (!tag) {
      tag = { id: state.sequences.tag.next(), name: draft.name, color: draft.color }
      state.tags.push(tag)
    }
    ids.add(tag.id)
  }
  return { categoryId: value.categoryId, merchant: value.merchant, tags: uniqueSorted(ids) }
}

/** Backend `validate_rule`: patterns, then the category and tags it sets, then the IBAN it names. */
function validateRule(state: FinanceState, rule: RuleInput): RuleInput {
  validatePatterns(rule)
  validateEnrichment(state, [{ categoryId: rule.set_category, tags: rule.add_tags }])
  return rule.account_ref ? { ...rule, account_ref: normalizeIban(rule.account_ref) } : rule
}

/** Backend `matching_transactions`: what an enabled rule matches in the history, in id order. */
function matchingTransactions(state: FinanceState, input: RuleInput): { rule: RuleInput; rows: DemoTransaction[] } {
  const rule = validateRule(state, input)
  const account = coreStore().account
  if (!account) return { rule, rows: [] }
  return { rule, rows: [...state.transactions.values()].filter(row => ruleMatches(rule, row, account.iban)) }
}

function findRule(state: FinanceState, id: number): RuleOut {
  const rule = state.rules.find(item => item.id === id)
  if (!rule) throw new DemoApiError('rule_not_found', 404)
  return rule
}

const SAMPLE_SIZE = 10

export const financeAdminHandlers: HttpHandler[] = [
  http.patch('/api/admin/account', route('admin', async ({ request }): Promise<AccountOut> => {
    const { name } = parseBody(await readJson(request), body => ({ name: body.text('name', { min: 1, max: 150 }) }))
    const core = coreStore()
    if (!core.account) throw new DemoApiError('account_confirmation_required', 409)
    if (!name.trim()) throw new DemoApiError('invalid_request')
    core.account = { ...core.account, name: name.trim() }
    financeStore().revision += 1
    return { ...core.account }
  })),

  http.post('/api/admin/catalog/:kind', route('admin', async ({ request, params }): Promise<CatalogOut> => {
    const kind = kindParam(params)
    const input = parseBody(await readJson(request), readCatalog)
    const state = financeStore()
    const items = catalog(state, kind)
    if (items.some(item => nameKey(kind, item.name) === nameKey(kind, input.name))) throw new DemoApiError('name_exists', 409)
    const item = { id: (kind === 'categories' ? state.sequences.category : state.sequences.tag).next(), ...input }
    items.push(item)
    state.revision += 1
    return { ...item }
  }, { status: 201 })),

  http.patch('/api/admin/catalog/:kind/:itemId', route('admin', async ({ request, params }): Promise<CatalogOut> => {
    const kind = kindParam(params)
    const id = integerParam(params, 'itemId')
    const input = parseBody(await readJson(request), readCatalog)
    const state = financeStore()
    const items = catalog(state, kind)
    const item = items.find(entry => entry.id === id)
    if (!item) throw new DemoApiError('item_not_found', 404)
    if (items.some(entry => entry.id !== id && nameKey(kind, entry.name) === nameKey(kind, input.name))) {
      throw new DemoApiError('name_exists', 409)
    }
    Object.assign(item, input)
    state.revision += 1
    return { ...item }
  })),

  http.delete('/api/admin/catalog/:kind/:itemId', route('admin', ({ params }) => {
    const kind = kindParam(params)
    const id = integerParam(params, 'itemId')
    const state = financeStore()
    const items = catalog(state, kind)
    const index = items.findIndex(entry => entry.id === id)
    if (index < 0) throw new DemoApiError('item_not_found', 404)
    const transactions = [...state.transactions.values()]
    const used = kind === 'categories'
      ? transactions.some(row => row.categoryId === id) || state.rules.some(rule => rule.set_category === id)
      : transactions.some(row => row.tags.includes(id)) || state.rules.some(rule => rule.add_tags.includes(id))
    if (used) throw new DemoApiError('item_in_use', 409)
    items.splice(index, 1)
    state.revision += 1
  }, { status: 204 })),

  http.patch('/api/admin/transactions/:transactionId', route('admin', async ({ request, params }): Promise<TransactionOut> => {
    const id = integerParam(params, 'transactionId')
    const input = parseBody(await readJson(request), body => ({ ...readEnrichment(body), version: body.int('version') }))
    const state = financeStore()
    const transaction = state.transactions.get(id)
    if (!transaction) throw new DemoApiError('transaction_not_found', 404)
    if (transaction.version !== input.version) throw new DemoApiError('preview_stale', 409)
    validateEnrichment(state, [input])
    Object.assign(transaction, resolveEnrichment(state, input), { source: 'manual', version: transaction.version + 1 })
    state.revision += 1
    return transactionOut(transaction)
  })),

  http.get('/api/admin/rules', route('admin', (): RuleOut[] => financeStore().rules.map(rule => ({ ...rule, add_tags: [...rule.add_tags] })))),

  http.post('/api/admin/rules/preview', route('admin', async ({ request }): Promise<RuleImpact> => {
    const input = parseBody(await readJson(request), readRule)
    const state = financeStore()
    const { rows } = matchingTransactions(state, input)
    return { revision: state.revision, count: rows.length, sample: rows.slice(0, SAMPLE_SIZE).map(transactionOut) }
  })),

  http.post('/api/admin/rules/apply', route('admin', async ({ request }): Promise<RuleImpact> => {
    const input = parseBody(await readJson(request), body => ({
      revision: body.int('revision', { min: 0 }),
      rule: body.object('rule', readRule),
    }))
    const state = financeStore()
    if (state.revision !== input.revision) throw new DemoApiError('preview_stale', 409)
    const { rule, rows } = matchingTransactions(state, input.rule!)
    for (const row of rows) {
      Object.assign(row, ruleMetadata(rule, row), { source: 'rule', version: row.version + 1 })
    }
    state.revision += 1
    return { revision: state.revision, count: rows.length, sample: rows.slice(0, SAMPLE_SIZE).map(transactionOut) }
  })),

  http.post('/api/admin/rules', route('admin', async ({ request }): Promise<RuleOut> => {
    const input = parseBody(await readJson(request), readRule)
    const state = financeStore()
    const valid = validateRule(state, input)
    const rule = { id: state.sequences.rule.next(), ...valid }
    state.rules.push(rule)
    state.revision += 1
    return { ...rule, add_tags: [...rule.add_tags] }
  }, { status: 201 })),

  http.put('/api/admin/rules/:ruleId', route('admin', async ({ request, params }): Promise<RuleOut> => {
    const id = integerParam(params, 'ruleId')
    const input = parseBody(await readJson(request), readRule)
    const state = financeStore()
    const valid = validateRule(state, input)
    const rule = findRule(state, id)
    Object.assign(rule, valid)
    state.revision += 1
    return { ...rule, add_tags: [...rule.add_tags] }
  })),

  http.delete('/api/admin/rules/:ruleId', route('admin', ({ params }) => {
    const id = integerParam(params, 'ruleId')
    const state = financeStore()
    state.rules.splice(state.rules.indexOf(findRule(state, id)), 1)
    state.revision += 1
  }, { status: 204 })),
]
