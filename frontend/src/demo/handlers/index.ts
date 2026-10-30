/**
 * The demo API: every domain's handlers, then a catch-all. MSW answers with the first handler that
 * matches, so each domain module orders its own routes (`/api/events/agenda` before
 * `/api/events/:eventId`); domains never share a route. Every operation of src/api/openapi.json
 * has a handler (coverage.test.ts checks it): an operation the demo cannot perform still answers,
 * with 403 `demo_unavailable`, and is listed in {@link UNAVAILABLE_IN_DEMO}.
 */
import { http, HttpResponse, type HttpHandler } from '../core'
import { communityHandlers } from './community'
import { coreHandlers } from './core'
import { financeHandlers } from './finance'
import { peopleHandlers } from './people'
import { storageHandlers } from './storage'

/** Handlers of each module of the demo API. */
export const domainHandlers: Readonly<Record<'core' | 'finance' | 'community' | 'people' | 'storage', readonly HttpHandler[]>> = {
  core: coreHandlers,
  finance: financeHandlers,
  community: communityHandlers,
  people: peopleHandlers,
  storage: storageHandlers,
}

/**
 * Operations of the API (`METHOD /path` as in openapi.json) the demo cannot perform because they
 * need real infrastructure, with the reason. Their handlers validate the request like the backend
 * and answer 403 `demo_unavailable`, which the app shows as "This feature needs a real server, so
 * it is not available in the demo." The coverage test only accepts an operation without a handler
 * when it is listed here.
 */
export const UNAVAILABLE_IN_DEMO: Readonly<Record<string, string>> = {
  'POST /api/auth/google/start': 'Google sign-in needs a Google OAuth client and a server to return to.',
  'POST /api/auth/google/link': 'Linking a Google account needs Google sign-in.',
  'DELETE /api/auth/google/link': 'Unlinking a Google account needs Google sign-in.',
  'POST /api/admin/imports/{preview_id}/ai': 'AI classification needs an OpenAI-compatible API key on the server.',
}

/** Prefix of the console error logged for an /api request the demo does not answer. */
export const UNHANDLED_PREFIX = '[demo] Unhandled API request:'

/** Status of the catch-all: a missing handler is a demo bug, unlike the deliberate `demo_unavailable`. */
export const UNHANDLED_STATUS = 501

/** Any other /api request: loud (console error, 501) so tests and visitors notice the gap. */
export const unhandledHandler = http.all('/api/*', ({ request }) => {
  console.error(`${UNHANDLED_PREFIX} ${request.method} ${new URL(request.url).pathname}`)
  return HttpResponse.json({ code: 'not_implemented' }, { status: UNHANDLED_STATUS })
})

export const handlers: HttpHandler[] = [
  ...coreHandlers,
  ...financeHandlers,
  ...communityHandlers,
  ...peopleHandlers,
  ...storageHandlers,
  unhandledHandler,
]
