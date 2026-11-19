/**
 * Push notifications on this device (src/juntia/push.py): the browser subscribes with the server's
 * key and the portal registers it for the signed-in account, again every time the portal opens and
 * when the language changes, so the server keeps its language, its session and a subscription made
 * with its current key. The service worker (public/sw.js) shows what arrives. Safari only offers
 * them to the portal added to the Home Screen of an iPhone or iPad (iOS 16.4 and later); the demo
 * never does (its service worker is MSW's).
 */
import { createContext, use, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ApiError, api } from '../api/client'
import type { PushConfigOut, PushSubscriptionIn } from '../api/schema.gen'
import { useI18n, type Language } from '../i18n'

/**
 * Notifications on this device: `demo` · `insecure` (not HTTPS) · `unsupported` (not in this
 * browser) · `install` (an iPhone or iPad in Safari: only the portal added to the Home Screen gets
 * them) · `denied` (blocked in the browser's settings) · `off` · `on`.
 */
export type PushStatus = 'demo' | 'insecure' | 'unsupported' | 'install' | 'denied' | 'off' | 'on'

export interface PushValue {
  status: PushStatus
  /** Turning them on or off. */
  busy: boolean
  /** Asks for permission (call it from a click: Safari only asks then) and registers this device. */
  enable: () => Promise<void>
  disable: () => Promise<void>
}

export const SERVICE_WORKER = '/sw.js'
/** The account that turned them on in this browser (the browser keeps the subscription itself). */
export const PUSH_STORAGE_KEY = 'juntia_push'
const DEMO = import.meta.env.VITE_DEMO === '1'

/** A secure page with service workers, the Push API and notifications. */
export function pushSupported(): boolean {
  return window.isSecureContext && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
}

/** Opened as an installed app (Home Screen, "Install app"), not in a browser tab. */
function isStandalone(): boolean {
  const iosStandalone = (navigator as Navigator & { standalone?: boolean }).standalone === true
  return iosStandalone || window.matchMedia?.('(display-mode: standalone)').matches === true
}

/** An iPhone or iPad (iPadOS calls itself a Mac, one with a touch screen). */
function isAppleMobile(): boolean {
  return /\b(iPhone|iPad|iPod)\b/.test(navigator.userAgent) || (/\bMacintosh\b/.test(navigator.userAgent) && navigator.maxTouchPoints > 1)
}

/** URL-safe base64 (with or without padding) → bytes: the server's key as `applicationServerKey`. */
export function base64UrlBytes(text: string): Uint8Array<ArrayBuffer> {
  const base64 = text.replaceAll('-', '+').replaceAll('_', '/').replace(/=+$/, '')
  const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4))
  return Uint8Array.from(binary, character => character.charCodeAt(0))
}

/** Whether `subscription` was made with `key` (browsers that cannot tell are taken at their word). */
export function subscribedWith(subscription: PushSubscription, key: Uint8Array): boolean {
  const current = subscription.options?.applicationServerKey
  if (!current) return true
  const bytes = new Uint8Array(current)
  return bytes.length === key.length && bytes.every((value, index) => value === key[index])
}

function storedAccount(): string | null {
  try { return localStorage.getItem(PUSH_STORAGE_KEY) }
  catch { return null }
}

function storeAccount(userId: number | null) {
  try {
    if (userId === null) localStorage.removeItem(PUSH_STORAGE_KEY)
    else localStorage.setItem(PUSH_STORAGE_KEY, String(userId))
  } catch { console.warn('Notification preference could not be stored.') }
}

function enabledFor(userId: number | null): boolean {
  return userId !== null && storedAccount() === String(userId)
}

export function initialStatus(userId: number | null): PushStatus {
  if (DEMO) return 'demo'
  if (!window.isSecureContext) return 'insecure'
  if (!pushSupported()) return isAppleMobile() && !isStandalone() ? 'install' : 'unsupported'
  if (Notification.permission === 'denied') return 'denied'
  return Notification.permission === 'granted' && enabledFor(userId) ? 'on' : 'off'
}

function subscriptionBody(subscription: PushSubscription, language: Language): PushSubscriptionIn {
  const keys = subscription.toJSON().keys ?? {}
  return { endpoint: subscription.endpoint, keys: { p256dh: keys.p256dh ?? '', auth: keys.auth ?? '' }, locale: language }
}

async function currentSubscription(): Promise<PushSubscription | null> {
  const registration = await navigator.serviceWorker.getRegistration()
  return (await registration?.pushManager.getSubscription()) ?? null
}

type ServerKey = () => Promise<Uint8Array<ArrayBuffer>>

/** Drops a subscription made with an older key of the server, there and in the browser. */
async function forget(subscription: PushSubscription): Promise<void> {
  await api('/push/unsubscribe', 'POST', { endpoint: subscription.endpoint }).catch(() => undefined)
  await subscription.unsubscribe()
}

/** Asks for permission and subscribes this browser with the server's key; the permission when not granted. */
async function subscribeDevice(serverKey: ServerKey): Promise<PushSubscription | NotificationPermission> {
  // First, while the click is being handled: Safari only asks for permission then.
  const permission = await Notification.requestPermission()
  if (permission !== 'granted') return permission
  await navigator.serviceWorker.register(SERVICE_WORKER)
  const [registration, key] = await Promise.all([navigator.serviceWorker.ready, serverKey()])
  const existing = await registration.pushManager.getSubscription()
  if (existing && subscribedWith(existing, key)) return existing
  if (existing) await forget(existing)
  return registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key })
}

const PushContext = createContext<PushValue | null>(null)

/** The notifications of the signed-in account (`userId`; null: signed out) on this device. */
export function PushProvider({ userId, children }: { userId: number | null; children: ReactNode }) {
  const { language } = useI18n()
  const [state, setState] = useState(() => ({ userId, status: initialStatus(userId) }))
  // Another account signed in, or out: this device's state is the new one's.
  if (state.userId !== userId) setState({ userId, status: initialStatus(userId) })
  const [busy, setBusy] = useState(false)
  const key = useRef<Promise<Uint8Array<ArrayBuffer>> | null>(null)
  const settle = useCallback((next: PushStatus) => setState(current => ({ ...current, status: next })), [])

  const serverKey = useCallback(() => {
    if (!key.current) {
      const request = api<PushConfigOut>('/push').then(({ public_key }) => base64UrlBytes(public_key))
      // A failed request is tried again the next time.
      request.catch(() => {
        if (key.current === request) key.current = null
      })
      key.current = request
    }
    return key.current
  }, [])

  useEffect(() => {
    if (userId === null || DEMO || !pushSupported()) return
    let cancelled = false
    async function refresh() {
      if (Notification.permission !== 'granted' || !enabledFor(userId)) {
        if (!cancelled) settle(Notification.permission === 'denied' ? 'denied' : 'off')
        return
      }
      const registration = await navigator.serviceWorker.register(SERVICE_WORKER)
      let subscription = await registration.pushManager.getSubscription()
      if (subscription) {
        const current = await serverKey()
        if (!subscribedWith(subscription, current)) {
          // The server's key changed (a new AUTH_SECRET): the old subscription no longer works.
          await forget(subscription)
          const ready = await navigator.serviceWorker.ready
          subscription = await ready.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: current }).catch(() => null)
        }
      }
      if (!subscription) {
        storeAccount(null)
        if (!cancelled) settle('off')
        return
      }
      if (!cancelled) settle('on')
      await api('/push/subscription', 'PUT', subscriptionBody(subscription, language))
    }
    refresh().catch((error: unknown) => {
      // Offline, or the server is unreachable: nothing changes, the next opening tries again.
      if (error instanceof ApiError && error.code === 'push_service_unsupported') {
        storeAccount(null)
        if (!cancelled) settle('off')
      }
    })
    return () => { cancelled = true }
  }, [userId, language, serverKey, settle])

  const enable = useCallback(async () => {
    if (userId === null || DEMO || !pushSupported()) return
    setBusy(true)
    try {
      const subscription = await subscribeDevice(serverKey)
      if (typeof subscription === 'string') {
        settle(subscription === 'denied' ? 'denied' : 'off')
        return
      }
      await api('/push/subscription', 'PUT', subscriptionBody(subscription, language))
      storeAccount(userId)
      settle('on')
    } finally {
      setBusy(false)
    }
  }, [userId, language, serverKey, settle])

  const disable = useCallback(async () => {
    if (DEMO || !pushSupported()) return
    setBusy(true)
    try {
      const subscription = await currentSubscription()
      if (subscription) {
        await api('/push/unsubscribe', 'POST', { endpoint: subscription.endpoint })
        await subscription.unsubscribe()
      }
      storeAccount(null)
      settle('off')
    } finally {
      setBusy(false)
    }
  }, [settle])

  const value = useMemo<PushValue>(
    () => ({ status: state.status, busy, enable, disable }), [state.status, busy, enable, disable],
  )
  return <PushContext value={value}>{children}</PushContext>
}

/** The notifications of this device; null outside {@link PushProvider}. */
export function usePush(): PushValue | null {
  return use(PushContext)
}
