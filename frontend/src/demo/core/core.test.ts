import { HttpResponse, getResponse, http } from 'msw'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { resetDemo } from '../store'
import { coreStore } from '../store/core'
import {
  Body, DemoApiError, IdSequence, Random, actorOf, addDays, addMonths, daysAgo, daysAhead, daysBetween, demoRandom,
  demoUnavailable, displayName, endOfMonth, hoursFromNow, idParam, instant, isDay, monthsAgo, normalizePhone, now,
  pageCount, pageParam, paginate, parseBody, queryBool, queryChoice, queryDay, queryInt, queryInts, queryText,
  readerIdentity, requireAdmin, requireAnySession, requireResident, revokeResidentSessions, route, sequenceAfter,
  setClock, signInAdmin, signOutAdmin, signOutResident, startOfMonth, today, type Access, type RouteOptions,
} from '.'

// Thursday 29 October 2026, midday (local time).
const NOW = new Date(2026, 9, 29, 12, 0)

beforeEach(() => resetDemo({ now: () => NOW }))
afterEach(() => resetDemo())

async function failure(action: () => unknown): Promise<{ code: string; status: number; fields?: unknown }> {
  try {
    await action()
  } catch (error) {
    if (error instanceof DemoApiError) return { code: error.code, status: error.status, ...(error.fields ? { fields: error.fields } : {}) }
    throw error
  }
  throw new Error('Expected a DemoApiError')
}

describe('random', () => {
  test('a seed always gives the same numbers, within the requested ranges', () => {
    const first = new Random(42), second = new Random(42)
    const values = Array.from({ length: 50 }, () => first.random())
    expect(Array.from({ length: 50 }, () => second.random())).toEqual(values)
    expect(values.every(value => value >= 0 && value < 1)).toBe(true)
    const random = new Random(7)
    for (let index = 0; index < 200; index += 1) {
      expect(random.between(3, 5)).toBeGreaterThanOrEqual(3)
      expect(random.between(3, 5)).toBeLessThanOrEqual(5)
      expect(random.below(4)).toBeLessThan(4)
      const uniform = random.uniform(10, 20)
      expect(uniform).toBeGreaterThanOrEqual(10)
      expect(uniform).toBeLessThan(20)
    }
  })

  test('shuffles without losing items, picks from a list and builds version 4 UUIDs', () => {
    const random = new Random(1)
    expect(random.shuffled([1, 2, 3, 4, 5]).sort()).toEqual([1, 2, 3, 4, 5])
    expect(['a', 'b', 'c']).toContain(random.choice(['a', 'b', 'c']))
    expect(() => random.choice([])).toThrow()
    expect(random.uuid()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect([random.chance(0), random.chance(1)]).toEqual([false, true])
  })

  test('each part of the demo has its own stream', () => {
    const finance = demoRandom('finance').random()
    expect(demoRandom('finance').random()).toBe(finance)
    expect(demoRandom('community').random()).not.toBe(finance)
  })
})

describe('clock', () => {
  test('dates are relative to the pinned today', () => {
    expect(now()).toEqual(NOW)
    expect(today()).toBe('2026-10-29')
    expect(daysAgo(30)).toBe('2026-09-29')
    expect(daysAhead(3)).toBe('2026-11-01')
    expect(monthsAgo(13)).toBe('2025-09-29')
    expect(startOfMonth('2026-10-29')).toBe('2026-10-01')
    expect(endOfMonth('2024-02-10')).toBe('2024-02-29')
    expect(daysBetween('2026-10-01', '2026-10-29')).toBe(28)
    expect(daysBetween('2026-10-29', '2026-10-01')).toBe(-28)
  })

  test('adding days and months follows the calendar, across DST changes and month ends', () => {
    expect(addDays('2026-03-28', 2)).toBe('2026-03-30')
    expect(addDays('2026-10-24', 3)).toBe('2026-10-27')
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28')
    expect(addMonths('2024-03-31', -1)).toBe('2024-02-29')
    expect(addMonths('2026-10-29', -12)).toBe('2025-10-29')
    expect(isDay('2026-02-29')).toBe(false)
    expect(isDay('2026-13-01')).toBe(false)
    expect(isDay('29/10/2026')).toBe(false)
    expect(() => addDays('2026-02-30', 1)).toThrow()
  })

  test('instants are ISO strings of local times', () => {
    expect(new Date(instant('2026-10-29', '18:30'))).toEqual(new Date(2026, 9, 29, 18, 30))
    expect(hoursFromNow(12)).toBe(new Date(2026, 9, 30, 0, 0).toISOString())
    expect(() => instant('2026-10-29', '6pm')).toThrow()
  })
})

describe('ids and pages', () => {
  test('sequences never hand out an id twice', () => {
    const sequence = new IdSequence()
    expect([sequence.next(), sequence.next()]).toEqual([1, 2])
    sequence.observe(10)
    sequence.observe(4)
    expect(sequence.next()).toBe(11)
    expect(sequenceAfter([3, 9, 5]).next()).toBe(10)
    expect(sequenceAfter([]).current).toBe(0)
  })

  test('pages follow the backend: at least one page, empty past the end', () => {
    const items = Array.from({ length: 45 }, (_, index) => index + 1)
    expect(paginate(items, 1, 20)).toEqual({ items: items.slice(0, 20), page: 1, pages: 3, total: 45 })
    expect(paginate(items, 3, 20).items).toEqual([41, 42, 43, 44, 45])
    expect(paginate(items, 4, 20)).toEqual({ items: [], page: 4, pages: 3, total: 45 })
    expect(paginate([], 1, 50)).toEqual({ items: [], page: 1, pages: 1, total: 0 })
    expect(pageCount(50, 50)).toBe(1)
    expect(pageCount(51, 50)).toBe(2)
  })
})

describe('sessions', () => {
  test('the demo opens with the sample neighbor; the administrator wins when both are signed in', () => {
    expect(readerIdentity()).toMatchObject({ kind: 'resident', resident: { id: 6, name: 'Olivia Bennett' } })
    expect(requireResident().email).toBe('olivia.bennett@example.com')
    signInAdmin()
    expect(readerIdentity()).toEqual({ kind: 'administrator' })
    expect(requireAdmin()).toEqual({ kind: 'administrator' })
    expect(actorOf(requireAnySession())).toEqual({ kind: 'administrator', name: 'Technical administrator', user_id: null })
  })

  test('guards answer like the backend', async () => {
    signInAdmin()
    expect(await failure(requireResident)).toEqual({ code: 'resident_profile_required', status: 403 })
    signOutAdmin()
    expect(await failure(requireAdmin)).toEqual({ code: 'authentication_required', status: 401 })
    expect(actorOf(requireAnySession())).toEqual({ kind: 'resident', name: 'Olivia Bennett', user_id: 6 })
    signOutResident()
    expect(readerIdentity()).toBeNull()
    expect(await failure(requireAnySession)).toEqual({ code: 'authentication_required', status: 401 })
    expect(await failure(requireResident)).toEqual({ code: 'authentication_required', status: 401 })
  })

  test('a session ends when it expires, when the account is disabled or when it is revoked', () => {
    coreStore()
    setClock(() => new Date(NOW.getTime() + 11 * 3_600_000))
    expect(readerIdentity()).not.toBeNull()
    setClock(() => new Date(NOW.getTime() + 13 * 3_600_000))
    expect(readerIdentity()).toBeNull()

    setClock(() => NOW)
    const resident = requireResident()
    resident.disabled = true
    expect(readerIdentity()).toBeNull()
    resident.disabled = false
    revokeResidentSessions(5)
    expect(readerIdentity()).not.toBeNull()
    revokeResidentSessions(6)
    expect(readerIdentity()).toBeNull()
  })
})

describe('validation', () => {
  test('reads a contract and refuses unknown fields', () => {
    const read = (body: Body) => ({
      name: body.name('name'),
      email: body.email('email'),
      phone: body.phone('phone'),
      dwelling: body.int('dwelling_id'),
      notes: body.text('notes', { max: 10, fallback: '' }),
      color: body.optionalText('color', { max: 7 }),
      kind: body.literal('kind', ['a', 'b'] as const, 'a'),
      tags: body.ids('tags', { unique: true }),
      coefficient: body.decimal('coefficient', { min: 0, max: 100, places: 2, nullable: true }),
      starts: body.day('starts_on', { nullable: true }),
      enabled: body.bool('enabled', true),
      version: body.optionalInt('version'),
    })
    expect(parseBody({ name: '  Grace   Liu ', email: 'Grace.Liu@Example.com', phone: '+44 20 7946 0876', dwelling_id: 6, tags: [2, 1], coefficient: '8.9', starts_on: '2026-11-02' }, read)).toEqual({
      name: 'Grace Liu', email: 'grace.liu@example.com', phone: '+442079460876', dwelling: 6, notes: '', color: null,
      kind: 'a', tags: [2, 1], coefficient: '8.90', starts: '2026-11-02', enabled: true, version: null,
    })
    let caught: unknown
    try {
      parseBody({ name: '\u0007', email: 'nope', phone: '12', dwelling_id: 0, notes: 'x'.repeat(11), kind: 'c', tags: [1, 1], coefficient: 8.123, starts_on: '2026-02-30', enabled: 'yes', extra: 1 }, read)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(DemoApiError)
    expect(caught).toMatchObject({
      code: 'invalid_request', status: 422, payload: { code: 'invalid_request' },
      invalid: {
        name: 'value_error', email: 'value_error', phone: 'value_error', dwelling_id: 'greater_than_equal',
        notes: 'string_too_long', kind: 'literal_error', tags: 'value_error', coefficient: 'decimal_max_places',
        starts_on: 'date_from_datetime_parsing', enabled: 'bool_type', extra: 'extra_forbidden',
      },
    })
  })

  test('nested lists report their fields, and routes can map them to their own codes', async () => {
    const read = (body: Body) => body.list('new_tags', { max: 2 }, tag => ({ name: tag.name('name', { max: 100 }), color: tag.text('color', { max: 7 }) }))
    expect(parseBody({ new_tags: [{ name: ' Plumber ', color: '#123456' }] }, read)).toEqual([{ name: 'Plumber', color: '#123456' }])
    const mapped = await failure(() => parseBody({ new_tags: [{ name: '', color: '#123456' }, { name: 'Ok' }] }, read, {
      fields: invalid => Object.fromEntries(Object.keys(invalid).map(field => ['tags', field.endsWith('.name') ? 'contact_tag_name_invalid' : 'contact_tag_color_invalid'])),
    }))
    expect(mapped).toEqual({ code: 'invalid_request', status: 422, fields: { tags: 'contact_tag_color_invalid' } })
    expect(await failure(() => parseBody([], read))).toEqual({ code: 'invalid_request', status: 422 })
    expect(await failure(() => parseBody({ zones: 'x' }, body => body.int('zones'), { code: 'dwelling_layout_invalid' })))
      .toEqual({ code: 'dwelling_layout_invalid', status: 422 })
  })

  test('names and phones follow the backend normalizers', () => {
    expect(displayName('  Flat   1A ')).toBe('Flat 1A')
    expect(displayName('   ')).toBeNull()
    expect(displayName('Tab\there')).toBeNull()
    expect(displayName('Line\nbreak')).toBeNull()
    expect(normalizePhone('')).toBe('')
    expect(normalizePhone('(+44) 20-7946.0123')).toBe('+442079460123')
    expect(normalizePhone('123')).toBeNull()
  })
})

describe('requests', () => {
  async function answer(handler: ReturnType<typeof http.get>, method: string, path: string, headers: Record<string, string> = {}) {
    const response = await getResponse([handler], new Request(new URL(path, location.origin), { method, headers }))
    if (!response) throw new Error('No answer')
    const text = await response.text()
    return { status: response.status, body: text ? JSON.parse(text) : undefined }
  }
  const handler = (method: 'get' | 'post', access: Access, resolve: () => unknown, options?: RouteOptions) =>
    http[method]('/api/test/:id', route(access, resolve, options))

  test('writes need the X-Juntia-Request header, before any other check', async () => {
    const post = handler('post', 'admin', () => ({ ok: true }), { status: 201 })
    expect(await answer(post, 'POST', '/api/test/1')).toEqual({ status: 403, body: { code: 'invalid_origin' } })
    expect(await answer(post, 'POST', '/api/test/1', { 'X-Juntia-Request': '1' })).toEqual({ status: 401, body: { code: 'authentication_required' } })
    signInAdmin()
    expect(await answer(post, 'POST', '/api/test/1', { 'X-Juntia-Request': '1' })).toEqual({ status: 201, body: { ok: true } })
  })

  test('sessions, features, no-content answers and errors', async () => {
    expect(await answer(handler('get', 'session', () => null), 'GET', '/api/test/1')).toEqual({ status: 200, body: null })
    expect(await answer(handler('get', 'resident', () => [1]), 'GET', '/api/test/1')).toEqual({ status: 200, body: [1] })
    const feature = handler('get', 'session', () => ({}), { feature: 'events' })
    coreStore().features.events = false
    expect(await answer(feature, 'GET', '/api/test/1')).toEqual({ status: 404, body: { code: 'events_disabled' } })
    const removal = handler('post', 'public', () => undefined, { status: 204 })
    expect(await answer(removal, 'POST', '/api/test/1', { 'X-Juntia-Request': '1' })).toEqual({ status: 204, body: undefined })
    const failing = handler('get', 'public', () => {
      throw new DemoApiError('contact_stale', 409, { name: 'contact_stale' })
    })
    expect(await answer(failing, 'GET', '/api/test/1')).toEqual({ status: 409, body: { code: 'contact_stale', fields: { name: 'contact_stale' } } })
    expect(await answer(handler('get', 'public', () => demoUnavailable()), 'GET', '/api/test/1'))
      .toEqual({ status: 403, body: { code: 'demo_unavailable' } })
    const raw = await getResponse([handler('get', 'public', () => HttpResponse.text('raw'))], new Request(new URL('/api/test/1', location.origin)))
    expect(await raw?.text()).toBe('raw')
  })

  test('a broken handler is a logged 500 internal_error', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const broken = handler('get', 'public', () => {
      throw new TypeError('boom')
    })
    expect(await answer(broken, 'GET', '/api/test/1')).toEqual({ status: 500, body: { code: 'internal_error' } })
    expect(await answer(handler('get', 'public', () => undefined), 'GET', '/api/test/1')).toEqual({ status: 500, body: { code: 'internal_error' } })
    expect(error).toHaveBeenCalledTimes(2)
  })

  test('path and query parameters are validated like FastAPI', async () => {
    const url = new URL('http://localhost/api/x?page=2&tag=3&tag=4&q=pipe&flow=income&uncategorized=yes&start=2026-10-01&bad=2026-02-30')
    expect(idParam({ id: '7' }, 'id')).toBe(7)
    expect(await failure(() => idParam({ id: 'x' }, 'id'))).toEqual({ code: 'invalid_request', status: 422 })
    expect(await failure(() => idParam({ id: '0' }, 'id'))).toEqual({ code: 'invalid_request', status: 422 })
    expect(pageParam(url)).toBe(2)
    expect(pageParam(new URL('http://localhost/api/x'))).toBe(1)
    expect(queryInts(url, 'tag')).toEqual([3, 4])
    expect(queryInt(url, 'missing')).toBeNull()
    expect(queryText(url, 'q')).toBe('pipe')
    expect(await failure(() => queryText(url, 'q', { max: 3 }))).toEqual({ code: 'invalid_request', status: 422 })
    expect(queryChoice(url, 'flow', ['', 'income', 'expense'] as const, '')).toBe('income')
    expect(await failure(() => queryChoice(url, 'q', ['a'] as const, 'a'))).toEqual({ code: 'invalid_request', status: 422 })
    expect(queryBool(url, 'uncategorized')).toBe(true)
    expect(queryBool(url, 'missing', true)).toBe(true)
    expect(queryDay(url, 'start')).toBe('2026-10-01')
    expect(await failure(() => queryDay(url, 'bad'))).toEqual({ code: 'invalid_request', status: 422 })
  })
})
