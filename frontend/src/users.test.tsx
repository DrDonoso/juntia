import { act, cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, useLocation } from 'react-router'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { api, cache } from './api/client'
import type { DwellingOut, UserOut } from './api/schema.gen'
import { setLanguage } from './i18n'
import { DwellingsPage, UsersPage } from './users'

vi.mock('./api/client', async original => {
  const actual = await original<typeof import('./api/client')>()
  return { ...actual, api: vi.fn() }
})

const dwellings: DwellingOut[] = [
  { id: 1, label: 'Flat 2', coefficient: '1.00', user_count: 3, version: 1 },
  { id: 2, label: 'Flat 10', coefficient: '2.00', user_count: 2, version: 1 },
]
function resident(id: number, values: Partial<UserOut>): UserOut {
  return {
    // The accented initial checks that names sort ignoring accents.
    id, email: `resident-${id}@example.org`, name: 'Áine', phone: '', status: 'active', version: 1,
    dwelling_id: 1, dwelling_label: 'Flat 2', coefficient: '1.00',
    last_login_at: null, invitation_status: 'none', invitation_expires_at: null,
    invitation_sent_at: null, google_linked: false, has_password: true, ...values,
  }
}
const records = Object.freeze([
  resident(4, { name: 'Zoe', phone: '+442079460002', dwelling_id: 2, dwelling_label: 'Flat 10', last_login_at: '2025-12-31T23:00:00Z' }),
  resident(1, { phone: '+442079460003', dwelling_id: 2, dwelling_label: 'Flat 10', last_login_at: '2026-10-17T10:00:00+02:00' }),
  resident(5, { status: 'pending', has_password: false }),
  resident(3, { name: 'chloe', phone: '+442079460001', status: 'pending', has_password: false }),
  resident(2, { name: 'Beatrice', status: 'disabled', last_login_at: '2026-10-17T08:30:00Z' }),
])
const defaults = cache.getDefaultOptions()

beforeEach(() => {
  cache.clear()
  cache.setDefaultOptions({ queries: { retry: false } })
  vi.mocked(api).mockReset()
  vi.mocked(api).mockImplementation(async url => {
    if (url === '/admin/users') return records
    if (url === '/admin/dwellings') return dwellings
    if (url === '/admin/presidency') return { president: null, version: 0 }
    if (url === '/features') return { coefficient: true }
    throw new Error(`Unexpected API request: ${url}`)
  })
})
afterEach(() => {
  cleanup()
  cache.clear()
  cache.setDefaultOptions(defaults)
  vi.restoreAllMocks()
})

function Location() {
  return <output data-testid="location">{useLocation().search}</output>
}
async function page(route = '/admin/users') {
  render(<QueryClientProvider client={cache}><MemoryRouter initialEntries={[route]}><UsersPage /><Location /></MemoryRouter></QueryClientProvider>)
  return within(await screen.findByRole('table', { name: 'Community users' }))
}
function params() { return new URLSearchParams(screen.getByTestId('location').textContent || '') }
function expectOrder(ids: number[], tableName = 'Community users', editLabel = 'Edit user ') {
  const table = within(screen.getByRole('table', { name: tableName }))
  const emails = table.getAllByRole('row').slice(1).map(row =>
    within(row).getByRole('button', { name: new RegExp(`^${editLabel}`) }).getAttribute('aria-label')?.replace(editLabel, ''),
  )
  expect(emails).toEqual(ids.map(id => `resident-${id}@example.org`))
}

test('users default to natural name order with stable ties and non-sortable actions', async () => {
  const table = await page()
  expectOrder([1, 5, 2, 3, 4])
  expect(table.getByRole('columnheader', { name: 'User' })).toHaveAttribute('aria-sort', 'ascending')
  expect(table.getAllByRole('button', { name: /^Sort by / })).toHaveLength(5)
  const actions = table.getByRole('columnheader', { name: 'Actions' })
  expect(actions).not.toHaveAttribute('aria-sort')
  expect(within(actions).queryByRole('button')).toBeNull()
  expect(table.getAllByRole('button', { name: /^Delete user / })).toHaveLength(records.length)
  expect(cache.getQueryData(['admin', 'users'])).toEqual(records)
})

test.each([
  { label: 'User', sortLabel: 'Sort by user', key: 'name', direction: 'desc', first: [4, 3, 2, 1, 5], second: [1, 5, 2, 3, 4] },
  { label: 'Phone', sortLabel: 'Sort by phone', key: 'phone', direction: 'asc', first: [3, 4, 1, 5, 2], second: [1, 4, 3, 5, 2] },
  { label: 'Dwelling', sortLabel: 'Sort by dwelling', key: 'dwelling_label', direction: 'asc', first: [5, 2, 3, 1, 4], second: [1, 4, 5, 2, 3] },
  { label: 'Status', sortLabel: 'Sort by status', key: 'status', direction: 'asc', first: [1, 4, 2, 5, 3], second: [5, 3, 2, 1, 4] },
  { label: 'Last sign-in', sortLabel: 'Sort by last sign-in', key: 'last_login_at', direction: 'desc', first: [2, 1, 4, 5, 3], second: [4, 1, 2, 5, 3] },
])('$label header sorts both ways without mutating cached users or refetching', async ({ label, sortLabel, key, direction, first, second }) => {
  const user = userEvent.setup()
  const table = await page('/admin/users?source=directory')
  const button = table.getByRole('button', { name: sortLabel })
  expect(button).toHaveClass('table-sort-button')
  await user.click(button)
  expectOrder(first)
  expect(table.getByRole('columnheader', { name: label })).toHaveAttribute('aria-sort', direction === 'asc' ? 'ascending' : 'descending')
  expect(params().get('sort')).toBe(key)
  expect(params().get('direction')).toBe(direction)
  expect(params().get('source')).toBe('directory')
  expect(button).toHaveFocus()

  await user.click(button)
  expectOrder(second)
  expect(table.getByRole('columnheader', { name: label })).toHaveAttribute('aria-sort', direction === 'asc' ? 'descending' : 'ascending')
  expect(params().get('direction')).toBe(direction === 'asc' ? 'desc' : 'asc')
  expect(cache.getQueryData(['admin', 'users'])).toEqual(records)
  expect(vi.mocked(api).mock.calls.filter(([url]) => url === '/admin/users')).toHaveLength(1)
})

test('sorting restores from the URL and stays independent of the dwelling filter', async () => {
  const user = userEvent.setup()
  const table = await page('/admin/users?dwelling=1&sort=last_login_at&direction=asc&source=directory')
  expectOrder([2, 5, 3])
  expect(table.getByRole('columnheader', { name: 'Last sign-in' })).toHaveAttribute('aria-sort', 'ascending')
  await user.click(table.getByRole('button', { name: 'Sort by dwelling' }))
  expectOrder([5, 2, 3])
  expect(params().get('dwelling')).toBe('1')
  expect(table.getByRole('columnheader', { name: 'Last sign-in' })).toHaveAttribute('aria-sort', 'none')

  await user.selectOptions(screen.getByRole('combobox', { name: 'Filter by dwelling' }), '2')
  expectOrder([1, 4])
  expect(params().get('sort')).toBe('dwelling_label')
  expect(params().get('direction')).toBe('asc')
  expect(params().get('source')).toBe('directory')
  await user.selectOptions(screen.getByRole('combobox', { name: 'Filter by dwelling' }), '')
  expectOrder([5, 2, 3, 1, 4])
  expect(params().has('dwelling')).toBe(false)
  expect(params().get('sort')).toBe('dwelling_label')
  expect(params().get('direction')).toBe('asc')
})

test('sort buttons support Enter and Space and expose only the active column direction', async () => {
  const user = userEvent.setup()
  const table = await page()
  const phone = table.getByRole('button', { name: 'Sort by phone' })
  phone.focus()
  await user.keyboard('{Enter}')
  expectOrder([3, 4, 1, 5, 2])
  expect(table.getByRole('columnheader', { name: 'Phone' })).toHaveAttribute('aria-sort', 'ascending')
  expect(table.getByRole('columnheader', { name: 'User' })).toHaveAttribute('aria-sort', 'none')
  await user.keyboard(' ')
  expectOrder([1, 4, 3, 5, 2])
  expect(table.getByRole('columnheader', { name: 'Phone' })).toHaveAttribute('aria-sort', 'descending')
  expect(phone).toHaveFocus()
})

test.each(['sort=unknown&direction=invalid', 'sort=__proto__', 'direction=invalid'])('invalid sorting parameters use the default order: %s', async query => {
  const table = await page(`/admin/users?${query}`)
  expectOrder([1, 5, 2, 3, 4])
  expect(table.getByRole('columnheader', { name: 'User' })).toHaveAttribute('aria-sort', 'ascending')
})

test('the users table follows a language switch without reloading or reordering', async () => {
  const table = await page('/admin/users?sort=status&direction=asc')
  expectOrder([1, 4, 2, 5, 3])
  expect(table.getAllByText('Pending activation')).toHaveLength(2)
  expect(table.getByText('Deactivated')).toBeInTheDocument()
  expect(table.getAllByText('Never')).toHaveLength(2)

  act(() => setLanguage('es'))
  const spanish = within(screen.getByRole('table', { name: 'Usuarios de la comunidad' }))
  expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Usuarios')
  expect(spanish.getByRole('columnheader', { name: 'Estado' })).toHaveAttribute('aria-sort', 'ascending')
  expect(spanish.getByRole('button', { name: 'Ordenar por usuario' })).toHaveClass('table-sort-button')
  expect(spanish.getByRole('button', { name: 'Ordenar por vivienda' })).toBeInTheDocument()
  expect(spanish.getByText('Desactivado')).toBeInTheDocument()
  expect(spanish.getAllByText('Activo')).toHaveLength(2)
  expect(spanish.getAllByText('Nunca')).toHaveLength(2)
  expect(spanish.getByRole('button', { name: 'Editar usuario resident-1@example.org' })).toHaveTextContent('Editar')
  expect(screen.getByRole('combobox', { name: 'Filtrar por vivienda' })).toHaveDisplayValue('Todas las viviendas')
  expect(screen.getByRole('region', { name: 'Presidencia' })).toHaveTextContent('Sin asignar')
  expectOrder([1, 4, 2, 5, 3], 'Usuarios de la comunidad', 'Editar usuario ')
  expect(vi.mocked(api).mock.calls.filter(([url]) => url === '/admin/users')).toHaveLength(1)
})

test('dwellings count their accounts with plural forms in each language', async () => {
  vi.mocked(api).mockImplementation(async url => {
    if (url === '/admin/dwellings') return [{ ...dwellings[0], user_count: 1 }, dwellings[1]]
    if (url === '/features') return { coefficient: true }
    throw new Error(`Unexpected API request: ${url}`)
  })
  render(<QueryClientProvider client={cache}><MemoryRouter><DwellingsPage /></MemoryRouter></QueryClientProvider>)
  const table = within(await screen.findByRole('table', { name: 'Community dwellings' }))
  expect(table.getByRole('link', { name: '1 account' })).toHaveAttribute('href', '/admin/users?dwelling=1')
  expect(table.getByRole('link', { name: '2 accounts' })).toHaveAttribute('href', '/admin/users?dwelling=2')
  expect(table.getByRole('columnheader', { name: 'Ownership coefficient' })).toBeInTheDocument()
  expect(table.getByText('2.00%')).toBeInTheDocument()
  expect(table.getByRole('button', { name: 'Edit dwelling Flat 10' })).toHaveTextContent('Edit')
  expect(screen.getByRole('button', { name: 'Arrange dwellings' })).toBeEnabled()

  act(() => setLanguage('es'))
  const spanish = within(screen.getByRole('table', { name: 'Viviendas de la comunidad' }))
  expect(spanish.getByRole('link', { name: '1 cuenta' })).toBeInTheDocument()
  expect(spanish.getByRole('link', { name: '2 cuentas' })).toBeInTheDocument()
  expect(spanish.getByRole('columnheader', { name: 'Coeficiente' })).toBeInTheDocument()
  expect(spanish.getByText('2,00 %')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Organizar viviendas' })).toBeEnabled()
  expect(screen.getByRole('button', { name: 'Crear vivienda' })).toBeEnabled()
})
