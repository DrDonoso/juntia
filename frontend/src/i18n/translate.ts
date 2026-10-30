import { Fragment, createElement, type ReactNode } from 'react'
import { en } from './locales/en'
import { es } from './locales/es'
import type {
  Dictionary, IntlLocale, Language, Messages, Params, PluralMessage, RichTags, TranslateArgs, TranslationKey,
} from './types'

export const DICTIONARIES: Readonly<Record<Language, Messages<Dictionary>>> = { en, es }

export const INTL_LOCALES: Readonly<Record<Language, IntlLocale>> = { en: 'en-GB', es: 'es-ES' }

export function isLanguage(value: unknown): value is Language {
  return value === 'en' || value === 'es'
}

function isPlural(value: unknown): value is PluralMessage {
  return typeof value === 'object' && value !== null && typeof (value as { other?: unknown }).other === 'string'
}

function resolve(tree: unknown, key: string): string | PluralMessage | undefined {
  let node = tree
  for (const part of key.split('.')) {
    // Own properties only: a code such as `constructor` must not reach Object.prototype.
    if (typeof node !== 'object' || node === null || !Object.hasOwn(node, part)) return undefined
    node = (node as Record<string, unknown>)[part]
  }
  return typeof node === 'string' || isPlural(node) ? node : undefined
}

/** Whether a key built at runtime (e.g. from an API error code) names a message. */
export function hasMessage(key: string): key is TranslationKey {
  return resolve(DICTIONARIES.en, key) !== undefined
}

const pluralRules = new Map<Language, Intl.PluralRules>()
const countFormats = new Map<Language, Intl.NumberFormat>()

function selectPlural(language: Language, message: PluralMessage, count: unknown): string {
  if (typeof count !== 'number' || !Number.isFinite(count)) return message.other
  if (count === 0 && message.zero !== undefined) return message.zero
  let rules = pluralRules.get(language)
  if (!rules) {
    rules = new Intl.PluralRules(INTL_LOCALES[language])
    pluralRules.set(language, rules)
  }
  return (message as Readonly<Record<string, string | undefined>>)[rules.select(count)] ?? message.other
}

function interpolate(language: Language, template: string, params: Params | undefined): string {
  if (!params) return template
  return template.replace(/\{(\w+)\}/g, (placeholder, name: string) => {
    if (!Object.hasOwn(params, name)) return placeholder
    const value = params[name]
    // Only `count` is formatted for the locale: years and identifiers must never become "2,026".
    if (name === 'count' && typeof value === 'number') {
      let format = countFormats.get(language)
      if (!format) {
        format = new Intl.NumberFormat(INTL_LOCALES[language])
        countFormats.set(language, format)
      }
      return format.format(value)
    }
    return String(value)
  })
}

function lookup(language: Language, key: string): string | PluralMessage | undefined {
  const message = resolve(DICTIONARIES[language], key) ?? resolve(DICTIONARIES.en, key)
  if (message === undefined && import.meta.env.DEV && import.meta.env.MODE !== 'test') console.warn(`Missing translation: ${key}`)
  return message
}

function pick(language: Language, message: string | PluralMessage, params: Params | undefined): string {
  return typeof message === 'string' ? message : selectPlural(language, message, params?.count)
}

/** Formats a message value: picks the plural form for `count`, then fills the `{placeholders}`. */
export function formatMessage(language: Language, message: string | PluralMessage, params?: Params): string {
  return interpolate(language, pick(language, message, params), params)
}

type TagRenderers = Readonly<Record<string, (chunks: ReactNode) => ReactNode>>

const TAG = /<(\w+)>([\s\S]*?)<\/\1>/g

/** Formats a rich message value (see `translateRich`). */
export function formatRich(language: Language, message: string | PluralMessage, tags: TagRenderers, params?: Params): ReactNode {
  const text = pick(language, message, params)
  const nodes: ReactNode[] = []
  let cursor = 0
  // Tags are found before interpolation, so parameter values can never become markup.
  for (const match of text.matchAll(TAG)) {
    if (match.index > cursor) nodes.push(interpolate(language, text.slice(cursor, match.index), params))
    const inner = interpolate(language, match[2], params)
    const render = Object.hasOwn(tags, match[1]) ? tags[match[1]] : undefined
    nodes.push(render ? render(inner) : inner)
    cursor = match.index + match[0].length
  }
  if (cursor < text.length) nodes.push(interpolate(language, text.slice(cursor), params))
  return nodes.map((node, index) => createElement(Fragment, { key: index }, node))
}

function translateLoose(language: Language, key: string, params?: Params): string {
  const message = lookup(language, key)
  return message === undefined ? key : formatMessage(language, message, params)
}

/** Message for `key` in `language` (English fallback, then the key itself). */
export const translate = translateLoose as <K extends TranslationKey>(
  language: Language, key: K, ...args: TranslateArgs<K>
) => string

function translateRichLoose(language: Language, key: string, tags: TagRenderers, params?: Params): ReactNode {
  const message = lookup(language, key)
  return message === undefined ? key : formatRich(language, message, tags, params)
}

/**
 * Rich message: each `<tag>chunks</tag>` is rendered by `tags.tag(chunks)` (React elements, never
 * HTML strings). Tags cannot nest; `{placeholders}` work inside and outside them.
 */
export const translateRich = translateRichLoose as <K extends TranslationKey>(
  language: Language, key: K, tags: RichTags<K>, ...args: TranslateArgs<K>
) => ReactNode
