import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import type { ActionOut, DeleteImpact, EventOut, ImportOut, NotificationOut, NotificationsOut } from '../../api/schema.gen'
import { resetDemo } from '../store'
import { asAdministrator, demoRequest, signInAdmin } from '../testing'

// Thursday 29 October 2026, 12:00 in Madrid: the statements reach 26 October.
const NOW = new Date('2026-10-29T11:00:00Z')
const DAY = 86_400_000
let current = NOW

beforeEach(() => {
  current = NOW
  resetDemo({ now: () => current })
})
afterEach(() => resetDemo())

const bell = async () => (await demoRequest<NotificationsOut>('GET', '/api/notifications')).body
const ofKind = async (kind: NotificationOut['kind']) => (await bell()).items.filter(item => item.kind === kind)

/** Removes the statement of `month` (`YYYY-MM`) as Manage statements does. */
async function removeStatement(month: string) {
  const statements = (await demoRequest<ImportOut[]>('GET', '/api/admin/statements')).body
  const statement = statements.find(item => item.start_date.startsWith(month))!
  const { revision } = (await demoRequest<DeleteImpact>('GET', `/api/admin/statements/${statement.id}/removal`)).body
  expect(await demoRequest('DELETE', `/api/admin/statements/${statement.id}`, { body: { revision } })).toMatchObject({ status: 204 })
}

describe('notifications in the demo', () => {
  test('neighbors receive the news of the community, not the alerts of the administration', async () => {
    const { kinds, today } = await bell()
    expect(today).toBe('2026-10-29')
    expect(kinds).toEqual(['accounts_ready', 'action_changes', 'action_comments', 'event_changes', 'event_reminder']
      .map(kind => ({ kind, enabled: true })))
    expect(await demoRequest('PATCH', '/api/notifications/preferences', { body: { kind: 'statement_missing', enabled: false } }))
      .toMatchObject({ status: 403, body: { code: 'notification_kind_unavailable' } })
    // A section turned off takes its kinds away.
    await asAdministrator(() => demoRequest('PATCH', '/api/admin/settings/features/events', { body: { enabled: false } }))
    expect((await bell()).kinds.map(item => item.kind)).toEqual(['accounts_ready', 'action_changes', 'action_comments'])
    expect(await ofKind('event_changes')).toEqual([])
  })

  test('the news that came was read until three days before, and is forgotten after 90 days', async () => {
    const { items, unread } = await bell()
    expect(items.length).toBeGreaterThan(0)
    expect(unread).toBe(items.filter(item => !item.read).length)
    for (const item of items) {
      const age = NOW.getTime() - Date.parse(item.created_at)
      expect(age).toBeLessThanOrEqual(90 * DAY)
      expect(item.read || age <= 3 * DAY).toBe(true)
    }
  })

  test('the accounts of the previous month are told to everyone but the administrator who imports them', async () => {
    expect(await ofKind('accounts_ready')).toEqual([expect.objectContaining({
      params: { month: '2026-09' }, link: '/?start=2026-09-01&end=2026-09-30',
    })])
    await signInAdmin()
    expect(await ofKind('accounts_ready')).toEqual([])
    await removeStatement('2026-09')
    expect(await ofKind('accounts_ready')).toEqual([])
  })

  test('comments on an action tell who follows it, and commenting reads what was told', async () => {
    // The sample neighbor commented on the lift's action; Grace Liu asked two days ago, and the
    // president answered three hours ago.
    const [lift] = (await ofKind('action_comments')).filter(item => item.params.title.startsWith('Lift modernisation'))
    expect(lift).toMatchObject({ read: false, params: { comments: '2', attachments: '0', author: 'James Okafor' } })
    const path = `/api/actions/items/${lift.link.split('/').pop()}`
    expect(await demoRequest('POST', `${path}/comments`, { body: { body: 'A payment plan would help.' } })).toMatchObject({ status: 201 })
    expect((await ofKind('action_comments')).find(item => item.id === lift.id)).toMatchObject({ read: true })
    // The president, who created it, read Grace Liu's when he answered.
    const [told] = await asAdministrator(() => ofKind('action_comments'))
    expect(told).toMatchObject({
      link: lift.link, read: false, params: { comments: '1', attachments: '0', author: 'Olivia Bennett' },
    })
  })

  test('a new status of an action tells everyone else', async () => {
    const [lift] = (await ofKind('action_comments')).filter(item => item.params.title.startsWith('Lift modernisation'))
    const path = `/api/actions/items/${lift.link.split('/').pop()}`
    current = new Date(NOW.getTime() + 60_000)
    await asAdministrator(async () => {
      const { version } = (await demoRequest<ActionOut>('GET', path)).body
      expect(await demoRequest('PATCH', path, { body: { status: 'approved', version } })).toMatchObject({ status: 200 })
    })
    expect((await bell()).items[0]).toMatchObject({
      kind: 'action_changes', link: lift.link, read: false, created_at: current.toISOString(),
      params: { title: lift.params.title, status: 'approved', change: 'status' },
    })
  })

  test('events tell their news, and everyone is reminded a day before they start', async () => {
    const created = await asAdministrator(() => demoRequest<EventOut>('POST', '/api/events', {
      body: {
        title: 'Garden party', description: '', location: 'Garden', timezone: 'Europe/Madrid', all_day: false,
        starts_at: '2026-10-31T19:00:00', ends_at: '2026-10-31T22:00:00',
      },
    }))
    expect(created.status).toBe(201)
    const link = `/events/${created.body.id}`
    const params = { title: 'Garden party', day: '2026-10-31', time: '19:00', location: 'Garden' }
    const reminders = async () => (await ofKind('event_reminder')).filter(item => item.link === link)
    expect((await bell()).items[0]).toMatchObject({ kind: 'event_changes', link, read: false, params: { ...params, change: 'created' } })
    expect(await reminders()).toEqual([])
    // 24 hours before it starts: 19:00 in Madrid.
    current = new Date('2026-10-30T18:00:00Z')
    expect((await bell()).today).toBe('2026-10-30')
    expect(await reminders()).toEqual([expect.objectContaining({ params, read: false, created_at: current.toISOString() })])
    // Deleted, it is cancelled and its reminder goes.
    await asAdministrator(() => demoRequest('DELETE', `/api/events/${created.body.id}`, { body: { version: created.body.version } }))
    expect(await reminders()).toEqual([])
    expect((await ofKind('event_changes')).find(item => item.link === link)).toMatchObject({
      read: false, params: { ...params, change: 'cancelled' },
    })
  })

  test('administrators are told when the statement of the previous month is missing', async () => {
    await signInAdmin()
    expect((await bell()).kinds.map(item => item.kind)).toEqual([
      'statement_missing', 'accounts_ready', 'action_changes', 'action_comments', 'event_changes', 'event_reminder',
    ])
    // Without October's statement nothing is missing yet: September is the previous month.
    await removeStatement('2026-10')
    expect(await ofKind('statement_missing')).toEqual([])
    await removeStatement('2026-09')
    const [alert] = await ofKind('statement_missing')
    expect(alert).toEqual({
      id: alert.id, kind: 'statement_missing', params: { month: '2026-09' }, link: '/admin', created_at: NOW.toISOString(), read: false,
    })
    const unread = (await bell()).unread
    expect((await demoRequest<NotificationsOut>('POST', `/api/notifications/${alert.id}/read`)).body.unread).toBe(unread - 1)
    expect(await ofKind('statement_missing')).toEqual([{ ...alert, read: true }])
    const off = await demoRequest<NotificationsOut>('PATCH', '/api/notifications/preferences', {
      body: { kind: 'statement_missing', enabled: false },
    })
    expect(off.body.kinds[0]).toEqual({ kind: 'statement_missing', enabled: false })
    expect(off.body.items.filter(item => item.kind === 'statement_missing')).toEqual([])
    expect(await demoRequest('PATCH', '/api/notifications/preferences', { body: { kind: 'statement_missing', enabled: 'no' } }))
      .toMatchObject({ status: 422, body: { code: 'invalid_request' } })
    await demoRequest('PATCH', '/api/notifications/preferences', { body: { kind: 'statement_missing', enabled: true } })
    const dismissed = await demoRequest<NotificationsOut>('POST', `/api/notifications/${alert.id}/dismiss`)
    expect(dismissed.body.items.filter(item => item.kind === 'statement_missing')).toEqual([])
    expect(await demoRequest('POST', '/api/notifications/999999/read')).toMatchObject({ status: 404, body: { code: 'notification_not_found' } })
  })

  test('marking everything as read', async () => {
    expect((await bell()).unread).toBeGreaterThan(0)
    const read = (await demoRequest<NotificationsOut>('POST', '/api/notifications/read-all')).body
    expect(read.unread).toBe(0)
    expect(read.items.every(item => item.read)).toBe(true)
  })
})
