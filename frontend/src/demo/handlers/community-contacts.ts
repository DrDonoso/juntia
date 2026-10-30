/**
 * Contact routes of the demo API (src/juntia/contacts.py): the shared contacts with their tags and
 * history, the administrator's tag catalogue and the archive of deleted contacts. Every reader may
 * create, edit and delete contacts and tags; forms get the backend's field codes on errors.
 */
import type { ContactOut, ContactTagIn, ContactTagOut } from '../../api/schema.gen'
import {
  DemoApiError, actorOf, displayName, http, idParam, nowIso, pageParam, paginate, parseBody, queryChoice, queryInt, queryText, readJson,
  route, type Body, type HttpHandler, type RouteContext,
} from '../core'
import { communityStore, type CommunityState } from '../store/community'
import {
  CONTACT_PAGE_SIZE, CONTACT_SORTS, DEFAULT_CONTACT_TAG_COLOR, MAX_CONTACT_TAGS, contactChangeOut, contactOut, contactTagOut,
  createContact, createContactTag, deleteContact, editContact, editContactTag, findContact, findContactTag, planNewTags, queryContacts,
  tagSuggestions, type ContactFields,
} from '../store/community-contacts'
import { compareText, type DemoContact, type DemoContactTag } from '../store/community-model'
import { actionText, casefold, labelKey } from '../store/community-text'
import { MODEL, contactFields, tagColor, tagFields, tagName, valid, version } from './community-contracts'

const CONTACT_KEYS = ['name', 'company', 'email', 'phone', 'notes', 'tags', 'new_tags']

/** The validated body of `ContactIn` / `ContactEdit`. */
interface ContactInput {
  /** Only the fields the body sent (`exclude_unset`): an edit leaves the others alone. */
  fields: Partial<ContactFields> & Pick<ContactFields, 'name'>
  /** Undefined when the body does not send `tags` (an edit then keeps the current ones). */
  tags: number[] | undefined
  newTags: ContactTagIn[]
  version: number
}

/** `ContactIn` (and `ContactEdit` with `withVersion`), with its model validator: an email or a phone, at most 30 distinct tags. */
function contactInput(body: Body, withVersion: boolean): ContactInput {
  const name = body.name('name')
  const company = body.text('company', { max: 150, fallback: '' })
  const email = body.raw('email') === undefined || body.raw('email') === null ? null : body.email('email')
  const phone = body.phone('phone')
  const notes = body.text('notes', { max: 20000, fallback: '' })
  const tags = [...new Set(body.ids('tags', { max: MAX_CONTACT_TAGS }))].sort((a, b) => a - b)
  const newTags = body.list('new_tags', { max: MAX_CONTACT_TAGS }, (tag): ContactTagIn => ({
    name: tagName(tag), color: tagColor(tag, DEFAULT_CONTACT_TAG_COLOR),
  }))
  const expected = withVersion ? version(body) : 0
  const fields = {
    name,
    company: body.failed('company') || !company.trim() ? '' : displayName(company) ?? body.fail('company', 'value_error') ?? '',
    email, phone,
    notes: body.failed('notes') ? notes : actionText(notes) ?? body.fail('notes', 'value_error') ?? '',
  }
  if (valid(body, withVersion ? [...CONTACT_KEYS, 'version'] : CONTACT_KEYS)) {
    const names = newTags.map(tag => casefold(tag.name))
    if (!email && !phone) body.fail(MODEL, 'contact_channel_required')
    else if (tags.length + newTags.length > MAX_CONTACT_TAGS || new Set(names).size !== names.length) body.fail(MODEL, 'contact_tags_invalid')
  }
  const sent = (['company', 'email', 'phone', 'notes'] as const).filter(key => body.present.has(key))
  return {
    fields: { name: fields.name, ...Object.fromEntries(sent.map(key => [key, fields[key]])) },
    tags: body.present.has('tags') ? tags : undefined,
    newTags,
    version: expected,
  }
}

/** The tags a contact will have, checked like `lock_tags` and `replace_tags` before anything changes. */
function checkTags(state: CommunityState, input: ContactInput, current: readonly number[] = []): void {
  const plan = planNewTags(state, input.newTags)
  const selected = new Set([...(input.tags ?? current), ...plan.existing])
  if ([...selected].some(id => !findContactTag(state, id))) {
    throw new DemoApiError('contact_tag_not_found', 422, { tags: 'contact_tag_not_found' })
  }
  const changed = plan.missing.length > 0 || selected.size !== new Set(current).size || current.some(id => !selected.has(id))
  if (changed && selected.size + plan.missing.length > MAX_CONTACT_TAGS) {
    throw new DemoApiError('contact_tags_invalid', 422, { tags: 'contact_tags_invalid' })
  }
}

function author({ identity }: RouteContext) {
  if (!identity) throw new DemoApiError('authentication_required', 401)
  return actorOf(identity)
}

/** A current contact: deleted ones are only in the archive and the history. */
function contactOf(state: CommunityState, id: number): DemoContact {
  const contact = findContact(state, id)
  if (!contact || contact.deletedAt !== null) throw new DemoApiError('contact_not_found', 404)
  return contact
}

function contactPage({ url }: RouteContext, deleted: boolean) {
  const q = queryText(url, 'q', { max: 200 })
  const page = pageParam(url)
  const sort = queryChoice(url, 'sort', CONTACT_SORTS, 'name')
  const direction = queryChoice(url, 'direction', ['asc', 'desc'], 'asc')
  const state = communityStore()
  const { items, ...info } = paginate(queryContacts(state, { q, sort, direction, deleted }), page, CONTACT_PAGE_SIZE)
  return { ...info, items: items.map(contact => contactOut(state, contact)) }
}

/** `edit_tag` (from the contacts page or the administration): renames or recolours a tag everywhere. */
async function editTag(context: RouteContext): Promise<ContactTagOut> {
  const tagId = idParam(context.params, 'tagId')
  const input = parseBody(await readJson(context.request), body => ({
    name: tagName(body), color: tagColor(body, DEFAULT_CONTACT_TAG_COLOR), version: version(body),
  }), { fields: tagFields })
  const state = communityStore()
  const tag = findContactTag(state, tagId)
  if (!tag) throw new DemoApiError('contact_tag_not_found', 422, { tags: 'contact_tag_not_found' })
  if (tag.version !== input.version) throw new DemoApiError('contact_stale', 409)
  if (taken(state, input.name, tag)) throw new DemoApiError('contact_tag_exists', 409, { name: 'contact_tag_exists' })
  editContactTag(state, author(context), tag, { name: input.name, color: input.color }, nowIso())
  return contactTagOut(tag)
}

/** Whether another tag already has this name (`contact_tags.normalized_name` is unique). */
function taken(state: CommunityState, name: string, except?: DemoContactTag): boolean {
  return state.contactTags.some(tag => tag !== except && labelKey(tag.name) === labelKey(name))
}

export const contactHandlers: HttpHandler[] = [
  http.get('/api/contacts', route('session', context => contactPage(context, false))),
  http.post('/api/contacts', route('session', async (context): Promise<ContactOut> => {
    const input = parseBody(await readJson(context.request), body => contactInput(body, false), { fields: contactFields })
    const state = communityStore()
    checkTags(state, input)
    const { name, company = '', email = null, phone = '', notes = '' } = input.fields
    const contact = createContact(state, author(context), { name, company, email, phone, notes }, input.tags ?? [], input.newTags, nowIso())
    return contactOut(state, contact)
  }, { status: 201 })),
  http.get('/api/contacts/:contactId', route('session', ({ params }) => {
    const state = communityStore()
    return contactOut(state, contactOf(state, idParam(params, 'contactId')))
  })),
  http.patch('/api/contacts/:contactId', route('session', async context => {
    const contactId = idParam(context.params, 'contactId')
    const input = parseBody(await readJson(context.request), body => contactInput(body, true), { fields: contactFields })
    const state = communityStore()
    const contact = contactOf(state, contactId)
    if (contact.version !== input.version) throw new DemoApiError('contact_stale', 409)
    checkTags(state, input, contact.tagIds)
    editContact(state, author(context), contact, input.fields, input.tags, input.newTags, nowIso())
    return contactOut(state, contact)
  })),
  http.delete('/api/contacts/:contactId', route('session', async context => {
    const contactId = idParam(context.params, 'contactId')
    const expected = parseBody(await readJson(context.request), version, { fields: contactFields })
    const state = communityStore()
    const contact = contactOf(state, contactId)
    if (contact.version !== expected) throw new DemoApiError('contact_stale', 409)
    deleteContact(state, author(context), contact, nowIso())
  }, { status: 204 })),
  http.get('/api/contact-tags', route('session', () => tagSuggestions(communityStore()).map(contactTagOut))),
  http.post('/api/contact-tags', route('session', async (context): Promise<ContactTagOut> => {
    const input = parseBody(await readJson(context.request), body => ({
      name: tagName(body), color: tagColor(body, DEFAULT_CONTACT_TAG_COLOR),
    }), { fields: tagFields })
    const state = communityStore()
    if (taken(state, input.name)) throw new DemoApiError('contact_tag_exists', 409, { name: 'contact_tag_exists' })
    return contactTagOut(createContactTag(state, author(context), input, nowIso()))
  }, { status: 201 })),
  http.patch('/api/contact-tags/:tagId', route('session', editTag)),
  http.get('/api/contact-history', route('session', ({ url }) => {
    const page = pageParam(url)
    const contactId = queryInt(url, 'contact_id')
    const state = communityStore()
    if (contactId !== null && !findContact(state, contactId)) throw new DemoApiError('contact_not_found', 404)
    const changes = state.contactHistory
      .filter(change => contactId === null || change.contactId === contactId)
      .sort((a, b) => b.id - a.id)
    const { items, ...info } = paginate(changes, page, CONTACT_PAGE_SIZE)
    return { ...info, items: items.map(contactChangeOut) }
  })),
  http.get('/api/admin/contact-tags', route('admin', ({ url }) => {
    const q = queryText(url, 'q', { max: 100 })
    const page = pageParam(url)
    const needle = casefold(q.normalize('NFKC').trim())
    const tags = communityStore().contactTags.filter(tag => labelKey(tag.name).includes(needle))
      .sort((a, b) => compareText(labelKey(a.name), labelKey(b.name)) || a.id - b.id)
    const { items, ...info } = paginate(tags, page, CONTACT_PAGE_SIZE)
    return { ...info, items: items.map(contactTagOut) }
  })),
  http.get('/api/admin/contact-tags/:tagId', route('admin', ({ params }) => {
    const tag = findContactTag(communityStore(), idParam(params, 'tagId'))
    if (!tag) throw new DemoApiError('contact_tag_not_found', 404)
    return contactTagOut(tag)
  })),
  http.patch('/api/admin/contact-tags/:tagId', route('admin', editTag)),
  http.get('/api/admin/contacts/deleted', route('admin', context => contactPage(context, true))),
]
