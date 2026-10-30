import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import type { EventAgendaPage, EventCalendarOut, EventHistoryPage, EventOut, EventPage } from '../../api/schema.gen'
import { signInResident } from '../core'
import { resetDemo } from '../store'
import { communityStore } from '../store/community'
import { dayNumber, zonedDay } from '../store/community-time'
import { coreStore } from '../store/core'
import { demoFetch, demoRequest, demoUrl } from '../testing'

// Thursday 29 October 2026, midday (local time), like the other demo tests.
const NOW = new Date(2026, 9, 29, 12)
const OLIVIA = { kind: 'resident', name: 'Olivia Bennett', user_id: 6 }

// The clock can move during a test without rebuilding the data (the backend tests patch `utcnow`).
let clock = NOW
beforeEach(() => {
  clock = NOW
  resetDemo({ now: () => clock })
})
afterEach(() => resetDemo())

const get = <T = unknown>(path: string) => demoRequest<T>('GET', path)

async function agenda(params: Record<string, string | number> = {}): Promise<EventAgendaPage> {
  const response = await get<EventAgendaPage>(`/api/events/agenda?${new URLSearchParams(Object.entries(params).map(([key, value]) => [key, String(value)]))}`)
  expect(response.status).toBe(200)
  return response.body
}

async function list(params: Record<string, string | number> = {}): Promise<EventPage> {
  return (await get<EventPage>(`/api/events?${new URLSearchParams(Object.entries(params).map(([key, value]) => [key, String(value)]))}`)).body
}

const eventBody = (fields: Record<string, unknown> = {}) => ({
  title: 'Lift service visit', description: 'Technical visit', location: 'Entrance hall', timezone: 'Europe/Madrid',
  all_day: false, starts_at: '2030-05-10T18:00:00', ends_at: '2030-05-10T20:00:00', ...fields,
})

async function create(fields: Record<string, unknown> = {}): Promise<EventOut> {
  const response = await demoRequest<EventOut>('POST', '/api/events', { body: eventBody(fields) })
  expect(response.status, JSON.stringify(response.body)).toBe(201)
  return response.body
}

const fullDay = (start: string, end: string, fields: Record<string, unknown> = {}) => create({
  all_day: true, starts_at: null, ends_at: null, starts_on: start, ends_on: end, ...fields,
})

/** An empty calendar at `instant`, to replay the backend's agenda tests. */
function emptyCalendar(instant: string): void {
  moveClock(instant)
  const state = communityStore()
  state.events.length = 0
  state.eventHistory.length = 0
}

/** Moves the clock; the visitor signs in again (demo sessions last 12 hours). */
function moveClock(instant: string): void {
  clock = new Date(instant)
  signInResident(6)
}

function eventId(title: string): number {
  const event = communityStore().events.find(item => item.title.startsWith(title))
  if (!event) throw new Error(`No event "${title}"`)
  return event.id
}

describe('the agenda of the scenario', () => {
  test('starts today: ongoing events continue and every entry is chronological', async () => {
    const today = zonedDay(NOW.getTime())
    const page = await agenda()
    expect(page.page).toBe(1)
    expect(page.items[0].day).toBe(today)
    const roof = page.items.find(entry => entry.event.title.startsWith('Roof works'))
    expect(roof).toMatchObject({ day: today, is_continuation: true, is_last_day: false, is_past: false })
    expect(page.items.find(entry => entry.event.title === 'Bulky waste collection')).toMatchObject({ day: today, is_continuation: false, is_last_day: true })
    expect(page.items.every(entry => !entry.is_past)).toBe(true)
    const days = page.items.map(entry => entry.day)
    expect(days).toEqual([...days].sort())
    for (const [index, entry] of page.items.entries()) {
      const previous = page.items[index - 1]
      if (!previous || previous.day !== entry.day) continue
      const time = (item: typeof entry) => item.is_continuation || item.event.all_day ? null : item.event.starts_at
      if (time(previous) !== null) expect(time(entry), entry.event.title).not.toBeNull()
    }
    const vote = page.items.find(entry => entry.event.title.startsWith("Residents' meeting"))
    expect(vote?.event).toMatchObject({ action: { title: 'Lift modernisation: controller, doors and cabin' }, location: 'Community room, ground floor' })
  })

  test('the complete timeline opens on the page that reaches today; past and deleted scopes go backwards', async () => {
    const today = zonedDay(NOW.getTime())
    const first = await agenda({ scope: 'all', page: 1 })
    const entries = [...first.items]
    for (let page = 2; page <= first.pages; page += 1) entries.push(...(await agenda({ scope: 'all', page })).items)
    expect(entries.map(entry => entry.day)).toEqual(entries.map(entry => entry.day).sort())
    const earlier = entries.filter(entry => entry.day < today).length
    expect((await agenda({ scope: 'all' })).page).toBe(Math.min(Math.floor(earlier / 20) + 1, first.pages))
    expect(entries.filter(entry => entry.is_past).length).toBeGreaterThan(5)
    expect(entries[0]).toMatchObject({ is_past: true })
    const past = await agenda({ scope: 'past' })
    expect(past.items.every(entry => entry.is_past)).toBe(true)
    expect(past.items.map(entry => entry.day)).toEqual(past.items.map(entry => entry.day).sort().reverse())
    const deleted = await agenda({ scope: 'deleted' })
    expect(deleted.items.map(entry => entry.event.title)).toEqual(['Car park gate repair visit'])
    expect(deleted.items[0].event.deleted_at).not.toBeNull()
  })

  test('filters by text and by action', async () => {
    expect((await agenda({ scope: 'all', q: 'LIFT' })).items.map(entry => entry.event.title)).toEqual(['Lift inspection', "Residents' meeting: lift modernisation vote"])
    const lift = communityStore().actions.find(action => action.title.startsWith('Lift'))?.id ?? 0
    const linked = await agenda({ scope: 'all', action_id: lift })
    expect(new Set(linked.items.map(entry => entry.event.action?.id))).toEqual(new Set([lift]))
    coreStore().features.actions = false
    expect(await get(`/api/events/agenda?action_id=${lift}`)).toMatchObject({ status: 404, body: { code: 'actions_disabled' } })
    expect((await agenda()).items.every(entry => entry.event.action === null)).toBe(true)
    for (const query of ['page=0', 'scope=unknown', 'action_id=0', `q=${'a'.repeat(201)}`]) expect((await get(`/api/events/agenda?${query}`)).status, query).toBe(422)
  })
})

describe('the agenda, like the backend', () => {
  test('a two-day event has one record and daily continuations', async () => {
    emptyCalendar('2026-01-01T00:00:00Z')
    const value = await fullDay('2030-05-10', '2030-05-12')
    const other = await create({ starts_at: '2030-05-11T10:00:00', ends_at: '2030-05-11T11:00:00' })
    const page = await agenda()
    expect([page.total, page.pages]).toEqual([3, 1])
    expect(page.items.map(entry => [entry.day, entry.event.id])).toEqual([['2030-05-10', value.id], ['2030-05-11', value.id], ['2030-05-11', other.id]])
    expect(page.items[0]).toMatchObject({ is_continuation: false, is_last_day: false })
    expect(page.items[1]).toMatchObject({ is_continuation: true, is_last_day: true })
    expect(page.items[0].event).toEqual(value)
    expect((await list()).total).toBe(2)
  })

  test.each([
    ['2030-05-10T23:00:00', '2030-05-11T01:00:00', ['2030-05-10', '2030-05-11']],
    ['2030-05-10T22:00:00', '2030-05-11T00:00:00', ['2030-05-10']],
    ['2026-03-28T23:00:00', '2026-03-30T00:00:00', ['2026-03-28', '2026-03-29']],
    ['2026-10-24T23:00:00', '2026-10-26T00:00:00', ['2026-10-24', '2026-10-25']],
  ])('timed days respect the exclusive midnight and daylight saving (%s)', async (start, end, days) => {
    emptyCalendar('2026-01-01T00:00:00Z')
    await create({ starts_at: start, ends_at: end })
    const entries = (await agenda()).items
    expect(entries.map(entry => entry.day)).toEqual(days)
    expect(entries[0].is_continuation).toBe(false)
    expect(entries.at(-1)?.is_last_day).toBe(true)
  })

  test('ongoing events start today; past and deleted keep reverse order', async () => {
    emptyCalendar('2026-01-01T00:00:00Z')
    const ongoing = await fullDay('2030-05-10', '2030-05-13')
    const finished = await fullDay('2030-05-08', '2030-05-10')
    moveClock('2030-05-10T22:00:00Z')
    expect((await agenda()).items.map(entry => entry.day)).toEqual(['2030-05-11', '2030-05-12'])
    expect((await agenda()).items.every(entry => entry.is_continuation)).toBe(true)
    const past = (await agenda({ scope: 'past' })).items
    expect(past.map(entry => entry.day)).toEqual(['2030-05-09', '2030-05-08'])
    expect(past.every(entry => entry.event.id === finished.id)).toBe(true)
    expect((await demoRequest('DELETE', `/api/events/${ongoing.id}`, { body: { version: 1 } })).status).toBe(204)
    expect((await agenda()).items).toEqual([])
    expect((await agenda({ scope: 'deleted' })).items.map(entry => entry.day)).toEqual(['2030-05-12', '2030-05-11', '2030-05-10'])
  })

  test('pagination orders every daily occurrence before slicing', async () => {
    emptyCalendar('2026-01-01T00:00:00Z')
    const spanning = await fullDay('2030-05-01', '2030-05-29')
    const expected: [string, string, number][] = Array.from({ length: 28 }, (_, index) => [`2030-05-${String(index + 1).padStart(2, '0')}`, '', spanning.id])
    for (let index = 0; index < 23; index += 1) {
      const day = `2030-05-${String((index * 7) % 23 + 1).padStart(2, '0')}`
      const value = await create({ title: `Visit ${index}`, starts_at: `${day}T10:00:00`, ends_at: `${day}T11:00:00` })
      expected.push([day, '10:00', value.id])
    }
    const order = (reverse: boolean) => [...expected].sort((a, b) => (reverse ? -1 : 1) * (a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]) || a[2] - b[2]))
    for (const [scope, reverse] of [['upcoming', false], ['past', true]] as const) {
      if (reverse) moveClock('2031-01-01T00:00:00Z')
      const pages = [await agenda({ scope, page: 1 }), await agenda({ scope, page: 2 }), await agenda({ scope, page: 3 })]
      expect(pages.map(page => [page.total, page.pages, page.items.length])).toEqual([[51, 3, 20], [51, 3, 20], [51, 3, 11]])
      expect(pages.flatMap(page => page.items.map(entry => [entry.day, entry.event.id]))).toEqual(order(reverse).map(([day, , id]) => [day, id]))
    }
  })

  test('long events stay bounded to the requested page', async () => {
    emptyCalendar('2026-01-01T00:00:00Z')
    await fullDay('2030-01-01', '9999-12-31')
    const first = await agenda(), second = await agenda({ page: 2 })
    expect(first.total).toBe(dayNumber('9999-12-31') - dayNumber('2030-01-01'))
    expect([first.items[0].day, first.items.at(-1)?.day, second.items[0].day]).toEqual(['2030-01-01', '2030-01-20', '2030-01-21'])
    expect(second.items.every(entry => entry.is_continuation)).toBe(true)
    expect((await agenda({ page: 1000000 })).items).toEqual([])
  })

  test('the complete timeline is chronological and marks only finished events', async () => {
    emptyCalendar('2026-01-01T00:00:00Z')
    const action = communityStore().actions[0]
    const finished = await fullDay('2030-05-01', '2030-05-03', { action_id: action.id })
    const ongoing = await fullDay('2030-05-09', '2030-05-12')
    const earlier = await create({ starts_at: '2030-05-10T08:00:00', ends_at: '2030-05-10T09:00:00' })
    const later = await create({ starts_at: '2030-05-10T18:00:00', ends_at: '2030-05-10T19:00:00', action_id: action.id })
    const removed = await fullDay('2030-05-10', '2030-05-11')
    expect((await demoRequest('DELETE', `/api/events/${removed.id}`, { body: { version: 1 } })).status).toBe(204)
    moveClock('2030-05-10T10:00:00Z')
    const page = await agenda({ scope: 'all' })
    expect([page.total, page.page, page.pages]).toEqual([7, 1, 1])
    expect(page.items.map(entry => [entry.day, entry.event.id, entry.is_continuation, entry.is_past])).toEqual([
      ['2030-05-01', finished.id, false, true], ['2030-05-02', finished.id, true, true],
      ['2030-05-09', ongoing.id, false, false], ['2030-05-10', ongoing.id, true, false],
      ['2030-05-10', earlier.id, false, true], ['2030-05-10', later.id, false, false],
      ['2030-05-11', ongoing.id, true, false],
    ])
    expect((await list({ scope: 'all' })).items.map(event => event.id)).toEqual([finished.id, ongoing.id, earlier.id, later.id])
  })

  test('the complete timeline opens on the page reaching today, or on its latest page', async () => {
    emptyCalendar('2030-05-10T10:00:00Z')
    expect(await agenda({ scope: 'all' })).toEqual({ items: [], total: 0, page: 1, pages: 1 })
    await fullDay('2030-03-01', '2030-04-15')
    await fullDay('2030-05-08', '2030-05-12')
    await fullDay('2030-05-20', '2030-07-01')
    const page = await agenda({ scope: 'all' })
    expect([page.total, page.page, page.pages]).toEqual([91, 3, 5])
    expect(page.items.slice(0, 9).map(entry => entry.day)).toEqual([
      '2030-04-10', '2030-04-11', '2030-04-12', '2030-04-13', '2030-04-14', '2030-05-08', '2030-05-09', '2030-05-10', '2030-05-11',
    ])
    expect(page.items.map(entry => entry.is_past)).toEqual([...Array(5).fill(true), ...Array(15).fill(false)])
    expect((await agenda()).page).toBe(1)
  })
})

describe('events', () => {
  test('creation converts the community wall clock to UTC and records the history', async () => {
    emptyCalendar('2026-01-01T00:00:00Z')
    const value = await create({ title: '  Lift   service visit ', location: '  ', description: ' Bring keys\r\n ' })
    expect(value).toMatchObject({
      title: 'Lift service visit', location: '', description: 'Bring keys', all_day: false,
      starts_at: '2030-05-10T16:00:00Z', ends_at: '2030-05-10T18:00:00Z', starts_on: null, ends_on: null,
      action: null, author: OLIVIA, version: 1, deleted_at: null,
    })
    expect((await get(`/api/events/${value.id}`)).body).toEqual(value)
    const history = (await get<EventHistoryPage>(`/api/events/${value.id}/history`)).body
    expect(history.items).toEqual([expect.objectContaining({ kind: 'created', author: OLIVIA, before: null, after: expect.objectContaining({ title: 'Lift service visit' }) })])
    for (const [start, end, instants] of [
      ['2026-03-29T01:30:00', '2026-03-29T04:30:00', ['2026-03-29T00:30:00Z', '2026-03-29T02:30:00Z']],
      ['2026-10-25T01:30:00', '2026-10-25T04:30:00', ['2026-10-24T23:30:00Z', '2026-10-25T03:30:00Z']],
      ['2027-01-10T18:00', '2027-01-10T19:00:00.000', ['2027-01-10T17:00:00Z', '2027-01-10T18:00:00Z']],
    ]) {
      const saved = await create({ starts_at: start, ends_at: end })
      expect([saved.starts_at, saved.ends_at]).toEqual(instants)
    }
  })

  test('validation reports the backend field codes and never saves', async () => {
    emptyCalendar('2026-01-01T00:00:00Z')
    const cases: [Record<string, unknown>, Record<string, string> | undefined][] = [
      [{ title: '   ' }, { title: 'event_field_invalid' }],
      [{ title: 'x'.repeat(201) }, { title: 'event_field_invalid' }],
      [{ description: 'x'.repeat(20001) }, { description: 'event_field_invalid' }],
      [{ location: 'x'.repeat(201) }, { location: 'event_field_invalid' }],
      [{ starts_at: null }, { interval: 'event_interval_invalid' }],
      [{ ends_at: '2030-05-10T17:00:00' }, { interval: 'event_interval_invalid' }],
      [{ starts_at: '2030-05-10T18:00:00Z' }, { starts_at: 'event_interval_invalid' }],
      [{ all_day: 'false' }, { all_day: 'event_interval_invalid' }],
      [{ all_day: true }, { interval: 'event_interval_invalid' }],
      [{ action_id: 0 }, { action_id: 'event_field_invalid' }],
      [{ unexpected: true }, undefined],
      [{ all_day: true, starts_at: null, ends_at: null, starts_on: '2030-05-10', ends_on: '2030-05-10' }, { interval: 'event_interval_invalid' }],
    ]
    for (const [fields, expected] of cases) {
      const response = await demoRequest<{ code: string; fields?: Record<string, string> }>('POST', '/api/events', { body: eventBody(fields) })
      expect(response.status, JSON.stringify(fields)).toBe(422)
      expect(response.body, JSON.stringify(fields)).toEqual(expected ? { code: 'invalid_request', fields: expected } : { code: 'invalid_request' })
    }
    expect(await demoRequest('POST', '/api/events', { body: eventBody({ starts_at: '2026-03-29T02:30:00', ends_at: '2026-03-29T04:00:00' }) }))
      .toMatchObject({ status: 422, body: { code: 'event_time_nonexistent', fields: { starts_at: 'event_time_nonexistent' } } })
    expect(await demoRequest('POST', '/api/events', { body: eventBody({ starts_at: '2026-10-25T02:30:00', ends_at: '2026-10-25T04:00:00' }) }))
      .toMatchObject({ status: 422, body: { code: 'event_time_ambiguous', fields: { starts_at: 'event_time_ambiguous' } } })
    expect(await demoRequest('POST', '/api/events', { body: eventBody({ timezone: 'UTC' }) })).toMatchObject({ status: 409, body: { code: 'event_timezone_changed' } })
    expect(await demoRequest('POST', '/api/events', { body: eventBody({ action_id: 2147483647 }) }))
      .toMatchObject({ status: 422, body: { code: 'event_action_not_found', fields: { action_id: 'event_action_not_found' } } })
    expect(await demoRequest('POST', '/api/events', { body: eventBody(), mutationHeader: false })).toMatchObject({ status: 403, body: { code: 'invalid_origin' } })
    expect(communityStore().events).toEqual([])
  })

  test('edits need the current version, keep the history and can link or unlink an action', async () => {
    emptyCalendar('2026-01-01T00:00:00Z')
    const action = communityStore().actions[4]
    const value = await create({ action_id: action.id })
    expect(value.action).toEqual({ id: action.id, title: action.title })
    const path = `/api/events/${value.id}`
    const changed = await demoRequest<EventOut>('PATCH', path, { body: eventBody({ version: 1, title: 'Lift inspection and survey' }) })
    expect(changed).toMatchObject({ status: 200, body: { version: 2, title: 'Lift inspection and survey', action: { id: action.id } } })
    expect(await demoRequest('PATCH', path, { body: eventBody({ version: 1, title: 'Late' }) })).toMatchObject({ status: 409, body: { code: 'event_stale' } })
    expect((await demoRequest<EventOut>('PATCH', path, { body: eventBody({ version: 2, title: 'Lift inspection and survey' }) })).body).toEqual(changed.body)
    const unlinked = await demoRequest<EventOut>('PATCH', path, { body: eventBody({ version: 2, title: 'Lift inspection and survey', action_id: null }) })
    expect(unlinked.body).toMatchObject({ version: 3, action: null })
    coreStore().features.actions = false
    expect(await demoRequest('PATCH', path, { body: eventBody({ version: 3, action_id: action.id }) })).toMatchObject({ status: 404, body: { code: 'actions_disabled' } })
    coreStore().features.actions = true
    const history = (await get<EventHistoryPage>(`${path}/history`)).body.items
    expect(history.map(item => item.kind)).toEqual(['updated', 'updated', 'created'])
    expect(history[1]).toMatchObject({ before: { title: 'Lift service visit' }, after: { title: 'Lift inspection and survey' } })
    expect(history[0]).toMatchObject({ before: { action: { id: action.id } }, after: { action: null } })
  })

  test('deleted events stay readable with their history but cannot change or export', async () => {
    const id = eventId('Window cleaning')
    const path = `/api/events/${id}`
    const value = (await get<EventOut>(path)).body
    expect(await demoRequest('DELETE', path, { body: { version: value.version + 1 } })).toMatchObject({ status: 409, body: { code: 'event_stale' } })
    expect(await demoRequest('DELETE', path, { body: {} })).toEqual(expect.objectContaining({ status: 422, body: { code: 'invalid_request' } }))
    expect((await demoRequest('DELETE', path, { body: { version: value.version } })).status).toBe(204)
    expect((await get<EventOut>(path)).body).toMatchObject({ deleted_at: NOW.toISOString(), version: value.version + 1 })
    expect(await demoRequest('PATCH', path, { body: eventBody({ version: value.version + 1 }) })).toMatchObject({ status: 409, body: { code: 'event_deleted' } })
    expect(await demoRequest('DELETE', path, { body: { version: value.version + 1 } })).toMatchObject({ status: 409, body: { code: 'event_deleted' } })
    expect(await get(`${path}/calendar`)).toMatchObject({ status: 409, body: { code: 'event_deleted' } })
    expect(await get(`${path}/calendar.ics`)).toMatchObject({ status: 409, body: { code: 'event_deleted' } })
    expect((await get<EventHistoryPage>(`${path}/history`)).body.items.map(item => item.kind)).toEqual(['deleted', 'created'])
    expect((await list({ scope: 'deleted' })).items.map(event => event.id)).toEqual([id, eventId('Car park gate')])
    expect(await get('/api/events/9999')).toMatchObject({ status: 404, body: { code: 'event_not_found' } })
  })

  test('the list is chronological, searchable and paged across all matches', async () => {
    emptyCalendar('2026-01-01T00:00:00Z')
    const values: EventOut[] = []
    for (let index = 0; index < 23; index += 1) {
      const day = `2030-05-${String((index * 7) % 23 + 1).padStart(2, '0')}`
      values.push(await create({ title: `Revision ${index}`, starts_at: `${day}T18:00:00`, ends_at: `${day}T19:00:00` }))
    }
    const first = await list({ q: 'revision' }), second = await list({ q: 'REVISION', page: 2 })
    expect([first.total, first.pages, first.items.length, second.items.length]).toEqual([23, 2, 20, 3])
    expect([...first.items, ...second.items].map(event => event.id)).toEqual(
      [...values].sort((a, b) => (a.starts_at ?? '').localeCompare(b.starts_at ?? '') || a.id - b.id).map(event => event.id))
    expect((await list({ q: 'no-match' })).total).toBe(0)
    for (const query of ['page=0', 'scope=unknown']) expect((await get(`/api/events?${query}`)).status).toBe(422)
  })

  test('history and items hide action links while actions are off', async () => {
    const id = eventId('Lift inspection')
    coreStore().features.actions = false
    expect((await get<EventOut>(`/api/events/${id}`)).body.action).toBeNull()
    expect((await get<EventHistoryPage>(`/api/events/${id}/history`)).body.items[0].after?.action).toBeNull()
    coreStore().features.actions = true
    expect((await get<EventHistoryPage>(`/api/events/${id}/history`)).body.items[0].after?.action).toEqual({ id: expect.any(Number), title: 'Lift modernisation' })
  })
})

describe('calendar exports and access', () => {
  test('offer a Google Calendar link and an iCalendar file', async () => {
    const id = eventId("Residents' meeting")
    const links = (await get<EventCalendarOut>(`/api/events/${id}/calendar`)).body
    const url = new URL(links.google_url ?? '')
    expect(url.origin + url.pathname).toBe('https://calendar.google.com/calendar/render')
    expect(url.searchParams.get('text')).toBe("Residents' meeting: lift modernisation vote")
    expect(url.searchParams.get('ctz')).toBe('Europe/Madrid')
    expect(url.searchParams.get('details')).toMatch(new RegExp(`\\n\\n${demoUrl('/').origin}/events/${id}$`))
    const response = await demoFetch(new Request(demoUrl(`/api/events/${id}/calendar.ics`)))
    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('text/calendar; charset=utf-8')
    expect(response.headers.get('Content-Disposition')).toBe(`attachment; filename="event-${id}.ics"`)
    const text = await response.text()
    const event = communityStore().events.find(item => item.id === id)
    expect(text).toContain(`\r\nUID:${event?.calendarUid}@juntia\r\n`)
    expect(text).toContain(`\r\nSEQUENCE:${(event?.version ?? 0) - 1}\r\n`)
    expect(text).toContain(`\r\nDTSTART:${event?.startsAt?.replace(/[-:]/g, '')}\r\nDTEND:${event?.endsAt?.replace(/[-:]/g, '')}\r\n`)
    expect(text.endsWith('END:VEVENT\r\nEND:VCALENDAR\r\n')).toBe(true)
    const allDay = await demoFetch(new Request(demoUrl(`/api/events/${eventId('Access control')}/calendar.ics`)))
    expect(await allDay.text()).toMatch(/\r\nDTSTART;VALUE=DATE:\d{8}\r\nDTEND;VALUE=DATE:\d{8}\r\n/)
  })

  test('need a session and the events feature', async () => {
    const id = eventId('Lift inspection')
    const routes = ['/api/events', '/api/events/agenda', '/api/events/config', `/api/events/${id}`, `/api/events/${id}/history`, `/api/events/${id}/calendar`, `/api/events/${id}/calendar.ics`]
    expect((await get('/api/events/config')).body).toEqual({ timezone: 'Europe/Madrid' })
    coreStore().features.events = false
    for (const route of routes) expect(await get(route), route).toMatchObject({ status: 404, body: { code: 'events_disabled' } })
    for (const [method, route] of [['POST', '/api/events'], ['PATCH', `/api/events/${id}`], ['DELETE', `/api/events/${id}`]]) {
      expect(await demoRequest(method, route, { body: '{invalid' }), route).toMatchObject({ status: 404, body: { code: 'events_disabled' } })
    }
    coreStore().features.events = true
    await demoRequest('POST', '/api/auth/logout')
    for (const route of routes) expect(await get(route), route).toMatchObject({ status: 401 })
    await demoRequest('POST', '/api/admin/auth/login', { body: { username: 'demo', password: 'demo' } })
    const created = await create()
    expect(created.author).toEqual({ kind: 'administrator', name: 'Technical administrator', user_id: null })
  })
})
