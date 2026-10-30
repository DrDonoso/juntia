import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest'
import { cache } from './api/client'
import type { DwellingOut, PresidencyIn, PresidencyOut, UserOut } from './api/schema.gen'
import { UsersPage } from './users'

const defaults = cache.getDefaultOptions()
const showModal = HTMLDialogElement.prototype.showModal, closeModal = HTMLDialogElement.prototype.close
const dwellings: DwellingOut[] = [
  { id: 1, label: '1 A', coefficient: null, version: 1, user_count: 3 },
  { id: 2, label: '2 B', coefficient: null, version: 1, user_count: 1 },
]
const identities: Pick<UserOut, 'id' | 'name' | 'email' | 'dwelling_id' | 'dwelling_label' | 'status'>[] = [
  { id: 1, name: 'Alice', email: 'alice@example.org', dwelling_id: 1, dwelling_label: '1 A', status: 'active' },
  { id: 2, name: 'Peter', email: 'peter@example.org', dwelling_id: 2, dwelling_label: '2 B', status: 'active' },
  { id: 3, name: 'Pending', email: 'pending@example.org', dwelling_id: 1, dwelling_label: '1 A', status: 'pending' },
  { id: 4, name: 'Disabled', email: 'disabled@example.org', dwelling_id: 1, dwelling_label: '1 A', status: 'disabled' },
]
const residents: UserOut[] = identities.map(user => ({
  phone: '', version: 1, coefficient: null, last_login_at: null,
  invitation_status: 'none', invitation_expires_at: null, invitation_sent_at: null,
  has_password: true, google_linked: false, ...user,
}))
let saved: PresidencyOut
let writes: PresidencyIn[]
let failure: string
let readFailure: boolean

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', '') }
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open') }
})
afterAll(() => {
  HTMLDialogElement.prototype.showModal = showModal
  HTMLDialogElement.prototype.close = closeModal
  cache.setDefaultOptions(defaults)
})
beforeEach(() => {
  cache.clear()
  cache.setDefaultOptions({ queries: { retry: false, staleTime: Infinity } })
  writes = []; failure = ''; readFailure = false
  saved = { president: { id: 1, name: 'Alice', dwelling_id: 1, dwelling_label: '1 A' }, version: 4 }
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    if (input === '/api/features') return Response.json({ coefficient: false, actions: true, events: false, google_login: false })
    if (input === '/api/admin/dwellings') return Response.json(dwellings)
    if (input === '/api/admin/users') return Response.json(residents)
    if (input === '/api/admin/presidency') {
      if (init?.method !== 'PUT') return readFailure ? Response.json({ code: 'internal_error' }, { status: 503 }) : Response.json(saved)
      const body: PresidencyIn = JSON.parse(String(init.body))
      writes.push(body)
      if (failure) return Response.json({ code: failure }, { status: failure === 'presidency_stale' ? 409 : 503 })
      const person = residents.find(user => user.id === body.user_id)
      if (body.user_id !== null && !person) throw new Error('Unexpected presidency holder')
      saved = { version: saved.version + 1, president: person ? {
        id: person.id, name: person.name, dwelling_id: person.dwelling_id, dwelling_label: person.dwelling_label,
      } : null }
      return Response.json(saved)
    }
    throw new Error(`Unexpected request ${input}`)
  }))
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); cache.clear() })

async function openUsers(path = '/admin/users') {
  render(<QueryClientProvider client={cache}><MemoryRouter initialEntries={[path]}><UsersPage /></MemoryRouter></QueryClientProvider>)
  const user = userEvent.setup()
  await screen.findByRole('table', { name: 'Community users' })
  const button = screen.getByRole('button', { name: 'Change president' })
  if (!readFailure) await waitFor(() => expect(button).toBeEnabled())
  return { user, button, card: screen.getByRole('region', { name: 'Presidency' }) }
}

test('assigning an active resident requires confirmation and cancellation does not write', async () => {
  saved = { president: null, version: 0 }
  const { user, button, card } = await openUsers()
  expect(card).toHaveTextContent('Unassigned')
  await user.click(button)
  const dialog = screen.getByRole('dialog', { name: 'Change president' })
  const select = within(dialog).getByRole('combobox', { name: 'New president' })
  expect(within(select).getAllByRole('option').map(option => option.textContent)).toEqual(['Unassigned', 'Alice · 1 A', 'Peter · 2 B'])
  expect(within(dialog).getByRole('button', { name: 'Confirm change' })).toBeDisabled()
  await user.selectOptions(select, '1')
  expect(dialog).toHaveTextContent('The presidency will pass to Alice.')
  expect(writes).toEqual([])
  await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
  expect(writes).toEqual([])
  expect(button).toHaveFocus()
  await user.click(button)
  await user.selectOptions(screen.getByRole('combobox', { name: 'New president' }), '1')
  await user.click(screen.getByRole('button', { name: 'Confirm change' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(writes).toEqual([{ user_id: 1, version: 0 }])
  expect(card).toHaveTextContent('Alice')
  expect(await screen.findByRole('button', { name: 'Alice: Community president' })).toBeVisible()
  expect(await screen.findByText('Presidency updated. The change is now shown in Neighbors.')).toBeVisible()
  expect(button).toHaveFocus()
})

test('the table filter does not restrict the holder selector or hide the current president', async () => {
  const { user, button, card } = await openUsers('/admin/users?dwelling=2')
  expect(card).toHaveTextContent('Alice')
  expect(screen.queryByRole('button', { name: 'Edit user alice@example.org' })).toBeNull()
  await user.click(button)
  await user.selectOptions(screen.getByRole('combobox', { name: 'New president' }), '2')
  const dialog = screen.getByRole('dialog')
  expect(dialog).toHaveTextContent('The presidency will pass from Alice to Peter.')
  expect(dialog).toHaveTextContent("Alice's medal will be removed.")
  expect(screen.getByRole('option', { name: 'Alice · 1 A' })).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'Confirm change' }))
  await waitFor(() => expect(card).toHaveTextContent('Peter'))
  expect(writes).toEqual([{ user_id: 2, version: 4 }])
})

test('clearing the presidency sends explicit null and removes the medal', async () => {
  const { user, button, card } = await openUsers()
  await user.click(button)
  await user.selectOptions(screen.getByRole('combobox', { name: 'New president' }), '')
  expect(screen.getByRole('dialog')).toHaveTextContent('The presidency will be left unassigned.')
  await user.click(screen.getByRole('button', { name: 'Confirm change' }))
  await waitFor(() => expect(card).toHaveTextContent('Unassigned'))
  expect(writes).toEqual([{ user_id: null, version: 4 }])
  expect(screen.queryByRole('button', { name: 'Alice: Community president' })).toBeNull()
})

test('stale changes stay open, preserve the selection and cannot overwrite a new version', async () => {
  const { user, button } = await openUsers()
  await user.click(button)
  const select = screen.getByRole('combobox', { name: 'New president' })
  await user.selectOptions(select, '2')
  failure = 'presidency_stale'
  saved = { ...saved, version: 5 }
  await user.click(screen.getByRole('button', { name: 'Confirm change' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('The presidency or the selected account has changed')
  expect(select).toHaveValue('2')
  expect(screen.getByRole('button', { name: 'Confirm change' })).toBeDisabled()
  await user.selectOptions(select, '')
  expect(screen.getByRole('button', { name: 'Confirm change' })).toBeDisabled()
  await user.click(screen.getByRole('button', { name: 'Cancel' }))
  failure = ''
  await user.click(button)
  await user.selectOptions(screen.getByRole('combobox', { name: 'New president' }), '2')
  await user.click(screen.getByRole('button', { name: 'Confirm change' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(writes).toEqual([{ user_id: 2, version: 4 }, { user_id: 2, version: 5 }])
})

test('failed saves retain the draft and do not display a success message', async () => {
  const { user, button } = await openUsers()
  await user.click(button)
  await user.selectOptions(screen.getByRole('combobox', { name: 'New president' }), '2')
  failure = 'internal_error'
  await user.click(screen.getByRole('button', { name: 'Confirm change' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('The operation could not be completed')
  expect(screen.getByRole('combobox', { name: 'New president' })).toHaveValue('2')
  expect(screen.queryByText('Presidency updated. The change is now shown in Neighbors.')).toBeNull()
  expect(saved.president?.id).toBe(1)
  failure = ''
  await user.click(screen.getByRole('button', { name: 'Confirm change' }))
  await waitFor(() => expect(saved.president?.id).toBe(2))
})

test('a read failure is explicit and blocks destructive actions until the holder is known', async () => {
  readFailure = true
  const { user, button, card } = await openUsers()
  expect(await within(card).findByRole('alert')).toBeVisible()
  expect(card).not.toHaveTextContent('Unassigned')
  expect(button).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Deactivate user alice@example.org' })).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Delete user alice@example.org' })).toBeDisabled()
  readFailure = false
  await user.click(screen.getByRole('button', { name: 'Retry loading the presidency' }))
  await waitFor(() => expect(button).toBeEnabled())
  expect(card).toHaveTextContent('Alice')
})

test.each(['Deactivate', 'Delete', 'Edit'])('%s warns when the change will vacate the presidency', async operation => {
  const { user } = await openUsers()
  await user.click(screen.getByRole('button', { name: `${operation} user alice@example.org` }))
  const dialog = screen.getByRole('dialog')
  if (operation === 'Edit') {
    expect(within(dialog).queryByText(/This person holds the presidency/)).toBeNull()
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Email' }), { target: { value: 'changed@example.org' } })
  }
  expect(within(dialog).getByText(/This person holds the presidency/)).toHaveTextContent('unassigned')
  await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
  expect(writes).toEqual([])
})
