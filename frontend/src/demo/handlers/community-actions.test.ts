import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import type {
  ActionAttachmentOut, ActionAttachmentPage, ActionBoardOut, ActionCommentOut, ActionCommentPage, ActionHistoryPage, ActionLabelOut,
  ActionLabelPage, ActionOut, ActionPage,
} from '../../api/schema.gen'
import { looksLikePdf } from '../core'
import { resetDemo } from '../store'
import { communityStore } from '../store/community'
import { ACTION_STATUSES } from '../store/community-actions'
import { coreStore } from '../store/core'
import { demoFetch, demoRequest, demoUrl } from '../testing'

// Thursday 29 October 2026, midday (local time), like the other demo tests.
const NOW = new Date(2026, 9, 29, 12)
const OLIVIA = { kind: 'resident', name: 'Olivia Bennett', user_id: 6 }
const ADMIN = { kind: 'administrator', name: 'Technical administrator', user_id: null }

beforeEach(() => resetDemo({ now: () => NOW }))
afterEach(() => resetDemo())

const get = <T = unknown>(path: string) => demoRequest<T>('GET', path)
const adminLogin = () => demoRequest('POST', '/api/admin/auth/login', { body: { username: 'demo', password: 'demo' } })
const signOut = () => demoRequest('POST', '/api/auth/logout')

function actionId(title: string): number {
  const action = communityStore().actions.find(item => item.title.startsWith(title))
  if (!action) throw new Error(`No action "${title}"`)
  return action.id
}

function labelId(name: string): number {
  const label = communityStore().labels.find(item => item.name === name)
  if (!label) throw new Error(`No label "${name}"`)
  return label.id
}

describe('the board and the list', () => {
  test('the board has every status in order; closed columns only outside the open scope', async () => {
    const open = (await get<ActionBoardOut>('/api/actions/board')).body
    expect(open.columns.map(column => column.status)).toEqual(ACTION_STATUSES)
    for (const column of open.columns) {
      const closed = column.status === 'done' || column.status === 'discarded'
      expect(column.total === 0, column.status).toBe(closed)
      expect(column).toMatchObject({ page: 1, pages: 1 })
      expect(column.items.every(item => item.status === column.status)).toBe(true)
      expect(column.items.map(item => item.updated_at)).toEqual(column.items.map(item => item.updated_at).sort().reverse())
    }
    const all = (await get<ActionBoardOut>('/api/actions/board?scope=all')).body
    for (const column of all.columns) expect(column.total, column.status).toBeGreaterThanOrEqual(2)
    const filtered = (await get<ActionBoardOut>(`/api/actions/board?scope=all&label=${labelId('Roof')}&q=MEMBRANE`)).body
    expect(filtered.columns.flatMap(column => column.items.map(item => item.title))).toEqual(['Roof leak above the fourth-floor landing'])
  })

  test('the list is open actions by latest activity, with counts, labels and authors', async () => {
    const { status, body } = await get<ActionPage>('/api/actions/items')
    expect(status).toBe(200)
    const actions = communityStore().actions
    expect(body).toMatchObject({ page: 1, pages: 1, total: actions.filter(action => !['done', 'discarded'].includes(action.status)).length })
    expect(body.items.map(item => item.updated_at)).toEqual(body.items.map(item => item.updated_at).sort().reverse())
    const roof = body.items.find(item => item.title.startsWith('Roof leak'))
    expect(roof).toMatchObject({
      status: 'in_progress', author: { kind: 'resident', name: 'Chloe Dubois', user_id: 14 },
      labels: [{ name: 'Painting', color: '#e65909' }, { name: 'Roof', color: '#bd9670' }],
    })
    expect(roof?.comment_count).toBeGreaterThan(5)
    expect(roof?.attachment_count).toBe(6)
    const tiles = body.items.find(item => item.title.startsWith('Cracked tiles'))
    expect(tiles).toMatchObject({ author: ADMIN, labels: [], comment_count: 0, attachment_count: 0 })
    expect('description' in (tiles ?? {})).toBe(false)
  })

  test('sorts, filters and pages over every match', async () => {
    const byTitle = (await get<ActionPage>('/api/actions/items?scope=all&sort=title&direction=asc')).body
    expect(byTitle.total).toBe(19)
    expect(byTitle.items.map(item => item.title.toLowerCase())).toEqual(byTitle.items.map(item => item.title.toLowerCase()).sort())
    const byStatus = (await get<ActionPage>('/api/actions/items?scope=all&sort=status&direction=desc')).body.items
    expect(byStatus.map(item => ACTION_STATUSES.indexOf(item.status))).toEqual(byStatus.map(item => ACTION_STATUSES.indexOf(item.status)).sort((a, b) => b - a))
    expect((await get<ActionPage>('/api/actions/items?scope=closed')).body.items.every(item => ['done', 'discarded'].includes(item.status))).toBe(true)
    expect((await get<ActionPage>('/api/actions/items?status=done&scope=all')).body.items.map(item => item.status)).toEqual(['done', 'done', 'done'])
    const both = (await get<ActionPage>(`/api/actions/items?scope=all&label=${labelId('Roof')}&label=${labelId('Plumbing')}`)).body
    expect(both.items.map(item => item.title)).toEqual(['Gutter and downpipe replacement'])
    expect((await get<ActionPage>('/api/actions/items?scope=all&q=SKYLIGHT')).body.total).toBe(1)
    for (let index = 0; index < 5; index += 1) await demoRequest('POST', '/api/actions/items', { body: { title: `Extra ${index}` } })
    const second = (await get<ActionPage>('/api/actions/items?scope=all&page=2')).body
    expect(second).toMatchObject({ page: 2, pages: 2, total: 24 })
    expect(second.items).toHaveLength(4)
    expect((await get<ActionPage>('/api/actions/items?scope=all&page=3')).body).toMatchObject({ items: [], page: 3, pages: 2 })
  })

  test('refuses malformed filters like FastAPI', async () => {
    const labels = Array.from({ length: 21 }, (_, index) => `label=${index + 1}`).join('&')
    for (const query of ['page=0', 'label=-1', 'label=x', 'scope=invalid', 'status=invalid', 'sort=unsupported', 'direction=sideways', labels, `q=${'a'.repeat(201)}`]) {
      expect((await get(`/api/actions/items?${query}`)).status, query).toBe(422)
    }
    expect((await get('/api/actions/board?status=nope')).status).toBe(422)
  })
})

describe('actions', () => {
  test('creating normalizes the fields, reuses labels by name and records the history', async () => {
    const created = await demoRequest<ActionOut>('POST', '/api/actions/items', {
      body: { title: '  Paint the   bike room ', description: '  First line\r\nSecond line  ', labels: ['common AREAS', ' Bike   storage ', 'bike storage'] },
    })
    expect(created.status).toBe(201)
    expect(created.body).toMatchObject({
      title: 'Paint the bike room', description: 'First line\nSecond line', status: 'detected', author: OLIVIA, version: 1,
      created_at: NOW.toISOString(), updated_at: NOW.toISOString(), comment_count: 0, attachment_count: 0,
    })
    expect(created.body.labels).toEqual([
      { id: 10, name: 'Bike storage', color: null, version: 1 },
      { id: labelId('Common areas'), name: 'Common areas', color: null, version: 1 },
    ])
    expect((await get(`/api/actions/items/${created.body.id}`)).body).toEqual(created.body)
    const history = (await get<ActionHistoryPage>(`/api/actions/items/${created.body.id}/history`)).body
    expect(history.items).toEqual([{
      id: expect.any(Number), kind: 'created', author: OLIVIA, created_at: NOW.toISOString(), comment_id: null, attachment_id: null,
      changes: [
        { field: 'title', before: null, after: 'Paint the bike room' },
        { field: 'description', before: null, after: 'First line\nSecond line' },
        { field: 'status', before: null, after: 'detected' },
        { field: 'labels', before: null, after: ['Bike storage', 'Common areas'] },
      ],
    }])
  })

  test('edits record each changed field, refuse stale versions and ignore no-ops', async () => {
    const id = actionId('Bike storage')
    const path = `/api/actions/items/${id}`
    const before = (await get<ActionOut>(path)).body
    const saved = await demoRequest<ActionOut>('PATCH', path, { body: { version: before.version, status: 'quoting', labels: ['Common areas', 'Security'] } })
    expect(saved).toMatchObject({ status: 200, body: { status: 'quoting', version: before.version + 1, updated_at: NOW.toISOString() } })
    expect(saved.body.labels.map(label => label.name)).toEqual(['Common areas', 'Security'])
    const [event] = (await get<ActionHistoryPage>(`${path}/history`)).body.items
    expect(event).toMatchObject({
      kind: 'updated', author: OLIVIA,
      changes: [
        { field: 'status', before: 'detected', after: 'quoting' },
        { field: 'labels', before: ['Common areas'], after: ['Common areas', 'Security'] },
      ],
    })
    expect(await demoRequest('PATCH', path, { body: { version: before.version, title: 'Late' } })).toMatchObject({ status: 409, body: { code: 'action_stale' } })
    const same = await demoRequest<ActionOut>('PATCH', path, { body: { version: saved.body.version, title: saved.body.title } })
    expect(same.body).toEqual(saved.body)
    for (const body of [
      { version: saved.body.version }, { version: saved.body.version, title: null }, { version: saved.body.version, title: ' ' },
      { version: saved.body.version, status: 'unknown' }, { version: 0, title: 'x' }, { version: saved.body.version, title: 'x', extra: 1 },
      { version: saved.body.version, labels: Array.from({ length: 21 }, (_, index) => `L${index}`) },
    ]) {
      expect((await demoRequest('PATCH', path, { body })).status, JSON.stringify(body)).toBe(422)
    }
  })

  test('creation follows the ActionIn contract and the write header', async () => {
    for (const body of [
      {}, { title: '' }, { title: 'x'.repeat(201) }, { title: 'Ok', status: 'later' }, { title: 'Ok', labels: ['x'.repeat(101)] },
      { title: 'Ok', labels: 'Roof' }, { title: 'Ok', description: 'Bad\u0000text' }, { title: 'Ok', author: 'me' },
    ]) {
      expect(await demoRequest('POST', '/api/actions/items', { body }), JSON.stringify(body)).toMatchObject({ status: 422, body: { code: 'invalid_request' } })
    }
    expect(await demoRequest('POST', '/api/actions/items', { body: { title: 'Ok' }, mutationHeader: false })).toMatchObject({ status: 403, body: { code: 'invalid_origin' } })
    expect(await get('/api/actions/items/9999')).toMatchObject({ status: 404, body: { code: 'action_not_found' } })
    expect((await get('/api/actions/items/abc')).status).toBe(422)
  })

  test('residents and the administrator need a session, and the feature flag gates every route', async () => {
    const id = actionId('Roof leak')
    const routes = [
      '/api/actions/board', '/api/actions/items', '/api/actions/labels', `/api/actions/items/${id}`,
      `/api/actions/items/${id}/comments`, `/api/actions/items/${id}/attachments`, `/api/actions/items/${id}/history`,
    ]
    coreStore().features.actions = false
    for (const route of routes) expect(await get(route), route).toMatchObject({ status: 404, body: { code: 'actions_disabled' } })
    expect(await demoRequest('POST', '/api/actions/items', { body: { title: 'x' } })).toMatchObject({ status: 404, body: { code: 'actions_disabled' } })
    coreStore().features.actions = true
    await signOut()
    for (const route of routes) expect(await get(route), route).toMatchObject({ status: 401, body: { code: 'authentication_required' } })
    await adminLogin()
    const created = await demoRequest<ActionOut>('POST', '/api/actions/items', { body: { title: 'Checked by the administrator' } })
    expect(created).toMatchObject({ status: 201, body: { author: ADMIN } })
  })
})

describe('comments', () => {
  test('threads list every comment, newest first, withdrawn ones without their text', async () => {
    const cctv = (await get<ActionCommentPage>(`/api/actions/items/${actionId('CCTV')}/comments`)).body
    expect(cctv.items.map(comment => comment.id)).toEqual(cctv.items.map(comment => comment.id).sort((a, b) => b - a))
    const withdrawn = cctv.items.filter(comment => comment.withdrawn_at !== null)
    expect(withdrawn).toEqual([expect.objectContaining({ body: null, version: 2, author: { kind: 'resident', name: 'Daniel Mensah', user_id: 8 } })])
    expect(cctv.items.some(comment => comment.author.name === 'Noah Patel')).toBe(true)
    const roof = (await get<ActionCommentPage>(`/api/actions/items/${actionId('Roof leak')}/comments`)).body.items
    expect(roof.find(comment => comment.author.user_id === 6)).toMatchObject({ version: 2, body: expect.stringContaining('EUR 605') })
  })

  test('the author edits and withdraws their own comment; the history keeps every text', async () => {
    const id = actionId('Lift modernisation')
    const path = `/api/actions/items/${id}`
    const action = (await get<ActionOut>(path)).body
    const own = (await get<ActionCommentPage>(`${path}/comments`)).body.items.find(comment => comment.author.user_id === 6)
    if (!own) throw new Error('Olivia has a comment on the lift')
    const edited = await demoRequest<ActionCommentOut>('PATCH', `${path}/comments/${own.id}`, { body: { version: own.version, body: '  Updated figures\r\nsee the quotes.  ' } })
    expect(edited).toMatchObject({ status: 200, body: { body: 'Updated figures\nsee the quotes.', version: own.version + 1, updated_at: NOW.toISOString() } })
    expect(await demoRequest('PATCH', `${path}/comments/${own.id}`, { body: { version: own.version, body: 'Old' } })).toMatchObject({ status: 409, body: { code: 'action_stale' } })
    expect(await demoRequest('DELETE', `${path}/comments/${own.id}`, { body: { version: own.version + 1 } })).toMatchObject({ status: 204 })
    expect((await get<ActionCommentOut>(`${path}/comments/${own.id}`)).body).toMatchObject({ body: null, withdrawn_at: NOW.toISOString(), version: own.version + 2 })
    expect(await demoRequest('PATCH', `${path}/comments/${own.id}`, { body: { version: own.version + 2, body: 'Back' } })).toMatchObject({ status: 409, body: { code: 'action_content_withdrawn' } })
    const history = (await get<ActionHistoryPage>(`${path}/history`)).body.items
    expect(history.slice(0, 2)).toMatchObject([
      { kind: 'comment_withdrawn', comment_id: own.id, changes: [{ field: 'comment', before: 'Updated figures\nsee the quotes.', after: null }] },
      { kind: 'comment_edited', comment_id: own.id, changes: [{ field: 'comment', before: own.body, after: 'Updated figures\nsee the quotes.' }] },
    ])
    const after = (await get<ActionOut>(path)).body
    expect(after).toMatchObject({ version: action.version, comment_count: action.comment_count - 1, updated_at: NOW.toISOString() })
  })

  test("only the administrator changes someone else's comment", async () => {
    const path = `/api/actions/items/${actionId('Lift modernisation')}`
    const james = (await get<ActionCommentPage>(`${path}/comments`)).body.items.find(comment => comment.author.user_id === 1)
    if (!james) throw new Error('James has a comment on the lift')
    expect(await demoRequest('PATCH', `${path}/comments/${james.id}`, { body: { version: james.version, body: 'Mine now' } })).toMatchObject({ status: 403, body: { code: 'action_owner_required' } })
    expect(await demoRequest('DELETE', `${path}/comments/${james.id}`, { body: { version: james.version } })).toMatchObject({ status: 403 })
    await adminLogin()
    expect((await demoRequest('DELETE', `${path}/comments/${james.id}`, { body: { version: james.version } })).status).toBe(204)
    expect((await get<ActionHistoryPage>(`${path}/history`)).body.items[0]).toMatchObject({ kind: 'comment_withdrawn', author: ADMIN })
  })

  test('posting checks the text and the parent action', async () => {
    const path = `/api/actions/items/${actionId('Bike storage')}`
    const posted = await demoRequest<ActionCommentOut>('POST', `${path}/comments`, { body: { body: ' Count me in! ' } })
    expect(posted).toMatchObject({ status: 201, body: { body: 'Count me in!', author: OLIVIA, version: 1, withdrawn_at: null } })
    for (const body of [{ body: '' }, { body: '   ' }, { body: 'x'.repeat(10001) }, {}]) {
      expect((await demoRequest('POST', `${path}/comments`, { body })).status).toBe(422)
    }
    expect(await get(`/api/actions/items/${actionId('Roof leak')}/comments/${posted.body.id}`)).toMatchObject({ status: 404, body: { code: 'action_comment_not_found' } })
    expect(await demoRequest('POST', '/api/actions/items/9999/comments', { body: { body: 'Hi' } })).toMatchObject({ status: 404, body: { code: 'action_not_found' } })
  })
})

describe('PDF attachments', () => {
  test('lists active PDFs, newest first; withdrawn ones on request', async () => {
    const lift = `/api/actions/items/${actionId('Lift modernisation')}/attachments`
    const active = (await get<ActionAttachmentPage>(lift)).body
    expect(active.items.map(item => item.filename)).toEqual(['Annual lift inspection report.pdf', 'Quote - Riverside Elevators.pdf', 'Quote - Apex Lifts.pdf'])
    expect(active.items.every(item => item.withdrawn_at === null && item.purged_at === null && /^[0-9a-f]{64}$/.test(item.sha256))).toBe(true)
    const all = (await get<ActionAttachmentPage>(`${lift}?include_withdrawn=true`)).body
    expect(all.total).toBe(4)
    expect(all.items.find(item => item.withdrawn_at !== null)).toMatchObject({ filename: 'Quote - Apex Lifts (draft).pdf', version: 2 })
    expect((await get(`${lift}?include_withdrawn=maybe`)).status).toBe(422)
  })

  test('downloads and previews answer the PDF with its current name', async () => {
    const path = `/api/actions/items/${actionId('Accessible ramp')}/attachments`
    const drawings = (await get<ActionAttachmentPage>(path)).body.items.find(item => item.filename.startsWith('Ramp drawings'))
    if (!drawings) throw new Error('The ramp has its drawings')
    expect(drawings.filename).toBe('Ramp drawings (revision 2).pdf')
    for (const [action, kind] of [['download', 'attachment'], ['preview', 'inline']] as const) {
      const response = await demoFetch(new Request(demoUrl(`${path}/${drawings.id}/${action}`)))
      expect(response.status).toBe(200)
      expect(response.headers.get('Content-Type')).toBe('application/pdf')
      expect(response.headers.get('Content-Disposition')).toMatch(new RegExp(`^${kind}; filename\\*=utf-8''Ramp%20drawings%20`))
      const bytes = new Uint8Array(await response.arrayBuffer())
      expect(looksLikePdf(bytes)).toBe(true)
      expect(bytes.length).toBe(drawings.size)
    }
    expect((await demoFetch(new Request(demoUrl(`${path}/${drawings.id.toUpperCase()}/download`)))).status).toBe(200)
    expect(await get(`${path}/not-a-uuid/download`)).toMatchObject({ status: 422 })
    expect(await get(`/api/actions/items/${actionId('Roof leak')}/attachments/${drawings.id}/download`)).toMatchObject({ status: 404, body: { code: 'action_attachment_not_found' } })
    communityStore().attachments.find(item => item.id === drawings.id)!.purgedAt = NOW.toISOString()
    expect(await get(`${path}/${drawings.id}/preview`)).toMatchObject({ status: 410, body: { code: 'action_attachment_purged' } })
    expect((await get<ActionAttachmentOut>(`${path}/${drawings.id}`)).body.purged_at).toBe(NOW.toISOString())
  })

  test('the author renames and withdraws their PDF; withdrawn files stay downloadable', async () => {
    const id = actionId('Bike storage')
    const path = `/api/actions/items/${id}/attachments`
    const [catalogue] = (await get<ActionAttachmentPage>(path)).body.items
    expect(catalogue).toMatchObject({ filename: 'Bike rack catalogue.pdf', author: OLIVIA })
    const renamed = await demoRequest<ActionAttachmentOut>('PATCH', `${path}/${catalogue.id}`, { body: { version: 1, filename: '  Two-tier racks.PDF ' } })
    expect(renamed).toMatchObject({ status: 200, body: { filename: 'Two-tier racks.pdf', version: 2 } })
    expect((await get<ActionHistoryPage>(`/api/actions/items/${id}/history`)).body.items[0]).toMatchObject({
      kind: 'attachment_renamed', attachment_id: catalogue.id, changes: [{ field: 'filename', before: 'Bike rack catalogue.pdf', after: 'Two-tier racks.pdf' }],
    })
    expect(await demoRequest('PATCH', `${path}/${catalogue.id}`, { body: { version: 1, filename: 'Stale.pdf' } })).toMatchObject({ status: 409, body: { code: 'action_stale' } })
    for (const filename of ['', '.pdf', '../outside.pdf', 'line\nbreak.pdf', 'a'.repeat(252)]) {
      expect((await demoRequest('PATCH', `${path}/${catalogue.id}`, { body: { version: 2, filename } })).status, filename).toBe(422)
    }
    expect((await demoRequest('PATCH', `${path}/${catalogue.id}`, { body: { version: 2, filename: 'Bike rack catalogue' } })).body).toMatchObject({ filename: 'Bike rack catalogue.pdf', version: 3 })
    expect((await demoRequest('DELETE', `${path}/${catalogue.id}`, { body: { version: 3 } })).status).toBe(204)
    expect((await get<ActionAttachmentPage>(path)).body.items).toEqual([])
    expect(await demoRequest('PATCH', `${path}/${catalogue.id}`, { body: { version: 4, filename: 'Back.pdf' } })).toMatchObject({ status: 409, body: { code: 'action_content_withdrawn' } })
    expect((await demoFetch(new Request(demoUrl(`${path}/${catalogue.id}/download`)))).status).toBe(200)
    expect((await get<ActionHistoryPage>(`/api/actions/items/${id}/history`)).body.items[0]).toMatchObject({
      kind: 'attachment_withdrawn', changes: [{ field: 'filename', before: 'Bike rack catalogue.pdf', after: null }],
    })
  })

  test("residents cannot rename or withdraw someone else's PDF", async () => {
    const path = `/api/actions/items/${actionId('Roof leak')}/attachments`
    const [latest] = (await get<ActionAttachmentPage>(path)).body.items
    expect(await demoRequest('PATCH', `${path}/${latest.id}`, { body: { version: latest.version, filename: 'Mine.pdf' } })).toMatchObject({ status: 403, body: { code: 'action_owner_required' } })
    expect(await demoRequest('DELETE', `${path}/${latest.id}`, { body: { version: latest.version } })).toMatchObject({ status: 403 })
  })
})

describe('history', () => {
  test('pages the events of an action, newest first', async () => {
    const id = actionId('Roof leak')
    const events = communityStore().actionHistory.filter(event => event.actionId === id)
    const first = (await get<ActionHistoryPage>(`/api/actions/items/${id}/history`)).body
    expect(first).toMatchObject({ total: events.length, pages: Math.ceil(events.length / 20), page: 1 })
    expect(first.items[0].id).toBe(Math.max(...events.map(event => event.id)))
    const last = (await get<ActionHistoryPage>(`/api/actions/items/${id}/history?page=${first.pages}`)).body
    expect(last.items.at(-1)).toMatchObject({ kind: 'created', author: { name: 'Chloe Dubois' } })
    const update = first.items.concat(last.items).find(event => event.changes.some(change => change.field === 'description'))
    expect(update?.changes.map(change => change.field)).toEqual(['description', 'status', 'labels'])
  })
})

describe('labels', () => {
  test('readers search the label catalogue', async () => {
    const all = (await get<ActionLabelPage>('/api/actions/labels')).body
    expect(all.items.map(label => label.name)).toEqual(['Accessibility', 'Common areas', 'Energy', 'Garden', 'Lift', 'Painting', 'Plumbing', 'Roof', 'Security'])
    expect((await get<ActionLabelPage>('/api/actions/labels?q=%EF%BC%B2OO')).body.items.map(label => label.name)).toEqual(['Roof'])
    expect((await get<ActionLabelPage>(`/api/actions/labels?id=${labelId('Lift')}&id=${labelId('Roof')}`)).body.total).toBe(2)
    expect((await get(`/api/actions/labels?${Array.from({ length: 21 }, (_, index) => `id=${index + 1}`).join('&')}`)).status).toBe(422)
    expect((await get(`/api/actions/labels?q=${'a'.repeat(101)}`)).status).toBe(422)
  })

  test('the administrator renames or recolours a label for every action', async () => {
    const id = labelId('Lift')
    expect(await get(`/api/admin/action-labels/${id}`)).toMatchObject({ status: 401 })
    await adminLogin()
    const label = (await get<ActionLabelOut>(`/api/admin/action-labels/${id}`)).body
    const linked = communityStore().actions.filter(action => action.labelIds.includes(id)).map(action => ({ id: action.id, version: action.version }))
    const saved = await demoRequest<ActionLabelOut>('PATCH', `/api/admin/action-labels/${id}`, { body: { name: '  Elevator ', color: '#AABBCC', version: label.version } })
    expect(saved).toMatchObject({ status: 200, body: { id, name: 'Elevator', color: '#aabbcc', version: label.version + 1 } })
    for (const action of linked) {
      const current = (await get<ActionOut>(`/api/actions/items/${action.id}`)).body
      expect(current.version).toBe(action.version + 1)
      expect((await get<ActionHistoryPage>(`/api/actions/items/${action.id}/history`)).body.items[0]).toMatchObject({
        kind: 'updated', author: ADMIN,
        changes: [
          { field: 'labels', before: expect.arrayContaining(['Lift']), after: expect.arrayContaining(['Elevator']) },
          { field: 'label_color', before: 'Lift: #4963de', after: 'Elevator: #aabbcc' },
        ],
      })
    }
    expect(await demoRequest('PATCH', `/api/admin/action-labels/${id}`, { body: { name: 'Late', color: '#000000', version: label.version } })).toMatchObject({ status: 409, body: { code: 'action_label_stale' } })
    expect(await demoRequest('PATCH', `/api/admin/action-labels/${id}`, { body: { name: '\uff32\uff2f\uff2f\uff26', color: '#000000', version: label.version + 1 } }))
      .toMatchObject({ status: 409, body: { code: 'action_label_exists', fields: { name: 'action_label_exists' } } })
    expect(await demoRequest('PATCH', `/api/admin/action-labels/${id}`, { body: { name: ' ', color: 'red', version: label.version + 1 } }))
      .toMatchObject({ status: 422, body: { code: 'invalid_request', fields: { name: 'contact_tag_name_invalid', color: 'contact_tag_color_invalid' } } })
    expect((await demoRequest('PATCH', `/api/admin/action-labels/${id}`, { body: { name: 'Elevator', color: '#aabbcc', version: label.version + 1 } })).body).toEqual(saved.body)
    expect(await get('/api/admin/action-labels/9999')).toMatchObject({ status: 404, body: { code: 'action_label_not_found' } })
    expect((await get<ActionLabelPage>('/api/admin/action-labels?q=elev')).body.items).toEqual([saved.body])
  })

  test('the catalogue stays available to the administrator while actions are off', async () => {
    await adminLogin()
    coreStore().features.actions = false
    expect((await get<ActionLabelPage>('/api/admin/action-labels')).body.total).toBe(9)
    expect(await get('/api/actions/labels')).toMatchObject({ status: 404, body: { code: 'actions_disabled' } })
    const id = labelId('Garden')
    expect((await demoRequest('PATCH', `/api/admin/action-labels/${id}`, { body: { name: 'Gardens', color: '#2bccb4', version: 2 } })).status).toBe(200)
  })
})
