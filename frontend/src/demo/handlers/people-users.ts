/**
 * Users administration of the demo (`/api/admin/users`, after src/juntia/users.py): the
 * administrator invites, edits, deactivates, reactivates and deletes neighbors with the backend's
 * rules (optimistic versions, unique emails, the presidency left unassigned with its holder's
 * account, sessions closed when an account is disabled, deleted or changes its email).
 *
 * The demo sends no email: every invitation counts as accepted by the SMTP server at once
 * (`invitation_status` "sent", a link valid for 72 hours) and no link exists, so invited neighbors
 * stay pending. SMTP configuration and the invitation rate limits are not simulated.
 */
import type { UserOut } from '../../api/schema.gen'
import { Body, DemoApiError, http, parseBody, readJson, revokeResidentSessions, route, type HttpHandler } from '../core'
import {
  coreStore, findDwelling, findResident, findResidentByEmail, invitationStatus, residentStatus, type DemoResident,
} from '../store/core'
import { clearPresidency, forgetResidentPassword } from '../store/people'
import { POSITIVE, anyIdParam, clearInvitation, dwellingOf, sendInvitation, visibleCoefficient } from './people-shared'

function userOut(resident: DemoResident): UserOut {
  const dwelling = dwellingOf(resident)
  return {
    email: resident.email,
    name: resident.name,
    phone: resident.phone,
    dwelling_id: resident.dwellingId,
    id: resident.id,
    version: resident.version,
    status: residentStatus(resident),
    dwelling_label: dwelling.label,
    coefficient: visibleCoefficient(dwelling),
    last_login_at: resident.lastLoginAt,
    invitation_status: invitationStatus(resident),
    invitation_expires_at: resident.invitationExpiresAt,
    invitation_sent_at: resident.invitationSentAt,
    has_password: resident.hasPassword,
    google_linked: resident.googleLinked,
  }
}

/** `UserIn`: email, name, optional phone and dwelling. */
function userInput(body: Body) {
  return {
    email: body.email('email'),
    name: body.name('name', { max: 150 }),
    phone: body.phone('phone'),
    /** Whether the body had `phone` (an edit without it keeps the saved one). */
    phoneSupplied: body.present.has('phone'),
    dwellingId: body.int('dwelling_id', POSITIVE),
  }
}

function existingUser(id: number): DemoResident {
  const resident = findResident(id)
  if (!resident) throw new DemoApiError('user_not_found', 404)
  return resident
}

/** `locked_user(…, version)`: 404 for an unknown user, 409 `record_stale` for an outdated version. */
function currentUser(id: number, version: number): DemoResident {
  const resident = existingUser(id)
  if (resident.version !== version) throw new DemoApiError('record_stale', 409)
  return resident
}

function requireDwelling(id: number): void {
  if (!findDwelling(id)) throw new DemoApiError('dwelling_not_found')
}

/** Emails are unique (the database's unique index: 409 `record_conflict`). */
function requireFreeEmail(email: string): void {
  if (findResidentByEmail(email)) throw new DemoApiError('record_conflict', 409)
}

const byName = (left: DemoResident, right: DemoResident) =>
  (left.name < right.name ? -1 : left.name > right.name ? 1 : 0) || left.id - right.id

export const peopleUserHandlers: HttpHandler[] = [
  http.get('/api/admin/users', route('admin', () => [...coreStore().residents].sort(byName).map(userOut))),
  http.post('/api/admin/users', route('admin', async ({ request }) => {
    const input = parseBody(await readJson(request), userInput)
    requireDwelling(input.dwellingId)
    requireFreeEmail(input.email)
    const { residents, sequences } = coreStore()
    const resident: DemoResident = {
      id: sequences.resident.next(), name: input.name, email: input.email, phone: input.phone, dwellingId: input.dwellingId,
      activated: false, disabled: false, hasPassword: false, googleLinked: false, lastLoginAt: null,
      invitationDelivery: 'none', invitationSentAt: null, invitationExpiresAt: null, version: 1,
    }
    sendInvitation(resident)
    residents.push(resident)
    return userOut(resident)
  }, { status: 201 })),
  http.post('/api/admin/users/:userId/invite', route('admin', async ({ request, params }) => {
    const id = anyIdParam(params, 'userId')
    const { version } = parseBody(await readJson(request), body => ({ version: body.int('version', POSITIVE) }))
    const resident = currentUser(id, version)
    if (resident.disabled || resident.activated) throw new DemoApiError('invitation_not_pending', 409)
    resident.version += 1
    sendInvitation(resident)
    return userOut(resident)
  })),
  http.patch('/api/admin/users/:userId/status', route('admin', async ({ request, params }) => {
    const id = anyIdParam(params, 'userId')
    const input = parseBody(await readJson(request), body => ({ disabled: body.bool('disabled'), version: body.int('version', POSITIVE) }))
    const resident = currentUser(id, input.version)
    if (resident.disabled !== input.disabled) {
      resident.disabled = input.disabled
      resident.version += 1
      if (resident.disabled) clearPresidency(resident.id)
      revokeResidentSessions(resident.id)
      clearInvitation(resident)
      // Reactivating someone who never accepted their invitation sends them a new one.
      if (!resident.disabled && !resident.activated) sendInvitation(resident)
    }
    return userOut(resident)
  })),
  http.patch('/api/admin/users/:userId', route('admin', async ({ request, params }) => {
    const id = anyIdParam(params, 'userId')
    const input = parseBody(await readJson(request), body => ({ ...userInput(body), version: body.int('version', POSITIVE) }))
    const resident = currentUser(id, input.version)
    requireDwelling(input.dwellingId)
    const emailChanged = resident.email !== input.email
    if (emailChanged) requireFreeEmail(input.email)
    resident.name = input.name
    if (input.phoneSupplied) resident.phone = input.phone
    resident.dwellingId = input.dwellingId
    resident.version += 1
    if (emailChanged) {
      // A new address must be proven again: no sessions, password or Google link, and a new invitation.
      resident.email = input.email
      revokeResidentSessions(resident.id)
      resident.hasPassword = false
      forgetResidentPassword(resident.id)
      resident.googleLinked = false
      resident.activated = false
      clearPresidency(resident.id)
      clearInvitation(resident)
      if (!resident.disabled) sendInvitation(resident)
    }
    return userOut(resident)
  })),
  http.delete('/api/admin/users/:userId', route('admin', async ({ request, params }) => {
    const id = anyIdParam(params, 'userId')
    const input = parseBody(await readJson(request), body => ({ email: body.email('email'), version: body.int('version', POSITIVE) }))
    const resident = currentUser(id, input.version)
    if (input.email !== resident.email) throw new DemoApiError('user_delete_confirmation_required')
    clearPresidency(resident.id)
    revokeResidentSessions(resident.id)
    forgetResidentPassword(resident.id)
    const { residents } = coreStore()
    residents.splice(residents.indexOf(resident), 1)
  }, { status: 204 })),
]
