import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { MemoryRouter } from 'react-router'
import { afterEach, expect, test, vi } from 'vitest'
import { Login } from './admin'
import { cache, signedOut } from './api/client'
import { ForgotPassword, LoginNoticeProvider, PasswordLink, ResidentLogin, safeReturnPath } from './auth'
import { setLanguage } from './i18n'
import { coefficientPercent, connectionTime, phoneValidationMessage, profileInitials } from './shared'

afterEach(() => { cleanup(); cache.clear(); vi.unstubAllGlobals() })

function renderSignedOut(ui: ReactNode, path = '/login') {
  vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('Unexpected request'))))
  cache.setQueryData(['reader-auth'], signedOut)
  cache.setQueryData(['features'], { actions: false, coefficient: false, events: false, google_login: false })
  return render(<QueryClientProvider client={cache}><LoginNoticeProvider><MemoryRouter initialEntries={[path]}>
    {ui}
  </MemoryRouter></LoginNoticeProvider></QueryClientProvider>)
}

test.each([
  [null, '/'],
  ['/transactions?start=2026-01-01&flow=expense', '/transactions?start=2026-01-01&flow=expense'],
  ['/?start=2026-01-01', '/?start=2026-01-01'],
  ['/profile', '/profile'],
  ['/neighbors', '/neighbors'],
  ['/contacts?q=elevator&sort=email&direction=desc&page=2', '/contacts?q=elevator&sort=email&direction=desc&page=2'],
  ['/contacts/extra', '/'],
  ['/admin/contacts', '/'],
  ['/actions', '/actions'],
  ['/actions?view=board&label=2', '/actions?view=board&label=2'],
  ['/actions/42?scope=all', '/actions/42?scope=all'],
  ['/actions/0', '/'],
  ['/actions/not-an-id', '/'],
  ['/actions/42/extra', '/'],
  ['/admin/actions', '/'],
  ['/actions/\n42', '/'],
  ['https://attacker.example/transactions', '/'],
  ['//attacker.example/transactions', '/'],
  ['/\\attacker.example/transactions', '/'],
  ['/admin/users', '/'],
  ['/login', '/'],
  ['/transactions/../../admin', '/'],
])('login return path %s stays in the reader portal', (value, expected) => {
  expect(safeReturnPath(value)).toBe(expected)
})

test('last connection displays a never-connected state and an actual timestamp', () => {
  expect(connectionTime(null)).toBe('Never')
  expect(connectionTime('2026-10-09T10:20:30Z')).toContain('2026')
  expect(connectionTime('2026-10-09T10:20:30Z')).toContain(':30')
  setLanguage('es')
  expect(connectionTime(null)).toBe('Nunca')
})

test('coefficients always display two decimals and profile initials retain accents', () => {
  expect(coefficientPercent('12.5')).toBe('12.50%')
  expect(coefficientPercent('0')).toBe('0.00%')
  expect(coefficientPercent('100')).toBe('100.00%')
  expect(coefficientPercent(null)).toBe('Not set')
  expect(profileInitials('  Óscar   Muñoz ')).toBe('ÓM')
  setLanguage('es')
  expect(coefficientPercent('12.5')).toBe('12,50 %')
  expect(coefficientPercent(null)).toBe('Sin definir')
  expect(profileInitials('  Óscar   Muñoz ')).toBe('ÓM')
})

test('phone entry accepts optional formatted numbers and rejects dialer instructions', () => {
  expect(phoneValidationMessage('')).toBe('')
  expect(phoneValidationMessage('+1 (202) 555-0101')).toBe('')
  expect(phoneValidationMessage('123456')).not.toBe('')
  expect(phoneValidationMessage('1234567890123456')).not.toBe('')
  expect(phoneValidationMessage('tel:+12025550101')).not.toBe('')
  expect(phoneValidationMessage('*1234567#')).not.toBe('')
})

test('the resident sign-in starts in English and its language picker switches it immediately', async () => {
  const user = userEvent.setup()
  renderSignedOut(<ResidentLogin />)
  expect(screen.getByRole('heading', { name: 'Sign in' })).toBeInTheDocument()
  expect(screen.getByRole('textbox', { name: 'Email' })).toBeInTheDocument()
  expect(screen.getByLabelText('Password')).toHaveAttribute('type', 'password')
  expect(screen.getByRole('link', { name: 'Forgot your password?' })).toHaveAttribute('href', '/forgot-password')
  const picker = screen.getByRole('combobox', { name: 'Language' })
  expect(picker).toHaveValue('en')
  expect(within(picker).getByRole('option', { name: 'English' })).toHaveAttribute('lang', 'en')
  expect(within(picker).getByRole('option', { name: 'Español' })).toHaveAttribute('lang', 'es')
  await user.selectOptions(picker, 'es')
  expect(screen.getByRole('heading', { name: 'Iniciar sesión' })).toBeInTheDocument()
  expect(screen.getByRole('textbox', { name: 'Correo electrónico' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Entrar' })).toBeInTheDocument()
  expect(screen.getByRole('combobox', { name: 'Idioma' })).toHaveValue('es')
  expect(localStorage.getItem('juntia_language')).toBe('es')
  await user.selectOptions(screen.getByRole('combobox', { name: 'Idioma' }), 'en')
  expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument()
  expect(localStorage.getItem('juntia_language')).toBe('en')
})

test('the administration sign-in is translated and offers the language picker', async () => {
  const user = userEvent.setup()
  renderSignedOut(<Login />, '/admin')
  expect(screen.getByRole('heading', { name: 'Administration' })).toBeInTheDocument()
  expect(screen.getByRole('textbox', { name: 'Username' })).toBeInTheDocument()
  expect(screen.getByLabelText('Password')).toHaveAttribute('type', 'password')
  expect(screen.getByRole('button', { name: 'Sign in to administration' })).toBeInTheDocument()
  await user.selectOptions(screen.getByRole('combobox', { name: 'Language' }), 'es')
  expect(screen.getByRole('heading', { name: 'Administración' })).toBeInTheDocument()
  expect(screen.getByRole('textbox', { name: 'Usuario' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Entrar en administración' })).toBeInTheDocument()
})

test('recovery and invitation screens keep the picker and explain invalid links in both languages', () => {
  const { unmount } = renderSignedOut(<ForgotPassword />, '/forgot-password')
  expect(screen.getByRole('heading', { name: 'Recover your password' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Send recovery link' })).toBeInTheDocument()
  expect(screen.getByRole('combobox', { name: 'Language' })).toBeInTheDocument()
  unmount()
  const invitation = renderSignedOut(<PasswordLink invitation />, '/activate')
  expect(screen.getByRole('heading', { name: 'Activate your account' })).toBeInTheDocument()
  expect(screen.getByRole('alert')).toHaveTextContent('This link is not valid. Ask the administrator for a new invitation.')
  expect(screen.getByRole('combobox', { name: 'Language' })).toBeInTheDocument()
  invitation.unmount()
  setLanguage('es')
  renderSignedOut(<PasswordLink invitation={false} />, '/reset-password')
  expect(screen.getByRole('heading', { name: 'Nueva contraseña' })).toBeInTheDocument()
  expect(screen.getByRole('alert')).toHaveTextContent('El enlace no es válido. Solicita un nuevo enlace de recuperación.')
  expect(screen.getByRole('link', { name: 'Solicitar otro enlace' })).toHaveAttribute('href', '/forgot-password')
})
