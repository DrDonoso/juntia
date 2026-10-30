/**
 * Community event routes of the demo API (src/juntia/community_events.py): the list, the agenda
 * with one entry per day, items with history, and the calendar exports. Every reader may create,
 * edit or delete an event; times are entered in the community's time zone. All routes answer 404
 * `events_disabled` while the feature is off, and links to actions disappear while actions are off.
 */
import type { EventAgendaPage, EventOut } from '../../api/schema.gen'
import {
  DemoApiError, HttpResponse, MAX_PAGE, actorOf, displayName, http, idParam, isDay, now, nowIso, pageParam, paginate, parseBody, queryChoice,
  queryInt, queryText, readJson, route, type Body, type HttpHandler, type RouteContext,
} from '../core'
import { communityStore, type CommunityState } from '../store/community'
import { findAction } from '../store/community-actions'
import {
  EVENT_PAGE_SIZE, EVENT_SCOPES, agendaPage, createEvent, deleteEvent, editEvent, eventChangeOut, eventOut, findEvent, listEvents,
  type EventFields, type EventQuery,
} from '../store/community-events'
import type { DemoEvent } from '../store/community-model'
import { actionText } from '../store/community-text'
import { COMMUNITY_TIME_ZONE, apiInstant, wallClockValue, zonedInstants, type WallClock } from '../store/community-time'
import { coreStore } from '../store/core'
import { calendarFile, googleCalendar } from './community-calendar'
import { MODEL, eventFields, valid, version } from './community-contracts'

const EVENTS = { feature: 'events' } as const

const EVENT_KEYS = ['title', 'description', 'location', 'timezone', 'all_day', 'starts_at', 'ends_at', 'starts_on', 'ends_on', 'action_id']

/** The validated body of `EventIn` / `EventEdit`, times still in the community's wall clock. */
interface EventInput {
  title: string
  description: string
  location: string
  timezone: string
  schedule: { allDay: true; startsOn: string; endsOn: string } | { allDay: false; startsAt: WallClock; endsAt: WallClock }
  /** Undefined when the body leaves the link alone (`action_id` not sent). */
  actionId: number | null | undefined
  version: number
}

const NAIVE = /^(\d{4})-(\d{2})-(\d{2})(?:[Tt _](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,6})\d*)?)?)?(Z|[+-]\d{2}(?::?\d{2})?)?$/i

/** Pydantic's `NaiveDatetime` (a date alone is midnight); `'aware'` when it carries a time zone. */
export function naiveDateTime(value: string): WallClock | 'aware' | null {
  const match = NAIVE.exec(value.trim())
  if (!match) return null
  if (match[8]) return 'aware'
  const [year, month, day, hour = 0, minute = 0, second = 0] = match.slice(1, 7).map(part => Number(part ?? 0))
  if (!isDay(`${match[1]}-${match[2]}-${match[3]}`) || hour > 23 || minute > 59 || second > 59) return null
  return { year, month, day, hour, minute, second, millisecond: Number((match[7] ?? '0').padEnd(3, '0').slice(0, 3)) }
}

function dateTime(body: Body, key: string): WallClock | null {
  const raw = body.raw(key)
  if (raw === undefined || raw === null) return null
  if (typeof raw !== 'string') return body.fail(key, 'datetime_type')
  const value = naiveDateTime(raw)
  if (value === 'aware') return body.fail(key, 'timezone_naive')
  return value ?? body.fail(key, 'datetime_from_date_parsing')
}

/** `EventIn` (and `EventEdit` with `withVersion`), with its model validator: one valid schedule. */
function eventInput(body: Body, withVersion: boolean): EventInput {
  const title = body.text('title', { min: 1, max: 200 })
  const description = body.text('description', { max: 20000, fallback: '' })
  const location = body.text('location', { max: 200, fallback: '' })
  const timezone = body.text('timezone', { min: 1, max: 100 })
  const allDay = body.bool('all_day')
  const startsAt = dateTime(body, 'starts_at'), endsAt = dateTime(body, 'ends_at')
  const startsOn = body.day('starts_on', { nullable: true }), endsOn = body.day('ends_on', { nullable: true })
  const actionId = body.optionalInt('action_id')
  const expected = withVersion ? version(body) : 0
  const place = body.failed('location') || !location.trim() ? '' : displayName(location) ?? body.fail('location', 'value_error') ?? ''
  const input = {
    title: body.failed('title') ? title : displayName(title) ?? body.fail('title', 'value_error') ?? '',
    description: body.failed('description') ? description : actionText(description) ?? body.fail('description', 'value_error') ?? '',
    location: place, timezone, actionId: body.present.has('action_id') ? actionId : undefined, version: expected,
  }
  // Placeholder for invalid bodies, which parseBody rejects once they are read.
  const invalid = { ...input, schedule: { allDay: true, startsOn: '', endsOn: '' } } as const
  if (!valid(body, withVersion ? [...EVENT_KEYS, 'version'] : EVENT_KEYS)) return invalid
  if (allDay && startsOn !== null && endsOn !== null && endsOn > startsOn && startsAt === null && endsAt === null) {
    return { ...input, schedule: { allDay: true, startsOn, endsOn } }
  }
  if (!allDay && startsAt !== null && endsAt !== null && wallClockValue(endsAt) > wallClockValue(startsAt) && startsOn === null && endsOn === null) {
    return { ...input, schedule: { allDay: false, startsAt, endsAt } }
  }
  body.fail(MODEL, 'event_interval_invalid')
  return invalid
}

/** `local_to_utc`: a wall-clock time that a daylight saving change skips or repeats is refused. */
function utc(clock: WallClock, field: 'starts_at' | 'ends_at'): number {
  const instants = zonedInstants(clock, COMMUNITY_TIME_ZONE)
  if (instants.length === 1) return instants[0]
  const code = instants.length ? 'event_time_ambiguous' : 'event_time_nonexistent'
  throw new DemoApiError(code, 422, { [field]: code })
}

/** `set_fields`: the event as it will be saved, in UTC (409 when the community's zone changed meanwhile). */
function eventFieldsOf(input: EventInput): EventFields {
  if (input.timezone !== COMMUNITY_TIME_ZONE) throw new DemoApiError('event_timezone_changed', 409)
  const text = { title: input.title, description: input.description, location: input.location }
  const { schedule } = input
  if (schedule.allDay) return { ...text, allDay: true, startsAt: null, endsAt: null, startsOn: schedule.startsOn, endsOn: schedule.endsOn }
  const startsAt = utc(schedule.startsAt, 'starts_at'), endsAt = utc(schedule.endsAt, 'ends_at')
  if (endsAt <= startsAt) throw new DemoApiError('event_interval_invalid', 422, { ends_at: 'event_interval_invalid' })
  return { ...text, allDay: false, startsAt: apiInstant(startsAt), endsAt: apiInstant(endsAt), startsOn: null, endsOn: null }
}

/** `set_action`: a sent link needs the actions feature and an existing action. */
function linkedAction(state: CommunityState, input: EventInput): number | null | undefined {
  if (input.actionId === undefined) return undefined
  if (!coreStore().features.actions) throw new DemoApiError('actions_disabled', 404)
  if (input.actionId !== null && !findAction(state, input.actionId)) {
    throw new DemoApiError('event_action_not_found', 422, { action_id: 'event_action_not_found' })
  }
  return input.actionId
}

function author({ identity }: RouteContext) {
  if (!identity) throw new DemoApiError('authentication_required', 401)
  return actorOf(identity)
}

function links(): boolean {
  return coreStore().features.actions
}

function eventOf(state: CommunityState, id: number, { active = false } = {}): DemoEvent {
  const event = findEvent(state, id)
  if (!event) throw new DemoApiError('event_not_found', 404)
  if (active && event.deletedAt !== null) throw new DemoApiError('event_deleted', 409)
  return event
}

/** The scope, search and action filters of the list and the agenda. */
function eventQuery(url: URL): EventQuery {
  return {
    scope: queryChoice(url, 'scope', EVENT_SCOPES, 'upcoming'),
    q: queryText(url, 'q', { max: 200 }),
    actionId: queryInt(url, 'action_id'),
  }
}

function checkActionFilter(query: EventQuery): void {
  if (query.actionId !== null && !links()) throw new DemoApiError('actions_disabled', 404)
}

export const eventHandlers: HttpHandler[] = [
  http.get('/api/events/config', route('session', () => ({ timezone: COMMUNITY_TIME_ZONE }), EVENTS)),
  http.get('/api/events/agenda', route('session', ({ url }): EventAgendaPage => {
    const page = queryInt(url, 'page', { max: MAX_PAGE })
    const query = eventQuery(url)
    checkActionFilter(query)
    const state = communityStore()
    const result = agendaPage(state, query, page, now().getTime())
    const visible = links()
    return {
      ...result,
      items: result.items.map(entry => ({
        day: entry.day, is_continuation: entry.isContinuation, is_last_day: entry.isLastDay, is_past: entry.isPast,
        event: eventOut(state, entry.event, visible),
      })),
    }
  }, EVENTS)),
  http.get('/api/events', route('session', ({ url }) => {
    const page = pageParam(url)
    const query = eventQuery(url)
    checkActionFilter(query)
    const state = communityStore()
    const { items, ...info } = paginate(listEvents(state, query, now().getTime()), page, EVENT_PAGE_SIZE)
    return { ...info, items: items.map(event => eventOut(state, event, links())) }
  }, EVENTS)),
  http.post('/api/events', route('session', async (context): Promise<EventOut> => {
    const input = parseBody(await readJson(context.request), body => eventInput(body, false), { fields: eventFields })
    const state = communityStore()
    const fields = eventFieldsOf(input)
    const actionId = linkedAction(state, input) ?? null
    const event = createEvent(state, author(context), fields, actionId, nowIso(), state.random.uuid())
    return eventOut(state, event, links())
  }, { ...EVENTS, status: 201 })),
  http.get('/api/events/:eventId', route('session', ({ params }) => {
    const state = communityStore()
    return eventOut(state, eventOf(state, idParam(params, 'eventId')), links())
  }, EVENTS)),
  http.patch('/api/events/:eventId', route('session', async context => {
    const eventId = idParam(context.params, 'eventId')
    const input = parseBody(await readJson(context.request), body => eventInput(body, true), { fields: eventFields })
    const state = communityStore()
    const event = eventOf(state, eventId, { active: true })
    if (event.version !== input.version) throw new DemoApiError('event_stale', 409)
    const fields = eventFieldsOf(input)
    editEvent(state, author(context), event, fields, linkedAction(state, input), nowIso())
    return eventOut(state, event, links())
  }, EVENTS)),
  http.delete('/api/events/:eventId', route('session', async context => {
    const eventId = idParam(context.params, 'eventId')
    const expected = parseBody(await readJson(context.request), version, { fields: eventFields })
    const state = communityStore()
    const event = eventOf(state, eventId, { active: true })
    if (event.version !== expected) throw new DemoApiError('event_stale', 409)
    deleteEvent(state, author(context), event, nowIso())
  }, { ...EVENTS, status: 204 })),
  http.get('/api/events/:eventId/history', route('session', ({ params, url }) => {
    const eventId = idParam(params, 'eventId')
    const page = pageParam(url)
    const state = communityStore()
    const event = eventOf(state, eventId)
    const changes = state.eventHistory.filter(change => change.eventId === event.id).sort((a, b) => b.id - a.id)
    const { items, ...info } = paginate(changes, page, EVENT_PAGE_SIZE)
    return { ...info, items: items.map(change => eventChangeOut(change, links())) }
  }, EVENTS)),
  http.get('/api/events/:eventId/calendar', route('session', ({ params, url }) => {
    const event = eventOf(communityStore(), idParam(params, 'eventId'), { active: true })
    return googleCalendar(event, url.origin, COMMUNITY_TIME_ZONE)
  }, EVENTS)),
  http.get('/api/events/:eventId/calendar.ics', route('session', ({ params, url }) => {
    const event = eventOf(communityStore(), idParam(params, 'eventId'), { active: true })
    return new HttpResponse(calendarFile(event, url.origin), {
      headers: { 'Content-Type': 'text/calendar; charset=utf-8', 'Content-Disposition': `attachment; filename="event-${event.id}.ics"` },
    })
  }, EVENTS)),
]
