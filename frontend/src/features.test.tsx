import type { ReactNode } from 'react'
import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { FeaturesPage } from './admin'
import { cache } from './api/client'
import type { FeatureFlagsOut } from './api/schema.gen'
import { setLanguage } from './i18n'
import { useFeatureLifecycle, useFeatures } from './shared'
import { DwellingsPage } from './users'

vi.mock('./dwelling-layout-editor', () => ({ DwellingLayoutEditor: () => null }))

const defaults = cache.getDefaultOptions()
const enabled: FeatureFlagsOut = { coefficient: true, actions: true, events: false, google_login: false }

beforeEach(() => {
  cache.setDefaultOptions({ queries: { retry: false, staleTime: Infinity } })
  cache.setQueryData(['features'], enabled)
})
afterEach(() => {
  cleanup(); cache.clear(); cache.setDefaultOptions(defaults)
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals()
})

function reply(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status })
}

function RuntimeFeatures() {
  const query = useFeatures(true)
  useFeatureLifecycle(query.data)
  return null
}

function renderFeatures(children: ReactNode = <FeaturesPage />) {
  return render(<QueryClientProvider client={cache}><MemoryRouter>
    <RuntimeFeatures />{children}
  </MemoryRouter></QueryClientProvider>)
}

test('switches save one explicit flag and only display confirmed server values', async () => {
  let finish: (response: Response) => void = () => { throw new Error('Request not started') }
  const fetcher = vi.fn(() => new Promise<Response>(resolve => { finish = resolve }))
  vi.stubGlobal('fetch', fetcher)
  renderFeatures()
  const coefficient = screen.getByRole('switch', { name: 'Ownership coefficients' })
  const actions = screen.getByRole('switch', { name: 'Actions' })
  expect(coefficient).toHaveAttribute('aria-checked', 'true')
  fireEvent.click(coefficient)
  expect(coefficient).toBeDisabled()
  expect(actions).toBeDisabled()
  expect(coefficient).toHaveAttribute('aria-checked', 'true')
  expect(fetcher).toHaveBeenCalledWith('/api/admin/settings/features/coefficient', expect.objectContaining({
    method: 'PATCH', body: '{"enabled":false}',
    headers: { 'X-Juntia-Request': '1', 'Content-Type': 'application/json' },
  }))
  finish(reply({ ...enabled, coefficient: false }))
  await waitFor(() => expect(coefficient).toHaveAttribute('aria-checked', 'false'))
  expect(actions).toHaveAttribute('aria-checked', 'true')
  expect(coefficient).toBeEnabled()
  expect(screen.getByText('Ownership coefficients: disabled.')).toBeVisible()
})

test('a failed save keeps the saved switch state and reports the error', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => reply({ code: 'internal_error' }, 500)))
  renderFeatures()
  const toggle = screen.getByRole('switch', { name: 'Actions' })
  fireEvent.click(toggle)
  expect(await screen.findByRole('alert')).toHaveTextContent('The operation could not be completed')
  expect(toggle).toHaveAttribute('aria-checked', 'true')
  expect(toggle).toBeEnabled()
  expect(cache.getQueryData(['features'])).toEqual(enabled)
})

test('failed feature loading exposes a retry instead of guessing flag defaults', async () => {
  cache.removeQueries({ queryKey: ['features'] })
  const fetcher = vi.fn().mockResolvedValueOnce(reply({ code: 'internal_error' }, 500))
    .mockResolvedValueOnce(reply({ ...enabled, actions: false }))
  vi.stubGlobal('fetch', fetcher)
  renderFeatures()
  expect(await screen.findByRole('alert')).toHaveTextContent('The operation could not be completed')
  expect(screen.queryByRole('switch')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Retry loading' }))
  expect(await screen.findByRole('switch', { name: 'Actions' })).toHaveAttribute('aria-checked', 'false')
})

test('reenabling coefficients refreshes masked dwelling, user and profile caches', async () => {
  cache.setQueryData(['features'], { ...enabled, coefficient: false })
  const dwelling = { id: 1, label: '1 A', coefficient: null, version: 1, user_count: 1 }
  cache.setQueryData(['admin', 'dwellings'], [dwelling])
  cache.setQueryData(['admin', 'users'], [{ coefficient: null }])
  cache.setQueryData(['profile', 7], { coefficient: null })
  cache.setQueryData(['summary'], { retained: true })
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    if (input === '/api/admin/settings/features/coefficient') return reply(enabled)
    if (input === '/api/admin/dwellings') return reply([{ ...dwelling, coefficient: '12.50' }])
    throw new Error(`Unexpected request: ${input}`)
  }))
  renderFeatures(<><FeaturesPage /><DwellingsPage /></>)
  expect(screen.queryByRole('columnheader', { name: 'Ownership coefficient' })).toBeNull()
  fireEvent.click(screen.getByRole('switch', { name: 'Ownership coefficients' }))
  expect(await screen.findByText('12.50%')).toBeVisible()
  expect(screen.getByRole('columnheader', { name: 'Ownership coefficient' })).toBeVisible()
  expect(cache.getQueryState(['admin', 'users'])?.isInvalidated).toBe(true)
  expect(cache.getQueryState(['profile', 7])?.isInvalidated).toBe(true)
  expect(cache.getQueryState(['summary'])?.isInvalidated).toBe(false)
})

test('open pages discover remote changes within five seconds without navigation', async () => {
  vi.useFakeTimers()
  let current = { ...enabled, actions: false }
  const fetcher = vi.fn(async () => reply(current))
  vi.stubGlobal('fetch', fetcher)
  cache.setQueryData(['actions', 'list'], { items: [{ title: 'Previously visible' }] })
  cache.setQueryData(['contacts', 'list'], { retained: true })
  renderFeatures()
  expect(fetcher).not.toHaveBeenCalled()
  await act(async () => { await vi.advanceTimersByTimeAsync(5_001) })
  expect(screen.getByRole('switch', { name: 'Actions' })).toHaveAttribute('aria-checked', 'false')
  expect(cache.getQueryData(['actions', 'list'])).toBeUndefined()
  expect(cache.getQueryData(['contacts', 'list'])).toEqual({ retained: true })
  current = enabled
  await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
  expect(screen.getByRole('switch', { name: 'Actions' })).toHaveAttribute('aria-checked', 'true')
  expect(fetcher).toHaveBeenCalledTimes(2)
})

test('an older feature read cannot overwrite a successful switch update', async () => {
  let finish: (response: Response) => void = () => { throw new Error('Read not started') }
  vi.stubGlobal('fetch', vi.fn((input: string) => {
    if (input === '/api/features') return new Promise<Response>(resolve => { finish = resolve })
    if (input === '/api/admin/settings/features/actions') return Promise.resolve(reply({ ...enabled, actions: false }))
    throw new Error(`Unexpected request: ${input}`)
  }))
  renderFeatures()
  const fetching = cache.refetchQueries({ queryKey: ['features'] })
  fireEvent.click(screen.getByRole('switch', { name: 'Actions' }))
  await waitFor(() => expect(screen.getByRole('switch', { name: 'Actions' })).toHaveAttribute('aria-checked', 'false'))
  await act(async () => { finish(reply(enabled)); await fetching })
  expect(cache.getQueryData(['features'])).toEqual({ ...enabled, actions: false })
})

test('the features page follows a language switch and confirms changes in that language', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => reply({ ...enabled, coefficient: false })))
  renderFeatures()
  expect(screen.getByRole('heading', { name: 'Features', level: 1 })).toBeVisible()
  expect(screen.getByRole('switch', { name: 'Ownership coefficients' })).toHaveTextContent('Enabled')
  expect(screen.getByRole('switch', { name: 'Events' })).toHaveTextContent('Disabled')
  act(() => setLanguage('es'))
  expect(screen.getByRole('heading', { name: 'Feature flags', level: 1 })).toBeVisible()
  expect(screen.getByRole('switch', { name: 'Eventos' })).toHaveTextContent('Desactivada')
  const coefficient = screen.getByRole('switch', { name: 'Coeficientes de propiedad' })
  expect(coefficient).toHaveTextContent('Activada')
  fireEvent.click(coefficient)
  expect(await screen.findByText('Coeficientes de propiedad: desactivada.')).toBeVisible()
  expect(coefficient).toHaveAttribute('aria-checked', 'false')
  expect(coefficient).toHaveTextContent('Desactivada')
})
