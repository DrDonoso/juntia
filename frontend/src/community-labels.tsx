import { useId, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ApiError, api, cache, errorMessage } from './api/client'
import type { ActionLabelOut, ActionLabelPage, ContactTagOut, ContactTagPage } from './api/schema.gen'
import { TagBadge, tagColor, tagNameError } from './contact-tags'
import { useI18n } from './i18n'
import { Icon } from './icons'
import { Modal, Notice, Pagination, RequiredMark, focusFormField, useAction } from './shared'

type Kind = 'actions' | 'contacts'
type Label = ActionLabelOut | ContactTagOut
const endpoints = { actions: '/admin/action-labels', contacts: '/admin/contact-tags' } as const

function LabelEditor({ kind, value, close, saved }: {
  kind: Kind; value: Label; close: () => void; saved: (value: Label) => void
}) {
  const { t } = useI18n()
  const [base, setBase] = useState(value)
  const [name, setName] = useState(value.name), [color, setColor] = useState(() => tagColor(value))
  const [nameError, setNameError] = useState<string>()
  const [current, setCurrent] = useState<Label | null>(null)
  const operation = useAction(false), refresh = useAction(false)
  const busy = operation.busy || refresh.busy
  const stale = operation.failure instanceof ApiError
    && ['action_label_stale', 'contact_stale'].includes(operation.failure.code)
  const invalidName = !!nameError || operation.failure instanceof ApiError && !!operation.failure.fields.name
  const id = useId(), endpoint = `${endpoints[kind]}/${base.id}`
  return <Modal title={t(`labels.catalogs.${kind}.editTitle`, { name: value.name })} close={close} disabled={busy}>
    <form noValidate onSubmit={event => {
      event.preventDefault()
      if (busy || stale) return
      const error = tagNameError(name)
      setNameError(error)
      if (error) { focusFormField(event.currentTarget, 'name'); return }
      void operation.run(async () => {
        const result = await api<Label>(endpoint, 'PATCH', { name, color, version: base.version })
        await Promise.all([
          cache.invalidateQueries({ queryKey: ['admin', 'community-labels', kind] }),
          cache.invalidateQueries({ queryKey: [kind] }),
        ])
        saved(result)
      })
    }}>
      <p className="muted">{t(`labels.catalogs.${kind}.scope`)}</p>
      <label><span>{t('labels.editor.name')} <RequiredMark /></span><input name="name" required maxLength={100} value={name} disabled={busy}
        aria-invalid={invalidName || undefined} aria-describedby={nameError ? `${id}-name-error` : undefined}
        onChange={event => { setName(event.target.value); setNameError(undefined) }} /></label>
      {nameError && <Notice id={`${id}-name-error`} error>{nameError}</Notice>}
      <div className="inline">
        <label>{t('labels.editor.color')}<input type="color" required value={color} disabled={busy} onChange={event => setColor(event.target.value)} /></label>
        <TagBadge preview previewLabel={t(`labels.catalogs.${kind}.preview`)} tag={{ name: name.trim() || t(`labels.catalogs.${kind}.previewName`), color }} />
      </div>
      {operation.notice}{refresh.notice}
      {stale && <section className="action-conflict">
        <p>{t(`labels.catalogs.${kind}.stale`)}</p>
        <button type="button" className="secondary" disabled={busy} onClick={() => void refresh.run(async () => {
          setCurrent(await api<Label>(endpoint))
        })}>{t('labels.editor.reloadCurrent')}</button>
      </section>}
      {current && <section className="action-conflict" aria-label={t(`labels.catalogs.${kind}.current`)}>
        <h3>{t('labels.editor.currentTitle')}</h3><TagBadge tag={{ ...current, color: tagColor(current) }} />
        <p>{t('labels.editor.currentHelp')}</p>
        <button type="button" className="secondary" disabled={busy} onClick={() => {
          if (name === base.name) setName(current.name)
          if (color === tagColor(base)) setColor(tagColor(current))
          setBase(current); setCurrent(null); operation.reset()
        }}>{t('labels.editor.rebase')}</button>
      </section>}
      <div className="inline">
        <button disabled={busy || stale}>{operation.busy ? t('common.saving') : t(`labels.catalogs.${kind}.save`)}</button>
        <button type="button" className="secondary" disabled={busy} onClick={close}>{t('common.cancel')}</button>
      </div>
    </form>
  </Modal>
}

function LabelCatalog({ kind }: { kind: Kind }) {
  const { t } = useI18n()
  const [search, setSearch] = useState(''), [page, setPage] = useState(1)
  const [editing, setEditing] = useState<Label | null>(null)
  // Keep the saved name, not the message, so the confirmation follows a language switch.
  const [saved, setSaved] = useState<string | null>(null)
  const endpoint = endpoints[kind], title = t(`labels.catalogs.${kind}.title`)
  const params = new URLSearchParams({ q: search, page: String(page) })
  const query = useQuery({
    queryKey: ['admin', 'community-labels', kind, params.toString()],
    queryFn: () => api<ActionLabelPage | ContactTagPage>(`${endpoint}?${params}`),
    staleTime: 0,
  })
  const heading = useId()
  return <section className="card" aria-labelledby={heading}>
    <h2 id={heading}>{title}</h2>
    <label>{t(`labels.catalogs.${kind}.search`)}
      <input type="search" maxLength={100} value={search} onChange={event => { setSearch(event.target.value); setPage(1) }} />
    </label>
    {saved !== null && <Notice>{t(`labels.catalogs.${kind}.saved`, { name: saved })}</Notice>}
    {query.isPending && <Notice>{t(`labels.catalogs.${kind}.loading`)}</Notice>}
    {query.error && <><Notice error>{errorMessage(query.error)}</Notice>
      <button type="button" className="secondary" disabled={query.isFetching} onClick={() => void query.refetch()}>{t('common.retryLoading')}</button></>}
    {query.data && <>
      <p className="muted">{t(`labels.catalogs.${kind}.count`, { count: query.data.total })}</p>
      <ul className="community-label-list" aria-label={title} aria-busy={query.isFetching}>
        {query.data.items.map(label => <li key={label.id}>
          <TagBadge tag={{ ...label, color: tagColor(label) }} />
          <button type="button" className="secondary icon-button" title={t('labels.edit', { name: label.name })} aria-label={t('labels.edit', { name: label.name })}
            onClick={() => { setEditing(label); setSaved(null) }}><Icon name="edit" /></button>
        </li>)}
      </ul>
      {query.data.items.length === 0 && <p className="empty">{search ? t(`labels.catalogs.${kind}.empty.search`) : page > 1 ? t(`labels.catalogs.${kind}.empty.page`) : t(`labels.catalogs.${kind}.empty.none`)}</p>}
      <Pagination page={page} pages={query.data.pages} change={setPage} busy={query.isFetching} label={title} />
    </>}
    {editing && <LabelEditor key={editing.id} kind={kind} value={editing} close={() => setEditing(null)} saved={label => {
      setEditing(null); setSaved(label.name)
    }} />}
  </section>
}

export function CommunityLabelsPage() {
  const { t } = useI18n()
  return <>
    <div className="page-heading"><div><p className="eyebrow">{t('labels.eyebrow')}</p><h1>{t('labels.title')}</h1>
      <p className="muted">{t('labels.description')}</p>
      <p className="muted">{t('labels.creation')}</p>
    </div></div>
    <div className="dashboard-grid"><LabelCatalog kind="actions" /><LabelCatalog kind="contacts" /></div>
  </>
}
