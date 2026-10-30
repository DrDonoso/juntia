// The demo must answer the whole API: every operation of openapi.json needs a handler (or a reason
// in UNAVAILABLE_IN_DEMO), and every handler must still be an operation of the API.
import openapiSource from '../../api/openapi.json?raw'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { resetDemo } from '../store'
import { demoRequest } from '../testing'
import { UNAVAILABLE_IN_DEMO, handlers, unhandledHandler } from './index'

const NOW = new Date(2026, 9, 29, 12)

beforeEach(() => resetDemo({ now: () => NOW }))
afterEach(() => resetDemo())

interface Operation {
  /** As in openapi.json and {@link UNAVAILABLE_IN_DEMO}: `POST /api/admin/imports/{preview_id}/ai`. */
  key: string
  method: string
  /** In MSW's syntax: `/api/admin/imports/:preview_id/ai`. */
  path: string
}

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']

function apiOperations(): Operation[] {
  const document = JSON.parse(openapiSource) as { paths: Record<string, Record<string, unknown>> }
  return Object.entries(document.paths).flatMap(([path, item]) => Object.keys(item)
    .filter(method => HTTP_METHODS.includes(method))
    .map(method => ({ key: `${method.toUpperCase()} ${path}`, method: method.toUpperCase(), path: path.replace(/\{([^}]+)\}/g, ':$1') })))
}

/** The demo's handlers but the catch-all, as `METHOD /path`. */
function demoRoutes(): { method: string; path: string }[] {
  return handlers.filter(handler => handler !== unhandledHandler).map(({ info }) => {
    if (typeof info.method !== 'string' || typeof info.path !== 'string') throw new Error(`Unexpected demo handler: ${info.header}`)
    return { method: info.method, path: info.path }
  })
}

/** A path whatever its parameters are called (`/api/actions/items/:itemId` and `…/:item_id` are the same route). */
const shape = (path: string) => path.replace(/:[^/]+/g, ':')

const sameRoute = (a: { method: string; path: string }, b: { method: string; path: string }) =>
  a.method === b.method && shape(a.path) === shape(b.path)

const label = ({ method, path }: { method: string; path: string }) => `${method} ${path}`

describe('the demo API covers the OpenAPI document', () => {
  test('lists every operation of the API', () => {
    const operations = apiOperations()
    expect(operations.length).toBeGreaterThanOrEqual(108)
    expect(operations).toContainEqual({ key: 'GET /api/admin/storage/withdrawn', method: 'GET', path: '/api/admin/storage/withdrawn' })
    expect(operations).toContainEqual({
      key: 'GET /api/events/{event_id}/calendar.ics', method: 'GET', path: '/api/events/:event_id/calendar.ics',
    })
  })

  test('every operation has a demo handler, unless it is listed as unavailable in the demo', () => {
    const routes = demoRoutes()
    const missing = apiOperations().filter(operation => !routes.some(route => sameRoute(route, operation)) && !Object.hasOwn(UNAVAILABLE_IN_DEMO, operation.key))
    expect(missing.map(label), 'operations of openapi.json that no demo handler answers').toEqual([])
  })

  test('every demo handler answers an operation of the API, and only one handler does', () => {
    const operations = apiOperations()
    const routes = demoRoutes()
    expect(routes.filter(route => !operations.some(operation => sameRoute(operation, route))).map(label), 'demo handlers of no API operation').toEqual([])
    const shapes = routes.map(route => `${route.method} ${shape(route.path)}`)
    expect(shapes.filter((value, index) => shapes.indexOf(value) !== index), 'operations answered twice').toEqual([])
  })

  test('operations unavailable in the demo exist, say why, and answer demo_unavailable', async () => {
    const operations = apiOperations()
    for (const [key, reason] of Object.entries(UNAVAILABLE_IN_DEMO)) {
      expect(operations.map(operation => operation.key), key).toContain(key)
      expect(reason.trim(), key).not.toBe('')
    }
    // A valid request of each one that has a handler, sent by someone allowed to.
    const requests: Readonly<Record<string, { method: string; path: string; body: unknown; admin?: true }>> = {
      'POST /api/auth/google/start': { method: 'POST', path: '/api/auth/google/start', body: { return_path: '/neighbors' } },
      'POST /api/auth/google/link': { method: 'POST', path: '/api/auth/google/link', body: { current_password: 'demo' } },
      'DELETE /api/auth/google/link': { method: 'DELETE', path: '/api/auth/google/link', body: { current_password: 'demo' } },
      'POST /api/admin/imports/{preview_id}/ai': {
        method: 'POST', path: '/api/admin/imports/0f8fad5b-d9cb-469f-a165-70867728950e/ai', body: { version: 1 }, admin: true,
      },
    }
    const routes = demoRoutes()
    const handled = operations
      .filter(operation => Object.hasOwn(UNAVAILABLE_IN_DEMO, operation.key) && routes.some(route => sameRoute(route, operation)))
      .map(operation => operation.key)
    expect(Object.keys(requests).sort()).toEqual(handled.sort())
    for (const [key, request] of Object.entries(requests).sort(([, a], [, b]) => Number(a.admin ?? false) - Number(b.admin ?? false))) {
      if (request.admin) await demoRequest('POST', '/api/admin/auth/login', { body: { username: 'demo', password: 'demo' } })
      expect(await demoRequest(request.method, request.path, { body: request.body }), key).toMatchObject({ status: 403, body: { code: 'demo_unavailable' } })
    }
  })
})
