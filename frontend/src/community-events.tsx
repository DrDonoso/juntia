import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { Link, Navigate, useLocation, useNavigate, useParams, useSearchParams } from 'react-router'
import { ApiError, api, errorMessage } from './api/client'
import type { EventActionOut, EventAgendaPage, EventHistoryPage, EventOut, EventPage } from './api/schema.gen'
import {
  CalendarButton, EventActionLink, EventCards, EventEditor, EventFeatureGate, EventSnapshotView, cacheEvent, eventModalState, eventRange,
  localInput, useEventConfig, useEventLink, type EventModalState,
} from './community-event-shared'
import { MarkdownText } from './markdown'
import { useI18n } from './i18n'
import { Icon } from './icons'
import { Modal, Notice, Pagination, authorName, connectionTime, day, useAction, useFeatures } from './shared'

type Scope = 'upcoming' | 'all' | 'past' | 'deleted'
const scopes: readonly Scope[] = ['upcoming', 'all', 'past', 'deleted']
function isScope(value: string | null): value is Scope {
  return scopes.some(scope => scope === value)
}
// Without an explicit page, the API opens the complete timeline on the page that reaches today.
function pageNumber(value: string | null) {
  return value && /^[1-9]\d{0,6}$/.test(value) && Number(value) <= 1000000 ? Number(value) : null
}
function validEventId(value: string | null) {
  return value && /^[1-9][0-9]{0,9}$/.test(value) && Number(value) <= 2147483647 ? Number(value) : null
}
function useEventAgenda(params: URLSearchParams) {
  return useQuery({
    queryKey: ['events', 'agenda', params.toString()],
    queryFn: ({ signal }) => api<EventAgendaPage>(`/events/agenda?${params}`, 'GET', undefined, signal),
    refetchInterval: 60_000,
  })
}
function EventList() {
  const { t } = useI18n()
  const [params, setParams] = useSearchParams()
  const config = useEventConfig(), features = useFeatures()
  const [creating, setCreating] = useState(false)
  const rawScope = params.get('scope'), scope = isScope(rawScope) ? rawScope : 'upcoming'
  const page = pageNumber(params.get('page')), search = params.get('q') || ''
  const request = new URLSearchParams({ scope, q: search })
  if (page) request.set('page', String(page))
  const actionId = params.get('action_id')
  if (features.data?.actions && !features.error && actionId && /^[1-9]\d{0,9}$/.test(actionId)) request.set('action_id', actionId)
  const query = useEventAgenda(request)
  function change(key: string, value: string) {
    setParams(previous => {
      const next = new URLSearchParams(previous)
      if (value) next.set(key, value); else next.delete(key)
      if (key !== 'page') next.delete('page')
      return next
    })
  }
  return <>
    <div className="page-heading"><div><p className="eyebrow">{t('events.agenda.eyebrow')}</p><h1>{t('events.agenda.title')}</h1></div>
      <button disabled={!config.data || !!config.error} onClick={() => setCreating(true)}><Icon name="calendar" />{t('events.agenda.create')}</button></div>
    <section className="card event-filters" aria-label={t('events.agenda.filters')}>
      <label>{t('events.agenda.scope')}<select value={scope} onChange={event => change('scope', event.target.value)}>
        {scopes.map(value => <option key={value} value={value}>{t(`events.agenda.scopes.${value}`)}</option>)}
      </select></label>
      <label>{t('events.agenda.search')}<input type="search" maxLength={200} value={search} onChange={event => change('q', event.target.value)} /></label>
      {actionId && <button type="button" className="quiet" onClick={() => change('action_id', '')}>{t('events.agenda.clearActionFilter')}</button>}
    </section>
    {actionId && !features.data?.actions && <Notice>{t('events.agenda.actionFilterIgnored')}</Notice>}
    {config.isPending && <Notice>{t('events.agenda.loadingTimeZone')}</Notice>}
    {config.error && <Notice error>{errorMessage(config.error)}</Notice>}
    {query.isPending && <Notice>{t('events.agenda.loading')}</Notice>}
    {query.error && <><Notice error>{errorMessage(query.error)}</Notice><button type="button" className="secondary" onClick={() => void query.refetch()}>{t('common.retryLoading')}</button></>}
    {query.data && config.data && !query.error && !config.error && <>
      {!query.data.items.length && <Notice>{t(`events.agenda.empty.${scope}`)}</Notice>}
      <EventCards items={query.data.items} zone={config.data.timezone} dimPast={scope === 'all'} />
      <Pagination page={query.data.page} pages={query.data.pages} change={value => change('page', String(value))} busy={query.isFetching} label={t('events.agenda.pagination')} />
    </>}
    {creating && config.data && <EventEditor value={null} timezone={config.data.timezone} close={() => setCreating(false)} saved={value => {
      setCreating(false)
      setParams(previous => {
        const next = new URLSearchParams(previous)
        next.set('event', String(value.id))
        return next
      }, { state: eventModalState })
    }} />}
    <EventModalHost />
  </>
}
export function EventsPage() {
  return <EventFeatureGate><EventList /></EventFeatureGate>
}

function EventHistory({ id, zone, close }: { id: number; zone: string; close: () => void }) {
  const { t } = useI18n()
  const [page, setPage] = useState(1)
  const query = useQuery({
    queryKey: ['events', 'history', id, page],
    queryFn: ({ signal }) => api<EventHistoryPage>(`/events/${id}/history?page=${page}`, 'GET', undefined, signal),
  })
  return <Modal title={t('events.history.title')} close={close} className="event-history">
    <p className="muted">{t('events.history.help')}</p>
    {query.isPending && <Notice>{t('events.history.loading')}</Notice>}
    {query.error && <Notice error>{errorMessage(query.error)}</Notice>}
    {query.data && !query.error && <>
      <ol className="contact-events">{query.data.items.map(item => <li key={item.id}>
        <header><strong>{t(`events.history.kinds.${item.kind}`)}</strong><span>{authorName(item.author, t)} · <time dateTime={item.created_at}>{connectionTime(item.created_at)}</time></span></header>
        {item.before && <details><summary>{t('events.history.before')}</summary><EventSnapshotView value={item.before} zone={zone} /></details>}
        {item.after && <details><summary>{t('events.history.after')}</summary><EventSnapshotView value={item.after} zone={zone} /></details>}
      </li>)}</ol>
      <Pagination page={page} pages={query.data.pages} change={setPage} busy={query.isFetching} label={t('events.history.pagination')} />
    </>}
  </Modal>
}

function DeleteEvent({ value, zone, close }: { value: EventOut; zone: string; close: () => void }) {
  const { t } = useI18n()
  const [current, setCurrent] = useState(value), operation = useAction(['events']), refresh = useAction(false)
  const stale = operation.failure instanceof ApiError && operation.failure.code === 'event_stale'
  const busy = operation.busy || refresh.busy
  return <Modal title={t('events.deletion.title')} close={close} disabled={busy}>
    <EventSnapshotView value={current} zone={zone} />
    <p>{t('events.deletion.text')}</p>
    {operation.notice}{refresh.notice}
    {stale && <button type="button" className="secondary" disabled={busy} onClick={() => void refresh.run(async () => {
      const updated = await api<EventOut>(`/events/${value.id}`)
      setCurrent(updated); operation.reset()
    })}>{t('events.deletion.reload')}</button>}
    {current.deleted_at && <Notice>{t('events.deletion.alreadyDeleted')}</Notice>}
    <div className="inline"><button type="button" className="danger secondary" disabled={busy || stale || !!current.deleted_at} onClick={() => void operation.run(async () => {
      await api(`/events/${current.id}`, 'DELETE', { version: current.version }); close()
    })}>{operation.busy ? t('events.deletion.deleting') : t('events.deletion.confirm')}</button>
      <button type="button" className="secondary" disabled={busy} onClick={close}>{t('common.cancel')}</button></div>
  </Modal>
}

function EventDetailModal({ id, close }: { id: number; close: () => void }) {
  const { t } = useI18n()
  const config = useEventConfig(), features = useFeatures()
  const query = useQuery({
    queryKey: ['events', 'item', id],
    queryFn: ({ signal }) => api<EventOut>(`/events/${id}`, 'GET', undefined, signal),
  })
  const [editing, setEditing] = useState(false), [history, setHistory] = useState(false), [deleting, setDeleting] = useState(false)
  const loading = query.isPending || config.isPending, failure = query.error || config.error
  const value = query.data, zone = config.data?.timezone
  return <Modal title={value?.title || t('events.detail.title')} close={close} className="event-detail-modal">
    {loading ? <Notice>{t('events.detail.loading')}</Notice> : failure ? <Notice error>{errorMessage(failure)}</Notice> : value && zone && <div className="event-detail">
      {value.deleted_at && <Notice>{t('events.detail.deleted')}</Notice>}
      <p className="event-schedule">{eventRange(value, zone)}</p>
      <div className="event-detail-fields">
        <h3>{t('events.detail.location')}</h3><p className="event-text">{value.location || t('events.detail.noLocation')}</p>
        <hr />
        <h3>{t('events.detail.description')}</h3>
        {value.description ? <MarkdownText text={value.description} /> : <p className="event-text">{t('events.detail.noDescription')}</p>}
        {features.data?.actions && !features.error && <>
          <hr />
          <h3>{t('events.detail.action')}</h3>
          {value.action ? <EventActionLink value={value} /> : <p>{t('events.detail.noAction')}</p>}
        </>}
      </div>
      <p className="muted">{t('events.detail.createdBy', { name: authorName(value.author, t), time: connectionTime(value.created_at) })}</p>
      <p className="muted">{t('events.detail.updatedAt', { time: connectionTime(value.updated_at) })}</p>
      <div className="inline event-detail-actions">
        {!value.deleted_at && <button type="button" onClick={() => setEditing(true)}>{t('events.detail.edit')}</button>}
        <button type="button" className="secondary" onClick={() => setHistory(true)}>{t('common.history')}</button>
        <CalendarButton value={value} />
        {!value.deleted_at && <button type="button" className="quiet danger" onClick={() => setDeleting(true)}><Icon name="trash" />{t('events.detail.delete')}</button>}
      </div>
    </div>}
    {editing && value && zone && <EventEditor value={value} timezone={zone} close={() => setEditing(false)} saved={() => setEditing(false)} />}
    {history && zone && <EventHistory id={id} zone={zone} close={() => setHistory(false)} />}
    {deleting && value && zone && <DeleteEvent value={value} zone={zone} close={() => setDeleting(false)} />}
  </Modal>
}

// The open event lives in the URL (`event=<id>`) so the page behind keeps its state and Back closes it.
function EventModalHost() {
  const { t } = useI18n()
  const [params] = useSearchParams(), location = useLocation(), navigate = useNavigate()
  // Ignores repeated close requests until the history navigation lands.
  const closing = useRef(false)
  useEffect(() => { closing.current = false }, [location.key])
  const raw = params.get('event')
  if (raw === null) return null
  const id = validEventId(raw)
  function close() {
    if (closing.current) return
    closing.current = true
    if ((location.state as EventModalState | null)?.eventModal) {
      navigate(-1)
      return
    }
    const next = new URLSearchParams(location.search)
    next.delete('event')
    const search = next.toString()
    navigate({ pathname: location.pathname, search: search ? `?${search}` : '' }, { replace: true })
  }
  return id ? <EventDetailModal key={id} id={id} close={close} />
    : <Modal title={t('events.detail.title')} close={close} className="event-detail-modal"><Notice error>{t('events.detail.notFound')}</Notice></Modal>
}

export function EventDetailPage() {
  const { t } = useI18n()
  const { eventId = '' } = useParams()
  const id = validEventId(eventId)
  return id ? <Navigate replace to={`/events?event=${id}`} />
    : <EventFeatureGate><Notice error>{t('events.detail.notFound')}</Notice></EventFeatureGate>
}

type TimelineSide = 'past' | 'upcoming'
// Finished events come newest first and the others soonest first, so each side loads outwards from now.
function useActionTimeline(actionId: number, scope: TimelineSide) {
  return useInfiniteQuery({
    queryKey: ['events', 'action', actionId, scope],
    queryFn: ({ pageParam, signal }) => api<EventPage>(`/events?${new URLSearchParams({
      action_id: String(actionId), scope, page: String(pageParam),
    })}`, 'GET', undefined, signal),
    initialPageParam: 1,
    getNextPageParam: (last: EventPage) => last.page < last.pages ? last.page + 1 : undefined,
    refetchInterval: 60_000,
  })
}
// Pages read at different moments can repeat an event that changed side or page in between.
function distinct(values: EventOut[], seen: Set<number>) {
  return values.filter(value => {
    if (seen.has(value.id)) return false
    seen.add(value.id)
    return true
  })
}
// Scrolls the timeline, not the page, to bring an entry to its middle.
function centerIn(track: HTMLElement, entry: Element) {
  const box = track.getBoundingClientRect(), target = entry.getBoundingClientRect()
  track.scrollLeft += target.left + target.width / 2 - box.left - box.width / 2
}
function TimelineEvent({ value, zone, past, ongoing }: { value: EventOut; zone: string; past: boolean; ongoing: boolean }) {
  const { t } = useI18n()
  const eventLink = useEventLink()
  const start = value.all_day ? value.starts_on : value.starts_at && localInput(value.starts_at, zone).slice(0, 10)
  return <li className={`event-track-item${past ? ' event-past' : ''}`} data-event-id={value.id}>
    <p className="event-track-day">{start && <time dateTime={start}>{day(start)}</time>}</p>
    <span className="event-track-axis" aria-hidden="true" />
    <div className="card event-track-card">
      <h3><Link to={eventLink(value.id)} state={eventModalState}>{value.title}</Link></h3>
      {past && <span className="sr-only">{t('events.cards.finished')}</span>}
      <p className="event-schedule">{eventRange(value, zone, true)}</p>
      {value.location && <p className="event-text">{value.location}</p>}
      {ongoing && <span className="tag event-track-ongoing">{t('events.linked.ongoing')}</span>}
    </div>
  </li>
}
// What to bring into view once it is on the timeline: a new event, or the first event of a loaded page,
// next to the event that was at that end.
type Reveal = { id: number; loaded?: { side: TimelineSide; pages: number } }
function LinkedEvents({ action }: { action: EventActionOut }) {
  const { t } = useI18n()
  const config = useEventConfig()
  const past = useActionTimeline(action.id, 'past'), upcoming = useActionTimeline(action.id, 'upcoming')
  const sides = { past, upcoming }
  const [creating, setCreating] = useState(false)
  const track = useRef<HTMLDivElement>(null)
  // The timeline opens centered on now; afterwards it only moves to show what the reader loaded or created.
  const centered = useRef(false), reveal = useRef<Reveal | null>(null)
  const zone = config.data?.timezone
  const failure = config.error || past.error || upcoming.error
  const seen = new Set<number>()
  const finished = distinct(past.data?.pages.flatMap(page => page.items).reverse() ?? [], seen)
  const pending = distinct(upcoming.data?.pages.flatMap(page => page.items) ?? [], seen)
  const loadingMore = past.isFetchingNextPage || upcoming.isFetchingNextPage
  useLayoutEffect(() => {
    const element = track.current
    if (!element) return
    if (!centered.current) {
      centered.current = true
      const marker = element.querySelector('.event-track-now')
      if (marker) centerIn(element, marker)
    }
    const target = reveal.current
    if (!target) return
    const { loaded } = target
    if (loaded && (sides[loaded.side].data?.pages.length ?? 0) <= loaded.pages) return
    const anchor = element.querySelector(`[data-event-id="${target.id}"]`)
    const entry = !loaded ? anchor : loaded.side === 'past' ? anchor?.previousElementSibling : anchor?.nextElementSibling
    // A new event appears once the timeline refreshes.
    if (!entry && !loaded) return
    reveal.current = null
    if (!entry?.classList.contains('event-track-item')) return
    centerIn(element, entry)
    // The button may be gone with the last page: focus continues on the first event it added.
    if (loaded) entry.querySelector('a')?.focus({ preventScroll: true })
  })
  function loadMore(side: TimelineSide) {
    const edge = side === 'past' ? finished[0] : pending.at(-1)
    reveal.current = edge ? { id: edge.id, loaded: { side, pages: sides[side].data?.pages.length ?? 0 } } : null
    void sides[side].fetchNextPage()
  }
  const now = Date.now(), today = zone ? localInput(new Date(now).toISOString(), zone).slice(0, 10) : ''
  function started(value: EventOut) {
    return value.all_day ? !!value.starts_on && value.starts_on <= today : !!value.starts_at && Date.parse(value.starts_at) <= now
  }
  const agendaLink = new URLSearchParams({ action_id: String(action.id), scope: 'all' })
  return <>
    <section className="card event-linked" aria-labelledby="action-events-heading">
      <header>
        <h2 id="action-events-heading">{t('events.linked.title')}</h2>
        <button type="button" className="icon-button" title={t('events.linked.create')} aria-label={t('events.linked.create')}
          disabled={!config.data || !!config.error} onClick={() => setCreating(true)}><Icon name="plus" /></button>
      </header>
      {(past.isPending || upcoming.isPending) && !failure && <Notice>{t('events.agenda.loading')}</Notice>}
      {failure && <Notice error>{errorMessage(failure)}</Notice>}
      {zone && past.data && upcoming.data && (finished.length || pending.length ? <div ref={track} className="event-track">
        {past.hasNextPage && <button type="button" className="secondary" disabled={loadingMore} onClick={() => loadMore('past')}>{t('events.linked.earlier')}</button>}
        <ol className="event-track-list">
          {finished.map(value => <TimelineEvent key={value.id} value={value} zone={zone} past ongoing={false} />)}
          <li className="event-track-now">{t('events.linked.now')}</li>
          {pending.map(value => <TimelineEvent key={value.id} value={value} zone={zone} past={false} ongoing={started(value)} />)}
        </ol>
        {upcoming.hasNextPage && <button type="button" className="secondary" disabled={loadingMore} onClick={() => loadMore('upcoming')}>{t('events.linked.later')}</button>}
      </div> : <p className="muted">{t('events.linked.empty')}</p>)}
      <Link to={`/events?${agendaLink}`}>{t('events.linked.agenda')}</Link>
      {creating && config.data && <EventEditor value={null} timezone={config.data.timezone} initialAction={action}
        close={() => setCreating(false)} saved={value => {
          setCreating(false); cacheEvent(value)
          if (value.action?.id === action.id) reveal.current = { id: value.id }
        }} />}
    </section>
    <EventModalHost />
  </>
}
export function ActionEvents({ action }: { action: EventActionOut }) {
  const features = useFeatures()
  return features.data?.events && features.data.actions && !features.error ? <LinkedEvents key={action.id} action={action} /> : null
}
