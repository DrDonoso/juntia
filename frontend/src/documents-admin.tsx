import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { Link, useLocation } from 'react-router'
import { api, cache, errorMessage } from './api/client'
import type {
  DocumentDeletionOut, DocumentDeletionPage, DocumentInfoOut, DocumentSettings, DocumentStorageOut,
  StoredDocumentVersionOut, StoredDocumentVersionPage,
} from './api/schema.gen'
import { ActionTime, byteSize } from './community-action-shared'
import { DocumentHistory, DocumentInfoDialog, FileDetails, VersionList, kindIcon, locationText } from './documents'
import { formatNumber, useI18n, type Translate } from './i18n'
import { Icon } from './icons'
import { Modal, Notice, Pagination, authorName, useAction } from './shared'
import { SizeField, parseSize } from './size-field'
import { TextPreview, isTextFile, plainClick } from './text-preview'

const MIB = 1024 * 1024
const POLICIES: readonly DocumentSettings['manage_policy'][] = ['creator', 'administrator', 'everyone']
const SETTINGS_KEY = ['admin', 'documents', 'settings'] as const
type LimitKey = 'max_file_mb' | 'max_video_mb' | 'user_quota_mb' | 'community_quota_mb'
// What the server accepts (DocumentSettingsEdit), in whole MiB: a file or a video up to the 10 GiB of
// a ZIP download, quotas up to 10 TiB.
export const DOCUMENT_LIMITS: readonly { key: LimitKey; min: number; max: number }[] = [
  { key: 'max_file_mb', min: 1, max: 10 * 1024 },
  { key: 'max_video_mb', min: 1, max: 10 * 1024 },
  { key: 'user_quota_mb', min: 1, max: 10 * 1024 * 1024 },
  { key: 'community_quota_mb', min: 1, max: 10 * 1024 * 1024 },
]

function useDocumentSettings() {
  return useQuery({ queryKey: SETTINGS_KEY, queryFn: () => api<DocumentSettings>('/admin/settings/documents') })
}

export function DocumentPolicyCard() {
  const { t, rich } = useI18n()
  const query = useDocumentSettings()
  const action = useAction(false), heading = useId()
  return <section className="card document-policy" aria-labelledby={heading}>
    <h2 id={heading}>{t('documents.admin.policy.title')}</h2>
    <p className="muted">{t('documents.admin.policy.description')}</p>
    <p className="muted">{rich('documents.admin.policy.limits', {
      link: chunks => <Link to="/admin/storage#document-limits">{chunks}</Link>,
    })}</p>
    {query.isPending && <Notice>{t('documents.admin.policy.loading')}</Notice>}
    {query.error && <Notice error>{errorMessage(query.error)}</Notice>}
    {query.data && <fieldset disabled={action.busy}>
      <legend>{t('documents.admin.policy.legend')}</legend>
      {POLICIES.map(policy => <label key={policy} className="check document-policy-option">
        <input type="radio" name="document-policy" value={policy} checked={query.data.manage_policy === policy}
          onChange={() => void action.run(async () => {
            const saved = await api<DocumentSettings>('/admin/settings/documents', 'PATCH', { manage_policy: policy })
            cache.setQueryData(SETTINGS_KEY, saved)
            void cache.invalidateQueries({ queryKey: ['documents'] })
          }, t('documents.admin.policy.saved', { policy: t(`documents.admin.policy.options.${policy}.label`) }))} />
        <span><strong>{t(`documents.admin.policy.options.${policy}.label`)}</strong>
          <small className="muted">{t(`documents.admin.policy.options.${policy}.description`)}</small></span>
      </label>)}
    </fieldset>}
    {action.notice}
  </section>
}

/**
 * The limits of shared documents, on the Storage page: each with a slider and a box for an exact
 * size, saved together. `storage` warns about quotas below what is already stored.
 */
export function DocumentLimitsCard({ storage }: { storage?: DocumentStorageOut }) {
  const { t } = useI18n()
  const query = useDocumentSettings()
  const [draft, setDraft] = useState<Partial<Record<LimitKey, string>>>({})
  const action = useAction(false), heading = useId()
  const section = useRef<HTMLElement>(null)
  const { hash } = useLocation()
  const saved = query.data
  const ready = Boolean(saved && storage)
  // Links from Features land here once the page above has its final height.
  useEffect(() => { if (ready && hash === '#document-limits') section.current?.scrollIntoView() }, [ready, hash])
  const text = (key: LimitKey) => draft[key] ?? (saved ? String(saved[key]) : '')
  const values = DOCUMENT_LIMITS.map(limit => ({ ...limit, value: parseSize(text(limit.key), limit.min, limit.max) }))
  const changes = Object.fromEntries(values.flatMap(limit =>
    saved && limit.value !== null && limit.value !== saved[limit.key] ? [[limit.key, limit.value]] : []))
  const invalid = values.some(limit => limit.value === null)
  const edited = saved !== undefined && DOCUMENT_LIMITS.some(limit => text(limit.key) !== String(saved[limit.key]))
  function warning(key: LimitKey, value: number | null): string | undefined {
    if (!storage || value === null) return undefined
    if (key === 'community_quota_mb' && storage.stored_bytes > value * MIB) {
      return t('documents.admin.limits.belowCommunity', { size: byteSize(storage.stored_bytes) })
    }
    const over = key === 'user_quota_mb' ? storage.residents.filter(row => row.stored_bytes > value * MIB).length : 0
    return over ? t('documents.admin.limits.belowNeighbors', { count: over }) : undefined
  }
  function submit(event: FormEvent) {
    event.preventDefault()
    if (invalid || !Object.keys(changes).length) return
    void action.run(async () => {
      cache.setQueryData(SETTINGS_KEY, await api<DocumentSettings>('/admin/settings/documents', 'PATCH', changes))
      setDraft({})
      void cache.invalidateQueries({ queryKey: ['admin', 'storage'] })
      void cache.invalidateQueries({ queryKey: ['documents'] })
    }, t('documents.admin.limits.saved'))
  }
  return <section ref={section} id="document-limits" className="card document-limits" aria-labelledby={heading}>
    <h2 id={heading}>{t('documents.admin.limits.title')}</h2>
    <p className="muted">{t('documents.admin.limits.description')}</p>
    {query.isPending && <Notice>{t('documents.admin.limits.loading')}</Notice>}
    {query.error && <Notice error>{errorMessage(query.error)}</Notice>}
    {saved && <form onSubmit={submit} noValidate>
      <div className="document-limits-grid">{values.map(limit => <SizeField key={limit.key}
        label={t(`documents.admin.limits.fields.${limit.key}.label`)} help={t(`documents.admin.limits.fields.${limit.key}.help`)}
        min={limit.min} max={limit.max} value={text(limit.key)} fallback={saved[limit.key]} disabled={action.busy}
        warning={warning(limit.key, limit.value)}
        change={value => { action.reset(); setDraft(previous => ({ ...previous, [limit.key]: value })) }} />)}</div>
      {action.notice}
      <div className="inline">
        <button disabled={action.busy || invalid || !Object.keys(changes).length}>
          {action.busy ? t('common.saving') : t('documents.admin.limits.save')}</button>
        <button type="button" className="secondary" disabled={action.busy || !edited}
          onClick={() => { setDraft({}); action.reset() }}>{t('documents.admin.limits.discard')}</button>
      </div>
    </form>}
  </section>
}

function contents(item: DocumentDeletionOut, translate: Translate): string {
  return item.folder_id !== null
    ? translate('documents.admin.deleted.folderContents', { count: item.file_count, folders: item.folder_count, size: byteSize(item.stored_bytes) })
    : byteSize(item.stored_bytes)
}

function DeletedInfo({ item, close }: { item: DocumentDeletionOut; close: () => void }) {
  const { t } = useI18n()
  const file = useQuery({
    queryKey: ['admin', 'documents', 'file', item.document_id],
    queryFn: () => api<DocumentInfoOut>(`/admin/documents/files/${item.document_id}`),
    enabled: item.document_id !== null,
  })
  const path = item.document_id !== null ? `/admin/documents/files/${item.document_id}` : `/admin/documents/folders/${item.folder_id}`
  return <DocumentInfoDialog title={t('documents.info.title', { name: item.name })} close={close}
    history={<DocumentHistory path={path} queryKey={['admin', 'documents', item.folder_id !== null ? 'folder' : 'file', item.folder_id ?? item.document_id]}
      folder={item.folder_id !== null} />}>
    {item.folder_id !== null && <dl className="document-details">
      <div><dt>{t('documents.info.contents')}</dt><dd>{contents(item, t)}</dd></div>
      <div><dt>{t('documents.info.location')}</dt><dd>{locationText(item.location, t)}</dd></div>
      <div><dt>{t('documents.admin.deleted.deletedBy')}</dt><dd>{authorName(item.author, t)} · <ActionTime value={item.created_at} /></dd></div>
    </dl>}
    {file.isPending && item.document_id !== null && <Notice>{t('documents.info.loading')}</Notice>}
    {file.error && <Notice error>{errorMessage(file.error)}</Notice>}
    {file.data && <>
      <FileDetails value={file.data} />
      <h3>{t('documents.info.versions')}</h3>
      <VersionList versions={file.data.versions} current={file.data.current.number}
        download={version => `/api/admin/documents/versions/${version.id}/download`} />
    </>}
  </DocumentInfoDialog>
}

function DeletionDialog({ item, kind, close, done }: {
  item: DocumentDeletionOut; kind: 'restore' | 'purge'; close: () => void; done: (message: string) => void
}) {
  const { t } = useI18n()
  const operation = useAction(false)
  const purge = kind === 'purge'
  return <Modal title={purge ? t('documents.admin.purge.title', { name: item.name }) : t('documents.admin.restore.title', { name: item.name })}
    close={close} disabled={operation.busy}>
    <p><strong>{item.name}</strong> · {contents(item, t)}</p>
    <p className="muted">{t('documents.admin.deleted.location', { location: locationText(item.location, t) })}</p>
    {purge ? <ul className="storage-purge-facts">
      <li>{t('documents.admin.purge.forever')}</li>
      <li>{t('documents.admin.purge.history')}</li>
      <li>{t('documents.admin.purge.frees', { size: byteSize(item.stored_bytes) })}</li>
    </ul> : <p>{t('documents.admin.restore.description')}</p>}
    {operation.notice}
    <div className="inline">
      <button type="button" className={purge ? 'secondary danger' : ''} disabled={operation.busy} onClick={() => void operation.run(async () => {
        await api(`/admin/documents/deletions/${item.id}/${kind}`, 'POST')
        done(purge ? t('documents.admin.purge.done', { name: item.name, size: byteSize(item.stored_bytes) })
          : t('documents.admin.restore.done', { name: item.name }))
      })}><Icon name={operation.busy ? 'spinner' : purge ? 'trash' : 'refresh'} size={16} className={operation.busy ? 'icon-spin' : undefined} />
        {purge ? t('documents.admin.purge.confirm') : t('documents.admin.restore.confirm')}</button>
      <button type="button" className="secondary" disabled={operation.busy} onClick={close}>{t('common.cancel')}</button>
    </div>
  </Modal>
}

export function DeletedDocumentsPage() {
  const { t } = useI18n()
  const [page, setPage] = useState(1)
  const [dialog, setDialog] = useState<{ kind: 'info' | 'restore' | 'purge'; item: DocumentDeletionOut } | null>(null)
  const [outcome, setOutcome] = useState('')
  const heading = useRef<HTMLHeadingElement>(null), headingId = useId()
  const query = useQuery({
    queryKey: ['admin', 'documents', 'deleted', page],
    queryFn: () => api<DocumentDeletionPage>(`/admin/documents/deleted?page=${page}`),
    placeholderData: keepPreviousData, staleTime: 0,
  })
  useEffect(() => { if (outcome) heading.current?.focus() }, [outcome])
  const title = t('documents.admin.deleted.title')
  return <>
    <div className="page-heading"><div><p className="eyebrow">{t('admin.eyebrow')}</p><h1>{title}</h1>
      <p className="muted">{t('documents.admin.deleted.description')}</p></div></div>
    <section className="card" aria-labelledby={headingId}>
      <h2 id={headingId} ref={heading} tabIndex={-1}>{title}</h2>
      {outcome && <Notice>{outcome}</Notice>}
      {query.isPending && <Notice>{t('documents.admin.deleted.loading')}</Notice>}
      {query.error && <><Notice error>{errorMessage(query.error)}</Notice>
        <button type="button" className="secondary" disabled={query.isFetching} onClick={() => void query.refetch()}>{t('common.retryLoading')}</button></>}
      {query.data && <>
        {query.data.items.length === 0 ? <p className="empty">{page > 1 ? t('documents.admin.deleted.emptyPage') : t('documents.admin.deleted.empty')}</p>
          : <ul className="action-attachment-list document-deleted-list" aria-label={title} aria-busy={query.isFetching}>
            {query.data.items.map(item => <li key={item.id}>
              <Icon name={item.file_kind ? kindIcon(item.file_kind) : 'folder'} size={28} className="document-icon" />
              <div className="action-file-info"><strong>{item.name}</strong>
                <p className="muted">{contents(item, t)}</p>
                <p className="muted">{t('documents.admin.deleted.location', { location: locationText(item.location, t) })}</p>
                <p className="muted">{t('documents.admin.deleted.deletedByName', { name: authorName(item.author, t) })} · <ActionTime value={item.created_at} /></p>
              </div>
              <div className="inline">
                <button type="button" className="secondary" aria-label={t('documents.admin.deleted.infoLabel', { name: item.name })}
                  onClick={() => { setOutcome(''); setDialog({ kind: 'info', item }) }}><Icon name="info" size={16} />{t('documents.menu.info')}</button>
                <button type="button" className="secondary" aria-label={t('documents.admin.deleted.restoreLabel', { name: item.name })}
                  onClick={() => { setOutcome(''); setDialog({ kind: 'restore', item }) }}><Icon name="refresh" size={16} />{t('documents.admin.restore.confirm')}</button>
                <button type="button" className="secondary danger" aria-label={t('documents.admin.deleted.purgeLabel', { name: item.name })}
                  onClick={() => { setOutcome(''); setDialog({ kind: 'purge', item }) }}><Icon name="trash" size={16} />{t('documents.admin.purge.confirm')}</button>
              </div>
            </li>)}
          </ul>}
        <Pagination page={page} pages={query.data.pages} change={setPage} busy={query.isFetching} label={t('documents.admin.deleted.pagination')} />
      </>}
    </section>
    {dialog?.kind === 'info' && <DeletedInfo item={dialog.item} close={() => setDialog(null)} />}
    {(dialog?.kind === 'restore' || dialog?.kind === 'purge') && <DeletionDialog key={dialog.item.id} item={dialog.item} kind={dialog.kind}
      close={() => setDialog(null)} done={message => {
        setDialog(null); setOutcome(message)
        void cache.invalidateQueries({ queryKey: ['admin'] })
        void cache.invalidateQueries({ queryKey: ['documents'] })
      }} />}
  </>
}

type Level = 'normal' | 'warning' | 'full'

function level(used: number, limit: number): Level {
  return used >= limit ? 'full' : used >= limit * 0.9 ? 'warning' : 'normal'
}

function Meter({ label, used, limit }: { label: string; used: number; limit: number }) {
  const { t } = useI18n()
  const value = Math.min(Math.max(used, 0), limit)
  const ratio = limit > 0 ? Math.floor(used / limit * 1000) / 1000 : 1
  return <div className="storage-meter" data-level={level(used, limit)} role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={limit}
    aria-valuenow={value} aria-valuetext={t('storage.meterText', {
      used: byteSize(used), limit: byteSize(limit), percent: formatNumber(ratio, { style: 'percent', maximumFractionDigits: 1 }),
    })}>
    <span className="storage-meter-fill" style={{ width: `${limit > 0 ? value / limit * 100 : 100}%` }} />
  </div>
}

export function DocumentStorageCard({ storage }: { storage: DocumentStorageOut }) {
  const { t } = useI18n()
  const heading = useId()
  const state = level(storage.stored_bytes, storage.quota_bytes)
  return <section className="card storage-card" aria-labelledby={heading}>
    <h2 id={heading}>{t('storage.documents.title')}</h2>
    <p className="storage-figure">{t('storage.usage', { used: byteSize(storage.stored_bytes), limit: byteSize(storage.quota_bytes) })}</p>
    <Meter label={t('storage.documents.meter')} used={storage.stored_bytes} limit={storage.quota_bytes} />
    <dl className="storage-breakdown">
      <div><dt>{t('storage.documents.current')}</dt><dd>{byteSize(storage.current_bytes)} · {t('storage.documents.files', { count: storage.files })}</dd></div>
      <div><dt>{t('storage.documents.previous')}</dt><dd>{byteSize(storage.previous_bytes)} · {t('storage.documents.versions', { count: storage.previous_versions })}</dd></div>
      <div><dt>{t('storage.documents.deleted')}</dt><dd>{byteSize(storage.deleted_bytes)} · {t('storage.documents.files', { count: storage.deleted_files })}</dd></div>
      <div><dt>{t('storage.documents.administrator')}</dt><dd>{byteSize(storage.administrator_bytes)}</dd></div>
      <div><dt>{t('storage.documents.uploads')}</dt><dd>{byteSize(storage.upload_bytes)} · {t('storage.documents.uploadCount', { count: storage.uploads })}</dd></div>
    </dl>
    <p className="storage-hint"><a href="#document-limits">{t('storage.documents.change')}</a></p>
    {state === 'full' && <Notice error>{t('storage.documents.full')}</Notice>}
    {state === 'warning' && <p className="notice warning" role="status">{t('storage.documents.near')}</p>}
  </section>
}

function VersionPurgeDialog({ item, close, done }: { item: StoredDocumentVersionOut; close: () => void; done: () => void }) {
  const { t } = useI18n()
  const operation = useAction(false)
  const author = authorName(item.author, t), size = byteSize(item.size)
  return <Modal title={t('storage.documents.previousVersions.purgeTitle')} close={close} disabled={operation.busy}>
    <p><strong className="storage-filename">{item.document_name}</strong> · {t('documents.info.versionNumber', { number: item.number })} · {size}</p>
    <p className="muted">{t('storage.withdrawnPDFs.uploadedBy', { name: author })}<br />{locationText(item.location, t)}</p>
    <ul className="storage-purge-facts">
      <li>{t('storage.purge.forever')}</li>
      <li>{t('storage.documents.previousVersions.keeps')}</li>
      <li>{item.author.kind === 'resident' ? t('storage.documents.previousVersions.freesNeighbor', { size, name: author })
        : t('storage.documents.previousVersions.freesCommunity', { size })}</li>
    </ul>
    {operation.notice}
    <div className="inline">
      <button type="button" className="secondary danger" disabled={operation.busy} onClick={() => void operation.run(async () => {
        await api<StoredDocumentVersionOut>(`/admin/storage/document-versions/${item.id}/purge`, 'POST')
        done()
      })}><Icon name={operation.busy ? 'spinner' : 'trash'} size={16} className={operation.busy ? 'icon-spin' : undefined} />
        {operation.busy ? t('storage.purge.deleting') : t('storage.purge.confirm')}</button>
      <button type="button" className="secondary" disabled={operation.busy} onClick={close}>{t('common.cancel')}</button>
    </div>
  </Modal>
}

// The administrator's own copies, also while Documents is turned off.
const versionUrl = (item: StoredDocumentVersionOut, action: 'preview' | 'download') => `/api/admin/documents/versions/${item.id}/${action}`

// The latest uploaded first, 5 per page.
export function PreviousDocumentVersions() {
  const { t, rich } = useI18n()
  const [page, setPage] = useState(1), [search, setSearch] = useState('')
  const [purging, setPurging] = useState<StoredDocumentVersionOut | null>(null)
  const [viewing, setViewing] = useState<StoredDocumentVersionOut | null>(null)
  const [outcome, setOutcome] = useState<{ name: string; number: number; size: number } | null>(null)
  const heading = useRef<HTMLHeadingElement>(null), headingId = useId()
  const q = search.trim()
  const params = new URLSearchParams({ page: String(page) })
  if (q) params.set('q', q)
  const query = useQuery({
    queryKey: ['admin', 'storage', 'document-versions', page, q],
    queryFn: () => api<StoredDocumentVersionPage>(`/admin/storage/document-versions?${params}`),
    placeholderData: keepPreviousData, staleTime: 0,
  })
  useEffect(() => { if (outcome) heading.current?.focus() }, [outcome])
  const title = t('storage.documents.previousVersions.title')
  return <section className="card" aria-labelledby={headingId}>
    <h2 id={headingId} ref={heading} tabIndex={-1}>{title}</h2>
    <label className="storage-search">{t('storage.documents.previousVersions.search')}<input type="search" maxLength={200} value={search}
      onChange={event => { setSearch(event.target.value); setPage(1) }} /></label>
    {outcome && <Notice>{t('storage.documents.previousVersions.purged', {
      name: outcome.name, number: outcome.number, size: byteSize(outcome.size),
    })}</Notice>}
    {query.isPending && <Notice>{t('storage.documents.previousVersions.loading')}</Notice>}
    {query.error && <><Notice error>{errorMessage(query.error)}</Notice>
      <button type="button" className="secondary" disabled={query.isFetching} onClick={() => void query.refetch()}>{t('common.retryLoading')}</button></>}
    {query.data && <>
      {query.data.total > 0 && <p className="muted">{q ? t('storage.search.results', { count: query.data.total })
        : t('storage.documents.previousVersions.total', { count: query.data.total })}</p>}
      {query.data.items.length === 0 ? <p className="empty">{page > 1 ? t('storage.documents.previousVersions.emptyPage')
        : q ? t('storage.search.empty', { query: q }) : t('storage.documents.previousVersions.empty')}</p>
        : <ul className="action-attachment-list storage-withdrawn-list" aria-label={title} aria-busy={query.isFetching}>
          {query.data.items.map(item => {
            const labels = { name: item.document_name, number: item.number }
            return <li key={item.id}>
              <div className="action-file-info"><strong>{item.document_name}</strong>
                <p className="muted">{t('documents.info.versionNumber', { number: item.number })} · {byteSize(item.size)} · {t('storage.withdrawnPDFs.uploadedBy', { name: authorName(item.author, t) })} · {rich('storage.documents.previousVersions.uploadedAt', {
                  time: () => <ActionTime value={item.created_at} />,
                })}</p>
                <p className="muted">{locationText(item.location, t)}</p>
              </div>
              <div className="storage-file-actions">
                {item.previewable && <a className="button secondary icon-button" href={versionUrl(item, 'preview')} target="_blank" rel="noopener noreferrer"
                  aria-label={t('storage.documents.previousVersions.preview', labels)}
                  title={isTextFile(item.extension) ? t('documents.card.viewTitle') : t('documents.card.previewTitle')} onClick={event => {
                    if (!isTextFile(item.extension) || !plainClick(event)) return
                    event.preventDefault()
                    setViewing(item)
                  }}><Icon name="eye" /></a>}
                <a className="button secondary icon-button" href={versionUrl(item, 'download')} download=""
                  aria-label={t('storage.documents.previousVersions.download', labels)} title={t('documents.menu.download')}><Icon name="download" /></a>
                <button type="button" className="secondary danger" aria-label={t('storage.documents.previousVersions.deleteLabel', labels)}
                  onClick={() => { setOutcome(null); setPurging(item) }}><Icon name="trash" size={16} />{t('storage.withdrawnPDFs.delete')}</button>
              </div>
            </li>
          })}
        </ul>}
      <Pagination page={page} pages={query.data.pages} change={setPage} busy={query.isFetching} label={t('storage.documents.previousVersions.pagination')} />
    </>}
    {viewing && <TextPreview name={`${viewing.document_name} · ${t('documents.info.versionNumber', { number: viewing.number })}`}
      extension={viewing.extension} size={viewing.size} path={`/admin/documents/versions/${viewing.id}/preview`}
      download={versionUrl(viewing, 'download')} close={() => setViewing(null)} />}
    {purging && <VersionPurgeDialog key={purging.id} item={purging} close={() => setPurging(null)} done={() => {
      setOutcome({ name: purging.document_name, number: purging.number, size: purging.size })
      setPurging(null)
      void cache.invalidateQueries({ queryKey: ['admin', 'storage'] })
      void cache.invalidateQueries({ queryKey: ['documents'] })
    }} />}
  </section>
}
