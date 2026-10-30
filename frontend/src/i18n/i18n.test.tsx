import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useLocale } from 'react-aria-components'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, describe, expect, expectTypeOf, test, vi } from 'vitest'
import { cache, signedOut } from '../api/client'
import { LoginNoticeProvider } from '../auth'
import { Shell } from '../main'
import {
  I18nRoot, LANGUAGE_STORAGE_KEY, collator, compareText, dateTimeFormat, detectLanguage, formatMessage, formatNumber,
  formatRich, getLanguage, hasMessage, intlLocale, lowerCase, resetLanguage, setLanguage, subscribeLanguage, t,
  translate, upperCase, useI18n, type MessageParams, type MessageTags, type Messages,
} from '.'
import { en } from './locales/en'
import { es } from './locales/es'

afterEach(() => {
  cleanup()
  cache.clear()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  document.documentElement.removeAttribute('lang')
})

const NAMESPACES = [
  'common', 'shell', 'auth', 'errors', 'finance', 'admin', 'actions', 'events', 'accounts', 'neighbors', 'contacts',
  'labels', 'storage', 'demo',
]

type Leaf = string | Readonly<Record<string, string>>

function isPlural(value: unknown): value is Readonly<Record<string, string>> {
  return typeof value === 'object' && value !== null && typeof (value as { other?: unknown }).other === 'string'
}

/** Every message by dotted path; plural objects are single entries. */
function messages(tree: unknown, prefix = ''): Map<string, Leaf> {
  const found = new Map<string, Leaf>()
  for (const [key, value] of Object.entries(tree as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (typeof value === 'string' || isPlural(value)) found.set(path, value)
    else for (const entry of messages(value, path)) found.set(...entry)
  }
  return found
}

const templates = (message: Leaf) => typeof message === 'string' ? [message] : Object.values(message)
const placeholders = (message: Leaf) => [...new Set(templates(message).flatMap(text => [...text.matchAll(/\{(\w+)\}/g)].map(match => match[1])))].sort()
const tags = (message: Leaf) => [...new Set(templates(message).flatMap(text => [...text.matchAll(/<\/?(\w+)>/g)].map(match => match[0])))].sort()

function browser(...languages: string[]) {
  Object.defineProperty(navigator, 'languages', { configurable: true, get: () => languages })
  Object.defineProperty(navigator, 'language', { configurable: true, get: () => languages[0] ?? '' })
}

describe('dictionaries', () => {
  const english = messages(en), spanish = messages(es)

  test('English and Spanish define every namespace with exactly the same keys', () => {
    expect(Object.keys(en).sort()).toEqual([...NAMESPACES].sort())
    expect(Object.keys(es).sort()).toEqual([...NAMESPACES].sort())
    expect([...spanish.keys()].sort()).toEqual([...english.keys()].sort())
  })

  test('no message is empty', () => {
    const empty = [...english, ...spanish].filter(([, message]) => templates(message).some(text => !text.trim()))
    expect(empty).toEqual([])
  })

  test('translations keep the same placeholders and rich-text tags', () => {
    const mismatched = [...english].filter(([path, message]) => {
      const translation = spanish.get(path)!
      return placeholders(message).join() !== placeholders(translation).join() || tags(message).join() !== tags(translation).join()
    }).map(([path]) => path)
    expect(mismatched).toEqual([])
  })

  test('plurals are complete and use the same forms in both languages', () => {
    const incomplete = [...english].filter(([path, message]) => {
      const translation = spanish.get(path)!
      if (!isPlural(message) && !isPlural(translation)) return false
      if (!isPlural(message) || !isPlural(translation)) return true
      const forms = Object.keys(message).sort().join()
      return !('one' in message) || forms !== Object.keys(translation).sort().join()
    }).map(([path]) => path)
    expect(incomplete).toEqual([])
  })

  test('the old Spanish client messages are preserved for every API error code', () => {
    expect(Object.keys(es.errors.codes)).toEqual(Object.keys(en.errors.codes))
    expect(Object.keys(en.errors.codes).length).toBeGreaterThanOrEqual(125)
    expect(es.errors.codes.invalid_iban).toBe('El IBAN está incompleto o sus dígitos de control no son válidos.')
    expect(en.errors.codes.invalid_iban).toBe('The IBAN is incomplete or its check digits are not valid.')
  })
})

describe('translation', () => {
  test('messages interpolate parameters in each language', () => {
    expect(translate('en', 'common.pagination.page', { page: 2, pages: 10 })).toBe('Page 2 of 10')
    expect(translate('es', 'common.pagination.page', { page: 2, pages: 10 })).toBe('Página 2 de 10')
    expect(translate('es', 'shell.links.overview')).toBe('Resumen')
    expect(formatMessage('en', 'Year {year}', { year: 2026 })).toBe('Year 2026')
    expect(formatMessage('en', 'Hello {name}')).toBe('Hello {name}')
    expect(formatMessage('en', 'Hello {name}', { other: 'x' })).toBe('Hello {name}')
  })

  test('plural forms follow Intl.PluralRules and format the count for the language', () => {
    const files = { zero: 'No files', one: '{count} file in {folder}', other: '{count} files in {folder}' }
    expect(formatMessage('en', files, { count: 0, folder: 'Minutes' })).toBe('No files')
    expect(formatMessage('en', files, { count: 1, folder: 'Minutes' })).toBe('1 file in Minutes')
    expect(formatMessage('en', files, { count: 1234, folder: 'Minutes' })).toBe('1,234 files in Minutes')
    expect(formatMessage('en', files)).toBe('{count} files in {folder}')
    const archivos = { one: '{count} archivo', other: '{count} archivos' }
    expect(formatMessage('es', archivos, { count: 1 })).toBe('1 archivo')
    expect(formatMessage('es', archivos, { count: 0 })).toBe('0 archivos')
    expect(formatMessage('es', archivos, { count: 12345 })).toBe('12.345 archivos')
    expect(formatMessage('es', archivos, { count: 1_000_000 })).toBe('1.000.000 archivos')
  })

  test('only own message paths resolve', () => {
    expect(hasMessage('common.close')).toBe(true)
    expect(hasMessage('errors.codes.invalid_iban')).toBe(true)
    for (const key of ['common.missing', 'common', 'common.pagination', 'errors.codes.constructor', 'errors.codes.__proto__', 'toString']) {
      expect(hasMessage(key)).toBe(false)
    }
  })

  test('rich text renders tags as React elements and never turns parameters into markup', () => {
    const { container } = render(<p>{formatRich('en', 'Read the <link>guide for {name}</link> before <b>{day}</b>.', {
      link: chunks => <a href="/guide">{chunks}</a>, b: chunks => <strong>{chunks}</strong>,
    }, { name: '<b>Ana</b>', day: 'Monday' })}</p>)
    expect(screen.getByRole('link', { name: 'guide for <b>Ana</b>' })).toHaveAttribute('href', '/guide')
    expect(container.querySelector('strong')).toHaveTextContent('Monday')
    expect(container.querySelector('b')).toBeNull()
    expect(container).toHaveTextContent('Read the guide for <b>Ana</b> before Monday.')
    cleanup()
    const fallback = render(<p>{formatRich('en', 'A <x>b</x> and <y>c', {})}</p>)
    expect(fallback.container).toHaveTextContent('A b and <y>c')
  })

  test('keys, parameters and translations are checked at compile time', () => {
    expectTypeOf<MessageParams<'Page {page} of {pages}'>>().toEqualTypeOf<{ readonly page: string | number; readonly pages: string | number }>()
    expectTypeOf<MessageParams<{ readonly one: 'One file in {folder}'; readonly other: '{count} files in {folder}' }>>()
      .toEqualTypeOf<{ readonly count: number; readonly folder: string | number }>()
    expectTypeOf<MessageTags<'Read <link>the guide</link> and <b>{name}</b>'>>().toEqualTypeOf<'link' | 'b'>()
    function compileOnly() {
      // @ts-expect-error unknown keys do not compile
      t('common.doesNotExist')
      // @ts-expect-error the message needs parameters
      t('common.pagination.page')
      // @ts-expect-error every placeholder needs a value
      t('common.pagination.page', { page: 1 })
      // @ts-expect-error a message without placeholders takes no parameters
      t('common.close', { name: 'x' })
      // @ts-expect-error a translation must define every key of the English source
      const missing: Messages<typeof en.common.pagination> = { previous: '', previousLabel: '', next: '', nextLabel: '', page: '' }
      // @ts-expect-error a translation cannot add keys
      const extra: Messages<typeof en.common.president> = { label: '', title: '', extra: '' }
      // @ts-expect-error an empty namespace accepts no keys until English defines them
      const early: Messages<Record<never, string>> = { title: '' }
      return [missing, extra, early]
    }
    expect(compileOnly).toBeTypeOf('function')
  })
})

describe('language selection', () => {
  test.each([
    [['es-ES', 'en'], 'es'],
    [['fr-FR', 'es-MX', 'en-US'], 'es'],
    [['de-DE', 'en-US', 'es'], 'en'],
    [['ES'], 'es'],
    [['es_AR'], 'es'],
    [['esu', 'de'], 'en'],
    [['de', 'fr'], 'en'],
    [[], 'en'],
  ])('browser languages %j select %s without storing a choice', (languages, expected) => {
    browser(...languages)
    expect(detectLanguage()).toBe(expected)
    expect(resetLanguage()).toBe(expected)
    expect(getLanguage()).toBe(expected)
    expect(localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBeNull()
  })

  test('a stored choice wins over the browser and invalid values are ignored', () => {
    browser('es-ES')
    localStorage.setItem(LANGUAGE_STORAGE_KEY, 'en')
    expect(detectLanguage()).toBe('en')
    localStorage.setItem(LANGUAGE_STORAGE_KEY, 'fr')
    expect(detectLanguage()).toBe('es')
    browser('en-GB')
    localStorage.setItem(LANGUAGE_STORAGE_KEY, 'es')
    expect(detectLanguage()).toBe('es')
  })

  test('the choice is stored, survives a reload and notifies subscribers only on changes', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeLanguage(listener)
    setLanguage('es')
    setLanguage('es')
    expect(listener).toHaveBeenCalledOnce()
    expect(localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe('es')
    expect(t('common.close')).toBe('Cerrar')
    setLanguage('en')
    localStorage.setItem(LANGUAGE_STORAGE_KEY, 'es')
    expect(resetLanguage()).toBe('es')
    unsubscribe()
    setLanguage('en')
    expect(listener).toHaveBeenCalledTimes(3)
  })

  test('unavailable storage falls back to the browser and still switches for the session', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new DOMException('Blocked', 'SecurityError') })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Blocked', 'SecurityError') })
    browser('es-ES')
    expect(resetLanguage()).toBe('es')
    setLanguage('en')
    expect(getLanguage()).toBe('en')
    expect(warn).toHaveBeenCalledWith('Language preference could not be read.')
    expect(warn).toHaveBeenCalledWith('Language preference could not be stored.')
  })

  test('the root keeps <html lang> and React Aria in the active language', () => {
    function Probe() {
      const { locale } = useLocale()
      const { t, language } = useI18n()
      return <p>{t('common.close')} {language} {locale}</p>
    }
    render(<I18nRoot><Probe /></I18nRoot>)
    expect(document.documentElement.lang).toBe('en')
    expect(screen.getByText('Close en en-GB')).toBeInTheDocument()
    act(() => setLanguage('es'))
    expect(document.documentElement.lang).toBe('es')
    expect(screen.getByText('Cerrar es es-ES')).toBeInTheDocument()
    act(() => setLanguage('en'))
    expect(document.documentElement.lang).toBe('en')
  })

  test('formatters follow the active language', () => {
    expect(intlLocale()).toBe('en-GB')
    expect(formatNumber(1234.5)).toBe('1,234.5')
    expect(dateTimeFormat({ month: 'long', timeZone: 'UTC' }).format(Date.UTC(2026, 2, 12))).toBe('March')
    expect(['Unit 10', 'unit 2', 'Únit 1'].sort(compareText)).toEqual(['Únit 1', 'unit 2', 'Unit 10'])
    expect(upperCase('street')).toBe('STREET')
    setLanguage('es')
    expect(intlLocale()).toBe('es-ES')
    expect(formatNumber(12345.5)).toBe('12.345,5')
    expect(dateTimeFormat({ month: 'long', timeZone: 'UTC' }).format(Date.UTC(2026, 2, 12))).toBe('marzo')
    expect(collator().compare('a', 'á')).toBe(0)
    expect(lowerCase('ÁRBOL')).toBe('árbol')
  })
})

describe('shell', () => {
  function renderShell() {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('Unexpected request'))))
    vi.stubGlobal('matchMedia', (media: string) => ({ media, matches: false, addEventListener() {}, removeEventListener() {} }))
    cache.setQueryData(['auth'], { authenticated: false, username: null })
    cache.setQueryData(['reader-auth'], {
      ...signedOut, authenticated: true, kind: 'resident', name: 'Alex Morgan', email: 'alex@example.org',
      user_id: 1, dwelling_id: 1, expires_at: '2099-01-01T00:00:00Z',
    })
    cache.setQueryData(['general-settings'], { community_name: 'Maple Court' })
    cache.setQueryData(['features'], { actions: true, coefficient: true, events: true, google_login: false })
    return render(<I18nRoot><QueryClientProvider client={cache}><LoginNoticeProvider><MemoryRouter initialEntries={['/']}>
      <Routes><Route element={<Shell />}><Route index element={<p>Overview page</p>} /></Route></Routes>
    </MemoryRouter></LoginNoticeProvider></QueryClientProvider></I18nRoot>)
  }

  function expectNavigation(name: string, groups: Record<string, string[]>) {
    const navigation = screen.getByRole('navigation', { name })
    for (const [group, links] of Object.entries(groups)) {
      const section = within(navigation).getByRole('group', { name: group })
      expect(within(section).getAllByRole('link').map(link => link.textContent)).toEqual(links)
    }
  }

  test('the avatar menu switches the whole shell to Spanish and back', async () => {
    const user = userEvent.setup()
    renderShell()
    expect(screen.getByText('Maple Court')).toBeInTheDocument()
    expectNavigation('Main navigation', {
      Finances: ['Overview', 'Transactions'], Management: ['Actions', 'Events'], Community: ['Neighbors', 'Contacts'],
    })
    expect(screen.getByRole('contentinfo')).toHaveTextContent('Information from the imported statements')
    await user.click(screen.getByRole('button', { name: 'User menu' }))
    const menu = screen.getByRole('navigation', { name: 'User options' })
    expect(within(menu).getByRole('link', { name: 'My profile' })).toHaveAttribute('href', '/profile')
    expect(within(menu).getByRole('button', { name: 'Sign out' })).toBeInTheDocument()
    await user.selectOptions(within(menu).getByRole('combobox', { name: 'Language' }), 'es')

    expect(document.documentElement.lang).toBe('es')
    expect(localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe('es')
    expectNavigation('Navegación principal', {
      Gastos: ['Resumen', 'Movimientos'], 'Gestión': ['Actuaciones', 'Eventos'], 'Información': ['Vecinos', 'Contactos'],
    })
    expect(screen.getByRole('button', { name: 'Ocultar importes' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Modo oscuro' })).toBeInTheDocument()
    expect(screen.getByRole('contentinfo')).toHaveTextContent('Información de los extractos importados')
    const spanishMenu = screen.getByRole('navigation', { name: 'Opciones de usuario' })
    expect(within(spanishMenu).getByRole('link', { name: 'Mi perfil' })).toBeInTheDocument()
    expect(within(spanishMenu).getByRole('button', { name: 'Cerrar sesión' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Menú de usuario' })).toHaveAttribute('aria-expanded', 'true')

    await user.selectOptions(within(spanishMenu).getByRole('combobox', { name: 'Idioma' }), 'en')
    expect(document.documentElement.lang).toBe('en')
    expectNavigation('Main navigation', {
      Finances: ['Overview', 'Transactions'], Management: ['Actions', 'Events'], Community: ['Neighbors', 'Contacts'],
    })
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument()
  })

  test('a Spanish browser opens the shell in Spanish', () => {
    browser('es-ES', 'en')
    resetLanguage()
    renderShell()
    expectNavigation('Navegación principal', { Gastos: ['Resumen', 'Movimientos'] })
    expect(screen.getByRole('link', { name: 'Saltar al contenido' })).toHaveAttribute('href', '#content')
  })
})
