import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, expect, test, vi } from 'vitest'
import { cache } from './api/client'
import type { ProfileOut } from './api/schema.gen'
import { LoginNoticeProvider } from './auth'
import { GoogleResult, GoogleSignIn } from './google'
import { setLanguage } from './i18n'
import { ProfilePage } from './profile'

afterEach(() => { cleanup(); cache.clear(); vi.unstubAllGlobals() })

function show(enabled: boolean, invitationToken?: string) {
  cache.setQueryData(['features'], { google_login: enabled, coefficient: true, actions: true, events: false })
  return render(<QueryClientProvider client={cache}><MemoryRouter>
    <GoogleSignIn invitationToken={invitationToken} />
  </MemoryRouter></QueryClientProvider>)
}

function showProfile(profile: Partial<ProfileOut> = {}, features = { google_login: true, coefficient: false }) {
  cache.setQueryData(['features'], features)
  cache.setQueryData(['reader-auth'], { kind: 'resident', user_id: 1 })
  cache.setQueryData(['profile', 1], {
    id: 1, name: 'Alex Morgan', email: 'alex@example.org', phone: '', version: 1, coefficient: null,
    dwelling_label: '1 A', last_login_at: null, google_linked: false, has_password: true, ...profile,
  })
  return render(<QueryClientProvider client={cache}><MemoryRouter><LoginNoticeProvider><ProfilePage /></LoginNoticeProvider></MemoryRouter></QueryClientProvider>)
}

test('Google is absent when no provider is configured', () => {
  show(false)
  expect(screen.queryByRole('button', { name: 'Continue with Google' })).toBeNull()
})

test.each(['', 'a'.repeat(64)])('Google sign-in displays a decorative icon for invitation %s', invitationToken => {
  show(true, invitationToken || undefined)
  const button = screen.getByRole('button', { name: 'Continue with Google' })
  expect(button.querySelector('svg')).toHaveAttribute('aria-hidden', 'true')
  expect(button.querySelector('svg')).toHaveAttribute('focusable', 'false')
})

test.each(['', 'a'.repeat(64)])('Google name import is only explained for invitation %s', invitationToken => {
  show(true, invitationToken || undefined)
  const notice = screen.queryByText(/we will use the name from your Google profile/)
  if (invitationToken) {
    expect(notice).toBeVisible()
    expect(notice).toHaveTextContent('you can change it in My profile')
  } else {
    expect(notice).toBeNull()
  }
})

test('Google account linking displays the same decorative icon without changing its label', () => {
  showProfile()
  const button = screen.getByRole('button', { name: 'Link Google' })
  expect(button.querySelector('svg')).toHaveAttribute('aria-hidden', 'true')
  expect(button.querySelector('svg')).toHaveAttribute('focusable', 'false')
})

test('the profile page follows the active language, including the coefficient format', () => {
  showProfile({ coefficient: '12.5', google_linked: true }, { google_login: true, coefficient: true })
  expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('My profile')
  expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('Alex Morgan')
  expect(screen.getByText('12.50%')).toBeInTheDocument()
  expect(screen.getByText('Never')).toBeInTheDocument()
  expect(screen.getByText('Google is linked to the email address alex@example.org.')).toBeInTheDocument()
  expect(screen.getByLabelText('Password to unlink Google')).toBeInTheDocument()

  act(() => setLanguage('es'))
  expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Mi perfil')
  expect(screen.getByRole('textbox', { name: 'Nombre' })).toHaveValue('Alex Morgan')
  expect(screen.getByRole('button', { name: 'Guardar datos' })).toBeDisabled()
  expect(screen.getByText('Coeficiente')).toBeInTheDocument()
  expect(screen.getByText('12,50 %')).toBeInTheDocument()
  expect(screen.getByText('Nunca')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Desvincular Google' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Cerrar todas mis sesiones' })).toBeInTheDocument()
})

test('Google activation posts the invitation and does not silently hide provider errors', async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response(
    JSON.stringify({ code: 'google_disabled' }), { status: 503 },
  ))
  vi.stubGlobal('fetch', fetcher)
  show(true, 'a'.repeat(64))
  fireEvent.click(screen.getByRole('button', { name: 'Continue with Google' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('Google sign-in is not configured')
  expect(fetcher.mock.calls[0][0]).toBe('/api/auth/google/start')
  expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({
    invitation_token: 'a'.repeat(64), return_path: '/',
  })
})

test('callback errors are translated without echoing untrusted provider text', () => {
  render(<MemoryRouter initialEntries={['/login?google_error=google_cancelled&invitation=retry']}>
    <GoogleResult />
  </MemoryRouter>)
  expect(screen.getByRole('alert')).toHaveTextContent('You cancelled the Google sign-in')
  expect(screen.getByRole('alert')).toHaveTextContent('open the invitation link in the email again')
})
