/**
 * The community data of this page load (actions, events and contacts): built from
 * ../scenario/community.ts on first use, changed by ../handlers/community*.ts through the
 * operations of ./community-actions.ts, ./community-events.ts and ./community-contacts.ts.
 */
import { communityScenario } from '../scenario/community'
import type { CommunityState } from './community-model'

export type { CommunityState } from './community-model'

let state: CommunityState | null = null

/** The community data of this page load, built from the scenario on first use. */
export function communityStore(): CommunityState {
  return (state ??= communityScenario())
}

/** Back to the scenario (tests; a page reload does the same). */
export function resetCommunityStore(): void {
  state = null
}
