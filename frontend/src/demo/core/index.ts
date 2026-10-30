/**
 * Everything a domain module needs to answer like the backend (see ../README.md). Import from here
 * rather than from 'msw' directly: the MSW version stays an implementation detail of the core.
 */
export { http, HttpResponse, type HttpHandler, type PathParams } from 'msw'
export {
  addDays, addMonths, daysAgo, daysAhead, daysBetween, endOfMonth, hoursFromNow, instant, isDay, isoDay, monthsAgo,
  now, nowIso, parseDay, setClock, startOfMonth, today,
} from './clock'
export { DEMO_UNAVAILABLE, DEMO_UNAVAILABLE_STATUS, DemoApiError } from './errors'
export {
  MAX_PAGE, MUTATION_HEADER, demoUnavailable, errorResponse, idParam, pageParam, queryBool, queryChoice, queryDay, queryInt,
  queryInts, queryText, readForm, readJson, route, textParam, type Access, type RouteContext, type RouteOptions,
} from './http'
export { IdSequence, sequenceAfter } from './ids'
export { pageCount, paginate, type Page } from './pagination'
export { demoPdf, fileDisposition, looksLikePdf, pdfResponse } from './pdf'
export { Random, demoRandom, hashText } from './random'
export {
  SIGNED_OUT, actorOf, adminSession, adminSignedIn, readerIdentity, readerSession, requireAdmin, requireAnySession,
  requireResident, residentAuth, revokeResidentSessions, signInAdmin, signInResident, signOutAdmin, signOutResident,
  signedInResident, type Identity,
} from './session'
export {
  Body, DemoValidationError, MAX_ID, characterCount, displayName, hasControlCharacters, normalizePhone, parseBody,
  type InvalidFields, type ParseOptions,
} from './validation'
