/**
 * Building blocks of the community scenario: who did something and when, written relative to the
 * demo's clock, and the timeline every part of the scenario adds its steps to. The steps run in
 * chronological order through the same operations as the API, so ids follow the dates and every
 * history entry matches the data it describes.
 */
import type { ActorOut } from '../../api/schema.gen'
import { ADMINISTRATOR_ACTOR_NAME, castResident } from '../cast'
import { daysAgo, hoursFromNow, instant } from '../core/clock'
import { IdSequence } from '../core/ids'
import { demoRandom } from '../core/random'
import type { CommunityState, DemoAction, DemoActionAttachment, DemoActionComment, DemoContact, DemoEvent } from '../store/community-model'

/** A neighbor of the cast (by id) or the administrator. */
export type Who = number | 'admin'

/** `[days ago, 'HH:MM']` in the visitor's time, or a few hours before now, to the minute (recent activity). */
export type When = readonly [daysAgo: number, time: string] | { readonly hoursAgo: number }

export function actor(who: Who): ActorOut {
  if (who === 'admin') return { kind: 'administrator', name: ADMINISTRATOR_ACTOR_NAME, user_id: null }
  const resident = castResident(who)
  return { kind: 'resident', name: resident.name, user_id: resident.id }
}

export function at(when: When): string {
  if (!('hoursAgo' in when)) return instant(daysAgo(when[0]), when[1])
  const moment = new Date(hoursFromNow(-when.hoursAgo))
  moment.setSeconds(0, 0)
  return moment.toISOString()
}

/** Records the scenario refers to by a short key (`'roof'`, `'roof:quote'`…). */
export interface ScenarioRefs {
  actions: Map<string, DemoAction>
  comments: Map<string, DemoActionComment>
  attachments: Map<string, DemoActionAttachment>
  events: Map<string, DemoEvent>
  contacts: Map<string, DemoContact>
}

/** One dated change of the scenario; `run` receives its instant. */
export interface ScenarioStep {
  at: string
  run: (state: CommunityState, refs: ScenarioRefs, at: string) => void
}

export function step(when: When, run: ScenarioStep['run']): ScenarioStep {
  return { at: at(when), run }
}

/** Looks a record up by key: a missing one is a mistake in the scenario. */
export function ref<T>(map: Map<string, T>, key: string): T {
  const value = map.get(key)
  if (value === undefined) throw new Error(`The community scenario has no record "${key}" yet`)
  return value
}

export function emptyCommunityState(): CommunityState {
  return {
    labels: [], actions: [], comments: [], attachments: [], actionHistory: [], events: [], eventHistory: [],
    contactTags: [], contacts: [], contactHistory: [],
    sequences: {
      label: new IdSequence(), action: new IdSequence(), comment: new IdSequence(), actionHistory: new IdSequence(),
      event: new IdSequence(), eventHistory: new IdSequence(), contactTag: new IdSequence(), contact: new IdSequence(),
      contactHistory: new IdSequence(),
    },
    random: demoRandom('community:visit'),
  }
}

/** Runs the steps in chronological order (steps at the same instant keep their order). */
export function replay(state: CommunityState, steps: readonly ScenarioStep[]): CommunityState {
  const refs: ScenarioRefs = { actions: new Map(), comments: new Map(), attachments: new Map(), events: new Map(), contacts: new Map() }
  for (const item of [...steps].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))) item.run(state, refs, item.at)
  return state
}
