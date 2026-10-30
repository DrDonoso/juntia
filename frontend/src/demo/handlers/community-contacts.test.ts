import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import type { ContactHistoryPage, ContactOut, ContactPage, ContactTagOut, ContactTagPage } from '../../api/schema.gen'
import { resetDemo } from '../store'
import { communityStore } from '../store/community'
import { foldText } from '../store/community-text'
import { demoRequest } from '../testing'

// Thursday 29 October 2026, midday (local time), like the other demo tests.
const NOW = new Date(2026, 9, 29, 12)
const OLIVIA = { kind: 'resident', name: 'Olivia Bennett', user_id: 6 }
const ADMIN = { kind: 'administrator', name: 'Technical administrator', user_id: null }

beforeEach(() => resetDemo({ now: () => NOW }))
afterEach(() => resetDemo())

const get = <T = unknown>(path: string) => demoRequest<T>('GET', path)
const adminLogin = () => demoRequest('POST', '/api/admin/auth/login', { body: { username: 'demo', password: 'demo' } })

async function contacts(params: Record<string, string> = {}, path = '/api/contacts'): Promise<ContactPage> {
  const response = await get<ContactPage>(`${path}?${new URLSearchParams(params)}`)
  expect(response.status).toBe(200)
  return response.body
}

function contact(name: string): ContactOut {
  const found = communityStore().contacts.find(item => item.name === name)
  if (!found) throw new Error(`No contact "${name}"`)
  return { id: found.id, version: found.version } as ContactOut
}

function tagId(name: string): number {
  const found = communityStore().contactTags.find(item => item.name === name)
  if (!found) throw new Error(`No tag "${name}"`)
  return found.id
}

async function read(name: string): Promise<ContactOut> {
  return (await get<ContactOut>(`/api/contacts/${contact(name).id}`)).body
}

/** The full form, as the app sends it on save. */
function form(value: ContactOut, changes: Record<string, unknown> = {}) {
  return {
    name: value.name, company: value.company, email: value.email, phone: value.phone, notes: value.notes,
    tags: value.tags.map(tag => tag.id), version: value.version, ...changes,
  }
}

describe('the contact list', () => {
  test('lists the current contacts by name with their tags', async () => {
    const page = await contacts()
    expect(page).toMatchObject({ page: 1, pages: 1, total: 16 })
    expect(page.items.map(item => foldText(item.name))).toEqual(page.items.map(item => foldText(item.name)).sort())
    expect(page.items.every(item => item.deleted_at === null)).toBe(true)
    expect(page.items.find(item => item.name === 'Marcus Hill')).toMatchObject({
      company: 'Northgate Plumbing', email: 'marcus.hill@example.com', phone: '+442079460102',
      tags: [{ name: 'Emergency', color: '#b94644' }, { name: 'Plumbing', color: '#47a4b4' }], version: 2,
    })
    expect(page.items.find(item => item.name === 'Ben Carter')?.tags).toEqual([{ id: tagId('Building works'), name: 'Building works', color: '#d77089', version: 2 }])
  })

  test('sorts by every column with empty values last', async () => {
    const all = (await contacts()).items
    for (const sort of ['name', 'company', 'email', 'phone', 'tags', 'notes', 'created_at', 'updated_at']) {
      for (const direction of ['asc', 'desc']) {
        const key = (item: ContactOut): string => sort === 'tags'
          ? item.tags.map(tag => foldText(tag.name)).sort().join('\x1f')
          : sort === 'created_at' || sort === 'updated_at' ? item[sort] : foldText(String(item[sort as 'name'] ?? ''))
        const filled = all.filter(item => key(item)).sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0) * (direction === 'asc' ? 1 : -1) || a.id - b.id)
        const expected = [...filled, ...all.filter(item => !key(item)).sort((a, b) => a.id - b.id)]
        expect((await contacts({ sort, direction })).items.map(item => item.id), `${sort} ${direction}`).toEqual(expected.map(item => item.id))
      }
    }
    for (const query of ['sort=bad', 'direction=bad', 'page=0', `q=${'a'.repeat(201)}`]) expect((await get(`/api/contacts?${query}`)).status, query).toBe(422)
  })

  test('searches every field and tag, accent-insensitively, and phone numbers by their digits', async () => {
    expect((await contacts({ q: 'EMERGENCY' })).items.every(item => item.tags.some(tag => tag.name === 'Emergency') || /emergenc/i.test(`${item.name} ${item.notes}`))).toBe(true)
    expect((await contacts({ q: 'emergency' })).total).toBeGreaterThanOrEqual(6)
    expect((await contacts({ q: '+44 (20) 7946-0102' })).items.map(item => item.name)).toEqual(['Marcus Hill'])
    expect((await contacts({ q: 'ML-20417' })).items.map(item => item.name)).toEqual(['Apex Lifts service desk'])
    expect((await contacts({ q: 'GR\u00cbEN THUMB' })).items.map(item => item.name)).toEqual(['Oliver Green'])
    // Only a deleted contact matches: the list shows current contacts.
    expect((await contacts({ q: 'sh\u00efne & co' })).items).toEqual([])
    expect((await contacts({ q: 'not-found' })).items).toEqual([])
  })
})

describe('contacts', () => {
  test('creating normalizes the form and creates new tags with it', async () => {
    const response = await demoRequest<ContactOut>('POST', '/api/contacts', {
      body: {
        name: '  Rita   Morgan ', company: ' Morgan Glaziers ', email: 'Rita.Morgan@Example.com', phone: '+44 20 7946 0303',
        notes: ' Replaced the broken pane in the entrance.\r\n ', tags: [tagId('Building works')],
        new_tags: [{ name: 'EMERGENCY', color: '#ffffff' }, { name: ' Glazing ', color: '#2BCCB4' }],
      },
    })
    expect(response.status).toBe(201)
    expect(response.body).toMatchObject({
      name: 'Rita Morgan', company: 'Morgan Glaziers', email: 'rita.morgan@example.com', phone: '+442079460303',
      notes: 'Replaced the broken pane in the entrance.', version: 1, created_at: NOW.toISOString(), deleted_at: null,
    })
    expect(response.body.tags.map(tag => [tag.name, tag.color])).toEqual([['Building works', '#d77089'], ['Emergency', '#b94644'], ['Glazing', '#2bccb4']])
    const history = (await get<ContactHistoryPage>('/api/contact-history')).body.items
    expect(history.slice(0, 2)).toMatchObject([
      { target: 'contact', target_id: response.body.id, kind: 'created', name: 'Rita Morgan', author: OLIVIA, before: null },
      { target: 'tag', kind: 'created', name: 'Glazing', author: OLIVIA, before: null, after: { name: 'Glazing', color: '#2bccb4' } },
    ])
  })

  test('forms get the backend field codes and nothing is saved', async () => {
    const before = communityStore().contacts.length
    const cases: [Record<string, unknown>, Record<string, string> | null][] = [
      [{ name: 'Valid', email: 'not-an-email', phone: 'tel:123' }, { email: 'contact_email_invalid', phone: 'contact_phone_invalid' }],
      [{ name: 'Valid' }, { email: 'contact_channel_required', phone: 'contact_channel_required' }],
      [{ name: ' ', phone: '1234567' }, { name: 'contact_name_invalid' }],
      [{ name: 'Valid', phone: '1234567', company: 'Bad\u0000name' }, { company: 'contact_company_invalid' }],
      [{ name: 'Valid', phone: '1234567', notes: 'x'.repeat(20001) }, { notes: 'contact_notes_invalid' }],
      [{ name: 'Valid', phone: '1234567', tags: [-1] }, { tags: 'contact_tags_invalid' }],
      [{ name: 'Valid', phone: '1234567', new_tags: [{ name: 'Color', color: 'javascript:red' }] }, { tags: 'contact_tag_color_invalid' }],
      [{ name: 'Valid', phone: '1234567', new_tags: [{ name: ' ' }] }, { tags: 'contact_tag_name_invalid' }],
      [{ name: 'Valid', phone: '1234567', new_tags: [{ name: 'Duplicated' }, { name: 'DUPLICATED' }] }, { tags: 'contact_tags_invalid' }],
      [{ name: 'Valid', phone: '1234567', author_user_id: 3 }, null],
    ]
    for (const [body, fields] of cases) {
      const response = await demoRequest('POST', '/api/contacts', { body })
      expect(response, JSON.stringify(body)).toMatchObject({ status: 422, body: fields ? { code: 'invalid_request', fields } : { code: 'invalid_request' } })
      if (!fields) expect(response.body).toEqual({ code: 'invalid_request' })
    }
    expect(await demoRequest('POST', '/api/contacts', { body: { name: 'Valid', phone: '1234567', tags: [999999] } }))
      .toMatchObject({ status: 422, body: { code: 'contact_tag_not_found', fields: { tags: 'contact_tag_not_found' } } })
    expect(communityStore().contacts).toHaveLength(before)
  })

  test('edits need the current version and record what changed', async () => {
    const value = await read('Oliver Green')
    const path = `/api/contacts/${value.id}`
    expect((await demoRequest<ContactOut>('PATCH', path, { body: form(value) })).body).toEqual(value)
    const saved = await demoRequest<ContactOut>('PATCH', path, { body: form(value, { phone: '+44 20 7946 0311', notes: 'Also clears the gutters.' }) })
    expect(saved).toMatchObject({ status: 200, body: { phone: '+442079460311', version: value.version + 1, updated_at: NOW.toISOString() } })
    expect(await demoRequest('PATCH', path, { body: form(value, { name: 'Stale' }) })).toMatchObject({ status: 409, body: { code: 'contact_stale' } })
    const history = (await get<ContactHistoryPage>(`/api/contact-history?contact_id=${value.id}`)).body.items
    expect(history.map(item => item.kind)).toEqual(['updated', 'created'])
    expect(history[0]).toMatchObject({ author: OLIVIA, before: { phone: '', notes: value.notes }, after: { phone: '+442079460311', notes: 'Also clears the gutters.' } })
    const tags = Array.from({ length: 31 }, (_, index) => ({ name: `Tag ${index}`, color: '#b94644' }))
    expect(await demoRequest('PATCH', path, { body: form(saved.body, { tags: [], new_tags: tags.slice(0, 30) }) })).toMatchObject({ status: 200 })
    const full = await read('Oliver Green')
    expect(full.tags).toHaveLength(30)
    expect(await demoRequest('PATCH', path, { body: form(full, { new_tags: [tags[30]] }) }))
      .toMatchObject({ status: 422, body: { code: 'invalid_request', fields: { tags: 'contact_tags_invalid' } } })
    const { tags: _kept, ...withoutTags } = form(full, { new_tags: [{ name: 'One more', color: '#b94644' }] })
    expect(await demoRequest('PATCH', path, { body: withoutTags }))
      .toMatchObject({ status: 422, body: { code: 'contact_tags_invalid', fields: { tags: 'contact_tags_invalid' } } })
    expect(communityStore().contactTags.some(tag => tag.name === 'One more' || tag.name === 'Tag 30')).toBe(false)
  })

  test('deleted contacts leave the list but keep their history and appear in the archive', async () => {
    const value = await read('Tom Ellis')
    const path = `/api/contacts/${value.id}`
    expect(await demoRequest('DELETE', path, { body: { version: value.version + 1 } })).toMatchObject({ status: 409, body: { code: 'contact_stale' } })
    expect((await demoRequest('DELETE', path, { body: { version: value.version } })).status).toBe(204)
    expect(await get(path)).toMatchObject({ status: 404, body: { code: 'contact_not_found' } })
    expect(await demoRequest('PATCH', path, { body: form(value, { version: value.version + 1 }) })).toMatchObject({ status: 404 })
    expect((await contacts()).total).toBe(15)
    expect((await get<ContactHistoryPage>(`/api/contact-history?contact_id=${value.id}`)).body.items[0])
      .toMatchObject({ kind: 'deleted', before: { name: 'Tom Ellis' }, after: null, author: OLIVIA })
    expect(await get('/api/admin/contacts/deleted')).toMatchObject({ status: 401 })
    await adminLogin()
    const archive = await contacts({}, '/api/admin/contacts/deleted')
    expect(archive.items.map(item => item.name)).toEqual(['Laura Mills', 'Peter Doyle', 'Tom Ellis'])
    expect(archive.items.every(item => item.deleted_at !== null)).toBe(true)
    expect((await contacts({ q: 'laura.mills@', sort: 'email', direction: 'desc' }, '/api/admin/contacts/deleted')).items.map(item => item.name)).toEqual(['Laura Mills'])
    expect((await contacts({ q: 'Tom Ellis' })).items).toEqual([])
  })
})

describe('contact tags', () => {
  test('suggestions put the tags most used by current contacts first', async () => {
    const tags = (await get<ContactTagOut[]>('/api/contact-tags')).body
    const uses = (tag: ContactTagOut) => communityStore().contacts.filter(item => item.deletedAt === null && item.tagIds.includes(tag.id)).length
    expect(tags.map(uses)).toEqual(tags.map(uses).sort((a, b) => b - a))
    expect(tags[0].name).toBe('Emergency')
    expect(tags).toHaveLength(communityStore().contactTags.length)
  })

  test('residents create and rename tags; names stay unique', async () => {
    const created = await demoRequest<ContactTagOut>('POST', '/api/contact-tags', { body: { name: '  Glazing ', color: '#AABBCC' } })
    expect(created).toMatchObject({ status: 201, body: { name: 'Glazing', color: '#aabbcc', version: 1 } })
    expect(await demoRequest('POST', '/api/contact-tags', { body: { name: 'GLAZING' } })).toMatchObject({ status: 409, body: { code: 'contact_tag_exists', fields: { name: 'contact_tag_exists' } } })
    expect(await demoRequest('POST', '/api/contact-tags', { body: { name: ' ', color: 'bad' } }))
      .toMatchObject({ status: 422, body: { code: 'invalid_request', fields: { name: 'contact_tag_name_invalid', color: 'contact_tag_color_invalid' } } })
    const path = `/api/contact-tags/${created.body.id}`
    const renamed = await demoRequest<ContactTagOut>('PATCH', path, { body: { name: 'Glass and glazing', color: '#aabbcc', version: 1 } })
    expect(renamed).toMatchObject({ status: 200, body: { name: 'Glass and glazing', version: 2 } })
    expect(await demoRequest('PATCH', path, { body: { name: 'Old', color: '#000000', version: 1 } })).toMatchObject({ status: 409, body: { code: 'contact_stale' } })
    expect(await demoRequest('PATCH', path, { body: { name: 'plumbing', color: '#000000', version: 2 } })).toMatchObject({ status: 409, body: { code: 'contact_tag_exists' } })
    expect((await demoRequest<ContactTagOut>('PATCH', path, { body: { name: 'Glass and glazing', color: '#aabbcc', version: 2 } })).body).toEqual(renamed.body)
    expect(await demoRequest('PATCH', path, { body: { ...renamed.body } })).toMatchObject({ status: 422 })
    expect(await demoRequest('PATCH', '/api/contact-tags/9999', { body: { name: 'Ghost', version: 1 } }))
      .toMatchObject({ status: 422, body: { code: 'contact_tag_not_found', fields: { tags: 'contact_tag_not_found' } } })
    const history = (await get<ContactHistoryPage>('/api/contact-history')).body.items
    expect(history.slice(0, 2)).toMatchObject([
      { target: 'tag', kind: 'updated', before: { name: 'Glazing', color: '#aabbcc' }, after: { name: 'Glass and glazing', color: '#aabbcc' } },
      { target: 'tag', kind: 'created', name: 'Glazing' },
    ])
  })

  test('renaming a tag shows everywhere while contact history keeps the old snapshot', async () => {
    const value = await read('Marcus Hill')
    const plumbing = value.tags.find(tag => tag.name === 'Plumbing')
    if (!plumbing) throw new Error('Marcus has the Plumbing tag')
    await demoRequest('PATCH', `/api/contact-tags/${plumbing.id}`, { body: { name: 'Plumbers', color: plumbing.color, version: plumbing.version } })
    expect((await read('Marcus Hill')).tags.map(tag => tag.name)).toEqual(['Emergency', 'Plumbers'])
    const created = (await get<ContactHistoryPage>(`/api/contact-history?contact_id=${value.id}`)).body.items.at(-1)
    expect(created?.after && 'tags' in created.after ? created.after.tags.map(tag => tag.name) : []).toContain('Plumbing')
  })

  test('the administrator manages the catalogue', async () => {
    const id = tagId('Insurance')
    expect(await get('/api/admin/contact-tags')).toMatchObject({ status: 401 })
    expect(await demoRequest('PATCH', `/api/admin/contact-tags/${id}`, { body: { name: 'Insurers', color: '#896385', version: 1 } })).toMatchObject({ status: 401 })
    await adminLogin()
    const catalogue = (await get<ContactTagPage>('/api/admin/contact-tags')).body
    expect(catalogue).toMatchObject({ page: 1, pages: 1, total: communityStore().contactTags.length })
    expect(catalogue.items.map(tag => tag.name.toLowerCase())).toEqual(catalogue.items.map(tag => tag.name.toLowerCase()).sort())
    expect((await get<ContactTagPage>('/api/admin/contact-tags?q=%EF%BC%A9NSUR')).body.items.map(tag => tag.name)).toEqual(['Insurance'])
    expect((await get(`/api/admin/contact-tags?q=${'a'.repeat(101)}`)).status).toBe(422)
    expect((await get<ContactTagOut>(`/api/admin/contact-tags/${id}`)).body).toMatchObject({ name: 'Insurance', version: 1 })
    expect(await get('/api/admin/contact-tags/9999')).toMatchObject({ status: 404, body: { code: 'contact_tag_not_found' } })
    const saved = await demoRequest<ContactTagOut>('PATCH', `/api/admin/contact-tags/${id}`, { body: { name: 'Insurers', color: '#FFFFFF', version: 1 } })
    expect(saved).toMatchObject({ status: 200, body: { id, name: 'Insurers', color: '#ffffff', version: 2 } })
    expect((await get<ContactHistoryPage>('/api/contact-history')).body.items[0]).toMatchObject({ target: 'tag', target_id: id, author: ADMIN })
  })
})

describe('contact history and access', () => {
  test('the shared history is newest first and filters by contact', async () => {
    const all = (await get<ContactHistoryPage>('/api/contact-history')).body
    const total = communityStore().contactHistory.length
    expect(all).toMatchObject({ total, page: 1, pages: Math.ceil(total / 50) })
    expect(all.items.map(item => item.id)).toEqual(all.items.map(item => item.id).sort((a, b) => b - a))
    const doyle = communityStore().contacts.find(item => item.name === 'Peter Doyle')
    const deleted = (await get<ContactHistoryPage>(`/api/contact-history?contact_id=${doyle?.id}`)).body.items
    expect(deleted.map(item => item.kind)).toEqual(['deleted', 'updated', 'created'])
    expect(await get('/api/contact-history?contact_id=9999')).toMatchObject({ status: 404, body: { code: 'contact_not_found' } })
    expect((await get('/api/contact-history?contact_id=0')).status).toBe(422)
  })

  test('every route needs a session; the administrator writes as Technical administrator', async () => {
    const id = contact('Marcus Hill').id
    await demoRequest('POST', '/api/auth/logout')
    for (const path of ['/api/contacts', `/api/contacts/${id}`, '/api/contact-tags', '/api/contact-history']) {
      expect(await get(path), path).toMatchObject({ status: 401, body: { code: 'authentication_required' } })
    }
    expect(await demoRequest('POST', '/api/contacts', { body: { name: 'Anonymous', phone: '1234567' } })).toMatchObject({ status: 401 })
    await adminLogin()
    const created = await demoRequest<ContactOut>('POST', '/api/contacts', { body: { name: 'Council helpline', phone: '+44 20 7946 0404' } })
    expect(created.status).toBe(201)
    expect((await get<ContactHistoryPage>(`/api/contact-history?contact_id=${created.body.id}`)).body.items[0].author).toEqual(ADMIN)
    expect(await demoRequest('POST', '/api/contacts', { body: { name: 'No header', phone: '1234567' }, mutationHeader: false })).toMatchObject({ status: 403, body: { code: 'invalid_origin' } })
  })
})
