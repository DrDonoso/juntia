/**
 * The signed-in account's own data in the demo (`/api/auth/*` besides signing in, after
 * src/juntia/users.py and google_auth.py): My profile, the password change and "sign out of all my
 * sessions" work like on a real server, for every account, administrators included. A changed
 * password lasts until the page is reloaded.
 *
 * The demo sends no email and has no Google project:
 * - `forgot-password` answers 202 `{"accepted": true}` for any address, exactly like the backend,
 *   which never tells whether an account exists and answers the same when SMTP is not configured;
 *   nothing is sent and no recovery link exists.
 * - No invitation or recovery link is ever issued, so `activate` and `reset-password` check the
 *   request and answer 400 `invalid_account_link`, the backend's answer to an unknown link.
 * - Google `start`, `link` and unlink answer 403 `demo_unavailable`.
 */
import type { ProfileOut, RecoveryOut } from '../../api/schema.gen'
import {
  Body, DemoApiError, demoUnavailable, hasControlCharacters, http, parseBody, readJson, revokeResidentSessions, route,
  type HttpHandler,
} from '../core'
import type { DemoResident } from '../store/core'
import { residentPasswordMatches, setResidentPassword } from '../store/people'
import { POSITIVE, accountToken, dwellingOf, newPassword, visibleCoefficient } from './people-shared'

function profileOut(resident: DemoResident): ProfileOut {
  const dwelling = dwellingOf(resident)
  return {
    email: resident.email,
    name: resident.name,
    phone: resident.phone,
    dwelling_id: resident.dwellingId,
    administrator: resident.administrator,
    id: resident.id,
    version: resident.version,
    dwelling_label: dwelling ? dwelling.label : null,
    coefficient: dwelling ? visibleCoefficient(dwelling) : null,
    last_login_at: resident.lastLoginAt,
    has_password: resident.hasPassword,
    google_linked: resident.googleLinked,
  }
}

/** `CurrentPasswordIn`, checked like `verify_current_password`. */
function requireCurrentPassword(resident: DemoResident, password: string): void {
  if (!resident.hasPassword) throw new DemoApiError('password_not_set', 409)
  if (!residentPasswordMatches(resident, password)) throw new DemoApiError('current_password_invalid', 400)
}

const currentPassword = (body: Body) => body.text('current_password', { min: 1, max: 1000 })

/**
 * Pages of the portal and of the administration a Google sign-in may return to (backend
 * `reader_route`; the frontend's `safeReturnPath` follows the same rule).
 */
function readerRoute(path: string): boolean {
  return ['/', '/transactions', '/neighbors', '/profile', '/actions', '/contacts', '/events', '/documents', '/search', '/admin'].includes(path)
    || /^\/(?:actions|events|documents\/folders)\/[1-9][0-9]{0,9}$/.test(path)
    || /^\/admin\/[a-z]{1,30}(?:-[a-z]{1,30}){0,3}$/.test(path)
}

/** `GoogleStartIn.return_path`: an internal page of the portal or the administration, without fragment. */
function returnPath(body: Body): string {
  const value = body.text('return_path', { max: 2048, fallback: '/' })
  if (body.failed('return_path')) return value
  const [beforeFragment, ...fragment] = value.split('#')
  const path = beforeFragment.split('?')[0]
  const safe = value.startsWith('/') && !value.startsWith('//') && !value.includes('\\') && !hasControlCharacters(value)
    && !fragment.join('#') && readerRoute(path)
  return safe ? value : body.fail('return_path', 'value_error') ?? value
}

export const peopleAccountHandlers: HttpHandler[] = [
  http.get('/api/auth/profile', route('session', ({ user }) => profileOut(user))),
  http.patch('/api/auth/profile', route('session', async ({ request, user: resident }) => {
    const input = parseBody(await readJson(request), body => ({
      name: body.name('name', { max: 150 }),
      phone: body.phone('phone'),
      phoneSupplied: body.present.has('phone'),
      version: body.int('version', POSITIVE),
    }))
    if (resident.version !== input.version) throw new DemoApiError('profile_stale', 409)
    resident.name = input.name
    if (input.phoneSupplied) resident.phone = input.phone
    resident.version += 1
    return profileOut(resident)
  })),
  http.post('/api/auth/profile/password', route('session', async ({ request, user: resident }) => {
    const input = parseBody(await readJson(request), body => ({ current: currentPassword(body), password: newPassword(body) }))
    requireCurrentPassword(resident, input.current)
    setResidentPassword(resident.id, input.password)
    resident.version += 1
    // Like the backend, every session of the account ends, this one included: sign in again with the new password.
    revokeResidentSessions(resident.id)
  }, { status: 204 })),
  http.delete('/api/auth/profile/sessions', route('session', ({ user }) => {
    revokeResidentSessions(user.id)
  }, { status: 204 })),
  http.post('/api/auth/forgot-password', route('public', async ({ request }): Promise<RecoveryOut> => {
    parseBody(await readJson(request), body => body.email('email'))
    return { accepted: true }
  }, { status: 202 })),
  ...['/api/auth/activate', '/api/auth/reset-password'].map(path => http.post(path, route('public', async ({ request }) => {
    parseBody(await readJson(request), body => ({ password: newPassword(body), token: accountToken(body, 'token') }))
    throw new DemoApiError('invalid_account_link', 400)
  }, { status: 204 }))),
  http.post('/api/auth/google/start', route('public', async ({ request }) => {
    parseBody(await readJson(request), body => ({
      invitationToken: accountToken(body, 'invitation_token', { optional: true }),
      returnPath: returnPath(body),
    }))
    return demoUnavailable()
  })),
  http.post('/api/auth/google/link', route('session', async ({ request }) => {
    parseBody(await readJson(request), currentPassword)
    return demoUnavailable()
  })),
  http.delete('/api/auth/google/link', route('session', async ({ request }) => {
    parseBody(await readJson(request), currentPassword)
    return demoUnavailable()
  })),
]
