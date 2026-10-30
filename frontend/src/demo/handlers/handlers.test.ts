import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { SIGNED_OUT } from '../core'
import { resetDemo } from '../store'
import { coreStore, findResident } from '../store/core'
import { demoRequest } from '../testing'
import { communityHandlers } from './community'
import { coreHandlers } from './core'
import { financeHandlers } from './finance'
import { UNHANDLED_PREFIX, UNHANDLED_STATUS, domainHandlers, handlers, unhandledHandler } from './index'
import { peopleHandlers } from './people'
import { storageHandlers } from './storage'

// Thursday 29 October 2026, midday (local time): sessions last until midnight.
const NOW = new Date(2026, 9, 29, 12, 0)
const SESSION_END = new Date(2026, 9, 30, 0, 0).toISOString()

beforeEach(() => resetDemo({ now: () => NOW }))
afterEach(() => resetDemo())

const login = (email: string, password = 'demo') => demoRequest('POST', '/api/auth/login', { body: { email, password } })
const adminLogin = (password = 'demo') => demoRequest('POST', '/api/admin/auth/login', { body: { username: 'demo', password } })

describe('the demo API modules', () => {
  test('every module exports an array of handlers, gathered before the catch-all', () => {
    const modules = [coreHandlers, financeHandlers, communityHandlers, peopleHandlers, storageHandlers]
    for (const module of modules) expect(Array.isArray(module)).toBe(true)
    expect(domainHandlers).toEqual({
      core: coreHandlers, finance: financeHandlers, community: communityHandlers, people: peopleHandlers, storage: storageHandlers,
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
      authenticated: true, kind: 'resident', name: 'Olivia Bennett', email: 'olivia.bennett@example.com',
      user_id: 6, dwelling_id: 5, expires_at: SESSION_END,
    })
    expect((await demoRequest('GET', '/api/admin/auth/session')).body).toEqual({ authenticated: false, username: null })
  })

  test('any active neighbor signs in with the password demo', async () => {
    expect(await login('James.Okafor@Example.com')).toMatchObject({
      status: 200, body: { authenticated: true, kind: 'resident', name: 'James Okafor', user_id: 1, dwelling_id: 1, expires_at: SESSION_END },
    })
    expect((await demoRequest('GET', '/api/auth/session')).body).toMatchObject({ user_id: 1 })
    expect(findResident(1)?.lastLoginAt).toBe(NOW.toISOString())
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

  test('an email changed by the administrator removes the password: the neighbor is invited again', async () => {
    await adminLogin()
    expect(await demoRequest('PATCH', '/api/admin/users/1', {
      body: { name: 'James Okafor', email: 'james.okafor@example.org', phone: '+442079460418', dwelling_id: 1, version: 1 },
    })).toMatchObject({ status: 200, body: { status: 'pending' } })
    for (const email of ['james.okafor@example.com', 'james.okafor@example.org']) {
      expect(await login(email)).toMatchObject({ status: 401, body: { code: 'invalid_credentials' } })
    }
  })

  test('sign-in requests follow the API contract and the write header', async () => {
    expect(await login('not-an-email')).toMatchObject({ status: 422, body: { code: 'invalid_request' } })
    expect(await demoRequest('POST', '/api/auth/login', { body: { email: 'james.okafor@example.com', password: 'demo', remember: true } }))
      .toMatchObject({ status: 422, body: { code: 'invalid_request' } })
    expect(await demoRequest('POST', '/api/auth/login', { body: { email: 'james.okafor@example.com', password: 'demo' }, mutationHeader: false }))
      .toMatchObject({ status: 403, body: { code: 'invalid_origin' } })
    expect(await demoRequest('POST', '/api/admin/auth/login', { body: { username: 'demo' } })).toMatchObject({ status: 422 })
  })

  test('the administrator signs in with demo / demo and takes over the reader session', async () => {
    expect(await adminLogin('nope')).toMatchObject({ status: 401, body: { code: 'invalid_credentials' } })
    expect(await demoRequest('POST', '/api/admin/auth/logout')).toMatchObject({ status: 401, body: { code: 'authentication_required' } })
    expect(await adminLogin()).toMatchObject({ status: 200, body: { authenticated: true, username: 'demo' } })
    expect((await demoRequest('GET', '/api/admin/auth/session')).body).toEqual({ authenticated: true, username: 'demo' })
    expect((await demoRequest('GET', '/api/auth/session')).body).toEqual({
      authenticated: true, kind: 'administrator', name: 'demo', email: null, user_id: null, dwelling_id: null, expires_at: SESSION_END,
    })
    expect(await demoRequest('POST', '/api/admin/auth/logout')).toMatchObject({ status: 204, body: undefined })
    expect((await demoRequest('GET', '/api/auth/session')).body).toMatchObject({ kind: 'resident', user_id: 6 })
  })

  test('signing out of the portal ends both sessions, and a reset starts again', async () => {
    await adminLogin()
    expect(await demoRequest('POST', '/api/auth/logout')).toMatchObject({ status: 204, body: undefined })
    expect((await demoRequest('GET', '/api/auth/session')).body).toEqual(SIGNED_OUT)
    expect((await demoRequest('GET', '/api/admin/auth/session')).body).toEqual({ authenticated: false, username: null })
    expect(await demoRequest('GET', '/api/account')).toMatchObject({ status: 401, body: { code: 'authentication_required' } })

    resetDemo({ now: () => NOW })
    expect((await demoRequest('GET', '/api/auth/session')).body).toMatchObject({ authenticated: true, user_id: 6 })
  })
})

describe('branding, features, version, account and health', () => {
  test('public settings and feature flags follow the core store', async () => {
    expect((await demoRequest('GET', '/api/features')).body).toEqual({ coefficient: true, actions: true, events: true, google_login: false })
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
