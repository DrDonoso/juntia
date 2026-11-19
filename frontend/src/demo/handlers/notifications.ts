/**
 * Notifications in the demo (after src/juntia/notifications.py and push.py). Administrators are told
 * when the statement of the previous month is missing: the ledger has movements from before that
 * month and none in it. The demo's statements reach three days before today, so nothing is missing
 * at first; removing the latest statements in Manage statements brings the alert, and importing the
 * statement again resolves it. Reading, dismissing and choosing the kinds work like on a real server
 * until the page is reloaded. The alerts are brought up to date on every request, as the server's
 * notifier does every minute.
 *
 * The demo has no push service, and its service worker is MSW's: registering a device for push
 * notifications answers 403 `demo_unavailable` (`UNAVAILABLE_IN_DEMO`).
 */
import type { NotificationsOut } from '../../api/schema.gen'
import {
  DemoApiError, addMonths, demoUnavailable, http, idParam, nowIso, parseBody, readJson, route, startOfMonth, today,
  type HttpHandler,
} from '../core'
import type { DemoResident } from '../store/core'
import { financeStore } from '../store/finance'
import { notificationsStore, type DemoNotification, type DemoNotificationKind } from '../store/notifications'

const KINDS: readonly DemoNotificationKind[] = ['statement_missing']
/** The most notifications listed (backend `MAX_LISTED`). */
const MAX_LISTED = 50

/** The kinds an account can receive: the administrators', so far. */
function available(user: DemoResident): DemoNotificationKind[] {
  return user.administrator ? [...KINDS] : []
}

function muted(user: DemoResident): Set<DemoNotificationKind> {
  return notificationsStore().muted.get(user.id) ?? new Set()
}

/** Those of `months` (`YYYY-MM`) whose statement is missing: movements before the month, and none in it. */
function missingMonths(months: Iterable<string>): Set<string> {
  const days = [...financeStore().transactions.values()].map(transaction => transaction.bookingDate)
  if (days.length === 0) return new Set()
  const earliest = days.reduce((first, day) => day < first ? day : first)
  const booked = new Set(days.map(day => day.slice(0, 7)))
  return new Set([...months].filter(month => earliest < `${month}-01` && !booked.has(month)))
}

/**
 * The account's alerts brought up to date (the one of the previous month created when it is
 * missing), those that hold and are neither dismissed nor of a kind turned off, newest first.
 */
function shown(user: DemoResident): DemoNotification[] {
  if (!user.administrator) return []
  const store = notificationsStore()
  const month = addMonths(startOfMonth(today()), -1).slice(0, 7)
  const own = () => store.notifications.filter(item => item.accountId === user.id)
  if (missingMonths([month]).has(month) && !own().some(item => item.month === month)) {
    store.notifications.push({
      id: store.sequence.next(), accountId: user.id, month, createdAt: nowIso(), readAt: null, dismissedAt: null,
    })
  }
  if (muted(user).has('statement_missing')) return []
  const holding = missingMonths(own().map(item => item.month))
  return own()
    .filter(item => item.dismissedAt === null && holding.has(item.month))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id - left.id)
}

function notificationsOut(user: DemoResident): NotificationsOut {
  const items = shown(user)
  const off = muted(user)
  return {
    kinds: available(user).map(kind => ({ kind, enabled: !off.has(kind) })),
    unread: items.filter(item => item.readAt === null).length,
    items: items.slice(0, MAX_LISTED).map(item => ({
      id: item.id, kind: 'statement_missing', params: { month: item.month }, link: '/admin', created_at: item.createdAt,
      read: item.readAt !== null,
    })),
  }
}

/** One of the account's notifications (404 `notification_not_found` for anyone else's). */
function owned(user: DemoResident, id: number): DemoNotification {
  const item = notificationsStore().notifications.find(notification => notification.id === id && notification.accountId === user.id)
  if (!item) throw new DemoApiError('notification_not_found', 404)
  return item
}

const PUSH_LOCALES = ['en', 'es'] as const

export const notificationHandlers: HttpHandler[] = [
  http.get('/api/notifications', route('session', ({ user }) => notificationsOut(user))),
  http.post('/api/notifications/read-all', route('session', ({ user }) => {
    const now = nowIso()
    for (const item of shown(user)) item.readAt ??= now
    return notificationsOut(user)
  })),
  http.post('/api/notifications/:notificationId/read', route('session', ({ params, user }) => {
    owned(user, idParam(params, 'notificationId')).readAt ??= nowIso()
    return notificationsOut(user)
  })),
  http.post('/api/notifications/:notificationId/dismiss', route('session', ({ params, user }) => {
    const item = owned(user, idParam(params, 'notificationId'))
    const now = nowIso()
    item.readAt ??= now
    item.dismissedAt ??= now
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
