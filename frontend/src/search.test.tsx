import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClientProvider } from '@tanstack/react-query'
import { useRef, useState } from 'react'
import { MemoryRouter, useLocation } from 'react-router'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { ApiError, api, cache } from './api/client'
import type { SearchOut } from './api/schema.gen'
import { I18nRoot, setLanguage } from './i18n'
import { GlobalSearch, foldText, highlight, hitPath, resultsPath, searchWords, type SearchHit } from './search'

vi.mock('./api/client', async original => {
  const actual = await original<typeof import('./api/client')>()
  return { ...actual, api: vi.fn() }
})

const hits: SearchHit[] = [
  { kind: 'action', id: 3, title: 'Lift modernisation', excerpt: null, status: 'voting' },
  {
    kind: 'event', id: 9, title: 'Lift inspection', location: 'Machine room', all_day: false,
    starts_at: '2026-11-20T09:00:00Z', ends_at: '2026-11-20T11:00:00Z', starts_on: null, ends_on: null,
    excerpt: { text: 'The technician checks the lift doors.', source: 'description' },
  },
  { kind: 'file', id: 7, title: 'Lift contract.pdf', excerpt: null, document_kind: 'pdf', folder_id: 4, location: [{ id: 4, name: 'Contracts' }] },
  {
    kind: 'contact', id: 5, title: 'Apex Lifts', company: 'Apex', email: null, phone: '+442079460101',
    excerpt: { text: 'Call for lift emergencies', source: 'notes' },
  },
  { kind: 'transaction', id: 11, title: 'DIRECT DEBIT LIFT ALARM', excerpt: null, booking_date: '2026-10-02', amount: '-30.00', merchant: 'Ringwise' },
  { kind: 'action', id: 4, title: 'Pest control', status: 'detected', excerpt: { text: 'I saw one in the lift lobby.', source: 'comment' } },
]
let requests: string[], answers: Record<string, SearchOut | Error>
const defaults = cache.getDefaultOptions()

beforeEach(() => {
  cache.setDefaultOptions({ queries: { retry: false } })
  requests = []
  answers = { lift: { items: hits, more: false } }
  vi.mocked(api).mockImplementation(async (url: string) => {
    if (url === '/events/config') return { timezone: 'Europe/Madrid' }
    if (url.startsWith('/search?')) {
      const q = new URLSearchParams(url.slice('/search?'.length)).get('q') ?? ''
      requests.push(q)
      const answer = answers[q] ?? { items: [], more: false }
      if (answer instanceof Error) throw answer
      return answer
    }
    throw new Error(`Unexpected API request: ${url}`)
  })
})
afterEach(() => { cleanup(); cache.clear(); cache.setDefaultOptions(defaults); vi.restoreAllMocks() })

function Address() {
  const location = useLocation()
  return <p data-testid="address">{location.pathname + location.search}</p>
}

function Page({ compact, hideAmounts }: { compact: boolean; hideAmounts: boolean }) {
  const [open, setOpen] = useState(false)
  const panel = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null)
  return <>
    <GlobalSearch hideAmounts={hideAmounts} panel={compact ? { open, setOpen, panel, trigger } : undefined} />
    <main id="content" tabIndex={-1}><input aria-label="Another field" /></main>
    <Address />
  </>
}

function page({ compact = false, hideAmounts = false } = {}) {
  render(<I18nRoot><QueryClientProvider client={cache}><MemoryRouter initialEntries={['/']}>
    <Page compact={compact} hideAmounts={hideAmounts} />
  </MemoryRouter></QueryClientProvider></I18nRoot>)
  return screen.queryByRole('combobox', { name: 'Search the portal' })
}

/** The results listed for `text`, without the last option, which opens the page with all of them. */
async function results(box: HTMLElement, text = 'lift') {
  await userEvent.setup().type(box, text)
  const options = within(await screen.findByRole('listbox', { name: 'Search results' })).getAllByRole('option')
  expect(options.at(-1)).toHaveAccessibleName('See all results')
  expect(options.at(-1)).toHaveAttribute('href', resultsPath((box as HTMLInputElement).value.trim()))
  return options.slice(0, -1)
}

test('words are compared without case and accents, and marked wherever they appear', () => {
  expect(foldText('Ático ÑANDÚ Straße ﬁnca')).toBe('atico nandu strasse finca')
  expect(searchWords('  Ático  atico Lift ')).toEqual(['atico', 'lift'])
  const { container } = render(<p>{highlight('Revisión del ÁTICO y del ático', ['atico', 'revision'])}</p>)
  expect([...container.querySelectorAll('mark')].map(mark => mark.textContent)).toEqual(['Revisión', 'ÁTICO', 'ático'])
  expect(container).toHaveTextContent('Revisión del ÁTICO y del ático')
})

test('each result opens its own page, or the dialog of its page', () => {
  expect(hits.map(hitPath)).toEqual([
    '/actions/3', '/events?event=9', '/documents/folders/4?file=7', '/contacts?contact=5',
    '/transactions?q=DIRECT+DEBIT+LIFT+ALARM&start=2026-10-02&end=2026-10-02', '/actions/4',
  ])
  expect(hitPath({ kind: 'file', id: 8, title: 'Rules.pdf', excerpt: null, document_kind: 'pdf', folder_id: null, location: [] })).toBe('/documents?file=8')
  expect(hitPath({ kind: 'folder', id: 4, title: 'Contracts', excerpt: null, location: [] })).toBe('/documents/folders/4')
  expect(hitPath({
    kind: 'neighbor', id: 6, title: 'Olivia Bennett', excerpt: null, email: 'olivia@example.org', phone: '', dwelling: '2B', is_president: false,
  })).toBe('/neighbors?neighbor=6')
  expect(resultsPath('lift')).toBe('/search?q=lift')
  expect(resultsPath('ático 2B', 'file', 3)).toBe('/search?q=%C3%A1tico+2B&kind=file&page=3')
})

test('typing lists the best matches with what each one is, but a single character searches nothing', async () => {
  const user = userEvent.setup()
  const box = page()!
  await user.type(box, 'l')
  await new Promise(resolve => setTimeout(resolve, 400))
  expect(requests).toEqual([])
  expect(screen.queryByRole('listbox')).toBeNull()
  const options = await results(box, 'ift')
  expect(requests).toEqual(['lift'])
  expect(box).toHaveAttribute('aria-expanded', 'true')
  expect(screen.getByRole('status')).toHaveTextContent('6 results')
  expect(options.map(option => option.querySelector('.search-hit-kind')?.textContent)).toEqual([
    'Action', 'Event', 'Document', 'Contact', 'Transaction', 'Action',
  ])
  expect(options.map(option => option.getAttribute('href'))).toEqual(hits.map(hitPath))
  expect(within(options[0]).getByText('Lift').tagName).toBe('MARK')
  expect(options[0]).toHaveTextContent('Lift modernisationActionVoting')
  await waitFor(() => expect(options[1]).toHaveTextContent('20/11/2026, 10:00 – 20/11/2026, 12:00 · Machine room'))
  expect(options[1]).toHaveTextContent('The technician checks the lift doors.')
  expect(options[2]).toHaveTextContent('Documents / Contracts')
  expect(options[3]).toHaveTextContent('Apex · +442079460101')
  expect(options[4]).toHaveTextContent('02/10/2026 · -€30.00 · Ringwise')
  expect(within(options[5]).getByText('Comment:')).toBeVisible()
  expect(within(options[5]).getByText('lift').tagName).toBe('MARK')
})

test('the arrows choose a result and Enter opens it; Escape closes the list, then empties the box', async () => {
  const user = userEvent.setup()
  const box = page()!
  const options = await results(box)
  await user.keyboard('{ArrowDown}{ArrowDown}')
  expect(box).toHaveAttribute('aria-activedescendant', options[1].id)
  expect(options[1]).toHaveAttribute('aria-selected', 'true')
  // The last option, before the first, opens the page with every result.
  await user.keyboard('{ArrowUp}{ArrowUp}')
  const all = screen.getByRole('option', { name: 'See all results' })
  expect(box).toHaveAttribute('aria-activedescendant', all.id)
  expect(all).toHaveAttribute('aria-selected', 'true')
  await user.keyboard('{ArrowUp}')
  expect(box).toHaveAttribute('aria-activedescendant', options[5].id)
  await user.keyboard('{Escape}')
  expect(screen.queryByRole('listbox')).toBeNull()
  expect(box).toHaveValue('lift')
  await user.keyboard('{ArrowDown}')
  expect(screen.getByRole('listbox')).toBeVisible()
  await user.keyboard('{Escape}{Escape}')
  expect(box).toHaveValue('')
  await results(box)
  await user.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}{Enter}')
  expect(screen.getByTestId('address')).toHaveTextContent('/documents/folders/4?file=7')
  expect(box).toHaveValue('')
  expect(screen.queryByRole('listbox')).toBeNull()
  expect(screen.getByRole('main')).toHaveFocus()
})

test('Enter without a chosen result opens the page with every result, like the last option', async () => {
  const user = userEvent.setup()
  const box = page()!
  const address = () => screen.getByTestId('address')
  await user.type(box, 'l{Enter}')
  expect(address()).toHaveTextContent(/^\/$/)
  await user.clear(box)
  // At once, without waiting for the list.
  await user.type(box, ' lift doors {Enter}')
  expect(address()).toHaveTextContent(/^\/search\?q=lift\+doors$/)
  expect(box).toHaveValue('')
  expect(screen.getByRole('main')).toHaveFocus()
  await user.click((await results(box))[3])
  expect(address()).toHaveTextContent('/contacts?contact=5')
  await results(box)
  await user.keyboard('{ArrowUp}{Enter}')
  expect(address()).toHaveTextContent(/^\/search\?q=lift$/)
  await user.click((await results(box))[0])
  expect(address()).toHaveTextContent('/actions/3')
  await results(box)
  await user.click(screen.getByRole('option', { name: 'See all results' }))
  expect(address()).toHaveTextContent(/^\/search\?q=lift$/)
  expect(box).toHaveValue('')
})

test('says when nothing matches and when the search failed', async () => {
  const user = userEvent.setup()
  answers.broken = new ApiError('internal_error', 500)
  const box = page()!
  await user.type(box, 'zzz')
  expect(await screen.findByText('Nothing matches “zzz”.')).toBeVisible()
  expect(screen.queryByRole('option')).toBeNull()
  await user.clear(box)
  await user.type(box, 'broken')
  expect(await screen.findByRole('alert')).toHaveTextContent('The operation could not be completed. Contact the administrator.')
  answers.broken = { items: hits.slice(1, 2), more: false }
  await user.click(screen.getByRole('button', { name: 'Try again' }))
  expect((await screen.findAllByRole('option'))[0]).toHaveTextContent('Lift inspection')
})

test('/ and Ctrl+K go to the box, unless another field has the keys', async () => {
  const user = userEvent.setup()
  const box = page()!
  await user.keyboard('/')
  expect(box).toHaveFocus()
  expect(box).toHaveValue('')
  await user.click(screen.getByRole('textbox', { name: 'Another field' }))
  await user.keyboard('/')
  expect(screen.getByRole('textbox', { name: 'Another field' })).toHaveValue('/')
  await user.keyboard('{Control>}k{/Control}')
  expect(box).toHaveFocus()
})

test('amounts follow Hide amounts', async () => {
  const box = page({ hideAmounts: true })!
  const options = await results(box)
  expect(options[4].querySelector('.sensitive-value')).toHaveAttribute('data-hidden', 'true')
  expect(within(options[4]).getByText('Hidden amount')).toHaveClass('sr-only')
})

test('on narrow screens a magnifier opens the search under the bar, and a result closes it', async () => {
  const user = userEvent.setup()
  expect(page({ compact: true })).toBeNull()
  const toggle = screen.getByRole('button', { name: 'Search' })
  expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await user.click(toggle)
  expect(screen.getByRole('button', { name: 'Close the search' })).toHaveAttribute('aria-expanded', 'true')
  const panel = screen.getByRole('search', { name: 'Search the portal' })
  const options = await results(within(panel).getByRole('combobox'))
  await user.click(options[0])
  expect(screen.getByTestId('address')).toHaveTextContent('/actions/3')
  expect(screen.queryByRole('search')).toBeNull()
  fireEvent.keyDown(document.body, { key: 'k', ctrlKey: true })
  expect(screen.getByRole('search', { name: 'Search the portal' })).toBeVisible()
})

test('results speak the reader language', async () => {
  setLanguage('es')
  page()
  const box = screen.getByRole('combobox', { name: 'Buscar en el portal' })
  await userEvent.setup().type(box, 'lift')
  const options = within(await screen.findByRole('listbox', { name: 'Resultados de la búsqueda' })).getAllByRole('option')
  expect(options.pop()).toHaveAccessibleName('Ver todos los resultados')
  expect(options.map(option => option.querySelector('.search-hit-kind')?.textContent)).toEqual([
    'Actuación', 'Evento', 'Documento', 'Contacto', 'Movimiento', 'Actuación',
  ])
  expect(options[0]).toHaveTextContent('En votación')
  expect(options[2]).toHaveTextContent('Documentos / Contracts')
  expect(within(options[5]).getByText('Comentario:')).toBeVisible()
  expect(screen.getByRole('status')).toHaveTextContent('6 resultados')
})
