import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { RESIDENTS } from '../cast'
import { SIGNED_OUT } from '../core'
import { resetDemo } from '../store'
import { coreStore, findResident } from '../store/core'
import { demoRequest, signInAdmin } from '../testing'
import { communityHandlers } from './community'
import { coreHandlers } from './core'
import { financeHandlers } from './finance'
import { UNHANDLED_PREFIX, UNHANDLED_STATUS, domainHandlers, handlers, unhandledHandler } from './index'
import { peopleHandlers } from './people'
import { sharedDocumentHandlers } from './shared-documents'
import { storageHandlers } from './storage'

// Thursday 29 October 2026, midday (local time).
const NOW = new Date(2026, 9, 29, 12, 0)
const SESSION_END = new Date(NOW.getTime() + 168 * 3_600_000).toISOString()

beforeEach(() => resetDemo({ now: () => NOW }))
afterEach(() => resetDemo())

const login = (email: string, password = 'demo') => demoRequest('POST', '/api/auth/login', { body: { email, password } })

describe('the demo API modules', () => {
  test('every module exports an array of handlers, gathered before the catch-all', () => {
    const modules = [coreHandlers, financeHandlers, communityHandlers, peopleHandlers, storageHandlers, sharedDocumentHandlers]
    for (const module of modules) expect(Array.isArray(module)).toBe(true)
    expect(domainHandlers).toEqual({
      core: coreHandlers, finance: financeHandlers, community: communityHandlers, people: peopleHandlers, storage: storageHandlers,
      documents: sharedDocumentHandlers,
    })
    expect(handlers).toEqual([...modules.flat(), unhandledHandler])
    expect(unhandledHandler.info).toMatchObject({ path: '/api/*' })
  })

  test('an /api route nobody serves is a loud 501', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    expect(await demoRequest('PATCH', '/api/nothing/here')).toMatchObject({ status: UNHANDLED_STATUS, body: { code: 'not_implemented' } })
    expect(error).toHaveBeenCalledWith(`${UNHANDLED_PREFIX} PATCH /api/nothing/here`)
    error.mockRestore()
  })
})

describe('sessions and sign-in', () => {
  test('the visitor starts signed in as the sample neighbor', async () => {
    expect((await demoRequest('GET', '/api/auth/session')).body).toEqual({
      authenticated: true, administrator: false, name: 'Olivia Bennett', email: 'olivia.bennett@example.com',
      user_id: 6, dwelling_id: 5, expires_at: SESSION_END,
    })
  })

  test('every active account signs in with the password demo, the administrator too, replacing the session', async () => {
    expect(await login('James.Okafor@Example.com')).toMatchObject({
      status: 200,
      body: {
        authenticated: true, administrator: true, name: 'James Okafor', email: 'james.okafor@example.com', user_id: 1,
        dwelling_id: 1, expires_at: SESSION_END,
      },
    })
    expect((await demoRequest('GET', '/api/auth/session')).body).toMatchObject({ user_id: 1, administrator: true })
    expect(findResident(1)?.lastLoginAt).toBe(NOW.toISOString())
    expect(await login('grace.liu@example.com')).toMatchObject({ status: 200, body: { user_id: 7, administrator: false } })
    expect((await demoRequest('GET', '/api/auth/session')).body).toMatchObject({ user_id: 7, administrator: false })
  })

  test('wrong passwords, pending, disabled and unknown accounts get invalid_credentials', async () => {
    for (const [email, password] of [
      ['james.okafor@example.com', 'Demo'],
      ['ethan.brooks@example.com', 'demo'],
      ['noah.patel@example.com', 'demo'],
      ['nobody@example.com', 'demo'],
    ]) {
      expect(await login(email, password)).toMatchObject({ status: 401, body: { code: 'invalid_credentials' } })
    }
    expect((await demoRequest('GET', '/api/auth/session')).body).toMatchObject({ user_id: 6 })
  })

  test('a password changed in My profile signs in instead of demo, until a reload', async () => {
    const password = 'new-demo-password'
    expect(await demoRequest('POST', '/api/auth/profile/password', { body: { current_password: 'demo', password } })).toMatchObject({ status: 204 })
    expect((await demoRequest('GET', '/api/auth/session')).body).toEqual(SIGNED_OUT)
    expect(await login('olivia.bennett@example.com')).toMatchObject({ status: 401, body: { code: 'invalid_credentials' } })
    expect(await login('olivia.bennett@example.com', password)).toMatchObject({ status: 200, body: { user_id: 6, expires_at: SESSION_END } })
    // The other neighbors keep demo.
    expect(await login('james.okafor@example.com')).toMatchObject({ status: 200, body: { user_id: 1 } })

    resetDemo({ now: () => NOW })
    expect(await login('olivia.bennett@example.com', password)).toMatchObject({ status: 401, body: { code: 'invalid_credentials' } })
    expect(await login('olivia.bennett@example.com')).toMatchObject({ status: 200, body: { user_id: 6 } })
  })

  test('an email changed by an administrator removes the password: the account is invited again', async () => {
    await signInAdmin()
    expect(await demoRequest('PATCH', '/api/admin/users/2', {
      body: { name: 'Priya Sharma', email: 'priya.sharma@example.org', phone: '+442079460563', dwelling_id: 1, version: 1 },
    })).toMatchObject({ status: 200, body: { status: 'pending' } })
    for (const email of ['priya.sharma@example.com', 'priya.sharma@example.org']) {
      expect(await login(email)).toMatchObject({ status: 401, body: { code: 'invalid_credentials' } })
    }
  })

  test('sign-in requests follow the API contract and the write header', async () => {
    expect(await login('not-an-email')).toMatchObject({ status: 422, body: { code: 'invalid_request' } })
    expect(await demoRequest('POST', '/api/auth/login', { body: { email: 'james.okafor@example.com', password: 'demo', remember: true } }))
      .toMatchObject({ status: 422, body: { code: 'invalid_request' } })
    expect(await demoRequest('POST', '/api/auth/login', { body: { email: 'james.okafor@example.com', password: 'demo' }, mutationHeader: false }))
      .toMatchObject({ status: 403, body: { code: 'invalid_origin' } })
    // Administrators sign in with their email, like everyone: there is no username.
    expect(await demoRequest('POST', '/api/auth/login', { body: { username: 'demo', password: 'demo' } })).toMatchObject({ status: 422 })
  })

  test('the administration is for administrators: a neighbor gets 403 administrator_required', async () => {
    const requests: [string, string, unknown?][] = [
      ['GET', '/api/admin/users'], ['GET', '/api/admin/presidency'], ['GET', '/api/admin/storage'], ['GET', '/api/admin/statements'],
      ['PATCH', '/api/admin/settings/general', { community_name: 'Elm Court' }], ['GET', '/api/admin/documents/deleted'],
    ]
    for (const [method, path, body] of requests) {
      expect(await demoRequest(method, path, { body }), `${method} ${path}`).toMatchObject({ status: 403, body: { code: 'administrator_required' } })
    }
    await signInAdmin()
    for (const [method, path] of requests.filter(([method]) => method === 'GET')) {
      expect((await demoRequest(method, path)).status, path).toBe(200)
    }
  })

  test('signing out ends the session, and a reset starts again', async () => {
    await signInAdmin()
    expect(await demoRequest('POST', '/api/auth/logout')).toMatchObject({ status: 204, body: undefined })
    expect((await demoRequest('GET', '/api/auth/session')).body).toEqual(SIGNED_OUT)
    expect(await demoRequest('GET', '/api/account')).toMatchObject({ status: 401, body: { code: 'authentication_required' } })
    expect(await demoRequest('GET', '/api/admin/users')).toMatchObject({ status: 401, body: { code: 'authentication_required' } })

    resetDemo({ now: () => NOW })
    expect((await demoRequest('GET', '/api/auth/session')).body).toMatchObject({ authenticated: true, user_id: 6 })
  })
})

describe('the first-run setup', () => {
  const account = { name: 'Ada Morgan', email: 'ada.morgan@example.com', password: 'a-long-enough-password' }

  test('is never available: the demo always has accounts', async () => {
    expect(await demoRequest('GET', '/api/auth/setup')).toMatchObject({ status: 200, body: { available: false } })
    await demoRequest('POST', '/api/auth/logout')
    expect(await demoRequest('GET', '/api/auth/setup')).toMatchObject({ status: 200, body: { available: false } })
    expect(await demoRequest('POST', '/api/auth/setup', { body: account })).toMatchObject({ status: 409, body: { code: 'setup_unavailable' } })
    expect((await demoRequest('GET', '/api/auth/session')).body).toEqual(SIGNED_OUT)
    expect(coreStore().residents).toHaveLength(RESIDENTS.length)
  })

  test('checks the new account like the backend before refusing it', async () => {
    for (const body of [
      { ...account, name: '   ' }, { ...account, email: 'ada.morgan' }, { ...account, password: 'too-short' },
      { ...account, password: ' '.repeat(12) }, { ...account, password: '\u{1F600}'.repeat(19) },
      { name: account.name, email: account.email }, { ...account, administrator: true },
    ]) {
      expect(await demoRequest('POST', '/api/auth/setup', { body }), JSON.stringify(body)).toMatchObject({ status: 422, body: { code: 'invalid_request' } })
    }
    expect(await demoRequest('POST', '/api/auth/setup', { body: account, mutationHeader: false }))
      .toMatchObject({ status: 403, body: { code: 'invalid_origin' } })
  })
})

describe('branding, features, version, account and health', () => {
  test('public settings and feature flags follow the core store', async () => {
    expect((await demoRequest('GET', '/api/features')).body).toEqual({
      coefficient: true, actions: true, events: true, documents: true, google_login: false,
    })
    coreStore().features.actions = false
    expect((await demoRequest('GET', '/api/features')).body).toMatchObject({ actions: false })
    expect((await demoRequest('GET', '/api/settings/general')).body).toEqual({ community_name: 'Maple Court' })
    expect((await demoRequest('GET', '/api/version')).body).toEqual({ version: 'demo', build_date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) })
    expect((await demoRequest('GET', '/health')).body).toEqual({ status: 'ok' })
  })

  test('the bank account needs a session', async () => {
    expect(await demoRequest('GET', '/api/account')).toMatchObject({
      status: 200, body: { iban: 'ES3099990001230123456789', name: 'Community account' },
    })
    coreStore().account = null
    expect(await demoRequest('GET', '/api/account')).toMatchObject({ status: 200, body: null })
    await demoRequest('POST', '/api/auth/logout')
    expect(await demoRequest('GET', '/api/account')).toMatchObject({ status: 401 })
  })
})

describe("what's new", () => {
  const seen = (ids: unknown) => demoRequest('POST', '/api/whats-new/seen', { body: { ids } })

  test('keeps the notes the account has read, checked like the API', async () => {
    // None recorded at first: the app then marks every note as read (nothing to catch up on).
    expect((await demoRequest('GET', '/api/whats-new')).body).toEqual({ seen: null })
    const read = ['2026-11-17-whats-new', '2026-12-01-search']
    expect((await seen(['2026-12-01-search', '2026-11-17-whats-new', '2026-12-01-search'])).body).toEqual({ seen: read })
    expect((await seen(['2026-11-17-whats-new'])).body).toEqual({ seen: read })
    const invalid: unknown[] = [
      { ids: [] },
      { ids: Array.from({ length: 501 }, (_, index) => `2026-01-01-n${index}`) },
      { ids: '2026-11-17-whats-new' },
      { ids: [7] },
      { ids: ['whats-new'] },
      { ids: ['2026-11-17-Whats-New'] },
      { ids: [' 2026-11-17-whats-new'] },
      { ids: [`2026-11-17-${'a'.repeat(70)}`] },
      {},
      { ids: read, all: true },
    ]
    for (const body of invalid) {
      expect(await demoRequest('POST', '/api/whats-new/seen', { body }), JSON.stringify(body))
        .toMatchObject({ status: 422, body: { code: 'invalid_request' } })
    }
    expect((await demoRequest('GET', '/api/whats-new')).body).toEqual({ seen: read })
  })

  test('each account keeps its own notes, and reading them needs a session', async () => {
    await seen(['2026-11-17-whats-new'])
    await login('james.okafor@example.com')
    expect((await demoRequest('GET', '/api/whats-new')).body).toEqual({ seen: null })
    await demoRequest('POST', '/api/auth/logout')
    expect(await demoRequest('GET', '/api/whats-new')).toMatchObject({ status: 401, body: { code: 'authentication_required' } })
    expect(await seen(['2026-12-01-search'])).toMatchObject({ status: 401, body: { code: 'authentication_required' } })
    expect(coreStore().whatsNewSeen).toEqual(new Map([[6, ['2026-11-17-whats-new']]]))
  })
})
