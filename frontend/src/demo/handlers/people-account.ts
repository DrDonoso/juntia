/**
 * The neighbor's own account in the demo (`/api/auth/*` besides signing in, after
 * src/juntia/users.py and google_auth.py): My profile, the password change and "sign out of all my
 * sessions" work like on a real server, for neighbors only (the administrator gets 403
 * `resident_profile_required`). A changed password lasts until the page is reloaded.
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
  type HttpHandler, type Identity,
} from '../core'
import type { DemoResident } from '../store/core'
import { residentPasswordMatches, setResidentPassword } from '../store/people'
import { POSITIVE, accountToken, dwellingOf, newPassword, visibleCoefficient } from './people-shared'

/** The neighbor of a `route('resident', …)` request. */
function ownAccount(identity: Identity | null): DemoResident {
  if (identity?.kind !== 'resident') throw new Error('Resident routes always have a neighbor identity')
  return identity.resident
}

function profileOut(resident: DemoResident): ProfileOut {
  const dwelling = dwellingOf(resident)
  return {
    email: resident.email,
    name: resident.name,
    phone: resident.phone,
    dwelling_id: resident.dwellingId,
    id: resident.id,
    version: resident.version,
    dwelling_label: dwelling.label,
    coefficient: visibleCoefficient(dwelling),
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

/** Reader pages a Google sign-in may return to (backend `reader_route`). */
function readerRoute(path: string): boolean {
  return ['/', '/transactions', '/neighbors', '/profile', '/actions', '/contacts', '/events'].includes(path)
    || /^\/(?:actions|events)\/[1-9][0-9]{0,9}$/.test(path)
}

/** `GoogleStartIn.return_path`: an internal reader route, without fragment. */
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
  http.get('/api/auth/profile', route('resident', ({ identity }) => profileOut(ownAccount(identity)))),
  http.patch('/api/auth/profile', route('resident', async ({ request, identity }) => {
    const resident = ownAccount(identity)
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
  http.post('/api/auth/profile/password', route('resident', async ({ request, identity }) => {
    const resident = ownAccount(identity)
    const input = parseBody(await readJson(request), body => ({ current: currentPassword(body), password: newPassword(body) }))
    requireCurrentPassword(resident, input.current)
    setResidentPassword(resident.id, input.password)
    resident.version += 1
    // Like the backend, every session of the account ends, this one included: sign in again with the new password.
    revokeResidentSessions(resident.id)
  }, { status: 204 })),
  http.delete('/api/auth/profile/sessions', route('resident', ({ identity }) => {
    revokeResidentSessions(ownAccount(identity).id)
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
  http.post('/api/auth/google/link', route('resident', async ({ request }) => {
    parseBody(await readJson(request), currentPassword)
    return demoUnavailable()
  })),
  http.delete('/api/auth/google/link', route('resident', async ({ request }) => {
    parseBody(await readJson(request), currentPassword)
    return demoUnavailable()
  })),
]
