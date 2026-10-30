/**
 * Community data of the demo: actions with labels, comments, PDF attachments and history, events,
 * and contacts with tags and history. Every part adds its dated steps to one timeline, replayed in
 * chronological order through the store's operations (see ./community-script.ts), so the data is
 * deterministic (`demoRandom('community:…')`), relative to today and consistent with its history.
 */
import type { CommunityState } from '../store/community-model'
import { actionSteps } from './community-actions'
import { contactSteps } from './community-contacts'
import { eventSteps } from './community-events'
import { emptyCommunityState, replay } from './community-script'

export function communityScenario(): CommunityState {
  return replay(emptyCommunityState(), [...actionSteps(), ...eventSteps(), ...contactSteps()])
}
