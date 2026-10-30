/**
 * Helpers shared by the people handlers (people.ts, people-users.ts, people-account.ts): the
 * backend's parameter ranges, the ownership coefficient as the API shows it, the password policy
 * and invitations, which the demo sends without email.
 */
import { Body, hoursFromNow, idParam, nowIso, type PathParams } from '../core'
import { MAX_PASSWORD_BYTES, passwordBytes } from '../store/people'
import { coreStore, findDwelling, type DemoDwelling, type DemoResident } from '../store/core'

/**
 * FastAPI's plain `int` path parameters (`/users/{user_id}`): any integer is accepted, so an unknown
 * id is "not found" (404) rather than an invalid request.
 */
export function anyIdParam(params: PathParams, name: string): number {
  return idParam(params, name, { min: Number.MIN_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER })
}

/** `Field(ge=1)` without an upper bound (versions, `dwelling_id`). */
export const POSITIVE = { min: 1, max: Number.MAX_SAFE_INTEGER } as const

/** Invitation links last 72 hours (backend `issue_token`). */
export const INVITATION_HOURS = 72

/** The coefficient as the API shows it: null while the coefficient feature is off (the value is kept). */
export function visibleCoefficient(dwelling: DemoDwelling): string | null {
  return coreStore().features.coefficient ? dwelling.coefficient : null
}

/** The dwelling of a neighbor (always there, like the backend's foreign key). */
export function dwellingOf(resident: DemoResident): DemoDwelling {
  const dwelling = findDwelling(resident.dwellingId)
  if (!dwelling) throw new Error(`Neighbor ${resident.id} lives in a missing dwelling ${resident.dwellingId}`)
  return dwelling
}

/** `NewPasswordIn.password`: 10 to 72 characters, not blank and at most 72 UTF-8 bytes. */
export function newPassword(body: Body, key = 'password'): string {
  const value = body.text(key, { min: 10, max: 72 })
  if (!body.failed(key) && (!value.trim() || passwordBytes(value) > MAX_PASSWORD_BYTES)) body.fail(key, 'value_error')
  return value
}

/** A 64-character lower-case hex token (invitation and recovery links). */
export function accountToken(body: Body, key: string, { optional = false }: { optional?: boolean } = {}): string | null {
  const value = optional ? body.optionalText(key, { min: 64, max: 64 }) : body.text(key, { min: 64, max: 64 })
  if (value !== null && !body.failed(key) && !/^[0-9a-f]+$/.test(value)) body.fail(key, 'string_pattern_mismatch')
  return value
}

/** Forgets a neighbor's invitation (backend: status and email changes clear it before any new one). */
export function clearInvitation(resident: DemoResident): void {
  resident.invitationDelivery = 'none'
  resident.invitationSentAt = null
  resident.invitationExpiresAt = null
}

/**
 * Sends an invitation the way the backend records it once the SMTP server accepts the message
 * (`invitation_status` "sent", a link valid for 72 hours). The demo has no email: nothing leaves the
 * browser and no link exists, so the neighbor stays pending (see `POST /api/auth/activate`).
 */
export function sendInvitation(resident: DemoResident): void {
  resident.invitationDelivery = 'sent'
  resident.invitationSentAt = nowIso()
  resident.invitationExpiresAt = hoursFromNow(INVITATION_HOURS)
}
