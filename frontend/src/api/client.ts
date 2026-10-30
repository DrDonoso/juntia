import { QueryClient } from '@tanstack/react-query'
import { hasMessage, t, type Dictionary } from '../i18n'
import type { FeatureFlagsOut, UserAuthOut } from './schema.gen'

export const cache = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 30_000 } },
})

export const signedOut: UserAuthOut = {
  authenticated: false, kind: null, name: null, email: null, user_id: null,
  dwelling_id: null, expires_at: null,
}
let identityGeneration = 0
let eventGeneration = 0

export async function refreshEventData(enabled: boolean) {
  const generation = ++eventGeneration
  await cache.cancelQueries({ queryKey: ['events'] })
  if (generation !== eventGeneration) return
  if (enabled) await cache.invalidateQueries({ queryKey: ['events'] })
  else cache.removeQueries({ queryKey: ['events'] })
}

export async function clearPrivateData(includeAuth = false) {
  identityGeneration += 1
  const predicate = (query: { queryKey: readonly unknown[] }) =>
    !['auth', 'reader-auth', 'general-settings', 'features'].includes(String(query.queryKey[0]))
  await cache.cancelQueries({ predicate: includeAuth ? query => !['general-settings', 'features'].includes(String(query.queryKey[0])) : predicate })
  cache.removeQueries({ predicate })
}

type ErrorCode = keyof Dictionary['errors']['codes']

function isErrorCode(code: string): code is ErrorCode {
  return hasMessage(`errors.codes.${code}`)
}

function apiErrorText(code: string, status: number): string {
  return isErrorCode(code) ? t(`errors.codes.${code}`) : t('errors.requestFailed', { status })
}

export class ApiError extends Error {
  constructor(public code: string, public status: number, public fields: Record<string, string> = {}) {
    super(apiErrorText(code, status))
    this.name = 'ApiError'
  }
}

/** User-facing message for any thrown value; API errors follow the active language. */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return apiErrorText(error.code, error.status)
  return error instanceof Error ? error.message : t('errors.generic')
}

export function codeMessage(code: string): string {
  return isErrorCode(code) ? t(`errors.codes.${code}`) : t('errors.generic')
}

function checkIdentity(generation: number, identityBound: boolean) {
  if (identityBound && generation !== identityGeneration) throw new ApiError('session_changed', 409)
}

function checkEventGeneration(generation: number | null) {
  if (generation !== null && generation !== eventGeneration) throw new ApiError('event_features_changed', 409)
}

async function request(path: string, method: string, body?: unknown, signal?: AbortSignal) {
  const generation = identityGeneration
  // A feature change must not turn an acknowledged write into an apparent failed save.
  const eventRevision = method === 'GET' && /^\/events(?:\/|\?|$)/.test(path) ? eventGeneration : null
  const privateRequest = path.startsWith('/auth/profile') || path === '/auth/google/link'
    || !path.startsWith('/auth/') && !path.startsWith('/admin/auth/')
      && path !== '/settings/general' && path !== '/version' && path !== '/features'
  const identityBound = privateRequest || path.endsWith('/auth/session')
  const multipart = body instanceof FormData
  const options: RequestInit = {
    method, credentials: 'same-origin', ...(signal ? { signal } : {}),
    headers: method === 'GET' ? {} : {
      'X-Juntia-Request': '1',
      ...(multipart ? {} : { 'Content-Type': 'application/json' }),
    },
  }
  if (body !== undefined) {
    if (method === 'GET') throw new Error('A GET request cannot send a body.')
    options.body = multipart ? body : JSON.stringify(body)
  }
  const response = await fetch(`/api${path}`, options)
  checkIdentity(generation, identityBound)
  checkEventGeneration(eventRevision)
  if (!response.ok) {
    if (response.status === 401 && !path.endsWith('/login')) {
      await clearPrivateData(true)
      if (path.startsWith('/admin/')) {
        cache.setQueryData(['auth'], { authenticated: false, username: null })
        if (cache.getQueryData<UserAuthOut>(['reader-auth'])?.kind === 'administrator') {
          cache.setQueryData(['reader-auth'], signedOut)
        }
      } else {
        cache.setQueryData(['auth'], { authenticated: false, username: null })
        cache.setQueryData(['reader-auth'], signedOut)
      }
    }
    const payload: unknown = await response.json().catch(() => null)
    const code = payload && typeof payload === 'object' && 'code' in payload
      && typeof payload.code === 'string' ? payload.code : ''
    if (code === 'actions_disabled') {
      cache.setQueryData<FeatureFlagsOut>(['features'], previous => previous ? { ...previous, actions: false } : previous)
      await cache.cancelQueries({ queryKey: ['actions'] })
      cache.removeQueries({ queryKey: ['actions'] })
      await refreshEventData(cache.getQueryData<FeatureFlagsOut>(['features'])?.events === true)
    }
    if (code === 'events_disabled') {
      cache.setQueryData<FeatureFlagsOut>(['features'], previous => previous ? { ...previous, events: false } : previous)
      await refreshEventData(false)
    }
    const fields = payload && typeof payload === 'object' && 'fields' in payload
      && payload.fields !== null && typeof payload.fields === 'object' && !Array.isArray(payload.fields)
      ? Object.fromEntries(Object.entries(payload.fields).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
      : {}
    throw new ApiError(code, response.status, fields)
  }
  return { response, generation, identityBound, eventRevision }
}

export function api<T>(path: string, method?: string, body?: unknown, signal?: AbortSignal): Promise<T>
export async function api(path: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<unknown> {
  const { response, generation, identityBound, eventRevision } = await request(path, method, body, signal)
  const result = response.status === 204 ? undefined : await response.json()
  checkIdentity(generation, identityBound)
  checkEventGeneration(eventRevision)
  return result
}

export async function downloadFile(path: string, filename: string): Promise<void> {
  const { response, generation, identityBound, eventRevision } = await request(path, 'GET')
  const content = await response.blob()
  checkIdentity(generation, identityBound)
  checkEventGeneration(eventRevision)
  const url = URL.createObjectURL(content)
  const link = document.createElement('a')
  try {
    link.href = url
    link.download = filename
    document.body.append(link)
    link.click()
  } finally {
    link.remove()
    URL.revokeObjectURL(url)
  }
}
