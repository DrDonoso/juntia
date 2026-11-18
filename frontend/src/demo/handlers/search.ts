/**
 * The search box at the top of every page (src/juntia/search.py): actions, events, shared
 * documents, neighbors, contacts and bank transactions at once, read from the stores of the other
 * domains. Every word must appear in an item, in any order and in any of its fields, ignoring case
 * and accents; an action is also found by one of its comments or PDFs, and a file by its text.
 * Titles that start with the search come first, then titles with every word, then the words
 * elsewhere, and files found only by their text last: a few of each kind, and a few in all. The
 * page of results counts every kind and lists the best few of each, or every item of one kind.
 */
import type { SearchExcerpt, SearchOut, SearchResultsOut } from '../../api/schema.gen'
import { DemoApiError, http, now, nowIso, queryInt, route, type HttpHandler } from '../core'
import { coreStore } from '../store/core'
import { communityStore } from '../store/community'
import { hasEnded, localStart } from '../store/community-events'
import { compareText } from '../store/community-model'
import { casefold, foldText } from '../store/community-text'
import { COMMUNITY_TIME_ZONE, zonedDay } from '../store/community-time'
import { financeStore } from '../store/finance'
import { collapse, money } from '../store/finance-ledger'
import { peopleStore } from '../store/people'
import { nameKey } from '../store/shared-document-files'
import { locateText, textSurroundings } from '../store/shared-document-text'
import { currentVersion, folderPath, readTexts, sharedDocumentsStore } from '../store/shared-documents'

const MAX_WORDS = 10
const PER_KIND = 5
const LIMIT = 20
/** The page of results: one kind, so many at a time, up to so many pages. */
const PAGE_SIZE = 20
const MAX_PAGE = 500
const EXCERPT_BEFORE = 40
const EXCERPT_AFTER = 100
/** Equally good matches are listed in this order of their kinds. */
const KINDS = ['action', 'event', 'folder', 'file', 'neighbor', 'contact', 'transaction'] as const

type Hit = SearchOut['items'][number]
type SearchKind = typeof KINDS[number]
/** 0: the title starts with the search; 1: the title has every word; 2: elsewhere; 3: only in a file's text. */
interface Found { rank: number; hit: Hit }
/** The items found of one kind, best first: those of the window asked for, whether more follow, and how many match. */
interface Kind { found: Found[]; more: boolean; total: number }
/** Which items of a kind to read, best first. */
interface Window { offset: number; limit: number }
/** The box's list: the best few of each kind. */
const PREVIEW: Window = { offset: 0, limit: PER_KIND }
interface Source { text: string; name: SearchExcerpt['source']; markdown?: boolean }

/** `search_words`: the distinct words of the search, without case and accents. */
export function searchWords(q: string): string[] {
  return [...new Set(foldText(q).split(/\s+/u).filter(Boolean))].slice(0, MAX_WORDS)
}

/** `phone_digits`: a word written like a phone number (600-123-456), as phones are kept. */
function phoneDigits(word: string): string | null {
  const digits = word.replace(/[().-]/g, '')
  return digits !== word && /^\+?[0-9]+$/.test(digits) ? digits : null
}

/** `every_word`: every word is in the texts; one written like a phone number may be in the phone instead. */
function everyWord(texts: readonly string[], words: readonly string[], phone?: string): boolean {
  const key = foldText(texts.join('\n'))
  return words.every(word => {
    const digits = phone === undefined ? null : phoneDigits(word)
    return key.includes(word) || digits !== null && phone !== undefined && phone.includes(digits)
  })
}

function rank(title: string, words: readonly string[], otherwise = 2): number {
  const key = foldText(title)
  if (key.startsWith(words.join(' '))) return 0
  return words.every(word => key.includes(word)) ? 1 : otherwise
}

/** The words that the title does not show. */
function lacking(title: string, words: readonly string[]): string[] {
  const key = foldText(title)
  return words.filter(word => !key.includes(word))
}

const WORD = '[\\p{L}\\p{N}_]'
// Linear like the server's: link texts and addresses stop at the next bracket or parenthesis, and
// emphasis takes at most three marks.
const MARKDOWN_IMAGE = /!\[([^[\]]*)\]\([^()]*\)/g
const MARKDOWN_LINK = /\[([^[\]]*)\]\([^()]*\)/g
const MARKDOWN_LINE = /^[ \t]*(?:>[ \t]?)*(?:#{1,6}[ \t]+|(?:[-*+]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?)?/gm
const MARKDOWN_MARKS = /\*\*|__|~~|`+/g
const MARKDOWN_EMPHASIS = new RegExp(`(?<!${WORD})[*_]{1,3}(?=${WORD})|(?<=${WORD})[*_]{1,3}(?!${WORD})`, 'gu')

/** `plain_text`: what a Markdown text reads like, without marks or the addresses of links. */
export function plainText(markdown: string): string {
  const text = markdown.replace(MARKDOWN_IMAGE, '$1').replace(MARKDOWN_LINK, '$1').replace(MARKDOWN_LINE, '')
  return collapse(text.replace(MARKDOWN_MARKS, '').replace(MARKDOWN_EMPHASIS, ''))
}

/** `first_excerpt`: the words around the first of them in the first text that has any. */
function firstExcerpt(sources: readonly Source[], words: readonly string[]): SearchExcerpt | null {
  if (!words.length) return null
  for (const source of sources) {
    const text = source.markdown ? plainText(source.text) : collapse(source.text)
    const found = locateText(text, words)
    if (found) {
      const part = textSurroundings(text, found[0], found[1], EXCERPT_BEFORE, EXCERPT_AFTER)
      return { text: part.before + part.match + part.after, source: source.name }
    }
  }
  return null
}

/** Most recent first, then the highest id, like `ORDER BY ... DESC, id DESC`. */
const latest = <T extends { id: number }>(at: (item: T) => string) => (a: T, b: T) => compareText(at(b), at(a)) || b.id - a.id

function kind<T>(items: T[], hit: (item: T) => Found, window: Window): Kind {
  const end = window.offset + window.limit
  return { found: items.slice(window.offset, end).map(hit), more: items.length > end, total: items.length }
}

function findActions(words: string[], window: Window): Kind {
  const state = communityStore()
  const labelNames = (labelIds: readonly number[]) => labelIds.flatMap(id => state.labels.filter(label => label.id === id))
    .sort((a, b) => compareText(casefold(a.name), casefold(b.name))).map(label => label.name)
  const comments = state.comments.filter(comment => comment.withdrawnAt === null).sort((a, b) => b.id - a.id)
  const pdfs = state.attachments.filter(attachment => attachment.withdrawnAt === null)
    .sort((a, b) => compareText(b.createdAt, a.createdAt) || compareText(b.id, a.id))
  const pdfName = (pdf: typeof pdfs[number]) => pdf.displayFilename ?? pdf.filename
  const found = state.actions.flatMap(action => {
    const inFields = everyWord([action.title, action.description, labelNames(action.labelIds).join('\n')], words)
    const comment = comments.find(item => item.actionId === action.id && everyWord([item.body], words))
    const pdf = pdfs.find(item => item.actionId === action.id && everyWord([pdfName(item)], words))
    return inFields || comment || pdf ? [{ action, inFields, comment, pdf, rank: rank(action.title, words) }] : []
  }).sort((a, b) => a.rank - b.rank || latest<typeof a.action>(action => action.updatedAt)(a.action, b.action))
  return kind(found, ({ action, inFields, comment, pdf, rank }) => {
    const sources: Source[] = inFields
      ? [{ text: action.description, name: 'description', markdown: true }, { text: labelNames(action.labelIds).join(', '), name: 'labels' }]
      : [
        ...comment ? [{ text: comment.body, name: 'comment', markdown: true } as const] : [],
        ...pdf ? [{ text: pdfName(pdf), name: 'attachment' } as const] : [],
      ]
    return { rank, hit: {
      kind: 'action', id: action.id, title: action.title, status: action.status,
      excerpt: firstExcerpt(sources, lacking(action.title, words)),
    } }
  }, window)
}

function findEvents(words: string[], window: Window): Kind {
  const instant = now().getTime(), today = zonedDay(instant, COMMUNITY_TIME_ZONE)
  const found = communityStore().events
    .filter(event => event.deletedAt === null && everyWord([event.title, event.location, event.description], words))
    .map(event => ({ event, rank: rank(event.title, words), ended: hasEnded(event, instant, today), start: localStart(event, COMMUNITY_TIME_ZONE) }))
    // Upcoming and ongoing events first, the soonest first; then past ones, the latest first.
    .sort((a, b) => a.rank - b.rank || Number(a.ended) - Number(b.ended)
      || (a.ended ? compareText(b.start, a.start) : compareText(a.start, b.start)) || a.event.id - b.event.id)
  return kind(found, ({ event, rank }) => ({ rank, hit: {
    kind: 'event', id: event.id, title: event.title, location: event.location, all_day: event.allDay,
    starts_at: event.startsAt, ends_at: event.endsAt, starts_on: event.startsOn, ends_on: event.endsOn,
    excerpt: firstExcerpt([{ text: event.description, name: 'description', markdown: true }], lacking(event.title, words)),
  } }), window)
}

/** Where a folder or file is: the folders from the top level of Documents. */
function documentLocation(folderId: number | null) {
  return folderPath(sharedDocumentsStore(), folderId).map(folder => ({ id: folder.id, name: folder.name }))
}

function findFolders(words: string[], window: Window): Kind {
  const folders = sharedDocumentsStore().folders.filter(folder => folder.deletedAt === null && everyWord([folder.name], words))
    .map(folder => ({ folder, rank: rank(folder.name, words) }))
    .sort((a, b) => a.rank - b.rank || compareText(nameKey(a.folder.name), nameKey(b.folder.name)) || a.folder.id - b.folder.id)
  return kind(folders, ({ folder, rank }) => ({ rank, hit: {
    kind: 'folder', id: folder.id, title: folder.name, excerpt: null, location: documentLocation(folder.parentId),
  } }), window)
}

async function findFiles(words: string[], window: Window): Promise<Kind> {
  const documents = sharedDocumentsStore()
  await readTexts(documents, nowIso())
  const files = documents.documents.filter(document => document.deletedAt === null).flatMap(document => {
    const text = currentVersion(documents, document).text
    const read = text !== null && text.content !== '' && words.every(word => text.key.includes(word))
    return everyWord([document.name], words) || read ? [{ document, content: text?.content ?? '', rank: rank(document.name, words, 3) }] : []
  }).sort((a, b) => a.rank - b.rank || latest<typeof a.document>(document => document.updatedAt)(a.document, b.document))
  return kind(files, ({ document, content, rank }) => ({ rank, hit: {
      kind: 'file', id: document.id, title: document.name, document_kind: document.kind, folder_id: document.folderId,
      location: documentLocation(document.folderId),
      excerpt: rank === 3 ? firstExcerpt([{ text: content, name: 'text' }], lacking(document.name, words)) : null,
  } }), window)
}

/** The accounts the Neighbors directory lists: active ones with a dwelling. */
function findNeighbors(words: string[], window: Window): Kind {
  const { residents, dwellings } = coreStore()
  const { presidentId } = peopleStore().presidency
  const found = residents.flatMap(resident => {
    const dwelling = dwellings.find(item => item.id === resident.dwellingId)
    if (!dwelling || !resident.activated || resident.disabled) return []
    return everyWord([resident.name, resident.email, resident.phone, dwelling.label], words, resident.phone)
      ? [{ resident, dwelling, rank: rank(resident.name, words) }] : []
  }).sort((a, b) => a.rank - b.rank || compareText(foldText(a.resident.name), foldText(b.resident.name)) || a.resident.id - b.resident.id)
  return kind(found, ({ resident, dwelling, rank }) => ({ rank, hit: {
    kind: 'neighbor', id: resident.id, title: resident.name, excerpt: null, email: resident.email, phone: resident.phone,
    dwelling: dwelling.label, is_president: resident.id === presidentId,
  } }), window)
}

function findContacts(words: string[], window: Window): Kind {
  const state = communityStore()
  const tagNames = (tagIds: readonly number[]) => tagIds.flatMap(id => state.contactTags.filter(tag => tag.id === id))
    .sort((a, b) => compareText(casefold(a.name), casefold(b.name))).map(tag => tag.name)
  const found = state.contacts.filter(contact => contact.deletedAt === null && everyWord(
    [contact.name, contact.company, contact.email ?? '', contact.phone, contact.notes, tagNames(contact.tagIds).join('\n')], words, contact.phone,
  )).map(contact => ({ contact, rank: rank(contact.name, words) }))
    .sort((a, b) => a.rank - b.rank || compareText(foldText(a.contact.name), foldText(b.contact.name)) || a.contact.id - b.contact.id)
  return kind(found, ({ contact, rank }) => ({ rank, hit: {
    kind: 'contact', id: contact.id, title: contact.name, company: contact.company, email: contact.email, phone: contact.phone,
    excerpt: firstExcerpt([{ text: contact.notes, name: 'notes' }, { text: tagNames(contact.tagIds).join(', '), name: 'tags' }], lacking(contact.name, words)),
  } }), window)
}

function findTransactions(words: string[], window: Window): Kind {
  const found = [...financeStore().transactions.values()]
    .filter(transaction => everyWord([transaction.description, transaction.merchant], words))
    .map(transaction => ({ transaction, rank: rank(transaction.description, words) }))
    .sort((a, b) => a.rank - b.rank || latest<typeof a.transaction>(transaction => transaction.bookingDate)(a.transaction, b.transaction))
  return kind(found, ({ transaction, rank }) => ({ rank, hit: {
    kind: 'transaction', id: transaction.id, title: transaction.description, excerpt: null, booking_date: transaction.bookingDate,
    amount: money(transaction.amount), merchant: transaction.merchant,
  } }), window)
}

/** One kind's search, for a window of its matches. */
type Searcher = (window: Window) => Kind | Promise<Kind>

/** `searchers`: the search of each kind that members can read now, in the order of the kinds. */
function searchers(words: string[]): [SearchKind, Searcher][] {
  const { features } = coreStore()
  return [
    ...features.actions ? [['action', window => findActions(words, window)] as [SearchKind, Searcher]] : [],
    ...features.events ? [['event', window => findEvents(words, window)] as [SearchKind, Searcher]] : [],
    ...features.documents ? [
      ['folder', window => findFolders(words, window)] as [SearchKind, Searcher],
      ['file', window => findFiles(words, window)] as [SearchKind, Searcher],
    ] : [],
    ['neighbor', window => findNeighbors(words, window)],
    ['contact', window => findContacts(words, window)],
    ['transaction', window => findTransactions(words, window)],
  ]
}

/** `q` is required, 1 to 200 characters. */
function searchText(url: URL): string {
  const q = url.searchParams.get('q')
  if (!q || Array.from(q).length > 200) throw new DemoApiError('invalid_request', 422)
  return q
}

export const searchHandlers: HttpHandler[] = [
  // Sections that are off are not searched.
  http.get('/api/search', route('session', async ({ url }): Promise<SearchOut> => {
    const words = searchWords(searchText(url))
    if (!words.length) return { items: [], more: false }
    const kinds: Kind[] = []
    for (const [, search] of searchers(words)) kinds.push(await search(PREVIEW))
    const best = kinds.flatMap(({ found }) => found.map((entry, position) => ({ ...entry, position })))
      .sort((a, b) => a.rank - b.rank || KINDS.indexOf(a.hit.kind) - KINDS.indexOf(b.hit.kind) || a.position - b.position)
    return { items: best.slice(0, LIMIT).map(entry => entry.hit), more: best.length > LIMIT || kinds.some(({ more }) => more) }
  })),
  // `search_results`: how many items of each kind match, and the best few of each kind (the kinds
  // with the best matches first) or, for one kind (`kind`), a page of its items (`page`, 1 to 500).
  http.get('/api/search/results', route('session', async ({ url }): Promise<SearchResultsOut> => {
    const words = searchWords(searchText(url))
    const kindValue = url.searchParams.get('kind')
    const chosen = kindValue === null ? null : KINDS.find(kind => kind === kindValue)
    if (chosen === undefined) throw new DemoApiError('invalid_request', 422)
    const page = queryInt(url, 'page', { min: 1, max: MAX_PAGE }) ?? 1
    const found: [SearchKind, Kind][] = []
    for (const [name, search] of words.length ? searchers(words) : []) {
      found.push([name, await search(chosen === null || name === chosen
        ? chosen === null ? PREVIEW : { offset: (page - 1) * PAGE_SIZE, limit: PAGE_SIZE }
        : { offset: 0, limit: 0 })])
    }
    const counts = found.filter(([, result]) => result.total > 0).map(([name, result]) => ({ kind: name, total: result.total }))
    if (chosen === null) {
      const groups = found.map(([, result]) => result).filter(result => result.found.length > 0)
        .sort((a, b) => a.found[0].rank - b.found[0].rank || KINDS.indexOf(a.found[0].hit.kind) - KINDS.indexOf(b.found[0].hit.kind))
      const items = groups.flatMap(group => group.found.map(entry => entry.hit))
      return { counts, items, page: 1, pages: items.length ? 1 : 0 }
    }
    const result = found.find(([name]) => name === chosen)?.[1]
    return {
      counts, items: result?.found.map(entry => entry.hit) ?? [], page,
      // Pages go up to MAX_PAGE: more words narrow a broader search.
      pages: Math.min(Math.ceil((result?.total ?? 0) / PAGE_SIZE), MAX_PAGE),
    }
  })),
]