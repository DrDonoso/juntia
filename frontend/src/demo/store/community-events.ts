/**
 * Community events (src/juntia/community_events.py): the operations that create, change and delete
 * them with their history, the API views, and the list and agenda queries. Days and "today" are
 * those of the community's time zone, like the backend's.
 */
import type { ActorOut, EventHistoryOut, EventOut, EventSnapshot } from '../../api/schema.gen'
import { pageCount } from '../core/pagination'
import { findAction } from './community-actions'
import { actorOut, compareText, sameJson, type ChangeKind, type CommunityState, type DemoEvent, type DemoEventChange } from './community-model'
import { foldText } from './community-text'
import { COMMUNITY_TIME_ZONE, dayNumber, dayOfNumber, zonedDateTime, zonedDay } from './community-time'

export const EVENT_PAGE_SIZE = 20

export const EVENT_SCOPES = ['upcoming', 'past', 'all', 'deleted'] as const
export type EventScope = typeof EVENT_SCOPES[number]

/** What an event says and when it happens, as validated from the API. */
export interface EventFields {
  title: string
  description: string
  location: string
  allDay: boolean
  startsAt: string | null
  endsAt: string | null
  startsOn: string | null
  endsOn: string | null
}

export function findEvent(state: CommunityState, id: number): DemoEvent | undefined {
  return state.events.find(event => event.id === id)
}

/** What the history keeps of an event; `links` shows its action (hidden while actions are off). */
export function eventSnapshot(state: CommunityState, event: DemoEvent, links: boolean): EventSnapshot {
  const action = links && event.actionId !== null ? findAction(state, event.actionId) : undefined
  return {
    title: event.title, description: event.description, location: event.location, all_day: event.allDay,
    starts_at: event.startsAt, ends_at: event.endsAt, starts_on: event.startsOn, ends_on: event.endsOn,
    action: action ? { id: action.id, title: action.title } : null,
  }
}

export function eventOut(state: CommunityState, event: DemoEvent, links: boolean): EventOut {
  return {
    ...eventSnapshot(state, event, links), id: event.id, version: event.version, author: actorOut(event.author),
    created_at: event.createdAt, updated_at: event.updatedAt, deleted_at: event.deletedAt,
  }
}

function record(
  state: CommunityState, event: DemoEvent, actor: ActorOut, kind: ChangeKind, before: EventSnapshot | null,
  after: EventSnapshot | null, at: string,
): void {
  state.eventHistory.push({ id: state.sequences.eventHistory.next(), eventId: event.id, kind, author: { ...actor }, createdAt: at, before, after })
}

export function createEvent(
  state: CommunityState, actor: ActorOut, fields: EventFields, actionId: number | null, at: string, calendarUid: string,
): DemoEvent {
  const event: DemoEvent = {
    id: state.sequences.event.next(), calendarUid, ...fields, actionId, author: { ...actor }, version: 1,
    createdAt: at, updatedAt: at, deletedAt: null,
  }
  state.events.push(event)
  record(state, event, actor, 'created', null, eventSnapshot(state, event, true), at)
  return event
}

/**
 * `edit_event`: applies the fields (and the action link unless `actionId` is undefined); a new
 * version and a history entry only when something changed.
 */
export function editEvent(
  state: CommunityState, actor: ActorOut, event: DemoEvent, fields: EventFields, actionId: number | null | undefined, at: string,
): void {
  const before = eventSnapshot(state, event, true)
  Object.assign(event, fields)
  if (actionId !== undefined) event.actionId = actionId
  const after = eventSnapshot(state, event, true)
  if (sameJson(before, after)) return
  event.version += 1
  event.updatedAt = at
  record(state, event, actor, 'updated', before, after, at)
}

/** Deleted events stay readable (and in the "deleted" scope) with their history. */
export function deleteEvent(state: CommunityState, actor: ActorOut, event: DemoEvent, at: string): void {
  const before = eventSnapshot(state, event, true)
  event.deletedAt = at
  event.updatedAt = at
  event.version += 1
  record(state, event, actor, 'deleted', before, null, at)
}

export function eventChangeOut(change: DemoEventChange, links: boolean): EventHistoryOut {
  const visible = (snapshot: EventSnapshot | null) => snapshot && { ...snapshot, action: links ? snapshot.action : null }
  return {
    id: change.id, kind: change.kind, author: actorOut(change.author), created_at: change.createdAt,
    before: visible(change.before), after: visible(change.after),
  }
}

/** Whether an event is over (`has_ended`, the "past" scope): all-day ones at the end of their last day. */
export function hasEnded(event: DemoEvent, now: number, today: string): boolean {
  return event.allDay ? (event.endsOn ?? '') <= today : Date.parse(event.endsAt ?? '') <= now
}

export interface EventQuery {
  scope: EventScope
  q: string
  actionId: number | null
}

/** Events of a scope matching the filters (`event_conditions`). */
export function filterEvents(state: CommunityState, query: EventQuery, now: number, zone = COMMUNITY_TIME_ZONE): DemoEvent[] {
  const today = zonedDay(now, zone)
  const needle = query.q.trim() ? foldText(query.q.trim()) : null
  return state.events.filter(event => {
    if ((query.scope === 'deleted') !== (event.deletedAt !== null)) return false
    if (query.scope === 'upcoming' && hasEnded(event, now, today)) return false
    if (query.scope === 'past' && !hasEnded(event, now, today)) return false
    if (query.actionId !== null && event.actionId !== query.actionId) return false
    return needle === null || foldText(event.title).includes(needle)
  })
}

/** Sortable local start: all-day events start at midnight of their first day. */
function localStart(event: DemoEvent, zone: string): string {
  return event.allDay ? `${event.startsOn}T00:00:00.000` : zonedDateTime(Date.parse(event.startsAt ?? ''), zone)
}

/** `GET /api/events`: chronological for upcoming and all, latest first for past and deleted. */
export function listEvents(state: CommunityState, query: EventQuery, now: number, zone = COMMUNITY_TIME_ZONE): DemoEvent[] {
  const sign = query.scope === 'upcoming' || query.scope === 'all' ? 1 : -1
  return filterEvents(state, query, now, zone)
    .map(event => ({ event, start: localStart(event, zone) }))
    .sort((a, b) => sign * (compareText(a.start, b.start) || a.event.id - b.event.id))
    .map(entry => entry.event)
}

export interface AgendaEntry {
  day: string
  event: DemoEvent
  isContinuation: boolean
  isLastDay: boolean
  isPast: boolean
}

export interface AgendaPage {
  items: AgendaEntry[]
  total: number
  page: number
  pages: number
}

/**
 * `GET /api/events/agenda`: one entry per event and day it covers, in the community's days. The
 * upcoming scope starts ongoing events today; without a page, the complete timeline opens on the
 * page that reaches today. Each event yields at most the entries the requested page can show, so
 * a very long event never expands its whole duration.
 */
export function agendaPage(
  state: CommunityState, query: EventQuery, page: number | null, now: number, zone = COMMUNITY_TIME_ZONE,
): AgendaPage {
  const today = zonedDay(now, zone)
  const todayNumber = dayNumber(today)
  const ascending = query.scope === 'upcoming' || query.scope === 'all'
  const intervals = filterEvents(state, query, now, zone).map(event => {
    const first = event.allDay ? dayNumber(event.startsOn ?? '') : dayNumber(zonedDay(Date.parse(event.startsAt ?? ''), zone))
    const last = event.allDay ? dayNumber(event.endsOn ?? '') - 1 : dayNumber(zonedDay(Date.parse(event.endsAt ?? '') - 1, zone))
    const visibleFirst = query.scope === 'upcoming' ? Math.max(first, todayNumber) : first
    return { event, first, last, visibleFirst, span: last - visibleFirst }
  })
  const total = intervals.reduce((sum, interval) => sum + interval.span + 1, 0)
  const earlier = intervals.reduce((sum, interval) => sum + (
    interval.visibleFirst >= todayNumber ? 0 : interval.last < todayNumber ? interval.span + 1 : todayNumber - interval.visibleFirst
  ), 0)
  const pages = pageCount(total, EVENT_PAGE_SIZE)
  const current = page ?? (query.scope === 'all' ? Math.min(Math.floor(earlier / EVENT_PAGE_SIZE) + 1, pages) : 1)
  const offset = (current - 1) * EVENT_PAGE_SIZE
  if (offset >= total) return { items: [], total, page: current, pages }
  const reach = current * EVENT_PAGE_SIZE
  const occurrences = intervals.flatMap(interval => Array.from({ length: Math.min(interval.span + 1, reach) }, (_, index) => {
    const day = ascending ? interval.visibleFirst + index : interval.last - index
    const time = day === interval.first && interval.event.startsAt !== null ? Date.parse(interval.event.startsAt) : null
    return { interval, day, time }
  }))
  occurrences.sort((a, b) => {
    const days = a.day - b.day
    if (days) return ascending ? days : -days
    if (a.time !== b.time) {
      // Entries without a time (all-day events and continuations) come first in each day, last when reversed.
      if (a.time === null) return ascending ? -1 : 1
      if (b.time === null) return ascending ? 1 : -1
      return ascending ? a.time - b.time : b.time - a.time
    }
    return ascending ? a.interval.event.id - b.interval.event.id : b.interval.event.id - a.interval.event.id
  })
  return {
    items: occurrences.slice(offset, offset + EVENT_PAGE_SIZE).map(({ interval, day }) => ({
      day: dayOfNumber(day), event: interval.event, isContinuation: day !== interval.first, isLastDay: day === interval.last,
      isPast: hasEnded(interval.event, now, today),
    })),
    total, page: current, pages,
  }
}
