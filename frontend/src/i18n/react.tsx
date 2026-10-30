import { useLayoutEffect, useMemo, useSyncExternalStore, type ReactNode } from 'react'
import { I18nProvider as AriaI18nProvider } from 'react-aria-components'
import { getLanguage, setLanguage, subscribeLanguage } from './store'
import { INTL_LOCALES, translate, translateRich } from './translate'
import type { IntlLocale, Language, Translate, TranslateRich } from './types'

export interface I18n {
  language: Language
  /** BCP 47 tag for Intl and React Aria (`en-GB` / `es-ES`). */
  locale: IntlLocale
  t: Translate
  /** Message with `<tag>…</tag>` markers rendered as React elements. */
  rich: TranslateRich
  setLanguage: (language: Language) => void
}

/** Active language and translators; the component re-renders when the language changes. */
export function useI18n(): I18n {
  const language = useSyncExternalStore(subscribeLanguage, getLanguage, getLanguage)
  return useMemo(() => {
    const t: Translate = (key, ...args) => translate(language, key, ...args)
    const rich: TranslateRich = (key, tags, ...args) => translateRich(language, key, tags, ...args)
    return { language, locale: INTL_LOCALES[language], t, rich, setLanguage }
  }, [language])
}

/** Keeps `<html lang>` in sync and makes React Aria format dates and numbers in the active language. */
export function I18nRoot({ children }: { children: ReactNode }) {
  const { language, locale } = useI18n()
  useLayoutEffect(() => {
    document.documentElement.lang = language
  }, [language])
  return <AriaI18nProvider locale={locale}>{children}</AriaI18nProvider>
}
