/**
 * The finance request bodies of src/juntia/contracts.py, read with ../core's `Body`: catalog items,
 * classifications (`EnrichmentIn`, with tags created on the fly), rules (`RuleIn`), import decisions
 * and the optimistic versions and revisions. Unknown fields are refused and every broken contract
 * is a 422 `invalid_request`, like FastAPI.
 */
import type { RuleOut } from '../../api/schema.gen'
import { Body, DemoApiError, displayName, idParam, type PathParams } from '../core'
import { DEFAULT_COLOR, cents, collapse, tagNameKey, uniqueSorted } from '../store/finance-ledger'

/** Integers pydantic accepts where the backend sets no range (ids that may not exist). */
const ANY_INTEGER = { min: Number.MIN_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER }
const COLOR = /^#[0-9a-fA-F]{6}$/
const MATCH_MODES = ['contains', 'starts_with', 'exact', 'regex'] as const

/** A FastAPI `int` path parameter: any integer (a missing record is the route's 404, not a 422). */
export function integerParam(params: PathParams, name: string): number {
  return idParam(params, name, ANY_INTEGER)
}

/** A FastAPI `UUID` path parameter, as its canonical lower-case text (`str(uuid)`). */
export function uuidParam(params: PathParams, name: string): string {
  const raw = params[name]
  const hex = typeof raw === 'string' ? raw.trim().replace(/^urn:uuid:/i, '').replace(/^\{(.*)\}$/, '$1') : ''
  const compact = /^[0-9a-f]{32}$/i.test(hex) ? hex
    : /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(hex) ? hex.replace(/-/g, '') : null
  if (!compact) throw new DemoApiError('invalid_request')
  const value = compact.toLowerCase()
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`
}

/** `list[int]` with at most `max` items (default `[]`). */
export function integerList(body: Body, key: string, max: number): number[] {
  const value = body.raw(key)
  if (value === undefined) return []
  if (!Array.isArray(value)) return body.fail(key, 'list_type') ?? []
  if (value.length > max) return body.fail(key, 'too_long') ?? []
  if (!value.every(item => typeof item === 'number' && Number.isSafeInteger(item))) return body.fail(key, 'int_type') ?? []
  return value as number[]
}

function color(body: Body, key: string, fallback: string | undefined): string {
  const value = body.text(key, { max: 7, fallback })
  if (body.failed(key)) return value
  return COLOR.test(value) ? value : (body.fail(key, 'string_pattern_mismatch') ?? '')
}

export interface CatalogInput {
  name: string
  color: string
}

/** `CatalogIn`: a category or tag of the catalog (name collapsed, color as given). */
export function readCatalog(body: Body): CatalogInput {
  const raw = body.text('name', { min: 1, max: 100 })
  const name = body.failed('name') ? '' : collapse(raw)
  if (!body.failed('name') && !name) body.fail('name', 'value_error')
  return { name, color: color(body, 'color', DEFAULT_COLOR) }
}

/** `TagIn`: a tag created while classifying (NFKC, visible characters, lower-case color). */
function readNewTag(body: Body): CatalogInput {
  const raw = body.text('name', { min: 1, max: 100 })
  let name = ''
  if (!body.failed('name')) {
    name = displayName(raw.normalize('NFKC')) ?? ''
    if (!name || [...name].length > 100) body.fail('name', 'value_error')
  }
  return { name, color: color(body, 'color', DEFAULT_COLOR).toLowerCase() }
}

export interface EnrichmentInput {
  categoryId: number | null
  merchant: string
  tags: number[]
  newTags: CatalogInput[]
}

/** `EnrichmentIn`: a category, a merchant and up to 30 distinct tags, existing or new. */
export function readEnrichment(body: Body): EnrichmentInput {
  const categoryId = body.optionalInt('category_id', ANY_INTEGER)
  const merchant = body.text('merchant', { max: 200, fallback: '' })
  const tags = uniqueSorted(integerList(body, 'tags', 30))
  const newTags = body.list('new_tags', { max: 30 }, readNewTag)
  const names = newTags.map(tag => tagNameKey(tag.name))
  body.check(tags.length + names.length <= 30 && new Set(names).size === names.length, 'new_tags')
  return { categoryId, merchant, tags, newTags }
}

/** `EnrichmentIn | None` (default None). */
export function readOptionalEnrichment(body: Body, key: string): EnrichmentInput | null {
  const value = body.raw(key)
  return value === undefined || value === null ? null : body.object(key, readEnrichment)
}

export type RuleInput = Omit<RuleOut, 'id'>

/** `RuleIn`: conditions and actions of a classification rule (amounts written with two decimals). */
export function readRule(body: Body): RuleInput {
  const rule: RuleInput = {
    name: body.text('name', { min: 1, max: 100 }),
    priority: body.int('priority', { min: 0, max: 100_000, fallback: 100 }),
    enabled: body.bool('enabled', true),
    description_mode: body.literal('description_mode', MATCH_MODES, 'contains'),
    description_value: body.text('description_value', { min: 1, max: 300 }),
    detail_mode: body.optionalLiteral('detail_mode', MATCH_MODES),
    detail_value: body.optionalText('detail_value', { max: 300 }),
    amount_sign: body.optionalLiteral('amount_sign', ['positive', 'negative'] as const),
    amount_min: body.decimal('amount_min', { min: 0, max: 999_999_999_999.99, places: 2, nullable: true }),
    amount_max: body.decimal('amount_max', { min: 0, max: 999_999_999_999.99, places: 2, nullable: true }),
    account_ref: body.optionalText('account_ref', { max: 1_000_000 }),
    currency: body.optionalLiteral('currency', ['EUR'] as const),
    set_category: body.optionalInt('set_category', ANY_INTEGER),
    set_merchant: body.optionalText('set_merchant', { max: 200 }),
    add_tags: integerList(body, 'add_tags', 30),
    skip_ai: body.bool('skip_ai', true),
  }
  body.check(Boolean(rule.detail_mode) === Boolean(rule.detail_value), 'detail_value')
  if (rule.amount_min !== null && rule.amount_max !== null) body.check(cents(rule.amount_min) <= cents(rule.amount_max), 'amount_max')
  return rule
}

export interface DecisionInput {
  ordinal: number
  existingId: number | null
  createNew: boolean
  enrichment: EnrichmentInput | null
}

/** `RowDecision`: how to record one line of a statement under review. */
export function readDecision(body: Body): DecisionInput {
  return {
    ordinal: body.int('ordinal', { min: 0 }),
    existingId: body.optionalInt('existing_id', { min: 1, max: Number.MAX_SAFE_INTEGER }),
    createNew: body.bool('create_new', false),
    enrichment: readOptionalEnrichment(body, 'enrichment'),
  }
}
