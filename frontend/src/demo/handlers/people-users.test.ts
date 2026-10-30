import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import type { DwellingNeighborsOut, DwellingOut, PresidencyOut, UserOut } from '../../api/schema.gen'
import { RESIDENTS, activeResidents, castResidentsOf } from '../cast'
import { daysAgo, hoursFromNow, instant } from '../core'
import { resetDemo } from '../store'
import { coreStore } from '../store/core'
import { demoRequest } from '../testing'

// Thursday 29 October 2026, midday (local time).
const NOW = new Date(2026, 9, 29, 12, 0)

beforeEach(() => resetDemo({ now: () => NOW }))
afterEach(() => resetDemo())

const signInAdmin = () => demoRequest('POST', '/api/admin/auth/login', { body: { username: 'demo', password: 'demo' } })
const signIn = (email: string, password = 'demo') => demoRequest('POST', '/api/auth/login', { body: { email, password } })
const users = async () => (await demoRequest<UserOut[]>('GET', '/api/admin/users')).body
const user = async (id: number) => (await users()).find(item => item.id === id)
const directoryNames = async () => (await demoRequest<DwellingNeighborsOut[]>('GET', '/api/neighbors')).body
  .flatMap(dwelling => dwelling.neighbors.map(person => person.name))
const president = async () => (await demoRequest<PresidencyOut>('GET', '/api/admin/presidency')).body
/** Whether the visitor's neighbor session (Olivia Bennett) is still open. */
const visitorSignedIn = () => coreStore().session.residentId !== null

const invitation = { name: '  Ava   Morgan ', email: 'Ava.Morgan@Example.com', phone: '+44 20 7946 0999', dwelling_id: 11 }
/** Id of the next account (ids are never reused). */
const NEXT_ID = Math.max(...RESIDENTS.map(item => item.id)) + 1

describe('the users list', () => {
  test('shows every account by name, with its status, dwelling, sign-in and invitation', async () => {
    await signInAdmin()
    const list = await users()
    expect(list.map(item => item.name)).toEqual(RESIDENTS.map(item => item.name).sort((left, right) => left < right ? -1 : left > right ? 1 : 0))
    expect(list.find(item => item.id === 6)).toEqual({
      email: 'olivia.bennett@example.com', name: 'Olivia Bennett', phone: '+442079460152', dwelling_id: 5, id: 6, version: 1,
      status: 'active', dwelling_label: '2B', coefficient: '7.60', last_login_at: NOW.toISOString(), invitation_status: 'none',
      invitation_expires_at: null, invitation_sent_at: null, has_password: true, google_linked: false,
    })
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

  test('is for the administrator only', async () => {
    expect(await demoRequest('GET', '/api/admin/users')).toMatchObject({ status: 401, body: { code: 'authentication_required' } })
    expect(await demoRequest('POST', '/api/admin/users', { body: invitation })).toMatchObject({ status: 401 })
    expect(await demoRequest('PATCH', '/api/admin/users/6/status', { body: { disabled: true, version: 1 } })).toMatchObject({ status: 401 })
    expect(await demoRequest('DELETE', '/api/admin/users/6', { body: { email: 'olivia.bennett@example.com', version: 1 } })).toMatchObject({ status: 401 })
  })
})

describe('invitations', () => {
  test('inviting creates a pending account whose invitation counts as sent, without any email', async () => {
    await signInAdmin()
    const created = await demoRequest<UserOut>('POST', '/api/admin/users', { body: invitation })
    expect(created).toMatchObject({ status: 201 })
    expect(created.body).toEqual({
      email: 'ava.morgan@example.com', name: 'Ava Morgan', phone: '+442079460999', dwelling_id: 11, id: NEXT_ID, version: 1,
      status: 'pending', dwelling_label: '4B', coefficient: '7.90', last_login_at: null, invitation_status: 'sent',
      invitation_expires_at: hoursFromNow(72), invitation_sent_at: NOW.toISOString(), has_password: false, google_linked: false,
    })
    expect(await user(NEXT_ID)).toEqual(created.body)
    expect(await directoryNames()).not.toContain('Ava Morgan')
    expect((await demoRequest<DwellingOut[]>('GET', '/api/admin/dwellings')).body.find(dwelling => dwelling.id === 11)?.user_count).toBe(castResidentsOf(11).length + 1)
    expect(await signIn('ava.morgan@example.com')).toMatchObject({ status: 401, body: { code: 'invalid_credentials' } })
    expect(await demoRequest('POST', '/api/admin/users', { body: { ...invitation, phone: undefined, email: 'liam.wood@example.com' } }))
      .toMatchObject({ status: 201, body: { id: NEXT_ID + 1, phone: '' } })
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
    ]) {
      expect(await demoRequest('POST', '/api/admin/users', { body }), JSON.stringify(body)).toMatchObject({ status: 422, body: { code: 'invalid_request' } })
    }
    expect(await users()).toHaveLength(RESIDENTS.length)
  })

  test('the administrator resends pending invitations, with optimistic versions', async () => {
    await signInAdmin()
    expect(await demoRequest('POST', '/api/admin/users/16/invite', { body: { version: 1 } })).toMatchObject({
      status: 200,
      body: { id: 16, version: 2, status: 'pending', invitation_status: 'sent', invitation_sent_at: NOW.toISOString(), invitation_expires_at: hoursFromNow(72) },
    })
    expect(await demoRequest('POST', '/api/admin/users/16/invite', { body: { version: 1 } }))
      .toMatchObject({ status: 409, body: { code: 'record_stale' } })
    expect(await demoRequest('POST', '/api/admin/users/1/invite', { body: { version: 1 } }))
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
  test('the administrator changes name, phone and dwelling; the directory follows', async () => {
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
    expect(await demoRequest('PATCH', '/api/admin/users/2', { body: { ...body, email: 'Grace.Liu@example.com' } })).toMatchObject({ status: 409, body: { code: 'record_conflict' } })
    expect(await demoRequest('PATCH', '/api/admin/users/2', { body: { ...body, version: undefined } })).toMatchObject({ status: 422, body: { code: 'invalid_request' } })
    expect(await user(2)).toMatchObject({ name: 'Priya Sharma', version: 1, dwelling_id: 1 })
  })

  test("a new email closes the neighbor's sessions, removes their password and Google, and invites them again", async () => {
    await signInAdmin()
    expect(visitorSignedIn()).toBe(true)
    expect(await demoRequest('PATCH', '/api/admin/users/6', {
      body: { name: 'Olivia Bennett', email: 'olivia.b@example.com', phone: '+442079460152', dwelling_id: 5, version: 1 },
    })).toMatchObject({
      status: 200,
      body: { email: 'olivia.b@example.com', status: 'pending', has_password: false, invitation_status: 'sent', invitation_sent_at: NOW.toISOString(), version: 2 },
    })
    expect(visitorSignedIn()).toBe(false)
    expect(await directoryNames()).not.toContain('Olivia Bennett')
    expect(await signIn('olivia.b@example.com')).toMatchObject({ status: 401, body: { code: 'invalid_credentials' } })
    expect(await demoRequest('PATCH', '/api/admin/users/7', {
      body: { name: 'Grace Liu', email: 'grace.liu@example.org', phone: '+442079460876', dwelling_id: 6, version: 1 },
    })).toMatchObject({ status: 200, body: { google_linked: false, has_password: false, status: 'pending' } })
  })

  test("a new email for the president leaves the presidency unassigned; for a disabled account, no invitation", async () => {
    await signInAdmin()
    await demoRequest('PATCH', '/api/admin/users/1', {
      body: { name: 'James Okafor', email: 'j.okafor@example.com', phone: '+442079460418', dwelling_id: 1, version: 1 },
    })
    expect(await president()).toEqual({ president: null, version: 2 })
    expect(await demoRequest('PATCH', '/api/admin/users/11', {
      body: { name: 'Noah Patel', email: 'noah.p@example.com', phone: '+442079460905', dwelling_id: 8, version: 1 },
    })).toMatchObject({ status: 200, body: { status: 'disabled', invitation_status: 'none', invitation_sent_at: null, has_password: false } })
  })
})

describe('deactivating and reactivating', () => {
  test('a deactivated neighbor loses their sessions and leaves the directory until reactivated', async () => {
    await signInAdmin()
    expect(await demoRequest('PATCH', '/api/admin/users/6/status', { body: { disabled: true, version: 1 } }))
      .toMatchObject({ status: 200, body: { id: 6, status: 'disabled', version: 2 } })
    expect(visitorSignedIn()).toBe(false)
    expect(await directoryNames()).not.toContain('Olivia Bennett')
    expect(await signIn('olivia.bennett@example.com')).toMatchObject({ status: 401, body: { code: 'invalid_credentials' } })
    expect(await demoRequest('PATCH', '/api/admin/users/6/status', { body: { disabled: false, version: 2 } }))
      .toMatchObject({ status: 200, body: { status: 'active', invitation_status: 'none', version: 3 } })
    expect(await directoryNames()).toContain('Olivia Bennett')
    expect(await signIn('olivia.bennett@example.com')).toMatchObject({ status: 200, body: { user_id: 6 } })
  })

  test('deactivating the president leaves the presidency unassigned', async () => {
    await signInAdmin()
    await demoRequest('PATCH', '/api/admin/users/1/status', { body: { disabled: true, version: 1 } })
    expect(await president()).toEqual({ president: null, version: 2 })
    await demoRequest('PATCH', '/api/admin/users/1/status', { body: { disabled: false, version: 2 } })
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
    expect(visitorSignedIn()).toBe(true)
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
    expect(visitorSignedIn()).toBe(true)
  })

  test('removes the account and its sessions; the dwelling stays and the email can be invited again', async () => {
    await signInAdmin()
    expect(await demoRequest('DELETE', '/api/admin/users/6', { body: { email: 'Olivia.Bennett@example.com', version: 1 } }))
      .toMatchObject({ status: 204, body: undefined })
    expect(visitorSignedIn()).toBe(false)
    expect(await user(6)).toBeUndefined()
    const directory = (await demoRequest<DwellingNeighborsOut[]>('GET', '/api/neighbors')).body
    expect(directory.find(dwelling => dwelling.label === '2B')?.neighbors).toEqual([])
    expect(await demoRequest('POST', '/api/admin/users', { body: { name: 'Olivia Bennett', email: 'olivia.bennett@example.com', dwelling_id: 5 } }))
      .toMatchObject({ status: 201, body: { id: NEXT_ID, status: 'pending' } })
  })

  test('deleting the president leaves the presidency unassigned', async () => {
    await signInAdmin()
    await demoRequest('DELETE', '/api/admin/users/1', { body: { email: 'james.okafor@example.com', version: 1 } })
    expect(await president()).toEqual({ president: null, version: 2 })
    expect(await demoRequest('PUT', '/api/admin/presidency', { body: { user_id: 1, version: 2 } }))
      .toMatchObject({ status: 404, body: { code: 'user_not_found' } })
  })
})
