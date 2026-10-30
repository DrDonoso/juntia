/**
 * Records of the community domain as the demo keeps them, shaped like the backend's tables
 * (src/juntia/db.py): actions with labels, comments, PDF attachments and their history, events
 * and their history, and contacts with tags and their history. Authors are `ActorOut` snapshots,
 * like the backend's `Authorship` columns, so they survive later changes to the neighbor.
 */
import type {
  ActionChange, ActionEventOut, ActionSummaryOut, ActorOut, ContactSnapshot, ContactTagIn, EventSnapshot,
} from '../../api/schema.gen'
import { ADMINISTRATOR_ACTOR_NAME } from '../cast'
import type { IdSequence } from '../core/ids'
import type { Random } from '../core/random'

export type ActionStatus = ActionSummaryOut['status']
export type ActionEventKind = ActionEventOut['kind']
export type ChangeKind = 'created' | 'updated' | 'deleted'

export interface DemoActionLabel {
  id: number
  name: string
  /** Null until the administrator chooses one (the app then derives a colour from the name). */
  color: string | null
  version: number
}

export interface DemoAction {
  id: number
  title: string
  description: string
  status: ActionStatus
  labelIds: number[]
  author: ActorOut
  version: number
  createdAt: string
  /** Last activity: every change, comment and attachment moves it (the list's default order). */
  updatedAt: string
}

export interface DemoActionComment {
  id: number
  actionId: number
  /** Kept after a withdrawal for the history; the API then answers null. */
  body: string
  author: ActorOut
  version: number
  createdAt: string
  updatedAt: string
  withdrawnAt: string | null
}

export interface DemoActionAttachment {
  /** The upload id the client chose (a UUID). */
  id: string
  actionId: number
  /** Name of the uploaded file; a rename sets {@link displayFilename}. */
  filename: string
  displayFilename: string | null
  size: number
  sha256: string
  /** The file; a purge deletes it (empty), while its size and fingerprint stay in the record. */
  bytes: Uint8Array<ArrayBuffer>
  author: ActorOut
  version: number
  createdAt: string
  withdrawnAt: string | null
  /** When the administrator purged the file of a withdrawn PDF (SEC-03): its record and history stay. */
  purgedAt: string | null
}

export interface DemoActionEvent {
  id: number
  actionId: number
  kind: ActionEventKind
  author: ActorOut
  createdAt: string
  changes: ActionChange[]
  commentId: number | null
  attachmentId: string | null
}

export interface DemoEvent {
  id: number
  /** Stable identity of the event in calendar apps (`UID:<uuid>@juntia`). */
  calendarUid: string
  title: string
  description: string
  location: string
  allDay: boolean
  /** UTC instants of a timed event. */
  startsAt: string | null
  endsAt: string | null
  /** Days of an all-day event; `endsOn` is exclusive, like the API's. */
  startsOn: string | null
  endsOn: string | null
  actionId: number | null
  author: ActorOut
  version: number
  createdAt: string
  updatedAt: string
  deletedAt: string | null
}

export interface DemoEventChange {
  id: number
  eventId: number
  kind: ChangeKind
  author: ActorOut
  createdAt: string
  before: EventSnapshot | null
  after: EventSnapshot | null
}

export interface DemoContactTag {
  id: number
  name: string
  color: string
  version: number
}

export interface DemoContact {
  id: number
  name: string
  company: string
  email: string | null
  /** Normalized like the API (`+442079460102`) or `''`. */
  phone: string
  notes: string
  tagIds: number[]
  version: number
  createdAt: string
  updatedAt: string
  deletedAt: string | null
}

/** One entry of the contacts' shared history: about a contact or about a tag. */
export interface DemoContactChange {
  id: number
  contactId: number | null
  tagId: number | null
  kind: ChangeKind
  author: ActorOut
  createdAt: string
  before: ContactSnapshot | ContactTagIn | null
  after: ContactSnapshot | ContactTagIn | null
}

export interface CommunitySequences {
  label: IdSequence
  action: IdSequence
  comment: IdSequence
  actionHistory: IdSequence
  event: IdSequence
  eventHistory: IdSequence
  contactTag: IdSequence
  contact: IdSequence
  contactHistory: IdSequence
}

export interface CommunityState {
  labels: DemoActionLabel[]
  actions: DemoAction[]
  comments: DemoActionComment[]
  attachments: DemoActionAttachment[]
  actionHistory: DemoActionEvent[]
  events: DemoEvent[]
  eventHistory: DemoEventChange[]
  contactTags: DemoContactTag[]
  contacts: DemoContact[]
  contactHistory: DemoContactChange[]
  sequences: CommunitySequences
  /** Calendar UIDs of the events created during the visit. */
  random: Random
}

/** An author as the API shows it: administrators always as "Technical administrator" (backend `author_name`). */
export function actorOut(author: ActorOut): ActorOut {
  return author.kind === 'administrator'
    ? { kind: 'administrator', name: ADMINISTRATOR_ACTOR_NAME, user_id: null }
    : { kind: 'resident', name: author.name, user_id: author.user_id }
}

/** Code point order, like the backend's binary collations. */
export function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** Records changed through the API are compared as JSON, like the backend compares its snapshots. */
export function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}
