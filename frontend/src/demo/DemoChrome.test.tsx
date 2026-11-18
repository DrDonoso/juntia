import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { cache } from '../api/client'
import type { UserAuthOut } from '../api/schema.gen'
import { ForgotPassword, Login, LoginNoticeProvider } from '../auth'
import { I18nRoot, setLanguage } from '../i18n'
import { en } from '../i18n/locales/en'
import { es } from '../i18n/locales/es'
import { signInResident, signOutResident } from './core'
import DemoChrome from './DemoChrome'
import { resetDemoWelcome } from './DemoWelcome'
import { resetDemo } from './store'
import { demoRequest, stubFetchWithDemo } from './testing'

const { setupWorker, start } = vi.hoisted(() => {
  const start = vi.fn(async () => undefined)
  return { start, setupWorker: vi.fn(() => ({ start })) }
})
vi.mock('msw/browser', () => ({ setupWorker }))

// jsdom has no modal dialogs: open and close them like the browser does.
const showModal = HTMLDialogElement.prototype.showModal, closeModal = HTMLDialogElement.prototype.close
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', '') }
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open') }
})
afterAll(() => {
  HTMLDialogElement.prototype.showModal = showModal
  HTMLDialogElement.prototype.close = closeModal
})

function Location() {
  const { pathname, search } = useLocation()
  return <output aria-label="Location">{pathname + search}</output>
}

/** The demo chrome next to the real sign-in screens, against the demo API. */
function renderDemo(path: string, { login = <Login /> }: { login?: ReactNode } = {}) {
  return render(<I18nRoot><QueryClientProvider client={cache}><LoginNoticeProvider><MemoryRouter initialEntries={[path]}>
    <main id="content"><Routes>
      <Route path="/login" element={login} />
      <Route path="/forgot-password" element={<ForgotPassword />} />
      <Route path="*" element={null} />
    </Routes></main>
    <Location />
    <DemoChrome />
  </MemoryRouter></LoginNoticeProvider></QueryClientProvider></I18nRoot>)
}

const welcome = () => screen.findByRole('dialog', { name: en.demo.welcome.title })
const location = () => screen.getByRole('status', { name: 'Location' })

beforeEach(() => {
  resetDemo()
  resetDemoWelcome()
  stubFetchWithDemo()
})
afterEach(() => {
  cleanup()
  cache.clear()
  vi.unstubAllGlobals()
})

describe('demo chrome', () => {
  test('a persistent banner and a welcome dialog once per page load', async () => {
    const user = userEvent.setup()
    const { unmount } = renderDemo('/')
    const banner = screen.getByRole('complementary', { name: en.demo.banner.label })
    expect(banner).toHaveTextContent(en.demo.banner.text)
    expect(within(banner).getByRole('link', { name: en.demo.banner.sourceLabel }))
      .toHaveAttribute('href', 'https://github.com/DrDonoso/juntia')
    expect(document.documentElement.dataset.demo).toBe('true')

    const dialog = await welcome()
    expect(dialog).toHaveTextContent(en.demo.welcome.data)
    expect(await within(dialog).findByText('You are signed in as Olivia Bennett, a neighbor at Maple Court. The administration is one click away too.')).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: en.demo.welcome.neighbor }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(location()).toHaveTextContent(/^\/$/)
    unmount()
    expect(document.documentElement.dataset.demo).toBeUndefined()

    renderDemo('/')
    expect(screen.getByRole('complementary', { name: en.demo.banner.label })).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  test('the welcome dialog names whoever is signed in', async () => {
    signInResident(1)
    renderDemo('/')
    expect(await within(await welcome()).findByText('You are signed in as James Okafor, a neighbor at Maple Court. The administration is one click away too.'))
      .toBeInTheDocument()
  })

  test('"Open administration" signs James Okafor, the administrator, in and opens /admin', async () => {
    const user = userEvent.setup()
    renderDemo('/')
    await user.click(within(await welcome()).getByRole('button', { name: en.demo.welcome.admin }))
    await waitFor(() => expect(location()).toHaveTextContent(/^\/admin$/))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(cache.getQueryData<UserAuthOut>(['reader-auth'])).toMatchObject({
      authenticated: true, administrator: true, user_id: 1, name: 'James Okafor', email: 'james.okafor@example.com',
    })
    expect((await demoRequest<UserAuthOut>('GET', '/api/auth/session')).body).toMatchObject({ user_id: 1, administrator: true })
  })

  test('"Open administration" opens the page of the administration that was asked for', async () => {
    const user = userEvent.setup()
    renderDemo('/admin/users?sort=status')
    await user.click(within(await welcome()).getByRole('button', { name: en.demo.welcome.admin }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(location()).toHaveTextContent(/^\/admin\/users\?sort=status$/)
    expect(cache.getQueryData<UserAuthOut>(['reader-auth'])).toMatchObject({ administrator: true, user_id: 1 })
  })

  test('"Explore as a neighbor" leaves an administration link for the portal', async () => {
    const user = userEvent.setup()
    renderDemo('/admin/users')
    await user.click(within(await welcome()).getByRole('button', { name: en.demo.welcome.neighbor }))
    await waitFor(() => expect(location()).toHaveTextContent(/^\/$/))
    expect((await demoRequest<UserAuthOut>('GET', '/api/auth/session')).body).toMatchObject({ user_id: 6, administrator: false })
  })

  test('the texts follow the language', async () => {
    setLanguage('es')
    renderDemo('/')
    expect(screen.getByRole('complementary', { name: es.demo.banner.label })).toHaveTextContent(es.demo.banner.text)
    expect(await screen.findByRole('dialog', { name: es.demo.welcome.title })).toBeInTheDocument()
  })
})

describe('sign-in help', () => {
  test('the sign-in arrives filled in with the sample neighbor, and signs in', async () => {
    const user = userEvent.setup()
    signOutResident()
    renderDemo('/login')
    await user.click(within(await welcome()).getByRole('button', { name: en.common.close }))
    const note = await screen.findByRole('note')
    expect(note).toHaveTextContent('Demo: sign in as olivia.bennett@example.com with the password demo. Every active neighbor of the demo uses the same password.')
    const form = screen.getByRole('button', { name: en.auth.login.submit }).closest('form')
    expect(note.parentElement?.nextElementSibling).toBe(form)
    await waitFor(() => expect(screen.getByLabelText(en.auth.email)).toHaveValue('olivia.bennett@example.com'))
    expect(screen.getByLabelText(en.auth.password)).toHaveValue('demo')
    await user.click(screen.getByRole('button', { name: en.auth.login.submit }))
    await waitFor(() => expect(location()).toHaveTextContent(/^\/$/))
    expect(cache.getQueryData<UserAuthOut>(['reader-auth'])).toMatchObject({ administrator: false, user_id: 6 })
    expect(screen.queryByRole('note')).not.toBeInTheDocument()
  })

  test('once the sample neighbor has chosen another password, only the email is filled in', async () => {
    const user = userEvent.setup()
    const password = 'new-demo-password'
    expect(await demoRequest('POST', '/api/auth/profile/password', { body: { current_password: 'demo', password } })).toMatchObject({ status: 204 })
    renderDemo('/login')
    await user.click(within(await welcome()).getByRole('button', { name: en.common.close }))
    expect(await screen.findByRole('note')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByLabelText(en.auth.email)).toHaveValue('olivia.bennett@example.com'))
    expect(screen.getByLabelText(en.auth.password)).toHaveValue('')
    await user.type(screen.getByLabelText(en.auth.password), password)
    await user.click(screen.getByRole('button', { name: en.auth.login.submit }))
    await waitFor(() => expect(location()).toHaveTextContent(/^\/$/))
    expect(cache.getQueryData<UserAuthOut>(['reader-auth'])).toMatchObject({ user_id: 6 })
  })

  test('signing in to return to the administration arrives filled in with the administrator, James Okafor', async () => {
    const user = userEvent.setup()
    signOutResident()
    renderDemo('/login?next=%2Fadmin%2Fusers')
    await user.click(within(await welcome()).getByRole('button', { name: en.common.close }))
    expect(await screen.findByRole('note')).toHaveTextContent(
      'Demo: sign in as james.okafor@example.com with the password demo. James Okafor, the president, is also the administrator.',
    )
    await waitFor(() => expect(screen.getByLabelText(en.auth.email)).toHaveValue('james.okafor@example.com'))
    expect(screen.getByLabelText(en.auth.password)).toHaveValue('demo')
    await user.click(screen.getByRole('button', { name: en.auth.login.submit }))
    await waitFor(() => expect(location()).toHaveTextContent(/^\/admin\/users$/))
    expect(cache.getQueryData<UserAuthOut>(['reader-auth'])).toMatchObject({ administrator: true, user_id: 1 })
    await waitFor(() => expect(screen.queryByRole('note')).not.toBeInTheDocument())
  })

  test('a return to the portal keeps the sample neighbor, and the administrator gets only the email once his password changed', async () => {
    const user = userEvent.setup()
    signOutResident()
    const { unmount } = renderDemo('/login?next=%2Fneighbors')
    await user.click(within(await welcome()).getByRole('button', { name: en.common.close }))
    expect(await screen.findByRole('note')).toHaveTextContent('Demo: sign in as olivia.bennett@example.com with the password demo.')
    unmount()

    signInResident(1)
    expect(await demoRequest('POST', '/api/auth/profile/password', { body: { current_password: 'demo', password: 'another-password' } })).toMatchObject({ status: 204 })
    renderDemo('/login?next=%2Fadmin')
    expect(await screen.findByRole('note')).toHaveTextContent('Demo: sign in as james.okafor@example.com')
    await waitFor(() => expect(screen.getByLabelText(en.auth.email)).toHaveValue('james.okafor@example.com'))
    expect(screen.getByLabelText(en.auth.password)).toHaveValue('')
  })

  test('other screens get no help, and a form that already has values is left alone', async () => {
    const user = userEvent.setup()
    signOutResident()
    const { unmount } = renderDemo('/forgot-password')
    await user.click(within(await welcome()).getByRole('button', { name: en.common.close }))
    expect(await screen.findByRole('heading', { name: en.auth.forgot.title })).toBeInTheDocument()
    expect(screen.getByLabelText(en.auth.email)).toHaveValue('')
    expect(screen.queryByRole('note')).not.toBeInTheDocument()
    unmount()

    renderDemo('/login', {
      login: <section className="card login"><form>
        <label>{en.auth.email}<input type="email" autoComplete="username" defaultValue="grace.liu@example.com" /></label>
        <label>{en.auth.password}<input type="password" autoComplete="current-password" defaultValue="typed" /></label>
      </form></section>,
    })
    expect(await screen.findByRole('note')).toBeInTheDocument()
    expect(screen.getByLabelText(en.auth.email)).toHaveValue('grace.liu@example.com')
    expect(screen.getByLabelText(en.auth.password)).toHaveValue('typed')
  })
})

describe('start', () => {
  test('starts the service worker with every handler, quietly, bypassing static files', async () => {
    setupWorker.mockClear()
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: {} })
    try {
      const { startDemo } = await import('./browser')
      const root = document.createElement('div')
      expect(await startDemo(root)).toBe(true)
      expect(setupWorker).toHaveBeenCalledOnce()
      expect(start).toHaveBeenCalledWith({ serviceWorker: { url: '/mockServiceWorker.js' }, quiet: true, onUnhandledRequest: 'bypass' })
      expect(root).toBeEmptyDOMElement()
    } finally {
      Reflect.deleteProperty(navigator, 'serviceWorker')
    }
  })

  test('without service workers it explains, in the visitor\'s language, why the demo cannot run', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    setLanguage('es')
    const { startDemo } = await import('./browser')
    const root = document.createElement('div')
    expect(await startDemo(root)).toBe(false)
    expect(within(root).getByRole('alert')).toHaveTextContent(`${es.demo.startError.title}${es.demo.startError.description}`)
    expect(document.documentElement.lang).toBe('es')
    expect(error).toHaveBeenCalled()
    error.mockRestore()
  })
})
