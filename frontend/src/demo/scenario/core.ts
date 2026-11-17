/**
 * Initial core data: the visitor opens the demo signed in as the sample neighbor, every feature is
 * on, and the dwellings and accounts come from the cast with their dates relative to today (the
 * president's account is also the administrator's).
 */
import { ADMINISTRATOR_ID, COMMUNITY, DWELLINGS, RESIDENTS, SAMPLE_NEIGHBOR_ID, type CastResident } from '../cast'
import { DEMO_SESSION_HOURS } from '../config'
import { daysAgo, hoursFromNow, instant, nowIso } from '../core/clock'
import { sequenceAfter } from '../core/ids'
import type { CoreState, DemoDwelling, DemoResident } from '../store/core'

/** Invitation links last 72 hours (backend `issue_token`). */
const INVITATION_HOURS = 72

/** A plausible, fixed time of day for each neighbor's last sign-in. */
function signInTime(id: number): string {
  const hour = 7 + (id * 7) % 15
  const minute = (id * 13) % 60
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

function resident(cast: CastResident): DemoResident {
  const pending = cast.status === 'pending'
  const sentAt = pending && cast.invitedDaysAgo !== null ? instant(daysAgo(cast.invitedDaysAgo), '09:30') : null
  const lastLoginAt = cast.id === SAMPLE_NEIGHBOR_ID
    ? nowIso()
    : cast.lastSignInDaysAgo === null ? null : instant(daysAgo(cast.lastSignInDaysAgo), signInTime(cast.id))
  return {
    id: cast.id,
    name: cast.name,
    email: cast.email,
    phone: cast.phone,
    dwellingId: cast.dwellingId,
    administrator: cast.id === ADMINISTRATOR_ID,
    activated: !pending,
    disabled: cast.status === 'disabled',
    hasPassword: !pending,
    googleLinked: cast.googleLinked,
    lastLoginAt,
    invitationDelivery: pending ? 'sent' : 'none',
    invitationSentAt: sentAt,
    invitationExpiresAt: sentAt === null ? null : new Date(Date.parse(sentAt) + INVITATION_HOURS * 3_600_000).toISOString(),
    version: 1,
  }
}

export function coreScenario(): CoreState {
  const dwellings: DemoDwelling[] = DWELLINGS.map(dwelling => ({
    id: dwelling.id, label: dwelling.label, coefficient: dwelling.coefficient, version: 1,
  }))
  const residents = RESIDENTS.map(resident)
  return {
    session: { residentId: SAMPLE_NEIGHBOR_ID, expiresAt: hoursFromNow(DEMO_SESSION_HOURS) },
    features: { coefficient: true, actions: true, events: true, documents: true },
    general: { community_name: COMMUNITY.name },
    account: { iban: COMMUNITY.account.iban, name: COMMUNITY.account.name },
    dwellings,
    residents,
    whatsNewSeen: new Map(),
    sequences: {
      dwelling: sequenceAfter(dwellings.map(dwelling => dwelling.id)),
      resident: sequenceAfter(residents.map(item => item.id)),
    },
  }
}
