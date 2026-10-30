import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import type { DwellingLayoutOut } from '../../api/schema.gen'
import { DWELLINGS, PRESIDENT_ID, castResident } from '../cast'
import { resetDemo } from '../store'
import { findResident, type DemoResident } from '../store/core'
import { clearPresidency, peopleStore, residentPasswordMatches, setResidentPassword } from '../store/people'
import { demoRequest } from '../testing'
import { floorName, mapleCourtLayout, peopleScenario } from './people'

// Thursday 29 October 2026, midday (local time).
const NOW = new Date(2026, 9, 29, 12, 0)

function resident(id: number): DemoResident {
  const found = findResident(id)
  if (!found) throw new Error(`No neighbor ${id}`)
  return found
}

beforeEach(() => resetDemo({ now: () => NOW }))
afterEach(() => resetDemo())

describe('the people scenario', () => {
  test('is the same on every visit', () => {
    expect(peopleScenario()).toEqual(peopleScenario())
    expect(mapleCourtLayout().zones[0].id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })

  test('arranges Maple Court as one building, top floor first, every dwelling placed once', () => {
    const layout = mapleCourtLayout()
    expect(layout).toMatchObject({ show_row_names: true, show_column_names: false })
    expect(layout.zones).toHaveLength(1)
    const [zone] = layout.zones
    expect(zone).toMatchObject({ name: 'Main building', columns: 3 })
    expect(zone.rows.map(row => [row.name, row.cells])).toEqual([
      ['4th floor', [10, 11, 12]],
      ['3rd floor', [7, 8, 9]],
      ['2nd floor', [4, 5, 6]],
      ['1st floor', [1, 2, 3]],
    ])
    const placed = zone.rows.flatMap(row => row.cells)
    expect([...placed].sort((left, right) => (left ?? 0) - (right ?? 0))).toEqual(DWELLINGS.map(dwelling => dwelling.id))
    const ids = [zone.id, ...zone.rows.map(row => row.id)]
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]{1,64}$/)
  })

  test('the layout is the one the directory serves, and the API accepts it back unchanged', async () => {
    const { body } = await demoRequest<DwellingLayoutOut>('GET', '/api/neighbors/layout')
    expect(body).toEqual({ version: 1, layout: mapleCourtLayout(), limits: { zones: 50, rows: 100, columns: 24, cells: 10000 } })
    await demoRequest('POST', '/api/admin/auth/login', { body: { username: 'demo', password: 'demo' } })
    expect(await demoRequest('PUT', '/api/admin/dwellings/layout', { body: { version: 1, layout: body.layout } }))
      .toMatchObject({ status: 200, body: { version: 2, layout: mapleCourtLayout() } })
  })

  test('skips names that are not a floor and a door, and names floors in English', () => {
    const layout = mapleCourtLayout([{ id: 1, label: '1A', coefficient: '50.00' }, { id: 2, label: 'Garage', coefficient: '50.00' }])
    expect(layout.zones[0]).toMatchObject({ columns: 1, rows: [{ name: '1st floor', cells: [1] }] })
    expect([0, 1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 101].map(floorName)).toEqual([
      'Ground floor', '1st floor', '2nd floor', '3rd floor', '4th floor', '11th floor', '12th floor', '13th floor',
      '21st floor', '22nd floor', '23rd floor', '101st floor',
    ])
  })

  test('James Okafor holds the presidency, and nobody has changed their password yet', () => {
    const { presidency, passwords } = peopleScenario()
    expect(presidency).toEqual({ presidentId: PRESIDENT_ID, version: 1 })
    expect(castResident(PRESIDENT_ID)).toMatchObject({ name: 'James Okafor', status: 'active' })
    expect(passwords.size).toBe(0)
  })
})

describe('the people store', () => {
  test('neighbors sign in with demo until they change their password; accounts without one never match', () => {
    const olivia = resident(6), ethan = resident(15)
    expect(residentPasswordMatches(olivia, 'demo')).toBe(true)
    expect(residentPasswordMatches(olivia, 'Demo')).toBe(false)
    expect(residentPasswordMatches(ethan, 'demo')).toBe(false)
    setResidentPassword(6, 'new-demo-password')
    expect(residentPasswordMatches(olivia, 'demo')).toBe(false)
    expect(residentPasswordMatches(olivia, 'new-demo-password')).toBe(true)
    expect(residentPasswordMatches(resident(1), 'demo')).toBe(true)
    resetDemo({ now: () => NOW })
    expect(residentPasswordMatches(resident(6), 'demo')).toBe(true)
  })

  test('passwords longer than 72 UTF-8 bytes never match, like bcrypt on the backend', () => {
    const olivia = resident(6)
    const long = 'a'.repeat(73)
    setResidentPassword(6, long)
    expect(residentPasswordMatches(olivia, long)).toBe(false)
    expect(residentPasswordMatches(olivia, '')).toBe(false)
  })

  test('clearing the presidency only affects its holder', () => {
    clearPresidency(6)
    expect(peopleStore().presidency).toEqual({ presidentId: 1, version: 1 })
    clearPresidency(1)
    expect(peopleStore().presidency).toEqual({ presidentId: null, version: 2 })
  })
})
