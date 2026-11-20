/**
 * Notifications in the demo (after src/juntia/notifications.py and push.py), derived on every request
 * from the other stores with the backend's rules; the notifications store only keeps what each
 * account did with them (store/notifications.ts).
 *
 * - Administrators are told when the statement of the previous month is missing: the ledger has
 *   movements from before that month and none in it. The demo's statements reach three days before
 *   today, so nothing is missing at first; removing the latest statements in Manage statements brings
 *   the alert, and importing the statement again resolves it.
 * - Every account but the administrator, who imports the statements, is told the accounts of the
 *   previous month once its statement brought them.
 * - The news of the actions and the events comes from their history, as it happened: every change
 *   by someone else of an action's status, the comments and PDFs on the actions the account follows
 *   (it created, edited, commented on or attached a PDF to them), and the events that had not ended
 *   when someone created, moved or deleted them. One notification per subject keeps the latest, and
 *   what the account does on a subject reads it. The news that came more than three days before the
 *   page loaded had been read by then; it is forgotten 90 days after it came.
 * - Every account is reminded of the events that start in the next 24 hours (all-day ones: the next
 *   day), unless their start was set less than 24 hours before.
 *
 * Reading, dismissing and choosing the kinds work like on a real server until the page is reloaded.
 * The demo has no push service, and its service worker is MSW's: registering a device for push
 * notifications answers 403 `demo_unavailable` (`UNAVAILABLE_IN_DEMO`).
 */
import type { EventSnapshot, NotificationOut, NotificationsOut } from '../../api/schema.gen'
import { ADMINISTRATOR_ID } from '../cast'
import {
  DemoApiError, addMonths, demoUnavailable, endOfMonth, http, idParam, now, nowIso, parseBody, readJson, route, startOfMonth,
  today, type HttpHandler,
} from '../core'
import { communityStore } from '../store/community'
import { hasEnded } from '../store/community-events'
import type { DemoEvent } from '../store/community-model'
import { COMMUNITY_TIME_ZONE, DAY_MS, dayNumber, dayOfNumber, zonedDateTime, zonedDay, zonedInstant } from '../store/community-time'
import { coreStore, type DemoResident } from '../store/core'
import { financeStore } from '../store/finance'
import { notificationsStore, type DemoNotificationKind } from '../store/notifications'

/** Every kind, in the order they are shown (backend `NOTIFICATION_KINDS`). */
const KINDS: readonly DemoNotificationKind[] = [
  'statement_missing', 'accounts_ready', 'action_changes', 'action_comments', 'event_changes', 'event_reminder',
]
/** The section each kind belongs to: while it is off, the kind is neither listed nor chosen. */
const SECTIONS: Partial<Record<DemoNotificationKind, 'actions' | 'events'>> = {
  action_changes: 'actions', action_comments: 'actions', event_changes: 'events', event_reminder: 'events',
}
/** The most notifications listed (backend `MAX_LISTED`). */
const MAX_LISTED = 50
/** News is forgotten this long after it came (backend `KEEP`). */
const KEEP_MS = 90 * DAY_MS
/** The news that came this long before the page loaded had been read by then. */
const READ_BEFORE_MS = 3 * DAY_MS
/** The history entries that make an account follow an action ('updated' only when it edits its title, description or status). */
const FOLLOWING = new Set(['created', 'updated', 'comment_added', 'attachment_added'])
const EDITED: ReadonlySet<string> = new Set(['title', 'description', 'status'])

type Params = Record<string, string>

/** Something new for the account: a notification, or news that brings one up to date. */
interface News {
  kind: DemoNotificationKind
  key: string
  link: string
  /** Its parameters, from those it had while still unread (null once read or dismissed). */
  change: (told: Params | null) => Params
  /** An alert whose condition no longer holds. */
  resolved?: boolean
}

/** What happened to the account's notifications, in time order. */
type Step = { at: string } & (
  | { news: News }
  | { amend: { keys: readonly string[]; params: Params } }
  | { seen: readonly string[] }
  | { act: 'read' | 'dismiss'; key: string }
)

/** A notification after everything that happened to it. */
interface Told {
  kind: DemoNotificationKind
  key: string
  link: string
  params: Params
  createdAt: string
  readAt: string | null
  dismissedAt: string | null
  resolved: boolean
}

/** The kinds an account can receive while the sections they belong to are on. */
function available(user: DemoResident): DemoNotificationKind[] {
  const { features } = coreStore()
  return KINDS.filter(kind => {
    const section = SECTIONS[kind]
    return (user.administrator || kind !== 'statement_missing') && (!section || features[section])
  })
}

function muted(user: DemoResident): Set<DemoNotificationKind> {
  return notificationsStore().muted.get(user.id) ?? new Set()
}

function count(value: string | undefined): number {
  return /^\d+$/.test(value ?? '') ? Number(value) : 0
}

/** The month before today's (`YYYY-MM`), the one that ended last. */
function previousMonth(): string {
  return addMonths(startOfMonth(today()), -1).slice(0, 7)
}

// Finances -----------------------------------------------------------------------------------------

/** Those of `months` (`YYYY-MM`) whose statement is missing: movements before the month, and none in it. */
function missingMonths(months: Iterable<string>): Set<string> {
  const days = [...financeStore().transactions.values()].map(transaction => transaction.bookingDate)
  if (days.length === 0) return new Set()
  const earliest = days.reduce((first, day) => day < first ? day : first)
  const booked = new Set(days.map(day => day.slice(0, 7)))
  return new Set([...months].filter(month => earliest < `${month}-01` && !booked.has(month)))
}

/** The administrators' alerts: the previous month's statement, from when it was first noticed missing. */
function statementNews(user: DemoResident): Step[] {
  if (!user.administrator) return []
  const { noticed } = notificationsStore()
  const prefix = `${user.id}:statement_missing:`
  const month = previousMonth()
  if (!noticed.has(prefix + month) && missingMonths([month]).has(month)) noticed.set(prefix + month, nowIso())
  const months = [...noticed.entries()].filter(([key]) => key.startsWith(prefix))
  const holding = missingMonths(months.map(([key]) => key.slice(prefix.length)))
  return months.map(([key, at]) => {
    const missing = key.slice(prefix.length)
    return {
      at,
      news: {
        kind: 'statement_missing', key: `statement_missing:${missing}`, link: '/admin', change: () => ({ month: missing }),
        resolved: !holding.has(missing),
      },
    }
  })
}

/** The accounts of the previous month, from the import that brought its movements; not for who imported it. */
function accountsNews(user: DemoResident): Step[] {
  const month = previousMonth()
  const finance = financeStore()
  const booked = new Set([...finance.transactions.values()].filter(item => item.bookingDate.startsWith(month)).map(item => item.id))
  if (user.id === ADMINISTRATOR_ID || booked.size === 0) return []
  const at = finance.imports.filter(item => item.rows.some(row => booked.has(row.transactionId))).map(item => item.createdAt).sort()[0]
  return [{
    at: at ?? nowIso(),
    news: {
      kind: 'accounts_ready', key: `accounts_ready:${month}`, link: `/?start=${month}-01&end=${endOfMonth(`${month}-01`)}`,
      change: () => ({ month }),
    },
  }]
}

// Actions ----------------------------------------------------------------------------------------

/** What the account was told about every action, as it happened. */
function actionNews(user: DemoResident): Step[] {
  const community = communityStore()
  const steps: Step[] = []
  for (const action of community.actions) {
    const link = `/actions/${action.id}`
    const keys = [`action:${action.id}`, `action_comments:${action.id}`] as const
    let title = '', status = '', following = false
    for (const entry of community.actionHistory.filter(item => item.actionId === action.id)) {
      const fields = new Set(entry.changes.map(change => change.field))
      for (const change of entry.changes) {
        if (change.field === 'title') title = String(change.after)
        if (change.field === 'status') status = String(change.after)
      }
      const at = entry.createdAt
      if (entry.author.kind === 'resident' && entry.author.user_id === user.id) {
        // What it does on the action (backend: creating it, editing it, commenting, attaching) reads it, and follows it;
        // labels alone do not, nor their renaming in the catalog.
        if (FOLLOWING.has(entry.kind) && (entry.kind !== 'updated' || [...fields].some(field => EDITED.has(field)))) {
          steps.push({ at, seen: keys })
          following = true
        }
        continue
      }
      const told = { title, status }
      if (entry.kind === 'created' || (entry.kind === 'updated' && fields.has('status'))) {
        const created = entry.kind === 'created'
        steps.push({
          at,
          news: {
            kind: 'action_changes', key: keys[0], link,
            // A new action that is still unread stays new, with its current status.
            change: previous => ({ ...told, change: created || previous?.change === 'created' ? 'created' : 'status' }),
          },
        })
      }
      if (entry.kind === 'updated' && fields.has('title')) steps.push({ at, amend: { keys, params: { title } } })
      if ((entry.kind === 'comment_added' || entry.kind === 'attachment_added') && following) {
        const attachment = entry.kind === 'attachment_added', author = entry.author.name
        steps.push({
          at,
          news: {
            kind: 'action_comments', key: keys[1], link,
            change: previous => ({
              title: told.title,
              comments: String(count(previous?.comments) + (attachment ? 0 : 1)),
              attachments: String(count(previous?.attachments) + (attachment ? 1 : 0)),
              author,
            }),
          },
        })
      }
    }
  }
  return steps
}

// Events -----------------------------------------------------------------------------------------

/** What the texts about an event need: its title, the day and time it starts in the community's time zone, its place. */
function eventParams(snapshot: EventSnapshot): Params {
  const base = { title: snapshot.title, location: snapshot.location }
  if (snapshot.all_day) return { ...base, day: snapshot.starts_on ?? '', time: '' }
  const start = zonedDateTime(Date.parse(snapshot.starts_at ?? ''), COMMUNITY_TIME_ZONE)
  return { ...base, day: start.slice(0, 10), time: start.slice(11, 16) }
}

function snapshotOf(event: DemoEvent): EventSnapshot {
  return {
    title: event.title, description: event.description, location: event.location, all_day: event.allDay,
    starts_at: event.startsAt, ends_at: event.endsAt, starts_on: event.startsOn, ends_on: event.endsOn, action: null,
  }
}

/** Whether an event, as a snapshot shows it, had ended at `instant`. */
function endedAt(snapshot: EventSnapshot, instant: number): boolean {
  return snapshot.all_day
    ? (snapshot.ends_on ?? '') <= zonedDay(instant, COMMUNITY_TIME_ZONE)
    : Date.parse(snapshot.ends_at ?? '') <= instant
}

const SCHEDULE = ['all_day', 'starts_at', 'ends_at', 'starts_on', 'ends_on', 'location'] as const
const START = ['all_day', 'starts_at', 'starts_on'] as const

function differ(before: EventSnapshot | null, after: EventSnapshot | null, fields: readonly (keyof EventSnapshot)[]): boolean {
  return fields.some(field => before?.[field] !== after?.[field])
}

/** What the account was told about every event that had not ended, as it happened. */
function eventNews(user: DemoResident): Step[] {
  const community = communityStore()
  const steps: Step[] = []
  for (const event of community.events) {
    const key = `event:${event.id}`, link = `/events/${event.id}`
    for (const entry of community.eventHistory.filter(item => item.eventId === event.id)) {
      const at = entry.createdAt
      if (entry.author.kind === 'resident' && entry.author.user_id === user.id) {
        steps.push({ at, seen: [key] })
        continue
      }
      const snapshot = entry.after ?? entry.before
      if (!snapshot) continue
      const params = eventParams(snapshot)
      const change = entry.kind === 'created' ? 'created'
        : entry.kind === 'deleted' ? 'cancelled'
          : differ(entry.before, entry.after, SCHEDULE) ? 'changed' : null
      if (change === null || endedAt(snapshot, Date.parse(at))) {
        steps.push({ at, amend: { keys: [key], params } })
        continue
      }
      steps.push({
        at,
        news: {
          kind: 'event_changes', key, link, resolved: hasEnded(event, now().getTime(), zonedDay(now().getTime(), COMMUNITY_TIME_ZONE)),
          // A new event that is still unread stays new, unless it is cancelled.
          change: previous => ({
            ...params, change: change === 'created' || (change === 'changed' && previous?.change === 'created') ? 'created' : change,
          }),
        },
      })
    }
  }
  return steps
}

/** The reminders of the events that start in the next 24 hours (all-day ones: tomorrow), for everyone. */
function reminders(): Step[] {
  const community = communityStore()
  const instant = now().getTime()
  const tomorrow = dayOfNumber(dayNumber(zonedDay(instant, COMMUNITY_TIME_ZONE)) + 1)
  const steps: Step[] = []
  for (const event of community.events) {
    if (event.deletedAt !== null) continue
    const start = event.allDay ? null : Date.parse(event.startsAt ?? '')
    const due = start === null ? event.startsOn === tomorrow : start > instant && start <= instant + DAY_MS
    if (!due) continue
    const remindAt = start === null
      ? Date.parse(zonedInstant(dayOfNumber(dayNumber(event.startsOn ?? '') - 1), '00:00', COMMUNITY_TIME_ZONE))
      : start - DAY_MS
    // Its start set less than 24 hours before: its news told everybody then.
    const setAt = Math.max(Date.parse(event.createdAt), ...community.eventHistory
      .filter(entry => entry.eventId === event.id && entry.kind === 'updated' && differ(entry.before, entry.after, START))
      .map(entry => Date.parse(entry.createdAt)))
    if (setAt > remindAt) continue
    const params = eventParams(snapshotOf(event))
    steps.push({
      at: new Date(remindAt).toISOString(),
      news: {
        kind: 'event_reminder', key: `event_reminder:${event.id}:${params.day}${params.time ? `T${params.time}` : ''}`,
        link: `/events/${event.id}`, change: () => params,
      },
    })
  }
  return steps
}

// The account's notifications --------------------------------------------------------------------

/** Every notification of the account, as everything that happened left it. */
function derive(user: DemoResident): Told[] {
  const store = notificationsStore()
  const kinds = new Set(available(user))
  const readBefore = Date.parse(store.loadedAt) - READ_BEFORE_MS
  const steps: Step[] = [
    ...statementNews(user),
    ...accountsNews(user),
    ...(kinds.has('action_changes') ? actionNews(user) : []),
    ...(kinds.has('event_changes') ? eventNews(user) : []),
    ...(kinds.has('event_reminder') ? reminders() : []),
    ...store.acts.filter(act => act.accountId === user.id).map(({ at, act, key }) => ({ at, act, key })),
  ].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
  const told = new Map<string, Told>()
  for (const step of steps) {
    if ('news' in step) {
      const { kind, key, link, change, resolved = false } = step.news
      const previous = told.get(key)
      const unread = previous && !previous.readAt && !previous.dismissedAt && !previous.resolved
      const old = Date.parse(step.at) < readBefore
      told.set(key, {
        kind, key, link, params: change(unread ? previous.params : null), createdAt: step.at,
        readAt: old ? step.at : null, dismissedAt: null, resolved,
      })
    } else if ('amend' in step) {
      for (const key of step.amend.keys) {
        const item = told.get(key)
        if (item) item.params = { ...item.params, ...step.amend.params }
      }
    } else if ('seen' in step) {
      for (const key of step.seen) {
        const item = told.get(key)
        if (item) item.readAt ??= step.at
      }
    } else {
      const item = told.get(step.key)
      if (!item) continue
      item.readAt ??= step.at
      if (step.act === 'dismiss') item.dismissedAt ??= step.at
    }
  }
  return [...told.values()]
}

/** The id of the account's notification `key`, the same during the whole visit. */
function idOf(user: DemoResident, key: string): number {
  const { ids, sequence } = notificationsStore()
  const name = `${user.id}:${key}`
  let id = ids.get(name)
  if (id === undefined) {
    id = sequence.next()
    ids.set(name, id)
  }
  return id
}

/** The account's notifications under the bell: of the kinds it wants, neither resolved nor dismissed, nor forgotten; newest first. */
function shown(user: DemoResident): (Told & { id: number })[] {
  const wanted = new Set(available(user).filter(kind => !muted(user).has(kind)))
  const forgotten = now().getTime() - KEEP_MS
  return derive(user)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.key.localeCompare(b.key))
    .map(item => ({ ...item, id: idOf(user, item.key) }))
    .filter(item => wanted.has(item.kind) && !item.resolved && !item.dismissedAt
      && (item.kind === 'statement_missing' || Date.parse(item.createdAt) >= forgotten))
    .reverse()
}

function notificationsOut(user: DemoResident): NotificationsOut {
  const items = shown(user)
  const off = muted(user)
  return {
    kinds: available(user).map(kind => ({ kind, enabled: !off.has(kind) })),
    today: zonedDay(now().getTime(), COMMUNITY_TIME_ZONE),
    unread: items.filter(item => item.readAt === null).length,
    items: items.slice(0, MAX_LISTED).map((item): NotificationOut => ({
      id: item.id, kind: item.kind, params: item.params, link: item.link, created_at: item.createdAt, read: item.readAt !== null,
    })),
  }
}

/** The key of one of the account's notifications (404 `notification_not_found` for anyone else's). */
function owned(user: DemoResident, id: number): string {
  const key = derive(user).map(item => item.key).find(key => notificationsStore().ids.get(`${user.id}:${key}`) === id)
  if (key === undefined) throw new DemoApiError('notification_not_found', 404)
  return key
}

function act(user: DemoResident, key: string, kind: 'read' | 'dismiss'): void {
  notificationsStore().acts.push({ accountId: user.id, key, act: kind, at: nowIso() })
}

const PUSH_LOCALES = ['en', 'es'] as const

export const notificationHandlers: HttpHandler[] = [
  http.get('/api/notifications', route('session', ({ user }) => notificationsOut(user))),
  http.post('/api/notifications/read-all', route('session', ({ user }) => {
    for (const item of shown(user)) if (item.readAt === null) act(user, item.key, 'read')
    return notificationsOut(user)
  })),
  http.post('/api/notifications/:notificationId/read', route('session', ({ params, user }) => {
    act(user, owned(user, idParam(params, 'notificationId')), 'read')
    return notificationsOut(user)
  })),
  http.post('/api/notifications/:notificationId/dismiss', route('session', ({ params, user }) => {
    act(user, owned(user, idParam(params, 'notificationId')), 'dismiss')
    return notificationsOut(user)
  })),
  http.patch('/api/notifications/preferences', route('session', async ({ request, user }) => {
    const { kind, enabled } = parseBody(await readJson(request), body => ({
      kind: body.literal('kind', KINDS), enabled: body.bool('enabled'),
    }))
    if (!available(user).includes(kind)) throw new DemoApiError('notification_kind_unavailable', 403)
    const { muted: byAccount } = notificationsStore()
    const off = new Set(byAccount.get(user.id))
    if (enabled) off.delete(kind)
    else off.add(kind)
    byAccount.set(user.id, off)
    return notificationsOut(user)
  })),
  http.get('/api/push', route('session', () => demoUnavailable())),
  http.put('/api/push/subscription', route('session', async ({ request }) => {
    parseBody(await readJson(request), body => ({
      endpoint: body.text('endpoint', { min: 1, max: 2048 }),
      keys: body.object('keys', keys => ({ p256dh: keys.text('p256dh', { min: 1, max: 100 }), auth: keys.text('auth', { min: 1, max: 40 }) })),
      locale: body.literal('locale', PUSH_LOCALES),
    }))
    return demoUnavailable()
  })),
  http.post('/api/push/unsubscribe', route('session', async ({ request }) => {
    parseBody(await readJson(request), body => body.text('endpoint', { min: 1, max: 2048 }))
    return demoUnavailable()
  })),
]
