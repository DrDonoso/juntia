import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import type { DeleteImpact, ImportOut, NotificationsOut } from '../../api/schema.gen'
import { resetDemo } from '../store'
import { demoRequest, signInAdmin } from '../testing'

// Thursday 29 October 2026, midday (local time): the statements reach 26 October.
const NOW = new Date(2026, 9, 29, 12, 0)

beforeEach(() => resetDemo({ now: () => NOW }))
afterEach(() => resetDemo())

const bell = async () => (await demoRequest<NotificationsOut>('GET', '/api/notifications')).body

/** Removes the statement of `month` (`YYYY-MM`) as Manage statements does. */
async function removeStatement(month: string) {
  const statements = (await demoRequest<ImportOut[]>('GET', '/api/admin/statements')).body
  const statement = statements.find(item => item.start_date.startsWith(month))!
  const { revision } = (await demoRequest<DeleteImpact>('GET', `/api/admin/statements/${statement.id}/removal`)).body
  expect(await demoRequest('DELETE', `/api/admin/statements/${statement.id}`, { body: { revision } })).toMatchObject({ status: 204 })
}

describe('notifications in the demo', () => {
  test('the sample neighbor receives none and cannot choose them', async () => {
    expect(await bell()).toEqual({ kinds: [], unread: 0, items: [] })
    expect(await demoRequest('PATCH', '/api/notifications/preferences', { body: { kind: 'statement_missing', enabled: false } }))
      .toMatchObject({ status: 403, body: { code: 'notification_kind_unavailable' } })
  })

  test('administrators are told when the statement of the previous month is missing', async () => {
    await signInAdmin()
    expect(await bell()).toEqual({ kinds: [{ kind: 'statement_missing', enabled: true }], unread: 0, items: [] })
    // Without October's statement nothing is missing yet: September is the previous month.
    await removeStatement('2026-10')
    expect((await bell()).items).toEqual([])
    await removeStatement('2026-09')
    const { items: [alert], unread } = await bell()
    expect({ alert, unread }).toEqual({
      alert: {
        id: 1, kind: 'statement_missing', params: { month: '2026-09' }, link: '/admin', created_at: NOW.toISOString(), read: false,
      },
      unread: 1,
    })
    expect((await demoRequest<NotificationsOut>('POST', '/api/notifications/1/read')).body).toMatchObject({
      unread: 0, items: [{ id: 1, read: true }],
    })
    const off = await demoRequest<NotificationsOut>('PATCH', '/api/notifications/preferences', {
      body: { kind: 'statement_missing', enabled: false },
    })
    expect(off.body).toEqual({ kinds: [{ kind: 'statement_missing', enabled: false }], unread: 0, items: [] })
    expect(await demoRequest('PATCH', '/api/notifications/preferences', { body: { kind: 'statement_missing', enabled: 'no' } }))
      .toMatchObject({ status: 422, body: { code: 'invalid_request' } })
    await demoRequest('PATCH', '/api/notifications/preferences', { body: { kind: 'statement_missing', enabled: true } })
    expect((await demoRequest<NotificationsOut>('POST', '/api/notifications/1/dismiss')).body.items).toEqual([])
    expect((await bell()).items).toEqual([])
    expect(await demoRequest('POST', '/api/notifications/2/read')).toMatchObject({ status: 404, body: { code: 'notification_not_found' } })
  })
})
