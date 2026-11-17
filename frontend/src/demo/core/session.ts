/**
 * The session of the demo, with the backend's rules (src/juntia/auth.py): one per browser, like the
 * backend's single `juntia_user` cookie, for any account. Administrators are accounts with the
 * `administrator` flag (../store/core.ts; in the cast, the president James Okafor) and sign in like
 * everyone else. A session ends when it expires or its account can no longer sign in, and every
 * request reads the account again, so a revoked role or a disabled account applies at once. Guards
 * answer the backend's errors: 401 `authentication_required` without a session, and 403
 * `administrator_required` on the administration (`/api/admin/*`) for an account without the role.
 *
 * A handler gets the signed-in account, a `DemoResident` whose `id` is its user id, from its route
 * context (`route('session', ({ user }) => …)`, see ./http.ts) or from {@link requireAnySession};
 * {@link actorOf} makes it the author of what it writes.
 */
import type { ActorOut, UserAuthOut } from '../../api/schema.gen'
import { DEMO_SESSION_HOURS } from '../config'
import { coreStore, findResident, type DemoResident } from '../store/core'
import { hoursFromNow, now } from './clock'
import { DemoApiError } from './errors'

/** `GET /api/auth/session` while nobody is signed in. */
export const SIGNED_OUT: UserAuthOut = {
  authenticated: false, administrator: false, name: null, email: null, user_id: null, dwelling_id: null, expires_at: null,
}

/** The signed-in account, while its session lasts and the account is active and enabled; null otherwise. */
export function signedInResident(): DemoResident | null {
  const { session } = coreStore()
  if (session.residentId === null || session.expiresAt === null || Date.parse(session.expiresAt) <= now().getTime()) return null
  const resident = findResident(session.residentId)
  return resident && resident.activated && !resident.disabled ? resident : null
}

/** The signed-in account (backend `reader_session`): 401 `authentication_required` without one. */
export function requireAnySession(): DemoResident {
  const resident = signedInResident()
  if (!resident) throw new DemoApiError('authentication_required', 401)
  return resident
}

/**
 * A signed-in administrator (backend `administrator_session`, every `/api/admin/*` route): 401
 * `authentication_required` without a session, 403 `administrator_required` without the role.
 */
export function requireAdmin(): DemoResident {
  const resident = requireAnySession()
  if (!resident.administrator) throw new DemoApiError('administrator_required', 403)
  return resident
}

/** Signs an account in for {@link DEMO_SESSION_HOURS}, replacing this browser's session. */
export function signInResident(residentId: number): void {
  const { session } = coreStore()
  session.residentId = residentId
  session.expiresAt = hoursFromNow(DEMO_SESSION_HOURS)
}

/** Signs this browser out. */
export function signOutResident(): void {
  const { session } = coreStore()
  session.residentId = null
  session.expiresAt = null
}

/**
 * Ends the sessions of an account, like the backend's `revoke_user` (account disabled or deleted,
 * email or password changed, "close my sessions"): this browser's, when that account is signed in.
 */
export function revokeResidentSessions(residentId: number): void {
  if (coreStore().session.residentId === residentId) signOutResident()
}

/** `UserAuthOut` of a signed-in account (backend `signed_in`). */
export function residentAuth(resident: DemoResident): UserAuthOut {
  return {
    authenticated: true, administrator: resident.administrator, name: resident.name, email: resident.email,
    user_id: resident.id, dwelling_id: resident.dwellingId, expires_at: coreStore().session.expiresAt,
  }
}

/** `GET /api/auth/session`: the signed-in account, or {@link SIGNED_OUT}. */
export function readerSession(): UserAuthOut {
  const resident = signedInResident()
  return resident ? residentAuth(resident) : { ...SIGNED_OUT }
}

/**
 * Who writes something (backend `auth.Actor`): the author stored with it, `resident` with the
 * account's id and name for every account, administrators included, and whether the account
 * administers, which lets it change what others wrote (comments, PDFs, shared documents). Records
 * keep only the author (`authorship()` in ../store/community-model.ts), never the role.
 */
export interface DemoActor extends ActorOut {
  kind: 'resident'
  user_id: number
  administrator: boolean
}

/** The actor of an account (backend `actor_of`). */
export function actorOf(resident: DemoResident): DemoActor {
  return { kind: 'resident', user_id: resident.id, name: resident.name, administrator: resident.administrator }
}
