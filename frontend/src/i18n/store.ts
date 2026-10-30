import { INTL_LOCALES, isLanguage, translate } from './translate'
import type { IntlLocale, Language, Translate } from './types'

export const LANGUAGE_STORAGE_KEY = 'juntia_language'

/** The language the user chose with the selector, if any. */
export function storedLanguage(): Language | null {
  try {
    const value = localStorage.getItem(LANGUAGE_STORAGE_KEY)
    return isLanguage(value) ? value : null
  } catch {
    console.warn('Language preference could not be read.')
    return null
  }
}

/** First supported language among the browser preferences (`es-*` → es, `en-*` → en). */
export function browserLanguage(): Language | null {
  if (typeof navigator === 'undefined') return null
  const preferences = navigator.languages?.length ? navigator.languages : [navigator.language]
  for (const tag of preferences) {
    const primary = typeof tag === 'string' ? tag.split(/[-_]/)[0].toLowerCase() : ''
    if (isLanguage(primary)) return primary
  }
  return null
}

/** Stored choice, then the browser languages, then English. */
export function detectLanguage(): Language {
  return storedLanguage() ?? browserLanguage() ?? 'en'
}

let current: Language = detectLanguage()
const listeners = new Set<() => void>()

function apply(next: Language) {
  if (next === current) return
  current = next
  for (const listener of listeners) listener()
}

export function getLanguage(): Language {
  return current
}

/** Switches the UI language and remembers the choice on this device. */
export function setLanguage(next: Language) {
  if (!isLanguage(next)) return
  try { localStorage.setItem(LANGUAGE_STORAGE_KEY, next) }
  catch { console.warn('Language preference could not be stored.') }
  apply(next)
}

/** Detects the language again without storing it (startup state; tests call it before each test). */
export function resetLanguage(): Language {
  apply(detectLanguage())
  return current
}

export function subscribeLanguage(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** Intl/React Aria tag of the active language (`en-GB` or `es-ES`). */
export function intlLocale(language: Language = current): IntlLocale {
  return INTL_LOCALES[language]
}

/** Translates in the active language outside React render (event handlers, API errors, helpers). */
export const t: Translate = (key, ...args) => translate(current, key, ...args)
