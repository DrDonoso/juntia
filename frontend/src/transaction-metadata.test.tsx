import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClientProvider } from '@tanstack/react-query'
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest'
import { ApiError, api, cache } from './api/client'
import type { CatalogOut, TransactionOut } from './api/schema.gen'
import { TransactionDetail, TransactionTags, metadataDraft, prepareMetadata } from './transaction-metadata'

vi.mock('./api/client', async original => {
  const actual = await original<typeof import('./api/client')>()
  return { ...actual, api: vi.fn() }
})

const frequent: CatalogOut = { id: 2, name: 'Emergencies', color: '#21639f' }
const rare: CatalogOut = { id: 1, name: 'Elevator', color: '#ffffff' }
const transaction: TransactionOut = {
  id: 7, booking_date: '2026-10-02', value_date: '2026-10-02', description: 'Cleaning receipt',
  amount: '-30.00', balance_after: '970.00', category_id: null, merchant: '', tags: [],
  classification_source: 'unclassified', version: 3,
}
let available: CatalogOut[]
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
  available = [frequent, rare]
  vi.mocked(api).mockReset().mockImplementation(async (url, method = 'GET') => {
    if (url === '/catalog/tags') return available
    if (url === '/catalog/categories') return [{ id: 1, name: 'Cleaning', color: '#21639f' }]
    if (url === '/admin/transactions/7' && method === 'PATCH') return transaction
    throw new Error(`Unexpected API request: ${method} ${url}`)
  })
})
afterEach(() => { cleanup(); cache.clear(); cache.setDefaultOptions(defaults); vi.restoreAllMocks() })

async function editor(value = transaction) {
  const close = vi.fn()
  render(<QueryClientProvider client={cache}><TransactionDetail value={value} editable close={close} /></QueryClientProvider>)
  const input = screen.getByRole('combobox', { name: 'Tags' })
  await waitFor(() => expect(input).toBeEnabled())
  return { input, close }
}

test('focus shows the eight most used unselected tags in catalog order', async () => {
  available = [...available, ...Array.from({ length: 10 }, (_, index) => ({
    id: index + 3, name: `Tag ${index}`, color: '#21639f',
  }))]
  const user = userEvent.setup()
  const { input, close } = await editor({ ...transaction, tags: [rare.id] })
  await user.click(input)
  expect(within(screen.getByRole('listbox')).getAllByRole('option').map(option => option.textContent)).toEqual(
    available.filter(tag => tag.id !== rare.id).slice(0, 8).map(tag => tag.name),
  )
  await user.keyboard('{Escape}')
  expect(screen.queryByRole('listbox')).toBeNull()
  expect(close).not.toHaveBeenCalled()
  await user.paste('ag 9')
  expect(screen.getByRole('option', { name: 'Tag 9' })).toBeInTheDocument()
  await user.keyboard('{ArrowDown}{Enter}')
  expect(screen.getByRole('button', { name: 'Remove Tag 9' })).toBeInTheDocument()
  expect(input).toHaveFocus()
  expect(input).toHaveAttribute('aria-expanded', 'false')
  await user.click(input)
  expect(input).toHaveAttribute('aria-expanded', 'true')
  expect(screen.queryByRole('checkbox')).toBeNull()
})

test('transaction tags share live colors, autocomplete, chips and deferred creation', async () => {
  const user = userEvent.setup()
  const { input, close } = await editor()
  await user.type(input, 'f')
  expect(screen.getByLabelText('Tag preview')).toHaveStyle({ backgroundColor: '#c6c102' })
  await user.type(input, 'a')
  expect(screen.getByLabelText('Tag preview')).toHaveStyle({ backgroundColor: '#d77089' })
  await user.type(input, 'm')
  expect(screen.getByLabelText('Tag preview')).toHaveStyle({ backgroundColor: '#2bccb4' })
  await user.keyboard('{Enter}')
  expect(screen.getByRole('button', { name: 'Remove fam' })).toBeInTheDocument()
  await user.type(input, 'EMERG')
  await user.keyboard('{ArrowDown}{Enter}')
  expect(screen.getByRole('button', { name: 'Remove Emergencies' }).closest('.tag')).toHaveStyle({ backgroundColor: '#21639f', color: '#ffffff' })
  expect(screen.getAllByRole('button', { name: /^Remove / }).map(button => button.closest('.tag')?.textContent)).toEqual(['fam', 'Emergencies'])
  await user.keyboard('{Backspace}')
  expect(screen.queryByRole('button', { name: 'Remove Emergencies' })).toBeNull()
  await user.type(input, 'emerg')
  await user.click(screen.getByRole('option', { name: 'Emergencies' }))
  await user.type(input, 'FAM')
  await user.keyboard(',')
  expect(screen.getAllByRole('button', { name: 'Remove fam' })).toHaveLength(1)
  expect(vi.mocked(api).mock.calls.every(([, method]) => !method)).toBe(true)
  await user.type(input, 'pending')
  await user.click(screen.getByRole('button', { name: 'Save classification' }))
  await waitFor(() => expect(close).toHaveBeenCalledOnce())
  expect(api).toHaveBeenCalledWith('/admin/transactions/7', 'PATCH', {
    version: 3, category_id: null, merchant: '', tags: [2],
    new_tags: [{ name: 'fam', color: '#2bccb4' }, expect.objectContaining({ name: 'pending' })],
  })
  expect(vi.mocked(api).mock.calls.some(([url]) => url.startsWith('/admin/catalog') || url.startsWith('/contact'))).toBe(false)
})

test('Enter without an active suggestion adds the typed name rather than the first match', async () => {
  const user = userEvent.setup()
  const { input } = await editor()
  await user.type(input, 'emerg')
  await user.keyboard('{Enter}')
  expect(screen.getByRole('button', { name: 'Remove emerg' })).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Remove Emergencies' })).toBeNull()
  await user.click(screen.getByRole('button', { name: 'Remove emerg' }))
  expect(input).toHaveFocus()
})

test('cancelled and failed edits keep tag creation out of the catalog', async () => {
  const user = userEvent.setup()
  const implementation = vi.mocked(api).getMockImplementation()!
  vi.mocked(api).mockImplementation(async (url, method, body) => {
    if (method === 'PATCH') throw new ApiError('preview_stale', 409)
    return implementation(url, method, body)
  })
  const { input, close } = await editor()
  await user.type(input, 'fam{Enter}')
  await user.click(screen.getByRole('button', { name: 'Save classification' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('The data has changed')
  expect(screen.getByRole('button', { name: 'Remove fam' })).toBeInTheDocument()
  expect(close).not.toHaveBeenCalled()
  await user.click(screen.getByRole('button', { name: 'Close' }))
  expect(close).toHaveBeenCalledOnce()
  expect(vi.mocked(api).mock.calls.filter(([, method]) => method)).toHaveLength(1)
})

test('pending invalid text blocks submission without losing the draft', async () => {
  const { input, close } = await editor()
  fireEvent.change(input, { target: { value: '\ufdfa'.repeat(100) } })
  fireEvent.submit(screen.getByRole('button', { name: 'Save classification' }).closest('form')!)
  expect(await screen.findByRole('alert')).toHaveTextContent('100 characters')
  expect(input).toHaveValue('\ufdfa'.repeat(100))
  expect(close).not.toHaveBeenCalled()
  expect(vi.mocked(api).mock.calls.some(([, method]) => method === 'PATCH')).toBe(false)
})

test('a submit includes valid pending text even without a blur event', async () => {
  const { input, close } = await editor()
  fireEvent.change(input, { target: { value: 'fam' } })
  fireEvent.submit(screen.getByRole('button', { name: 'Save classification' }).closest('form')!)
  await waitFor(() => expect(close).toHaveBeenCalledOnce())
  expect(api).toHaveBeenCalledWith('/admin/transactions/7', 'PATCH', expect.objectContaining({
    new_tags: [{ name: 'fam', color: '#2bccb4' }],
  }))
})

test('failed catalog loading is visible and does not allow accidental tag creation', async () => {
  const implementation = vi.mocked(api).getMockImplementation()!
  vi.mocked(api).mockImplementation(async (url, method, body) => {
    if (url === '/catalog/tags') throw new ApiError('internal_error', 500)
    return implementation(url, method, body)
  })
  render(<QueryClientProvider client={cache}><TransactionDetail value={transaction} editable close={vi.fn()} /></QueryClientProvider>)
  expect(await screen.findByRole('alert')).toHaveTextContent('The operation could not be completed')
  expect(screen.getByRole('combobox', { name: 'Tags' })).toBeDisabled()
})

test('readers cannot edit tags and displayed tags retain their saved colors', () => {
  const view = render(<QueryClientProvider client={cache}><TransactionDetail value={transaction} editable={false} close={vi.fn()} /></QueryClientProvider>)
  expect(screen.queryByRole('combobox', { name: 'Tags' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Save classification' })).toBeNull()
  view.unmount()
  const tags = render(<TransactionTags value={metadataDraft({ tags: [frequent.id, rare.id, 999] })} available={available} />)
  expect(within(tags.container).getByText('Emergencies')).toHaveStyle({ backgroundColor: '#21639f', color: '#ffffff' })
  expect(within(tags.container).getByText('Elevator')).toHaveStyle({ backgroundColor: '#ffffff', color: '#000000' })
  expect(within(tags.container).getByText('#999')).toBeInTheDocument()
})

test('metadata serialization preserves unknown ids and enforces the combined tag limit', () => {
  expect(prepareMetadata(metadataDraft({ tags: [999] }), [])).toEqual({ category_id: null, merchant: '', tags: [999] })
  const tags = Array.from({ length: 30 }, (_, index) => index + 1)
  expect(() => prepareMetadata({ ...metadataDraft({ tags }), tagInput: 'one more' }, [])).toThrow('Select up to 30 valid tags.')
})
