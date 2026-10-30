/**
 * Core endpoints of the demo API: sessions and sign-in for neighbors and the administrator, the
 * public branding and feature flags, the version, the bank account and the health check.
 * Neighbors sign in with their cast email and the password `demo`, or the one they chose in My
 * profile during the visit; the administrator with `demo` / `demo` (src/juntia/auth.py rules:
 * wrong or ineligible credentials are 401 `invalid_credentials`, and signing out of the portal
 * ends both sessions).
 */
import type { FeatureFlagsOut, VersionOut } from '../../api/schema.gen'
import { DEMO_ADMIN_USERNAME, DEMO_PASSWORD } from '../config'
import {
  DemoApiError, adminSession, http, nowIso, parseBody, readJson, readerSession, residentAuth, route, signInAdmin,
  signInResident, signOutAdmin, signOutResident, type HttpHandler,
} from '../core'
import { canSignIn, coreStore, findResidentByEmail } from '../store/core'
import { residentPasswordMatches } from '../store/people'

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
    signOutAdmin()
  }, { status: 204 })),
  http.get('/api/admin/auth/session', route('public', () => adminSession())),
  http.post('/api/admin/auth/login', route('public', async ({ request }) => {
    const { username, password } = parseBody(await readJson(request), body => ({
      username: body.text('username', { max: 150 }),
      password: body.text('password', { max: 1000 }),
    }))
    if (username !== DEMO_ADMIN_USERNAME || password !== DEMO_PASSWORD) throw new DemoApiError('invalid_credentials', 401)
    signInAdmin()
    return adminSession()
  })),
  http.post('/api/admin/auth/logout', route('admin', () => {
    signOutAdmin()
  }, { status: 204 })),
  http.get('/api/features', route('public', () => featureFlags())),
  http.get('/api/settings/general', route('public', () => ({ ...coreStore().general }))),
  http.get('/api/version', route('public', (): VersionOut => ({ version: 'demo', build_date: __DEMO_BUILD_DATE__ }))),
  http.get('/api/account', route('session', () => {
    const { account } = coreStore()
    return account && { ...account }
  })),
  http.get('/health', route('public', () => ({ status: 'ok' }))),
]
