import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cache, signedOut } from '../api/client'
import type { NotificationOut, NotificationPreferenceIn, NotificationsOut, PushSubscriptionIn } from '../api/schema.gen'
import { LoginNoticeProvider } from '../auth'
import { I18nRoot, setLanguage } from '../i18n'
import { Shell } from '../main'
import { NotificationSettings, relativeTime } from './notifications'
import { PUSH_STORAGE_KEY, PushProvider, base64UrlBytes } from './push'

const NOW = new Date('2026-12-01T10:00:00Z')
// The server's VAPID key, and one it had before a new AUTH_SECRET.
const KEY = 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U'
const OLD_KEY = 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM'
const ENDPOINT = 'https://web.push.apple.com/QGuQyavXutnMH'
const defaults = cache.getDefaultOptions()

function alert(id: number, month: string, minutesAgo: number, read = false): NotificationOut {
  return {
    id, kind: 'statement_missing', params: { month }, link: '/admin', read,
    created_at: new Date(NOW.getTime() - minutesAgo * 60_000).toISOString(),
  }
}

/** What the API answers (`/api/notifications`), and the requests it received. */
let state: NotificationsOut
let requests: string[]
let subscriptions: PushSubscriptionIn[]

function respond(next: NotificationsOut) {
  state = { ...next, unread: next.items.filter(item => !item.read).length }
  return Response.json(state)
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  cache.clear()
  // What the tests put in the cache (the session, the community, the features) stays as it is.
  cache.setDefaultOptions({ queries: { retry: false, staleTime: Infinity } })
  state = {
    kinds: [{ kind: 'statement_missing', enabled: true }], today: '2026-12-01', unread: 2,
    items: [alert(2, '2026-11', 5), alert(1, '2026-10', 32 * 24 * 60)],
  }
  requests = []
  subscriptions = []
  vi.stubGlobal('matchMedia', (media: string) => ({ media, matches: false, addEventListener() {}, removeEventListener() {} }))
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    requests.push(`${method} ${input}`)
    const body: unknown = init?.body ? JSON.parse(String(init.body)) : undefined
    const id = Number(/^\/api\/notifications\/(\d+)\//.exec(input)?.[1])
    if (method === 'GET' && input === '/api/notifications') return Response.json(state)
    if (method === 'POST' && input === '/api/notifications/read-all') {
      return respond({ ...state, items: state.items.map(item => ({ ...item, read: true })) })
    }
    if (method === 'POST' && input.endsWith('/read')) {
      return respond({ ...state, items: state.items.map(item => item.id === id ? { ...item, read: true } : item) })
    }
    if (method === 'POST' && input.endsWith('/dismiss')) {
      return respond({ ...state, items: state.items.filter(item => item.id !== id) })
    }
    if (method === 'PATCH' && input === '/api/notifications/preferences') {
      const { kind, enabled } = body as NotificationPreferenceIn
      return respond({ ...state, kinds: state.kinds.map(item => item.kind === kind ? { kind, enabled } : item) })
    }
    if (method === 'GET' && input === '/api/push') return Response.json({ public_key: KEY })
    if (method === 'PUT' && input === '/api/push/subscription') {
      subscriptions.push(body as PushSubscriptionIn)
      return new Response(null, { status: 204 })
    }
    if (method === 'POST' && input === '/api/push/unsubscribe') return new Response(null, { status: 204 })
    throw new Error(`Unexpected request ${method} ${input}`)
  }))
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  cache.clear()
  localStorage.removeItem(PUSH_STORAGE_KEY)
  for (const name of ['serviceWorker', 'standalone', 'userAgent']) Reflect.deleteProperty(navigator, name)
})
afterAll(() => cache.setDefaultOptions(defaults))

function renderShell(administrator = true) {
  cache.setQueryData(['reader-auth'], {
    ...signedOut, authenticated: true, administrator, name: 'Alex Morgan', email: 'alex@example.org',
    user_id: 1, dwelling_id: null, expires_at: '2099-01-01T00:00:00Z',
  })
  cache.setQueryData(['general-settings'], { community_name: 'Maple Court' })
  cache.setQueryData(['features'], { actions: true, coefficient: true, events: true, documents: true, google_login: false })
  return render(<I18nRoot><QueryClientProvider client={cache}><LoginNoticeProvider><MemoryRouter initialEntries={['/']}>
    <Routes><Route element={<Shell />}>
      <Route index element={<p>Overview page</p>} />
      <Route path="admin" element={<p>Import page</p>} />
      <Route path="profile" element={<p>Profile page</p>} />
    </Route></Routes>
  </MemoryRouter></LoginNoticeProvider></QueryClientProvider></I18nRoot>)
}

function renderSettings() {
  return render(<I18nRoot><QueryClientProvider client={cache}><MemoryRouter initialEntries={['/profile#notifications']}>
    <PushProvider userId={7}><NotificationSettings administrator /></PushProvider>
  </MemoryRouter></QueryClientProvider></I18nRoot>)
}

class FakeSubscription {
  readonly options: { applicationServerKey: ArrayBuffer }
  readonly unsubscribe = vi.fn(async () => true)

  constructor(readonly endpoint: string, key: string) {
    this.options = { applicationServerKey: base64UrlBytes(key).buffer }
  }

  toJSON() {
    return { endpoint: this.endpoint, expirationTime: null, keys: { p256dh: 'BBrowserKey', auth: 'AuthSecret' } }
  }
}

/** A secure browser with service workers and the Push API (jsdom has neither). */
function fakeBrowser({ permission = 'default', answer = 'granted', subscribedWith }: {
  permission?: NotificationPermission; answer?: NotificationPermission; subscribedWith?: string
} = {}) {
  const browser = {
    subscription: subscribedWith ? new FakeSubscription(ENDPOINT, subscribedWith) : null as FakeSubscription | null,
    subscribe: vi.fn(async ({ applicationServerKey }: { applicationServerKey: Uint8Array }) => {
      browser.subscription = new FakeSubscription(`${ENDPOINT}-new`, btoa(String.fromCharCode(...applicationServerKey)))
      return browser.subscription
    }),
    register: vi.fn(async () => registration),
  }
  const registration = { pushManager: { getSubscription: async () => browser.subscription, subscribe: browser.subscribe } }
  const notification = {
    permission,
    requestPermission: vi.fn(async () => {
      notification.permission = answer
      return answer
    }),
  }
  vi.stubGlobal('Notification', notification)
  vi.stubGlobal('PushManager', {})
  vi.stubGlobal('isSecureContext', true)
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: { register: browser.register, ready: Promise.resolve(registration), getRegistration: async () => registration },
  })
  return browser
}

describe('the bell', () => {
  it('counts the unread notifications of an administrator and opens, reads and dismisses them', async () => {
    const user = userEvent.setup()
    renderShell()
    const bell = await screen.findByRole('button', { name: 'Notifications: 2 unread' })
    expect(bell).toHaveTextContent('2')
    await user.click(bell)
    const panel = screen.getByRole('dialog', { name: 'Notifications' })
    expect(bell).toHaveAttribute('aria-expanded', 'true')
    expect(within(panel).getByRole('button', { name: 'Mark all as read' })).toHaveFocus()
    expect(within(panel).getAllByRole('link').map(link => link.textContent)).toEqual([
      'Missing statement: November 2026', 'Missing statement: October 2026', 'Notification settings',
    ])
    expect(within(panel).getAllByText('Unread')).toHaveLength(2)
    expect(within(panel).getAllByText('It has not been imported yet: import it in Finances > Import.')).toHaveLength(2)
    expect(within(panel).getByText('5 minutes ago')).toHaveAttribute('datetime', state.items[0].created_at)
    expect(within(panel).getByText('last month')).toBeInTheDocument()

    // A control that disappears leaves the focus in the panel.
    await user.click(within(panel).getByRole('button', { name: 'Mark as read: Missing statement: October 2026' }))
    expect(await screen.findByRole('button', { name: 'Notifications: 1 unread' })).toBeInTheDocument()
    expect(panel).toHaveFocus()
    await user.click(within(panel).getByRole('button', { name: 'Dismiss: Missing statement: October 2026' }))
    await waitFor(() => expect(within(panel).queryByText('Missing statement: October 2026')).toBeNull())
    expect(requests).toEqual(expect.arrayContaining(['POST /api/notifications/1/read', 'POST /api/notifications/1/dismiss']))

    // Escape closes it and gives the focus back to the bell.
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog', { name: 'Notifications' })).toBeNull()
    expect(bell).toHaveFocus()

    // Opening one goes to its page, and it counts as read.
    await user.click(bell)
    await user.click(within(screen.getByRole('dialog', { name: 'Notifications' })).getByRole('link', {
      name: 'Missing statement: November 2026',
    }))
    expect(screen.getByText('Import page')).toBeInTheDocument()
    expect(screen.queryByRole('dialog', { name: 'Notifications' })).toBeNull()
    expect(await screen.findByRole('button', { name: 'Notifications' })).not.toHaveTextContent(/\d/)
    expect(requests).toContain('POST /api/notifications/2/read')
  })

  it('marks every notification as read, caps its count and speaks Spanish', async () => {
    state = { ...state, unread: 12, items: Array.from({ length: 12 }, (_, index) => alert(index + 1, '2026-11', index)) }
    act(() => setLanguage('es'))
    const user = userEvent.setup()
    renderShell()
    const bell = await screen.findByRole('button', { name: 'Notificaciones: 9+ sin leer' })
    expect(bell).toHaveTextContent('9+')
    await user.click(bell)
    const panel = screen.getByRole('dialog', { name: 'Notificaciones' })
    expect(within(panel).getAllByRole('link')[0]).toHaveTextContent('Falta el extracto de noviembre de 2026')
    expect(within(panel).getAllByText('Sin leer')).toHaveLength(12)
    expect(within(panel).getAllByText('Aún no se ha importado: impórtalo en Gastos > Importar.')).toHaveLength(12)
    expect(within(panel).getByText('ahora')).toBeInTheDocument()
    await user.click(within(panel).getByRole('button', { name: 'Marcar todas como leídas' }))
    expect(await screen.findByRole('button', { name: 'Notificaciones' })).not.toHaveTextContent(/\d/)
    expect(within(panel).queryByText('Sin leer')).toBeNull()
  })

  it('tells a neighbor the news of the community, with the days told against the community’s date', async () => {
    const news = (id: number, kind: NotificationOut['kind'], params: Record<string, string>, link: string): NotificationOut => ({
      id, kind, params, link, read: false, created_at: new Date(NOW.getTime() - id * 60_000).toISOString(),
    })
    const meeting = { title: 'Owners’ meeting', day: '2026-12-02', time: '19:00', location: 'Portal' }
    state = {
      kinds: (['accounts_ready', 'action_changes', 'action_comments', 'event_changes', 'event_reminder'] as const)
        .map(kind => ({ kind, enabled: true })),
      today: '2026-12-01', unread: 8,
      items: [
        news(1, 'event_reminder', meeting, '/events/4'),
        news(2, 'event_reminder', { title: 'Lift inspection', day: '2026-12-01', time: '10:00', location: '' }, '/events/6'),
        news(3, 'event_changes', { title: 'Cleaning day', day: '2027-01-15', time: '', location: '', change: 'created' }, '/events/5'),
        news(4, 'event_changes', { ...meeting, change: 'cancelled' }, '/events/4'),
        news(5, 'action_comments', { title: 'Leak in the garage', comments: '2', attachments: '1', author: 'Ana' }, '/actions/7'),
        news(6, 'action_comments', { title: 'Broken gate', comments: '1', attachments: '0', author: 'Ana' }, '/actions/8'),
        news(7, 'action_changes', { title: 'Leak in the garage', status: 'voting', change: 'created' }, '/actions/7'),
        news(8, 'accounts_ready', { month: '2026-11' }, '/?start=2026-11-01&end=2026-11-30'),
      ],
    }
    const user = userEvent.setup()
    renderShell(false)
    await user.click(await screen.findByRole('button', { name: 'Notifications: 8 unread' }))
    const panel = screen.getByRole('dialog', { name: 'Notifications' })
    const texts = () => within(panel).getAllByRole('listitem').map(item => [
      within(item).getByRole('link').textContent, item.querySelector('.notification-body')?.textContent,
    ])
    expect(texts()).toEqual([
      ['Tomorrow: Owners’ meeting', 'Wednesday 2 December, 19:00 · Portal'],
      ['Today: Lift inspection', 'Tuesday 1 December, 10:00'],
      ['New event: Cleaning day', 'Friday 15 January 2027'],
      ['Event cancelled: Owners’ meeting', 'Wednesday 2 December, 19:00 · Portal'],
      ['Leak in the garage', '2 new comments and 1 new PDF'],
      ['Broken gate', 'New comment by Ana'],
      ['New action: Leak in the garage', 'Status: Voting'],
      ['The accounts of November 2026 are ready', "See the month's income and expenses in Finances > Overview."],
    ])
    expect(within(panel).getByRole('link', { name: 'Broken gate' })).toHaveAttribute('href', '/actions/8')
    act(() => setLanguage('es'))
    expect(texts()).toEqual([
      ['Mañana: Owners’ meeting', 'Miércoles 2 de diciembre, 19:00 · Portal'],
      ['Hoy: Lift inspection', 'Martes 1 de diciembre, 10:00'],
      ['Nuevo evento: Cleaning day', 'Viernes 15 de enero de 2027'],
      ['Evento cancelado: Owners’ meeting', 'Miércoles 2 de diciembre, 19:00 · Portal'],
      ['Leak in the garage', '2 comentarios y 1 PDF nuevos'],
      ['Broken gate', 'Nuevo comentario de Ana'],
      ['Nueva actuación: Leak in the garage', 'Estado: En votación'],
      ['Ya están las cuentas de noviembre de 2026', 'Consulta los ingresos y gastos del mes en Gastos > Resumen.'],
    ])
  })

  it('is not shown to an account that receives no notifications', async () => {
    state = { kinds: [], today: '2026-12-01', unread: 0, items: [] }
    renderShell(false)
    await waitFor(() => expect(requests).toContain('GET /api/notifications'))
    expect(screen.queryByRole('button', { name: /^Notifications/ })).toBeNull()
  })

  it('offers to turn them on for this device', async () => {
    fakeBrowser()
    const user = userEvent.setup()
    renderShell()
    await user.click(await screen.findByRole('button', { name: 'Notifications: 2 unread' }))
    await user.click(screen.getByRole('button', { name: 'Turn on for this device' }))
    await waitFor(() => expect(subscriptions).toEqual([
      { endpoint: expect.stringContaining(ENDPOINT), keys: { p256dh: 'BBrowserKey', auth: 'AuthSecret' }, locale: 'en' },
    ]))
    expect(screen.queryByRole('button', { name: 'Turn on for this device' })).toBeNull()
    expect(localStorage.getItem(PUSH_STORAGE_KEY)).toBe('1')
  })
})

describe('the notification settings', () => {
  it('turn each kind on and off', async () => {
    const user = userEvent.setup()
    renderSettings()
    const kind = await screen.findByRole('switch', { name: 'Missing bank statement' })
    expect(screen.getByRole('heading', { name: 'Notifications' })).toHaveFocus()
    expect(kind).toBeChecked()
    expect(kind).toHaveAccessibleDescription("From the first day of each month, while the previous month's statement has not been imported.")
    await user.click(kind)
    await waitFor(() => expect(kind).not.toBeChecked())
    expect(kind).toHaveTextContent('Off')
    expect(requests).toContain('PATCH /api/notifications/preferences')
  })

  it('turn them on and off on this device', async () => {
    const browser = fakeBrowser()
    const user = userEvent.setup()
    renderSettings()
    const device = await screen.findByRole('switch', { name: 'Notifications on this device' })
    expect(device).not.toBeChecked()
    await user.click(device)
    await waitFor(() => expect(device).toBeChecked())
    expect(browser.register).toHaveBeenCalledWith('/sw.js')
    expect(subscriptions).toHaveLength(1)
    expect(localStorage.getItem(PUSH_STORAGE_KEY)).toBe('7')
    await user.click(device)
    await waitFor(() => expect(device).not.toBeChecked())
    expect(browser.subscription?.unsubscribe).toHaveBeenCalled()
    expect(requests).toContain('POST /api/push/unsubscribe')
    expect(localStorage.getItem(PUSH_STORAGE_KEY)).toBeNull()
  })

  it('register this device again when the portal opens, with the server’s current key', async () => {
    localStorage.setItem(PUSH_STORAGE_KEY, '7')
    const browser = fakeBrowser({ permission: 'granted', subscribedWith: OLD_KEY })
    const old = browser.subscription
    renderSettings()
    expect(await screen.findByRole('switch', { name: 'Notifications on this device' })).toBeChecked()
    await waitFor(() => expect(subscriptions).toHaveLength(1))
    expect(old?.unsubscribe).toHaveBeenCalled()
    expect(browser.subscribe).toHaveBeenCalledTimes(1)
    expect(subscriptions[0].endpoint).toBe(`${ENDPOINT}-new`)
  })

  it('say why this device cannot have them', async () => {
    fakeBrowser({ permission: 'denied' })
    renderSettings()
    expect(await screen.findByText(/^Notifications are blocked for this site/)).toBeInTheDocument()
    expect(screen.queryByRole('switch', { name: 'Notifications on this device' })).toBeNull()
    cleanup()

    vi.unstubAllGlobals()
    vi.stubGlobal('isSecureContext', false)
    renderSettings()
    expect(await screen.findByText('Notifications need the portal to be opened over HTTPS.')).toBeInTheDocument()
    cleanup()

    vi.stubGlobal('isSecureContext', true)
    Object.defineProperty(navigator, 'userAgent', { configurable: true, value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_4 like Mac OS X)' })
    renderSettings()
    expect(await screen.findByText(/^On an iPhone or iPad, first add the portal to the Home Screen/)).toBeInTheDocument()
  })
})

describe('relative times', () => {
  it('follow the active language', () => {
    const ago = (seconds: number) => relativeTime(new Date(NOW.getTime() - seconds * 1000).toISOString(), NOW.getTime())
    expect([ago(20), ago(5 * 60), ago(2 * 3600), ago(26 * 3600), ago(8 * 86_400), ago(400 * 86_400)]).toEqual([
      'now', '5 minutes ago', '2 hours ago', 'yesterday', 'last week', 'last year',
    ])
    act(() => setLanguage('es'))
    expect([ago(2 * 3600), ago(26 * 3600)]).toEqual(['hace 2 horas', 'ayer'])
  })
})
