import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import type { ActionChange, EventSnapshot } from '../../api/schema.gen'
import { paletteColor } from '../../contact-tags'
import { RESIDENTS } from '../cast'
import { looksLikePdf } from '../core'
import { resetDemo } from '../store'
import { communityStore } from '../store/community'
import { ACTION_STATUSES, actionLabels, attachmentName } from '../store/community-actions'
import { contactSnapshot } from '../store/community-contacts'
import { eventSnapshot } from '../store/community-events'
import type { ActionStatus, CommunityState, DemoAction } from '../store/community-model'
import { sha256Hex } from '../store/community-sha256'
import { zonedDay } from '../store/community-time'

// Thursday 29 October 2026, midday (local time), like the other demo tests.
const NOW = new Date(2026, 9, 29, 12)

beforeEach(() => resetDemo({ now: () => NOW }))
afterEach(() => resetDemo())

/** The scenario without the PDF bytes, as JSON (comparable across builds). */
function snapshot(state: CommunityState): string {
  return JSON.stringify({ ...state, attachments: state.attachments.map(({ bytes, ...rest }) => ({ ...rest, bytes: bytes.length })), sequences: null, random: null })
}

function allTimestamps(state: CommunityState): string[] {
  return [
    ...state.actions.flatMap(item => [item.createdAt, item.updatedAt]),
    ...state.comments.flatMap(item => [item.createdAt, item.updatedAt, item.withdrawnAt ?? item.createdAt]),
    ...state.attachments.flatMap(item => [item.createdAt, item.withdrawnAt ?? item.createdAt]),
    ...state.actionHistory.map(item => item.createdAt),
    ...state.events.flatMap(item => [item.createdAt, item.updatedAt, item.deletedAt ?? item.createdAt]),
    ...state.eventHistory.map(item => item.createdAt),
    ...state.contacts.flatMap(item => [item.createdAt, item.updatedAt, item.deletedAt ?? item.createdAt]),
    ...state.contactHistory.map(item => item.createdAt),
  ]
}

function unique(values: readonly (number | string)[]): boolean {
  return new Set(values).size === values.length
}

describe('the community scenario', () => {
  test('is the same on every build of the same day', () => {
    const first = snapshot(communityStore())
    resetDemo({ now: () => NOW })
    expect(snapshot(communityStore())).toBe(first)
  })

  test('fills every column of the board and uses every label', () => {
    const { actions, labels } = communityStore()
    expect(actions.length).toBeGreaterThanOrEqual(18)
    for (const status of ACTION_STATUSES) expect(actions.filter(action => action.status === status).length, status).toBeGreaterThanOrEqual(2)
    expect(labels.map(label => label.name).sort()).toEqual([
      'Accessibility', 'Common areas', 'Energy', 'Garden', 'Lift', 'Painting', 'Plumbing', 'Roof', 'Security',
    ])
    for (const label of labels) expect(actions.some(action => action.labelIds.includes(label.id)), label.name).toBe(true)
    expect(labels.filter(label => label.color === null).map(label => label.name)).toEqual(['Common areas'])
    // Every label looks different, including the colour the app derives for uncoloured ones.
    const colours = labels.map(label => label.color ?? paletteColor(label.name))
    expect(new Set(colours).size).toBe(colours.length)
  })

  test('has unique ids, and its sequences continue after them', () => {
    const state = communityStore()
    const tables = [
      [state.labels, state.sequences.label], [state.actions, state.sequences.action], [state.comments, state.sequences.comment],
      [state.actionHistory, state.sequences.actionHistory], [state.events, state.sequences.event],
      [state.eventHistory, state.sequences.eventHistory], [state.contactTags, state.sequences.contactTag],
      [state.contacts, state.sequences.contact], [state.contactHistory, state.sequences.contactHistory],
    ] as const
    for (const [rows, sequence] of tables) {
      const ids = rows.map(row => row.id)
      expect(unique(ids)).toBe(true)
      expect(sequence.current).toBe(Math.max(...ids))
    }
    expect(unique(state.attachments.map(item => item.id))).toBe(true)
    expect(state.attachments.every(item => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(item.id))).toBe(true)
    expect(unique(state.events.map(item => item.calendarUid))).toBe(true)
  })

  test('happened in the past, with ids in chronological order', () => {
    for (const time of [new Date(2026, 9, 29, 0, 30), NOW, new Date(2026, 9, 29, 23, 50), new Date(2027, 2, 28, 1, 0)]) {
      resetDemo({ now: () => time })
      const state = communityStore()
      expect(allTimestamps(state).every(value => Date.parse(value) <= time.getTime())).toBe(true)
      for (const rows of [state.actions, state.actionHistory, state.eventHistory, state.contactHistory, state.events, state.contacts]) {
        const dates = [...rows].sort((a, b) => a.id - b.id).map(row => row.createdAt)
        expect(dates).toEqual([...dates].sort())
      }
    }
  })

  test('history replays to the current actions', () => {
    const state = communityStore()
    for (const action of state.actions) {
      const events = state.actionHistory.filter(event => event.actionId === action.id)
      const [created, ...later] = events
      expect(created.kind).toBe('created')
      expect(created.createdAt).toBe(action.createdAt)
      expect(created.author).toEqual(action.author)
      const current: Record<string, ActionChange['after']> = Object.fromEntries(created.changes.map(change => [change.field, change.after]))
      for (const event of later.filter(item => item.kind === 'updated')) {
        for (const change of event.changes) {
          if (change.field === 'label_color') continue
          expect(change.before, `${action.title}: ${change.field}`).toEqual(current[change.field])
          current[change.field] = change.after
        }
      }
      expect(current).toEqual({
        title: action.title, description: action.description, status: action.status,
        labels: actionLabels(state, action).map(label => label.name),
      })
      expect(action.version).toBe(1 + later.filter(event => event.kind === 'updated').length)
      expect(action.updatedAt).toBe(events.at(-1)?.createdAt)
    }
  })

  test('comments and PDFs match their history', () => {
    const state = communityStore()
    for (const comment of state.comments) {
      const events = state.actionHistory.filter(event => event.commentId === comment.id)
      expect(events[0]).toMatchObject({ kind: 'comment_added', actionId: comment.actionId, createdAt: comment.createdAt, author: comment.author })
      let body = events[0].changes[0].after
      for (const event of events.slice(1)) {
        expect(event.changes[0].before).toBe(body)
        body = event.kind === 'comment_withdrawn' ? body : event.changes[0].after
      }
      expect(body).toBe(comment.body)
      expect(comment.version).toBe(events.length)
      expect(comment.withdrawnAt).toBe(events.find(event => event.kind === 'comment_withdrawn')?.createdAt ?? null)
    }
    for (const attachment of state.attachments) {
      const events = state.actionHistory.filter(event => event.attachmentId === attachment.id)
      expect(events[0].kind).toBe('attachment_added')
      expect(events[0].changes).toEqual([
        { field: 'filename', before: null, after: attachment.filename },
        { field: 'size', before: null, after: String(attachment.size) },
      ])
      const renames = events.filter(event => event.kind === 'attachment_renamed')
      expect(attachmentName(attachment)).toBe(renames.at(-1)?.changes[0].after ?? attachment.filename)
      expect(attachment.version).toBe(events.length)
      expect(attachment.size).toBe(attachment.bytes.length)
      expect(attachment.sha256).toBe(sha256Hex(attachment.bytes))
      expect(looksLikePdf(attachment.bytes)).toBe(true)
      expect(attachment.purgedAt).toBeNull()
    }
    const withdrawn = (rows: readonly { withdrawnAt: string | null }[]) => rows.filter(row => row.withdrawnAt !== null).length
    expect(withdrawn(state.comments)).toBe(1)
    // The storage page's candidates for a purge: withdrawn PDFs of different authors.
    const withdrawnPdfs = state.attachments.filter(attachment => attachment.withdrawnAt !== null)
    expect(withdrawnPdfs.map(attachment => attachment.author.name).sort()).toEqual(['Daniel Mensah', 'Grace Liu', 'Technical administrator'])
    expect(state.comments.filter(comment => comment.version > 1 && comment.withdrawnAt === null).length).toBeGreaterThanOrEqual(3)
    expect(state.actionHistory.some(event => event.kind === 'attachment_renamed')).toBe(true)
    expect(state.actionHistory.some(event => event.changes.some(change => change.field === 'label_color'))).toBe(true)
  })

  test('authors come from the cast, and the visitor owns some of the content', () => {
    const state = communityStore()
    const authors = [
      ...state.actions, ...state.comments, ...state.attachments, ...state.actionHistory, ...state.events, ...state.eventHistory,
      ...state.contactHistory,
    ].map(row => row.author)
    for (const author of authors) {
      if (author.kind === 'administrator') expect(author).toEqual({ kind: 'administrator', name: 'Technical administrator', user_id: null })
      else expect(RESIDENTS.find(resident => resident.id === author.user_id)?.name).toBe(author.name)
    }
    const visitor = (rows: readonly { author: { user_id: number | null } }[]) => rows.filter(row => row.author.user_id === 6).length
    expect(visitor(state.actions)).toBeGreaterThan(0)
    expect(visitor(state.comments)).toBeGreaterThanOrEqual(3)
    expect(visitor(state.attachments)).toBeGreaterThan(0)
  })

  test('events cover the past, today and the coming weeks, with coherent dates', () => {
    const state = communityStore()
    const today = zonedDay(NOW.getTime())
    expect(state.events.length).toBeGreaterThanOrEqual(14)
    for (const event of state.events) {
      if (event.allDay) {
        expect(event.startsAt ?? event.endsAt).toBeNull()
        expect((event.startsOn ?? '') < (event.endsOn ?? '')).toBe(true)
      } else {
        expect(event.startsOn ?? event.endsOn).toBeNull()
        expect(Date.parse(event.startsAt ?? '')).toBeLessThan(Date.parse(event.endsAt ?? ''))
      }
      if (event.actionId !== null) expect(state.actions.some(action => action.id === event.actionId)).toBe(true)
    }
    const timed = state.events.filter(event => !event.allDay)
    const allDay = state.events.filter(event => event.allDay)
    expect(timed.some(event => Date.parse(event.endsAt ?? '') < NOW.getTime())).toBe(true)
    expect(timed.some(event => Date.parse(event.startsAt ?? '') > NOW.getTime())).toBe(true)
    expect(allDay.some(event => (event.startsOn ?? '') < today && (event.endsOn ?? '') > today)).toBe(true)
    expect(allDay.some(event => event.startsOn === today)).toBe(true)
    expect(state.events.filter(event => event.deletedAt !== null)).toHaveLength(1)
    expect(state.events.filter(event => event.actionId !== null).length).toBeGreaterThanOrEqual(5)
  })

  test('event history replays to the current events', () => {
    const state = communityStore()
    // Snapshots keep the action's title of their time: compare the linked action by id.
    const linked = (value: EventSnapshot | null | undefined) => value && { ...value, action: value.action?.id ?? null }
    for (const event of state.events) {
      const changes = state.eventHistory.filter(change => change.eventId === event.id)
      expect(changes[0]).toMatchObject({ kind: 'created', before: null, createdAt: event.createdAt, author: event.author })
      for (const [index, change] of changes.entries()) {
        if (index > 0) expect(linked(change.before)).toEqual(linked(changes[index - 1].after))
      }
      const last = changes.at(-1)
      expect(linked(last?.kind === 'deleted' ? last.before : last?.after)).toEqual(linked(eventSnapshot(state, event, true)))
      expect(event.version).toBe(changes.length)
      expect(event.deletedAt).toBe(changes.find(change => change.kind === 'deleted')?.createdAt ?? null)
    }
    const inspection = state.eventHistory.find(change => change.after?.title === 'Lift inspection')
    expect(inspection?.after?.action?.title).toBe('Lift modernisation')
  })

  test('contacts use fictional details, and their history replays to them', () => {
    const state = communityStore()
    expect(state.contacts.filter(contact => contact.deletedAt === null).length).toBeGreaterThanOrEqual(15)
    expect(state.contacts.filter(contact => contact.deletedAt !== null)).toHaveLength(2)
    expect(state.contactTags.length).toBeGreaterThanOrEqual(8)
    for (const tag of state.contactTags) expect(tag.color).toMatch(/^#[0-9a-f]{6}$/)
    expect(new Set(state.contactTags.map(tag => tag.color)).size).toBe(state.contactTags.length)
    for (const contact of state.contacts) {
      if (contact.email !== null) expect(contact.email).toMatch(/^[a-z.]+@example\.(com|org)$/)
      if (contact.phone) expect(contact.phone).toMatch(/^\+4420794600\d{2}$|^\+442079460[0-9]{3}$/)
      expect(contact.email ?? contact.phone).toBeTruthy()
      for (const id of contact.tagIds) expect(state.contactTags.some(tag => tag.id === id)).toBe(true)
      const changes = state.contactHistory.filter(change => change.contactId === contact.id)
      expect(changes[0]).toMatchObject({ kind: 'created', before: null, createdAt: contact.createdAt })
      for (const [index, change] of changes.entries()) {
        if (index > 0) expect(change.before).toEqual(changes[index - 1].after)
      }
      const last = changes.at(-1)
      const current = contactSnapshot(state, contact)
      // Snapshots keep the tags as they were: compare the tag ids only.
      const ids = (value: typeof current | null | undefined) => value && { ...value, tags: value.tags.map(tag => tag.id) }
      expect(ids(last?.kind === 'deleted' ? last.before as typeof current : last?.after as typeof current)).toEqual(ids(current))
      expect(contact.version).toBe(changes.length)
    }
    const tagChanges = state.contactHistory.filter(change => change.tagId !== null)
    expect(tagChanges.filter(change => change.kind === 'created')).toHaveLength(state.contactTags.length)
    expect(tagChanges.filter(change => change.kind === 'updated')).toEqual([
      expect.objectContaining({ before: { name: 'Building', color: '#d77089' }, after: { name: 'Building works', color: '#d77089' } }),
    ])
  })

  test('is written in English without Spanish-specific characters', () => {
    const text = snapshot(communityStore())
    expect(text).not.toMatch(/[áéíóúñ¿¡ÁÉÍÓÚÑ]/)
  })

  test('statuses of the board follow the backend order', () => {
    const order: readonly ActionStatus[] = ['detected', 'quoting', 'voting', 'approved', 'ordered', 'in_progress', 'done', 'discarded']
    expect(ACTION_STATUSES).toEqual(order)
    const byStatus = (action: DemoAction) => ACTION_STATUSES.indexOf(action.status)
    expect(communityStore().actions.map(byStatus).every(index => index >= 0)).toBe(true)
  })
})
