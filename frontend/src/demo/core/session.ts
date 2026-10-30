/**
 * Sessions of the demo, with the backend's rules (src/juntia/auth.py): a neighbor session and an
 * administrator session can coexist, the administrator wins when both exist (`reader_session`),
 * and a session ends when it expires or the neighbor can no longer sign in. Guards answer the
 * backend's errors: 401 `authentication_required`, 403 `resident_profile_required`.
 */
import type { ActorOut, AuthOut, UserAuthOut } from '../../api/schema.gen'
import { ADMINISTRATOR_ACTOR_NAME } from '../cast'
import { DEMO_ADMIN_USERNAME, DEMO_SESSION_HOURS } from '../config'
import { coreStore, findResident, type DemoResident } from '../store/core'
import { hoursFromNow, now } from './clock'
import { DemoApiError } from './errors'

/** Who is making a request (backend `reader_session`). */
export type Identity =
  | { readonly kind: 'administrator' }
  | { readonly kind: 'resident'; readonly resident: DemoResident }

const ADMINISTRATOR: Identity = { kind: 'administrator' }

export const SIGNED_OUT: UserAuthOut = {
  authenticated: false, kind: null, name: null, email: null, user_id: null, dwelling_id: null, expires_at: null,
}

function current(expiresAt: string | null): boolean {
  return expiresAt !== null && Date.parse(expiresAt) > now().getTime()
}

/** Whether the administrator is signed in. */
export function adminSignedIn(): boolean {
  return current(coreStore().session.adminExpiresAt)
}

/** The signed-in neighbor, while their account is active and enabled. */
export function signedInResident(): DemoResident | null {
  const { session } = coreStore()
  if (session.residentId === null || !current(session.residentExpiresAt)) return null
  const resident = findResident(session.residentId)
  return resident && resident.activated && !resident.disabled ? resident : null
}

/** The administrator first, then the neighbor; null when nobody is signed in. */
export function readerIdentity(): Identity | null {
  if (adminSignedIn()) return ADMINISTRATOR
  const resident = signedInResident()
  return resident ? { kind: 'resident', resident } : null
}

/** Any reader session (finance, contacts, actions, events…): 401 without one. */
export function requireAnySession(): Identity {
  const identity = readerIdentity()
  if (!identity) throw new DemoApiError('authentication_required', 401)
  return identity
}

/** A neighbor's own session (profile): 401 without a session, 403 for the administrator. */
export function requireResident(): DemoResident {
  const identity = requireAnySession()
  if (identity.kind !== 'resident') throw new DemoApiError('resident_profile_required', 403)
  return identity.resident
}

/** The administrator session (`/api/admin/*`): 401 without it. */
export function requireAdmin(): Identity {
  if (!adminSignedIn()) throw new DemoApiError('authentication_required', 401)
  return ADMINISTRATOR
}

export function signInResident(residentId: number): void {
  const { session } = coreStore()
  session.residentId = residentId
  session.residentExpiresAt = hoursFromNow(DEMO_SESSION_HOURS)
}

export function signOutResident(): void {
  const { session } = coreStore()
  session.residentId = null
  session.residentExpiresAt = null
}

export function signInAdmin(): void {
  coreStore().session.adminExpiresAt = hoursFromNow(DEMO_SESSION_HOURS)
}

export function signOutAdmin(): void {
  coreStore().session.adminExpiresAt = null
}

/**
 * Ends the sessions of a neighbor, like the backend's `revoke_user` (account disabled or deleted,
 * email or password changed, "close my sessions").
 */
export function revokeResidentSessions(residentId: number): void {
  if (coreStore().session.residentId === residentId) signOutResident()
}

/** `UserAuthOut` of a neighbor session. */
export function residentAuth(resident: DemoResident): UserAuthOut {
  return {
    authenticated: true, kind: 'resident', name: resident.name, email: resident.email,
    user_id: resident.id, dwelling_id: resident.dwellingId, expires_at: coreStore().session.residentExpiresAt,
  }
}

/** `GET /api/auth/session`. */
export function readerSession(): UserAuthOut {
  const identity = readerIdentity()
  if (!identity) return { ...SIGNED_OUT }
  if (identity.kind === 'resident') return residentAuth(identity.resident)
  return {
    authenticated: true, kind: 'administrator', name: DEMO_ADMIN_USERNAME, email: null,
    user_id: null, dwelling_id: null, expires_at: coreStore().session.adminExpiresAt,
  }
}

/** `GET /api/admin/auth/session`. */
export function adminSession(): AuthOut {
  return adminSignedIn() ? { authenticated: true, username: DEMO_ADMIN_USERNAME } : { authenticated: false, username: null }
}

/**
 * Author of what an identity writes (`ActorOut` / `ActionActorOut`): administrators always appear
 * as "Technical administrator", never with their login.
 */
export function actorOf(identity: Identity): ActorOut {
  return identity.kind === 'administrator'
    ? { kind: 'administrator', name: ADMINISTRATOR_ACTOR_NAME, user_id: null }
    : { kind: 'resident', name: identity.resident.name, user_id: identity.resident.id }
}
