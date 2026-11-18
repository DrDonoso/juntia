import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import type { ProfileOut, UserAuthOut, UserOut } from '../../api/schema.gen'
import { signInResident } from '../core'
import { resetDemo } from '../store'
import { findResident, type DemoResident } from '../store/core'
import { residentPasswordMatches } from '../store/people'
import { demoRequest, signInAdmin } from '../testing'

// Thursday 29 October 2026, midday (local time).
const NOW = new Date(2026, 9, 29, 12, 0)

beforeEach(() => resetDemo({ now: () => NOW }))
afterEach(() => resetDemo())

const signIn = (email: string, password = 'demo') => demoRequest('POST', '/api/auth/login', { body: { email, password } })
const signOut = () => demoRequest('POST', '/api/auth/logout')
const session = async () => (await demoRequest<UserAuthOut>('GET', '/api/auth/session')).body

function resident(id: number): DemoResident {
  const found = findResident(id)
  if (!found) throw new Error(`No neighbor ${id}`)
  return found
}

const TOKEN = 'a'.repeat(64)
const NEW_PASSWORD = 'new-demo-password'

describe('My profile', () => {
  test("shows the signed-in account, with its role and dwelling", async () => {
    expect(await demoRequest('GET', '/api/auth/profile')).toEqual(expect.objectContaining({
      status: 200,
      body: {
        email: 'olivia.bennett@example.com', name: 'Olivia Bennett', phone: '+442079460152', dwelling_id: 5, administrator: false, id: 6,
        version: 1, dwelling_label: '2B', coefficient: '7.60', last_login_at: NOW.toISOString(), has_password: true, google_linked: false,
      },
    }))
    await signIn('grace.liu@example.com')
    expect((await demoRequest<ProfileOut>('GET', '/api/auth/profile')).body).toMatchObject({ id: 7, google_linked: true, dwelling_label: '2C' })
    await signInAdmin()
    expect((await demoRequest<ProfileOut>('GET', '/api/auth/profile')).body)
      .toMatchObject({ id: 1, administrator: true, dwelling_id: 1, dwelling_label: '1A', coefficient: '8.90' })
  })

  test('an administrator without a dwelling has a profile too, with no dwelling nor coefficient', async () => {
    await signInAdmin()
    await demoRequest('PATCH', '/api/admin/users/2', {
      body: { name: 'Priya Sharma', email: 'priya.sharma@example.com', phone: '+442079460563', dwelling_id: null, administrator: true, version: 1 },
    })
    await signIn('priya.sharma@example.com')
    expect((await demoRequest<ProfileOut>('GET', '/api/auth/profile')).body)
      .toMatchObject({ id: 2, administrator: true, dwelling_id: null, dwelling_label: null, coefficient: null })
    expect(await demoRequest('PATCH', '/api/auth/profile', { body: { name: 'Priya Sharma', phone: '', version: 2 } }))
      .toMatchObject({ status: 200, body: { phone: '', version: 3, dwelling_id: null } })
  })

  test('is for every signed-in account: visitors without a session get 401', async () => {
    const requests: [string, string, unknown?][] = [
      ['GET', '/api/auth/profile'], ['PATCH', '/api/auth/profile', { name: 'James Okafor', version: 1 }],
      ['POST', '/api/auth/profile/password', { current_password: 'demo', password: NEW_PASSWORD }], ['DELETE', '/api/auth/profile/sessions'],
      ['POST', '/api/auth/google/link', { current_password: 'demo' }], ['DELETE', '/api/auth/google/link', { current_password: 'demo' }],
    ]
    await signOut()
    for (const [method, path, body] of requests) {
      expect(await demoRequest(method, path, { body }), `${method} ${path}`).toMatchObject({ status: 401, body: { code: 'authentication_required' } })
    }
    await signInAdmin()
    expect(await demoRequest('PATCH', '/api/auth/profile', { body: { name: 'James  Okafor', version: 1 } }))
      .toMatchObject({ status: 200, body: { id: 1, name: 'James Okafor', version: 2 } })
    expect(await demoRequest('POST', '/api/auth/profile/password', { body: { current_password: 'demo', password: NEW_PASSWORD } }))
      .toMatchObject({ status: 204 })
    expect((await session()).authenticated).toBe(false)
    expect(residentPasswordMatches(resident(1), NEW_PASSWORD)).toBe(true)
  })

  test('the neighbor updates their name and phone; the session, users and directory follow', async () => {
    expect(await demoRequest('PATCH', '/api/auth/profile', { body: { name: ' Olivia   Bennett-Hart ', phone: '+44 (20) 7946-0153', version: 1 } }))
      .toMatchObject({ status: 200, body: { id: 6, name: 'Olivia Bennett-Hart', phone: '+442079460153', version: 2, email: 'olivia.bennett@example.com' } })
    expect((await session()).name).toBe('Olivia Bennett-Hart')
    expect(await demoRequest('PATCH', '/api/auth/profile', { body: { name: 'Olivia Bennett', version: 2 } }))
      .toMatchObject({ status: 200, body: { name: 'Olivia Bennett', phone: '+442079460153', version: 3 } })
    expect(await demoRequest('PATCH', '/api/auth/profile', { body: { name: 'Olivia', phone: '', version: 2 } }))
      .toMatchObject({ status: 409, body: { code: 'profile_stale' } })
    await signInAdmin()
    expect((await demoRequest<UserOut[]>('GET', '/api/admin/users')).body.find(user => user.id === 6)).toMatchObject({ phone: '+442079460153', version: 3 })
  })

  test('the profile form follows the contract: no blank names, valid phones, no other fields', async () => {
    for (const body of [
      { name: '   ', version: 1 }, { name: 'Olivia', phone: 'call me', version: 1 }, { name: 'Olivia' },
      { name: 'Olivia', email: 'olivia@example.org', version: 1 }, { name: 'x'.repeat(151), version: 1 },
    ]) {
      expect(await demoRequest('PATCH', '/api/auth/profile', { body }), JSON.stringify(body)).toMatchObject({ status: 422, body: { code: 'invalid_request' } })
    }
    expect(resident(6)).toMatchObject({ name: 'Olivia Bennett', version: 1 })
  })
})

describe('changing the password', () => {
  test('needs the current password and signs every session out; the new password lasts until a reload', async () => {
    expect(await demoRequest('POST', '/api/auth/profile/password', { body: { current_password: 'wrong-password', password: NEW_PASSWORD } }))
      .toMatchObject({ status: 400, body: { code: 'current_password_invalid' } })
    expect(await demoRequest('POST', '/api/auth/profile/password', { body: { current_password: 'demo', password: NEW_PASSWORD } }))
      .toMatchObject({ status: 204, body: undefined })
    expect((await session()).authenticated).toBe(false)
    expect(resident(6).version).toBe(2)
    expect(residentPasswordMatches(resident(6), NEW_PASSWORD)).toBe(true)
    expect(residentPasswordMatches(resident(6), 'demo')).toBe(false)
    resetDemo({ now: () => NOW })
    expect(residentPasswordMatches(resident(6), 'demo')).toBe(true)
  })

  test('a second change needs the password chosen in the first one', async () => {
    await demoRequest('POST', '/api/auth/profile/password', { body: { current_password: 'demo', password: NEW_PASSWORD } })
    signInResident(6)
    expect(await demoRequest('POST', '/api/auth/profile/password', { body: { current_password: 'demo', password: 'another-password-1' } }))
      .toMatchObject({ status: 400, body: { code: 'current_password_invalid' } })
    expect(await demoRequest('POST', '/api/auth/profile/password', { body: { current_password: NEW_PASSWORD, password: 'another-password-1' } }))
      .toMatchObject({ status: 204 })
    expect(residentPasswordMatches(resident(6), 'another-password-1')).toBe(true)
  })

  test('the new password has 10 characters at least and 72 UTF-8 bytes at most, and is not blank', async () => {
    for (const password of ['short-pwd', ' '.repeat(12), 'x'.repeat(73), '\u{1F600}'.repeat(19)]) {
      expect(await demoRequest('POST', '/api/auth/profile/password', { body: { current_password: 'demo', password } }), JSON.stringify(password))
        .toMatchObject({ status: 422, body: { code: 'invalid_request' } })
    }
    for (const body of [{ password: NEW_PASSWORD }, { current_password: '', password: NEW_PASSWORD }, { current_password: 'demo', password: NEW_PASSWORD, confirmation: NEW_PASSWORD }]) {
      expect(await demoRequest('POST', '/api/auth/profile/password', { body }), JSON.stringify(body)).toMatchObject({ status: 422, body: { code: 'invalid_request' } })
    }
    // 18 emoji are 72 bytes: the longest password allowed.
    expect(await demoRequest('POST', '/api/auth/profile/password', { body: { current_password: 'demo', password: '\u{1F600}'.repeat(18) } }))
      .toMatchObject({ status: 204 })
  })

  test('an account without a local password must create one through recovery first', async () => {
    resident(6).hasPassword = false
    expect(await demoRequest('POST', '/api/auth/profile/password', { body: { current_password: 'demo', password: NEW_PASSWORD } }))
      .toMatchObject({ status: 409, body: { code: 'password_not_set' } })
  })
})

describe('signing out of every session', () => {
  test("closes this browser's session", async () => {
    expect(await demoRequest('DELETE', '/api/auth/profile/sessions')).toMatchObject({ status: 204, body: undefined })
    expect((await session()).authenticated).toBe(false)
    expect(await demoRequest('DELETE', '/api/auth/profile/sessions')).toMatchObject({ status: 401, body: { code: 'authentication_required' } })
    expect(await signIn('olivia.bennett@example.com')).toMatchObject({ status: 200, body: { user_id: 6 } })
    expect(resident(6).version).toBe(1)
  })
})

describe('links sent by email', () => {
  test('password recovery answers the same for every address, and sends nothing', async () => {
    await signOut()
    for (const email of ['olivia.bennett@example.com', 'nobody@example.com', 'ethan.brooks@example.com', 'noah.patel@example.com']) {
      expect(await demoRequest('POST', '/api/auth/forgot-password', { body: { email } }), email)
        .toMatchObject({ status: 202, body: { accepted: true } })
    }
    expect(await demoRequest('POST', '/api/auth/forgot-password', { body: { email: 'not-an-email' } })).toMatchObject({ status: 422, body: { code: 'invalid_request' } })
    expect(await demoRequest('POST', '/api/auth/forgot-password', { body: { email: 'olivia.bennett@example.com' }, mutationHeader: false }))
      .toMatchObject({ status: 403, body: { code: 'invalid_origin' } })
  })

  test('no invitation or recovery link exists in the demo: valid requests get invalid_account_link', async () => {
    for (const path of ['/api/auth/activate', '/api/auth/reset-password']) {
      expect(await demoRequest('POST', path, { body: { token: TOKEN, password: NEW_PASSWORD } }), path)
        .toMatchObject({ status: 400, body: { code: 'invalid_account_link' } })
      for (const body of [
        { token: TOKEN.toUpperCase(), password: NEW_PASSWORD }, { token: TOKEN.slice(1), password: NEW_PASSWORD }, { token: TOKEN, password: 'short' },
        { password: NEW_PASSWORD }, { token: TOKEN, password: NEW_PASSWORD, email: 'ethan.brooks@example.com' },
      ]) {
        expect(await demoRequest('POST', path, { body }), `${path} ${JSON.stringify(body)}`).toMatchObject({ status: 422, body: { code: 'invalid_request' } })
      }
    }
    expect(resident(15)).toMatchObject({ activated: false, hasPassword: false })
  })
})

describe('Google sign-in', () => {
  test('starting a Google sign-in is not available in the demo', async () => {
    await signOut()
    for (const body of [
      {}, { return_path: '/neighbors' }, { return_path: '/actions/12?view=comments' }, { invitation_token: TOKEN, return_path: '/' },
      { return_path: '/documents' }, { return_path: '/documents/folders/12' }, { return_path: '/admin' },
      { return_path: '/admin/users?sort=status' }, { return_path: '/admin/deleted-documents' },
    ]) {
      expect(await demoRequest('POST', '/api/auth/google/start', { body }), JSON.stringify(body)).toMatchObject({ status: 403, body: { code: 'demo_unavailable' } })
    }
    for (const body of [
      { return_path: 'https://evil.example.com/' }, { return_path: '//evil.example.com' }, { return_path: '/admin/' },
      { return_path: '/admin/Users' }, { return_path: '/admin/users/1' }, { return_path: '/admin/a-b-c-d-e' }, { return_path: '/administration' },
      { return_path: '/events/1#top' }, { return_path: '/\\evil' }, { invitation_token: 'abc' }, { remember: true },
      { return_path: '/documents/folders/0' }, { return_path: '/documents/files/1' },
    ]) {
      expect(await demoRequest('POST', '/api/auth/google/start', { body }), JSON.stringify(body)).toMatchObject({ status: 422, body: { code: 'invalid_request' } })
    }
  })

  test('linking and unlinking Google are not available either, and change nothing', async () => {
    await signIn('grace.liu@example.com')
    expect(await demoRequest('DELETE', '/api/auth/google/link', { body: { current_password: 'demo' } }))
      .toMatchObject({ status: 403, body: { code: 'demo_unavailable' } })
    expect(await demoRequest('POST', '/api/auth/google/link', { body: { current_password: 'demo' } }))
      .toMatchObject({ status: 403, body: { code: 'demo_unavailable' } })
    expect(await demoRequest('DELETE', '/api/auth/google/link', { body: {} })).toMatchObject({ status: 422, body: { code: 'invalid_request' } })
    expect(resident(7)).toMatchObject({ googleLinked: true, version: 1 })
    expect((await session()).user_id).toBe(7)
  })
})
