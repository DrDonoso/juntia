/**
 * Notifications of the demo (backend `notifications` and `users.notifications_muted`). None are
 * stored: handlers/notifications.ts derives them on every request from the finance and community
 * stores with the backend's rules. This store keeps what cannot be derived: what each account did
 * with them during the visit (read, dismissed), when each alert was first noticed, the id of each
 * notification and the kinds each account turned off.
 */
import type { NotificationOut } from '../../api/schema.gen'
import { nowIso } from '../core/clock'
import { IdSequence } from '../core/ids'

export type DemoNotificationKind = NotificationOut['kind']

/** An account read one of its notifications (by its key), or dismissed it. */
export interface DemoNotificationAct {
  accountId: number
  key: string
  act: 'read' | 'dismiss'
  at: string
}

export interface NotificationsState {
  /** When the page loaded: the news that came more than 3 days before had been read by then. */
  loadedAt: string
  acts: DemoNotificationAct[]
  /** When each account was first told each alert, by `<account>:<key>`. */
  noticed: Map<string, string>
  /** The id of each notification, by `<account>:<key>`: the same during the whole visit. */
  ids: Map<string, number>
  /** The kinds each account turned off, by account id. */
  muted: Map<number, Set<DemoNotificationKind>>
  sequence: IdSequence
}

let state: NotificationsState | null = null

/** What happened to the notifications during this page load: nothing at first. */
export function notificationsStore(): NotificationsState {
  return (state ??= { loadedAt: nowIso(), acts: [], noticed: new Map(), ids: new Map(), muted: new Map(), sequence: new IdSequence() })
}

/** Back to the start (tests; a page reload does the same). */
export function resetNotificationsStore(): void {
  state = null
}
