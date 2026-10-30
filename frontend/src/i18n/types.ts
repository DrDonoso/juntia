import type { ReactNode } from 'react'
import type { en } from './locales/en'

export const LANGUAGES = ['en', 'es'] as const

/** UI language: English (default and fallback) or Spanish. */
export type Language = (typeof LANGUAGES)[number]

/** BCP 47 tag used by Intl and React Aria (day-first dates in both languages). */
export type IntlLocale = 'en-GB' | 'es-ES'

/** The English dictionary is the source of truth for every key. */
export type Dictionary = typeof en

export type Namespace = keyof Dictionary

/**
 * Shape a translation must have to mirror an English source `T`: the same keys at every level
 * (plural objects keep the same forms) with string leaves. An empty source accepts no keys.
 */
export type Messages<T> = [keyof T] extends [never]
  ? { readonly [key: string]: never }
  : { readonly [K in keyof T]: T[K] extends string ? string : Messages<T[K]> }

/**
 * Plural message selected with `Intl.PluralRules` from the `count` parameter; `zero` overrides an
 * exact 0. Never name a regular group key `other`: objects with an `other` string are plurals.
 */
export type PluralMessage = { readonly zero?: string; readonly one: string; readonly other: string }

type Join<P extends string, K extends string> = P extends '' ? K : `${P}.${K}`

/** Dotted path of every message (`'common.close'`, `'errors.codes.invalid_iban'`, …). */
export type LeafKeys<T, P extends string = ''> = {
  [K in keyof T & string]: T[K] extends string
    ? Join<P, K>
    : T[K] extends { readonly other: string }
      ? Join<P, K>
      : LeafKeys<T[K], Join<P, K>>
}[keyof T & string]

export type TranslationKey = LeafKeys<Dictionary>

type At<T, K extends string> = K extends `${infer Head}.${infer Rest}`
  ? Head extends keyof T ? At<T[Head], Rest> : never
  : K extends keyof T ? T[K] : never

type Message<K extends TranslationKey> = At<Dictionary, K>

/** Every template of a message (all the forms of a plural). */
type Templates<M> = M extends string ? M : M extends Readonly<Record<string, string>> ? M[keyof M] : never

type Placeholders<S> = S extends `${string}{${infer Name}}${infer Rest}` ? Name | Placeholders<Rest> : never

type Tags<S> = S extends `${string}<${infer Tag}>${infer Rest}`
  ? (Tag extends `/${string}` ? never : Tag) | Tags<Rest>
  : never

export type ParamValue = string | number

export type Params = Readonly<Record<string, ParamValue>>

/** Parameters of a message value: its `{placeholders}`; plurals also need a numeric `count`. */
export type MessageParams<M> = [M] extends [string]
  ? { readonly [N in Placeholders<M>]: ParamValue }
  : { readonly [N in 'count' | Placeholders<Templates<M>>]: N extends 'count' ? number : ParamValue }

/** `<tag>` names of a message value. */
export type MessageTags<M> = Tags<Templates<M>>

export type ParamsOf<K extends TranslationKey> = MessageParams<Message<K>>

/**
 * `t(key)` for messages without parameters, `t(key, params)` when the message needs them. When `K`
 * is the whole key union (a dynamic key, or a typo that failed inference) parameters are optional,
 * so a mistyped key is reported on the key instead of as a missing argument.
 */
export type TranslateArgs<K extends TranslationKey> = [keyof ParamsOf<K>] extends [never]
  ? [params?: undefined]
  : [TranslationKey] extends [K] ? [params?: Params] : [params: ParamsOf<K>]

/** One renderer for each `<tag>…</tag>` pair of a rich message. */
export type RichTags<K extends TranslationKey> = {
  readonly [N in MessageTags<Message<K>>]: (chunks: ReactNode) => ReactNode
}

export type Translate = <K extends TranslationKey>(key: K, ...args: TranslateArgs<K>) => string

export type TranslateRich = <K extends TranslationKey>(key: K, tags: RichTags<K>, ...args: TranslateArgs<K>) => ReactNode
