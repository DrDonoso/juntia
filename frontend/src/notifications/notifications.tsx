/**
 * Notifications (src/juntia/notifications.py): the bell in the top bar with the account's alerts,
 * and their settings in My profile. Both show only to accounts that can receive some kind
 * (administrators, so far). Push notifications on each device: ./push.tsx.
 */
import { useEffect, useId, useRef, type RefObject } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, useLocation } from 'react-router'
import { api, cache } from '../api/client'
import type { NotificationOut, NotificationsOut } from '../api/schema.gen'
import { Icon } from '../icons'
import { dateTimeFormat, relativeTimeFormat, useI18n, type Translate } from '../i18n'
import { useAction } from '../shared'
import { usePush, type PushStatus } from './push'
import './notifications.css'

/** How often the bell asks again while the account can receive some kind. */
export const POLL_MS = 60_000

/** The account's role decides which kinds it receives: a new role asks again. */
export function notificationsKey(administrator: boolean) {
  return ['notifications', administrator] as const
}

export function useNotifications(administrator: boolean, enabled = true) {
  return useQuery({
    queryKey: notificationsKey(administrator),
    queryFn: ({ signal }) => api<NotificationsOut>('/notifications', 'GET', undefined, signal),
    enabled,
    refetchInterval: query => query.state.data?.kinds.length ? POLL_MS : false,
    refetchOnWindowFocus: query => query.state.data?.kinds.length ? 'always' : false,
  })
}

/** A change of the account's notifications, shown at once with the server's answer: whether it was saved. */
function useNotificationChange(administrator: boolean) {
  const action = useAction(false)
  async function change(path: string, method = 'POST', body?: unknown): Promise<boolean> {
    let saved = false
    await action.run(async () => {
      cache.setQueryData(notificationsKey(administrator), await api<NotificationsOut>(path, method, body))
      saved = true
    })
    return saved
  }
  return { ...action, change }
}

/** `2026-11` → "November 2026" / "noviembre de 2026". */
function monthName(month: string | undefined): string {
  if (!month || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return month ?? ''
  return dateTimeFormat({ month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${month}-01T00:00:00Z`))
}

type Texts = { title: string; body: string }

const TEXTS: { [K in NotificationOut['kind']]: (item: NotificationOut, t: Translate) => Texts } = {
  statement_missing: (item, t) => ({
    title: t('notifications.kinds.statement_missing.title', { month: monthName(item.params.month) }),
    body: t('notifications.kinds.statement_missing.body'),
  }),
}

const UNITS: readonly [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 86_400], ['month', 30 * 86_400], ['week', 7 * 86_400], ['day', 86_400], ['hour', 3_600], ['minute', 60],
]

/** "5 minutes ago", "yesterday", "3 weeks ago"… in the active language. */
export function relativeTime(value: string, now = Date.now()): string {
  const seconds = (new Date(value).getTime() - now) / 1000
  const format = relativeTimeFormat({ numeric: 'auto' })
  for (const [unit, size] of UNITS) {
    if (Math.abs(seconds) >= size) return format.format(Math.round(seconds / size), unit)
  }
  return format.format(0, 'second')
}

/** The bell and its panel, which the shell opens and closes like its other menus. */
export type NotificationsPanel = {
  open: boolean; setOpen: (open: boolean) => void
  panel: RefObject<HTMLElement | null>; trigger: RefObject<HTMLButtonElement | null>
}

function NotificationItem({ item, busy, change, leave }: {
  item: NotificationOut
  busy: boolean
  change: (path: string) => void
  /** Its link was followed. */
  leave: () => void
}) {
  const { t } = useI18n()
  const { title, body } = TEXTS[item.kind](item, t)
  const markRead = t('notifications.markRead', { title })
  const dismiss = t('notifications.dismiss', { title })
  return <li className={item.read ? 'notification-item' : 'notification-item notification-unread'}>
    <span className="notification-icon" aria-hidden="true"><Icon name="alert" size={18} /></span>
    <div className="notification-text">
      {!item.read && <span className="sr-only">{t('notifications.unread')}</span>}
      <Link className="notification-title" to={item.link} onClick={leave}>{title}</Link>
      <p className="notification-body">{body}</p>
      <time className="notification-time" dateTime={item.created_at}
        title={dateTimeFormat({ dateStyle: 'long', timeStyle: 'short' }).format(new Date(item.created_at))}>
        {relativeTime(item.created_at)}
      </time>
    </div>
    <div className="notification-item-actions">
      {!item.read && <button type="button" className="quiet icon-button" title={markRead} aria-label={markRead} disabled={busy}
        onClick={() => change(`/notifications/${item.id}/read`)}><Icon name="check" size={16} /></button>}
      <button type="button" className="quiet icon-button" title={dismiss} aria-label={dismiss} disabled={busy}
        onClick={() => change(`/notifications/${item.id}/dismiss`)}><Icon name="close" size={16} /></button>
    </div>
  </li>
}

/**
 * The bell in the top bar of the accounts that can receive notifications, with how many are unread,
 * and their panel: open one (it counts as read), mark them as read, dismiss them, and go to their
 * settings or turn them on for this device.
 */
export function NotificationBell({ administrator, panel }: { administrator: boolean; panel: NotificationsPanel }) {
  const { t } = useI18n()
  const panelId = useId(), titleId = useId()
  const query = useNotifications(administrator)
  const action = useNotificationChange(administrator)
  const push = usePush()
  const value = query.data
  // A control a change removes takes the focus with it: once the change shows, it goes to the panel.
  const keepFocus = useRef(false)
  useEffect(() => {
    if (!keepFocus.current) return
    keepFocus.current = false
    const element = panel.panel.current
    if (element && !element.contains(document.activeElement)) element.focus()
  }, [value, panel.panel])
  if (!value || value.kinds.length === 0) return null
  const { open, setOpen } = panel
  const unread = value.unread
  const label = unread > 0 ? t('notifications.bellUnread', { count: unread }) : t('notifications.title')
  function change(path: string) {
    keepFocus.current = true
    void action.change(path).then(saved => { if (!saved) keepFocus.current = false })
  }
  /** Following a link closes the panel and takes the focus to the page, as the user menu does. */
  function close() {
    setOpen(false)
    document.getElementById('content')?.focus()
  }
  function leave(item: NotificationOut) {
    close()
    if (!item.read) {
      api<NotificationsOut>(`/notifications/${item.id}/read`, 'POST').then(
        next => cache.setQueryData(notificationsKey(administrator), next), () => undefined,
      )
    }
  }
  return <div className="notification-controls">
    <button ref={panel.trigger} type="button" className="quiet icon-button notification-button" title={t('notifications.title')}
      aria-label={label} aria-expanded={open} aria-controls={open ? panelId : undefined} onClick={() => setOpen(!open)}>
      <Icon name="bell" />
      {unread > 0 && <span className="notification-badge" aria-hidden="true">{unread > 9 ? '9+' : unread}</span>}
    </button>
    {open && <section ref={panel.panel} id={panelId} className="notification-panel" role="dialog" aria-labelledby={titleId} tabIndex={-1}>
      <div className="notification-panel-header">
        <h2 id={titleId}>{t('notifications.title')}</h2>
        {unread > 0 && <button type="button" className="quiet notification-read-all" disabled={action.busy}
          onClick={() => change('/notifications/read-all')}>{t('notifications.markAllRead')}</button>}
      </div>
      {action.notice}
      {value.items.length > 0
        ? <ul className="notification-list">
          {value.items.map(item => <NotificationItem key={item.id} item={item} busy={action.busy} change={change} leave={() => leave(item)} />)}
        </ul>
        : <p className="notification-empty"><Icon name="bell" size={28} />{t('notifications.empty')}</p>}
      <div className="notification-panel-footer">
        <Link to="/profile#notifications" onClick={close}>{t('notifications.settingsLink')}</Link>
        {push?.status === 'off' && <button type="button" className="secondary" disabled={push.busy || action.busy}
          onClick={() => void action.run(push.enable)}>{t('notifications.enableHere')}</button>}
      </div>
    </section>}
  </div>
}

const UNAVAILABLE: readonly PushStatus[] = ['demo', 'insecure', 'unsupported', 'install', 'denied']

/** Notifications on this device: a switch, or why this device cannot have them. */
function DeviceSetting() {
  const { t } = useI18n()
  const id = useId()
  const push = usePush()
  const action = useAction(false)
  const status = push?.status ?? 'unsupported'
  if (!push || UNAVAILABLE.includes(status)) {
    return <div className="notification-setting">
      <div><span className="notification-setting-label">{t('notifications.settings.device')}</span>
        <p className="muted">{t(`notifications.settings.unavailable.${status as Exclude<PushStatus, 'on' | 'off'>}`)}</p></div>
    </div>
  }
  const on = status === 'on'
  const busy = push.busy || action.busy
  return <div className="notification-setting">
    <div><span id={`${id}-label`} className="notification-setting-label">{t('notifications.settings.device')}</span>
      <p id={`${id}-description`} className="muted">{on ? t('notifications.settings.deviceOn') : t('notifications.settings.deviceOff')}</p></div>
    <button type="button" role="switch" className={on ? '' : 'secondary'} aria-checked={on}
      aria-labelledby={`${id}-label`} aria-describedby={`${id}-description`} disabled={busy}
      onClick={() => void action.run(on ? push.disable : push.enable)}>
      <Icon name={on ? 'check' : 'close'} />{busy ? t('notifications.settings.working') : on ? t('notifications.settings.on') : t('notifications.settings.off')}
    </button>
    {action.notice}
  </div>
}

/** The Notifications card of My profile (`/profile#notifications`): this device, and the kinds wanted. */
export function NotificationSettings({ administrator }: { administrator: boolean }) {
  const { t } = useI18n()
  const id = useId()
  const { hash } = useLocation()
  const heading = useRef<HTMLHeadingElement>(null)
  const query = useNotifications(administrator)
  const action = useNotificationChange(administrator)
  const ready = (query.data?.kinds.length ?? 0) > 0
  useEffect(() => {
    if (!ready || hash !== '#notifications') return
    heading.current?.scrollIntoView?.({ block: 'start' })
    heading.current?.focus()
  }, [ready, hash])
  if (!query.data || !ready) return null
  return <section id="notifications" className="card notification-settings" aria-labelledby={`${id}-title`}>
    <h2 ref={heading} id={`${id}-title`} tabIndex={-1}>{t('notifications.settings.title')}</h2>
    <p className="muted">{t('notifications.settings.intro')}</p>
    <DeviceSetting />
    <h3>{t('notifications.settings.kinds')}</h3>
    <ul className="notification-kinds">
      {query.data.kinds.map(({ kind, enabled }) => <li key={kind} className="notification-setting">
        <div><span id={`${id}-${kind}`} className="notification-setting-label">{t(`notifications.kinds.${kind}.label`)}</span>
          <p id={`${id}-${kind}-description`} className="muted">{t(`notifications.kinds.${kind}.description`)}</p></div>
        <button type="button" role="switch" className={enabled ? '' : 'secondary'} aria-checked={enabled}
          aria-labelledby={`${id}-${kind}`} aria-describedby={`${id}-${kind}-description`} disabled={action.busy}
          onClick={() => void action.change('/notifications/preferences', 'PATCH', { kind, enabled: !enabled })}>
          <Icon name={enabled ? 'check' : 'close'} />{enabled ? t('notifications.settings.on') : t('notifications.settings.off')}
        </button>
      </li>)}
    </ul>
    {action.notice}
  </section>
}
