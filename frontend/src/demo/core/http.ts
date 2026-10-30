/**
 * Helpers to answer like the backend: JSON bodies, the error format of src/juntia/errors.py, the
 * request pipeline of src/juntia/middleware.py (`route`) and FastAPI's parameter validation.
 */
import { HttpResponse, type JsonBodyType, type PathParams } from 'msw'
import { coreStore } from '../store/core'
import { isDay } from './clock'
import { DEMO_UNAVAILABLE, DEMO_UNAVAILABLE_STATUS, DemoApiError } from './errors'
import { readerIdentity, requireAdmin, requireAnySession, requireResident, type Identity } from './session'
import { MAX_ID } from './validation'

/** Header every write must carry (the backend answers 403 `invalid_origin` without it). */
export const MUTATION_HEADER = 'X-Juntia-Request'

/** Largest `page` query value the backend accepts. */
export const MAX_PAGE = 1_000_000

/** `{"code", "fields"?}` with the error's status, like the backend's `AppError` handler. */
export function errorResponse(error: DemoApiError): Response {
  return HttpResponse.json(error.payload, { status: error.status })
}

/** Answer for features that need real infrastructure (email, Google, AI, real PDF parsing). */
export function demoUnavailable(): Response {
  return errorResponse(new DemoApiError(DEMO_UNAVAILABLE, DEMO_UNAVAILABLE_STATUS))
}

/**
 * Who may call a route, like the backend's dependencies: `public` (anyone), `session` (a neighbor
 * or the administrator: finance, neighbors, contacts, actions, events), `resident` (a neighbor's
 * own data: the profile) and `admin` (`/api/admin/*`).
 */
export type Access = 'public' | 'session' | 'resident' | 'admin'

export interface RouteOptions {
  /** Success status: 201 for creations, 204 answers without a body. */
  status?: number
  /** Feature the route belongs to: when it is off the backend answers 404 `actions_disabled` / `events_disabled`. */
  feature?: 'actions' | 'events'
}

export interface RouteContext {
  request: Request
  params: PathParams
  url: URL
  /** The caller; null only on `public` routes when nobody is signed in. */
  identity: Identity | null
}

/** What a route resolver returns: a value answered as JSON (`null` included), or a Response as is. */
export type RouteResult = unknown

function checkAccess(access: Access): Identity | null {
  if (access === 'admin') return requireAdmin()
  if (access === 'resident') return { kind: 'resident', resident: requireResident() }
  if (access === 'session') return requireAnySession()
  return readerIdentity()
}

/**
 * Wraps a resolver with the backend's request pipeline, in its order: the `X-Juntia-Request` header
 * on writes (403 `invalid_origin`), the session (401/403), the feature flag (404), then the
 * resolver. Its value is answered as JSON with `options.status` (204: no body); a thrown
 * {@link DemoApiError} becomes the error response, and any other error a logged 500
 * `internal_error` (a bug in the demo).
 */
export function route(access: Access, resolve: (context: RouteContext) => RouteResult | Promise<RouteResult>, options: RouteOptions = {}) {
  return async ({ request, params }: { request: Request; params: PathParams }): Promise<Response> => {
    const url = new URL(request.url)
    try {
      if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && request.headers.get(MUTATION_HEADER) !== '1') {
        throw new DemoApiError('invalid_origin', 403)
      }
      const identity = checkAccess(access)
      if (options.feature && !coreStore().features[options.feature]) throw new DemoApiError(`${options.feature}_disabled`, 404)
      const result = await resolve({ request, params, url, identity })
      if (result instanceof Response) return result
      const status = options.status ?? 200
      if (status === 204) return new HttpResponse(null, { status })
      if (result === undefined) throw new Error('The route resolver returned nothing')
      return HttpResponse.json(result as JsonBodyType, { status })
    } catch (error) {
      if (error instanceof DemoApiError) return errorResponse(error)
      console.error(`[demo] ${request.method} ${url.pathname} failed:`, error)
      return errorResponse(new DemoApiError('internal_error', 500))
    }
  }
}

/** FastAPI's answer to a malformed path, query or body value. */
function invalidRequest(): DemoApiError {
  return new DemoApiError('invalid_request', 422)
}

function integer(raw: string, min: number, max: number): number {
  if (!/^\s*[+-]?\d+\s*$/.test(raw)) throw invalidRequest()
  const value = Number(raw)
  if (value < min || value > max) throw invalidRequest()
  return value
}

/** Integer path parameter (`/items/:itemId`), 1..2147483647 by default. */
export function idParam(params: PathParams, name: string, { min = 1, max = MAX_ID }: { min?: number; max?: number } = {}): number {
  const raw = params[name]
  if (typeof raw !== 'string') throw invalidRequest()
  return integer(raw, min, max)
}

/** String path parameter (`/imports/:previewId`). */
export function textParam(params: PathParams, name: string): string {
  const raw = params[name]
  if (typeof raw !== 'string' || !raw) throw invalidRequest()
  return raw
}

/** Optional integer query parameter; null when absent. */
export function queryInt(url: URL, name: string, { min = 1, max = MAX_ID }: { min?: number; max?: number } = {}): number | null {
  const raw = url.searchParams.get(name)
  return raw === null ? null : integer(raw, min, max)
}

/** `page` query parameter: 1 by default, 1..1000000. */
export function pageParam(url: URL): number {
  return queryInt(url, 'page', { max: MAX_PAGE }) ?? 1
}

/** Repeated integer query parameter (`tag=1&tag=2`). */
export function queryInts(url: URL, name: string): number[] {
  return url.searchParams.getAll(name).map(raw => integer(raw, 1, MAX_ID))
}

/** Text query parameter, `''` when absent; longer than `max` characters is invalid. */
export function queryText(url: URL, name: string, { max = 200 }: { max?: number } = {}): string {
  const value = url.searchParams.get(name) ?? ''
  if ([...value].length > max) throw invalidRequest()
  return value
}

/** Query parameter restricted to `values` (a `Literal`), `fallback` when absent. */
export function queryChoice<T extends string>(url: URL, name: string, values: readonly T[], fallback: T): T {
  const raw = url.searchParams.get(name)
  if (raw === null) return fallback
  if (!values.includes(raw as T)) throw invalidRequest()
  return raw as T
}

const TRUE = ['1', 'on', 't', 'true', 'y', 'yes']
const FALSE = ['0', 'off', 'f', 'false', 'n', 'no']

/** Boolean query parameter with pydantic's spellings (`true`, `1`, `yes`…), `fallback` when absent. */
export function queryBool(url: URL, name: string, fallback = false): boolean {
  const raw = url.searchParams.get(name)
  if (raw === null) return fallback
  const value = raw.trim().toLowerCase()
  if (TRUE.includes(value)) return true
  if (FALSE.includes(value)) return false
  throw invalidRequest()
}

/** Optional calendar day query parameter (`YYYY-MM-DD`); null when absent or empty. */
export function queryDay(url: URL, name: string): string | null {
  const raw = url.searchParams.get(name)
  if (raw === null || raw === '') return null
  if (!isDay(raw)) throw invalidRequest()
  return raw
}

/** The JSON body of a request (422 `invalid_request` when it is not JSON). */
export async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json()
  } catch {
    throw invalidRequest()
  }
}

/** The multipart form of an upload (422 `invalid_request` when it is not one). */
export async function readForm(request: Request): Promise<FormData> {
  try {
    return await request.formData()
  } catch {
    throw invalidRequest()
  }
}
