import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { api, cache } from './api/client'
import type { ImportOut, SummaryOut, TransactionOut } from './api/schema.gen'
import { setLanguage } from './i18n'
import { Overview, Statements, Transactions } from './reader'

vi.mock('./api/client', async original => {
  const actual = await original<typeof import('./api/client')>()
  return { ...actual, api: vi.fn() }
})

const transaction: TransactionOut = {
  id: 1,
  booking_date: '2026-10-15',
  value_date: '2026-10-15',
  description: 'Water bill',
  amount: '-42.50',
  balance_after: '1250.00',
  category_id: null,
  merchant: 'Water company',
  tags: [],
  classification_source: 'manual',
  version: 1,
}
// The server names missing categories and merchants in its own language (APP_LANGUAGE).
const summary: SummaryOut = {
  income: '120.00', expense: '140.00', net: '-20.00', count: 1,
  balance: '280.00', balance_date: '2027-02-15', coverage_start: '2027-01-03', coverage_end: '2027-02-15',
  monthly: [{ month: '2027-01', income: '120.00', expense: '140.00', net: '-20.00' }],
  categories: [
    { category_id: 5, name: 'Cleaning', color: '#08735a', amount: '84.00' },
    { category_id: null, name: 'Server fallback', color: '#64748b', amount: '56.00' },
  ],
  merchants: [
    { merchant: 'Servi & Co', name: 'Servi & Co', color: '#21639f', amount: '84.00' },
    { merchant: '', name: 'Server fallback', color: '#21639f', amount: '56.00' },
  ],
  daily: [],
}
const statement: ImportOut = {
  id: '00000000-0000-4000-8000-000000000001', filename: 'synthetic.pdf', created_at: '2026-10-02T12:00:00Z',
  start_date: '2026-09-30', end_date: '2026-10-02', opening_balance: '1200.00', closing_balance: '1000.00',
  count: 3, inserted: 1, duplicates: 2,
}
const defaults = cache.getDefaultOptions()
const requests: URLSearchParams[] = []
let summaryResponse = summary

beforeEach(() => {
  requests.length = 0
  summaryResponse = summary
  cache.clear()
  cache.setDefaultOptions({ queries: { retry: false } })
  vi.mocked(api).mockImplementation(async (url, method = 'GET') => {
    if (url === '/catalog/categories' || url === '/catalog/tags') return []
    if (url.startsWith('/transactions?')) {
      requests.push(new URL(url, 'http://localhost').searchParams)
      return { items: [transaction], total: 1, page: 1, pages: 1 }
    }
    if (url.startsWith('/summary?')) return summaryResponse
    if (url === '/admin/statements') return [statement]
    if (url === `/admin/statements/${statement.id}/removal`) return { removed_transactions: 2, retained_transactions: 1, revision: 4 }
    throw new Error(`Unexpected API request: ${method} ${url}`)
  })
})

afterEach(() => {
  cleanup()
  cache.clear()
  cache.setDefaultOptions(defaults)
  vi.restoreAllMocks()
})

function renderPage(page: ReactNode, path = '/') {
  return render(<QueryClientProvider client={cache}><MemoryRouter initialEntries={[path]}>{page}</MemoryRouter></QueryClientProvider>)
}

function linkTarget(link: HTMLElement): URL {
  return new URL(link.getAttribute('href')!, 'http://localhost')
}

test('transaction headers replace the selector and control sorting', async () => {
  renderPage(<Transactions />, '/transactions?page=2&q=water')
  const table = within(await screen.findByRole('table', { name: 'Community transactions' }))
  await waitFor(() => expect(requests).toHaveLength(1))
  expect(screen.getByRole('heading', { name: '1 transaction', level: 2 })).toBeInTheDocument()
  expect(screen.queryByRole('combobox', { name: 'Sort' })).toBeNull()
  expect(requests[0].get('sort')).toBe('date')
  expect(requests[0].get('direction')).toBe('desc')
  expect(table.getByRole('columnheader', { name: 'Date' })).toHaveAttribute('aria-sort', 'descending')
  expect(table.getByRole('button', { name: 'View transaction on 15/10/2026: Water bill' })).toHaveTextContent('Details')
  expect(table.getByText('Uncategorized')).toBeInTheDocument()

  const description = table.getByRole('button', { name: 'Sort by original description' })
  fireEvent.click(description)
  await waitFor(() => expect(requests.at(-1)?.get('sort')).toBe('description'))
  expect(requests.at(-1)?.get('direction')).toBe('asc')
  expect(requests.at(-1)?.get('page')).toBeNull()
  expect(requests.at(-1)?.get('q')).toBe('water')
  await waitFor(() => expect(screen.getByRole('columnheader', { name: 'Original description' })).toHaveAttribute('aria-sort', 'ascending'))

  fireEvent.click(screen.getByRole('button', { name: 'Sort by original description' }))
  await waitFor(() => expect(requests.at(-1)?.get('direction')).toBe('desc'))
  await waitFor(() => expect(screen.getByRole('columnheader', { name: 'Original description' })).toHaveAttribute('aria-sort', 'descending'))

  fireEvent.click(screen.getByRole('button', { name: 'Sort by date' }))
  await waitFor(() => expect(requests.at(-1)?.get('sort')).toBe('date'))
  expect(requests.at(-1)?.get('direction')).toBe('desc')
})

test('legacy ordering links retain their direction', async () => {
  renderPage(<Transactions />, '/transactions?sort=oldest')
  await screen.findByRole('table', { name: 'Community transactions' })
  await waitFor(() => expect(requests).toHaveLength(1))
  expect(requests[0].get('sort')).toBe('date')
  expect(requests[0].get('direction')).toBe('asc')
  expect(screen.getByRole('columnheader', { name: 'Date' })).toHaveAttribute('aria-sort', 'ascending')
})

test('the overview names missing categories and merchants itself and keeps their drill-downs', async () => {
  renderPage(<Overview />, '/?q=water')
  const uncategorized = await screen.findByRole('link', { name: 'View uncategorized transactions' })
  expect(uncategorized).toHaveTextContent('Uncategorized')
  expect(linkTarget(uncategorized).pathname).toBe('/transactions')
  expect(linkTarget(uncategorized).searchParams.get('uncategorized')).toBe('true')
  expect(linkTarget(uncategorized).searchParams.get('q')).toBe('water')
  expect(linkTarget(uncategorized).searchParams.get('flow')).toBe('expense')
  const cleaning = screen.getByRole('link', { name: 'View transactions in category Cleaning' })
  expect(cleaning).toHaveTextContent('Cleaning')
  expect(linkTarget(cleaning).searchParams.get('category')).toBe('5')
  const noMerchant = screen.getByRole('link', { name: 'View transactions without a merchant' })
  expect(noMerchant).toHaveTextContent('No merchant')
  expect(linkTarget(noMerchant).searchParams.has('merchant_exact')).toBe(true)
  expect(linkTarget(noMerchant).searchParams.get('merchant_exact')).toBe('')
  expect(linkTarget(screen.getByRole('link', { name: 'View transactions from merchant Servi & Co' })).searchParams.get('merchant_exact')).toBe('Servi & Co')
  expect(screen.queryByText('Server fallback')).toBeNull()
  expect(screen.getByRole('heading', { name: 'Community finances', level: 1 })).toBeInTheDocument()
  expect(within(screen.getByRole('region', { name: 'Financial summary' })).getByText('1 transaction')).toBeInTheDocument()
  expect(screen.getByText('Data available up to 15/02/2027.')).toBeInTheDocument()
  expect(screen.getByText('60.0%')).toBeInTheDocument()
})

test('statements count with plurals and confirm deletions in full sentences', async () => {
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
  renderPage(<Statements />, '/admin/statements')
  expect(await screen.findByText('3 transactions · 1 new · 2 already recorded')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Delete import' }))
  await waitFor(() => expect(confirm).toHaveBeenCalledWith(
    'Deleting this statement will remove 2 transactions. 1 transaction backed by other statements will be kept. Continue?',
  ))
  expect(vi.mocked(api).mock.calls.some(([, method]) => method === 'DELETE')).toBe(false)
})

test('a Spanish browser reads the finance pages in Spanish whatever language the server uses', async () => {
  setLanguage('es')
  summaryResponse = {
    ...summary,
    categories: summary.categories.map(row => row.category_id === null ? { ...row, name: 'Uncategorized' } : row),
    merchants: summary.merchants.map(row => row.merchant ? row : { ...row, name: 'No merchant' }),
  }
  const overview = renderPage(<Overview />)
  expect(await screen.findByRole('link', { name: 'Ver movimientos de la categoría Sin categoría' })).toHaveTextContent('Sin categoría')
  expect(screen.getByRole('link', { name: 'Ver movimientos del proveedor Sin proveedor' })).toHaveTextContent('Sin proveedor')
  expect(screen.queryByText('Uncategorized')).toBeNull()
  expect(screen.queryByText('No merchant')).toBeNull()
  expect(screen.getByRole('heading', { name: 'Finanzas de la comunidad', level: 1 })).toBeInTheDocument()
  expect(within(screen.getByRole('region', { name: 'Resumen financiero' })).getByText('1 movimiento')).toBeInTheDocument()
  expect(screen.getByText(/^60,0\s%$/)).toBeInTheDocument()
  overview.unmount()

  renderPage(<Transactions />, '/transactions')
  const table = within(await screen.findByRole('table', { name: 'Movimientos de la comunidad' }))
  expect(screen.getByRole('heading', { name: '1 movimiento', level: 2 })).toBeInTheDocument()
  expect(table.getByRole('button', { name: 'Ordenar por fecha' })).toBeInTheDocument()
  expect(table.getByRole('button', { name: 'Ver movimiento del 15/10/2026: Water bill' })).toHaveTextContent('Detalle')
})
