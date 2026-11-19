/**
 * public/sw.js, run with a stand-in for the worker's global scope: it shows the declarative
 * messages of the server (src/juntia/push.py) where the browser does not, and opens their page.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'

// The path stays a parameter: Vite rewrites `new URL(<literal>, import.meta.url)` into an asset URL.
const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const SOURCE = read('../../public/sw.js')
const ORIGIN = 'https://juntia.example.org'

interface FakeWindow {
  focus: () => Promise<unknown>
  navigate: (url: string) => Promise<unknown>
}

type Listener = (event: Record<string, unknown>) => void

function loadWorker(windows: FakeWindow[] = []) {
  const listeners = new Map<string, Listener>()
  const scope = {
    location: { origin: ORIGIN },
    registration: { showNotification: vi.fn(() => Promise.resolve()) },
    clients: { claim: vi.fn(() => Promise.resolve()), matchAll: vi.fn(async () => windows), openWindow: vi.fn(async () => null) },
    skipWaiting: vi.fn(),
    addEventListener: (type: string, listener: Listener) => listeners.set(type, listener),
  }
  // The worker's script reads its global scope as `self`.
  const run = new Function('self', SOURCE) as (self: typeof scope) => void
  run(scope)

  async function dispatch(type: string, event: Record<string, unknown> = {}) {
    const pending: Promise<unknown>[] = []
    listeners.get(type)?.({ ...event, waitUntil: (promise: Promise<unknown>) => pending.push(promise) })
    await Promise.all(pending)
  }
  return { scope, dispatch }
}

const pushOf = (message: unknown) => ({ data: { json: () => message } })

describe('the service worker', () => {
  it('takes over at once', async () => {
    const { scope, dispatch } = loadWorker()
    await dispatch('install')
    await dispatch('activate')
    expect(scope.skipWaiting).toHaveBeenCalled()
    expect(scope.clients.claim).toHaveBeenCalled()
  })

  it('shows a declarative message', async () => {
    const { scope, dispatch } = loadWorker()
    const notification = {
      title: 'Missing statement: November 2026',
      body: 'It has not been imported yet: import it in Finances > Import.',
      lang: 'en',
      dir: 'ltr',
      navigate: `${ORIGIN}/admin`,
      tag: 'statement_missing:2026-11',
      silent: false,
      icon: `${ORIGIN}/icons/icon-192.png`,
      badge: `${ORIGIN}/icons/badge-96.png`,
    }
    await dispatch('push', pushOf({ web_push: 8030, notification }))
    const { title, navigate, ...options } = notification
    expect(scope.registration.showNotification).toHaveBeenCalledWith(title, { ...options, data: { navigate } })
  })

  it('shows something for any other message (browsers revoke silent subscriptions)', async () => {
    const { scope, dispatch } = loadWorker()
    await dispatch('push', { data: { json: () => JSON.parse('not json') } })
    await dispatch('push', pushOf({ notification: { title: 'Not declarative', navigate: '/' } }))
    await dispatch('push', { data: null })
    expect(scope.registration.showNotification.mock.calls).toEqual([
      ['Juntia', { data: { navigate: '/' } }],
      ['Juntia', { data: { navigate: '/' } }],
      ['Juntia', { data: { navigate: '/' } }],
    ])
  })

  it('opens the page of a tapped notification in a window of the portal, or in a new one', async () => {
    const page = `${ORIGIN}/admin`
    const open: FakeWindow = { focus: vi.fn(async () => open), navigate: vi.fn(async () => open) }
    const tap = (navigate: string) => ({ notification: { close: vi.fn(), data: { navigate } } })

    let worker = loadWorker([open])
    const event = tap(page)
    await worker.dispatch('notificationclick', event)
    expect(event.notification.close).toHaveBeenCalled()
    expect(open.focus).toHaveBeenCalled()
    expect(open.navigate).toHaveBeenCalledWith(page)
    expect(worker.scope.clients.openWindow).not.toHaveBeenCalled()

    worker = loadWorker()
    await worker.dispatch('notificationclick', tap(page))
    expect(worker.scope.clients.openWindow).toHaveBeenCalledWith(page)

    // Never a page of another site.
    worker = loadWorker([open])
    await worker.dispatch('notificationclick', tap('https://elsewhere.example/'))
    expect(worker.scope.clients.openWindow).not.toHaveBeenCalled()
    expect(open.navigate).toHaveBeenCalledTimes(1)
  })
})
