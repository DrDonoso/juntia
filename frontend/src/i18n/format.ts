import { intlLocale } from './store'
import type { IntlLocale } from './types'

function cachedFor<T>(cache: Map<string, T>, options: object | undefined, create: (locale: IntlLocale) => T): T {
  const locale = intlLocale()
  const key = `${locale}|${JSON.stringify(options ?? {})}`
  let value = cache.get(key)
  if (value === undefined) {
    value = create(locale)
    cache.set(key, value)
  }
  return value
}

const numberFormats = new Map<string, Intl.NumberFormat>()
const dateTimeFormats = new Map<string, Intl.DateTimeFormat>()
const collators = new Map<string, Intl.Collator>()

/** Cached `Intl.NumberFormat` for the active language. */
export function numberFormat(options?: Intl.NumberFormatOptions): Intl.NumberFormat {
  return cachedFor(numberFormats, options, locale => new Intl.NumberFormat(locale, options))
}

/** Cached `Intl.DateTimeFormat` for the active language. */
export function dateTimeFormat(options?: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  return cachedFor(dateTimeFormats, options, locale => new Intl.DateTimeFormat(locale, options))
}

/** Cached `Intl.Collator` for the active language (default: numeric, case- and accent-insensitive). */
export function collator(options: Intl.CollatorOptions = { numeric: true, sensitivity: 'base' }): Intl.Collator {
  return cachedFor(collators, options, locale => new Intl.Collator(locale, options))
}

export function formatNumber(value: number, options?: Intl.NumberFormatOptions): string {
  return numberFormat(options).format(value)
}

/** Sorts text the way people read it in the active language ("Unit 2" before "Unit 10"). */
export function compareText(left: string, right: string): number {
  return collator().compare(left, right)
}

export function lowerCase(text: string): string {
  return text.toLocaleLowerCase(intlLocale())
}

export function upperCase(text: string): string {
  return text.toLocaleUpperCase(intlLocale())
}
