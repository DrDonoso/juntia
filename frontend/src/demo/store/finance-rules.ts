/**
 * Classification rules with the backend's semantics (src/juntia/rules.py): the first enabled rule
 * that matches, by priority and then id, sets the category and merchant it names and adds its tags.
 * Regular expressions follow Python's syntax closely enough for the demo (named groups are
 * translated) and match case-insensitively.
 */
import type { RuleOut } from '../../api/schema.gen'
import { DemoApiError } from '../core/errors'
import { casefold, cents, uniqueSorted, type DemoPreviewRow } from './finance-ledger'

export type MatchMode = RuleOut['description_mode']

/** The parts of a rule its matching reads (`RuleIn` without its name and actions). */
export type RuleConditions = Pick<RuleOut,
  'enabled' | 'account_ref' | 'amount_sign' | 'amount_min' | 'amount_max' | 'description_mode' | 'description_value' |
  'detail_mode' | 'detail_value'>

/** The classification a rule changes (backend `Enrichment`). */
export interface Classification {
  categoryId: number | null
  merchant: string
  tags: number[]
}

/** A Python-style regular expression as a case-insensitive RegExp; null when it is not valid. */
export function compilePattern(pattern: string): RegExp | null {
  const source = pattern.replace(/\(\?P</g, '(?<').replace(/\(\?P=(\w+)\)/g, '\\k<$1>')
  for (const flags of ['iu', 'i']) {
    try {
      return new RegExp(source, flags)
    } catch {
      // Unicode mode refuses some escapes Python accepts: try again without it.
    }
  }
  return null
}

/** Backend `validate_patterns`: 422 `invalid_regex` for a regular expression that does not compile. */
export function validatePatterns(rule: Pick<RuleOut, 'description_mode' | 'description_value' | 'detail_mode' | 'detail_value'>): void {
  for (const [mode, pattern] of [[rule.description_mode, rule.description_value], [rule.detail_mode, rule.detail_value]] as const) {
    if (mode === 'regex' && pattern && !compilePattern(pattern)) throw new DemoApiError('invalid_regex')
  }
}

/** Backend `text_matches`. */
export function textMatches(value: string, mode: MatchMode, pattern: string): boolean {
  if (mode === 'contains') return casefold(value).includes(casefold(pattern))
  if (mode === 'starts_with') return casefold(value).startsWith(casefold(pattern))
  if (mode === 'exact') return casefold(value) === casefold(pattern)
  const expression = compilePattern(pattern)
  if (!expression) throw new DemoApiError('rule_timeout')
  return expression.test(value)
}

/** Backend `matches`: whether an enabled rule applies to a movement of the account `iban`. */
export function ruleMatches(rule: RuleConditions, row: { description: string; amount: number }, iban: string): boolean {
  if (!rule.enabled || (rule.account_ref && rule.account_ref !== iban)) return false
  if (rule.amount_sign === 'positive' && row.amount <= 0) return false
  if (rule.amount_sign === 'negative' && row.amount >= 0) return false
  if (rule.amount_min !== null && Math.abs(row.amount) < cents(rule.amount_min)) return false
  if (rule.amount_max !== null && Math.abs(row.amount) > cents(rule.amount_max)) return false
  if (!textMatches(row.description, rule.description_mode, rule.description_value)) return false
  // This bank has one concept column, not a separate detail field.
  if (rule.detail_mode && rule.detail_value) return textMatches('', rule.detail_mode, rule.detail_value)
  return true
}

/** Backend `rule_metadata`: the rule's category and merchant when it sets them, plus its tags. */
export function ruleMetadata(rule: Pick<RuleOut, 'set_category' | 'set_merchant' | 'add_tags'>, current: Classification): Classification {
  return {
    categoryId: rule.set_category ?? current.categoryId,
    merchant: rule.set_merchant ?? current.merchant,
    tags: uniqueSorted([...current.tags, ...rule.add_tags]),
  }
}

/** Rules in the order they are tried. */
export function rulesByPriority(rules: readonly RuleOut[]): RuleOut[] {
  return [...rules].sort((left, right) => left.priority - right.priority || left.id - right.id)
}

/** The first rule that classifies a movement, if any. */
export function firstMatchingRule(rules: readonly RuleOut[], row: { description: string; amount: number }, iban: string): RuleOut | null {
  return rulesByPriority(rules).find(rule => ruleMatches(rule, row, iban)) ?? null
}

/** Backend `apply_rules`: classifies the rows under review that are not already recorded. */
export function applyRules(rows: readonly DemoPreviewRow[], rules: readonly RuleOut[], iban: string): DemoPreviewRow[] {
  const ordered = rulesByPriority(rules)
  return rows.map(row => {
    const updated = { ...row, candidates: [...row.candidates], tags: [...row.tags] }
    if (row.status === 'duplicate') return updated
    const rule = ordered.find(item => ruleMatches(item, row, iban))
    if (!rule) return updated
    return {
      ...updated,
      ...ruleMetadata(rule, row),
      matchedRule: rule.name,
      source: 'rule',
      skipAi: rule.skip_ai,
    }
  })
}
