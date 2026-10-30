/**
 * The people data of this page load (../scenario/people.ts) and its shared rules: the presidency is
 * left unassigned with its holder's account, and neighbors sign in with `demo` until they change
 * their password in My profile (a reload brings `demo` back).
 */
import { DEMO_PASSWORD } from '../config'
import { peopleScenario, type PeopleScenario } from '../scenario/people'
import type { DemoResident } from './core'

export type PeopleState = PeopleScenario

let state: PeopleState | null = null

/** The people data of this page load, built from the scenario on first use. */
export function peopleStore(): PeopleState {
  return (state ??= peopleScenario())
}

/** Back to the scenario (tests; a page reload does the same). */
export function resetPeopleStore(): void {
  state = null
}

/** bcrypt's limit: the backend refuses longer passwords rather than truncating them. */
export const MAX_PASSWORD_BYTES = 72

/** Size of a password in UTF-8 bytes, the unit of {@link MAX_PASSWORD_BYTES}. */
export function passwordBytes(password: string): number {
  return new TextEncoder().encode(password).length
}

/**
 * Whether `password` is the neighbor's password: `demo`, or the one they chose in My profile during
 * this visit. Accounts without a password (pending invitations) match nothing, like the backend.
 */
export function residentPasswordMatches(resident: DemoResident, password: string): boolean {
  const size = passwordBytes(password)
  if (!resident.hasPassword || size < 1 || size > MAX_PASSWORD_BYTES) return false
  return password === (peopleStore().passwords.get(resident.id) ?? DEMO_PASSWORD)
}

export function setResidentPassword(residentId: number, password: string): void {
  peopleStore().passwords.set(residentId, password)
}

/** Whether the neighbor chose another password during this visit, so `demo` no longer signs them in. */
export function residentPasswordChanged(residentId: number): boolean {
  return peopleStore().passwords.has(residentId)
}

/** The account lost its password (email changed) or no longer exists. */
export function forgetResidentPassword(residentId: number): void {
  peopleStore().passwords.delete(residentId)
}

/** Leaves the presidency unassigned when `residentId` holds it (backend `clear_presidency`). */
export function clearPresidency(residentId: number): void {
  const { presidency } = peopleStore()
  if (presidency.presidentId !== residentId) return
  presidency.presidentId = null
  presidency.version += 1
}
