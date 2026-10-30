import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest'
import { cache } from './api/client'
import type { ActionLabelOut, ContactTagOut } from './api/schema.gen'
import { CommunityLabelsPage } from './community-labels'
import { paletteColor } from './contact-tags'
import { I18nRoot, setLanguage } from './i18n'

const defaults = cache.getDefaultOptions()
const originalShow = HTMLDialogElement.prototype.showModal
const originalClose = HTMLDialogElement.prototype.close
let actionLabels: ActionLabelOut[], contactTags: ContactTagOut[]
const writes: { path: string; body: unknown }[] = []
// Each catalog has its own wording: action labels and contact tags.
const wording = {
  actions: { region: 'Action labels', editor: 'Edit label: Doors', save: 'Save label', preview: 'Label preview' },
  contacts: { region: 'Contact tags', editor: 'Edit tag: Doors', save: 'Save tag', preview: 'Tag preview' },
} as const

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', '') }
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open') }
})
afterAll(() => {
  HTMLDialogElement.prototype.showModal = originalShow
  HTMLDialogElement.prototype.close = originalClose
})
beforeEach(() => {
  cache.clear()
  cache.setDefaultOptions({ queries: { retry: false, staleTime: Infinity } })
  actionLabels = [{ id: 1, name: 'Doors', color: null, version: 1 }]
  contactTags = [{ id: 1, name: 'Doors', color: '#abcdef', version: 1 }]
  writes.length = 0
  vi.stubGlobal('fetch', vi.fn(respond))
})
afterEach(() => {
  cleanup(); cache.clear(); cache.setDefaultOptions(defaults); vi.restoreAllMocks(); vi.unstubAllGlobals()
})

function reply(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status })
}

async function respond(input: string, options: RequestInit) {
  const url = new URL(input, 'http://localhost')
  const action = url.pathname.startsWith('/api/admin/action-labels')
  const labels = action ? actionLabels : contactTags
  if (options.method === 'PATCH') {
    const body: { name: string; color: string; version: number } = JSON.parse(String(options.body))
    writes.push({ path: url.pathname, body })
    const index = labels.findIndex(label => url.pathname.endsWith(`/${label.id}`))
    if (index < 0) return reply({ code: 'action_label_not_found' }, 404)
    if (labels[index].version !== body.version) {
      return reply({ code: action ? 'action_label_stale' : 'contact_stale' }, 409)
    }
    const updated = { ...labels[index], name: body.name.trim(), color: body.color, version: body.version + 1 }
    labels.splice(index, 1, updated)
    return reply(updated)
  }
  if (/\/\d+$/.test(url.pathname)) return reply(labels.find(label => url.pathname.endsWith(`/${label.id}`)))
  const q = url.searchParams.get('q')?.toLowerCase() || ''
  const selected = labels.filter(label => label.name.toLowerCase().includes(q))
  const page = Number(url.searchParams.get('page') || '1'), size = action ? 20 : 50
  return reply({
    items: selected.slice((page - 1) * size, page * size),
    total: selected.length, page, pages: Math.max(1, Math.ceil(selected.length / size)),
  })
}

function page() { return render(<I18nRoot><QueryClientProvider client={cache}><CommunityLabelsPage /></QueryClientProvider></I18nRoot>) }
async function openEditor(kind: 'actions' | 'contacts') {
  const section = within(screen.getByRole('region', { name: wording[kind].region }))
  fireEvent.click(await section.findByRole('button', { name: 'Edit Doors' }))
  return within(screen.getByRole('dialog', { name: wording[kind].editor }))
}

test('catalogs are independent and remain available when the actions feature is disabled', async () => {
  cache.setQueryData(['features'], { actions: false, coefficient: true, events: false, google_login: false })
  page()
  expect(screen.getByRole('heading', { name: 'Community labels' })).toBeInTheDocument()
  const actions = within(screen.getByRole('region', { name: 'Action labels' }))
  const contacts = within(screen.getByRole('region', { name: 'Contact tags' }))
  expect(await actions.findByText('Doors')).toHaveStyle({ backgroundColor: paletteColor('Doors') })
  expect(await contacts.findByText('Doors')).toHaveStyle({ backgroundColor: '#abcdef' })
  expect(actions.getByText('1 label')).toBeInTheDocument()
  expect(contacts.getByText('1 tag')).toBeInTheDocument()
  expect(actions.getByRole('list', { name: 'Action labels' })).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: /create|delete/i })).toBeNull()
  expect(fetch).toHaveBeenCalledWith('/api/admin/action-labels?q=&page=1', expect.anything())
  expect(fetch).toHaveBeenCalledWith('/api/admin/contact-tags?q=&page=1', expect.anything())
})

test('returning to administration reloads labels created in the community portal', async () => {
  const view = page()
  await screen.findAllByText('Doors')
  view.unmount()
  actionLabels.push({ id: 2, name: 'New action label', color: null, version: 1 })
  contactTags.push({ id: 2, name: 'New contact tag', color: '#123456', version: 1 })
  page()
  expect(await screen.findByText('New action label')).toBeVisible()
  expect(await screen.findByText('New contact tag')).toBeVisible()
})

test.each(['actions', 'contacts'] as const)('saves names and colors by identity and invalidates only the relevant catalog (%s)', async kind => {
  cache.setQueryData([kind, 'existing'], { cached: true })
  const other = kind === 'actions' ? 'contacts' : 'actions'
  cache.setQueryData([other, 'existing'], { cached: true })
  page()
  const dialog = await openEditor(kind)
  const original = kind === 'actions' ? paletteColor('Doors') : '#abcdef'
  fireEvent.change(dialog.getByLabelText(/Name/), { target: { value: 'Access' } })
  expect(dialog.getByLabelText(wording[kind].preview)).toHaveStyle({ backgroundColor: original })
  fireEvent.change(dialog.getByLabelText('Color'), { target: { value: '#123456' } })
  expect(dialog.getByLabelText(wording[kind].preview)).toHaveStyle({ backgroundColor: '#123456' })
  expect(dialog.queryByLabelText(wording[kind === 'actions' ? 'contacts' : 'actions'].preview)).toBeNull()
  fireEvent.click(dialog.getByRole('button', { name: wording[kind].save }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(writes).toEqual([{
    path: kind === 'actions' ? '/api/admin/action-labels/1' : '/api/admin/contact-tags/1',
    body: { name: 'Access', color: '#123456', version: 1 },
  }])
  expect(screen.getByText(kind === 'actions' ? 'Label “Access” saved.' : 'Tag “Access” saved.')).toBeVisible()
  expect(screen.getByText('Access')).toHaveStyle({ backgroundColor: '#123456' })
  expect(cache.getQueryState([kind, 'existing'])?.isInvalidated).toBe(true)
  expect(cache.getQueryState([other, 'existing'])?.isInvalidated).toBe(false)
  expect(screen.getByText('Doors')).toBeVisible()
})

test('blank or oversized names are rejected locally and cancellation never writes', async () => {
  page()
  const dialog = await openEditor('actions')
  for (const name of [' ', 'a'.repeat(101), '\ufdfa'.repeat(100)]) {
    fireEvent.change(dialog.getByLabelText(/Name/), { target: { value: name } })
    fireEvent.click(dialog.getByRole('button', { name: 'Save label' }))
    expect(await dialog.findByRole('alert')).toHaveTextContent('up to 100 characters')
    expect(dialog.getByLabelText(/Name/)).toHaveAttribute('aria-invalid', 'true')
    expect(dialog.getByLabelText(/Name/)).toHaveFocus()
  }
  fireEvent.change(dialog.getByLabelText(/Name/), { target: { value: ' ' } })
  expect(dialog.getByLabelText('Label preview')).toHaveTextContent('Label')
  expect(writes).toHaveLength(0)
  fireEvent.click(dialog.getByRole('button', { name: 'Cancel' }))
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(writes).toHaveLength(0)
})

test.each(['actions', 'contacts'] as const)('stale writes keep the draft until the current version is explicitly reconciled (%s)', async kind => {
  page()
  const dialog = await openEditor(kind)
  fireEvent.change(dialog.getByLabelText(/Name/), { target: { value: 'My draft' } })
  const current = { id: 1, name: 'Other name', color: '#fedcba', version: 2 }
  if (kind === 'actions') actionLabels = [current]
  else contactTags = [current]
  fireEvent.click(dialog.getByRole('button', { name: wording[kind].save }))
  expect(await dialog.findByRole('alert')).toHaveTextContent('Someone else has changed')
  expect(dialog.getByText(kind === 'actions'
    ? 'Your draft is kept. Check the saved label before saving again.'
    : 'Your draft is kept. Check the saved tag before saving again.')).toBeInTheDocument()
  expect(dialog.getByLabelText(/Name/)).toHaveValue('My draft')
  expect(dialog.getByRole('button', { name: wording[kind].save })).toBeDisabled()
  fireEvent.click(dialog.getByRole('button', { name: 'Check the current version' }))
  await dialog.findByRole('heading', { name: 'Current version' })
  expect(dialog.getByRole('region', { name: kind === 'actions' ? 'Current version of the label' : 'Current version of the tag' }))
    .toHaveTextContent('Other name')
  expect(dialog.getByLabelText(/Name/)).toHaveValue('My draft')
  expect(writes).toHaveLength(1)
  fireEvent.click(dialog.getByRole('button', { name: 'Update the base and keep my draft' }))
  expect(dialog.getByLabelText(/Name/)).toHaveValue('My draft')
  expect(dialog.getByLabelText('Color')).toHaveValue('#fedcba')
  fireEvent.click(dialog.getByRole('button', { name: wording[kind].save }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(writes[1].body).toEqual({ name: 'My draft', color: '#fedcba', version: 2 })
})

test.each([
  { code: 'action_label_exists', status: 409, fields: { name: 'action_label_exists' } },
  { code: 'internal_error', status: 500, fields: {} },
])('failed saves preserve the draft and never show success ($code)', async failure => {
  vi.stubGlobal('fetch', vi.fn((input: string, options: RequestInit) => options.method === 'PATCH'
    ? Promise.resolve(reply(failure, failure.status)) : respond(input, options)))
  page()
  const dialog = await openEditor('actions')
  fireEvent.change(dialog.getByLabelText(/Name/), { target: { value: 'My name' } })
  fireEvent.change(dialog.getByLabelText('Color'), { target: { value: '#123456' } })
  fireEvent.click(dialog.getByRole('button', { name: 'Save label' }))
  await dialog.findByRole('alert')
  expect(dialog.getByLabelText(/Name/)).toHaveValue('My name')
  expect(dialog.getByLabelText('Color')).toHaveValue('#123456')
  expect(dialog.getByRole('button', { name: 'Save label' })).toBeEnabled()
  expect(screen.queryByText(/saved\.$/)).toBeNull()
})

test('catalog pagination and searching reset independently and expose an empty result', async () => {
  actionLabels = Array.from({ length: 21 }, (_, index) => ({
    id: index + 1, name: `Label ${String(index).padStart(2, '0')}`, color: null, version: 1,
  }))
  page()
  const section = within(screen.getByRole('region', { name: 'Action labels' }))
  fireEvent.click(await section.findByRole('button', { name: 'Next: Action labels' }))
  expect(await section.findByText('Label 20')).toBeVisible()
  expect(section.queryByText('Label 00')).toBeNull()
  expect(section.getByText('21 labels')).toBeInTheDocument()
  fireEvent.change(section.getByLabelText('Search action labels'), { target: { value: 'Label 00' } })
  expect(await section.findByText('Label 00')).toBeVisible()
  expect(section.queryByRole('navigation')).toBeNull()
  expect(fetch).toHaveBeenCalledWith('/api/admin/action-labels?q=Label+00&page=1', expect.anything())
  fireEvent.change(section.getByLabelText('Search action labels'), { target: { value: 'nonexistent' } })
  expect(await section.findByText('No labels match your search.')).toBeVisible()
  expect(screen.getByText('Doors')).toBeVisible()
})

test('a failed catalog load can be retried without hiding the other catalog', async () => {
  let fails = true
  vi.stubGlobal('fetch', vi.fn((input: string, options: RequestInit) => input.includes('action-labels') && fails
    ? Promise.resolve(reply({ code: 'internal_error' }, 500)) : respond(input, options)))
  page()
  const section = within(screen.getByRole('region', { name: 'Action labels' }))
  expect(await section.findByRole('alert')).toHaveTextContent('The operation could not be completed')
  expect(await screen.findByText('Doors')).toBeVisible()
  fails = false
  fireEvent.click(section.getByRole('button', { name: 'Retry loading' }))
  expect(await section.findByText('Doors')).toBeVisible()
  expect(section.queryByRole('alert')).toBeNull()
})

test('the page renders in Spanish and its confirmation follows a language switch', async () => {
  setLanguage('es')
  page()
  expect(screen.getByRole('heading', { name: 'Etiquetas de la comunidad' })).toBeInTheDocument()
  const actions = within(screen.getByRole('region', { name: 'Etiquetas de actuaciones' }))
  const contacts = within(screen.getByRole('region', { name: 'Etiquetas de contactos' }))
  expect(await actions.findByText('1 etiqueta')).toBeInTheDocument()
  expect(actions.getByLabelText('Buscar etiqueta de actuaciones')).toBeInTheDocument()
  expect(await contacts.findByText('1 etiqueta')).toBeInTheDocument()
  fireEvent.click(contacts.getByRole('button', { name: 'Editar Doors' }))
  const dialog = within(screen.getByRole('dialog', { name: 'Editar etiqueta: Doors' }))
  expect(dialog.getByText(/todas las fichas de contacto que usan esta etiqueta/)).toBeInTheDocument()
  expect(dialog.getByLabelText('Vista previa de etiqueta')).toHaveTextContent('Doors')
  fireEvent.change(dialog.getByLabelText(/Nombre/), { target: { value: 'Access' } })
  fireEvent.click(dialog.getByRole('button', { name: 'Guardar etiqueta' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(contacts.getByText('Etiqueta «Access» guardada.')).toBeVisible()

  act(() => setLanguage('en'))
  expect(screen.getByRole('heading', { name: 'Community labels' })).toBeInTheDocument()
  expect(screen.getByRole('region', { name: 'Contact tags' })).toBeInTheDocument()
  expect(contacts.getByText('Tag “Access” saved.')).toBeVisible()
  expect(actions.getByText('1 label')).toBeInTheDocument()
})
