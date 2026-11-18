import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, renderHook, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, expect, test, vi } from 'vitest'
import { cache, signedOut } from './api/client'
import type { UserAuthOut } from './api/schema.gen'
import { ForgotPassword, Login, LoginNoticeProvider, PasswordLink, safeReturnPath, useReaderAuth, useSessionLifecycle } from './auth'
import { setLanguage } from './i18n'
import { coefficientPercent, connectionTime, phoneValidationMessage, profileInitials } from './shared'

const cacheDefaults = cache.getDefaultOptions()
afterEach(() => { cleanup(); cache.clear(); cache.setDefaultOptions(cacheDefaults); vi.useRealTimers(); vi.unstubAllGlobals() })

function renderSignedOut(ui: ReactNode, path = '/login', setup = false) {
  vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('Unexpected request'))))
  cache.setQueryData(['reader-auth'], signedOut)
  cache.setQueryData(['setup'], { available: setup })
  cache.setQueryData(['features'], { actions: false, coefficient: false, events: false, google_login: false })
  return render(<QueryClientProvider client={cache}><LoginNoticeProvider><MemoryRouter initialEntries={[path]}>
    {ui}
  </MemoryRouter></LoginNoticeProvider></QueryClientProvider>)
}

test.each(['resident', 'administrator'] as const)('a %s session stays signed in until its seven-day expiry', async kind => {
  vi.useFakeTimers()
  const start = new Date('2026-11-02T18:00:00Z')
  vi.setSystemTime(start)
  cache.setDefaultOptions({ ...cacheDefaults, queries: { ...cacheDefaults.queries, gcTime: Infinity } })
  const reader: UserAuthOut = {
    authenticated: true, administrator: kind === 'administrator', name: 'Test user', email: null,
    user_id: 1, dwelling_id: null,
    expires_at: new Date(start.getTime() + 168 * 3_600_000).toISOString(),
  }
  cache.setQueryData(['reader-auth'], reader)
  cache.setQueryData(['summary'], { private: true })
  renderHook(() => useSessionLifecycle(reader))

  await act(async () => { await vi.advanceTimersByTimeAsync(168 * 3_600_000 - 1) })
  expect(cache.getQueryData(['reader-auth'])).toEqual(reader)
  expect(cache.getQueryData(['summary'])).toEqual({ private: true })
  await act(async () => { await vi.advanceTimersByTimeAsync(1) })
  expect(cache.getQueryData(['reader-auth'])).toEqual(signedOut)
  expect(cache.getQueryData(['summary'])).toBeUndefined()
})

test('several refused requests close the administration once, with the session that shows the revoked role', async () => {
  const account: UserAuthOut = {
    authenticated: true, administrator: true, name: 'Alex Admin', email: 'alex@example.org',
    user_id: 1, dwelling_id: null, expires_at: '2099-01-01T00:00:00Z',
  }
  const revoked = { ...account, administrator: false }
  cache.setQueryData(['reader-auth'], account)
  cache.setQueryData(['admin', 'users'], [{ private: true }])
  const answers: ((response: Response) => void)[] = []
  vi.stubGlobal('fetch', vi.fn((_input: string, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
    answers.push(resolve)
  })))
  const { result } = renderHook(() => useReaderAuth(), {
    wrapper: ({ children }) => <QueryClientProvider client={cache}>{children}</QueryClientProvider>,
  })
  // Each refused request asks for a new check of the session: the newer check replaces the older.
  void cache.invalidateQueries({ queryKey: ['reader-auth'] })
  void cache.invalidateQueries({ queryKey: ['reader-auth'] })
  await waitFor(() => expect(answers).toHaveLength(2))
  answers[0](Response.json(revoked))
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
  answers[1](Response.json(revoked))
  await waitFor(() => expect(result.current.data).toEqual(revoked))
  expect(result.current.error).toBeNull()
  expect(cache.getQueryData(['admin', 'users'])).toBeUndefined()
})

test.each([
  [null, '/'],
  ['/transactions?start=2026-01-01&flow=expense', '/transactions?start=2026-01-01&flow=expense'],
  ['/?start=2026-01-01', '/?start=2026-01-01'],
  ['/profile', '/profile'],
  ['/neighbors', '/neighbors'],
  ['/contacts?q=elevator&sort=email&direction=desc&page=2', '/contacts?q=elevator&sort=email&direction=desc&page=2'],
  ['/contacts/extra', '/'],
  ['/admin/contacts', '/admin/contacts'],
  ['/actions', '/actions'],
  ['/actions?view=board&label=2', '/actions?view=board&label=2'],
  ['/actions/42?scope=all', '/actions/42?scope=all'],
  ['/actions/0', '/'],
  ['/actions/not-an-id', '/'],
  ['/actions/42/extra', '/'],
  ['/admin/actions/42', '/'],
  ['/documents', '/documents'],
  ['/documents/folders/7', '/documents/folders/7'],
  ['/documents/folders/0', '/'],
  ['/documents/7', '/'],
  ['/search?q=ascensor&kind=action&page=2', '/search?q=ascensor&kind=action&page=2'],
  ['/search/7', '/'],
  ['/admin/deleted-documents', '/admin/deleted-documents'],
  ['/actions/\n42', '/'],
  ['https://attacker.example/transactions', '/'],
  ['//attacker.example/transactions', '/'],
  ['/\\attacker.example/transactions', '/'],
  ['/admin', '/admin'],
  ['/admin/users?dwelling=2', '/admin/users?dwelling=2'],
  ['/admin/', '/'],
  ['/admin/users/7', '/'],
  ['/administration', '/'],
  ['/login', '/'],
  ['/transactions/../../profile', '/profile'],
])('login return path %s stays in the portal or its administration', (value, expected) => {
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
  renderSignedOut(<Login />)
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

test('a new installation offers to create the administration account, in both languages', async () => {
  const user = userEvent.setup()
  renderSignedOut(<Login />, '/login', true)
  expect(screen.getByRole('heading', { name: 'Create the administration account' })).toBeInTheDocument()
  expect(screen.getByRole('textbox', { name: 'Your name' })).toBeInTheDocument()
  expect(screen.getByRole('textbox', { name: 'Email' })).toBeInTheDocument()
  expect(screen.getByLabelText('Password')).toHaveAttribute('type', 'password')
  expect(screen.getByLabelText('Repeat password')).toHaveAttribute('type', 'password')
  expect(screen.queryByRole('link', { name: 'Forgot your password?' })).not.toBeInTheDocument()
  await user.selectOptions(screen.getByRole('combobox', { name: 'Language' }), 'es')
  expect(screen.getByRole('heading', { name: 'Crea la cuenta de administración' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Crear la cuenta y abrir la administración' })).toBeInTheDocument()
})

test('the administration account is created with a valid password and opens the administration', async () => {
  const user = userEvent.setup()
  const identity: UserAuthOut = {
    authenticated: true, administrator: true, name: 'Alex Admin', email: 'alex@example.org',
    user_id: 1, dwelling_id: null, expires_at: '2099-01-01T00:00:00Z',
  }
  renderSignedOut(<Routes>
    <Route path="/login" element={<Login />} />
    <Route path="/admin" element={<p>Administration</p>} />
  </Routes>, '/login', true)
  const requests: unknown[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    if (input !== '/api/auth/setup' || init?.method !== 'POST') throw new Error(`Unexpected ${input}`)
    requests.push(JSON.parse(String(init.body)))
    return Response.json(identity, { status: 201 })
  }))
  await user.type(screen.getByRole('textbox', { name: 'Your name' }), ' Alex Admin ')
  await user.type(screen.getByRole('textbox', { name: 'Email' }), 'alex@example.org')
  await user.type(screen.getByLabelText('Password'), 'short')
  await user.type(screen.getByLabelText('Repeat password'), 'short')
  await user.click(screen.getByRole('button', { name: 'Create the account and open the administration' }))
  expect(screen.getByRole('alert')).toHaveTextContent('The password must have at least 10 characters.')
  expect(requests).toEqual([])
  await user.clear(screen.getByLabelText('Password'))
  await user.type(screen.getByLabelText('Password'), 'a synthetic password')
  await user.clear(screen.getByLabelText('Repeat password'))
  await user.type(screen.getByLabelText('Repeat password'), 'a synthetic password')
  await user.click(screen.getByRole('button', { name: 'Create the account and open the administration' }))
  expect(await screen.findByText('Administration')).toBeInTheDocument()
  expect(requests).toEqual([{ name: 'Alex Admin', email: 'alex@example.org', password: 'a synthetic password' }])
  expect(cache.getQueryData(['reader-auth'])).toEqual(identity)
  expect(cache.getQueryData(['setup'])).toEqual({ available: false })
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
