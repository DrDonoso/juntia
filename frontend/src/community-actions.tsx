import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router'
import { diffArrays } from 'diff'
import { ApiError, api, cache, errorMessage } from './api/client'
import type {
  ActionAttachmentOut, ActionAttachmentPage, ActionChange, ActionCommentOut, ActionCommentPage,
  ActionHistoryPage, ActionLabelOut, ActionOut, ActionPage, UserAuthOut,
} from './api/schema.gen'
import { useReaderAuth } from './auth'
import { Modal, Notice, hasControlCharacters, useAction } from './shared'
import {
  ActionFeatureGate, ActionLabelBadge, ActionPagination, ActionTime, Actor, PDF_BYTES, PDF_COUNT, PDFControls, StatusBadge,
  StatusControl, StatusOptions, actionDraft, actionRequestParams, attachmentCountLabel, byteSize, canModerate, commentCountLabel, createUploadId,
  isActionStatus, rebaseActionDraft, useActionLabels,
} from './community-action-shared'
import { ActionsBoard } from './community-actions-board'
import { ActionEvents } from './community-events'
import { ContactTagPicker, normalizeTagName, paletteColor, tagColor, type ContactTagChoice } from './contact-tags'
import { formatNumber, lowerCase, useI18n, type Translate } from './i18n'
import { Icon } from './icons'

type LabelError = 'actions.editor.labelInvalid' | 'actions.editor.labelLimit'

function LabelsEditor({ labels, initialLabels, change, disabled }: {
  labels: string[]; initialLabels?: ActionLabelOut[]; change: (value: string[]) => void; disabled: boolean
}) {
  const { t } = useI18n()
  const [text, setText] = useState(''), [error, setError] = useState<LabelError | null>(null)
  const [knownLabels, setKnownLabels] = useState(initialLabels || [])
  const suggestions = useActionLabels(text)
  useEffect(() => {
    setKnownLabels(previous => {
      const known = new Map(previous.map(label => [label.id, label]))
      for (const label of [...(initialLabels || []), ...(suggestions.data?.items || [])]) {
        if (label.version >= (known.get(label.id)?.version || 0)) known.set(label.id, label)
      }
      return [...known.values()]
    })
  }, [initialLabels, suggestions.data])
  const available = suggestions.data?.items.map(label => ({ ...label, color: tagColor(label) })) || []
  const selected: ContactTagChoice[] = labels.map(name => {
    const existing = knownLabels.find(label => normalizeTagName(label.name) === normalizeTagName(name))
      || initialLabels?.find(label => normalizeTagName(label.name) === normalizeTagName(name))
    return existing ? { ...existing, color: tagColor(existing) } : { id: null, name, color: paletteColor(name) }
  })
  function add(input: string): boolean {
    const value = input.normalize('NFKC').trim().replace(/\s+/g, ' ')
    if (!value) { setText(''); setError(null); return true }
    if (value.length > 100 || hasControlCharacters(value)) {
      setError('actions.editor.labelInvalid'); return false
    }
    if (labels.length >= 20) { setError('actions.editor.labelLimit'); return false }
    const existing = available.find(label => normalizeTagName(label.name) === normalizeTagName(value))
    const name = existing?.name || normalizeTagName(value)
    if (!labels.some(label => normalizeTagName(label) === normalizeTagName(name))) change([...labels, name])
    setText(''); setError(null)
    return true
  }
  return <>
    <ContactTagPicker selected={selected} available={available} input={text}
      changeInput={value => { setText(value); setError(null) }} add={add}
      remove={index => change(labels.filter((_, position) => position !== index))}
      disabled={disabled} error={error ? t(error) : undefined} texts={{
        label: t('actions.editor.labelPicker.label'), selected: t('actions.editor.labelPicker.selected'),
        available: t('actions.editor.labelPicker.available'), preview: t('actions.editor.labelPicker.preview'),
      }} />
    {suggestions.error && <Notice error>{errorMessage(suggestions.error)}</Notice>}
  </>
}

export function ActionEditor({ value, close, saved }: { value: ActionOut | null; close: () => void; saved: (value: ActionOut) => void }) {
  const { t } = useI18n()
  const [base, setBase] = useState(value)
  const [draft, setDraft] = useState(() => actionDraft(value))
  const [current, setCurrent] = useState<ActionOut | null>(null)
  const operation = useAction(['actions']), refresh = useAction(false)
  const stale = operation.failure instanceof ApiError && operation.failure.code === 'action_stale'
  const busy = operation.busy || refresh.busy
  function submit(event: FormEvent) {
    event.preventDefault()
    void operation.run(async () => {
      const body = base
        ? { ...draft, version: base.version }
        : { title: draft.title, description: draft.description, labels: draft.labels }
      const result = await api<ActionOut>(base ? `/actions/items/${base.id}` : '/actions/items', base ? 'PATCH' : 'POST',
        body)
      cache.setQueryData(['actions', 'item', result.id], result)
      saved(result)
    })
  }
  return <Modal title={base ? t('actions.editor.editTitle') : t('actions.editor.newTitle')} close={close} disabled={busy} className="action-editor">
    <form onSubmit={submit}>
      <label>{t('actions.editor.title')}<input required maxLength={200} value={draft.title} disabled={busy} onChange={event => setDraft({ ...draft, title: event.target.value })} /></label>
      <label>{t('actions.editor.description')}<textarea rows={5} maxLength={20000} value={draft.description} disabled={busy} onChange={event => setDraft({ ...draft, description: event.target.value })} /></label>
      {base && <label>{t('actions.editor.status')}<select value={draft.status} disabled={busy} onChange={event => {
        if (isActionStatus(event.target.value)) setDraft({ ...draft, status: event.target.value })
      }}><StatusOptions /></select></label>}
      <LabelsEditor labels={draft.labels} initialLabels={base?.labels} change={labels => setDraft({ ...draft, labels })} disabled={busy} />
      {!base && <p className="muted">{t('actions.editor.attachLater')}</p>}
      {operation.notice}{refresh.notice}
      {stale && base && <section className="action-conflict" aria-label={t('actions.editor.conflict')}>
        <p>{t('actions.editor.draftKept')}</p>
        <button type="button" className="secondary" disabled={busy} onClick={() => void refresh.run(async () => {
          setCurrent(await api<ActionOut>(`/actions/items/${base.id}`))
        })}>{t('actions.editor.checkCurrent')}</button>
      </section>}
      {current && base && <section className="action-conflict" aria-label={t('actions.editor.currentLabel')}>
        <h3>{t('actions.editor.current')}</h3><p><strong>{current.title}</strong></p>
        <p className="action-text">{current.description || t('actions.editor.noDescription')}</p>
        <p>{t(`actions.status.${current.status}`)} · {current.labels.map(label => label.name).join(', ') || t('actions.editor.noLabels')}</p>
        <p>{t('actions.editor.rebaseHelp')}</p>
        <button type="button" className="secondary" disabled={busy} onClick={() => {
          setDraft(rebaseActionDraft(draft, base, current)); setBase(current); setCurrent(null); operation.reset()
        }}>{t('actions.editor.rebase')}</button>
      </section>}
      <div className="inline"><button disabled={busy || stale}>{operation.busy ? t('common.saving') : t('actions.editor.save')}</button>
        <button type="button" className="secondary" disabled={busy} onClick={close}>{t('common.cancel')}</button></div>
    </form>
  </Modal>
}

function ActionFilters({ params, change }: { params: URLSearchParams; change: (mutate: (value: URLSearchParams) => void) => void }) {
  const { t } = useI18n()
  const [labelSearch, setLabelSearch] = useState(''), [labelPage, setLabelPage] = useState(1)
  const ids = params.getAll('label')
  const labels = useActionLabels(labelSearch, labelPage), selected = useActionLabels('', 1, ids)
  function set(key: string, value: string) {
    change(next => {
      if (value) next.set(key, value); else next.delete(key)
      if (key === 'status' && value) next.set('scope', 'all')
      if (key === 'scope') next.delete('status')
    })
  }
  return <section className="filters action-filters" aria-label={t('actions.filters.label')}>
    <label>{t('actions.filters.search')}<input type="search" maxLength={200} placeholder={t('actions.filters.searchPlaceholder')} value={params.get('q') || ''} onChange={event => set('q', event.target.value)} /></label>
    <label>{t('actions.filters.scope')}<select value={params.get('scope') || 'open'} onChange={event => set('scope', event.target.value)}>
      <option value="open">{t('actions.filters.scopes.open')}</option><option value="all">{t('actions.filters.scopes.all')}</option><option value="closed">{t('actions.filters.scopes.closed')}</option>
    </select></label>
    <label>{t('actions.filters.status')}<select value={params.get('status') || ''} onChange={event => set('status', event.target.value)}>
      <option value="">{t('actions.filters.allStatuses')}</option><StatusOptions />
    </select></label>
    <details className="action-label-filters"><summary>{ids.length > 0 ? t('actions.filters.labelsCount', { count: ids.length }) : t('actions.filters.labels')}</summary>
      <label>{t('actions.filters.labelSearch')}<input maxLength={100} value={labelSearch} onChange={event => { setLabelSearch(event.target.value); setLabelPage(1) }} /></label>
      <label>{t('actions.filters.addLabel')}<select value="" disabled={ids.length >= 20 || labels.isPending} onChange={event => {
        const id = event.target.value
        if (id && !ids.includes(id)) change(next => next.append('label', id))
      }}><option value="">{t('actions.filters.selectLabel')}</option>{labels.data?.items.filter(label => !ids.includes(String(label.id))).map(label => <option key={label.id} value={label.id}>{label.name}</option>)}</select></label>
      {labels.data && <ActionPagination page={labelPage} pages={labels.data.pages} change={setLabelPage} busy={labels.isFetching} label={t('actions.filters.labelPagination')} />}
      {labels.error && <Notice error>{errorMessage(labels.error)}</Notice>}
    </details>
    <button type="button" className="quiet" onClick={() => {
      setLabelSearch(''); setLabelPage(1)
      change(next => { for (const key of ['q', 'status', 'scope', 'label']) next.delete(key) })
    }}>{t('actions.filters.clear')}</button>
    {ids.length > 0 && <div className="chips action-selected-labels">{ids.map(id => {
      const name = selected.data?.items.find(label => String(label.id) === id)?.name || t('actions.filters.unknownLabel', { id })
      return <span key={id} className="filter-chip">{name}<button type="button" className="quiet" aria-label={t('actions.filters.removeLabel', { name })} onClick={() => change(next => next.delete('label', id))}><Icon name="close" size={14} /></button></span>
    })}</div>}
    {selected.error && <Notice error>{errorMessage(selected.error)}</Notice>}
  </section>
}

// Message keys, not text: the labels are translated when the table renders.
const listSortColumns = [
  { key: 'title', label: 'actions.list.columns.title' },
  { key: 'status', label: 'actions.list.columns.status' },
  { key: 'activity', label: 'actions.list.columns.activity' },
] as const
type ListSortKey = typeof listSortColumns[number]['key']

function ActionsListing() {
  const { t, rich } = useI18n()
  const [params, setParams] = useSearchParams()
  const [creating, setCreating] = useState(false)
  const navigate = useNavigate(), location = useLocation()
  const basePath = '/actions'
  const board = params.get('view') === 'board'
  const sort = params.get('sort') || 'activity', direction = params.get('direction') || 'desc'
  const filters = actionRequestParams(params)
  const request = new URLSearchParams(filters)
  request.set('page', params.get('page') || '1')
  request.set('sort', sort); request.set('direction', direction)
  const query = useQuery({
    queryKey: ['actions', 'list', request.toString()],
    queryFn: () => api<ActionPage>(`/actions/items?${request}`), enabled: !board,
  })
  function change(mutate: (value: URLSearchParams) => void) {
    setParams(previous => {
      const next = new URLSearchParams(previous); mutate(next); next.delete('page'); return next
    }, { replace: true })
  }
  function changeSort(column: ListSortKey) {
    change(next => {
      const current = next.get('sort') || 'activity', order = next.get('direction') || 'desc'
      next.set('sort', column)
      next.set('direction', current === column ? order === 'asc' ? 'desc' : 'asc' : column === 'activity' ? 'desc' : 'asc')
    })
  }
  return <>
    <div className="page-heading"><div><p className="eyebrow">{t('actions.list.eyebrow')}</p><h1>{t('actions.list.title')}</h1>
      <p className="muted">{t('actions.list.intro')}</p></div>
      <button onClick={() => setCreating(true)}>{t('actions.list.new')}</button></div>
    <div className="action-toolbar">
      <div role="group" aria-label={t('actions.list.view')} className="action-view-switch">
        <button type="button" className={board ? 'secondary' : ''} aria-pressed={!board} onClick={() => change(next => next.delete('view'))}>{t('actions.list.listView')}</button>
        <button type="button" className={board ? '' : 'secondary'} aria-pressed={board} onClick={() => change(next => next.set('view', 'board'))}>{t('actions.list.boardView')}</button>
      </div>
      <button type="button" className="quiet" onClick={() => void cache.invalidateQueries({ queryKey: ['actions'] })}>{t('actions.list.refresh')}</button>
    </div>
    <ActionFilters params={params} change={change} />
    {board ? <ActionsBoard filters={filters.toString()} basePath={basePath} search={location.search} /> : <>
      {query.isPending && <Notice>{t('actions.list.loading')}</Notice>}
      {query.error && <Notice error>{errorMessage(query.error)}</Notice>}
      <section className="card">
        {query.data && <p className="muted">{t('actions.list.total', { count: query.data.total })}</p>}
          <div className="table-scroll"><table className="actions-table" aria-label={t('actions.list.table')} aria-busy={query.isFetching}>
            <thead><tr>{listSortColumns.map(column => {
              const active = sort === column.key && (direction === 'asc' || direction === 'desc')
              const label = t(column.label)
              return <th key={column.key} scope="col" aria-label={label} aria-sort={active ? direction === 'asc' ? 'ascending' : 'descending' : 'none'}>
                <button type="button" className="table-sort-button" aria-label={t('actions.list.sortBy', { column: lowerCase(label) })} onClick={() => changeSort(column.key)}>
                  {label}<Icon name={active ? direction === 'asc' ? 'arrow-up' : 'arrow-down' : 'sort'} size={14} />
                </button>
              </th>
            })}<th scope="col">{t('actions.list.columns.counts')}</th></tr></thead>
            <tbody>{query.data?.items.map(item => <tr key={item.id}>
              <td><Link className="action-title-link" to={`${basePath}/${item.id}${location.search}`}>#{item.id} · {item.title}</Link>
                <div className="chips">{item.labels.map(label => <ActionLabelBadge key={label.id} label={label} />)}</div>
                <small>{rich('actions.list.createdBy', { actor: () => <Actor value={item.author} /> })}</small></td>
              <td><StatusControl item={item} hideLabel /></td>
              <td><ActionTime value={item.updated_at} /></td>
              <td>{commentCountLabel(item.comment_count)}<br />{attachmentCountLabel(item.attachment_count)}</td>
            </tr>)}
            {query.data?.items.length === 0 && <tr><td colSpan={4} className="empty">{t('actions.list.empty')}</td></tr>}
            </tbody>
          </table></div>
        {query.data && <ActionPagination page={query.data.page} pages={query.data.pages} busy={query.isFetching} label={t('actions.list.pagination')} change={page => setParams(previous => {
          const next = new URLSearchParams(previous); next.set('page', String(page)); return next
        })} />}
      </section>
    </>}
    {creating && <ActionEditor value={null} close={() => setCreating(false)} saved={value => {
      setCreating(false); navigate(`${basePath}/${value.id}${location.search}`)
    }} />}
  </>
}

export function ActionsPage() {
  const reader = useReaderAuth()
  return <ActionFeatureGate><ActionsListing key={`${reader.data?.kind}:${reader.data?.user_id}`} /></ActionFeatureGate>
}

function WithdrawDialog({ title, description, kept, endpoint, version, close }: {
  title: string; description: string; kept?: string; endpoint: string; version: number; close: () => void
}) {
  const { t } = useI18n()
  const operation = useAction(['actions'])
  function dismiss() { close(); void cache.invalidateQueries({ queryKey: ['actions'] }) }
  return <Modal title={title} close={dismiss} disabled={operation.busy}>
    <p>{description}</p><p>{kept ?? t('actions.withdraw.kept')}</p>
    {operation.notice}<div className="inline">
      <button disabled={operation.busy} onClick={() => void operation.run(async () => {
        await api(endpoint, 'DELETE', { version }); close()
      })}>{t('actions.withdraw.confirm')}</button>
      <button type="button" className="secondary" disabled={operation.busy} onClick={dismiss}>{t('common.cancel')}</button>
    </div>
  </Modal>
}

function CommentEditor({ itemId, value, close }: { itemId: number; value: ActionCommentOut; close: () => void }) {
  const { t } = useI18n()
  const [body, setBody] = useState(value.body || ''), [version, setVersion] = useState(value.version)
  const [current, setCurrent] = useState<ActionCommentOut | null>(null)
  const operation = useAction(['actions']), refresh = useAction(false)
  const stale = operation.failure instanceof ApiError && operation.failure.code === 'action_stale'
  const endpoint = `/actions/items/${itemId}/comments/${value.id}`
  const busy = operation.busy || refresh.busy
  return <Modal title={t('actions.comments.editor.title')} close={close} disabled={busy}>
    <form onSubmit={event => { event.preventDefault(); void operation.run(async () => {
      await api(endpoint, 'PATCH', { body, version }); close()
    }) }}>
      <label>{t('actions.comments.editor.body')}<textarea required maxLength={10000} rows={5} value={body} disabled={busy} onChange={event => setBody(event.target.value)} /></label>
      <p className="muted">{t('actions.comments.editor.historyKept')}</p>
      {operation.notice}{refresh.notice}
      {stale && <button type="button" className="secondary" disabled={busy} onClick={() => void refresh.run(async () => {
        setCurrent(await api<ActionCommentOut>(endpoint))
      })}>{t('actions.comments.editor.checkCurrent')}</button>}
      {current && <section className="action-conflict">
        <h3>{t('actions.comments.editor.current')}</h3><p className="action-text">{current.body || t('actions.comments.editor.withdrawn')}</p>
        {!current.withdrawn_at && <button type="button" className="secondary" onClick={() => {
          setVersion(current.version); setCurrent(null); operation.reset()
        }}>{t('actions.comments.editor.keepMine')}</button>}
      </section>}
      <div className="inline"><button disabled={busy || stale || !!current?.withdrawn_at || !body.trim()}>{t('actions.comments.editor.save')}</button>
        <button type="button" className="secondary" disabled={busy} onClick={close}>{t('common.cancel')}</button></div>
    </form>
  </Modal>
}

export function ActionComments({ itemId, reader, onHistory }: { itemId: number; reader?: UserAuthOut; onHistory: () => void }) {
  const { t, rich } = useI18n()
  const [page, setPage] = useState(1), [body, setBody] = useState('')
  const [editing, setEditing] = useState<ActionCommentOut | null>(null)
  const [withdrawing, setWithdrawing] = useState<ActionCommentOut | null>(null)
  const operation = useAction(['actions'])
  const query = useQuery({
    queryKey: ['actions', 'comments', itemId, page],
    queryFn: () => api<ActionCommentPage>(`/actions/items/${itemId}/comments?page=${page}`),
  })
  return <section className="card" aria-labelledby="action-comments-heading"><h2 id="action-comments-heading">{t('actions.comments.title')}</h2>
    <form className="action-comment-form" onSubmit={event => { event.preventDefault(); void operation.run(async () => {
      await api(`/actions/items/${itemId}/comments`, 'POST', { body }); setBody(''); setPage(1)
    }, t('actions.comments.posted')) }}>
      <label>{t('actions.comments.new')}<textarea required maxLength={10000} rows={3} value={body} disabled={operation.busy} onChange={event => setBody(event.target.value)} /></label>
      <button disabled={operation.busy || !body.trim()}>{t('actions.comments.post')}</button>
      {operation.notice}
    </form>
    {query.isPending && <Notice>{t('actions.comments.loading')}</Notice>}
    {query.error && <Notice error>{errorMessage(query.error)}</Notice>}
    {query.data && <>
      {query.data.items.length === 0 && <p className="muted">{t('actions.comments.empty')}</p>}
      <ul className="action-comment-list">{query.data.items.map(comment => <li key={comment.id}>
        <div className="action-entry-meta"><strong><Actor value={comment.author} /></strong><ActionTime value={comment.created_at} /></div>
        {comment.withdrawn_at ? <>
          <p className="muted">{t('actions.comments.withdrawn')}</p>
          <button type="button" className="quiet" onClick={onHistory}>{t('actions.comments.viewHistory')}</button>
        </> : <>
          <p className="action-text">{comment.body}</p>
          {comment.version > 1 && <small className="muted">{rich('actions.comments.edited', { time: () => <ActionTime value={comment.updated_at} /> })}</small>}
          {canModerate(comment.author, reader) && <div className="inline">
            <button type="button" className="quiet" aria-label={t('actions.comments.editLabel', { id: comment.id })} onClick={() => setEditing(comment)}>{t('actions.comments.edit')}</button>
            <button type="button" className="quiet" aria-label={t('actions.comments.withdrawLabel', { id: comment.id })} onClick={() => setWithdrawing(comment)}>{t('actions.comments.withdraw')}</button>
          </div>}
        </>}
      </li>)}</ul>
      <ActionPagination page={page} pages={query.data.pages} change={setPage} busy={query.isFetching} label={t('actions.comments.pagination')} />
    </>}
    {editing && <CommentEditor key={editing.id} itemId={itemId} value={editing} close={() => setEditing(null)} />}
    {withdrawing && <WithdrawDialog title={t('actions.comments.withdrawTitle')} description={withdrawing.body || ''} endpoint={`/actions/items/${itemId}/comments/${withdrawing.id}`}
      version={withdrawing.version} close={() => setWithdrawing(null)} />}
  </section>
}

function AttachmentNameEditor({ itemId, value, close }: { itemId: number; value: ActionAttachmentOut; close: () => void }) {
  const { t } = useI18n()
  const [filename, setFilename] = useState(value.filename), [version, setVersion] = useState(value.version)
  const [current, setCurrent] = useState<ActionAttachmentOut | null>(null), [invalid, setInvalid] = useState(false)
  const operation = useAction(['actions']), refresh = useAction(false)
  const stale = operation.failure instanceof ApiError && operation.failure.code === 'action_stale'
  const endpoint = `/actions/items/${itemId}/attachments/${value.id}`
  const busy = operation.busy || refresh.busy
  return <Modal title={t('actions.attachments.rename')} close={close} disabled={busy}>
    <form onSubmit={event => {
      event.preventDefault()
      const name = filename.trim(), stem = /\.pdf$/i.test(name) ? name.slice(0, -4).trim() : name
      if (!stem.replace(/[ .]/g, '') || stem.length > 251 || /[/\\\p{Cf}]/u.test(filename) || hasControlCharacters(filename)) {
        setInvalid(true); return
      }
      void operation.run(async () => {
        await api<ActionAttachmentOut>(endpoint, 'PATCH', { version, filename: `${stem}.pdf` }); close()
      })
    }}>
      <label>{t('actions.attachments.renameDialog.name')}<input required maxLength={255} value={filename} disabled={busy} aria-invalid={invalid || undefined}
        onChange={event => { setFilename(event.target.value); setInvalid(false) }} /></label>
      <p className="muted">{t('actions.attachments.renameDialog.help')}</p>
      {invalid && <Notice error>{t('actions.attachments.renameDialog.invalid')}</Notice>}{operation.notice}{refresh.notice}
      {stale && <button type="button" className="secondary" disabled={busy} onClick={() => void refresh.run(async () => {
        setCurrent(await api<ActionAttachmentOut>(endpoint))
      })}>{t('actions.attachments.renameDialog.checkCurrent')}</button>}
      {current && <section className="action-conflict">
        <h3>{t('actions.attachments.renameDialog.current')}</h3><p>{current.filename}</p>
        {current.withdrawn_at ? <Notice error>{t('actions.attachments.renameDialog.withdrawn')}</Notice>
          : <button type="button" className="secondary" disabled={busy} onClick={() => {
            setVersion(current.version); setCurrent(null); operation.reset()
          }}>{t('actions.attachments.renameDialog.keepMine')}</button>}
      </section>}
      <div className="inline"><button disabled={busy || stale || !!current?.withdrawn_at}>{t('actions.attachments.renameDialog.save')}</button>
        <button type="button" className="secondary" disabled={busy} onClick={close}>{t('common.cancel')}</button></div>
    </form>
  </Modal>
}

type PDFUpload = { id: string; file: File }
type FailedPDF = PDFUpload & { cause: unknown; retryable: boolean }
// Stored as data, not text, so the message follows a later language switch.
type SelectionError =
  | { kind: 'slots'; available: number }
  | { kind: 'invalid' | 'tooLarge'; name: string }
  | { kind: 'interrupted' }

export function ActionAttachments({ item, reader }: { item: ActionOut; reader?: UserAuthOut }) {
  const { t, rich } = useI18n()
  const [page, setPage] = useState(1)
  const [failures, setFailures] = useState<FailedPDF[]>([]), [selectionError, setSelectionError] = useState<SelectionError | null>(null)
  const [uploadingName, setUploadingName] = useState('')
  const [editing, setEditing] = useState<ActionAttachmentOut | null>(null)
  const [withdrawing, setWithdrawing] = useState<ActionAttachmentOut | null>(null)
  const operation = useAction(false), alive = useRef(true), uploading = useRef(false)
  const fileInput = useRef<HTMLInputElement>(null)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  useEffect(() => {
    if (!operation.busy) return
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault() }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [operation.busy])
  const query = useQuery({
    queryKey: ['actions', 'attachments', item.id, page],
    queryFn: () => api<ActionAttachmentPage>(`/actions/items/${item.id}/attachments?page=${page}`),
  })
  const activeCount = query.data?.total ?? item.attachment_count
  function selectFiles(files: FileList | null) {
    const selected = Array.from(files || [])
    if (!selected.length || uploading.current) return
    setSelectionError(null)
    if (selected.length > PDF_COUNT - activeCount) {
      setSelectionError({ kind: 'slots', available: Math.max(0, PDF_COUNT - activeCount) })
      return
    }
    for (const file of selected) {
      const kind = !/\.pdf$/i.test(file.name) || file.size === 0 ? 'invalid' : file.size > PDF_BYTES ? 'tooLarge' : null
      if (kind) { setSelectionError({ kind, name: file.name }); return }
    }
    setPage(1)
    uploadFiles(selected.map(file => ({ id: createUploadId(), file })))
  }
  function uploadFiles(entries: PDFUpload[]) {
    if (uploading.current) return
    uploading.current = true
    setSelectionError(null)
    void operation.run(async () => {
      for (const [index, entry] of entries.entries()) {
        if (!alive.current) break
        setUploadingName(entry.file.name)
        setFailures(previous => previous.filter(value => value.id !== entry.id))
        const data = new FormData(); data.append('file', entry.file); data.append('upload_id', entry.id)
        let stop = false
        try {
          await api<ActionAttachmentOut>(`/actions/items/${item.id}/attachments`, 'POST', data)
        } catch (error) {
          if (alive.current) setFailures(previous => [...previous, {
            ...entry, cause: error, retryable: !(error instanceof ApiError) || error.status >= 500,
          }])
          stop = error instanceof ApiError && (error.status === 401 || [
            'session_changed', 'actions_disabled', 'action_attachment_limit',
            // Storage is exhausted: the next files would be sent in full only to be refused too.
            'action_storage_user_quota', 'action_storage_community_quota', 'storage_low_space',
          ].includes(error.code))
          if (stop && alive.current && index < entries.length - 1) setSelectionError({ kind: 'interrupted' })
        } finally {
          await cache.invalidateQueries({ queryKey: ['actions'] })
        }
        if (stop) break
      }
    }).finally(() => {
      uploading.current = false
      if (alive.current) setUploadingName('')
    })
  }
  function selectionMessage(error: SelectionError): string {
    switch (error.kind) {
      case 'slots': return t('actions.attachments.slots', { count: error.available })
      case 'invalid': return t('actions.attachments.invalidFile', { name: error.name })
      case 'tooLarge': return t('actions.attachments.tooLarge', { name: error.name, size: byteSize(PDF_BYTES) })
      case 'interrupted': return t('actions.attachments.interrupted')
    }
  }
  return <section className="card" aria-labelledby="action-pdfs-heading"><h2 id="action-pdfs-heading">{t('actions.attachments.title')}</h2>
    <p className="muted">{t('actions.attachments.summary', { count: activeCount, max: formatNumber(PDF_COUNT), size: byteSize(PDF_BYTES) })}</p>
    <div className="file-picker">
      <input ref={fileInput} aria-label={t('actions.attachments.upload')} type="file" hidden multiple accept=".pdf,application/pdf" disabled={operation.busy || activeCount >= PDF_COUNT} onChange={event => {
        selectFiles(event.target.files); event.target.value = ''
      }} />
      <button type="button" className="secondary" disabled={operation.busy || activeCount >= PDF_COUNT} onClick={() => fileInput.current?.click()}><Icon name="upload" size={16} />{t('actions.attachments.upload')}</button>
      <span>{t('actions.attachments.multiple')}</span>
    </div>
    {selectionError && <Notice error>{selectionMessage(selectionError)}</Notice>}
    {operation.busy && uploadingName && <Notice>{t('actions.attachments.uploading', { name: uploadingName })}</Notice>}
    {failures.map(entry => <div key={entry.id} className="action-upload-error">
      <Notice error>{t('actions.attachments.failed', { name: entry.file.name, error: errorMessage(entry.cause) })}</Notice>
      {entry.retryable && <button type="button" className="secondary" disabled={operation.busy} aria-label={t('actions.attachments.retryLabel', { name: entry.file.name })}
        onClick={() => uploadFiles([entry])}>{t('actions.attachments.retry')}</button>}
    </div>)}
    {operation.notice}
    {query.isPending && <Notice>{t('actions.attachments.loading')}</Notice>}
    {query.error && <Notice error>{errorMessage(query.error)}</Notice>}
    {query.data && <>
      {query.data.items.length === 0 && <p className="muted">{t('actions.attachments.empty')}</p>}
      <ul className="action-attachment-list">{query.data.items.map(attachment => {
        const withdrawnAt = attachment.withdrawn_at
        return <li key={attachment.id}>
          <div className="action-file-info"><strong>{attachment.filename}</strong>
            <p className="muted">{byteSize(attachment.size)} · <Actor value={attachment.author} /></p>
            <small><ActionTime value={attachment.created_at} /></small>
            {withdrawnAt && <p className="muted">{rich('actions.attachments.withdrawnAt', { time: () => <ActionTime value={withdrawnAt} /> })}</p>}</div>
          <PDFControls itemId={item.id} id={attachment.id} filename={attachment.filename} purgedAt={attachment.purged_at}>
            {!withdrawnAt && canModerate(attachment.author, reader) && <>
              <button type="button" className="secondary icon-button" title={t('actions.attachments.rename')} aria-label={t('actions.attachments.renameLabel', { filename: attachment.filename })} onClick={() => setEditing(attachment)}><Icon name="edit" /></button>
              <button type="button" className="quiet icon-button" title={t('actions.attachments.withdraw')} aria-label={t('actions.attachments.withdrawLabel', { filename: attachment.filename })} onClick={() => setWithdrawing(attachment)}><Icon name="trash" /></button>
            </>}
          </PDFControls>
        </li>
      })}</ul>
      <ActionPagination page={page} pages={query.data.pages} change={setPage} busy={query.isFetching} label={t('actions.attachments.pagination')} />
    </>}
    {editing && <AttachmentNameEditor key={editing.id} itemId={item.id} value={editing} close={() => setEditing(null)} />}
    {withdrawing && <WithdrawDialog title={t('actions.attachments.withdraw')} description={withdrawing.filename} kept={t('actions.attachments.withdrawKept')}
      endpoint={`/actions/items/${item.id}/attachments/${withdrawing.id}`} version={withdrawing.version} close={() => setWithdrawing(null)} />}
  </section>
}

function historicalLines(field: ActionChange['field'], value: ActionChange['before'], t: Translate): string[] {
  if (value === null || value === '') return []
  if (Array.isArray(value)) return value
  if (field === 'status' && isActionStatus(value)) return [t(`actions.status.${value}`)]
  if (field === 'size') return [byteSize(Number(value))]
  return value.split(/\r\n?|\n/)
}

function ActionHistoryDiff({ change }: { change: ActionChange }) {
  const { t } = useI18n()
  const before = historicalLines(change.field, change.before, t), after = historicalLines(change.field, change.after, t)
  if (!before.length && !after.length) return <p className="muted">{change.field === 'labels' ? t('actions.history.noLabels') : t('actions.history.noContent')}</p>
  // Bound alignment work for large edits without omitting either version.
  const diff = diffArrays(before, after, { maxEditLength: 1000 })
  const parts = diff ?? [
    { removed: true, added: false, value: before },
    { removed: false, added: true, value: after },
  ]
  return <>
    {!diff && <p className="muted">{t('actions.history.tooLarge')}</p>}
    <div className="action-diff" role="group" aria-label={t('actions.history.changesTo', { field: lowerCase(t(`actions.history.fields.${change.field}`)) })}>
      {parts.flatMap((part, partIndex) => part.value.map((line, lineIndex) => {
        const kind = part.added ? 'added' : part.removed ? 'removed' : 'context'
        const Content = part.added ? 'ins' : part.removed ? 'del' : 'span'
        return <div key={`${partIndex}-${lineIndex}`} className={`action-diff-line action-diff-${kind}`}>
          <span className="action-diff-sign" aria-hidden="true">{part.added ? '+' : part.removed ? '-' : ' '}</span>
          <span className="sr-only">{t(part.added ? 'actions.history.added' : part.removed ? 'actions.history.removed' : 'actions.history.unchanged')}{' '}</span>
          <Content className="action-diff-content">{line}</Content>
        </div>
      }))}
    </div>
  </>
}

function ActionHistoryChanges({ changes }: { changes: ActionChange[] }) {
  const { t } = useI18n()
  const [expanded, setExpanded] = useState(false)
  return <details onToggle={event => setExpanded(event.currentTarget.open)}>
    <summary>{t('actions.history.viewChanges')}</summary>
    {expanded && <dl className="action-changes">{changes.map(change => <div key={change.field}>
      <dt>{t(`actions.history.fields.${change.field}`)}</dt><dd><ActionHistoryDiff change={change} /></dd>
    </div>)}</dl>}
  </details>
}

// The current state of a PDF named by the history: a purged one has no file left to view or download.
function HistoryPDF({ itemId, id, filename, purgedAt }: { itemId: number; id: string; filename: string; purgedAt?: string }) {
  const query = useQuery({
    queryKey: ['actions', 'attachment', itemId, id],
    queryFn: () => api<ActionAttachmentOut>(`/actions/items/${itemId}/attachments/${id}`),
    enabled: !purgedAt,
  })
  if (!purgedAt && query.isPending) return null
  return <PDFControls itemId={itemId} id={id} filename={filename} purgedAt={purgedAt ?? query.data?.purged_at} />
}

function ActionHistory({ itemId, close }: { itemId: number; close: () => void }) {
  const { t } = useI18n()
  const [page, setPage] = useState(1)
  const query = useQuery({
    queryKey: ['actions', 'history', itemId, page],
    queryFn: () => api<ActionHistoryPage>(`/actions/items/${itemId}/history?page=${page}`),
  })
  // Purges listed on this page; the state of other PDFs is read from the attachment itself.
  const purged = new Map(query.data?.items.flatMap(event => event.kind === 'attachment_purged' && event.attachment_id
    ? [[event.attachment_id, event.created_at] as const] : []))
  return <Modal title={t('actions.history.title')} close={close} className="action-history-dialog">
    <p className="muted">{t('actions.history.intro')}</p>
    {query.isPending && <Notice>{t('actions.history.loading')}</Notice>}
    {query.error && <Notice error>{errorMessage(query.error)}</Notice>}
    {query.data && <>
      <ol className="action-history-list">{query.data.items.map(event => {
        const fileChange = event.changes.find(change => change.field === 'filename')
        const filename = fileChange?.after || fileChange?.before
        return <li key={event.id}>
          <div className="action-entry-meta"><strong>{t(`actions.history.events.${event.kind}`)}</strong><ActionTime value={event.created_at} /></div>
          <p><Actor value={event.author} /></p>
          <ActionHistoryChanges changes={event.changes} />
          {event.attachment_id && event.kind !== 'attachment_purged' && <HistoryPDF itemId={itemId} id={event.attachment_id} purgedAt={purged.get(event.attachment_id)}
            filename={typeof filename === 'string' ? filename : t('actions.history.fallbackFilename')} />}
        </li>
      })}</ol>
      <ActionPagination page={page} pages={query.data.pages} change={setPage} busy={query.isFetching} label={t('actions.history.pagination')} />
    </>}
  </Modal>
}

function ActionDetail({ item, reader, basePath, search }: { item: ActionOut; reader?: UserAuthOut; basePath: string; search: string }) {
  const { t, rich } = useI18n()
  const [editing, setEditing] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  return <>
    <Link className="action-back" to={`${basePath}${search}`}><Icon name="arrow-left" size={16} />{t('actions.detail.back')}</Link>
    <div className="page-heading action-heading"><div><p className="eyebrow">{t('actions.detail.eyebrow', { id: item.id })}</p><h1>{item.title}</h1>
      <div className="chips"><StatusBadge status={item.status} />{item.labels.map(label => <ActionLabelBadge key={label.id} label={label} />)}</div></div>
      <div className="action-heading-controls">
        <StatusControl item={item} />
        <div className="inline">
          <button type="button" className="secondary" onClick={() => setHistoryOpen(true)}>{t('actions.detail.history')}</button>
          <button onClick={() => setEditing(true)}>{t('actions.detail.edit')}</button>
        </div>
      </div></div>
    <section className="card action-details">
      <h2>{t('actions.detail.description')}</h2><p className="action-text">{item.description || t('actions.detail.noDescription')}</p>
      <p className="muted">{rich('actions.detail.created', {
        actor: () => <Actor value={item.author} />, time: () => <ActionTime value={item.created_at} />,
      })}</p>
      <p className="muted">{rich('actions.detail.lastActivity', { time: () => <ActionTime value={item.updated_at} /> })}</p>
    </section>
    <div className="action-detail-content">
      <ActionAttachments item={item} reader={reader} />
      <ActionComments itemId={item.id} reader={reader} onHistory={() => setHistoryOpen(true)} />
    </div>
    <ActionEvents action={{ id: item.id, title: item.title }} />
    {editing && <ActionEditor value={item} close={() => setEditing(false)} saved={() => setEditing(false)} />}
    {historyOpen && <ActionHistory itemId={item.id} close={() => setHistoryOpen(false)} />}
  </>
}

function ActionDetailLoader() {
  const { itemId = '' } = useParams(), location = useLocation(), reader = useReaderAuth()
  const { t } = useI18n()
  const valid = /^[1-9][0-9]{0,9}$/.test(itemId) && Number(itemId) <= 2147483647
  const id = Number(itemId)
  const query = useQuery({
    queryKey: ['actions', 'item', id], queryFn: () => api<ActionOut>(`/actions/items/${id}`), enabled: valid,
  })
  if (!valid) return <Notice error>{t('actions.detail.notFound')}</Notice>
  if (query.isPending) return <Notice>{t('actions.detail.loading')}</Notice>
  if (query.error) return <Notice error>{errorMessage(query.error)}</Notice>
  return <ActionDetail key={`${id}:${reader.data?.kind}:${reader.data?.user_id}`} item={query.data} reader={reader.data}
    basePath="/actions" search={location.search} />
}

export function ActionDetailPage() {
  return <ActionFeatureGate><ActionDetailLoader /></ActionFeatureGate>
}
