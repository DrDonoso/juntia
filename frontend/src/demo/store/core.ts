/**
 * Core data of the demo, shared by every domain: who is signed in, the feature flags, the general
 * settings, the bank account, and the dwellings and accounts (identities: neighbors and
 * administrators). It starts from ../scenario/core.ts on every page load and lives in memory.
 *
 * The domains read and change these records in place (for example the people handlers edit
 * accounts and dwellings, and the community handlers name the authors), so the shapes below are
 * a contract: they hold every field the API returns for an identity.
 */
import type { AccountOut, GeneralSettings } from '../../api/schema.gen'
import { now } from '../core/clock'
import type { IdSequence } from '../core/ids'
import { coreScenario } from '../scenario/core'

export interface DemoDwelling {
  id: number
  label: string
  /** Percent with two decimals (`'8.90'`), kept while the coefficient feature is off (the API then answers null). */
  coefficient: string | null
  version: number
}

/** Backend `users.invitation_delivery`; `expired` is derived from {@link DemoResident.invitationExpiresAt}. */
export type InvitationDelivery = 'none' | 'sending' | 'sent' | 'failed'

/**
 * An account (backend `users`): a neighbor, who lives in a dwelling, an administrator, or both.
 * The signed-in one is `signedInResident()` (../core/session.ts).
 */
export interface DemoResident {
  /** The user id (`user_id` of the API). */
  id: number
  name: string
  /** Lower case, unique. */
  email: string
  /** Normalized like the API (`+442079460123`) or `''`. */
  phone: string
  /** Neighbors live in a dwelling; only administrators may have none (null). */
  dwellingId: number | null
  /** Opens the administration (`/api/admin/*`); read on every request, so a change applies at once. */
  administrator: boolean
  /** False until the invitation is accepted (`pending`). */
  activated: boolean
  disabled: boolean
  /** Accounts of the demo sign in with the password `demo` when this is true. */
  hasPassword: boolean
  googleLinked: boolean
  lastLoginAt: string | null
  invitationDelivery: InvitationDelivery
  invitationSentAt: string | null
  invitationExpiresAt: string | null
  version: number
}

/** The session of this browser, like the backend's single `juntia_user` cookie: one account at a time. */
export interface DemoSession {
  /** The signed-in account; null when signed out. */
  residentId: number | null
  expiresAt: string | null
}

/** Feature flags administrators can switch (Google sign-in is never available in the demo). */
export interface DemoFeatures {
  coefficient: boolean
  actions: boolean
  events: boolean
  documents: boolean
}

export interface CoreState {
  session: DemoSession
  features: DemoFeatures
  general: GeneralSettings
  /** The community's bank account; null before the first statement import. */
  account: AccountOut | null
  dwellings: DemoDwelling[]
  residents: DemoResident[]
  /**
   * "What's new" notes each account has read, by account id (backend `users.whats_new_seen`).
   * Nobody has one at first, so the visit starts with nothing to catch up on, like a new account.
   */
  whatsNewSeen: Map<number, string[]>
  sequences: { dwelling: IdSequence; resident: IdSequence }
}

let state: CoreState | null = null

/** The core data of this page load, built from the scenario on first use. */
export function coreStore(): CoreState {
  return (state ??= coreScenario())
}

/** Back to the scenario (tests; a page reload does the same). */
export function resetCoreStore(): void {
  state = null
}

export function findResident(id: number): DemoResident | undefined {
  return coreStore().residents.find(resident => resident.id === id)
}

/** Case-insensitive, like the backend's lower-cased emails. */
export function findResidentByEmail(email: string): DemoResident | undefined {
  const wanted = email.trim().toLowerCase()
  return coreStore().residents.find(resident => resident.email === wanted)
}

export function findDwelling(id: number): DemoDwelling | undefined {
  return coreStore().dwellings.find(dwelling => dwelling.id === id)
}

/** `UserOut.status` (backend `render_user`). */
export function residentStatus(resident: DemoResident): 'pending' | 'active' | 'disabled' {
  return resident.disabled ? 'disabled' : resident.activated ? 'active' : 'pending'
}

/** `UserOut.invitation_status`: a sent invitation whose link has expired reads `expired`. */
export function invitationStatus(resident: DemoResident): InvitationDelivery | 'expired' {
  const expired = resident.invitationExpiresAt !== null && Date.parse(resident.invitationExpiresAt) <= now().getTime()
  return (resident.invitationDelivery === 'sending' || resident.invitationDelivery === 'sent') && expired
    ? 'expired'
    : resident.invitationDelivery
}

/** Whether the account can sign in (backend: activated, enabled and with a password). */
export function canSignIn(resident: DemoResident): boolean {
  return resident.activated && !resident.disabled && resident.hasPassword
}

/** Read notes kept per account, the newest (backend `whats_new.MAX_SEEN`). */
const MAX_NOTES_SEEN = 1000

/** The "What's new" notes the account has read; null while none were recorded. */
export function notesRead(accountId: number): string[] | null {
  const seen = coreStore().whatsNewSeen.get(accountId)
  return seen ? [...seen] : null
}

/** Adds notes to the ones the account has read (sorted, the newest kept), like the API. */
export function markNotesRead(accountId: number, ids: readonly string[]): string[] {
  const { whatsNewSeen } = coreStore()
  const seen = [...new Set([...(whatsNewSeen.get(accountId) ?? []), ...ids])].sort().slice(-MAX_NOTES_SEEN)
  whatsNewSeen.set(accountId, seen)
  return [...seen]
}
