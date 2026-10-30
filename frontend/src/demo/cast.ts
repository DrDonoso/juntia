/**
 * The people of the demo: the community "Maple Court", its dwellings and its neighbors. Every
 * domain builds its data on these ids and names (fees per dwelling, authors of actions, contacts…),
 * so they are the contract between the demo's modules: extend the cast here, never change an id.
 *
 * Everything is fictional: names, `@example.com` emails, UK fiction phone numbers (Ofcom's drama
 * range +44 20 7946 0000–0999, stored normalized like the API does) and an IBAN that is
 * checksum-valid on the non-existent Spanish bank code 9999. Relative facts (last sign-in,
 * invitations) are in days before today: the scenario turns them into instants with the demo clock.
 */

export interface CastCommunity {
  readonly name: string
  readonly account: { readonly iban: string; readonly name: string }
}

export interface CastDwelling {
  readonly id: number
  readonly label: string
  /** Ownership coefficient (percent, two decimals, like the API); they add up to 100.00. */
  readonly coefficient: string
}

export type CastStatus = 'active' | 'pending' | 'disabled'

export interface CastResident {
  readonly id: number
  readonly name: string
  readonly email: string
  /** Normalized like the API stores it (`+442079460123`), or `''` without a phone. */
  readonly phone: string
  readonly dwellingId: number
  /** `pending`: invited, never activated; `disabled`: the administrator turned the account off. */
  readonly status: CastStatus
  /** Days before today of the last sign-in; null if the neighbor never signed in. */
  readonly lastSignInDaysAgo: number | null
  readonly googleLinked: boolean
  /** Pending neighbors: days since the invitation was sent (its link lasts 72 hours). */
  readonly invitedDaysAgo: number | null
}

export const COMMUNITY: CastCommunity = {
  name: 'Maple Court',
  account: { iban: 'ES3099990001230123456789', name: 'Community account' },
}

/** Four floors with three dwellings each; the top floor's are a little larger. */
export const DWELLINGS: readonly CastDwelling[] = [
  { id: 1, label: '1A', coefficient: '8.90' },
  { id: 2, label: '1B', coefficient: '7.60' },
  { id: 3, label: '1C', coefficient: '8.10' },
  { id: 4, label: '2A', coefficient: '8.90' },
  { id: 5, label: '2B', coefficient: '7.60' },
  { id: 6, label: '2C', coefficient: '8.10' },
  { id: 7, label: '3A', coefficient: '8.90' },
  { id: 8, label: '3B', coefficient: '7.60' },
  { id: 9, label: '3C', coefficient: '8.10' },
  { id: 10, label: '4A', coefficient: '9.50' },
  { id: 11, label: '4B', coefficient: '7.90' },
  { id: 12, label: '4C', coefficient: '8.80' },
]

const active = { status: 'active', googleLinked: false, invitedDaysAgo: null } as const

export const RESIDENTS: readonly CastResident[] = [
  { ...active, id: 1, name: 'James Okafor', email: 'james.okafor@example.com', phone: '+442079460418', dwellingId: 1, lastSignInDaysAgo: 1 },
  { ...active, id: 2, name: 'Priya Sharma', email: 'priya.sharma@example.com', phone: '+442079460563', dwellingId: 1, lastSignInDaysAgo: 4 },
  { ...active, id: 3, name: "Liam O'Connor", email: 'liam.oconnor@example.com', phone: '', dwellingId: 2, lastSignInDaysAgo: 12 },
  { ...active, id: 4, name: 'Sofia Rossi', email: 'sofia.rossi@example.com', phone: '+442079460291', dwellingId: 3, lastSignInDaysAgo: 2 },
  { ...active, id: 5, name: 'Mohammed Haddad', email: 'mohammed.haddad@example.com', phone: '+442079460734', dwellingId: 4, lastSignInDaysAgo: 7 },
  { ...active, id: 6, name: 'Olivia Bennett', email: 'olivia.bennett@example.com', phone: '+442079460152', dwellingId: 5, lastSignInDaysAgo: 0 },
  { ...active, id: 7, name: 'Grace Liu', email: 'grace.liu@example.com', phone: '+442079460876', dwellingId: 6, lastSignInDaysAgo: 3, googleLinked: true },
  { ...active, id: 8, name: 'Daniel Mensah', email: 'daniel.mensah@example.com', phone: '', dwellingId: 6, lastSignInDaysAgo: 21 },
  { ...active, id: 9, name: 'Emily Clarke', email: 'emily.clarke@example.com', phone: '+442079460349', dwellingId: 7, lastSignInDaysAgo: 5 },
  { ...active, id: 10, name: 'Hiroshi Tanaka', email: 'hiroshi.tanaka@example.com', phone: '+442079460627', dwellingId: 8, lastSignInDaysAgo: 9 },
  { ...active, id: 11, name: 'Noah Patel', email: 'noah.patel@example.com', phone: '+442079460905', dwellingId: 8, lastSignInDaysAgo: 140, status: 'disabled' },
  { ...active, id: 12, name: 'Amara Nwosu', email: 'amara.nwosu@example.com', phone: '', dwellingId: 9, lastSignInDaysAgo: 2 },
  { ...active, id: 13, name: 'Thomas Wright', email: 'thomas.wright@example.com', phone: '+442079460218', dwellingId: 10, lastSignInDaysAgo: 16, googleLinked: true },
  { ...active, id: 14, name: 'Chloe Dubois', email: 'chloe.dubois@example.com', phone: '+442079460481', dwellingId: 10, lastSignInDaysAgo: 30 },
  { ...active, id: 15, name: 'Ethan Brooks', email: 'ethan.brooks@example.com', phone: '', dwellingId: 11, lastSignInDaysAgo: null, status: 'pending', invitedDaysAgo: 1 },
  { ...active, id: 16, name: 'Hannah Schmidt', email: 'hannah.schmidt@example.com', phone: '+442079460790', dwellingId: 12, lastSignInDaysAgo: null, status: 'pending', invitedDaysAgo: 6 },
  // Active neighbors of 4B and 4C, so the top floor of the directory has nobody missing.
  { ...active, id: 17, name: 'Lucas Moreau', email: 'lucas.moreau@example.com', phone: '+442079460532', dwellingId: 11, lastSignInDaysAgo: 6 },
  { ...active, id: 18, name: 'Zara Ahmed', email: 'zara.ahmed@example.com', phone: '+442079460668', dwellingId: 12, lastSignInDaysAgo: 10 },
]

/** The community president (an active neighbor of 1A). */
export const PRESIDENT_ID = 1

/** The neighbor the visitor is signed in as when the demo opens. */
export const SAMPLE_NEIGHBOR_ID = 6

/** Author name of everything the administrator writes (backend: `kind: 'administrator'`). */
export const ADMINISTRATOR_ACTOR_NAME = 'Technical administrator'

export function castDwelling(id: number): CastDwelling {
  const dwelling = DWELLINGS.find(item => item.id === id)
  if (!dwelling) throw new Error(`The cast has no dwelling ${id}`)
  return dwelling
}

export function castResident(id: number): CastResident {
  const resident = RESIDENTS.find(item => item.id === id)
  if (!resident) throw new Error(`The cast has no resident ${id}`)
  return resident
}

/** Neighbors of a dwelling, in id order. */
export function castResidentsOf(dwellingId: number): CastResident[] {
  return RESIDENTS.filter(resident => resident.dwellingId === dwellingId)
}

/** Active neighbors (the ones who can sign in and write). */
export function activeResidents(): CastResident[] {
  return RESIDENTS.filter(resident => resident.status === 'active')
}
