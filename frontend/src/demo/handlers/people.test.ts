import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import type {
  DwellingLayout, DwellingLayoutOut, DwellingNeighborsOut, DwellingOut, PresidencyOut, ProfileOut, UserOut,
} from '../../api/schema.gen'
import { activeResidents, castResidentsOf } from '../cast'
import { MUTATION_HEADER } from '../core'
import { resetDemo } from '../store'
import { coreStore } from '../store/core'
import { demoFetch, demoRequest, demoUrl } from '../testing'
import { peopleHandlers } from './people'

// Thursday 29 October 2026, midday (local time).
const NOW = new Date(2026, 9, 29, 12, 0)

beforeEach(() => resetDemo({ now: () => NOW }))
afterEach(() => resetDemo())

const signInAdmin = () => demoRequest('POST', '/api/admin/auth/login', { body: { username: 'demo', password: 'demo' } })
const signOut = () => demoRequest('POST', '/api/auth/logout')

/** The operations ../README.md assigns to the people module, in MSW syntax. */
const PEOPLE_ROUTES = [
  'GET /api/neighbors', 'GET /api/neighbors/layout', 'GET /api/admin/users', 'POST /api/admin/users',
  'PATCH /api/admin/users/:userId', 'DELETE /api/admin/users/:userId', 'POST /api/admin/users/:userId/invite',
  'PATCH /api/admin/users/:userId/status', 'GET /api/admin/dwellings', 'POST /api/admin/dwellings',
  'PATCH /api/admin/dwellings/:dwellingId', 'PUT /api/admin/dwellings/layout', 'GET /api/admin/presidency',
  'PUT /api/admin/presidency', 'GET /api/auth/profile', 'PATCH /api/auth/profile', 'POST /api/auth/profile/password',
  'DELETE /api/auth/profile/sessions', 'POST /api/auth/activate', 'POST /api/auth/forgot-password',
  'POST /api/auth/reset-password', 'POST /api/auth/google/start', 'POST /api/auth/google/link',
  'DELETE /api/auth/google/link', 'PATCH /api/admin/settings/general', 'PATCH /api/admin/settings/features/:feature',
]

test('the people module answers exactly its 26 operations', () => {
  const served = peopleHandlers.map(handler => `${String(handler.info.method)} ${String(handler.info.path)}`)
  expect(served).toHaveLength(26)
  expect([...served].sort()).toEqual([...PEOPLE_ROUTES].sort())
})

describe('the Neighbors directory', () => {
  test('lists every dwelling in floor order with its active neighbors by name, and marks the president', async () => {
    const { status, body } = await demoRequest<DwellingNeighborsOut[]>('GET', '/api/neighbors')
    expect(status).toBe(200)
    expect(body.map(dwelling => dwelling.label)).toEqual(['1A', '1B', '1C', '2A', '2B', '2C', '3A', '3B', '3C', '4A', '4B', '4C'])
    expect(body[0]).toEqual({
      id: 1, label: '1A', neighbors: [
        { id: 1, name: 'James Okafor', email: 'james.okafor@example.com', phone: '+442079460418', is_president: true },
        { id: 2, name: 'Priya Sharma', email: 'priya.sharma@example.com', phone: '+442079460563', is_president: false },
      ],
    })
    const names = (label: string) => body.find(dwelling => dwelling.label === label)?.neighbors.map(person => person.name)
    expect(names('2C')).toEqual(['Daniel Mensah', 'Grace Liu'])
    expect(names('4A')).toEqual(['Chloe Dubois', 'Thomas Wright'])
    // Noah Patel is disabled; Ethan Brooks and Hannah Schmidt have not accepted their invitations.
    expect(names('3B')).toContain('Hiroshi Tanaka')
    expect(names('3B')).not.toContain('Noah Patel')
    expect(names('4B')).not.toContain('Ethan Brooks')
    expect(names('4C')).not.toContain('Hannah Schmidt')
    const everybody = body.flatMap(dwelling => dwelling.neighbors)
    expect(everybody).toHaveLength(activeResidents().length)
    expect(everybody.filter(person => person.is_president).map(person => person.name)).toEqual(['James Okafor'])
    expect(everybody.find(person => person.name === "Liam O'Connor")?.phone).toBe('')
  })

  test('needs a session, and the administrator reads it too', async () => {
    await signOut()
    expect(await demoRequest('GET', '/api/neighbors')).toMatchObject({ status: 401, body: { code: 'authentication_required' } })
    expect(await demoRequest('GET', '/api/neighbors/layout')).toMatchObject({ status: 401, body: { code: 'authentication_required' } })
    await signInAdmin()
    expect((await demoRequest('GET', '/api/neighbors')).status).toBe(200)
    expect((await demoRequest('GET', '/api/neighbors/layout')).status).toBe(200)
  })

  test('orders dwellings like the backend: basements, ground floor, mezzanine, numbered floors, attic, others', async () => {
    await signInAdmin()
    for (const [label, coefficient] of [['Garage', '0'], ['10A', '0'], ['\u00c1tico', '0'], ['Entresuelo 1', '0'], ['Bajos', '0'], ['-1', '0']]) {
      expect((await demoRequest('POST', '/api/admin/dwellings', { body: { label, coefficient } })).status).toBe(201)
    }
    const expected = ['-1', 'Bajos', 'Entresuelo 1', '1A', '1B', '1C', '2A', '2B', '2C', '3A', '3B', '3C', '4A', '4B', '4C', '10A', '\u00c1tico', 'Garage']
    expect((await demoRequest<DwellingOut[]>('GET', '/api/admin/dwellings')).body.map(dwelling => dwelling.label)).toEqual(expected)
    expect((await demoRequest<DwellingNeighborsOut[]>('GET', '/api/neighbors')).body.map(dwelling => dwelling.label)).toEqual(expected)
  })
})

describe('the dwelling layout', () => {
  const twoZones = (): DwellingLayout => ({
    zones: [
      {
        id: 'main', name: '  Main   building ', columns: 3, rows: [
          { id: 'floor-4', name: 'Top  floor', cells: [null, 11, 12] },
          { id: 'floor-1', name: '', cells: [1, 2, 3] },
        ],
      },
      { id: 'garden', name: 'Garden houses', columns: 2, rows: [{ id: 'garden-row', name: '', cells: [10, null] }] },
    ],
    show_row_names: false,
    show_column_names: true,
  })

  test('the administrator saves a new arrangement, which every reader gets', async () => {
    await signInAdmin()
    const saved = await demoRequest<DwellingLayoutOut>('PUT', '/api/admin/dwellings/layout', { body: { version: 1, layout: twoZones() } })
    expect(saved.status).toBe(200)
    expect(saved.body.version).toBe(2)
    expect(saved.body.layout?.zones[0]).toMatchObject({ name: 'Main building', rows: [{ name: 'Top floor' }, { name: '' }] })
    expect(saved.body.layout?.zones[1]).toEqual({ id: 'garden', name: 'Garden houses', columns: 2, rows: [{ id: 'garden-row', name: '', cells: [10, null] }] })
    await demoRequest('POST', '/api/admin/auth/logout')
    expect((await demoRequest<DwellingLayoutOut>('GET', '/api/neighbors/layout')).body).toEqual(saved.body)
  })

  test('the display options default to hidden names, and an empty layout is allowed', async () => {
    await signInAdmin()
    expect(await demoRequest('PUT', '/api/admin/dwellings/layout', { body: { version: 1, layout: { zones: [] } } }))
      .toMatchObject({ status: 200, body: { version: 2, layout: { zones: [], show_row_names: false, show_column_names: false } } })
  })

  test('a layout that breaks the contract is dwelling_layout_invalid', async () => {
    await signInAdmin()
    const zone = twoZones().zones[1]
    const invalid: unknown[] = [
      { zones: [{ ...zone, columns: 3 }] },
      { zones: [{ ...zone, rows: [{ ...zone.rows[0], cells: [10, 10] }] }] },
      { zones: [zone, { ...zone, id: 'other', rows: [{ id: 'garden-row', name: '', cells: [null, null] }] }] },
      { zones: [zone, { ...zone, rows: [{ id: 'other-row', name: '', cells: [null, null] }] }] },
      { zones: [{ ...zone, id: 'garden houses' }] },
      { zones: [{ ...zone, id: 'x'.repeat(65) }] },
      { zones: [{ ...zone, name: '   ' }] },
      { zones: [{ ...zone, rows: [{ ...zone.rows[0], name: '   ' }] }] },
      { zones: [{ ...zone, columns: 25 }] },
      { zones: [{ ...zone, columns: 2.5 }] },
      { zones: [{ ...zone, rows: [] }] },
      { zones: [{ ...zone, rows: [{ ...zone.rows[0], cells: [] }] }] },
      { zones: [{ ...zone, rows: [{ ...zone.rows[0], cells: [0, null] }] }] },
      { zones: [{ ...zone, rows: [{ ...zone.rows[0], cells: ['10', null] }] }] },
      { zones: [{ ...zone, rows: [{ ...zone.rows[0], cells: [10, null], floor: 1 }] }] },
      { zones: [zone], show_row_names: 'yes' },
      { zones: [zone], legend: true },
      { show_row_names: true },
      { zones: Array.from({ length: 51 }, (_, index) => ({ ...zone, id: `zone-${index}`, rows: [{ id: `row-${index}`, name: '', cells: [null, null] }] })) },
    ]
    for (const layout of invalid) {
      expect(await demoRequest('PUT', '/api/admin/dwellings/layout', { body: { version: 1, layout } }), JSON.stringify(layout).slice(0, 120))
        .toMatchObject({ status: 422, body: { code: 'dwelling_layout_invalid' } })
    }
    for (const body of [{ version: -1, layout: { zones: [] } }, { version: '1', layout: { zones: [] } }, { version: 1 }, { version: 1, layout: { zones: [] }, force: true }]) {
      expect(await demoRequest('PUT', '/api/admin/dwellings/layout', { body })).toMatchObject({ status: 422, body: { code: 'dwelling_layout_invalid' } })
    }
    const malformed = await demoFetch(new Request(demoUrl('/api/admin/dwellings/layout'), {
      method: 'PUT', headers: { [MUTATION_HEADER]: '1', 'Content-Type': 'application/json' }, body: '{"version": 1,',
    }))
    expect([malformed.status, await malformed.json()]).toEqual([422, { code: 'dwelling_layout_invalid' }])
    expect((await demoRequest<DwellingLayoutOut>('GET', '/api/neighbors/layout')).body.version).toBe(1)
  })

  test('unknown dwellings, outdated versions and missing permissions are refused', async () => {
    const layout = twoZones()
    expect(await demoRequest('PUT', '/api/admin/dwellings/layout', { body: { version: 1, layout } }))
      .toMatchObject({ status: 401, body: { code: 'authentication_required' } })
    await signInAdmin()
    expect(await demoRequest('PUT', '/api/admin/dwellings/layout', { body: { version: 1, layout }, mutationHeader: false }))
      .toMatchObject({ status: 403, body: { code: 'invalid_origin' } })
    layout.zones[1].rows[0].cells = [10, 99]
    // The dwellings are checked before the version.
    expect(await demoRequest('PUT', '/api/admin/dwellings/layout', { body: { version: 0, layout } }))
      .toMatchObject({ status: 422, body: { code: 'dwelling_layout_missing' } })
    layout.zones[1].rows[0].cells = [10, null]
    expect(await demoRequest('PUT', '/api/admin/dwellings/layout', { body: { version: 0, layout } }))
      .toMatchObject({ status: 409, body: { code: 'dwelling_layout_stale' } })
    expect((await demoRequest('PUT', '/api/admin/dwellings/layout', { body: { version: 1, layout } })).status).toBe(200)
    expect(await demoRequest('PUT', '/api/admin/dwellings/layout', { body: { version: 1, layout } }))
      .toMatchObject({ status: 409, body: { code: 'dwelling_layout_stale' } })
  })
})

describe('dwellings', () => {
  test('lists the dwellings with their coefficients and how many accounts each has', async () => {
    await signInAdmin()
    const { status, body } = await demoRequest<DwellingOut[]>('GET', '/api/admin/dwellings')
    expect(status).toBe(200)
    expect(body).toHaveLength(12)
    expect(body[0]).toEqual({ label: '1A', coefficient: '8.90', id: 1, version: 1, user_count: 2 })
    // Pending and disabled accounts count too.
    expect(body.find(dwelling => dwelling.label === '3B')?.user_count).toBe(castResidentsOf(8).length)
    expect(body.find(dwelling => dwelling.label === '4C')?.user_count).toBe(castResidentsOf(12).length)
    expect(body.reduce((cents, dwelling) => cents + Math.round(Number(dwelling.coefficient) * 100), 0)).toBe(10_000)
    await demoRequest('POST', '/api/admin/auth/logout')
    expect(await demoRequest('GET', '/api/admin/dwellings')).toMatchObject({ status: 401, body: { code: 'authentication_required' } })
  })

  test('the administrator creates a dwelling with a two-decimal coefficient', async () => {
    await signInAdmin()
    expect(await demoRequest('POST', '/api/admin/dwellings', { body: { label: '  Garden   house 1 ', coefficient: '5.5' } }))
      .toMatchObject({ status: 201, body: { label: 'Garden house 1', coefficient: '5.50', id: 13, version: 1, user_count: 0 } })
    expect(await demoRequest('POST', '/api/admin/dwellings', { body: { label: 'Garden house 2', coefficient: 0 } }))
      .toMatchObject({ status: 201, body: { coefficient: '0.00', id: 14 } })
    expect(await demoRequest('POST', '/api/admin/dwellings', { body: { label: 'Garden house 1', coefficient: '1' } }))
      .toMatchObject({ status: 409, body: { code: 'record_conflict' } })
    expect(await demoRequest('POST', '/api/admin/dwellings', { body: { label: 'Garden house 3' } }))
      .toMatchObject({ status: 422, body: { code: 'coefficient_required' } })
    expect(await demoRequest('POST', '/api/admin/dwellings', { body: { label: 'Garden house 3', coefficient: null } }))
      .toMatchObject({ status: 422, body: { code: 'coefficient_required' } })
    for (const body of [
      { label: 'Garden house 3', coefficient: '5.555' }, { label: 'Garden house 3', coefficient: 100.01 },
      { label: 'Garden house 3', coefficient: -1 }, { label: 'Garden house 3', coefficient: 'five' },
      { label: '   ', coefficient: '1' }, { label: 'x'.repeat(151), coefficient: '1' }, { coefficient: '1' },
      { label: 'Garden house 3', coefficient: '1', version: 1 },
    ]) expect(await demoRequest('POST', '/api/admin/dwellings', { body }), JSON.stringify(body)).toMatchObject({ status: 422, body: { code: 'invalid_request' } })
    expect((await demoRequest<DwellingOut[]>('GET', '/api/admin/dwellings')).body).toHaveLength(14)
  })

  test('the administrator renames a dwelling and changes its coefficient, with optimistic versions', async () => {
    await signInAdmin()
    expect(await demoRequest('PATCH', '/api/admin/dwellings/2', { body: { label: 'Flat 1B', coefficient: '7.65', version: 1 } }))
      .toMatchObject({ status: 200, body: { id: 2, label: 'Flat 1B', coefficient: '7.65', version: 2, user_count: 1 } })
    expect(await demoRequest('PATCH', '/api/admin/dwellings/2', { body: { label: 'Flat 1B', version: 2 } }))
      .toMatchObject({ status: 200, body: { coefficient: '7.65', version: 3 } })
    expect(await demoRequest('PATCH', '/api/admin/dwellings/2', { body: { label: 'Flat 1B', coefficient: '7.60', version: 2 } }))
      .toMatchObject({ status: 409, body: { code: 'record_stale' } })
    expect(await demoRequest('PATCH', '/api/admin/dwellings/2', { body: { label: '1C', coefficient: '7.60', version: 3 } }))
      .toMatchObject({ status: 409, body: { code: 'record_conflict' } })
    expect(await demoRequest('PATCH', '/api/admin/dwellings/99', { body: { label: 'Nowhere', coefficient: '1', version: 1 } }))
      .toMatchObject({ status: 404, body: { code: 'dwelling_not_found' } })
    expect(await demoRequest('PATCH', '/api/admin/dwellings/0', { body: { label: 'Nowhere', coefficient: '1', version: 1 } }))
      .toMatchObject({ status: 404, body: { code: 'dwelling_not_found' } })
    expect(await demoRequest('PATCH', '/api/admin/dwellings/two', { body: { label: 'Nowhere', coefficient: '1', version: 1 } }))
      .toMatchObject({ status: 422, body: { code: 'invalid_request' } })
    expect(await demoRequest('PATCH', '/api/admin/dwellings/2', { body: { label: 'Flat 1B', coefficient: '7.60' } }))
      .toMatchObject({ status: 422, body: { code: 'invalid_request' } })
    // Accounts and the directory follow the new name.
    expect((await demoRequest<UserOut[]>('GET', '/api/admin/users')).body.find(user => user.id === 3)?.dwelling_label).toBe('Flat 1B')
    expect((await demoRequest<DwellingNeighborsOut[]>('GET', '/api/neighbors')).body.find(dwelling => dwelling.id === 2)?.label).toBe('Flat 1B')
  })

  test('with ownership coefficients off they are hidden, refused and kept', async () => {
    await signInAdmin()
    expect(await demoRequest('PATCH', '/api/admin/settings/features/coefficient', { body: { enabled: false } }))
      .toMatchObject({ status: 200, body: { coefficient: false, actions: true, events: true, google_login: false } })
    const dwellings = (await demoRequest<DwellingOut[]>('GET', '/api/admin/dwellings')).body
    expect(dwellings.every(dwelling => dwelling.coefficient === null)).toBe(true)
    expect((await demoRequest<UserOut[]>('GET', '/api/admin/users')).body.every(user => user.coefficient === null)).toBe(true)
    expect(await demoRequest('POST', '/api/admin/dwellings', { body: { label: 'Shop', coefficient: '1.00' } }))
      .toMatchObject({ status: 409, body: { code: 'coefficient_disabled' } })
    expect(await demoRequest('POST', '/api/admin/dwellings', { body: { label: 'Shop' } }))
      .toMatchObject({ status: 201, body: { id: 13, coefficient: null } })
    expect(await demoRequest('PATCH', '/api/admin/dwellings/1', { body: { label: 'Flat 1A', coefficient: null, version: 1 } }))
      .toMatchObject({ status: 409, body: { code: 'coefficient_disabled' } })
    expect(await demoRequest('PATCH', '/api/admin/dwellings/1', { body: { label: 'Flat 1A', version: 1 } }))
      .toMatchObject({ status: 200, body: { label: 'Flat 1A', coefficient: null, version: 2 } })

    await demoRequest('PATCH', '/api/admin/settings/features/coefficient', { body: { enabled: true } })
    const restored = (await demoRequest<DwellingOut[]>('GET', '/api/admin/dwellings')).body
    expect(restored.find(dwelling => dwelling.id === 1)?.coefficient).toBe('8.90')
    expect(restored.find(dwelling => dwelling.id === 13)?.coefficient).toBeNull()
    expect(await demoRequest('PATCH', '/api/admin/dwellings/13', { body: { label: 'Shop', version: 1 } }))
      .toMatchObject({ status: 422, body: { code: 'coefficient_required' } })
  })

  test("a neighbor's profile hides the coefficient while the feature is off", async () => {
    expect((await demoRequest<ProfileOut>('GET', '/api/auth/profile')).body.coefficient).toBe('7.60')
    coreStore().features.coefficient = false
    expect((await demoRequest<ProfileOut>('GET', '/api/auth/profile')).body.coefficient).toBeNull()
  })
})

describe('the presidency', () => {
  test('James Okafor holds it; the administrator hands it to another active neighbor', async () => {
    await signInAdmin()
    expect((await demoRequest<PresidencyOut>('GET', '/api/admin/presidency')).body).toEqual({
      president: { id: 1, name: 'James Okafor', dwelling_id: 1, dwelling_label: '1A' }, version: 1,
    })
    expect(await demoRequest('PUT', '/api/admin/presidency', { body: { user_id: 6, version: 1 } })).toMatchObject({
      status: 200, body: { president: { id: 6, name: 'Olivia Bennett', dwelling_id: 5, dwelling_label: '2B' }, version: 2 },
    })
    const presidents = (await demoRequest<DwellingNeighborsOut[]>('GET', '/api/neighbors')).body
      .flatMap(dwelling => dwelling.neighbors).filter(person => person.is_president)
    expect(presidents.map(person => person.name)).toEqual(['Olivia Bennett'])
    expect(await demoRequest('PUT', '/api/admin/presidency', { body: { user_id: 1, version: 1 } }))
      .toMatchObject({ status: 409, body: { code: 'presidency_stale' } })
    expect(await demoRequest('PUT', '/api/admin/presidency', { body: { user_id: null, version: 2 } }))
      .toMatchObject({ status: 200, body: { president: null, version: 3 } })
  })

  test('only active neighbors can hold it, and the request follows the contract', async () => {
    await signInAdmin()
    // Eligibility is checked before the version.
    expect(await demoRequest('PUT', '/api/admin/presidency', { body: { user_id: 15, version: 0 } }))
      .toMatchObject({ status: 409, body: { code: 'presidency_inactive' } })
    expect(await demoRequest('PUT', '/api/admin/presidency', { body: { user_id: 11, version: 1 } }))
      .toMatchObject({ status: 409, body: { code: 'presidency_inactive' } })
    expect(await demoRequest('PUT', '/api/admin/presidency', { body: { user_id: 99, version: 1 } }))
      .toMatchObject({ status: 404, body: { code: 'user_not_found' } })
    for (const body of [{ version: 1 }, { user_id: '6', version: 1 }, { user_id: 0, version: 1 }, { user_id: 6, version: -1 }, { user_id: 6 }, { user_id: 6, version: 1, note: '' }]) {
      expect(await demoRequest('PUT', '/api/admin/presidency', { body }), JSON.stringify(body)).toMatchObject({ status: 422, body: { code: 'invalid_request' } })
    }
    expect((await demoRequest<PresidencyOut>('GET', '/api/admin/presidency')).body.version).toBe(1)
  })

  test('is for the administrator only', async () => {
    expect(await demoRequest('GET', '/api/admin/presidency')).toMatchObject({ status: 401, body: { code: 'authentication_required' } })
    expect(await demoRequest('PUT', '/api/admin/presidency', { body: { user_id: 6, version: 1 } }))
      .toMatchObject({ status: 401, body: { code: 'authentication_required' } })
  })
})

describe('general settings and features', () => {
  test('the administrator renames the community, which every page reads at once', async () => {
    await signInAdmin()
    expect(await demoRequest('PATCH', '/api/admin/settings/general', { body: { community_name: '  Maple   Court\tResidents ' } }))
      .toMatchObject({ status: 200, body: { community_name: 'Maple Court Residents' } })
    expect((await demoRequest('GET', '/api/settings/general')).body).toEqual({ community_name: 'Maple Court Residents' })
    for (const community_name of ['', '   ', 'x'.repeat(151), 'Maple\u0001Court']) {
      expect(await demoRequest('PATCH', '/api/admin/settings/general', { body: { community_name } }), JSON.stringify(community_name))
        .toMatchObject({ status: 422, body: { code: 'invalid_request' } })
    }
    expect(await demoRequest('PATCH', '/api/admin/settings/general', { body: { community_name: 'Maple Court', language: 'en' } }))
      .toMatchObject({ status: 422, body: { code: 'invalid_request' } })
    expect((await demoRequest('GET', '/api/settings/general')).body).toEqual({ community_name: 'Maple Court Residents' })
  })

  test('the administrator turns actions and events off and on', async () => {
    await signInAdmin()
    expect(await demoRequest('PATCH', '/api/admin/settings/features/actions', { body: { enabled: false } }))
      .toMatchObject({ status: 200, body: { coefficient: true, actions: false, events: true, google_login: false } })
    expect(await demoRequest('PATCH', '/api/admin/settings/features/events', { body: { enabled: false } }))
      .toMatchObject({ status: 200, body: { actions: false, events: false } })
    expect((await demoRequest('GET', '/api/features')).body).toEqual({ coefficient: true, actions: false, events: false, google_login: false })
    expect(coreStore().features).toEqual({ coefficient: true, actions: false, events: false })
    expect(await demoRequest('PATCH', '/api/admin/settings/features/events', { body: { enabled: true } }))
      .toMatchObject({ status: 200, body: { events: true } })
  })

  test('only known features, strict booleans and the administrator', async () => {
    expect(await demoRequest('PATCH', '/api/admin/settings/features/actions', { body: { enabled: false } }))
      .toMatchObject({ status: 401, body: { code: 'authentication_required' } })
    expect(await demoRequest('PATCH', '/api/admin/settings/general', { body: { community_name: 'Elm Court' } }))
      .toMatchObject({ status: 401, body: { code: 'authentication_required' } })
    await signInAdmin()
    expect(await demoRequest('PATCH', '/api/admin/settings/features/actions', { body: { enabled: false }, mutationHeader: false }))
      .toMatchObject({ status: 403, body: { code: 'invalid_origin' } })
    for (const [feature, body] of [['google_login', { enabled: true }], ['actions', { enabled: 'false' }], ['actions', { enabled: 0 }], ['actions', {}]] as const) {
      expect(await demoRequest('PATCH', `/api/admin/settings/features/${feature}`, { body }), `${feature} ${JSON.stringify(body)}`)
        .toMatchObject({ status: 422, body: { code: 'invalid_request' } })
    }
    expect(coreStore().features).toEqual({ coefficient: true, actions: true, events: true })
  })
})
