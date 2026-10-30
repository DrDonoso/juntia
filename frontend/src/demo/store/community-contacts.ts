/**
 * Contacts and their tags (src/juntia/contacts.py): the operations that change them and leave the
 * shared history, the API views, and the list, search and tag queries. Every reader can change
 * contacts and tags; deleted contacts stay in the history and in the administrator's archive.
 */
import type { ActorOut, ContactEventOut, ContactOut, ContactSnapshot, ContactTagIn, ContactTagOut } from '../../api/schema.gen'
import {
  actorOut, compareText, sameJson, type ChangeKind, type CommunityState, type DemoContact, type DemoContactChange, type DemoContactTag,
} from './community-model'
import { casefold, foldText, labelKey } from './community-text'

/** Page size of contacts, deleted contacts, the tag catalogue and the history. */
export const CONTACT_PAGE_SIZE = 50

/** Tags a contact may have (`ContactIn.tags` + `new_tags`). */
export const MAX_CONTACT_TAGS = 30

/** Colour of tags created without one (`TagIn.color`). */
export const DEFAULT_CONTACT_TAG_COLOR = '#21639f'

export const CONTACT_SORTS = ['name', 'company', 'email', 'phone', 'tags', 'notes', 'created_at', 'updated_at'] as const
export type ContactSort = typeof CONTACT_SORTS[number]

export interface ContactFields {
  name: string
  company: string
  email: string | null
  phone: string
  notes: string
}

export function findContact(state: CommunityState, id: number): DemoContact | undefined {
  return state.contacts.find(contact => contact.id === id)
}

export function findContactTag(state: CommunityState, id: number): DemoContactTag | undefined {
  return state.contactTags.find(tag => tag.id === id)
}

export function findContactTagByName(state: CommunityState, name: string): DemoContactTag | undefined {
  const key = labelKey(name)
  return state.contactTags.find(tag => labelKey(tag.name) === key)
}

export function contactTagOut(tag: DemoContactTag): ContactTagOut {
  return { id: tag.id, name: tag.name, color: tag.color, version: tag.version }
}

function tagSnapshot(tag: DemoContactTag): ContactTagIn {
  return { name: tag.name, color: tag.color }
}

/** A contact's tags in the backend's order (normalized name, then id). */
export function contactTags(state: CommunityState, contact: DemoContact): DemoContactTag[] {
  return contact.tagIds.flatMap(id => findContactTag(state, id) ?? [])
    .sort((a, b) => compareText(labelKey(a.name), labelKey(b.name)) || a.id - b.id)
}

export function contactSnapshot(state: CommunityState, contact: DemoContact): ContactSnapshot {
  return {
    name: contact.name, company: contact.company, email: contact.email, phone: contact.phone, notes: contact.notes,
    tags: contactTags(state, contact).map(contactTagOut),
  }
}

export function contactOut(state: CommunityState, contact: DemoContact): ContactOut {
  return {
    ...contactSnapshot(state, contact), id: contact.id, version: contact.version, created_at: contact.createdAt,
    updated_at: contact.updatedAt, deleted_at: contact.deletedAt,
  }
}

function record(
  state: CommunityState, actor: ActorOut, kind: ChangeKind, target: { contactId: number } | { tagId: number },
  before: ContactSnapshot | ContactTagIn | null, after: ContactSnapshot | ContactTagIn | null, at: string,
): void {
  state.contactHistory.push({
    id: state.sequences.contactHistory.next(), contactId: 'contactId' in target ? target.contactId : null,
    tagId: 'tagId' in target ? target.tagId : null, kind, author: { ...actor }, createdAt: at, before, after,
  })
}

/** `POST /api/contact-tags` (the name must be free: the handler checks it). */
export function createContactTag(state: CommunityState, actor: ActorOut, input: ContactTagIn, at: string): DemoContactTag {
  const tag: DemoContactTag = { id: state.sequences.contactTag.next(), name: input.name, color: input.color, version: 1 }
  state.contactTags.push(tag)
  record(state, actor, 'created', { tagId: tag.id }, null, tagSnapshot(tag), at)
  return tag
}

/** `edit_tag`: renames or recolours a tag everywhere; contact history keeps the old snapshots. */
export function editContactTag(state: CommunityState, actor: ActorOut, tag: DemoContactTag, input: ContactTagIn, at: string): void {
  const before = tagSnapshot(tag)
  if (sameJson(before, input)) return
  tag.name = input.name
  tag.color = input.color
  tag.version += 1
  record(state, actor, 'updated', { tagId: tag.id }, before, tagSnapshot(tag), at)
}

/** Ids the new tags of a contact form will have: existing names keep their tag; `missing` are created. */
export function planNewTags(state: CommunityState, tags: readonly ContactTagIn[]): { existing: number[]; missing: ContactTagIn[] } {
  const existing: number[] = [], missing: ContactTagIn[] = []
  for (const tag of tags) {
    const found = findContactTagByName(state, tag.name)
    if (found) existing.push(found.id)
    else missing.push(tag)
  }
  return { existing, missing }
}

/** `resolve_new_tags`: creates the missing tags (alphabetically, each with its history entry). */
function resolveNewTags(state: CommunityState, actor: ActorOut, tags: readonly ContactTagIn[], at: string): number[] {
  const ordered = [...tags].sort((a, b) => compareText(casefold(a.name), casefold(b.name)))
  return ordered.map(tag => (findContactTagByName(state, tag.name) ?? createContactTag(state, actor, tag, at)).id)
}

/** `create_contact`: inline tags first, then the contact (the handler has checked ids and limits). */
export function createContact(
  state: CommunityState, actor: ActorOut, fields: ContactFields, tagIds: readonly number[], newTags: readonly ContactTagIn[], at: string,
): DemoContact {
  const created = resolveNewTags(state, actor, newTags, at)
  const contact: DemoContact = {
    id: state.sequences.contact.next(), ...fields, tagIds: [...new Set([...tagIds, ...created])].sort((a, b) => a - b),
    version: 1, createdAt: at, updatedAt: at, deletedAt: null,
  }
  state.contacts.push(contact)
  record(state, actor, 'created', { contactId: contact.id }, null, contactSnapshot(state, contact), at)
  return contact
}

/** `edit_contact`: `tagIds` undefined keeps the tags; a new version and history entry only when something changed. */
export function editContact(
  state: CommunityState, actor: ActorOut, contact: DemoContact, fields: Partial<ContactFields>, tagIds: readonly number[] | undefined,
  newTags: readonly ContactTagIn[], at: string,
): void {
  const created = resolveNewTags(state, actor, newTags, at)
  const before = contactSnapshot(state, contact)
  Object.assign(contact, fields)
  contact.tagIds = [...new Set([...(tagIds ?? contact.tagIds), ...created])].sort((a, b) => a - b)
  const after = contactSnapshot(state, contact)
  if (sameJson(before, after)) return
  contact.version += 1
  contact.updatedAt = at
  record(state, actor, 'updated', { contactId: contact.id }, before, after, at)
}

export function deleteContact(state: CommunityState, actor: ActorOut, contact: DemoContact, at: string): void {
  const before = contactSnapshot(state, contact)
  contact.deletedAt = at
  contact.updatedAt = at
  contact.version += 1
  record(state, actor, 'deleted', { contactId: contact.id }, before, null, at)
}

export function contactChangeOut(change: DemoContactChange): ContactEventOut {
  const content = change.after ?? change.before
  return {
    id: change.id, target: change.contactId !== null ? 'contact' : 'tag', target_id: change.contactId ?? change.tagId ?? 0,
    name: content?.name ?? '', kind: change.kind, author: actorOut(change.author), created_at: change.createdAt,
    before: change.before, after: change.after,
  }
}

function searchable(state: CommunityState, contact: DemoContact): string {
  const tags = contactTags(state, contact).map(tag => tag.name)
  return foldText([contact.name, contact.company, contact.email ?? '', contact.phone, contact.notes, ...tags].join('\n'))
}

function sortKey(state: CommunityState, contact: DemoContact, sort: Exclude<ContactSort, 'created_at' | 'updated_at'>): string {
  if (sort === 'tags') {
    return contactTags(state, contact).map(tag => foldText(tag.name)).sort(compareText).join('\x1f')
  }
  return foldText(contact[sort] ?? '')
}

export interface ContactQuery {
  q: string
  sort: ContactSort
  direction: 'asc' | 'desc'
  deleted: boolean
}

/**
 * `contact_page`: accent-insensitive search over every field and tag (phone numbers also by their
 * digits), then the sort column with empty values last and the id as tiebreaker.
 */
export function queryContacts(state: CommunityState, query: ContactQuery): DemoContact[] {
  const needle = foldText(query.q.trim())
  const digits = needle.replace(/[\s().-]/g, '')
  const phoneSearch = /^\+?[0-9]+$/.test(digits)
  const matching = state.contacts.filter(contact => (contact.deletedAt !== null) === query.deleted && (
    !needle || searchable(state, contact).includes(needle) || (phoneSearch && contact.phone.includes(digits))
  ))
  const sign = query.direction === 'asc' ? 1 : -1
  const { sort } = query
  if (sort === 'created_at' || sort === 'updated_at') {
    const field = sort === 'created_at' ? 'createdAt' : 'updatedAt'
    return matching.sort((a, b) => sign * compareText(a[field], b[field]) || a.id - b.id)
  }
  const keyed = matching.map(contact => ({ contact, key: sortKey(state, contact, sort) }))
  keyed.sort((a, b) => Number(a.key === '') - Number(b.key === '') || sign * compareText(a.key, b.key) || a.contact.id - b.contact.id)
  return keyed.map(entry => entry.contact)
}

/** `GET /api/contact-tags`: the tags most used by current contacts first, then by name. */
export function tagSuggestions(state: CommunityState): DemoContactTag[] {
  const uses = new Map<number, number>()
  for (const contact of state.contacts) {
    if (contact.deletedAt === null) for (const id of contact.tagIds) uses.set(id, (uses.get(id) ?? 0) + 1)
  }
  return [...state.contactTags].sort((a, b) => (uses.get(b.id) ?? 0) - (uses.get(a.id) ?? 0)
    || compareText(labelKey(a.name), labelKey(b.name)) || a.id - b.id)
}
