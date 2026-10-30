import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, Navigate, useLocation, useNavigate, useParams, useSearchParams } from 'react-router'
import { ApiError, api, errorMessage } from './api/client'
import type { EventActionOut, EventAgendaPage, EventHistoryPage, EventOut } from './api/schema.gen'
import { CalendarButton, EventActionLink, EventCards, EventEditor, EventFeatureGate, EventSnapshotView, cacheEvent, eventModalState, eventRange, useEventConfig, type EventModalState } from './community-event-shared'
import { useI18n } from './i18n'
import { Icon } from './icons'
import { Modal, Notice, Pagination, authorName, connectionTime, useAction, useFeatures } from './shared'

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
        <h3>{t('events.detail.description')}</h3><p className="event-text">{value.description || t('events.detail.noDescription')}</p>
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

function LinkedEvents({ action }: { action: EventActionOut }) {
  const { t } = useI18n()
  const config = useEventConfig()
  const [timeline, setTimeline] = useState(false), [page, setPage] = useState<number | null>(null)
  const [creating, setCreating] = useState(false)
  const scope = timeline ? 'all' : 'upcoming'
  const request = new URLSearchParams({ action_id: String(action.id), scope })
  if (page) request.set('page', String(page))
  const query = useEventAgenda(request)
  const agendaLink = new URLSearchParams({ action_id: String(action.id) })
  if (timeline) agendaLink.set('scope', 'all')
  return <>
    <section className="card event-linked">
      <header className="page-heading"><h2>{timeline ? t('events.linked.all') : t('events.linked.upcoming')}</h2>
        <div className="event-linked-controls">
          <label className="check"><input type="checkbox" checked={timeline} onChange={event => { setTimeline(event.target.checked); setPage(null) }} />{t('events.linked.showPast')}</label>
          <button type="button" className="secondary" disabled={!config.data || !!config.error} onClick={() => setCreating(true)}>{t('events.linked.create')}</button>
        </div>
      </header>
      {query.isPending && <Notice>{t('events.agenda.loading')}</Notice>}
      {query.error && <Notice error>{errorMessage(query.error)}</Notice>}
      {config.error && <Notice error>{errorMessage(config.error)}</Notice>}
      {query.data && config.data && !query.error && !config.error && <>
        {!query.data.items.length && <p className="muted">{timeline ? t('events.linked.empty') : t('events.linked.emptyUpcoming')}</p>}
        <EventCards items={query.data.items} zone={config.data.timezone} dimPast={timeline} />
        <Pagination page={query.data.page} pages={query.data.pages} change={setPage} busy={query.isFetching} label={t('events.linked.pagination')} />
      </>}
      <Link to={`/events?${agendaLink}`}>{t('events.linked.agenda')}</Link>
      {creating && config.data && <EventEditor value={null} timezone={config.data.timezone} initialAction={action}
        close={() => setCreating(false)} saved={value => {
          setCreating(false); setPage(null); cacheEvent(value)
        }} />}
    </section>
    <EventModalHost />
  </>
}
export function ActionEvents({ action }: { action: EventActionOut }) {
  const features = useFeatures()
  return features.data?.events && features.data.actions && !features.error ? <LinkedEvents key={action.id} action={action} /> : null
}
