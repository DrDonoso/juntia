import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, expect, test, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { cache, signedOut } from './api/client'
import type { DwellingLayoutOut, DwellingNeighborsOut, UserAuthOut } from './api/schema.gen'
import { setLanguage, translate, type Translate } from './i18n'
import { NeighborEmail, NeighborsDirectory, NeighborsPage } from './neighbors'
import { PresidentBadge } from './shared'

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); cache.clear() })

const spanish: Translate = (key, ...args) => translate('es', key, ...args)

const email = 'resident+home@example.org'
const label = `Copy Alex's email: ${email}`

function mockClipboard(writeText?: (value: string) => Promise<void>) {
  vi.stubGlobal('navigator', { clipboard: writeText ? { writeText } : undefined })
}

test('copies the exact email and keeps the mail link available', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined)
  mockClipboard(writeText)
  render(<NeighborEmail email={email} name="Alex" />)
  const button = screen.getByRole('button', { name: label })
  expect(button).toHaveAttribute('type', 'button')
  fireEvent.click(button)
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Email copied'))
  expect(writeText).toHaveBeenCalledExactlyOnceWith(email)
  expect(screen.getByRole('link')).toHaveAttribute('href', `mailto:${encodeURIComponent(email)}`)
  fireEvent.click(button)
  await waitFor(() => expect(writeText).toHaveBeenCalledTimes(2))
})

test('does not claim success while the clipboard write is pending', async () => {
  let finish: () => void = () => { throw new Error('Clipboard write was not started') }
  mockClipboard(() => new Promise<void>(resolve => { finish = resolve }))
  render(<NeighborEmail email={email} name="Alex" />)
  fireEvent.click(screen.getByRole('button', { name: label }))
  expect(screen.getByRole('button', { name: label })).toBeDisabled()
  expect(screen.getByRole('status')).toBeEmptyDOMElement()
  finish()
  await waitFor(() => expect(screen.getByRole('button', { name: label })).toBeEnabled())
  expect(screen.getByRole('status')).toHaveTextContent('Email copied')
})

test('blocked clipboard reports the failure and allows retry', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  const writeText = vi.fn().mockRejectedValueOnce(new DOMException('Denied', 'NotAllowedError')).mockResolvedValue(undefined)
  mockClipboard(writeText)
  render(<NeighborEmail email={email} name="Alex" />)
  fireEvent.click(screen.getByRole('button', { name: label }))
  expect(await screen.findByRole('alert')).toHaveTextContent('The email could not be copied')
  expect(screen.getByRole('status')).toBeEmptyDOMElement()
  fireEvent.click(screen.getByRole('button', { name: label }))
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Email copied'))
  expect(screen.queryByRole('alert')).toBeNull()
})

test('an unavailable clipboard gives explicit manual-copy instructions', async () => {
  mockClipboard()
  render(<NeighborEmail email={email} name="Alex" />)
  fireEvent.click(screen.getByRole('button', { name: label }))
  expect(await screen.findByRole('alert')).toHaveTextContent('Select it and copy it manually')
  expect(screen.getByRole('link')).toHaveTextContent(email)
})

test('the medal is named, keyboard accessible and dismissible with Escape and blur', async () => {
  const user = userEvent.setup()
  render(<main><PresidentBadge name="Alex" /><button type="button">Next</button></main>)
  const badge = screen.getByRole('button', { name: 'Alex: Community president' })
  await user.tab()
  expect(badge).toHaveFocus()
  const tooltip = await screen.findByRole('tooltip')
  expect(tooltip).toHaveTextContent('Community president')
  expect(tooltip.closest('main')).toBe(screen.getByRole('main'))
  expect(badge).toHaveAttribute('aria-describedby', tooltip.id)
  await user.keyboard('{Escape}')
  await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull())
  expect(badge).toHaveFocus()
  await user.click(badge)
  expect(await screen.findByRole('tooltip')).toBeVisible()
  await user.tab()
  await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull())
})

test('keyboard focus keeps the tooltip when focusing scrolls the medal into view', async () => {
  const user = userEvent.setup()
  const frames: FrameRequestCallback[] = []
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => frames.push(callback))
  render(<main><PresidentBadge name="Alex" /></main>)
  await user.tab()
  expect(screen.getByRole('button', { name: 'Alex: Community president' })).toHaveFocus()
  // Browsers dispatch the scroll that brought the focused medal into view in the next frame, before
  // its animation frame callbacks; React Aria closes any open tooltip on scroll.
  fireEvent.scroll(document)
  act(() => frames.splice(0).forEach(callback => callback(performance.now())))
  expect(await screen.findByRole('tooltip')).toHaveTextContent('Community president')
})

test('the medal also explains its meaning on pointer hover', async () => {
  const user = userEvent.setup()
  render(<PresidentBadge name="Alex" />)
  const badge = screen.getByRole('button', { name: 'Alex: Community president' })
  await user.hover(badge)
  expect(await screen.findByRole('tooltip')).toHaveTextContent('Community president')
  await user.unhover(badge)
  await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull())
})

test('a preview medal keeps its tooltip inside the native modal instead of the inert page', async () => {
  const user = userEvent.setup()
  render(<main><dialog open aria-label="Preview"><PresidentBadge name="Alex" /></dialog></main>)
  await user.click(screen.getByRole('button', { name: 'Alex: Community president' }))
  const tooltip = await screen.findByRole('tooltip')
  expect(tooltip.closest('dialog')).toBe(screen.getByRole('dialog', { name: 'Preview' }))
})

test('only the designated person receives a medal without replacing the own-account tag or contacts', () => {
  render(<NeighborsDirectory layout={null} currentUserId={1} dwellings={[{
    id: 1, label: '1 A', neighbors: [
      { id: 1, name: 'Alex', email: 'alex@example.org', phone: '+442079460101', is_president: true },
      { id: 2, name: 'Sam', email: 'sam@example.org', phone: '', is_president: false },
    ],
  }]} />)
  expect(screen.getAllByRole('button', { name: /Community president/ })).toHaveLength(1)
  expect(screen.getByText('You')).toBeVisible()
  expect(screen.getByRole('link', { name: /Call Alex/ })).toHaveAttribute('href', 'tel:+442079460101')
  expect(screen.getAllByRole('button', { name: /^Copy .+'s email: / })).toHaveLength(2)
})

const directory: DwellingNeighborsOut[] = [
  { id: 1, label: '1 A', neighbors: [
    { id: 1, name: 'Alex Morgan', email: 'alex@example.org', phone: '+442079460101', is_president: true },
    { id: 2, name: 'Sam Taylor', email: 'sam@example.org', phone: '', is_president: false },
  ] },
  { id: 2, label: '1 B', neighbors: [{ id: 3, name: 'Robin Lee', email: 'robin@example.org', phone: '', is_president: false }] },
  { id: 3, label: '2 A', neighbors: [] },
]

test('dwelling cards count neighbors with plural forms and explain empty states', () => {
  render(<NeighborsDirectory layout={null} dwellings={directory} />)
  expect(within(screen.getByRole('region', { name: '1 A' })).getByText('2 neighbors')).toBeVisible()
  expect(within(screen.getByRole('region', { name: '1 B' })).getByText('1 neighbor')).toBeVisible()
  const empty = screen.getByRole('region', { name: '2 A' })
  expect(within(empty).getByText('0 neighbors')).toBeVisible()
  expect(empty).toHaveTextContent('This dwelling has no neighbors in the directory yet.')
  cleanup()
  render(<NeighborsDirectory layout={null} dwellings={[]} />)
  expect(screen.getByText('There are no dwellings in the directory yet.')).toBeVisible()
})

test('the neighbors page renders in Spanish and follows a language switch', async () => {
  const session: UserAuthOut = {
    ...signedOut, authenticated: true, kind: 'resident', name: 'Alex Morgan', email: 'alex@example.org',
    user_id: 1, dwelling_id: 1, expires_at: '2099-01-01T00:00:00Z',
  }
  const layout: DwellingLayoutOut = { version: 0, layout: null, limits: { zones: 50, rows: 100, columns: 24, cells: 10000 } }
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    if (input === '/api/auth/session') return Response.json(session)
    if (input === '/api/neighbors') return Response.json(directory)
    if (input === '/api/neighbors/layout') return Response.json(layout)
    throw new Error(`Unexpected request ${input}`)
  }))
  setLanguage('es')
  render(<QueryClientProvider client={cache}><MemoryRouter><NeighborsPage /></MemoryRouter></QueryClientProvider>)
  expect(screen.getByRole('heading', { level: 1, name: 'Vecinos' })).toBeVisible()
  expect(screen.getByText('TU COMUNIDAD')).toBeVisible()
  expect(screen.getByText('Directorio privado de la comunidad, agrupado por vivienda.')).toBeVisible()
  expect(screen.getByRole('status')).toHaveTextContent('Cargando vecinos…')
  const own = await screen.findByRole('region', { name: '1 A' })
  expect(within(own).getByText('2 vecinos')).toBeVisible()
  expect(within(own).getByText(spanish('neighbors.directory.you'))).toBeVisible()
  expect(within(own).getByRole('button', { name: 'Alex Morgan: Presidente/a de la comunidad' })).toBeVisible()
  expect(within(own).getByRole('link', { name: 'Llamar a Alex Morgan: +442079460101' })).toHaveAttribute('href', 'tel:+442079460101')
  expect(within(screen.getByRole('region', { name: '1 B' })).getByText('1 vecino')).toBeVisible()
  expect(screen.getByRole('region', { name: '2 A' })).toHaveTextContent(spanish('neighbors.directory.noNeighbors'))
  expect(await screen.findByRole('link', { name: spanish('neighbors.page.updatePhone') })).toHaveAttribute('href', '/profile')

  act(() => setLanguage('en'))
  expect(screen.getByRole('heading', { level: 1, name: 'Neighbors' })).toBeVisible()
  expect(screen.getByText('YOUR COMMUNITY')).toBeVisible()
  expect(within(own).getByText('2 neighbors')).toBeVisible()
  expect(within(own).getByText('You')).toBeVisible()
  expect(within(own).getByRole('button', { name: 'Alex Morgan: Community president' })).toBeVisible()
  expect(screen.getByRole('region', { name: '2 A' })).toHaveTextContent('This dwelling has no neighbors in the directory yet.')
  expect(screen.getByRole('link', { name: 'Update my phone number' })).toHaveAttribute('href', '/profile')
})
