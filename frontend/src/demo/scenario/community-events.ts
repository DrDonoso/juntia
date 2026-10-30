/**
 * Calendar of Maple Court: fifteen events around today in the community's time zone (past and
 * upcoming, timed and all-day, one lasting a week and one cancelled), several linked to actions,
 * with the history of their changes.
 */
import { addDays, now } from '../core/clock'
import { demoRandom } from '../core/random'
import { createEvent, deleteEvent, editEvent, type EventFields } from '../store/community-events'
import { COMMUNITY_TIME_ZONE, zonedDay, zonedInstant } from '../store/community-time'
import { actor, ref, step, type ScenarioStep, type When, type Who } from './community-script'

/** Days from the community's today, with a time span or a number of whole days. */
type Schedule =
  | { readonly day: number; readonly from: string; readonly to: string }
  | { readonly day: number; readonly days: number }

interface EventText {
  title: string
  description: string
  location: string
}

interface EventScript extends EventText {
  key: string
  at: When
  by: Who
  schedule: Schedule
  /** Key of the linked action. */
  action?: string
  updates?: readonly ({ at: When; by: Who; schedule?: Schedule } & Partial<EventText>)[]
  deleted?: { at: When; by: Who }
}

const MEETING_AGENDA = '1. Roof repair above the fourth-floor landing: choice between the two quotes.\n2. Accessible ramp at the main entrance.\n3. Entrance door access control.'
const VOTE_AGENDA = '1. Lift modernisation: vote on the quotes from Apex Lifts and Riverside Elevators, and on a special assessment in ten monthly instalments.'
const DELEGATION = "If you can't attend, you can delegate your vote to another neighbour in writing."

const SCRIPTS: readonly EventScript[] = [
  {
    key: 'led', at: [110, '12:00'], by: 'admin', action: 'led', schedule: { day: -104, days: 2 },
    title: 'LED installation in the stairwells', location: 'Stairwells, all floors',
    description: 'Bright Spark Electrical will work floor by floor. The stairwell light may be off for up to an hour on each landing.',
  },
  {
    key: 'pest', at: [58, '10:00'], by: 'admin', action: 'pest', schedule: { day: -52, from: '09:00', to: '11:00' },
    title: 'Pest control treatment', location: 'Basement and bin store',
    description: 'Pest Away Services will treat the basement corridor, the storage rooms, the bin store and the drains. Keep pets away from these areas until the afternoon.',
  },
  {
    key: 'meeting', at: [45, '20:15'], by: 1, action: 'roof', schedule: { day: -36, from: '19:00', to: '20:45' },
    title: "Extraordinary residents' meeting", location: 'Entrance hall',
    description: `Agenda:\n${MEETING_AGENDA}\n\n${DELEGATION}`,
    updates: [{
      at: [40, '09:30'], by: 1, location: 'Community room, ground floor',
      description: `Agenda:\n${MEETING_AGENDA}\n4. Gutter and downpipe replacement.\n\n${DELEGATION}`,
    }],
  },
  {
    key: 'lift-inspection', at: [32, '11:00'], by: 'admin', action: 'lift', schedule: { day: -25, from: '09:30', to: '12:00' },
    title: 'Lift inspection', location: 'Lift machine room',
    description: 'Annual inspection by the certification body. The lift will be out of service during the visit.',
  },
  {
    key: 'garden', at: [27, '17:30'], by: 4, schedule: { day: -18, from: '10:00', to: '13:00' },
    title: 'Garden clean-up morning', location: 'Courtyard',
    description: "Bring gloves! We'll prune the hedges, rake the leaves and plant spring bulbs. Coffee and pastries for everyone who joins.",
  },
  {
    key: 'water', at: [14, '16:20'], by: 'admin', schedule: { day: -9, from: '09:00', to: '12:00' },
    title: 'Water supply cut for pipe works', location: 'Whole building',
    description: 'Riverside Water is replacing a valve in the street. There will be no water in any dwelling during the works: fill a few bottles the night before.',
    updates: [{ at: [12, '08:45'], by: 'admin', schedule: { day: -9, from: '09:00', to: '13:00' } }],
  },
  {
    key: 'vote', at: [12, '20:30'], by: 1, action: 'lift', schedule: { day: 6, from: '19:00', to: '20:30' },
    title: "Residents' meeting: lift modernisation vote", location: 'Community room, ground floor',
    description: `Agenda:\n${VOTE_AGENDA}\n2. Any other business.\n\n${DELEGATION}`,
    updates: [{
      at: [6, '20:40'], by: 1,
      description: `Agenda:\n${VOTE_AGENDA}\n2. Play corner in the courtyard.\n3. Any other business.\n\n${DELEGATION}`,
    }],
  },
  {
    key: 'roof-works', at: [10, '19:10'], by: 1, action: 'roof', schedule: { day: -4, days: 8 },
    title: 'Roof works: scaffolding on the rear facade', location: 'Rear facade and courtyard',
    description: 'Northgate Roofing will repair the membrane around the skylight and replace the rear gutters. The courtyard will be partly closed and the fourth-floor landing may be noisy from 8:00 to 17:00.',
    updates: [{ at: [5, '18:30'], by: 13, schedule: { day: -3, days: 8 } }],
  },
  {
    key: 'extinguishers', at: [8, '09:45'], by: 'admin', action: 'extinguishers', schedule: { day: 2, from: '10:00', to: '12:00' },
    title: 'Fire extinguisher replacement', location: 'Landings and car park',
    description: 'Firesafe Services will replace the four expired extinguishers and check the others.',
  },
  {
    key: 'gate', at: [7, '12:00'], by: 'admin', schedule: { day: 1, from: '15:00', to: '16:00' },
    title: 'Car park gate repair visit', location: 'Car park',
    description: 'A technician will adjust the gate closer. The gate will stay open during the visit.',
    deleted: { at: [2, '09:15'], by: 'admin' },
  },
  {
    key: 'windows', at: [6, '11:15'], by: 'admin', schedule: { day: 3, from: '08:00', to: '12:00' },
    title: 'Window cleaning in the common areas', location: 'Stairwells and entrance',
    description: 'Sparkle Cleaning Services will clean the stairwell windows and the glass of the entrance door. Please keep the landings clear of shoes and plants.',
  },
  {
    key: 'access', at: [5, '12:40'], by: 'admin', action: 'access', schedule: { day: 12, days: 1 },
    title: 'Access control installation', location: 'Street door and car park door',
    description: 'Fortis Door Systems will install the fob readers. The doors will stay open with someone watching them during the works. Collect your fobs from the president in the evening.',
  },
  {
    key: 'bulky', at: [4, '19:00'], by: 2, schedule: { day: 0, days: 1 },
    title: 'Bulky waste collection', location: 'Pavement in front of the building',
    description: "The council collects furniture and large items left on the pavement before 8:00. Please don't leave anything in the entrance hall.",
  },
  {
    key: 'party', at: [3, '21:30'], by: 12, schedule: { day: 17, from: '18:00', to: '21:00' },
    title: "Neighbours' get-together in the courtyard", location: 'Courtyard',
    description: 'Bring something to share; drinks are on the community. Children welcome!',
  },
  {
    key: 'boiler', at: [1, '10:20'], by: 'admin', schedule: { day: 24, from: '09:00', to: '11:00' },
    title: 'Boiler room maintenance', location: 'Boiler room',
    description: 'Heatwise Boilers will service the hot water pumps. Hot water may be cut for up to two hours.',
  },
]

function fields(text: EventText, schedule: Schedule, today: string): EventFields {
  const day = addDays(today, schedule.day)
  if ('days' in schedule) {
    return { ...text, allDay: true, startsAt: null, endsAt: null, startsOn: day, endsOn: addDays(day, schedule.days) }
  }
  return {
    ...text, allDay: false, startsAt: zonedInstant(day, schedule.from), endsAt: zonedInstant(day, schedule.to), startsOn: null, endsOn: null,
  }
}

/** The events' part of the community timeline. */
export function eventSteps(): ScenarioStep[] {
  const today = zonedDay(now().getTime(), COMMUNITY_TIME_ZONE)
  const random = demoRandom('community:events')
  return SCRIPTS.flatMap(script => {
    const text = { title: script.title, description: script.description, location: script.location }
    let current = { text, schedule: script.schedule }
    const steps: ScenarioStep[] = [step(script.at, (state, refs, instant) => {
      const actionId = script.action ? ref(refs.actions, script.action).id : null
      refs.events.set(script.key, createEvent(state, actor(script.by), fields(text, script.schedule, today), actionId, instant, random.uuid()))
    })]
    for (const update of script.updates ?? []) {
      const { at: when, by, schedule = current.schedule, ...changes } = update
      current = { text: { ...current.text, ...changes }, schedule }
      const next = fields(current.text, schedule, today)
      steps.push(step(when, (state, refs, instant) => editEvent(state, actor(by), ref(refs.events, script.key), next, undefined, instant)))
    }
    const { deleted } = script
    if (deleted) steps.push(step(deleted.at, (state, refs, instant) => deleteEvent(state, actor(deleted.by), ref(refs.events, script.key), instant)))
    return steps
  })
}
