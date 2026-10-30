/**
 * Community endpoints of the demo API (the routes ../README.md assigns to community): actions with
 * labels, comments, PDFs and history, events with the agenda and calendar exports, and contacts
 * with tags, history and the deleted-contacts archive.
 */
import type { HttpHandler } from '../core'
import { actionHandlers } from './community-actions'
import { contactHandlers } from './community-contacts'
import { eventHandlers } from './community-events'

export const communityHandlers: HttpHandler[] = [...actionHandlers, ...eventHandlers, ...contactHandlers]
