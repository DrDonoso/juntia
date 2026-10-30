import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, useLocation, type To } from 'react-router'
import { ApiError, api, cache, codeMessage, downloadFile, errorMessage } from './api/client'
import type { ActionPage, EventActionOut, EventCalendarOut, EventConfigOut, EventIn, EventOccurrenceOut, EventOut, EventSnapshot, FeatureFlagsOut } from './api/schema.gen'
import { Icon } from './icons'
import { EventDateField, focusEventDateField } from './event-date-field'
import { dateTimeFormat, t, useI18n } from './i18n'
import { Modal, Notice, Pagination, day, focusFormField, useAction, useFeatures } from './shared'

export function EventFeatureGate({ children }: { children: ReactNode }) {
  const { t } = useI18n()
  const features = useFeatures()
  if (features.isPending) return <Notice>{t('events.gate.checking')}</Notice>
  if (features.error) return <Notice error>{errorMessage(features.error)}</Notice>
  if (!features.data.events) return <section className="card"><h1>{t('events.gate.disabledTitle')}</h1>
    <p>{t('events.gate.disabledText')}</p></section>
  return children
}

export function useEventConfig() {
  return useQuery({
    queryKey: ['events', 'config'],
    queryFn: ({ signal }) => api<EventConfigOut>('/events/config', 'GET', undefined, signal),
  })
}

export function cacheEvent(value: EventOut) {
  const features = cache.getQueryData<FeatureFlagsOut>(['features'])
  if (features?.events === true) {
    cache.setQueryData(['events', 'item', value.id], features.actions ? value : { ...value, action: null })
  }
}

// Wall-clock time in the community zone as `YYYY-MM-DDTHH:mm:ss` for drafts and comparisons;
// the fixed en-GB parts are parsed, never displayed.
export function localInput(value: string, zone: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(value))
  function part(type: Intl.DateTimeFormatPartTypes) {
    const result = parts.find(part => part.type === type)?.value
    if (!result) throw new Error(t('events.errors.unreadableDate'))
    return result
  }
  return `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}:${part('second')}`
}

export function shiftDay(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00Z`)
  if (!value || Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new Error(t('events.errors.invalidDate'))
  }
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

export function eventRange(value: EventSnapshot, zone: string, compact = false): string {
  if (value.all_day) {
    if (!value.starts_on || !value.ends_on) throw new Error(t('events.errors.invalidInterval'))
    const last = shiftDay(value.ends_on, -1)
    if (last !== value.starts_on) return t('events.schedule.allDayRange', { start: day(value.starts_on), end: day(last) })
    return compact ? t('events.schedule.allDay') : t('events.schedule.allDayOn', { date: day(value.starts_on) })
  }
  if (!value.starts_at || !value.ends_at) throw new Error(t('events.errors.invalidSchedule'))
  const sameDay = localInput(value.starts_at, zone).slice(0, 10) === localInput(value.ends_at, zone).slice(0, 10)
  const format = dateTimeFormat({
    timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    ...(compact && sameDay ? {} : { year: 'numeric', month: '2-digit', day: '2-digit' } as const),
  })
  return t('events.schedule.range', { start: format.format(new Date(value.starts_at)), end: format.format(new Date(value.ends_at)) })
}

export function EventActionLink({ value }: { value: EventSnapshot }) {
  const features = useFeatures()
  return value.action && features.data?.actions && !features.error
    ? <Link to={`/actions/${value.action.id}`} className="event-action-link"><Icon name="check" size={16} />{value.action.title}</Link>
    : null
}

export function CalendarButton({ value }: { value: EventOut }) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const download = useAction(false)
  const query = useQuery({
    queryKey: ['events', 'calendar', value.id, value.version],
    queryFn: ({ signal }) => api<EventCalendarOut>(`/events/${value.id}/calendar`, 'GET', undefined, signal),
    enabled: open, staleTime: 0,
  })
  if (value.deleted_at) return null
  return <>
    <button type="button" className="secondary icon-button" title={t('events.calendar.add')} aria-label={t('events.calendar.add')}
      aria-haspopup="dialog" onClick={() => setOpen(true)}><Icon name="calendar" /></button>
    {open && <Modal title={t('events.calendar.add')} close={() => setOpen(false)} disabled={download.busy}>
      <p><strong>{value.title}</strong></p>
      <p>{t('events.calendar.copy')}</p>
      {query.isPending && <Notice>{t('events.calendar.preparing')}</Notice>}
      {query.error && <><Notice error>{errorMessage(query.error)}</Notice>
        <button type="button" className="secondary" onClick={() => void query.refetch()}>{t('common.retry')}</button></>}
      {query.data?.google_error && <Notice>{codeMessage(query.data.google_error)}</Notice>}
      <div className="event-calendar-options">
        {query.data?.google_url && !query.error && !query.isFetching && <a className="button" href={query.data.google_url} target="_blank" rel="noreferrer">Google Calendar</a>}
        <button type="button" className="secondary" disabled={download.busy} onClick={() => void download.run(async () => {
          await downloadFile(`/events/${value.id}/calendar.ics`, `event-${value.id}.ics`)
        })}><Icon name="download" />{download.busy ? t('events.calendar.downloading') : t('events.calendar.download')}</button>
      </div>
      {download.notice}
      <p className="muted">{t('events.calendar.help')}</p>
    </Modal>}
  </>
}

export type EventModalState = { eventModal?: boolean }
// Marks a detail dialog opened from the app, so closing it can return through history.
export const eventModalState: EventModalState = { eventModal: true }

export function useEventLink() {
  const location = useLocation()
  return (id: number): To => {
    const params = new URLSearchParams(location.search)
    params.set('event', String(id))
    return { pathname: location.pathname, search: `?${params}` }
  }
}

export function EventCards({ items, zone, dimPast = false }: { items: EventOccurrenceOut[]; zone: string; dimPast?: boolean }) {
  const { t } = useI18n()
  const eventLink = useEventLink()
  const groups = new Map<string, EventOccurrenceOut[]>()
  for (const item of items) {
    const key = item.day
    const group = groups.get(key) || []
    group.push(item); groups.set(key, group)
  }
  return <div className="event-timeline">{[...groups].map(([date, values]) => <section key={date} className="event-day">
    <h2><time dateTime={date}>{day(date)}</time></h2>
    <ol>{values.map(({ event: value, is_continuation, is_last_day, is_past }) => {
      const past = dimPast && is_past
      return <li key={value.id} className={`card event-card${is_continuation ? ' event-continuation' : ''}${past ? ' event-past' : ''}`}>
        <h3><Link to={eventLink(value.id)} state={eventModalState}>{value.title}</Link></h3>
        {past && <p className="sr-only">{t('events.cards.finished')}</p>}
        {is_continuation ? <>
          <p className="event-continuation-note"><Icon name="arrow-right" size={16} />
            {is_last_day ? t('events.cards.continuesLastDay') : t('events.cards.continues')}
          </p>
          {value.deleted_at && <span className="tag">{t('events.cards.deleted')}</span>}
        </> : <>
          <p className="event-schedule">{eventRange(value, zone, true)}</p>
          {value.location && <p className="event-text">{value.location}</p>}
          <EventActionLink value={value} />
          {value.deleted_at ? <span className="tag">{t('events.cards.deleted')}</span> : <CalendarButton value={value} />}
        </>}
      </li>
    })}</ol>
  </section>)}</div>
}

type Draft = {
  title: string; description: string; location: string; all_day: boolean
  starts_at: string; ends_at: string; starts_on: string; last_day: string
  action: EventActionOut | null
}

export function eventDraft(value: EventOut | null, zone: string, initialAction?: EventActionOut): Draft {
  const today = localInput(new Date().toISOString(), zone).slice(0, 10)
  const startDate = value?.starts_at ? localInput(value.starts_at, zone).slice(0, 10) : today
  const endDate = value?.ends_at ? localInput(value.ends_at, zone).slice(0, 10) : startDate
  return {
    title: value?.title || '', description: value?.description || '', location: value?.location || '',
    all_day: value?.all_day || false,
    starts_at: value?.starts_at ? localInput(value.starts_at, zone) : '',
    ends_at: value?.ends_at ? localInput(value.ends_at, zone) : '',
    starts_on: value?.starts_on || startDate, last_day: value?.ends_on ? shiftDay(value.ends_on, -1) : endDate,
    action: value?.action || initialAction || null,
  }
}

export function eventBody(draft: Draft, zone: string, includeAction: boolean): EventIn {
  if (!draft.all_day && [draft.starts_at, draft.ends_at].some(value => !/T\d{2}:\d{2}/.test(value))) {
    throw new Error(t('events.editor.timesRequired'))
  }
  return {
    title: draft.title, description: draft.description, location: draft.location,
    timezone: zone, all_day: draft.all_day,
    starts_at: draft.all_day ? null : draft.starts_at,
    ends_at: draft.all_day ? null : draft.ends_at,
    starts_on: draft.all_day ? draft.starts_on : null,
    ends_on: draft.all_day ? shiftDay(draft.last_day, 1) : null,
    ...(includeAction ? { action_id: draft.action?.id ?? null } : {}),
  }
}

export function changeEventAllDay(draft: Draft, all_day: boolean): Draft {
  if (draft.all_day === all_day) return draft
  return all_day ? {
    ...draft, all_day,
    starts_on: draft.starts_at.split('T')[0] || draft.starts_on,
    last_day: draft.ends_at.split('T')[0] || draft.last_day,
  } : {
    ...draft, all_day,
    starts_at: `${draft.starts_on}T`, ends_at: `${draft.last_day}T`,
  }
}

export function rebaseEventDraft(draft: Draft, base: EventOut, current: EventOut, zone: string, currentZone = zone): Draft {
  const old = eventDraft(base, zone), next = eventDraft(current, currentZone)
  const schedule = (value: Draft) => [value.all_day, value.starts_at, value.ends_at, value.starts_on, value.last_day]
  const unchanged = JSON.stringify(schedule(draft)) === JSON.stringify(schedule(old))
  return {
    ...(unchanged ? next : draft),
    title: draft.title === old.title ? next.title : draft.title,
    description: draft.description === old.description ? next.description : draft.description,
    location: draft.location === old.location ? next.location : draft.location,
    action: draft.action?.id === old.action?.id ? next.action : draft.action,
  }
}

function ActionPicker({ selected, change, disabled }: {
  selected: EventActionOut | null; change: (value: EventActionOut | null) => void; disabled: boolean
}) {
  const { t } = useI18n()
  const [search, setSearch] = useState(''), [page, setPage] = useState(1), [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1), [position, setPosition] = useState<CSSProperties>({})
  const id = useId(), field = useRef<HTMLInputElement>(null), popup = useRef<HTMLDivElement>(null)
  const options = useRef<HTMLUListElement>(null)
  const expanded = open && !disabled
  const params = new URLSearchParams({ q: search.trim(), scope: 'all', page: String(page), sort: 'title', direction: 'asc' })
  const query = useQuery({
    queryKey: ['actions', 'event-picker', params.toString()],
    queryFn: ({ signal }) => api<ActionPage>(`/actions/items?${params}`, 'GET', undefined, signal),
    enabled: expanded,
  })
  const suggestions = query.error ? [] : query.data?.items || []
  useLayoutEffect(() => {
    if (!expanded) return
    const viewport = window.visualViewport
    function reposition(event?: Event) {
      if (!field.current || event?.target instanceof Node && popup.current?.contains(event.target)) return
      const bounds = field.current.getBoundingClientRect()
      const left = viewport?.offsetLeft || 0, top = viewport?.offsetTop || 0
      const viewportWidth = viewport?.width || window.innerWidth
      const viewportHeight = viewport?.height || window.innerHeight
      const width = Math.min(bounds.width, viewportWidth - 16)
      const below = top + viewportHeight - bounds.bottom - 8
      const above = below < 180 && bounds.top - top > below
      setPosition({
        left: Math.max(left + 8, Math.min(bounds.left, left + viewportWidth - width - 8)), width,
        maxHeight: Math.max(0, Math.min(300, above ? bounds.top - top - 8 : below)),
        ...(above ? { bottom: window.innerHeight - bounds.top + 4 } : { top: bounds.bottom + 4 }),
      })
    }
    reposition()
    window.addEventListener('resize', reposition)
    window.addEventListener('scroll', reposition, true)
    viewport?.addEventListener('resize', reposition)
    viewport?.addEventListener('scroll', reposition)
    return () => {
      window.removeEventListener('resize', reposition)
      window.removeEventListener('scroll', reposition, true)
      viewport?.removeEventListener('resize', reposition)
      viewport?.removeEventListener('scroll', reposition)
    }
  }, [expanded])
  useLayoutEffect(() => {
    if (expanded && active >= 0) options.current?.children.item(active)?.scrollIntoView({ block: 'nearest' })
  }, [expanded, active])
  function openOptions() {
    if (!open) { setSearch(''); setPage(1); setActive(-1) }
    setOpen(true)
  }
  function choose(value: EventActionOut | null) {
    change(value); field.current?.focus(); setOpen(false); setSearch(''); setActive(-1)
  }
  return <div className="event-picker" onBlur={event => {
    if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setOpen(false)
  }} onKeyDown={event => {
    if (event.key === 'Escape' && expanded) {
      event.preventDefault(); event.stopPropagation(); field.current?.focus(); setOpen(false)
    }
  }}>
    <label htmlFor={id}>{t('events.picker.label')}</label>
    <div className="event-picker-control">
      <input id={id} ref={field} role="combobox" name="action_id" autoComplete="off" aria-autocomplete="list"
        aria-expanded={expanded} aria-controls={expanded ? `${id}-options` : undefined}
        aria-activedescendant={expanded && suggestions[active] ? `${id}-option-${suggestions[active].id}` : undefined}
        value={expanded ? search : selected?.title || ''} placeholder={selected?.title || t('events.picker.placeholder')}
        maxLength={200} disabled={disabled} onFocus={openOptions} onClick={openOptions}
        onChange={event => { setSearch(event.target.value); setPage(1); setActive(-1); setOpen(true) }}
        onKeyDown={event => {
          if (event.nativeEvent.isComposing) return
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            if (!expanded) { openOptions(); return }
            setActive(index => event.key === 'ArrowDown'
              ? Math.min(index + 1, suggestions.length - 1)
              : index < 0 ? suggestions.length - 1 : Math.max(0, index - 1))
          } else if (event.key === 'Tab') {
            setOpen(false)
          } else if (event.key === 'Enter' && expanded) {
            event.preventDefault()
            const item = suggestions[active]
            if (item) choose({ id: item.id, title: item.title })
          }
        }} />
      {selected && <button type="button" className="quiet icon-button" disabled={disabled}
        aria-label={t('events.picker.remove')} title={t('events.picker.remove')} onClick={() => choose(null)}><Icon name="close" size={16} /></button>}
    </div>
    {expanded && <div ref={popup} className="event-picker-dropdown" style={position}>
      {query.isPending && <Notice>{t('events.picker.loading')}</Notice>}
      {query.error && <><Notice error>{errorMessage(query.error)}</Notice>
        <button type="button" className="quiet" onClick={() => void query.refetch()}>{t('events.picker.retry')}</button></>}
      {query.data && !query.error && !suggestions.length && <Notice>{t('events.picker.empty')}</Notice>}
      <ul ref={options} id={`${id}-options`} role="listbox" aria-label={t('events.picker.options')} className="event-picker-list">
        {suggestions.map((item, index) => <li key={item.id} id={`${id}-option-${item.id}`} role="option" tabIndex={-1}
          aria-selected={selected?.id === item.id} data-active={active === index || undefined}
          onClick={() => choose({ id: item.id, title: item.title })}>
          <span>{item.title}</span>{selected?.id === item.id && <Icon name="check" size={16} />}
        </li>)}
      </ul>
      {query.data && !query.error && <Pagination page={page} pages={query.data.pages}
        change={value => { setPage(value); setActive(-1) }} busy={query.isFetching} label={t('events.picker.pagination')} />}
    </div>}
  </div>
}

export function EventEditor({ value, timezone, initialAction, close, saved }: {
  value: EventOut | null; timezone: string; initialAction?: EventActionOut
  close: () => void; saved: (value: EventOut) => void
}) {
  const { t } = useI18n()
  const [base, setBase] = useState(value), [zone, setZone] = useState(timezone)
  const [draft, setDraft] = useState(() => eventDraft(value, timezone, initialAction))
  const [linkChanged, setLinkChanged] = useState(false)
  const [current, setCurrent] = useState<EventOut | null>(null)
  const operation = useAction(['events']), refresh = useAction(false), features = useFeatures()
  const id = useId()
  const formRef = useRef<HTMLFormElement>(null)
  const actions = features.data?.actions === true && !features.error
  const stale = operation.failure instanceof ApiError && operation.failure.code === 'event_stale'
  const zoneChanged = operation.failure instanceof ApiError && operation.failure.code === 'event_timezone_changed'
  const busy = operation.busy || refresh.busy
  const errors = operation.failure instanceof ApiError ? operation.failure.fields : {}
  useEffect(() => {
    if (value && !linkChanged && actions) setDraft(previous => ({ ...previous, action: value.action }))
  }, [value, linkChanged, actions])
  useEffect(() => {
    const form = formRef.current
    if (!form || !(operation.failure instanceof ApiError)) return
    const field = Object.keys(operation.failure.fields).find(name => form.elements.namedItem(name) instanceof HTMLElement)
    if (field && !focusEventDateField(form, field, operation.failure.code.startsWith('event_time_'))) focusFormField(form, field)
  }, [operation.failure])
  function fieldError(field: string) {
    return errors[field] ? <Notice key={field} error id={`${id}-${field}`}>{codeMessage(errors[field])}</Notice> : null
  }
  function inputError(field: string) {
    return { 'aria-invalid': !!errors[field] || undefined, 'aria-describedby': errors[field] ? `${id}-${field}` : undefined }
  }
  function dismiss() {
    if (JSON.stringify(draft) === JSON.stringify(eventDraft(base, zone, initialAction)) || window.confirm(t('events.editor.discard'))) close()
  }
  function changeSchedule(next: Draft) {
    setDraft(next)
    if (operation.failure instanceof ApiError && !stale && !zoneChanged) operation.reset()
  }
  const today = localInput(new Date().toISOString(), zone).slice(0, 10)
  return <Modal title={base ? t('events.editor.editTitle') : t('events.editor.createTitle')} close={dismiss} disabled={busy} className="event-editor">
    <form ref={formRef} onSubmit={event => {
      event.preventDefault()
      if (busy || stale || zoneChanged) return
      void operation.run(async () => {
        const body = eventBody(draft, zone, actions && (!base || linkChanged))
        const result = await api<EventOut>(base ? `/events/${base.id}` : '/events', base ? 'PATCH' : 'POST',
          base ? { ...body, version: base.version } : body)
        cacheEvent(result)
        saved(result)
      })
    }}>
      <label>{t('events.editor.fields.title')}<input name="title" required maxLength={200} value={draft.title} disabled={busy} {...inputError('title')} onChange={event => setDraft({ ...draft, title: event.target.value })} /></label>
      {fieldError('title')}
      <label>{t('events.editor.fields.description')}<textarea name="description" rows={4} maxLength={20000} value={draft.description} disabled={busy} {...inputError('description')} onChange={event => setDraft({ ...draft, description: event.target.value })} /></label>
      {fieldError('description')}
      <label>{t('events.editor.fields.location')}<input name="location" maxLength={200} value={draft.location} disabled={busy} {...inputError('location')} onChange={event => setDraft({ ...draft, location: event.target.value })} /></label>
      {fieldError('location')}
      <label className="check"><input type="checkbox" checked={draft.all_day} disabled={busy} onChange={event => changeSchedule(changeEventAllDay(draft, event.target.checked))} />{t('events.editor.fields.allDay')}</label>
      <div className="form-grid">{draft.all_day ? <>
        <EventDateField name="starts_on" label={t('events.editor.fields.firstDay')} value={draft.starts_on} today={today}
          disabled={busy} error={errors.starts_on} errorId={`${id}-starts_on`} change={starts_on => changeSchedule({
            ...draft, starts_on,
            last_day: draft.last_day === draft.starts_on || starts_on > draft.last_day ? starts_on : draft.last_day,
          })} />
        <EventDateField name="ends_on" label={t('events.editor.fields.lastDay')} value={draft.last_day} min={draft.starts_on} today={today}
          disabled={busy} error={errors.ends_on} errorId={`${id}-ends_on`} change={last_day => changeSchedule({ ...draft, last_day })} />
      </> : <>
        <EventDateField name="starts_at" label={t('events.editor.fields.start')} timeLabel={t('events.editor.fields.startTime')}
          value={draft.starts_at} today={today} withTime
          disabled={busy} error={errors.starts_at} errorId={`${id}-starts_at`} change={starts_at => changeSchedule({ ...draft, starts_at })} />
        <EventDateField name="ends_at" label={t('events.editor.fields.end')} timeLabel={t('events.editor.fields.endTime')}
          value={draft.ends_at} min={draft.starts_at} today={today} withTime
          disabled={busy} error={errors.ends_at} errorId={`${id}-ends_at`} change={ends_at => changeSchedule({ ...draft, ends_at })} />
      </>}</div>
      {['interval', 'starts_at', 'ends_at', 'starts_on', 'ends_on'].map(fieldError)}
      {actions ? <ActionPicker selected={draft.action} disabled={busy} change={action => { setDraft({ ...draft, action }); setLinkChanged(true) }} />
        : <p className="muted">{t('events.editor.actionsUnavailable')}</p>}
      {fieldError('action_id')}{operation.notice}{refresh.notice}
      {stale && base && <section className="action-conflict">
        <p>{t('events.editor.stale')}</p>
        <button type="button" className="secondary" disabled={busy} onClick={() => void refresh.run(async () => {
          setCurrent(await api<EventOut>(`/events/${base.id}`))
        })}>{t('events.editor.loadCurrent')}</button>
      </section>}
      {current && base && <section className="action-conflict">
        <h3>{t('events.editor.current')}</h3><EventSnapshotView value={current} zone={zone} />
        {current.deleted_at ? <Notice error>{t('events.editor.currentDeleted')}</Notice> : <>
          <p>{t('events.editor.rebaseHelp')}</p>
          <button type="button" className="secondary" disabled={busy} onClick={() => {
            setDraft(rebaseEventDraft(draft, base, current, zone))
            setBase(current); cacheEvent(current); setCurrent(null); operation.reset()
          }}>{t('events.editor.rebase')}</button>
        </>}
      </section>}
      {zoneChanged && <button type="button" className="secondary" disabled={busy} onClick={() => void refresh.run(async () => {
        const config = await api<EventConfigOut>('/events/config')
        if (base) setDraft(previous => rebaseEventDraft(previous, base, base, zone, config.timezone))
        cache.setQueryData(['events', 'config'], config); setZone(config.timezone); operation.reset()
      })}>{t('events.editor.reloadTimeZone')}</button>}
      <div className="inline"><button disabled={busy || stale || zoneChanged}>{operation.busy ? t('common.saving') : t('events.editor.save')}</button>
        <button type="button" className="secondary" disabled={busy} onClick={dismiss}>{t('common.cancel')}</button></div>
    </form>
  </Modal>
}

export function EventSnapshotView({ value, zone }: { value: EventSnapshot; zone: string }) {
  const { t } = useI18n()
  return <div className="event-text"><strong>{value.title}</strong><p>{eventRange(value, zone)}</p>
    {value.location && <p>{value.location}</p>}<p>{value.description || t('events.detail.noDescription')}</p><EventActionLink value={value} /></div>
}
