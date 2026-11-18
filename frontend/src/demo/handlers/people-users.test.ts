import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import type { DwellingNeighborsOut, DwellingOut, PresidencyOut, UserAuthOut, UserOut } from '../../api/schema.gen'
import { ADMINISTRATOR_ID, RESIDENTS, activeResidents, castResident, castResidentsOf } from '../cast'
import { DemoApiError, daysAgo, hoursFromNow, instant } from '../core'
import { resetDemo } from '../store'
import { findResident, type DemoResident } from '../store/core'
import { requireAdministratorRemains } from '../store/people'
import { demoRequest, signInAdmin, signInAs } from '../testing'

// Thursday 29 October 2026, midday (local time).
const NOW = new Date(2026, 9, 29, 12, 0)

beforeEach(() => resetDemo({ now: () => NOW }))
afterEach(() => resetDemo())

const signIn = (email: string, password = 'demo') => demoRequest('POST', '/api/auth/login', { body: { email, password } })
const session = async () => (await demoRequest<UserAuthOut>('GET', '/api/auth/session')).body
const users = async () => (await demoRequest<UserOut[]>('GET', '/api/admin/users')).body
const user = async (id: number) => (await users()).find(item => item.id === id)
const directoryNames = async () => (await demoRequest<DwellingNeighborsOut[]>('GET', '/api/neighbors')).body
  .flatMap(dwelling => dwelling.neighbors.map(person => person.name))
const president = async () => (await demoRequest<PresidencyOut>('GET', '/api/admin/presidency')).body

/** The edit form of a cast account as the app sends it, at version 1, with `changes`. */
function edit(id: number, changes: Record<string, unknown> = {}) {
  const { name, email, phone, dwellingId } = castResident(id)
  return { name, email, phone, dwelling_id: dwellingId, administrator: id === ADMINISTRATOR_ID, version: 1, ...changes }
}

function resident(id: number): DemoResident {
  const found = findResident(id)
  if (!found) throw new Error(`No account ${id}`)
  return found
}

/** The error a rule of the store answers, or null when it lets the change through. */
function refusal(rule: () => void): { code: string; status: number } | null {
  try {
    rule()
  } catch (error) {
    if (error instanceof DemoApiError) return { code: error.code, status: error.status }
    throw error
  }
  return null
}

const invitation = { name: '  Ava   Morgan ', email: 'Ava.Morgan@Example.com', phone: '+44 20 7946 0999', dwelling_id: 11 }
/** Id of the next account (ids are never reused). */
const NEXT_ID = Math.max(...RESIDENTS.map(item => item.id)) + 1

describe('the users list', () => {
  test('shows every account by name, with its role, status, dwelling, sign-in and invitation', async () => {
    await signInAdmin()
    const list = await users()
    expect(list.map(item => item.name)).toEqual(RESIDENTS.map(item => item.name).sort((left, right) => left < right ? -1 : left > right ? 1 : 0))
    expect(list.find(item => item.id === 6)).toEqual({
      email: 'olivia.bennett@example.com', name: 'Olivia Bennett', phone: '+442079460152', dwelling_id: 5, administrator: false, id: 6,
      version: 1, status: 'active', dwelling_label: '2B', coefficient: '7.60', last_login_at: NOW.toISOString(), invitation_status: 'none',
      invitation_expires_at: null, invitation_sent_at: null, has_password: true, google_linked: false,
    })
    expect(list.filter(item => item.administrator).map(item => [item.name, item.dwelling_label])).toEqual([['James Okafor', '1A']])
    const sent = instant(daysAgo(1), '09:30')
    expect(list.find(item => item.id === 15)).toMatchObject({
      name: 'Ethan Brooks', status: 'pending', invitation_status: 'sent', invitation_sent_at: sent,
      invitation_expires_at: new Date(Date.parse(sent) + 72 * 3_600_000).toISOString(), last_login_at: null, has_password: false,
    })
    expect(list.find(item => item.id === 16)).toMatchObject({ name: 'Hannah Schmidt', status: 'pending', invitation_status: 'expired' })
    expect(list.find(item => item.id === 11)).toMatchObject({ name: 'Noah Patel', status: 'disabled', invitation_status: 'none' })
    expect(list.find(item => item.id === 7)).toMatchObject({ name: 'Grace Liu', google_linked: true, has_password: true })
    expect(list.filter(item => item.status === 'active')).toHaveLength(activeResidents().length)
  })

  test('is for administrators only: a neighbor gets 403, nobody signed in 401', async () => {
    const requests: [string, string, unknown?][] = [
      ['GET', '/api/admin/users'], ['POST', '/api/admin/users', invitation],
      ['PATCH', '/api/admin/users/6/status', { disabled: true, version: 1 }],
      ['DELETE', '/api/admin/users/6', { email: 'olivia.bennett@example.com', version: 1 }],
    ]
    for (const [method, path, body] of requests) {
      expect(await demoRequest(method, path, { body }), `${method} ${path}`).toMatchObject({ status: 403, body: { code: 'administrator_required' } })
    }
    await demoRequest('POST', '/api/auth/logout')
    for (const [method, path, body] of requests) {
      expect(await demoRequest(method, path, { body }), `${method} ${path}`).toMatchObject({ status: 401, body: { code: 'authentication_required' } })
    }
  })
})

describe('invitations', () => {
  test('inviting creates a pending account whose invitation counts as sent, without any email', async () => {
    await signInAdmin()
    const created = await demoRequest<UserOut>('POST', '/api/admin/users', { body: invitation })
    expect(created).toMatchObject({ status: 201 })
    expect(created.body).toEqual({
      email: 'ava.morgan@example.com', name: 'Ava Morgan', phone: '+442079460999', dwelling_id: 11, administrator: false, id: NEXT_ID,
      version: 1, status: 'pending', dwelling_label: '4B', coefficient: '7.90', last_login_at: null, invitation_status: 'sent',
      invitation_expires_at: hoursFromNow(72), invitation_sent_at: NOW.toISOString(), has_password: false, google_linked: false,
    })
    expect(await user(NEXT_ID)).toEqual(created.body)
    expect(await directoryNames()).not.toContain('Ava Morgan')
    expect((await demoRequest<DwellingOut[]>('GET', '/api/admin/dwellings')).body.find(dwelling => dwelling.id === 11)?.user_count).toBe(castResidentsOf(11).length + 1)
    expect(await signIn('ava.morgan@example.com')).toMatchObject({ status: 401, body: { code: 'invalid_credentials' } })
    expect(await demoRequest('POST', '/api/admin/users', { body: { ...invitation, phone: undefined, email: 'liam.wood@example.com' } }))
      .toMatchObject({ status: 201, body: { id: NEXT_ID + 1, phone: '' } })
  })

  test('an administrator may have no dwelling; a neighbor needs one', async () => {
    await signInAdmin()
    expect(await demoRequest('POST', '/api/admin/users', { body: { name: 'Ava Morgan', email: 'ava.morgan@example.com', administrator: true } }))
      .toMatchObject({
        status: 201,
        body: { id: NEXT_ID, administrator: true, dwelling_id: null, dwelling_label: null, coefficient: null, status: 'pending' },
      })
    for (const body of [{ ...invitation, dwelling_id: undefined }, { ...invitation, dwelling_id: null }, { ...invitation, dwelling_id: null, administrator: false }]) {
      expect(await demoRequest('POST', '/api/admin/users', { body: { ...body, email: 'liam.wood@example.com' } }), JSON.stringify(body))
        .toMatchObject({ status: 422, body: { code: 'dwelling_required' } })
    }
    expect(await demoRequest('POST', '/api/admin/users', { body: { ...invitation, email: 'liam.wood@example.com', administrator: true } }))
      .toMatchObject({ status: 201, body: { id: NEXT_ID + 1, administrator: true, dwelling_id: 11, dwelling_label: '4B' } })
    expect((await demoRequest<DwellingOut[]>('GET', '/api/admin/dwellings')).body.map(dwelling => dwelling.user_count).reduce((sum, count) => sum + count))
      .toBe(RESIDENTS.length + 1)
  })

  test('emails are unique, dwellings must exist and the form follows the contract', async () => {
    await signInAdmin()
    expect(await demoRequest('POST', '/api/admin/users', { body: { ...invitation, email: 'James.Okafor@example.com' } }))
      .toMatchObject({ status: 409, body: { code: 'record_conflict' } })
    // The dwelling is checked first.
    expect(await demoRequest('POST', '/api/admin/users', { body: { ...invitation, email: 'james.okafor@example.com', dwelling_id: 99 } }))
      .toMatchObject({ status: 422, body: { code: 'dwelling_not_found' } })
    for (const body of [
      { ...invitation, email: 'ava.morgan' }, { ...invitation, phone: '12' }, { ...invitation, name: '   ' }, { ...invitation, name: undefined },
      { ...invitation, dwelling_id: 0 }, { ...invitation, dwelling_id: '11' }, { ...invitation, role: 'president' },
      { ...invitation, administrator: 'yes' }, { ...invitation, administrator: 1 }, { ...invitation, administrator: null },
    ]) {
      expect(await demoRequest('POST', '/api/admin/users', { body }), JSON.stringify(body)).toMatchObject({ status: 422, body: { code: 'invalid_request' } })
    }
    expect(await users()).toHaveLength(RESIDENTS.length)
  })

  test('an administrator resends pending invitations, with optimistic versions', async () => {
    await signInAdmin()
    expect(await demoRequest('POST', '/api/admin/users/16/invite', { body: { version: 1 } })).toMatchObject({
      status: 200,
      body: { id: 16, version: 2, status: 'pending', invitation_status: 'sent', invitation_sent_at: NOW.toISOString(), invitation_expires_at: hoursFromNow(72) },
    })
    expect(await demoRequest('POST', '/api/admin/users/16/invite', { body: { version: 1 } }))
      .toMatchObject({ status: 409, body: { code: 'record_stale' } })
    expect(await demoRequest('POST', '/api/admin/users/2/invite', { body: { version: 1 } }))
      .toMatchObject({ status: 409, body: { code: 'invitation_not_pending' } })
    expect(await demoRequest('POST', '/api/admin/users/11/invite', { body: { version: 1 } }))
      .toMatchObject({ status: 409, body: { code: 'invitation_not_pending' } })
    expect(await demoRequest('POST', '/api/admin/users/99/invite', { body: { version: 1 } }))
      .toMatchObject({ status: 404, body: { code: 'user_not_found' } })
    expect(await demoRequest('POST', '/api/admin/users/16/invite', { body: {} }))
      .toMatchObject({ status: 422, body: { code: 'invalid_request' } })
  })
})

describe('editing users', () => {
  test('an administrator changes name, phone and dwelling; the directory follows', async () => {
    await signInAdmin()
    expect(await demoRequest('PATCH', '/api/admin/users/2', {
      body: { name: 'Priya  Sharma-Lee', email: 'priya.sharma@example.com', phone: '', dwelling_id: 3, version: 1 },
    })).toMatchObject({
      status: 200, body: { id: 2, name: 'Priya Sharma-Lee', phone: '', dwelling_id: 3, dwelling_label: '1C', status: 'active', version: 2 },
    })
    const directory = (await demoRequest<DwellingNeighborsOut[]>('GET', '/api/neighbors')).body
    expect(directory.find(dwelling => dwelling.label === '1C')?.neighbors.map(person => person.name)).toEqual(['Priya Sharma-Lee', 'Sofia Rossi'])
    // Without a phone the saved one stays.
    expect(await demoRequest('PATCH', '/api/admin/users/4', { body: { name: 'Sofia Rossi', email: 'sofia.rossi@example.com', dwelling_id: 3, version: 1 } }))
      .toMatchObject({ status: 200, body: { phone: '+442079460291', version: 2 } })
  })

  test('outdated versions, unknown users and dwellings, and taken emails are refused', async () => {
    await signInAdmin()
    const body = { name: 'Priya Sharma', email: 'priya.sharma@example.com', phone: '', dwelling_id: 1, version: 1 }
    expect(await demoRequest('PATCH', '/api/admin/users/2', { body: { ...body, version: 2 } })).toMatchObject({ status: 409, body: { code: 'record_stale' } })
    expect(await demoRequest('PATCH', '/api/admin/users/99', { body })).toMatchObject({ status: 404, body: { code: 'user_not_found' } })
    expect(await demoRequest('PATCH', '/api/admin/users/2', { body: { ...body, dwelling_id: 99 } })).toMatchObject({ status: 422, body: { code: 'dwelling_not_found' } })
    expect(await demoRequest('PATCH', '/api/admin/users/2', { body: { ...body, dwelling_id: null } })).toMatchObject({ status: 422, body: { code: 'dwelling_required' } })
    expect(await demoRequest('PATCH', '/api/admin/users/2', { body: { ...body, email: 'Grace.Liu@example.com' } })).toMatchObject({ status: 409, body: { code: 'record_conflict' } })
    expect(await demoRequest('PATCH', '/api/admin/users/2', { body: { ...body, version: undefined } })).toMatchObject({ status: 422, body: { code: 'invalid_request' } })
    expect(await user(2)).toMatchObject({ name: 'Priya Sharma', version: 1, dwelling_id: 1 })
  })

  test('a new email removes the password and the Google link, and invites the account again', async () => {
    await signInAdmin()
    expect(await demoRequest('PATCH', '/api/admin/users/6', { body: edit(6, { email: 'olivia.b@example.com' }) })).toMatchObject({
      status: 200,
      body: { email: 'olivia.b@example.com', status: 'pending', has_password: false, invitation_status: 'sent', invitation_sent_at: NOW.toISOString(), version: 2 },
    })
    expect(await directoryNames()).not.toContain('Olivia Bennett')
    for (const email of ['olivia.b@example.com', 'olivia.bennett@example.com']) {
      expect(await signIn(email)).toMatchObject({ status: 401, body: { code: 'invalid_credentials' } })
    }
    expect(await demoRequest('PATCH', '/api/admin/users/7', { body: edit(7, { email: 'grace.liu@example.org' }) }))
      .toMatchObject({ status: 200, body: { google_linked: false, has_password: false, status: 'pending' } })
  })

  test('the president with a new email or without a dwelling leaves the presidency unassigned; a disabled account gets no invitation', async () => {
    await signInAdmin()
    await demoRequest('PUT', '/api/admin/presidency', { body: { user_id: 6, version: 1 } })
    await demoRequest('PATCH', '/api/admin/users/6', { body: edit(6, { email: 'olivia.b@example.com' }) })
    expect(await president()).toEqual({ president: null, version: 3 })
    await demoRequest('PUT', '/api/admin/presidency', { body: { user_id: 2, version: 3 } })
    // Only administrators may live in no dwelling, and they are then no one's neighbor.
    expect(await demoRequest('PATCH', '/api/admin/users/2', { body: edit(2, { administrator: true, dwelling_id: null }) }))
      .toMatchObject({ status: 200, body: { administrator: true, dwelling_id: null, dwelling_label: null, coefficient: null, status: 'active' } })
    expect(await president()).toEqual({ president: null, version: 5 })
    expect(await directoryNames()).not.toContain('Priya Sharma')
    expect(await demoRequest('PATCH', '/api/admin/users/11', { body: edit(11, { email: 'noah.p@example.com' }) }))
      .toMatchObject({ status: 200, body: { status: 'disabled', invitation_status: 'none', invitation_sent_at: null, has_password: false } })
  })

  test('administrators grant and revoke the role, which applies at once', async () => {
    await signInAdmin()
    expect(await demoRequest('PATCH', '/api/admin/users/2', { body: edit(2, { administrator: true }) }))
      .toMatchObject({ status: 200, body: { id: 2, administrator: true, status: 'active', version: 2 } })
    expect(await signInAs(2)).toMatchObject({ status: 200, body: { user_id: 2, administrator: true } })
    // Priya takes the role away from James: she remains an administrator, and he stays the president.
    expect(await demoRequest('PATCH', '/api/admin/users/1', { body: edit(1, { administrator: false }) }))
      .toMatchObject({ status: 200, body: { id: 1, administrator: false, dwelling_id: 1, status: 'active' } })
    expect((await president()).president).toMatchObject({ id: 1 })
    await signInAs(1)
    expect(await session()).toMatchObject({ user_id: 1, administrator: false })
    expect(await demoRequest('GET', '/api/admin/users')).toMatchObject({ status: 403, body: { code: 'administrator_required' } })
  })

  test('nobody changes their own role or email address, before any other check', async () => {
    await signInAdmin()
    for (const changes of [
      { administrator: false }, { email: 'james.okafor@example.org' }, { email: 'james.okafor@example.org', version: 9 },
      { administrator: false, dwelling_id: 99 },
    ]) {
      expect(await demoRequest('PATCH', '/api/admin/users/1', { body: edit(1, changes) }), JSON.stringify(changes))
        .toMatchObject({ status: 409, body: { code: 'cannot_modify_self' } })
    }
    // The rest of one's own account can change.
    expect(await demoRequest('PATCH', '/api/admin/users/1', { body: edit(1, { name: 'James  Okafor-Reid', email: 'James.Okafor@example.com', phone: '', dwelling_id: 2 }) }))
      .toMatchObject({ status: 200, body: { name: 'James Okafor-Reid', phone: '', dwelling_id: 2, administrator: true, version: 2 } })
    expect(await session()).toMatchObject({ user_id: 1, administrator: true, name: 'James Okafor-Reid', dwelling_id: 2 })
  })
})

describe('deactivating and reactivating', () => {
  test('a deactivated neighbor cannot sign in and leaves the directory until reactivated', async () => {
    await signInAdmin()
    expect(await demoRequest('PATCH', '/api/admin/users/6/status', { body: { disabled: true, version: 1 } }))
      .toMatchObject({ status: 200, body: { id: 6, status: 'disabled', version: 2 } })
    expect(await directoryNames()).not.toContain('Olivia Bennett')
    expect(await signIn('olivia.bennett@example.com')).toMatchObject({ status: 401, body: { code: 'invalid_credentials' } })
    expect(await demoRequest('PATCH', '/api/admin/users/6/status', { body: { disabled: false, version: 2 } }))
      .toMatchObject({ status: 200, body: { status: 'active', invitation_status: 'none', version: 3 } })
    expect(await directoryNames()).toContain('Olivia Bennett')
    expect(await signIn('olivia.bennett@example.com')).toMatchObject({ status: 200, body: { user_id: 6 } })
  })

  test('deactivating the president leaves the presidency unassigned', async () => {
    await signInAdmin()
    await demoRequest('PUT', '/api/admin/presidency', { body: { user_id: 2, version: 1 } })
    await demoRequest('PATCH', '/api/admin/users/2/status', { body: { disabled: true, version: 1 } })
    expect(await president()).toEqual({ president: null, version: 3 })
    await demoRequest('PATCH', '/api/admin/users/2/status', { body: { disabled: false, version: 2 } })
    expect((await president()).president).toBeNull()
  })

  test('a pending invitation is withdrawn on deactivation and sent again on reactivation', async () => {
    await signInAdmin()
    expect(await demoRequest('PATCH', '/api/admin/users/15/status', { body: { disabled: true, version: 1 } }))
      .toMatchObject({ status: 200, body: { status: 'disabled', invitation_status: 'none', invitation_sent_at: null, invitation_expires_at: null } })
    expect(await demoRequest('PATCH', '/api/admin/users/15/status', { body: { disabled: false, version: 2 } }))
      .toMatchObject({ status: 200, body: { status: 'pending', invitation_status: 'sent', invitation_sent_at: NOW.toISOString(), version: 3 } })
  })

  test('asking for the current status changes nothing; stale versions and bad requests are refused', async () => {
    await signInAdmin()
    expect(await demoRequest('PATCH', '/api/admin/users/11/status', { body: { disabled: true, version: 1 } }))
      .toMatchObject({ status: 200, body: { status: 'disabled', version: 1 } })
    expect(await demoRequest('PATCH', '/api/admin/users/6/status', { body: { disabled: true, version: 3 } }))
      .toMatchObject({ status: 409, body: { code: 'record_stale' } })
    expect(await demoRequest('PATCH', '/api/admin/users/99/status', { body: { disabled: true, version: 1 } }))
      .toMatchObject({ status: 404, body: { code: 'user_not_found' } })
    expect(await demoRequest('PATCH', '/api/admin/users/6/status', { body: { disabled: 'yes', version: 1 } }))
      .toMatchObject({ status: 422, body: { code: 'invalid_request' } })
    expect(await user(6)).toMatchObject({ status: 'active', version: 1 })
  })

  test('nobody deactivates their own account, before any other check', async () => {
    await signInAdmin()
    for (const body of [{ disabled: true, version: 1 }, { disabled: true, version: 7 }, { disabled: false, version: 1 }]) {
      expect(await demoRequest('PATCH', '/api/admin/users/1/status', { body }), JSON.stringify(body))
        .toMatchObject({ status: 409, body: { code: 'cannot_modify_self' } })
    }
    expect(await user(1)).toMatchObject({ status: 'active', version: 1 })
  })
})

describe('deleting users', () => {
  test('needs the email as confirmation and the current version', async () => {
    await signInAdmin()
    expect(await demoRequest('DELETE', '/api/admin/users/6', { body: { email: 'grace.liu@example.com', version: 1 } }))
      .toMatchObject({ status: 422, body: { code: 'user_delete_confirmation_required' } })
    expect(await demoRequest('DELETE', '/api/admin/users/6', { body: { email: 'olivia.bennett@example.com', version: 2 } }))
      .toMatchObject({ status: 409, body: { code: 'record_stale' } })
    expect(await demoRequest('DELETE', '/api/admin/users/99', { body: { email: 'olivia.bennett@example.com', version: 1 } }))
      .toMatchObject({ status: 404, body: { code: 'user_not_found' } })
    expect(await demoRequest('DELETE', '/api/admin/users/6', { body: { version: 1 } })).toMatchObject({ status: 422, body: { code: 'invalid_request' } })
    expect(await users()).toHaveLength(RESIDENTS.length)
  })

  test('removes the account; the dwelling stays and the email can be invited again', async () => {
    await signInAdmin()
    expect(await demoRequest('DELETE', '/api/admin/users/6', { body: { email: 'Olivia.Bennett@example.com', version: 1 } }))
      .toMatchObject({ status: 204, body: undefined })
    expect(await user(6)).toBeUndefined()
    const directory = (await demoRequest<DwellingNeighborsOut[]>('GET', '/api/neighbors')).body
    expect(directory.find(dwelling => dwelling.label === '2B')?.neighbors).toEqual([])
    expect(await signIn('olivia.bennett@example.com')).toMatchObject({ status: 401, body: { code: 'invalid_credentials' } })
    expect(await demoRequest('POST', '/api/admin/users', { body: { name: 'Olivia Bennett', email: 'olivia.bennett@example.com', dwelling_id: 5 } }))
      .toMatchObject({ status: 201, body: { id: NEXT_ID, status: 'pending' } })
  })

  test('deleting the president leaves the presidency unassigned', async () => {
    await signInAdmin()
    await demoRequest('PUT', '/api/admin/presidency', { body: { user_id: 2, version: 1 } })
    await demoRequest('DELETE', '/api/admin/users/2', { body: { email: 'priya.sharma@example.com', version: 1 } })
    expect(await president()).toEqual({ president: null, version: 3 })
    expect(await demoRequest('PUT', '/api/admin/presidency', { body: { user_id: 2, version: 3 } }))
      .toMatchObject({ status: 404, body: { code: 'user_not_found' } })
  })

  test('nobody deletes their own account, before any other check', async () => {
    await signInAdmin()
    for (const body of [{ email: 'james.okafor@example.com', version: 1 }, { email: 'olivia.bennett@example.com', version: 3 }]) {
      expect(await demoRequest('DELETE', '/api/admin/users/1', { body }), JSON.stringify(body))
        .toMatchObject({ status: 409, body: { code: 'cannot_modify_self' } })
    }
    expect(await user(1)).toMatchObject({ status: 'active', administrator: true })
  })
})

describe('the last active administrator', () => {
  test('always remains: removing the last one is refused', async () => {
    // Through the API James always remains, since nobody changes their own role or status; the
    // backend's check also covers two administrators removing each other at the same time.
    expect(refusal(() => requireAdministratorRemains(resident(1)))).toEqual({ code: 'last_administrator', status: 409 })
    await signInAdmin()
    await demoRequest('PATCH', '/api/admin/users/2', { body: edit(2, { administrator: true }) })
    expect(refusal(() => requireAdministratorRemains(resident(1)))).toBeNull()
    expect(refusal(() => requireAdministratorRemains(resident(2)))).toBeNull()
    // Disabled and pending administrators do not count.
    await demoRequest('PATCH', '/api/admin/users/2/status', { body: { disabled: true, version: 2 } })
    await demoRequest('POST', '/api/admin/users', { body: { name: 'Ava Morgan', email: 'ava.morgan@example.com', administrator: true } })
    expect(refusal(() => requireAdministratorRemains(resident(1)))).toEqual({ code: 'last_administrator', status: 409 })
  })

  test('another administrator may lose the role, the account or its activation while the one making the change remains', async () => {
    await signInAdmin()
    await demoRequest('PATCH', '/api/admin/users/2', { body: edit(2, { administrator: true }) })
    expect(await demoRequest('PATCH', '/api/admin/users/2/status', { body: { disabled: true, version: 2 } }))
      .toMatchObject({ status: 200, body: { status: 'disabled', administrator: true } })
    expect(await demoRequest('PATCH', '/api/admin/users/2/status', { body: { disabled: false, version: 3 } }))
      .toMatchObject({ status: 200, body: { status: 'active' } })
    expect(await demoRequest('PATCH', '/api/admin/users/2', { body: edit(2, { administrator: true, email: 'priya.sharma@example.org', version: 4 }) }))
      .toMatchObject({ status: 200, body: { status: 'pending', administrator: true } })
    expect(await demoRequest('DELETE', '/api/admin/users/2', { body: { email: 'priya.sharma@example.org', version: 5 } }))
      .toMatchObject({ status: 204 })
    expect((await users()).filter(item => item.administrator).map(item => item.id)).toEqual([1])
  })
})
