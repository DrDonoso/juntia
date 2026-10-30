import { afterEach, expect, test, vi } from 'vitest'
import { setLanguage, translate, type Translate } from './i18n'
import { MIN_PASSWORD_LENGTH, authorName, currentYearPeriod, day, expenseShare, filterRequestParams, money, validateNewPassword, withDefaultPeriod } from './shared'

afterEach(() => vi.useRealTimers())

test('bank dates do not shift with the local timezone', () => {
  expect(day('2026-10-02')).toBe('02/10/2026')
  expect(day(null)).toBe('—')
})

test('financial display uses the currency format of the active language and explicit unknown balances', () => {
  expect(money('1234.56')).toBe('€1,234.56')
  expect(money(null)).toBe('—')
  expect(money('-20.00')).toBe('-€20.00')
  setLanguage('es')
  expect(money('1234.56')).toMatch(/^1234,56\s€$/)
  expect(money('12345.6')).toMatch(/^12\.345,60\s€$/)
  expect(money('-20.00')).toMatch(/^-20,00\s€$/)
  expect(day('2026-10-02')).toBe('02/10/2026')
})

test('home defaults use the current local calendar year', () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(2027, 5, 15))
  expect(currentYearPeriod()).toEqual({ start: '2027-01-01', end: '2027-12-31' })
})

test('period defaults preserve explicit dates, open bounds and repeated filters', () => {
  const original = new URLSearchParams('start=&end=2025-06-30&tag=1&tag=2&merchant_exact=')
  const effective = withDefaultPeriod(original, { start: '2027-01-01', end: '2027-12-31' })
  expect(effective.get('start')).toBe('')
  expect(effective.get('end')).toBe('2025-06-30')
  expect(effective.getAll('tag')).toEqual(['1', '2'])
  const request = filterRequestParams(effective)
  expect(request.has('start')).toBe(false)
  expect(request.has('merchant_exact')).toBe(true)
  expect(request.get('merchant_exact')).toBe('')
  expect(original.toString()).toBe('start=&end=2025-06-30&tag=1&tag=2&merchant_exact=')
  expect(withDefaultPeriod(new URLSearchParams(), { start: '2027-01-01', end: '2027-12-31' }).toString()).toBe('start=2027-01-01&end=2027-12-31')
})

test('category shares use the total filtered expenses and the percentage format of the active language', () => {
  expect(expenseShare('84.00', '140.00')).toBe('60.0%')
  expect(expenseShare('56.00', '140.00')).toBe('40.0%')
  expect(expenseShare('0.00', '0.00')).toBe('—')
  setLanguage('es')
  expect(expenseShare('84.00', '140.00')).toMatch(/^60,0\s%$/)
})

test('administrator authors are named in the active language, never with the name sent by the server', () => {
  const resident = { kind: 'resident', name: 'Alex Morgan' } as const
  for (const name of ['ops-admin', 'Technical administrator', 'Administrador t\u00e9cnico']) {
    setLanguage('en')
    expect(authorName({ kind: 'administrator', name })).toBe('Technical administrator')
    setLanguage('es')
    expect(authorName({ kind: 'administrator', name })).toBe('Administrador t\u00e9cnico')
  }
  expect(authorName(resident)).toBe('Alex Morgan')
  setLanguage('en')
  expect(authorName(resident)).toBe('Alex Morgan')
  // Components pass the translator of useI18n().
  const spanish: Translate = (key, ...args) => translate('es', key, ...args)
  expect(authorName({ kind: 'administrator', name: 'ops-admin' }, spanish)).toBe('Administrador t\u00e9cnico')
  expect(authorName(resident, spanish)).toBe('Alex Morgan')
})

test.each(['Secret1234', 'x'.repeat(72), 'é'.repeat(10), '😀'.repeat(10)])('accepts a supported resident password without normalization', password => {
  expect(MIN_PASSWORD_LENGTH).toBe(10)
  expect(validateNewPassword(password, password)).toBeNull()
})

test.each([
  ['', '', 'password', 'Enter a password.'],
  [' '.repeat(10), ' '.repeat(10), 'password', 'Enter a password.'],
  ['x'.repeat(9), 'x'.repeat(9), 'password', 'The password must have at least 10 characters.'],
  ['😀'.repeat(9), '😀'.repeat(9), 'password', 'The password must have at least 10 characters.'],
  ['Secret1234', '', 'confirmation', 'Repeat the password.'],
  ['Secret1234', 'Other12345', 'confirmation', 'The passwords do not match.'],
  ['x'.repeat(73), 'x'.repeat(73), 'password', 'The password is too long. Use a shorter one.'],
  ['é'.repeat(37), 'é'.repeat(37), 'password', 'The password is too long. Use a shorter one.'],
])('returns a localized validation message for invalid input', (password, confirmation, field, message) => {
  expect(validateNewPassword(password, confirmation)).toEqual({ field, message })
  expect(message).not.toMatch(/bytes|UTF-8|Please/)
})

test('password validation messages follow the active language', () => {
  setLanguage('es')
  expect(validateNewPassword('x'.repeat(9), 'x'.repeat(9))).toEqual({ field: 'password', message: 'La contraseña debe tener al menos 10 caracteres.' })
  expect(validateNewPassword('Secret1234', 'Other12345')).toEqual({ field: 'confirmation', message: 'Las contraseñas no coinciden.' })
})
