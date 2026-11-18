import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, useLocation } from 'react-router'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { api, cache } from './api/client'
import type { SearchResultsOut } from './api/schema.gen'
import { I18nRoot, setLanguage } from './i18n'
import type { SearchHit } from './search'
import { SearchResultsPage } from './search-results'

vi.mock('./api/client', async original => {
  const actual = await original<typeof import('./api/client')>()
  return { ...actual, api: vi.fn() }
})

const action = (id: number): SearchHit => ({ kind: 'action', id, title: `Lift repair ${id}`, status: 'detected', excerpt: null })
const contact: SearchHit = { kind: 'contact', id: 5, title: 'Apex Lifts', company: 'Apex', email: null, phone: '+442079460101', excerpt: null }
const transaction: SearchHit = {
  kind: 'transaction', id: 11, title: 'DIRECT DEBIT LIFT ALARM', excerpt: null, booking_date: '2026-10-02', amount: '-30.00', merchant: 'Ringwise',
}
const counts: SearchResultsOut['counts'] = [{ kind: 'action', total: 7 }, { kind: 'contact', total: 1 }, { kind: 'transaction', total: 1 }]
let requests: string[], answers: Record<string, SearchResultsOut>
const defaults = cache.getDefaultOptions()

beforeEach(() => {
  cache.setDefaultOptions({ queries: { retry: false } })
  requests = []
  answers = {
    // The server lists the kinds with the best matches first.
    'q=lift': { counts, items: [contact, ...[7, 6, 5, 4, 3].map(action), transaction], page: 1, pages: 1 },
    'q=lift&kind=action': { counts, items: [7, 6, 5].map(action), page: 1, pages: 3 },
    'q=lift&kind=action&page=2': { counts, items: [4, 3, 2].map(action), page: 2, pages: 3 },
    'q=zzz': { counts: [], items: [], page: 1, pages: 0 },
  }
  vi.mocked(api).mockImplementation(async (url: string) => {
    const search = url.replace(/^\/search\/results\?/, '')
    requests.push(search)
    const answer = answers[search]
    if (!answer) throw new Error(`Unexpected API request: ${url}`)
    return answer
  })
})
afterEach(() => { cleanup(); cache.clear(); cache.setDefaultOptions(defaults); vi.restoreAllMocks(); setLanguage('en') })

function Address() {
  const location = useLocation()
  return <p data-testid="address">{location.pathname + location.search}</p>
}

function page(address: string) {
  render(<I18nRoot><QueryClientProvider client={cache}><MemoryRouter initialEntries={[address]}>
    <SearchResultsPage /><Address />
  </MemoryRouter></QueryClientProvider></I18nRoot>)
}

const filters = () => within(screen.getByRole('navigation', { name: 'Filter by type' })).getAllByRole('link')

test('lists the best of each kind, the best kinds first, with filters that count every kind', async () => {
  page('/search?q=lift')
  expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Results for “lift”')
  const sections = await screen.findAllByRole('region')
  expect(sections.map(section => within(section).getByRole('heading', { level: 2 }).textContent)).toEqual([
    'Contacts 1', 'Actions 7', 'Transactions 1',
  ])
  expect(filters().map(link => [link.textContent, link.getAttribute('href')])).toEqual([
    ['All 9', '/search?q=lift'], ['Actions 7', '/search?q=lift&kind=action'],
    ['Contacts 1', '/search?q=lift&kind=contact'], ['Transactions 1', '/search?q=lift&kind=transaction'],
  ])
  expect(filters()[0]).toHaveAttribute('aria-current', 'page')
  const actions = within(sections[1])
  expect(actions.getAllByRole('listitem')).toHaveLength(5)
  expect(actions.getByRole('link', { name: /^Lift repair 7/ })).toHaveAttribute('href', '/actions/7')
  expect(actions.getByRole('link', { name: 'See all 7 actions' })).toHaveAttribute('href', '/search?q=lift&kind=action')
  expect(within(sections[0]).queryByRole('link', { name: /^See all/ })).toBeNull()
  expect(within(sections[0]).getByText('Lift').tagName).toBe('MARK')
  expect(sections[2]).toHaveTextContent('02/10/2026 · -€30.00 · Ringwise')
  expect(requests).toEqual(['q=lift'])
})

test('a filter lists one kind, page by page', async () => {
  const user = userEvent.setup()
  page('/search?q=lift&kind=action')
  expect(await screen.findByRole('link', { name: /^Lift repair 5/ })).toBeVisible()
  expect(filters()[1]).toHaveAttribute('aria-current', 'page')
  expect(filters()[0]).not.toHaveAttribute('aria-current')
  expect(screen.getAllByRole('listitem')).toHaveLength(3)
  const pages = screen.getByRole('navigation', { name: 'Search results' })
  expect(pages).toHaveTextContent('Page 1 of 3')
  await user.click(within(pages).getByRole('button', { name: 'Next: Search results' }))
  expect(screen.getByTestId('address')).toHaveTextContent('/search?q=lift&kind=action&page=2')
  expect(await screen.findByRole('link', { name: /^Lift repair 2/ })).toBeVisible()
  expect(screen.getByRole('navigation', { name: 'Search results' })).toHaveTextContent('Page 2 of 3')
  // Every kind's count stays in the filters.
  expect(filters().map(link => link.textContent)).toEqual(['All 9', 'Actions 7', 'Contacts 1', 'Transactions 1'])
})

test('asks for two characters, and says when nothing matches', async () => {
  page('/search?q=l')
  expect(screen.getByText('Type at least two characters in the search box at the top of the page.')).toBeVisible()
  expect(requests).toEqual([])
  cleanup()
  page('/search?q=zzz')
  expect(await screen.findByText('Nothing matches “zzz”.')).toBeVisible()
  expect(screen.queryByRole('navigation', { name: 'Filter by type' })).toBeNull()
})

test('speaks the reader language', async () => {
  setLanguage('es')
  page('/search?q=lift')
  expect(await screen.findByRole('link', { name: 'Ver las 7 actuaciones' })).toBeVisible()
  expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Resultados de «lift»')
  expect(within(screen.getByRole('navigation', { name: 'Filtrar por tipo' })).getAllByRole('link').map(link => link.textContent)).toEqual([
    'Todo 9', 'Actuaciones 7', 'Contactos 1', 'Movimientos 1',
  ])
})
