/**
 * Community endpoints of the demo API (the routes ../README.md assigns to community): actions with
 * labels, comments, PDFs and history, events with the agenda and calendar exports, the images of
 * their texts, and contacts with tags, history and the deleted-contacts archive.
 */
import type { HttpHandler } from '../core'
import { actionHandlers } from './community-actions'
import { contactHandlers } from './community-contacts'
import { eventHandlers } from './community-events'
import { imageHandlers } from './community-images'

// The image routes go first: MSW takes the first match, and `/api/events/:eventId…` would take theirs.
export const communityHandlers: HttpHandler[] = [...imageHandlers, ...actionHandlers, ...eventHandlers, ...contactHandlers]
