/**
 * Core endpoints of the demo API: the session, signing in and out, the first-run setup, the public
 * branding and feature flags, the version, the bank account, the "What's new" notes each account
 * has read and the health check. Every active account signs in with its cast email and the
 * password `demo`, or the one it chose in My profile during the visit: neighbors and administrators
 * alike (src/juntia/auth.py rules: wrong or ineligible credentials are 401 `invalid_credentials`).
 * The demo always has accounts, so the setup that creates the first administrator of a new
 * installation is never available.
 */
import type { FeatureFlagsOut, SetupOut, VersionOut, WhatsNewOut } from '../../api/schema.gen'
import {
  DemoApiError, NOTE_ID, http, nowIso, parseBody, readJson, readerSession, residentAuth, route, signInResident, signOutResident,
  type HttpHandler,
} from '../core'
import { canSignIn, coreStore, findResidentByEmail, markNotesRead, notesRead } from '../store/core'
import { residentPasswordMatches } from '../store/people'
import { newPassword } from './people-shared'

/** `GET /api/features`: Google sign-in needs a real Google project, so it is never on. */
export function featureFlags(): FeatureFlagsOut {
  return { ...coreStore().features, google_login: false }
}

export const coreHandlers: HttpHandler[] = [
  http.get('/api/auth/session', route('public', () => readerSession())),
  http.post('/api/auth/login', route('public', async ({ request }) => {
    const { email, password } = parseBody(await readJson(request), body => ({
      email: body.email('email'),
      password: body.text('password', { max: 1000 }),
    }))
    const resident = findResidentByEmail(email)
    if (!resident || !canSignIn(resident) || !residentPasswordMatches(resident, password)) throw new DemoApiError('invalid_credentials', 401)
    resident.lastLoginAt = nowIso()
    signInResident(resident.id)
    return residentAuth(resident)
  })),
  http.post('/api/auth/logout', route('public', () => {
    signOutResident()
  }, { status: 204 })),
  http.get('/api/auth/setup', route('public', (): SetupOut => ({ available: false }))),
  // `SetupIn` is checked like on the server, which then finds accounts and refuses.
  http.post('/api/auth/setup', route('public', async ({ request }) => {
    parseBody(await readJson(request), body => ({
      name: body.name('name', { max: 150 }), email: body.email('email'), password: newPassword(body),
    }))
    throw new DemoApiError('setup_unavailable', 409)
  })),
  http.get('/api/features', route('public', () => featureFlags())),
  http.get('/api/settings/general', route('public', () => ({ ...coreStore().general }))),
  http.get('/api/version', route('public', (): VersionOut => ({ version: 'demo', build_date: __DEMO_BUILD_DATE__ }))),
  http.get('/api/account', route('session', () => {
    const { account } = coreStore()
    return account && { ...account }
  })),
  http.get('/api/whats-new', route('session', ({ user }): WhatsNewOut => ({ seen: notesRead(user.id) }))),
  http.post('/api/whats-new/seen', route('session', async ({ request, user }): Promise<WhatsNewOut> => {
    const ids = parseBody(await readJson(request), body => body.strings('ids', NOTE_ID, { min: 1, max: 500, length: 80 }))
    return { seen: markNotesRead(user.id, ids) }
  })),
  http.get('/health', route('public', () => ({ status: 'ok' }))),
]
