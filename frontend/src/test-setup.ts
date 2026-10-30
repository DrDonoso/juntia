import '@testing-library/jest-dom/vitest'
import { beforeEach } from 'vitest'
import { LANGUAGE_STORAGE_KEY, resetLanguage } from './i18n/store'

globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
}

// Every test starts in English: no stored choice and an English browser. Assert Spanish with
// `setLanguage('es')` (before rendering, or inside `act` afterwards).
beforeEach(() => {
  try { localStorage.removeItem(LANGUAGE_STORAGE_KEY) }
  catch { console.warn('Language preference could not be cleared.') }
  Object.defineProperty(navigator, 'languages', { configurable: true, get: () => ['en-GB', 'en'] })
  Object.defineProperty(navigator, 'language', { configurable: true, get: () => 'en-GB' })
  resetLanguage()
})
