/**
 * Notifications of the demo (backend `notifications` and `users.notifications_muted`): what each
 * account was told, read and dismissed during the visit, and the kinds it turned off. Whether an
 * alert holds follows the ledger of the visit (handlers/notifications.ts).
 */
import type { NotificationOut } from '../../api/schema.gen'
import { IdSequence } from '../core/ids'

export type DemoNotificationKind = NotificationOut['kind']

export interface DemoNotification {
  id: number
  accountId: number
  /** The month whose statement is missing (`YYYY-MM`). */
  month: string
  createdAt: string
  readAt: string | null
  dismissedAt: string | null
}

export interface NotificationsState {
  notifications: DemoNotification[]
  /** The kinds each account turned off, by account id. */
  muted: Map<number, Set<DemoNotificationKind>>
  sequence: IdSequence
}

let state: NotificationsState | null = null

/** The notifications of this page load: none at first, like an installation whose statements are up to date. */
export function notificationsStore(): NotificationsState {
  return (state ??= { notifications: [], muted: new Map(), sequence: new IdSequence() })
}

/** Back to the start (tests; a page reload does the same). */
export function resetNotificationsStore(): void {
  state = null
}
