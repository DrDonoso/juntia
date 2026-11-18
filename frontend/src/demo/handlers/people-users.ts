/**
 * Users administration of the demo (`/api/admin/users`, after src/juntia/users.py): administrators
 * invite, edit, deactivate, reactivate and delete accounts with the backend's rules: optimistic
 * versions, unique emails, a dwelling for every neighbor (only administrators may have none: 422
 * `dwelling_required`), the presidency left unassigned with its holder's account or dwelling, and
 * sessions closed when an account is disabled, deleted or changes its email. Nobody changes their
 * own role, email or status, or deletes their own account (409 `cannot_modify_self`), and an active
 * administrator always remains (409 `last_administrator`); granting or revoking the role ends no
 * session, since every request reads it again.
 *
 * The demo sends no email: every invitation counts as accepted by the SMTP server at once
 * (`invitation_status` "sent", a link valid for 72 hours) and no link exists, so invited accounts
 * stay pending. SMTP configuration and the invitation rate limits are not simulated.
 */
import type { UserOut } from '../../api/schema.gen'
import { Body, DemoApiError, http, parseBody, readJson, revokeResidentSessions, route, type HttpHandler } from '../core'
import {
  coreStore, findDwelling, findResident, findResidentByEmail, invitationStatus, residentStatus, type DemoResident,
} from '../store/core'
import { activeAdministrator, clearPresidency, forgetResidentPassword, requireAdministratorRemains } from '../store/people'
import { POSITIVE, anyIdParam, clearInvitation, dwellingOf, sendInvitation, visibleCoefficient } from './people-shared'

function userOut(resident: DemoResident): UserOut {
  const dwelling = dwellingOf(resident)
  return {
    email: resident.email,
    name: resident.name,
    phone: resident.phone,
    dwelling_id: resident.dwellingId,
    administrator: resident.administrator,
    id: resident.id,
    version: resident.version,
    status: residentStatus(resident),
    dwelling_label: dwelling ? dwelling.label : null,
    coefficient: dwelling ? visibleCoefficient(dwelling) : null,
    last_login_at: resident.lastLoginAt,
    invitation_status: invitationStatus(resident),
    invitation_expires_at: resident.invitationExpiresAt,
    invitation_sent_at: resident.invitationSentAt,
    has_password: resident.hasPassword,
    google_linked: resident.googleLinked,
  }
}

/** `UserIn`: email, name, optional phone, dwelling (none by default) and administrator role (off by default). */
function userInput(body: Body) {
  return {
    email: body.email('email'),
    name: body.name('name', { max: 150 }),
    phone: body.phone('phone'),
    /** Whether the body had `phone` (an edit without it keeps the saved one). */
    phoneSupplied: body.present.has('phone'),
    dwellingId: body.optionalInt('dwelling_id', POSITIVE),
    administrator: body.bool('administrator', false),
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

/** `require_dwelling`: neighbors live in an existing dwelling; an administrator may have none. */
function requireDwelling({ dwellingId, administrator }: { dwellingId: number | null; administrator: boolean }): void {
  if (dwellingId === null) {
    if (!administrator) throw new DemoApiError('dwelling_required')
  } else if (!findDwelling(dwellingId)) {
    throw new DemoApiError('dwelling_not_found')
  }
}

/** `refuse_self`: nobody changes their own role, email or status, or deletes their own account. */
function refuseSelf(editor: DemoResident, id: number): void {
  if (editor.id === id) throw new DemoApiError('cannot_modify_self', 409)
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
    requireDwelling(input)
    requireFreeEmail(input.email)
    const { residents, sequences } = coreStore()
    const resident: DemoResident = {
      id: sequences.resident.next(), name: input.name, email: input.email, phone: input.phone, dwellingId: input.dwellingId,
      administrator: input.administrator, activated: false, disabled: false, hasPassword: false, googleLinked: false,
      lastLoginAt: null, invitationDelivery: 'none', invitationSentAt: null, invitationExpiresAt: null, version: 1,
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
  http.patch('/api/admin/users/:userId/status', route('admin', async ({ request, params, user: editor }) => {
    const id = anyIdParam(params, 'userId')
    const input = parseBody(await readJson(request), body => ({ disabled: body.bool('disabled'), version: body.int('version', POSITIVE) }))
    refuseSelf(editor, id)
    const resident = currentUser(id, input.version)
    if (resident.disabled !== input.disabled) {
      if (input.disabled && activeAdministrator(resident)) requireAdministratorRemains(resident)
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
  http.patch('/api/admin/users/:userId', route('admin', async ({ request, params, user: editor }) => {
    const id = anyIdParam(params, 'userId')
    const input = parseBody(await readJson(request), body => ({ ...userInput(body), version: body.int('version', POSITIVE) }))
    const resident = existingUser(id)
    const emailChanged = resident.email !== input.email
    // A new email address also signs the account out until it is activated again.
    if (emailChanged || resident.administrator !== input.administrator) refuseSelf(editor, id)
    if (resident.version !== input.version) throw new DemoApiError('record_stale', 409)
    requireDwelling(input)
    if (emailChanged) requireFreeEmail(input.email)
    // The role taken away, or a new email address to confirm: an active administrator stops being one.
    if (activeAdministrator(resident) && (!input.administrator || emailChanged)) requireAdministratorRemains(resident)
    resident.name = input.name
    if (input.phoneSupplied) resident.phone = input.phone
    resident.dwellingId = input.dwellingId
    resident.administrator = input.administrator
    // The presidency belongs to a neighbor, who lives in a dwelling.
    if (resident.dwellingId === null) clearPresidency(resident.id)
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
  http.delete('/api/admin/users/:userId', route('admin', async ({ request, params, user: editor }) => {
    const id = anyIdParam(params, 'userId')
    const input = parseBody(await readJson(request), body => ({ email: body.email('email'), version: body.int('version', POSITIVE) }))
    refuseSelf(editor, id)
    const resident = currentUser(id, input.version)
    if (input.email !== resident.email) throw new DemoApiError('user_delete_confirmation_required')
    if (activeAdministrator(resident)) requireAdministratorRemains(resident)
    clearPresidency(resident.id)
    revokeResidentSessions(resident.id)
    forgetResidentPassword(resident.id)
    const { residents } = coreStore()
    residents.splice(residents.indexOf(resident), 1)
  }, { status: 204 })),
]
