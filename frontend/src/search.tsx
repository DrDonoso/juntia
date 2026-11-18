import { Fragment, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode, type RefObject } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { Link, useNavigate } from 'react-router'
import { api, errorMessage } from './api/client'
import type { FileHit, SearchExcerpt, SearchOut } from './api/schema.gen'
import { eventRange, useEventConfig } from './event-time'
import { useI18n, type TranslationKey } from './i18n'
import { Icon, type IconName } from './icons'
import { PrivacyContext } from './privacy'
import { Money, Notice, day } from './shared'

export type SearchHit = SearchOut['items'][number]
export type SearchKind = SearchHit['kind']
// The results and the search they answer, which their highlights follow while the next one loads.
type Results = SearchOut & { q: string }

const MIN_CHARACTERS = 2
// The server reads only so many words (search.MAX_WORDS).
const MAX_WORDS = 10
const DELAY = 250

const KIND_ICONS: Record<Exclude<SearchHit['kind'], 'file'>, IconName> = {
  action: 'check', event: 'calendar', folder: 'folder', neighbor: 'user', contact: 'mail', transaction: 'receipt',
}
const FILE_ICONS: Record<FileHit['document_kind'], IconName> = {
  pdf: 'file-text', image: 'image', video: 'video', document: 'file-text', spreadsheet: 'table', presentation: 'presentation', text: 'file',
}
// Where the words were found, when the title does not say it.
const SOURCES: Partial<Record<SearchExcerpt['source'], TranslationKey>> = {
  comment: 'search.sources.comment', attachment: 'search.sources.attachment',
  labels: 'search.sources.labels', tags: 'search.sources.tags',
}

function foldCharacter(character: string): string {
  return character.toUpperCase().toLowerCase().normalize('NFKD').replace(/\p{Mn}/gu, '')
}

/** A text without case and accents, character by character as the server folds it (query_sql.fold_text). */
export function foldText(value: string): string {
  return Array.from(value, foldCharacter).join('')
}

/** The distinct words the server looks for. */
export function searchWords(q: string): string[] {
  return [...new Set(foldText(q).split(/\s+/u).filter(Boolean))].slice(0, MAX_WORDS)
}

const searchable = (value: string) => Array.from(value).length >= MIN_CHARACTERS

/** Whether a search has enough characters to be sent. */
export function isSearchable(value: string): boolean {
  return searchable(value.trim())
}

/** The page with every result of a search: of every kind, or of one kind, page by page. */
export function resultsPath(q: string, kind: SearchKind | null = null, page = 1): string {
  const params = new URLSearchParams({ q })
  if (kind) params.set('kind', kind)
  if (page > 1) params.set('page', String(page))
  return `/search?${params}`
}

/** `text` with the search's words marked wherever they appear, ignoring case and accents. */
export function highlight(text: string, words: readonly string[]): ReactNode {
  const characters = Array.from(text)
  const marked = characters.map(() => false)
  // The character of `text` behind each unit of the folded text.
  const owners: number[] = []
  let key = ''
  characters.forEach((character, index) => {
    const folded = foldCharacter(character)
    key += folded
    for (let unit = 0; unit < folded.length; unit += 1) owners.push(index)
  })
  for (const word of words) {
    for (let at = key.indexOf(word); at >= 0; at = key.indexOf(word, at + 1)) {
      for (let index = owners[at]; index <= owners[at + word.length - 1]; index += 1) marked[index] = true
    }
  }
  const parts: ReactNode[] = []
  let start = 0
  for (let index = 1; index <= characters.length; index += 1) {
    if (index < characters.length && marked[index] === marked[start]) continue
    const chunk = characters.slice(start, index).join('')
    parts.push(<Fragment key={start}>{marked[start] ? <mark>{chunk}</mark> : chunk}</Fragment>)
    start = index
  }
  return parts
}

/** The page that shows a result: its own, or the dialog of its page. */
export function hitPath(hit: SearchHit): string {
  switch (hit.kind) {
    case 'action': return `/actions/${hit.id}`
    case 'event': return `/events?event=${hit.id}`
    case 'folder': return `/documents/folders/${hit.id}`
    case 'file': return `${hit.folder_id === null ? '/documents' : `/documents/folders/${hit.folder_id}`}?file=${hit.id}`
    case 'neighbor': return `/neighbors?neighbor=${hit.id}`
    case 'contact': return `/contacts?contact=${hit.id}`
    case 'transaction': return `/transactions?${new URLSearchParams({ q: hit.title, start: hit.booking_date, end: hit.booking_date })}`
  }
}

/** A plain click opens the result here; others, such as Ctrl-click, leave the search as it is. */
const plainClick = (event: MouseEvent) => event.button === 0 && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey

function HitDetail({ hit, words, zone }: { hit: SearchHit; words: readonly string[]; zone: string | undefined }) {
  const { t } = useI18n()
  const parts: ReactNode[] = []
  const text = (value: string) => { if (value) parts.push(highlight(value, words)) }
  switch (hit.kind) {
    case 'action':
      parts.push(t(`actions.status.${hit.status}`))
      break
    case 'event':
      if (zone) parts.push(eventRange(hit, zone))
      text(hit.location)
      break
    case 'folder':
    case 'file':
      parts.push([t('documents.root'), ...hit.location.map(folder => folder.name)].join(' / '))
      break
    case 'neighbor':
      text(t('search.dwelling', { label: hit.dwelling }))
      if (hit.is_president) parts.push(t('common.president.title'))
      text(hit.email)
      text(hit.phone)
      break
    case 'contact':
      text(hit.company)
      text(hit.email ?? '')
      text(hit.phone)
      break
    case 'transaction':
      parts.push(day(hit.booking_date), <Money value={hit.amount} />)
      text(hit.merchant)
      break
  }
  return parts.length > 0 && <span className="search-hit-detail">
    {parts.map((part, index) => <Fragment key={index}>{index > 0 && ' · '}{part}</Fragment>)}
  </span>
}

/** A result's icon, title with what it is, details and excerpt, in the box's list or on the page of results. */
export function HitContent({ hit, words, zone }: { hit: SearchHit; words: readonly string[]; zone: string | undefined }) {
  const { t } = useI18n()
  const source = hit.excerpt && SOURCES[hit.excerpt.source]
  return <>
    <Icon name={hit.kind === 'file' ? FILE_ICONS[hit.document_kind] : KIND_ICONS[hit.kind]} size={18} className="search-hit-icon" />
    <span className="search-hit-text">
      <span className="search-hit-heading">
        <span className="search-hit-title">{highlight(hit.title, words)}</span>
        <span className="search-hit-kind">{t(`search.kinds.${hit.kind}`)}</span>
      </span>
      <HitDetail hit={hit} words={words} zone={zone} />
      {hit.excerpt && <span className="search-hit-excerpt">
        {source && <span className="search-hit-source">{t(source)} </span>}{highlight(hit.excerpt.text, words)}
      </span>}
    </span>
  </>
}

function SearchOption({ hit, id, active, words, zone, choose }: {
  hit: SearchHit; id: string; active: boolean; words: readonly string[]; zone: string | undefined; choose: () => void
}) {
  return <Link to={hitPath(hit)} id={id} role="option" aria-selected={active} tabIndex={-1} data-active={active || undefined}
    className="search-hit" onClick={event => { if (plainClick(event)) choose() }}>
    <HitContent hit={hit} words={words} zone={zone} />
  </Link>
}

/**
 * The box and its results. Typing lists, after a short pause, what contains every word typed:
 * the arrows choose a result and Enter opens it. Without a chosen result, Enter opens the page
 * with every result, like the last option.
 */
function SearchBox({ compact, hideAmounts, input, done }: {
  compact: boolean; hideAmounts: boolean; input?: RefObject<HTMLInputElement | null>; done: () => void
}) {
  const { t } = useI18n()
  const navigate = useNavigate()
  const id = useId(), listId = `${id}-results`
  const optionId = (index: number) => `${id}-option-${index}`
  const [text, setText] = useState('')
  const [request, setRequest] = useState('')
  const [focused, setFocused] = useState(false)
  // Escape hides the results until the text changes or the arrows bring them back.
  const [dismissed, setDismissed] = useState(false)
  const [active, setActive] = useState({ q: '', index: -1 })
  useEffect(() => {
    const timer = setTimeout(() => setRequest(text.trim()), DELAY)
    return () => clearTimeout(timer)
  }, [text])
  const query = useQuery({
    queryKey: ['search', request],
    queryFn: async ({ signal }): Promise<Results> => ({
      ...await api<SearchOut>(`/search?${new URLSearchParams({ q: request })}`, 'GET', undefined, signal), q: request,
    }),
    enabled: searchable(request), placeholderData: keepPreviousData, staleTime: 0,
  })
  const typed = text.trim()
  const results = searchable(typed) ? query.data : undefined
  const expanded = (compact || focused) && !dismissed && searchable(typed)
  const items = expanded && results ? results.items : []
  const words = useMemo(() => results ? searchWords(results.q) : [], [results])
  const config = useEventConfig(items.some(hit => hit.kind === 'event'))
  const listed = items.length > 0
  // The results, then the option that shows them all on their page.
  const options = listed ? items.length + 1 : 0
  const activeIndex = results && active.q === results.q && active.index < options ? active.index : -1
  useLayoutEffect(() => {
    if (activeIndex >= 0) document.getElementById(`${id}-option-${activeIndex}`)?.scrollIntoView?.({ block: 'nearest' })
  }, [id, activeIndex])
  function finish() {
    setText(''); setRequest(''); setDismissed(false); setActive({ q: '', index: -1 })
    done()
  }
  function open(path: string) {
    navigate(path)
    finish()
  }
  function keyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing) return
    if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && results?.items.length && searchable(typed)) {
      event.preventDefault()
      if (dismissed) { setDismissed(false); return }
      // The last option shows every result.
      const last = results.items.length
      const index = event.key === 'ArrowDown'
        ? activeIndex >= last ? 0 : activeIndex + 1
        : activeIndex <= 0 ? last : activeIndex - 1
      setActive({ q: results.q, index })
    } else if (event.key === 'Enter') {
      // The chosen result; without one, every result of what is typed, on their page.
      const hit = items[activeIndex]
      if (!hit && !searchable(typed)) return
      event.preventDefault()
      open(hit ? hitPath(hit) : resultsPath(typed))
    } else if (event.key === 'Escape' && !compact && (expanded || text)) {
      event.preventDefault()
      if (expanded) setDismissed(true); else setText('')
    }
  }
  const counted = expanded && results && !query.isPlaceholderData ? t('search.count', { count: results.items.length }) : ''
  return <div className="global-search-box" onFocus={() => setFocused(true)} onBlur={event => {
    if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setFocused(false)
  }}>
    <div className="global-search-field">
      <Icon name="search" size={16} className="global-search-icon" />
      <input ref={input} type="search" role="combobox" aria-label={t('search.label')} placeholder={t('search.placeholder')}
        autoComplete="off" spellCheck={false} maxLength={200} enterKeyHint="search" value={text}
        aria-autocomplete="list" aria-expanded={listed} aria-controls={listed ? listId : undefined}
        aria-activedescendant={activeIndex >= 0 ? optionId(activeIndex) : undefined}
        aria-keyshortcuts={compact ? undefined : '/ Control+K Meta+K'}
        onChange={event => { setText(event.target.value); setDismissed(false); setActive({ q: '', index: -1 }) }} onKeyDown={keyDown} />
    </div>
    <span className="sr-only" role="status">{counted}</span>
    {/* Keeping the focus in the box keeps the results open while one is clicked. */}
    {expanded && (results || query.isFetching || query.error) && <PrivacyContext value={hideAmounts}>
      <div className="search-results" onMouseDown={event => event.preventDefault()}>
        {!results && query.isFetching && <p className="search-message">{t('search.loading')}</p>}
        {query.error && !query.isFetching && <div className="search-message">
          <Notice error>{errorMessage(query.error)}</Notice>
          <button type="button" className="secondary" onClick={() => void query.refetch()}>{t('common.retry')}</button>
        </div>}
        {results && !results.items.length && <p className="search-message">{t('search.empty', { query: results.q })}</p>}
        {listed && <div role="listbox" id={listId} aria-label={t('search.results')} aria-busy={query.isFetching}>
          {items.map((hit, index) => <SearchOption key={`${hit.kind}:${hit.id}`} hit={hit} id={optionId(index)}
            active={index === activeIndex} words={words} zone={config.data?.timezone} choose={finish} />)}
          <Link to={resultsPath(typed)} id={optionId(items.length)} role="option" aria-selected={activeIndex === items.length}
            tabIndex={-1} data-active={activeIndex === items.length || undefined} className="search-all"
            onClick={event => { if (plainClick(event)) finish() }}>
            <Icon name="search" size={16} /><span>{t('search.seeAll')}</span><Icon name="arrow-right" size={16} />
          </Link>
        </div>}
      </div>
    </PrivacyContext>}
  </div>
}

function editable(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName))
}

/** The search under the top bar of narrow screens, which the shell opens and closes like its menus. */
export type SearchPanel = {
  open: boolean; setOpen: (open: boolean) => void
  panel: RefObject<HTMLDivElement | null>; trigger: RefObject<HTMLButtonElement | null>
}

/**
 * The search at the top of every page for signed-in accounts: a box in the top bar, or on narrow
 * screens (`panel`) a magnifier that opens it under the bar. `/` and Ctrl+K (⌘K) go to it.
 */
export function GlobalSearch({ hideAmounts, panel }: { hideAmounts: boolean; panel?: SearchPanel }) {
  const { t } = useI18n()
  const panelId = useId()
  const input = useRef<HTMLInputElement>(null)
  const setOpen = panel?.setOpen
  useEffect(() => {
    function shortcut(event: globalThis.KeyboardEvent) {
      if (event.defaultPrevented || event.isComposing || event.altKey || document.querySelector('dialog[open]')) return
      const command = (event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === 'k'
      const slash = event.key === '/' && !event.ctrlKey && !event.metaKey && !editable(event.target)
      if (!command && !slash) return
      event.preventDefault()
      if (setOpen) setOpen(true)
      else input.current?.focus()
    }
    document.addEventListener('keydown', shortcut)
    return () => document.removeEventListener('keydown', shortcut)
  }, [setOpen])
  if (!panel) return <div className="global-search" role="search" aria-label={t('search.label')}>
    <SearchBox compact={false} hideAmounts={hideAmounts} input={input} done={() => document.getElementById('content')?.focus()} />
  </div>
  const { open } = panel
  return <>
    <button ref={panel.trigger} type="button" className="quiet icon-button search-toggle" title={open ? t('search.close') : t('search.open')}
      aria-label={open ? t('search.close') : t('search.open')} aria-expanded={open} aria-controls={open ? panelId : undefined}
      onClick={() => panel.setOpen(!open)}><Icon name={open ? 'close' : 'search'} /></button>
    {open && <div ref={panel.panel} id={panelId} className="global-search global-search-panel" role="search" aria-label={t('search.label')}>
      <SearchBox compact hideAmounts={hideAmounts} done={() => {
        panel.setOpen(false)
        document.getElementById('content')?.focus()
      }} />
    </div>}
  </>
}
