import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest'
import { ApiError, api, cache } from './api/client'
import type { ContactEventOut, ContactOut, ContactTagOut } from './api/schema.gen'
import { ContactsPage, rebaseContactDraft, tagTextColor, validateContactDraft } from './contacts'
import { appendContactTag, normalizeTagName, paletteColor } from './contact-tags'
import { I18nRoot, setLanguage, translate } from './i18n'

vi.mock('./api/client', async original => {
  const actual = await original<typeof import('./api/client')>()
  return { ...actual, api: vi.fn() }
})

const label: ContactTagOut = { id: 1, name: 'Lift', color: '#21639f', version: 1 }
const contact: ContactOut = {
  id: 1, name: 'Technical service', company: 'Lift company', email: 'support+home@example.org',
  phone: '+442079460123', notes: 'Afternoons only', tags: [label], version: 1,
  created_at: '2026-10-11T08:00:00Z', updated_at: '2026-10-11T08:00:00Z',
  deleted_at: null,
}
let records: ContactOut[], removed: ContactOut[], tags: ContactTagOut[], events: ContactEventOut[]
const defaults = cache.getDefaultOptions()
const originalShow = HTMLDialogElement.prototype.showModal
const originalClose = HTMLDialogElement.prototype.close
const originalScroll = HTMLElement.prototype.scrollIntoView
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', '') }
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open') }
  HTMLElement.prototype.scrollIntoView = function () {}
})
afterAll(() => {
  HTMLDialogElement.prototype.showModal = originalShow
  HTMLDialogElement.prototype.close = originalClose
  HTMLElement.prototype.scrollIntoView = originalScroll
})
beforeEach(() => {
  cache.clear()
  cache.setDefaultOptions({ queries: { retry: false }, mutations: { retry: false } })
  records = [contact]; removed = []; tags = [label]; events = []
  vi.mocked(api).mockImplementation(async (url, method = 'GET') => {
    if (url.startsWith('/contact-history')) return { items: events, total: events.length, page: 1, pages: 1 }
    if (url === '/contact-tags') return tags
    if (url === '/contacts/1') {
      if (method === 'DELETE') { records = []; return undefined }
      return contact
    }
    if (url === '/contacts' && method === 'POST') return contact
    if (url.startsWith('/admin/contacts/deleted?')) return { items: removed, total: removed.length, page: 1, pages: 1 }
    if (url.startsWith('/contacts?')) return { items: records, total: records.length, page: 1, pages: 1 }
    throw new Error(`Unexpected API request: ${method} ${url}`)
  })
})
afterEach(() => { cleanup(); cache.clear(); cache.setDefaultOptions(defaults); vi.restoreAllMocks() })

function page(route = '/contacts', deleted = false) {
  render(<I18nRoot><QueryClientProvider client={cache}><MemoryRouter initialEntries={[route]}>
    <ContactsPage deleted={deleted} />
  </MemoryRouter></QueryClientProvider></I18nRoot>)
}
async function table() { return within(await screen.findByRole('table', { name: 'Community contacts' })) }
async function contactAction(user: ReturnType<typeof userEvent.setup>, action: 'Edit' | 'History' | 'Delete') {
  await user.click((await table()).getByRole('button', { name: 'Actions for Technical service' }))
  await user.click(screen.getByRole('menuitem', { name: action }))
}

test('renders contact channels and requests search and sorting with pagination reset', async () => {
  const user = userEvent.setup()
  page('/contacts?page=2')
  const list = await table()
  expect(list.getByRole('link', { name: /^Email / })).toHaveAttribute('href', 'mailto:support%2Bhome%40example.org')
  expect(list.getByRole('link', { name: /^Call / })).toHaveAttribute('href', 'tel:+442079460123')
  await user.click(list.getByRole('button', { name: /^Copy / }))
  await waitFor(() => expect(list.getByRole('status')).toHaveTextContent('Email copied'))
  await user.click(within((await table()).getByRole('columnheader', { name: /Email/ })).getByRole('button'))
  await user.click(within((await table()).getByRole('columnheader', { name: /Email/ })).getByRole('button'))
  await user.type(screen.getByLabelText('Search contacts'), 'lift')
  await waitFor(() => expect(api).toHaveBeenCalledWith('/contacts?q=lift&sort=email&direction=desc&page=1'))
  expect((await table()).getByRole('columnheader', { name: /Email/ })).toHaveAttribute('aria-sort', 'descending')
  expect(screen.getByText('1 contact')).toBeInTheDocument()
})

test('requires a channel and sends the complete contact form without an author', async () => {
  const user = userEvent.setup()
  page()
  await table()
  await user.click(screen.getByRole('button', { name: 'New contact' }))
  const dialog = within(screen.getByRole('dialog', { name: 'New contact' }))
  await user.type(dialog.getByRole('textbox', { name: 'Name' }), 'Accountant')
  await user.click(dialog.getByRole('button', { name: 'Save contact' }))
  expect((await dialog.findAllByRole('alert')).every(element => element.textContent?.includes('at least an email address'))).toBe(true)
  expect(dialog.getByRole('textbox', { name: 'Email' })).toHaveAttribute('aria-invalid', 'true')
  expect(dialog.getByRole('textbox', { name: 'Contact phone' })).toHaveAttribute('aria-invalid', 'true')
  await user.type(dialog.getByRole('textbox', { name: 'Email' }), 'accountant@example.org')
  await user.click(dialog.getByRole('combobox', { name: 'Tags' }))
  await user.click(dialog.getByRole('option', { name: 'Lift' }))
  await user.click(dialog.getByRole('button', { name: 'Save contact' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(api).toHaveBeenCalledWith('/contacts', 'POST', {
    name: 'Accountant', company: '', email: 'accountant@example.org', phone: '', notes: '', tags: [1],
  })
})

test('a conflict keeps the draft and requires an explicit current-version reload', async () => {
  const user = userEvent.setup()
  const original = vi.mocked(api).getMockImplementation()!
  let writes = 0
  vi.mocked(api).mockImplementation(async (url, method, body) => {
    if (url === '/contacts/1' && method === 'PATCH' && writes++ === 0) throw new ApiError('contact_stale', 409)
    if (url === '/contacts/1' && method === undefined) return { ...contact, notes: 'New shared note', version: 2 }
    return original(url, method, body)
  })
  page()
  await contactAction(user, 'Edit')
  const dialog = within(screen.getByRole('dialog', { name: 'Edit contact' }))
  await user.clear(dialog.getByRole('textbox', { name: 'Name' }))
  await user.type(dialog.getByRole('textbox', { name: 'Name' }), 'My draft')
  await user.click(dialog.getByRole('button', { name: 'Save contact' }))
  expect(await dialog.findByRole('alert')).toHaveTextContent('Someone else has changed this data')
  expect(dialog.getByRole('textbox', { name: 'Name' })).toHaveValue('My draft')
  expect(dialog.getByRole('button', { name: 'Save contact' })).toBeDisabled()
  await user.click(dialog.getByRole('button', { name: 'Check the current version without losing my draft' }))
  await waitFor(() => expect(dialog.getByLabelText('Notes')).toHaveValue('New shared note'))
  expect(dialog.getByText('Current saved version: Technical service')).toBeInTheDocument()
  await user.click(dialog.getByRole('button', { name: 'Save contact' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(api).toHaveBeenCalledWith(expect.stringMatching(/^\/contacts\?/))
  expect(api).toHaveBeenCalledWith('/contacts/1', 'PATCH', expect.objectContaining({ name: 'My draft', version: 2 }))
})

test('deletion requires confirmation and cancellation makes no delete request', async () => {
  const user = userEvent.setup()
  page()
  await contactAction(user, 'Delete')
  let dialog = within(screen.getByRole('dialog', { name: 'Delete contact' }))
  expect(dialog.getByText(/It cannot be restored/)).toBeInTheDocument()
  expect(dialog.getByText('Technical service', { selector: 'strong' })).toBeInTheDocument()
  await user.click(dialog.getByRole('button', { name: 'Cancel' }))
  expect(vi.mocked(api).mock.calls.some(([, method]) => method === 'DELETE')).toBe(false)
  await contactAction(user, 'Delete')
  dialog = within(screen.getByRole('dialog', { name: 'Delete contact' }))
  await user.click(dialog.getByRole('button', { name: 'Delete contact' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(api).toHaveBeenCalledWith('/contacts/1', 'DELETE', { version: 1 })
  expect(await screen.findByText('There are no contacts yet. Create the first one.')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'New contact' })).toHaveFocus()
})

test('administration lists removed contacts with their individual retained history', async () => {
  const user = userEvent.setup()
  events = [{
    id: 1, target: 'contact', target_id: 1, name: contact.name, kind: 'deleted',
    author: { kind: 'resident', user_id: 7, name: 'Historic name' },
    created_at: contact.created_at,
    before: {
      name: contact.name, company: contact.company, email: contact.email, phone: contact.phone,
      notes: contact.notes, tags: [label],
    }, after: null,
  }]
  records = []
  removed = [{ ...contact, deleted_at: contact.updated_at }]
  page('/admin/deleted-contacts', true)
  await table()
  expect(screen.getByRole('heading', { name: 'Deleted contacts' })).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'New contact' })).toBeNull()
  expect(screen.getByRole('link', { name: 'Go to the community address book' })).toHaveAttribute('href', '/contacts')
  await user.click((await table()).getByRole('button', { name: 'Actions for Technical service' }))
  expect(screen.getAllByRole('menuitem')).toHaveLength(1)
  await user.click(screen.getByRole('menuitem', { name: 'History' }))
  const dialog = within(screen.getByRole('dialog', { name: 'History of Technical service' }))
  expect(await dialog.findByText('Historic name')).toBeInTheDocument()
  expect(dialog.getByText('Deleted · Technical service')).toBeInTheDocument()
  expect(dialog.getByText('Lift')).toHaveStyle({ backgroundColor: '#21639f', color: '#ffffff' })
  expect(dialog.queryByRole('button', { name: /general history/i })).toBeNull()
  await waitFor(() => expect(api).toHaveBeenCalledWith('/contact-history?page=1&contact_id=1'))
})

test('the history names each change, its target and the administrator in the reader language', async () => {
  const user = userEvent.setup()
  events = [{
    id: 2, target: 'tag', target_id: 2, name: 'Emergencies', kind: 'updated',
    // Whatever name arrives for an administrator author (here a login), the UI must never show it.
    author: { kind: 'administrator', user_id: null, name: 'ops-admin' },
    created_at: contact.updated_at,
    before: { name: 'Urgent', color: '#000000' }, after: { name: 'Emergencies', color: '#21639f' },
  }, {
    id: 1, target: 'contact', target_id: 1, name: contact.name, kind: 'created',
    author: { kind: 'resident', user_id: 7, name: 'Alex Morgan' },
    created_at: contact.created_at, before: null,
    after: { name: contact.name, company: contact.company, email: null, phone: contact.phone, notes: '', tags: [] },
  }]
  page()
  await contactAction(user, 'History')
  const history = screen.getByRole('dialog', { name: 'History of Technical service' })
  const dialog = within(history)
  const [tagEvent, contactEvent] = (await dialog.findAllByRole('listitem')).map(item => within(item))
  expect(tagEvent.getByText('Edited · Tag: Emergencies')).toBeInTheDocument()
  expect(tagEvent.getByText('Technical administrator')).toBeInTheDocument()
  const tagChanges = within(tagEvent.getByRole('table', { name: 'Changes to Emergencies' }))
  expect(tagChanges.getAllByRole('columnheader').map(header => header.textContent)).toEqual(['Field', 'Before', 'After'])
  expect(tagChanges.getAllByRole('rowheader').map(header => header.textContent)).toEqual(['Name', 'Color'])
  expect(contactEvent.getByText('Created · Technical service')).toBeInTheDocument()
  expect(contactEvent.getByText('Alex Morgan')).toBeInTheDocument()
  const contactChanges = within(contactEvent.getByRole('table', { name: 'Changes to Technical service' }))
  expect(contactChanges.getAllByRole('rowheader').map(header => header.textContent)).toEqual([
    'Name', 'Company / service', 'Email', 'Phone', 'Notes', 'Tags',
  ])
  expect(contactChanges.getAllByText('Not provided')).toHaveLength(8)
  expect(contactChanges.getByText('No tags')).toBeInTheDocument()
  expect(history).not.toHaveTextContent('ops-admin')
  act(() => setLanguage('es'))
  expect(tagEvent.getByText(translate('es', 'common.technicalAdministrator'))).toBeInTheDocument()
  expect(tagEvent.queryByText('Technical administrator')).toBeNull()
  expect(contactEvent.getByText('Alex Morgan')).toBeInTheDocument()
  expect(history).not.toHaveTextContent('ops-admin')
})

test('inline tags autocomplete, preview palette colors and persist only with the contact', async () => {
  const user = userEvent.setup()
  page()
  await table()
  await user.click(screen.getByRole('button', { name: 'New contact' }))
  const form = within(screen.getByRole('dialog', { name: 'New contact' }))
  await user.type(form.getByRole('textbox', { name: 'Name' }), 'Service')
  await user.type(form.getByRole('textbox', { name: 'Email' }), 'service@example.org')
  const input = form.getByRole('combobox', { name: 'Tags' })
  await user.type(input, 'f')
  expect(form.getByLabelText('Tag preview')).toHaveStyle({ backgroundColor: '#c6c102' })
  await user.type(input, 'a')
  expect(form.getByLabelText('Tag preview')).toHaveStyle({ backgroundColor: '#d77089' })
  await user.type(input, 'm')
  expect(form.getByLabelText('Tag preview')).toHaveStyle({ backgroundColor: '#2bccb4' })
  await user.keyboard('{Enter}')
  expect(form.getByRole('button', { name: 'Remove fam' })).toBeInTheDocument()
  await user.type(input, 'LIF')
  expect(form.getByRole('option', { name: 'Lift' })).toBeInTheDocument()
  await user.keyboard('{ArrowDown}{Enter}')
  expect(form.getByRole('button', { name: 'Remove Lift' })).toBeInTheDocument()
  await user.keyboard('{Backspace}')
  expect(form.queryByRole('button', { name: 'Remove Lift' })).toBeNull()
  await user.type(input, 'ift')
  await user.click(form.getByRole('option', { name: 'Lift' }))
  expect(input).toHaveValue('')
  expect(vi.mocked(api).mock.calls.some(([, method]) => method === 'POST')).toBe(false)
  expect(screen.getAllByRole('dialog')).toHaveLength(1)
  await user.click(form.getByRole('button', { name: 'Save contact' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(api).toHaveBeenCalledWith('/contacts', 'POST', expect.objectContaining({
    tags: [1], new_tags: [{ name: 'fam', color: '#2bccb4' }],
  }))
})

test('contact suggestions preserve the most-used ordering supplied by the catalog', async () => {
  tags = [{ id: 2, name: 'Emergencies', color: '#21639f', version: 1 }, label]
  const user = userEvent.setup()
  page()
  await table()
  await user.click(screen.getByRole('button', { name: 'New contact' }))
  const form = within(screen.getByRole('dialog', { name: 'New contact' }))
  await user.click(form.getByRole('combobox', { name: 'Tags' }))
  expect(form.getAllByRole('option').map(option => option.textContent)).toEqual(['Emergencies', 'Lift'])
})

test('failed reads report the failure instead of rendering an empty success state', async () => {
  vi.mocked(api).mockRejectedValue(new ApiError('internal_error', 500))
  page()
  expect(await screen.findByRole('alert')).toHaveTextContent('The operation could not be completed')
  expect(screen.queryByText(/There are no contacts yet/)).toBeNull()
})

test('reconciliation preserves edited channels and incorporates untouched fields', () => {
  const draft = { name: contact.name, company: contact.company, email: 'mine@example.org', phone: contact.phone, notes: contact.notes, tags: [label] }
  expect(rebaseContactDraft(draft, contact, { ...contact, name: 'New name', email: 'theirs@example.org', tags: [], version: 2 })).toEqual({
    ...draft, name: 'New name', tags: [],
  })
})

test('colored tags choose a legible foreground across light and dark backgrounds', () => {
  expect(tagTextColor('#ffffff')).toBe('#000000')
  expect(tagTextColor('#000000')).toBe('#ffffff')
  expect(tagTextColor('#21639f')).toBe('#ffffff')
  expect(tagTextColor('#ffff00')).toBe('#000000')
})

test('required fields have markers, no explanatory comments, and field-specific validation errors', async () => {
  const user = userEvent.setup()
  page()
  await table()
  await user.click(screen.getByRole('button', { name: 'New contact' }))
  const form = within(screen.getByRole('dialog', { name: 'New contact' }))
  const name = form.getByRole('textbox', { name: 'Name' })
  const email = form.getByRole('textbox', { name: 'Email' })
  const phone = form.getByRole('textbox', { name: 'Contact phone' })
  expect(name).toBeRequired()
  expect(email).toBeRequired()
  expect(phone).toBeRequired()
  expect(form.getAllByText('*')).toHaveLength(3)
  expect(form.queryByText(/Visible to the whole community/)).toBeNull()
  expect(form.queryByText(/Optional\. 7 to 15 digits/)).toBeNull()
  await user.click(form.getByRole('button', { name: 'Save contact' }))
  expect(name).toHaveAttribute('aria-invalid', 'true')
  expect(name).toHaveFocus()
  await user.type(name, 'Service')
  await user.type(email, 'invalid-email')
  await user.type(phone, '12abc')
  await user.click(form.getByRole('button', { name: 'Save contact' }))
  expect(email).toHaveAttribute('aria-invalid', 'true')
  expect(phone).toHaveAttribute('aria-invalid', 'true')
  expect(form.getByText(/Enter a valid email address/)).toHaveAttribute('role', 'alert')
  expect(form.getByText(/Enter 7 to 15 digits/)).toHaveAttribute('role', 'alert')
  expect(vi.mocked(api).mock.calls.some(([, method]) => method === 'POST')).toBe(false)
})

test('server field validation keeps the draft and marks the specific field', async () => {
  const user = userEvent.setup()
  const original = vi.mocked(api).getMockImplementation()!
  vi.mocked(api).mockImplementation(async (url, method, body) => {
    if (url === '/contacts/1' && method === 'PATCH') throw new ApiError('invalid_request', 422, { email: 'contact_email_invalid' })
    return original(url, method, body)
  })
  page()
  await contactAction(user, 'Edit')
  const form = within(screen.getByRole('dialog', { name: 'Edit contact' }))
  await user.click(form.getByRole('button', { name: 'Save contact' }))
  expect(await form.findByText(/Enter a valid email address/)).toHaveAttribute('role', 'alert')
  const email = form.getByRole('textbox', { name: 'Email' })
  expect(email).toHaveAttribute('aria-invalid', 'true')
  expect(email).toHaveValue(contact.email)
  await waitFor(() => expect(email).toHaveFocus())
  expect(form.getByRole('textbox', { name: 'Name' })).not.toHaveAttribute('aria-invalid')
})

test('the row menu supports keyboard navigation and the name opens a contact modal', async () => {
  const user = userEvent.setup()
  page()
  const list = await table()
  expect(list.queryByRole('button', { name: /^Edit/ })).toBeNull()
  const trigger = list.getByRole('button', { name: 'Actions for Technical service' })
  await user.click(trigger)
  expect(screen.getByRole('menu', { name: 'Actions for Technical service' })).toBeInTheDocument()
  expect(screen.getByRole('menuitem', { name: 'Edit' })).toHaveFocus()
  fireEvent.scroll(window)
  expect(screen.getByRole('menu')).toBeInTheDocument()
  await user.keyboard('{ArrowDown}')
  expect(screen.getByRole('menuitem', { name: 'History' })).toHaveFocus()
  await user.keyboard('{Escape}')
  expect(screen.queryByRole('menu')).toBeNull()
  expect(trigger).toHaveFocus()
  const name = list.getByRole('button', { name: 'View details for Technical service' })
  expect(list.queryByText(contact.notes)).toBeNull()
  await user.click(name)
  const details = within(screen.getByRole('dialog', { name: contact.name }))
  expect(details.getByText(contact.notes)).toBeVisible()
  expect(details.getByText(contact.company)).toBeInTheDocument()
  const mail = details.getByRole('link', { name: 'Email Technical service' })
  const phone = details.getByRole('link', { name: 'Call Technical service' })
  expect(mail).toHaveAttribute('href', 'mailto:support%2Bhome%40example.org')
  expect(phone).toHaveAttribute('href', 'tel:+442079460123')
  expect(mail.querySelector('svg')).toHaveAttribute('aria-hidden', 'true')
  expect(phone.querySelector('svg')).toHaveAttribute('aria-hidden', 'true')
  await user.click(details.getByRole('button', { name: 'Close' }))
  expect(name).toHaveFocus()
  expect(screen.queryByText('Details')).toBeNull()
})

test('unfinished tags are added on blur and cancelling never writes them to the catalog', async () => {
  const user = userEvent.setup()
  page()
  await table()
  await user.click(screen.getByRole('button', { name: 'New contact' }))
  const form = within(screen.getByRole('dialog', { name: 'New contact' }))
  await user.type(form.getByRole('combobox', { name: 'Tags' }), 'Emergencies')
  await user.click(form.getByRole('textbox', { name: 'Name' }))
  expect(form.getByRole('button', { name: 'Remove emergencies' })).toBeInTheDocument()
  await user.click(form.getByRole('button', { name: 'Cancel' }))
  expect(vi.mocked(api).mock.calls.some(([, method]) => method === 'POST' || method === 'PATCH')).toBe(false)
})

test('the reader has no redundant controls or access to the deleted directory toggle', async () => {
  page('/contacts?deleted=1')
  await table()
  expect(screen.queryByRole('button', { name: 'Manage tags' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'General history' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'View deleted contacts' })).toBeNull()
  expect(screen.queryByLabelText('Sort by')).toBeNull()
  expect(screen.queryByLabelText('Direction')).toBeNull()
  expect(screen.queryByText(/All users can create/)).toBeNull()
  expect(vi.mocked(api).mock.calls.some(([path]) => path.startsWith('/admin/contacts'))).toBe(false)
})

test.each(['email', 'phone'] as const)('missing %s disables only the corresponding detail action', async channel => {
  const user = userEvent.setup()
  records = [{ ...contact, [channel]: channel === 'email' ? null : '' }]
  page()
  await user.click((await table()).getByRole('button', { name: 'View details for Technical service' }))
  const details = within(screen.getByRole('dialog', { name: contact.name }))
  expect(details.getByRole('button', { name: channel === 'email' ? 'Email unavailable' : 'Phone unavailable' })).toBeDisabled()
  expect(details.getAllByRole('link')).toHaveLength(1)
})

test('the tag palette is deterministic and existing tag colors are not overwritten', () => {
  expect(['f', 'fa', 'fam', 'fami', 'famil', 'family'].map(paletteColor)).toEqual([
    '#c6c102', '#d77089', '#2bccb4', '#4963de', '#47a4b4', '#bd9670',
  ])
  expect(paletteColor(normalizeTagName(' FrIeNdS '))).toBe('#896385')
  expect(appendContactTag([], ' LIFT ', [label]).tags).toEqual([{ id: 1, name: 'Lift', color: '#21639f' }])
  expect(appendContactTag([label], 'lift', [label]).tags).toHaveLength(1)
  expect(appendContactTag([], '\ufdfa'.repeat(100), []).error).toBe('Enter a valid tag of up to 100 characters.')
  expect(validateContactDraft({ name: 'Ok', company: '', email: '', phone: '+44 20 7946 0123', tags: [], notes: '' })).toEqual({})
})

test('the address book renders in Spanish, formats counts and follows a language switch', async () => {
  const user = userEvent.setup()
  const original = vi.mocked(api).getMockImplementation()!
  vi.mocked(api).mockImplementation(async (url, method, body) => url.startsWith('/contacts?')
    ? { items: records, total: 12345, page: 1, pages: 1 } : original(url, method, body))
  setLanguage('es')
  page()
  const list = within(await screen.findByRole('table', { name: 'Contactos de la comunidad' }))
  expect(screen.getByRole('heading', { name: 'Contactos' })).toBeInTheDocument()
  expect(screen.getByText('12.345 contactos')).toBeInTheDocument()
  expect(screen.getByLabelText('Buscar contactos')).toBeInTheDocument()
  expect(list.getByRole('columnheader', { name: 'Correo' })).toBeInTheDocument()
  expect(list.getByRole('button', { name: 'Ver detalles de Technical service' })).toBeInTheDocument()
  await user.click(list.getByRole('button', { name: 'Acciones de Technical service' }))
  expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual(['Editar', 'Historial', 'Eliminar'])
  await user.keyboard('{Escape}')
  await user.click(screen.getByRole('button', { name: 'Nuevo contacto' }))
  const form = within(screen.getByRole('dialog', { name: 'Nuevo contacto' }))
  expect(form.getByRole('combobox', { name: 'Etiquetas' })).toBeInTheDocument()
  await user.click(form.getByRole('button', { name: 'Guardar contacto' }))
  expect(form.getByRole('textbox', { name: 'Nombre' })).toHaveAccessibleDescription(/hasta 150 caracteres/)
  expect(form.getByRole('button', { name: 'Cancelar' })).toBeEnabled()

  act(() => setLanguage('en'))
  expect(screen.getByRole('dialog', { name: 'New contact' })).toBeInTheDocument()
  expect(form.getByRole('button', { name: 'Save contact' })).toBeInTheDocument()
  expect(screen.getByRole('heading', { name: 'Contacts' })).toBeInTheDocument()
  expect(screen.getByText('12,345 contacts')).toBeInTheDocument()
})

test('the deleted contacts archive renders in Spanish', async () => {
  setLanguage('es')
  page('/admin/deleted-contacts', true)
  expect(await screen.findByText('No hay contactos eliminados.')).toBeInTheDocument()
  expect(screen.getByRole('heading', { name: 'Contactos eliminados' })).toBeInTheDocument()
  expect(screen.getByRole('link', { name: 'Ir a la agenda de la comunidad' })).toHaveAttribute('href', '/contacts')
  expect(screen.getByText('0 contactos')).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Nuevo contacto' })).toBeNull()
})
