import type { ReactNode } from 'react'
import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { ApiError, api, cache, downloadFile, refreshEventData } from './api/client'
import type { EventOccurrenceOut, EventOut, FeatureFlagsOut } from './api/schema.gen'
import { safeReturnPath } from './auth'
import { ActionEvents, EventDetailPage, EventsPage } from './community-events'
import { CalendarButton, EventCards, EventEditor, EventSnapshotView, cacheEvent, changeEventAllDay, eventBody, eventDraft, eventRange, localInput, rebaseEventDraft } from './community-event-shared'
import { I18nRoot, setLanguage, translate } from './i18n'
import { useFeatureLifecycle, useFeatures } from './shared'

const defaults = cache.getDefaultOptions()
type Fetcher = (url: string, options: RequestInit) => Promise<Response>
const flags: FeatureFlagsOut = { coefficient: true, actions: true, events: true, google_login: false }
const item: EventOut = {
  id: 1, title: 'Lift inspection', description: 'Technical visit', location: 'Entrance hall',
  all_day: false, starts_at: '2030-05-10T16:00:00Z', ends_at: '2030-05-10T18:00:00Z',
  starts_on: null, ends_on: null, action: { id: 7, title: 'Linked repair' },
  version: 1, author: { kind: 'resident', user_id: 3, name: 'Neighbor' },
  created_at: '2026-10-15T10:00:00Z', updated_at: '2026-10-15T10:00:00Z', deleted_at: null,
}
const occurrence: EventOccurrenceOut = {
  day: '2030-05-10', is_continuation: false, is_last_day: true, is_past: false, event: item,
}

beforeEach(() => {
  cache.setDefaultOptions({ queries: { retry: false, staleTime: Infinity } })
  cache.setQueryData(['features'], flags)
  cache.setQueryData(['events', 'config'], { timezone: 'Europe/Madrid' })
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: function (this: HTMLDialogElement) { this.open = true } })
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value: function (this: HTMLDialogElement) { this.open = false } })
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() })
})
afterEach(() => {
  cleanup(); cache.clear(); cache.setDefaultOptions(defaults)
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals()
})
function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status })
}
function Lifecycle() {
  const query = useFeatures()
  useFeatureLifecycle(query.data)
  return null
}
function mount(children: ReactNode, initialEntries = ['/']) {
  return render(<I18nRoot><QueryClientProvider client={cache}><MemoryRouter initialEntries={initialEntries}><Lifecycle />{children}</MemoryRouter></QueryClientProvider></I18nRoot>)
}
function LocationProbe() {
  const location = useLocation()
  return <output data-testid="location">{location.pathname + location.search}</output>
}
function HistoryControls() {
  const navigate = useNavigate()
  return <><button type="button" onClick={() => navigate(-1)}>Back</button><button type="button" onClick={() => navigate(1)}>Forward</button></>
}
function stubEventRequests(detail: EventOut = item) {
  const fetcher = vi.fn<Fetcher>(async url => {
    if (url.endsWith('/config')) return response({ timezone: 'Europe/Madrid' })
    if (url.startsWith('/api/events/agenda') || url.includes('/history')) return response({ items: [], total: 0, page: 1, pages: 1 })
    return response(detail)
  })
  vi.stubGlobal('fetch', fetcher)
  return fetcher
}

test.each([
  { mode: 'create', value: null },
  { mode: 'edit', value: item },
])('the $mode form omits time-zone help without changing its schedule controls', ({ value }) => {
  mount(<EventEditor value={value} timezone="Europe/Madrid" close={vi.fn()} saved={vi.fn()} />)
  expect(screen.queryByText(/time zone/i)).toBeNull()
  expect(screen.queryByText(/Europe\/Madrid/)).toBeNull()
  const start = screen.getByRole('group', { name: 'Start' })
  const end = screen.getByRole('group', { name: 'End' })
  expect(start).toBeVisible()
  expect(end).toBeVisible()
  if (value) {
    expect(start).toHaveTextContent('10/05/2030')
    expect(start).toHaveTextContent('18:00')
    expect(end).toHaveTextContent('20:00')
  }
  expect(screen.getByRole('button', { name: 'Save event' })).toBeVisible()
})

test('event dates always use the community zone, including winter and summer', () => {
  expect(localInput('2027-01-10T17:00:00Z', 'Europe/Madrid')).toBe('2027-01-10T18:00:00')
  expect(localInput('2027-07-10T16:00:00Z', 'Europe/Madrid')).toBe('2027-07-10T18:00:00')
  expect(localInput('2027-07-10T23:30:00Z', 'Asia/Kathmandu')).toBe('2027-07-11T05:15:00')
  const draft = eventDraft(item, 'Europe/Madrid')
  expect(draft.starts_at).toBe('2030-05-10T18:00:00')
  expect(eventBody(draft, 'Europe/Madrid', false)).toMatchObject({
    starts_at: '2030-05-10T18:00:00', ends_at: '2030-05-10T20:00:00', timezone: 'Europe/Madrid',
  })
})

test('event login destinations remain internal and preserve filters', () => {
  expect(safeReturnPath('/events/12')).toBe('/events/12')
  expect(safeReturnPath('/events?scope=past')).toBe('/events?scope=past')
  expect(safeReturnPath('/api/events/12/calendar.ics')).toBe('/')
  expect(safeReturnPath('//other.invalid/events')).toBe('/')
})

test('all-day ranges preserve dates and export an exclusive end without browser offsets', () => {
  const value = { ...item, all_day: true, starts_at: null, ends_at: null, starts_on: '2030-05-10', ends_on: '2030-05-13' }
  const draft = eventDraft(value, 'America/Los_Angeles')
  expect(draft.last_day).toBe('2030-05-12')
  expect(eventBody(draft, 'America/Los_Angeles', true)).toMatchObject({
    starts_on: '2030-05-10', ends_on: '2030-05-13', starts_at: null, ends_at: null, action_id: 7,
  })
  expect(eventRange(value, 'America/Los_Angeles')).toBe('10/05/2030 – 12/05/2030 · All day')
})

test('disabling all-day preserves both selected dates and requires explicit times', () => {
  const value = { ...item, all_day: true, starts_at: null, ends_at: null, starts_on: '2030-05-10', ends_on: '2030-05-13' }
  const draft = changeEventAllDay(eventDraft(value, 'Europe/Madrid'), false)
  expect(draft).toMatchObject({
    all_day: false, starts_at: '2030-05-10T', ends_at: '2030-05-12T',
    title: item.title, description: item.description,
  })
  expect(() => eventBody(draft, 'Europe/Madrid', false)).toThrow('Choose the start time and the end time.')
  expect(() => eventBody({ ...draft, starts_at: '2030-05-10T09:00' }, 'Europe/Madrid', false)).toThrow('Choose the start time')
  expect(eventBody({ ...draft, starts_at: '2030-05-10T09:00', ends_at: '2030-05-12T17:00' }, 'Europe/Madrid', false))
    .toMatchObject({ starts_at: '2030-05-10T09:00', ends_at: '2030-05-12T17:00', starts_on: null, ends_on: null })
})

test('switching modes keeps edited date selections rather than stale hidden dates', () => {
  const draft = { ...eventDraft(item, 'Europe/Madrid'), starts_at: '2030-05-15T09:00', ends_at: '2030-05-16T17:00' }
  const allDay = changeEventAllDay(draft, true)
  expect(allDay).toMatchObject({ starts_on: '2030-05-15', last_day: '2030-05-16' })
  expect(changeEventAllDay(allDay, false)).toMatchObject({ starts_at: '2030-05-15T', ends_at: '2030-05-16T' })
})

test('date-grouped cards show only the hours for the same community day', () => {
  expect(eventRange(item, 'Europe/Madrid', true)).toBe('18:00 – 20:00')
  expect(eventRange(item, 'Europe/Madrid')).toContain('10/05/2030')
  const acrossUTC = { ...item, starts_at: '2030-05-09T23:30:00Z', ends_at: '2030-05-10T00:30:00Z' }
  expect(eventRange(acrossUTC, 'Europe/Madrid', true)).toBe('01:30 – 02:30')
  const acrossLocal = { ...item, starts_at: '2030-05-10T21:00:00Z', ends_at: '2030-05-10T23:00:00Z' }
  expect(eventRange(acrossLocal, 'Europe/Madrid', true)).toBe('10/05/2030, 23:00 – 11/05/2030, 01:00')
  const allDay = { ...item, all_day: true, starts_at: null, ends_at: null, starts_on: '2030-05-10', ends_on: '2030-05-11' }
  expect(eventRange(allDay, 'Europe/Madrid', true)).toBe('All day')
  expect(eventRange(allDay, 'Europe/Madrid')).toBe('10/05/2030 · All day')
  expect(eventRange({ ...allDay, ends_on: '2030-05-13' }, 'Europe/Madrid', true)).toBe('10/05/2030 – 12/05/2030 · All day')
})

test('multi-day events have one full card and compact continuations linking to the same event', () => {
  const value = { ...item, all_day: true, starts_at: null, ends_at: null, starts_on: '2030-05-10', ends_on: '2030-05-13' }
  mount(<EventCards zone="Europe/Madrid" items={[
    { ...occurrence, event: value, is_last_day: false },
    { ...occurrence, event: value, day: '2030-05-11', is_continuation: true, is_last_day: false },
    { ...occurrence, event: value, day: '2030-05-12', is_continuation: true },
  ]} />, ['/events'])
  const first = within(screen.getByRole('heading', { name: '10/05/2030' }).closest('section')!)
  const middle = within(screen.getByRole('heading', { name: '11/05/2030' }).closest('section')!)
  const last = within(screen.getByRole('heading', { name: '12/05/2030' }).closest('section')!)
  expect(first.getByText('10/05/2030 – 12/05/2030 · All day')).toBeVisible()
  expect(first.getByText(item.location)).toBeVisible()
  expect(first.getByRole('button', { name: 'Add to my calendar' })).toBeVisible()
  expect(middle.getByText('Continues', { exact: true })).toBeVisible()
  expect(last.getByText('Continues · Last day')).toBeVisible()
  expect(middle.queryByText(item.location)).toBeNull()
  expect(last.queryByText(item.action!.title)).toBeNull()
  expect(middle.queryByRole('button')).toBeNull()
  expect(last.queryByRole('button')).toBeNull()
  for (const link of screen.getAllByRole('link', { name: item.title })) {
    expect(link).toHaveAttribute('href', '/events?event=1')
  }
  expect(screen.getAllByRole('link', { name: item.title })).toHaveLength(3)
  expect(screen.getAllByRole('listitem').filter(element => element.classList.contains('event-continuation'))).toHaveLength(2)
})

test('continuations and new events share their date group in the server-provided order', () => {
  const other = { ...item, id: 2, title: 'One-off visit', starts_at: '2030-05-11T08:00:00Z', ends_at: '2030-05-11T09:00:00Z' }
  mount(<EventCards zone="Europe/Madrid" items={[
    { ...occurrence, is_last_day: false },
    { ...occurrence, day: '2030-05-11', is_continuation: true },
    { ...occurrence, day: '2030-05-11', event: other },
  ]} />)
  const secondDay = within(screen.getByRole('heading', { name: '11/05/2030' }).closest('section')!)
  expect(screen.getAllByRole('heading', { level: 2 })).toHaveLength(2)
  expect(secondDay.getAllByRole('heading', { level: 3 }).map(element => element.textContent)).toEqual([
    item.title, other.title,
  ])
  expect(secondDay.getByText('10:00 – 11:00')).toBeVisible()
})

test('a page beginning with a continuation remains usable and past days retain reverse order', () => {
  const deleted = { ...item, deleted_at: '2031-01-01T00:00:00Z' }
  mount(<EventCards zone="Europe/Madrid" items={[
    { ...occurrence, day: '2030-05-12', is_continuation: true, event: deleted },
    { ...occurrence, day: '2030-05-11', is_continuation: true, is_last_day: false, event: deleted },
  ]} />, ['/events?scope=deleted'])
  expect(screen.getAllByRole('heading', { level: 2 }).map(element => element.textContent)).toEqual([
    '12/05/2030', '11/05/2030',
  ])
  expect(screen.getByText('Continues · Last day')).toBeVisible()
  expect(screen.getAllByText('Deleted')).toHaveLength(2)
  expect(screen.queryByRole('button', { name: 'Add to my calendar' })).toBeNull()
  expect(screen.getAllByRole('link', { name: item.title })[0]).toHaveAttribute('href', '/events?scope=deleted&event=1')
})

test('only mixed timelines mute finished events, without relying on color alone', () => {
  const finished = { ...item, id: 2, title: 'Finished visit' }
  const items = [{ ...occurrence, event: finished, is_past: true }, occurrence]
  const { unmount } = mount(<EventCards zone="Europe/Madrid" items={items} dimPast />, ['/events?scope=all'])
  const past = screen.getByRole('link', { name: finished.title }).closest('li')!
  expect(past).toHaveClass('event-past')
  expect(within(past).getByText('Finished event')).toHaveClass('sr-only')
  expect(screen.getByRole('link', { name: item.title }).closest('li')).not.toHaveClass('event-past')
  expect(screen.getAllByText('Finished event')).toHaveLength(1)
  unmount()
  mount(<EventCards zone="Europe/Madrid" items={items} />, ['/events?scope=past'])
  expect(screen.getByRole('link', { name: finished.title }).closest('li')).not.toHaveClass('event-past')
  expect(screen.queryByText('Finished event')).toBeNull()
})

test('rebasing preserves edited fields and adopts unedited server fields as a schedule unit', () => {
  const draft = { ...eventDraft(item, 'Europe/Madrid'), title: 'My draft' }
  const current = { ...item, title: 'Another title', description: 'New description', ends_at: '2030-05-10T19:00:00Z' }
  const merged = rebaseEventDraft(draft, item, current, 'Europe/Madrid')
  expect(merged.title).toBe('My draft')
  expect(merged.description).toBe('New description')
  expect(merged.ends_at).toBe('2030-05-10T21:00:00')
})

test('refreshing TZ preserves saved instants for an unedited schedule without discarding text edits', () => {
  const draft = { ...eventDraft(item, 'Europe/Madrid'), title: 'My draft' }
  const rezoned = rebaseEventDraft(draft, item, item, 'Europe/Madrid', 'UTC')
  expect(rezoned.title).toBe('My draft')
  expect(rezoned.starts_at).toBe('2030-05-10T16:00:00')
  expect(rezoned.ends_at).toBe('2030-05-10T18:00:00')
  const edited = { ...draft, starts_at: '2030-05-11T19:00:00', ends_at: '2030-05-11T20:00:00' }
  expect(rebaseEventDraft(edited, item, item, 'Europe/Madrid', 'UTC').starts_at).toBe(edited.starts_at)
})

test('disabled Events never starts private event requests', () => {
  cache.setQueryData(['features'], { ...flags, events: false })
  const fetcher = vi.fn()
  vi.stubGlobal('fetch', fetcher)
  mount(<EventsPage />)
  expect(screen.getByRole('heading', { name: 'Events are turned off' })).toBeVisible()
  expect(fetcher).not.toHaveBeenCalled()
})

test('agenda texts, schedules and editor controls follow the active language', async () => {
  const allDay = { ...item, id: 2, title: 'Garden day', all_day: true, starts_at: null, ends_at: null, starts_on: '2030-05-10', ends_on: '2030-05-11' }
  vi.stubGlobal('fetch', vi.fn<Fetcher>(async () => response({ items: [occurrence, { ...occurrence, event: allDay }], total: 2, page: 1, pages: 1 })))
  mount(<EventsPage />, ['/events'])
  expect(await screen.findByRole('link', { name: allDay.title })).toBeVisible()
  expect(screen.getByRole('heading', { level: 1, name: 'Events' })).toBeVisible()
  expect(screen.getByText('18:00 – 20:00')).toBeVisible()
  expect(screen.getByText('All day')).toBeVisible()
  expect(screen.getAllByRole('button', { name: 'Add to my calendar' })).toHaveLength(2)
  act(() => setLanguage('es'))
  expect(screen.getByRole('heading', { level: 1, name: 'Eventos' })).toBeVisible()
  expect(screen.getByLabelText('Mostrar')).toHaveValue('upcoming')
  expect(screen.getByText('18:00 – 20:00')).toBeVisible()
  expect(screen.getByText(translate('es', 'events.schedule.allDay'))).toBeVisible()
  expect(screen.getAllByRole('button', { name: translate('es', 'events.calendar.add') })).toHaveLength(2)
  fireEvent.click(screen.getByRole('button', { name: 'Nuevo evento' }))
  const editor = await screen.findByRole('dialog', { name: 'Nuevo evento' })
  expect(within(editor).getByRole('group', { name: 'Inicio' })).toBeVisible()
  expect(within(editor).getByRole('group', { name: 'Final' })).toBeVisible()
  expect(within(editor).getByRole('button', { name: 'Abrir calendario de Inicio' })).toBeVisible()
  expect(within(editor).getByRole('button', { name: 'Guardar evento' })).toBeVisible()
  act(() => setLanguage('en'))
  expect(within(editor).getByRole('group', { name: 'Start' })).toBeVisible()
  expect(within(editor).getByRole('button', { name: 'Open calendar for Start' })).toBeVisible()
  expect(screen.getByRole('dialog', { name: 'New event' })).toBe(editor)
})

test('timeline requests scope and page and uses the community zone without showing its label', async () => {
  const fetcher = vi.fn<Fetcher>(async () => response({ items: [occurrence], total: 21, page: 1, pages: 2 }))
  vi.stubGlobal('fetch', fetcher)
  mount(<EventsPage />, ['/events'])
  expect(await screen.findByRole('link', { name: item.title })).toHaveAttribute('href', '/events?event=1')
  expect(screen.queryByText(/Europe\/Madrid/)).toBeNull()
  expect(screen.getByText('18:00 – 20:00')).toBeVisible()
  expect(screen.queryByRole('button', { name: 'Refresh events' })).toBeNull()
  expect(screen.getByRole('heading', { level: 1, name: 'Events' }).closest('.page-heading')!.querySelectorAll('p:not(.eyebrow)')).toHaveLength(0)
  fireEvent.click(screen.getByRole('button', { name: 'Next: events' }))
  await waitFor(() => expect(fetcher.mock.calls.some(call => String(call[0]).includes('page=2'))).toBe(true))
  fireEvent.change(screen.getByLabelText('Show'), { target: { value: 'past' } })
  await waitFor(() => expect(fetcher.mock.calls.some(call => {
    const url = String(call[0])
    return url.includes('scope=past') && !url.includes('page=')
  })).toBe(true))
})

test('All opens the complete timeline on the page chosen by the server and mutes finished events', async () => {
  const finished = { ...item, id: 2, title: 'Finished visit' }
  const fetcher = vi.fn<Fetcher>(async () => response({
    items: [{ ...occurrence, event: finished, is_past: true }, occurrence], total: 50, page: 2, pages: 3,
  }))
  vi.stubGlobal('fetch', fetcher)
  mount(<EventsPage />, ['/events?scope=all'])
  expect(await screen.findByText('Page 2 of 3')).toBeVisible()
  const first = new URL(String(fetcher.mock.calls[0][0]), 'http://localhost')
  expect(first.searchParams.get('scope')).toBe('all')
  expect(first.searchParams.has('page')).toBe(false)
  expect(screen.getByLabelText('Show')).toHaveValue('all')
  expect(within(screen.getByLabelText('Show')).getAllByRole('option').map(option => option.textContent)).toEqual([
    'Upcoming and ongoing', 'All', 'Past', 'Deleted',
  ])
  expect(screen.getByRole('link', { name: finished.title }).closest('li')).toHaveClass('event-past')
  expect(screen.getByRole('link', { name: item.title }).closest('li')).not.toHaveClass('event-past')
  fireEvent.click(screen.getByRole('button', { name: 'Previous: events' }))
  await waitFor(() => expect(fetcher.mock.calls.some(call => String(call[0]).includes('scope=all&q=&page=1'))).toBe(true))
  fetcher.mockResolvedValue(response({ items: [], total: 0, page: 1, pages: 1 }))
  fireEvent.change(screen.getByLabelText('Search by title'), { target: { value: 'no matches' } })
  expect(await screen.findByText('No events match these filters.')).toBeVisible()
  expect(String(fetcher.mock.calls.at(-1)![0])).not.toContain('page=')
})

test('events open in a dialog over the agenda and closing returns to the same filters', async () => {
  const user = userEvent.setup()
  cache.setQueryData(['events', 'item', item.id], item)
  const fetcher = vi.fn<Fetcher>(async () => response({ items: [occurrence], total: 21, page: 2, pages: 2 }))
  vi.stubGlobal('fetch', fetcher)
  mount(<><EventsPage /><LocationProbe /></>, ['/events?scope=past&page=2'])
  const link = await screen.findByRole('link', { name: item.title })
  expect(link).toHaveAttribute('href', '/events?scope=past&page=2&event=1')
  await user.click(link)
  const dialog = await screen.findByRole('dialog', { name: item.title })
  expect(within(dialog).getByRole('heading', { level: 2, name: item.title })).toBeVisible()
  expect(screen.getByTestId('location')).toHaveTextContent('/events?scope=past&page=2&event=1')
  expect(screen.getByLabelText('Show')).toHaveValue('past')
  await user.click(within(dialog).getByRole('button', { name: 'Close' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(screen.getByTestId('location')).toHaveTextContent(/^\/events\?scope=past&page=2$/)
  expect(link).toBeVisible()
  expect(fetcher).toHaveBeenCalledOnce()
})

test('the event dialog follows browser history and can be closed again after Forward', async () => {
  const user = userEvent.setup()
  cache.setQueryData(['events', 'item', item.id], item)
  vi.stubGlobal('fetch', vi.fn<Fetcher>(async () => response({ items: [occurrence], total: 1, page: 1, pages: 1 })))
  mount(<><EventsPage /><LocationProbe /><HistoryControls /></>, ['/events?q=lift'])
  await user.click(await screen.findByRole('link', { name: item.title }))
  await user.click(within(await screen.findByRole('dialog', { name: item.title })).getByRole('button', { name: 'Close' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(screen.getByTestId('location')).toHaveTextContent(/^\/events\?q=lift$/)
  await user.click(screen.getByRole('button', { name: 'Forward' }))
  const dialog = await screen.findByRole('dialog', { name: item.title })
  expect(screen.getByTestId('location')).toHaveTextContent('/events?q=lift&event=1')
  await user.click(within(dialog).getByRole('button', { name: 'Close' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(screen.getByTestId('location')).toHaveTextContent(/^\/events\?q=lift$/)
  await user.click(screen.getByRole('button', { name: 'Forward' }))
  expect(await screen.findByRole('dialog', { name: item.title })).toBeVisible()
  await user.click(screen.getByRole('button', { name: 'Back' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(screen.getByTestId('location')).toHaveTextContent(/^\/events\?q=lift$/)
})

test('Escape in a dialog opened from an event closes only that dialog', async () => {
  cache.setQueryData(['events', 'item', item.id], item)
  stubEventRequests()
  mount(<><EventsPage /><LocationProbe /></>, ['/events?event=1'])
  const detail = await screen.findByRole('dialog', { name: item.title })
  fireEvent.click(within(detail).getByRole('button', { name: 'History' }))
  const history = await screen.findByRole('dialog', { name: 'Event history' })
  fireEvent(history, new Event('cancel', { cancelable: true }))
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Event history' })).toBeNull())
  expect(screen.getByRole('dialog', { name: item.title })).toBeVisible()
  expect(screen.getByTestId('location')).toHaveTextContent('/events?event=1')
  fireEvent(screen.getByRole('dialog', { name: item.title }), new Event('cancel', { cancelable: true }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(screen.getByTestId('location')).toHaveTextContent(/^\/events$/)
})

test('direct event links open the agenda with the event dialog', async () => {
  cache.setQueryData(['events', 'item', item.id], item)
  stubEventRequests()
  const routes = <><Routes><Route path="/events" element={<EventsPage />} /><Route path="/events/:eventId" element={<EventDetailPage />} /></Routes><LocationProbe /></>
  const { unmount } = mount(routes, ['/events/1'])
  expect(await screen.findByRole('dialog', { name: item.title })).toBeVisible()
  expect(screen.getByRole('heading', { level: 1, name: 'Events' })).toBeVisible()
  expect(screen.getByTestId('location')).toHaveTextContent('/events?event=1')
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Close' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(screen.getByTestId('location')).toHaveTextContent(/^\/events$/)
  unmount()
  mount(routes, ['/events/abc'])
  expect(screen.getByText('Event not found.')).toBeVisible()
  expect(screen.getByTestId('location')).toHaveTextContent('/events/abc')
})

test('event detail separates labelled fields without showing a time zone label', async () => {
  cache.setQueryData(['events', 'item', item.id], item)
  stubEventRequests({ ...item, action: null })
  mount(<EventsPage />, ['/events?event=1'])
  const dialog = await screen.findByRole('dialog', { name: item.title })
  expect(within(dialog).getByRole('heading', { level: 2, name: item.title })).toBeVisible()
  expect(within(dialog).getByRole('heading', { name: 'Location' })).toBeVisible()
  expect(within(dialog).getByText(item.location)).toBeVisible()
  expect(within(dialog).getByRole('heading', { name: 'Description' })).toBeVisible()
  expect(within(dialog).getByText(item.description)).toBeVisible()
  expect(within(dialog).getByRole('heading', { name: 'Related action' })).toBeVisible()
  expect(within(dialog).getByRole('link', { name: item.action!.title })).toHaveAttribute('href', '/actions/7')
  expect(within(dialog).getAllByRole('separator')).toHaveLength(2)
  expect(within(dialog).queryByText(/time zone/i)).toBeNull()
  expect(within(dialog).queryByText(/Europe\/Madrid/)).toBeNull()
  expect(within(dialog).getByText('10/05/2030, 18:00 – 10/05/2030, 20:00')).toBeVisible()
  expect(within(dialog).getByRole('button', { name: 'Edit event' })).toBeVisible()
  expect(within(dialog).getByRole('button', { name: 'Add to my calendar' })).toBeVisible()
  await act(async () => { cache.setQueryData(['features'], { ...flags, actions: false }) })
  await waitFor(() => expect(within(dialog).queryByRole('heading', { name: 'Related action' })).toBeNull())
  expect(within(dialog).queryByRole('link', { name: item.action!.title })).toBeNull()
  expect(within(dialog).getAllByRole('separator')).toHaveLength(1)
})

test('event detail keeps empty optional fields clearly labelled', async () => {
  const empty = { ...item, location: '', description: '', action: null }
  cache.setQueryData(['events', 'item', item.id], empty)
  stubEventRequests(empty)
  mount(<EventsPage />, ['/events?event=1'])
  const dialog = await screen.findByRole('dialog', { name: item.title })
  expect(within(dialog).getByText('Not specified.')).toBeVisible()
  expect(within(dialog).getByText('No description.')).toBeVisible()
  expect(within(dialog).getByText('No related action.')).toBeVisible()
  expect(within(dialog).getAllByRole('separator')).toHaveLength(2)
})

test('event authors name the administrator in the reader language, never with the name sent by the server', async () => {
  const administrator = { kind: 'administrator' as const, user_id: null, name: 'ops-admin' }
  const authored = { ...item, author: administrator }
  cache.setQueryData(['events', 'item', item.id], authored)
  vi.stubGlobal('fetch', vi.fn<Fetcher>(async url => {
    if (url.includes('/history')) return response({
      items: [
        { id: 2, kind: 'updated', author: administrator, created_at: item.updated_at, before: item, after: authored },
        { id: 1, kind: 'created', author: item.author, created_at: item.created_at, before: null, after: item },
      ],
      total: 2, page: 1, pages: 1,
    })
    if (url.startsWith('/api/events/agenda')) return response({ items: [], total: 0, page: 1, pages: 1 })
    return response(authored)
  }))
  mount(<EventsPage />, ['/events?event=1'])
  const detail = await screen.findByRole('dialog', { name: item.title })
  expect(within(detail).getByText(/^Created by /)).toHaveTextContent(/^Created by Technical administrator · /)
  fireEvent.click(within(detail).getByRole('button', { name: 'History' }))
  const history = await screen.findByRole('dialog', { name: 'Event history' })
  const entry = (kind: string) => within(history).getByText(kind).closest('li')
  expect(await within(history).findByText('Event updated')).toBeVisible()
  expect(entry('Event updated')).toHaveTextContent('Technical administrator · ')
  expect(entry('Event created')).toHaveTextContent('Neighbor · ')
  expect(document.body).not.toHaveTextContent('ops-admin')

  act(() => setLanguage('es'))
  const spanish = translate('es', 'common.technicalAdministrator')
  expect(within(detail).getByText(/^Creado por /)).toHaveTextContent(`Creado por ${spanish} · `)
  expect(entry(translate('es', 'events.history.kinds.updated'))).toHaveTextContent(`${spanish} · `)
  expect(entry(translate('es', 'events.history.kinds.created'))).toHaveTextContent('Neighbor · ')
  expect(document.body).not.toHaveTextContent('ops-admin')
})

test('agenda continues refreshing automatically without a manual refresh control', async () => {
  vi.useFakeTimers()
  const fetcher = vi.fn<Fetcher>(async () => response({ items: [occurrence], total: 1, page: 1, pages: 1 }))
  vi.stubGlobal('fetch', fetcher)
  await act(async () => { mount(<EventsPage />); await vi.advanceTimersByTimeAsync(10) })
  expect(fetcher).toHaveBeenCalledOnce()
  await act(async () => { await vi.advanceTimersByTimeAsync(60_010) })
  expect(fetcher).toHaveBeenCalledTimes(2)
  expect(screen.queryByRole('button', { name: 'Refresh events' })).toBeNull()
})

test('creating a single all-day event needs only its first day and sends the exclusive end', async () => {
  const user = userEvent.setup()
  const saved = vi.fn()
  const fetcher = vi.fn<Fetcher>(async () => response({ ...item, all_day: true, starts_at: null, ends_at: null, starts_on: '2030-05-10', ends_on: '2030-05-11' }, 201))
  vi.stubGlobal('fetch', fetcher)
  mount(<EventEditor value={null} timezone="Europe/Madrid" close={vi.fn()} saved={saved} />)
  fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Residents meeting' } })
  fireEvent.click(screen.getByLabelText('All day'))
  const start = screen.getByRole('group', { name: 'First day' })
  for (const [type, value] of [['day', '10'], ['month', '05'], ['year', '2030']]) {
    const segment = start.querySelector<HTMLElement>(`[data-type="${type}"]`)!
    await user.click(segment)
    await user.keyboard(value)
  }
  await user.tab()
  expect(screen.getByRole('group', { name: 'Last day (inclusive)' })).toHaveTextContent('10/05/2030')
  fireEvent.click(screen.getByRole('button', { name: 'Save event' }))
  await waitFor(() => expect(saved).toHaveBeenCalled())
  const [, options] = fetcher.mock.calls[0]
  expect(JSON.parse((options as RequestInit).body as string)).toMatchObject({
    title: 'Residents meeting', all_day: true, starts_on: '2030-05-10', ends_on: '2030-05-11',
  })
})

test('editing while Actions is disabled hides and preserves the association by omitting it', async () => {
  cache.setQueryData(['features'], { ...flags, actions: false })
  const saved = vi.fn()
  const fetcher = vi.fn<Fetcher>(async () => response({ ...item, title: 'New title', action: null, version: 2 }))
  vi.stubGlobal('fetch', fetcher)
  mount(<EventEditor value={item} timezone="Europe/Madrid" close={vi.fn()} saved={saved} />)
  expect(screen.queryByText(item.action!.title)).toBeNull()
  expect(screen.queryByRole('combobox', { name: 'Linked action (optional)' })).toBeNull()
  expect(screen.getByText('Actions are not available. Saving keeps any existing link unchanged.')).toBeVisible()
  fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'New title' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save event' }))
  await waitFor(() => expect(saved).toHaveBeenCalled())
  const body = JSON.parse((fetcher.mock.calls[0][1] as RequestInit).body as string)
  expect(body).not.toHaveProperty('action_id')
  expect(body.starts_at).toBe('2030-05-10T18:00:00')
})

test('a stale edit keeps the draft and requires explicitly reviewing the current version', async () => {
  let patches = 0
  const current = { ...item, title: 'Remote title', description: 'Remote description', version: 2 }
  const fetcher = vi.fn(async (url: string, options: RequestInit) => {
    if (options.method === 'PATCH') {
      patches++
      return patches === 1 ? response({ code: 'event_stale' }, 409) : response({ ...current, title: 'My draft', version: 3 })
    }
    if (url === '/api/events/1') return response(current)
    throw new Error(`Unexpected request: ${url}`)
  })
  vi.stubGlobal('fetch', fetcher)
  const saved = vi.fn()
  mount(<EventEditor value={item} timezone="Europe/Madrid" close={vi.fn()} saved={saved} />)
  fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'My draft' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save event' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Check the current version' }))
  expect(screen.getByRole('button', { name: 'Save event' })).toBeDisabled()
  fireEvent.click(await screen.findByRole('button', { name: 'Update the base and keep my draft' }))
  expect(screen.getByLabelText('Title')).toHaveValue('My draft')
  expect(screen.getByLabelText('Description')).toHaveValue('Remote description')
  fireEvent.click(screen.getByRole('button', { name: 'Save event' }))
  await waitFor(() => expect(saved).toHaveBeenCalled())
  expect(JSON.parse(fetcher.mock.calls.at(-1)![1].body as string).version).toBe(2)
})

test('picker searches existing actions and explicitly writes the selected link', async () => {
  const user = userEvent.setup()
  const saved = vi.fn()
  const fetcher = vi.fn<Fetcher>(async (url: string) => {
    if (url.startsWith('/api/actions/items?')) return response({
      items: [{ id: 8, title: 'Electrical work' }], total: 1, page: 1, pages: 1,
    })
    if (url === '/api/events/1') return response({ ...item, action: { id: 8, title: 'Electrical work' }, version: 2 })
    throw new Error(`Unexpected request: ${url}`)
  })
  vi.stubGlobal('fetch', fetcher)
  mount(<EventEditor value={item} timezone="Europe/Madrid" close={vi.fn()} saved={saved} />)
  const field = screen.getByRole('combobox', { name: 'Linked action (optional)' })
  expect(field).toHaveValue(item.action!.title)
  expect(fetcher).not.toHaveBeenCalled()
  await user.click(field)
  expect(await screen.findByRole('option', { name: 'Electrical work' })).toBeVisible()
  expect(field).toHaveAttribute('aria-expanded', 'true')
  await user.type(field, 'Elec')
  await waitFor(() => expect(fetcher.mock.calls.some(([url]) => url.includes('q=Elec&'))).toBe(true))
  await screen.findByRole('option', { name: 'Electrical work' })
  await user.keyboard('{ArrowDown}{Enter}')
  expect(field).toHaveValue('Electrical work')
  expect(field).toHaveFocus()
  expect(screen.queryByRole('listbox')).toBeNull()
  expect(saved).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Save event' }))
  await waitFor(() => expect(saved).toHaveBeenCalled())
  expect(JSON.parse((fetcher.mock.calls.at(-1)![1] as RequestInit).body as string).action_id).toBe(8)
})

test('picker lists all actions on focus, filters, and keeps the link when a search is dismissed', async () => {
  const user = userEvent.setup(), close = vi.fn()
  const choices = [item.action!, { id: 8, title: 'Electrical work' }]
  const fetcher = vi.fn<Fetcher>(async url => {
    const query = new URL(url, 'http://localhost').searchParams.get('q') || ''
    return response({ items: choices.filter(value => value.title.toLowerCase().includes(query.toLowerCase())), total: 2, page: 1, pages: 1 })
  })
  vi.stubGlobal('fetch', fetcher)
  mount(<EventEditor value={item} timezone="Europe/Madrid" close={close} saved={vi.fn()} />)
  const field = screen.getByRole('combobox', { name: 'Linked action (optional)' })
  await user.click(field)
  expect(await screen.findByRole('option', { name: item.action!.title })).toHaveAttribute('aria-selected', 'true')
  expect(screen.getByRole('option', { name: 'Electrical work' })).toBeVisible()
  fireEvent.scroll(screen.getByRole('dialog'))
  fireEvent.resize(window)
  expect(field).toHaveAttribute('aria-expanded', 'true')
  expect(screen.getByRole('option', { name: 'Electrical work' })).toBeVisible()
  await user.type(field, 'Elec')
  await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(1))
  expect(screen.getByRole('option', { name: 'Electrical work' })).toBeVisible()
  await user.keyboard('{Escape}')
  expect(screen.queryByRole('listbox')).toBeNull()
  expect(field).toHaveValue(item.action!.title)
  expect(field).toHaveFocus()
  expect(close).not.toHaveBeenCalled()
  await user.click(field)
  expect(await screen.findByRole('option', { name: item.action!.title })).toBeVisible()
  await user.type(field, 'No matches here')
  expect(await screen.findByText('No matching actions.')).toBeVisible()
  await user.tab()
  expect(field).toHaveValue(item.action!.title)
  expect(screen.queryByRole('listbox')).toBeNull()
  await user.click(screen.getByRole('button', { name: 'Remove link' }))
  expect(field).toHaveValue('')
  expect(field).toHaveFocus()
  expect(screen.queryByRole('button', { name: 'Remove link' })).toBeNull()
})

test('picker supports paging and mouse selection without closing when its pager receives focus', async () => {
  const user = userEvent.setup()
  const fetcher = vi.fn<Fetcher>(async url => {
    const page = Number(new URL(url, 'http://localhost').searchParams.get('page'))
    return response({ items: page === 1 ? [item.action] : [{ id: 21, title: 'Last action' }], total: 21, page, pages: 2 })
  })
  vi.stubGlobal('fetch', fetcher)
  mount(<EventEditor value={item} timezone="Europe/Madrid" close={vi.fn()} saved={vi.fn()} />)
  const field = screen.getByRole('combobox', { name: 'Linked action (optional)' })
  await user.click(field)
  await user.click(await screen.findByRole('button', { name: 'Next: available actions' }))
  await user.click(await screen.findByRole('option', { name: 'Last action' }))
  expect(field).toHaveValue('Last action')
  expect(field).toHaveFocus()
  expect(screen.queryByRole('listbox')).toBeNull()
})

test('picker exposes failed loading with a retry, not a false empty catalogue', async () => {
  const user = userEvent.setup()
  const fetcher = vi.fn<Fetcher>().mockResolvedValueOnce(response({ code: 'internal_error' }, 500))
    .mockResolvedValueOnce(response({ items: [item.action], total: 1, page: 1, pages: 1 }))
  vi.stubGlobal('fetch', fetcher)
  mount(<EventEditor value={item} timezone="Europe/Madrid" close={vi.fn()} saved={vi.fn()} />)
  await user.click(screen.getByRole('combobox', { name: 'Linked action (optional)' }))
  expect(await screen.findByRole('alert')).toBeVisible()
  expect(screen.queryByText('No matching actions.')).toBeNull()
  await user.click(screen.getByRole('button', { name: 'Retry loading actions' }))
  expect(await screen.findByRole('option', { name: item.action!.title })).toBeVisible()
})

test('calendar options require confirmation and download a private ICS instead of claiming it was saved', async () => {
  const google = 'https://calendar.google.com/calendar/render?action=TEMPLATE&text=Revision'
  const fetcher = vi.fn<Fetcher>(async (url: string) => url.endsWith('/calendar')
    ? response({ google_url: google, google_error: null })
    : new Response('BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n', { headers: { 'Content-Type': 'text/calendar' } }))
  vi.stubGlobal('fetch', fetcher)
  const create = vi.fn(() => 'blob:calendar')
  vi.stubGlobal('URL', class extends URL { static createObjectURL = create; static revokeObjectURL = vi.fn() })
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  mount(<CalendarButton value={item} />)
  const calendar = screen.getByRole('button', { name: 'Add to my calendar' })
  expect(calendar.textContent).toBe('')
  expect(calendar).toHaveAttribute('title', 'Add to my calendar')
  expect(calendar.querySelector('svg')).not.toBeNull()
  fireEvent.click(calendar)
  expect(await screen.findByRole('link', { name: 'Google Calendar' })).toHaveAttribute('href', google)
  expect(screen.getByText(/not synced/)).toBeVisible()
  fireEvent.click(screen.getByRole('button', { name: 'Other calendars (.ics)' }))
  await waitFor(() => expect(click).toHaveBeenCalledOnce())
  expect(click.mock.contexts[0]).toHaveProperty('download', 'event-1.ics')
  expect(create).toHaveBeenCalledWith(expect.any(Blob))
  expect(fetcher).toHaveBeenLastCalledWith('/api/events/1/calendar.ics', expect.objectContaining({
    method: 'GET', credentials: 'same-origin',
  }))
  expect(screen.queryByText(/saved to your calendar/i)).toBeNull()
})

test('action visibility changes hide even previously cached links and history snapshots', async () => {
  mount(<EventSnapshotView value={item} zone="Europe/Madrid" />)
  expect(screen.getByRole('link', { name: item.action!.title })).toBeVisible()
  await act(async () => { cache.setQueryData(['features'], { ...flags, actions: false }) })
  await waitFor(() => expect(screen.queryByText(item.action!.title)).toBeNull())
  expect(screen.getByText(item.title)).toBeVisible()
})

test('late private event responses and downloads cannot restore disabled data', async () => {
  let finish: (response: Response) => void = () => { throw new Error('Not started') }
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { finish = resolve })))
  const pending = api<EventOut>('/events/1').catch(error => error)
  await refreshEventData(false)
  finish(response(item))
  expect(await pending).toMatchObject({ code: 'event_features_changed' })
  const downloading = downloadFile('/events/1/calendar.ics', 'event-1.ics').catch(error => error)
  await refreshEventData(false)
  finish(new Response('BEGIN:VCALENDAR'))
  expect(await downloading).toBeInstanceOf(ApiError)
})

test('confirmed writes survive a flag change but cannot repopulate a disabled event cache', async () => {
  let finish: (response: Response) => void = () => { throw new Error('Not started') }
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { finish = resolve })))
  const pending = api<EventOut>('/events', 'POST', eventBody(eventDraft(item, 'Europe/Madrid'), 'Europe/Madrid', false))
  cache.setQueryData(['features'], { ...flags, events: false })
  await refreshEventData(false)
  finish(response(item, 201))
  const saved = await pending
  expect(saved.id).toBe(item.id)
  cacheEvent(saved)
  expect(cache.getQueryData(['events', 'item', item.id])).toBeUndefined()
  cache.setQueryData(['features'], { ...flags, actions: false })
  cacheEvent(saved)
  expect(cache.getQueryData<EventOut>(['events', 'item', item.id])?.action).toBeNull()
})

test('action event panel is independently gated and lists events for that action', async () => {
  const fetcher = vi.fn<Fetcher>(async (url: string) => response(url.endsWith('/config')
    ? { timezone: 'Europe/Madrid' } : { items: [], total: 0, page: 1, pages: 1 }))
  vi.stubGlobal('fetch', fetcher)
  cache.setQueryData(['features'], { ...flags, events: false })
  mount(<ActionEvents action={item.action!} />)
  expect(fetcher).not.toHaveBeenCalled()
  await act(async () => { cache.setQueryData(['features'], flags) })
  expect(await screen.findByText('This action has no upcoming events yet.')).toBeVisible()
  expect(fetcher.mock.calls.some(call => String(call[0]).includes('action_id=7'))).toBe(true)
  fireEvent.click(screen.getByRole('checkbox', { name: 'Show past events' }))
  expect(await screen.findByText('This action has no events yet.')).toBeVisible()
})

test('the action panel shows the complete timeline and opens events over the action', async () => {
  const user = userEvent.setup()
  const finished = { ...item, id: 2, title: 'Finished visit' }
  cache.setQueryData(['events', 'item', finished.id], finished)
  const fetcher = vi.fn<Fetcher>(async url => response(new URL(url, 'http://localhost').searchParams.get('scope') === 'all'
    ? { items: [{ ...occurrence, event: finished, is_past: true }, occurrence], total: 2, page: 1, pages: 1 }
    : { items: [occurrence], total: 1, page: 1, pages: 1 }))
  vi.stubGlobal('fetch', fetcher)
  mount(<><ActionEvents action={item.action!} /><LocationProbe /></>, ['/actions/7?view=board'])
  expect(await screen.findByRole('heading', { name: 'Upcoming events' })).toBeVisible()
  expect(await screen.findByRole('link', { name: item.title })).toBeVisible()
  expect(screen.queryByRole('link', { name: finished.title })).toBeNull()
  expect(screen.getByRole('link', { name: 'View events for this action' })).toHaveAttribute('href', '/events?action_id=7')
  await user.click(screen.getByRole('checkbox', { name: 'Show past events' }))
  expect(await screen.findByRole('heading', { name: 'All events' })).toBeVisible()
  const past = (await screen.findByRole('link', { name: finished.title })).closest('li')!
  expect(past).toHaveClass('event-past')
  expect(screen.getByRole('link', { name: item.title }).closest('li')).not.toHaveClass('event-past')
  expect(Object.fromEntries(new URL(String(fetcher.mock.calls.at(-1)![0]), 'http://localhost').searchParams)).toEqual({
    action_id: '7', scope: 'all',
  })
  expect(screen.getByRole('link', { name: 'View events for this action' })).toHaveAttribute('href', '/events?action_id=7&scope=all')
  await user.click(screen.getByRole('link', { name: finished.title }))
  const dialog = await screen.findByRole('dialog', { name: finished.title })
  expect(screen.getByTestId('location')).toHaveTextContent('/actions/7?view=board&event=2')
  await user.click(within(dialog).getByRole('button', { name: 'Close' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(screen.getByTestId('location')).toHaveTextContent(/^\/actions\/7\?view=board$/)
  expect(screen.getByRole('checkbox', { name: 'Show past events' })).toBeChecked()
  expect(screen.getByRole('link', { name: finished.title })).toBeVisible()
})
