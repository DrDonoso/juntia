import { useState, type DragEvent } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router'
import { ApiError, api, cache, errorMessage } from './api/client'
import type { ActionBoardOut, ActionColumnOut, ActionPage, ActionSummaryOut } from './api/schema.gen'
import { formatNumber, useI18n } from './i18n'
import { Notice, useAction } from './shared'
import { Icon } from './icons'
import { ActionLabelBadge, ActionPagination, ActionTime, StatusBadge, StatusControl, attachmentCountLabel, commentCountLabel, type ActionStatus } from './community-action-shared'

function BoardColumn({ initial, filters, basePath, search, dragged, busy, start, end, drop }: {
  initial: ActionColumnOut; filters: string; basePath: string; search: string
  dragged: ActionSummaryOut | null; busy: boolean
  start: (item: ActionSummaryOut) => void; end: () => void; drop: (status: ActionStatus) => void
}) {
  const { t } = useI18n()
  const [page, setPage] = useState(1)
  const [over, setOver] = useState(false)
  const params = new URLSearchParams(filters)
  params.set('status', initial.status); params.set('page', String(page))
  const query = useQuery({
    queryKey: ['actions', 'column', params.toString()],
    queryFn: () => api<ActionPage>(`/actions/items?${params}`), enabled: page > 1,
  })
  const data = page === 1 ? initial : query.data
  function dragOver(event: DragEvent) {
    if (!dragged || busy) return
    event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setOver(true)
  }
  const closedHidden = (initial.status === 'done' || initial.status === 'discarded')
    && (new URLSearchParams(filters).get('scope') || 'open') === 'open'
  const status = t(`actions.status.${initial.status}`)
  return <section className={`action-column${over && dragged && !busy ? ' drag-over' : ''}`} aria-label={status}
    onDragOver={dragOver} onDragLeave={event => {
      if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setOver(false)
    }} onDrop={event => {
      event.preventDefault(); setOver(false)
      if (dragged && !busy) drop(initial.status)
    }}>
    <header><h2><StatusBadge status={initial.status} /></h2><span className="tag" aria-label={t('actions.board.total', { count: initial.total })}>{formatNumber(initial.total)}</span></header>
    {closedHidden && <p className="muted">{t('actions.board.closedHidden')}</p>}
    {page > 1 && query.isPending && <Notice>{t('actions.board.loadingColumn')}</Notice>}
    {query.error && <Notice error>{errorMessage(query.error)}</Notice>}
    {data && <>
      <ul className="action-column-list" tabIndex={data.items.length ? 0 : undefined} aria-label={t('actions.board.cards', { status })}>{data.items.map(item => <li key={item.id} className="action-board-card" draggable={!busy}
        onDragStart={event => {
          event.dataTransfer.effectAllowed = 'move'
          event.dataTransfer.setData('text/plain', String(item.id))
          start(item)
        }} onDragEnd={end}>
        <div className="action-card-top"><span className="muted">#{item.id}</span>
          <span className="action-drag-handle" draggable={!busy} title={t('actions.board.drag')} aria-hidden="true"><Icon name="grip" /></span></div>
        <h3><Link to={`${basePath}/${item.id}${search}`}>{item.title}</Link></h3>
        <div className="chips">{item.labels.map(label => <ActionLabelBadge key={label.id} label={label} />)}</div>
        <p className="action-card-counts">{commentCountLabel(item.comment_count)} · {attachmentCountLabel(item.attachment_count)}</p>
        <p className="muted action-card-time"><ActionTime value={item.updated_at} /></p>
        <StatusControl item={item} />
      </li>)}</ul>
      {data.items.length === 0 && !closedHidden && <p className="action-column-empty">{t('actions.board.empty')}</p>}
      <ActionPagination page={page} pages={data.pages} change={setPage} busy={query.isFetching || busy} label={t('actions.board.pagination', { status })} />
    </>}
  </section>
}

export function ActionsBoard({ filters, basePath, search }: { filters: string; basePath: string; search: string }) {
  const { t } = useI18n()
  const query = useQuery({
    queryKey: ['actions', 'board', filters], queryFn: () => api<ActionBoardOut>(`/actions/board?${filters}`),
  })
  const [dragged, setDragged] = useState<ActionSummaryOut | null>(null)
  const operation = useAction(['actions'])
  const stale = operation.failure instanceof ApiError && operation.failure.code === 'action_stale'
  function drop(status: ActionStatus) {
    const item = dragged
    setDragged(null)
    if (!item || item.status === status) return
    void operation.run(async () => {
      await api(`/actions/items/${item.id}`, 'PATCH', { version: item.version, status })
    }, t('actions.board.saved', { status: t(`actions.status.${status}`) }))
  }
  return <section aria-label={t('actions.board.label')}>
    <p className="muted action-board-help">{t('actions.board.help')}</p>
    {operation.notice}
    {stale && <button className="secondary" disabled={operation.busy} onClick={() => void operation.run(async () => {
      await cache.invalidateQueries({ queryKey: ['actions'] })
    })}>{t('actions.board.refresh')}</button>}
    {query.isPending && <Notice>{t('actions.board.loading')}</Notice>}
    {query.error && <Notice error>{errorMessage(query.error)}</Notice>}
    {query.data && <div className="action-board" tabIndex={0} role="region" aria-label={t('actions.board.columns')}>
      {query.data.columns.map(column => <BoardColumn key={`${filters}:${column.status}`} initial={column} filters={filters}
        basePath={basePath} search={search} dragged={dragged} busy={operation.busy}
        start={setDragged} end={() => setDragged(null)} drop={drop} />)}
    </div>}
  </section>
}
