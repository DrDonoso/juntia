import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import type { ActionCommentOut, ActionOut, SearchOut, SearchResultsOut } from '../../api/schema.gen'
import { resetDemo } from '../store'
import { demoRequest, signInAdmin } from '../testing'
import { plainText, searchWords } from './search'

// Thursday 29 October 2026, midday (local time), like the other demo tests.
const NOW = new Date(2026, 9, 29, 12)

beforeEach(() => resetDemo({ now: () => NOW }))
afterEach(() => resetDemo())

async function search(q: string): Promise<SearchOut> {
  const { status, body } = await demoRequest<SearchOut>('GET', `/api/search?${new URLSearchParams({ q })}`)
  expect(status).toBe(200)
  return body
}

async function found(q: string): Promise<[string, string][]> {
  return (await search(q)).items.map(item => [item.kind, item.title])
}

async function only(q: string): Promise<SearchOut['items'][number]> {
  const { items } = await search(q)
  expect(items).toHaveLength(1)
  return items[0]
}

describe('the search box', () => {
  test('needs a text of 1 to 200 characters, and reads distinct words without case and accents', async () => {
    for (const path of ['/api/search', '/api/search?q=', `/api/search?q=${'x'.repeat(201)}`]) {
      expect(await demoRequest('GET', path)).toMatchObject({ status: 422, body: { code: 'invalid_request' } })
    }
    expect(await search('   ')).toEqual({ items: [], more: false })
    expect(searchWords(' Ascensor  ÁTICO ascensor ')).toEqual(['ascensor', 'atico'])
  })

  test('lists the best matches first, a few of each kind, with what each one is', async () => {
    const lift = await search('LIFT')
    expect(lift.items.slice(0, 3).map(item => [item.kind, item.title])).toEqual([
      ['action', 'Lift modernisation: controller, doors and cabin'], ['event', 'Lift inspection'],
      ['file', 'Lift maintenance contract.pdf'],
    ])
    expect(lift.more).toBe(true)
    const kinds = lift.items.map(item => item.kind)
    expect(Math.max(...[...new Set(kinds)].map(kind => kinds.filter(other => other === kind).length))).toBeLessThanOrEqual(5)
    // Words the title lacks are shown where they are: a description, a comment, a PDF, tags or a file's text.
    expect(lift.items.find(item => item.title === 'Pest control in the basement and bin store')?.excerpt).toEqual({
      text: 'I saw one in the lift lobby last night as well.', source: 'comment',
    })
    expect((await search('quote')).items.find(item => item.title === 'Facade painting')?.excerpt).toEqual({
      text: 'Quote - ColourCraft Decorators.pdf', source: 'attachment',
    })
    expect(await found('insurance')).toEqual([
      ['folder', 'Insurance'], ['file', 'Building insurance policy.pdf'],
      ['transaction', 'TRANSFER FROM HARBOR MUTUAL INSURANCE CLAIM HM-2026-0418 SETTLEMENT'],
      ['transaction', 'DIRECT DEBIT HARBOR MUTUAL INSURANCE POLICY HM-558201 ANNUAL PREMIUM'],
      ['contact', 'Claims line'], ['file', 'Minutes - ordinary meeting.pdf'],
    ])
    expect((await search('insurance')).items.at(-1)?.excerpt).toEqual({
      text: '…(8 in favour, 1 against). 2. Building insurance: renewed with Harbour Mutual. 3. Bike storage in the basement: a survey of the bikes in each…',
      source: 'text',
    })
  })

  test('finds neighbors and contacts by any field, phones as people write them', async () => {
    expect(await only('marcus northgate')).toMatchObject({
      kind: 'contact', title: 'Marcus Hill', company: 'Northgate Plumbing', email: 'marcus.hill@example.com', phone: '+442079460102',
    })
    expect(await only('plumbing hill emergency')).toMatchObject({ title: 'Marcus Hill', excerpt: { text: 'Emergency, Plumbing', source: 'tags' } })
    expect(await only('(20) 7946-0102')).toMatchObject({ kind: 'contact', title: 'Marcus Hill' })
    expect((await search('olivia')).items[0]).toEqual({
      kind: 'neighbor', id: 6, title: 'Olivia Bennett', email: 'olivia.bennett@example.com', phone: expect.stringMatching(/^\+44/),
      dwelling: '2B', is_president: false, excerpt: null,
    })
    expect((await search('james okafor')).items[0]).toMatchObject({ kind: 'neighbor', title: 'James Okafor', is_president: true })
  })

  test('an action is found by its own fields or by one of its comments, whose words do not add up', async () => {
    const action = (await demoRequest<ActionOut>('POST', '/api/actions/items', { body: { title: 'Paint the zebra crossing' } })).body
    const path = `/api/actions/items/${action.id}/comments`
    const comment = (await demoRequest<ActionCommentOut>('POST', path, { body: { body: 'Use **turquoise** paint' } })).body
    expect(await only('turquoise paint')).toMatchObject({
      kind: 'action', id: action.id, excerpt: { text: 'Use turquoise paint', source: 'comment' },
    })
    expect(await found('zebra turquoise')).toEqual([])
    // What was withdrawn is no longer found.
    const withdrawn = await demoRequest('DELETE', `${path}/${comment.id}`, { body: { version: comment.version } })
    expect(withdrawn.status).toBe(204)
    expect(await found('turquoise')).toEqual([])
  })

  test('sections that are off are not searched', async () => {
    await signInAdmin()
    for (const feature of ['actions', 'events', 'documents']) {
      const response = await demoRequest('PATCH', `/api/admin/settings/features/${feature}`, { body: { enabled: false } })
      expect(response.status).toBe(200)
    }
    expect(new Set((await search('lift')).items.map(item => item.kind))).toEqual(new Set(['contact', 'transaction']))
  })

  test('reads Markdown as text', () => {
    expect(plainText('Presupuesto **pendiente** de [Cerrajería](https://example.org/a_b)')).toBe('Presupuesto pendiente de Cerrajería')
    expect(plainText('Mira ![foto del portal](/api/actions/images/1234) y `nota_final`')).toBe('Mira foto del portal y nota_final')
    expect(plainText('# Orden del día\n\n- Cuotas\n1. Obras\n> - [x] _Hecho_ ~~antes~~\n\nfin')).toBe('Orden del día Cuotas Obras Hecho antes fin')
    expect(plainText('2 * 3 = 6')).toBe('2 * 3 = 6')
  })
})

async function results(params: Record<string, string>): Promise<SearchResultsOut> {
  const { status, body } = await demoRequest<SearchResultsOut>('GET', `/api/search/results?${new URLSearchParams(params)}`)
  expect(status).toBe(200)
  return body
}

describe('the page of results', () => {
  test('needs a search, a known kind and a page from 1 to 500', async () => {
    for (const query of ['', 'q=lift&kind=statement', 'q=lift&kind=transaction&page=0', 'q=lift&page=501', 'q=lift&page=two']) {
      expect(await demoRequest('GET', `/api/search/results?${query}`)).toMatchObject({ status: 422, body: { code: 'invalid_request' } })
    }
    expect(await results({ q: '   ' })).toEqual({ counts: [], items: [], page: 1, pages: 0 })
  })

  test('counts every kind and lists the best few of each, the kinds with the best matches first', async () => {
    const overview = await results({ q: 'lift' })
    expect(overview.counts.map(count => count.kind)).toEqual(['action', 'event', 'file', 'contact', 'transaction'])
    // Titles that start with the search first (an action, an event, a file), then titles with the word.
    const groups = overview.items.map(item => item.kind).filter((kind, index, kinds) => kind !== kinds[index - 1])
    expect(groups).toEqual(['action', 'event', 'file', 'contact', 'transaction'])
    for (const { kind, total } of overview.counts) {
      expect(overview.items.filter(item => item.kind === kind)).toHaveLength(Math.min(total, 5))
    }
    expect(overview.items[0].title).toBe('Lift modernisation: controller, doors and cabin')
    expect([overview.page, overview.pages]).toEqual([1, 1])
  })

  test('pages through one kind, newest transactions first, with every count for the filters', async () => {
    const overview = await results({ q: 'direct debit' })
    const total = overview.counts.find(count => count.kind === 'transaction')?.total ?? 0
    expect(total).toBeGreaterThan(20)
    const first = await results({ q: 'direct debit', kind: 'transaction' })
    const second = await results({ q: 'direct debit', kind: 'transaction', page: '2' })
    expect(first.counts).toEqual(overview.counts)
    expect([first.page, first.pages, first.items.length]).toEqual([1, Math.ceil(total / 20), 20])
    expect(second.items.length).toBe(Math.min(total - 20, 20))
    const dates = [...first.items, ...second.items].map(item => item.kind === 'transaction' ? item.booking_date : '')
    expect(dates).toEqual([...dates].sort().reverse())
    expect(new Set([...first.items, ...second.items].map(item => item.id)).size).toBe(first.items.length + second.items.length)
    expect(await results({ q: 'direct debit', kind: 'transaction', page: '500' })).toEqual({
      counts: overview.counts, items: [], page: 500, pages: first.pages,
    })
    // A kind without matches has nothing to page through.
    expect(await results({ q: 'direct debit', kind: 'neighbor' })).toEqual({ counts: overview.counts, items: [], page: 1, pages: 0 })
  })

  test('sections that are off are neither counted nor listed', async () => {
    await signInAdmin()
    for (const feature of ['actions', 'events', 'documents']) {
      expect((await demoRequest('PATCH', `/api/admin/settings/features/${feature}`, { body: { enabled: false } })).status).toBe(200)
    }
    expect((await results({ q: 'lift' })).counts.map(count => count.kind)).toEqual(['contact', 'transaction'])
    expect(await results({ q: 'lift', kind: 'event' })).toMatchObject({ items: [], pages: 0 })
  })
})
