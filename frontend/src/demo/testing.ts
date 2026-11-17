/**
 * Vitest helpers for the demo API (tests only: nothing in the app imports this module). Requests go
 * straight through the handlers with MSW's `getResponse`, so a test needs no service worker and no
 * network interception.
 *
 * ```ts
 * beforeEach(() => resetDemo({ now: () => new Date(2026, 9, 29, 12) }))
 * await signInAdmin()  // James Okafor, the president, who is also the administrator
 * const { status, body } = await demoRequest('GET', '/api/admin/users')
 * ```
 */
import { getResponse } from 'msw'
import { vi } from 'vitest'
import type { UserAuthOut } from '../api/schema.gen'
import { ADMINISTRATOR_ID, castResident } from './cast'
import { DEMO_PASSWORD } from './config'
import { MUTATION_HEADER, signInResident, signOutResident } from './core'
import { handlers } from './handlers'
import { coreStore } from './store/core'

export interface DemoRequestOptions {
  /** JSON body (sent with `Content-Type: application/json`). */
  body?: unknown
  /** Extra headers; writes carry `X-Juntia-Request: 1` unless `mutationHeader` is false. */
  headers?: Record<string, string>
  mutationHeader?: boolean
}

export interface DemoAnswer<T = unknown> {
  status: number
  /** Parsed JSON, or undefined for an empty body (204). */
  body: T
  headers: Headers
}

/** Absolute URL of an API path on the test page's origin. */
export function demoUrl(path: string): URL {
  return new URL(path, globalThis.location?.origin ?? 'http://localhost')
}

/** Answers a request with the demo handlers (a missing handler throws). */
export async function demoFetch(request: Request): Promise<Response> {
  const response = await getResponse(handlers, request)
  if (!response) throw new Error(`No demo handler answered ${request.method} ${new URL(request.url).pathname}`)
  return response
}

/** Sends a request to the demo API and reads its JSON answer. */
export async function demoRequest<T = unknown>(method: string, path: string, options: DemoRequestOptions = {}): Promise<DemoAnswer<T>> {
  const headers = new Headers(options.headers)
  if (method !== 'GET' && options.mutationHeader !== false) headers.set(MUTATION_HEADER, '1')
  if (options.body !== undefined) headers.set('Content-Type', 'application/json')
  const response = await demoFetch(new Request(demoUrl(path), {
    method, headers, body: options.body === undefined ? undefined : JSON.stringify(options.body),
  }))
  const text = await response.text()
  return { status: response.status, body: (text ? JSON.parse(text) : undefined) as T, headers: response.headers }
}

/** Signs a cast account in with the password `demo` (`POST /api/auth/login`), replacing the session. */
export function signInAs(residentId: number): Promise<DemoAnswer<UserAuthOut>> {
  return demoRequest<UserAuthOut>('POST', '/api/auth/login', { body: { email: castResident(residentId).email, password: DEMO_PASSWORD } })
}

/** Signs in as the administrator of the cast, James Okafor, the president, like "Open administration" does. */
export function signInAdmin(): Promise<DemoAnswer<UserAuthOut>> {
  return signInAs(ADMINISTRATOR_ID)
}

/**
 * Runs `action` signed in as the administrator of the cast, then gives the session back to whoever
 * had it (nobody included): what another browser of an administrator would do meanwhile.
 */
export async function asAdministrator<T>(action: () => Promise<T>): Promise<T> {
  const previous = coreStore().session.residentId
  await signInAdmin()
  try {
    return await action()
  } finally {
    if (previous === null) signOutResident()
    else signInResident(previous)
  }
}

/** Routes the app's own `fetch` calls (api/client.ts) to the demo handlers for this test. */
export function stubFetchWithDemo(): void {
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : demoUrl(String(input))
    return demoFetch(new Request(url, init))
  })
}
