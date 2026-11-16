import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { keepPreviousData, useIsFetching, useQuery } from '@tanstack/react-query'
import { Link } from 'react-router'
import { ApiError, api, cache, errorMessage } from './api/client'
import type {
  ActionAttachmentOut, CommunityStorageOut, DiskSpaceOut, ResidentStorageOut, StorageOut, StorageUsageOut, StoredAttachmentOut,
  StoredAttachmentPage, StoredImageOut, StoredImagePage,
} from './api/schema.gen'
import { byteSize } from './community-action-shared'
import { DocumentLimitsCard, DocumentStorageCard, PreviousDocumentVersions } from './documents-admin'
import { PreviewLink } from './file-preview'
import { compareText, dateTimeFormat, formatNumber, useI18n } from './i18n'
import { Icon } from './icons'
import { Modal, Notice, Pagination, SortableHeader, authorName, connectionTime, useAction, useTableSort } from './shared'

type Level = 'normal' | 'warning' | 'full'
type NeighborColumn = 'neighbor' | 'active' | 'withdrawn' | 'images' | 'quota' | 'documents'
// A neighbor's PDFs and images, plus the shared documents they uploaded, which have a quota of their own.
type NeighborRow = ResidentStorageOut & { document_bytes: number; document_versions: number }
const NEIGHBOR_SIZES: Record<Exclude<NeighborColumn, 'neighbor'>, (value: NeighborRow) => number> = {
  active: value => value.active_bytes, withdrawn: value => value.withdrawn_bytes, images: value => value.image_bytes,
  quota: value => value.stored_bytes, documents: value => value.document_bytes,
}
// Kept as data, not text, so the notice follows a language switch.
type Outcome = { kind: 'purged'; filename: string; size: number } | { kind: 'stale' }

function quotaLevel(used: number, limit: number): Level {
  return used >= limit ? 'full' : used >= limit * 0.9 ? 'warning' : 'normal'
}

// Rounded down, so a quota never reads 100% before it is full.
function share(used: number, limit: number): string {
  const ratio = limit > 0 ? Math.floor(used / limit * 1000) / 1000 : 1
  return formatNumber(ratio, { style: 'percent', maximumFractionDigits: 1 })
}

function UsageMeter({ label, used, limit, level }: { label: string; used: number; limit: number; level: Level }) {
  const { t } = useI18n()
  const value = Math.min(Math.max(used, 0), limit)
  return <div className="storage-meter" data-level={level} role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={limit}
    aria-valuenow={value} aria-valuetext={t('storage.meterText', { used: byteSize(used), limit: byteSize(limit), percent: share(used, limit) })}>
    <span className="storage-meter-fill" style={{ width: `${limit > 0 ? value / limit * 100 : 100}%` }} />
  </div>
}

function Warning({ children }: { children: ReactNode }) {
  return <p className="notice warning" role="status">{children}</p>
}

function Breakdown({ usage }: { usage: StorageUsageOut }) {
  const { t } = useI18n()
  return <dl className="storage-breakdown">
    <div><dt>{t('storage.active')}</dt><dd>{byteSize(usage.active_bytes)} · {t('storage.files', { count: usage.active_files })}</dd></div>
    <div><dt>{t('storage.withdrawn')}</dt><dd>{byteSize(usage.withdrawn_bytes)} · {t('storage.files', { count: usage.withdrawn_files })}</dd></div>
    <div><dt>{t('storage.images')}</dt><dd>{byteSize(usage.image_bytes)} · {t('storage.imageFiles', { count: usage.image_files })}</dd></div>
  </dl>
}

function CommunityCard({ usage }: { usage: CommunityStorageOut }) {
  const { t } = useI18n()
  const heading = useId()
  const level = quotaLevel(usage.stored_bytes, usage.quota_bytes)
  return <section className="card storage-card" aria-labelledby={heading}>
    <h2 id={heading}>{t('storage.community.title')}</h2>
    <p className="storage-figure">{t('storage.usage', { used: byteSize(usage.stored_bytes), limit: byteSize(usage.quota_bytes) })}</p>
    <UsageMeter label={t('storage.community.meter')} used={usage.stored_bytes} limit={usage.quota_bytes} level={level} />
    <p className="muted">{t('storage.community.available', { size: byteSize(Math.max(usage.quota_bytes - usage.stored_bytes, 0)) })}</p>
    <Breakdown usage={usage} />
    {level === 'full' && <Notice error>{t('storage.community.full')}</Notice>}
    {level === 'warning' && <Warning>{t('storage.community.near')}</Warning>}
  </section>
}

function AdministratorCard({ usage }: { usage: StorageUsageOut }) {
  const { t } = useI18n()
  const heading = useId()
  return <section className="card storage-card" aria-labelledby={heading}>
    <h2 id={heading}>{t('storage.administrator.title')}</h2>
    <p className="storage-figure">{t('storage.administrator.stored', { size: byteSize(usage.stored_bytes) })}</p>
    <Breakdown usage={usage} />
  </section>
}

function DiskCard({ disk }: { disk: DiskSpaceOut }) {
  const { t } = useI18n()
  const heading = useId()
  const { total_bytes: total, free_bytes: free, reserve_bytes: reserve } = disk
  // "Close to the reserve" leaves less than another reserve of headroom.
  const level: Level | null = total === null || free === null ? null : free < reserve ? 'full' : free < reserve * 2 ? 'warning' : 'normal'
  return <section className="card storage-card" aria-labelledby={heading}>
    <h2 id={heading}>{t('storage.disk.title')}</h2>
    {total === null || free === null ? <Notice>{t('storage.disk.unknown')}</Notice> : <>
      <p className="storage-figure">{t('storage.disk.free', { free: byteSize(free), total: byteSize(total) })}</p>
      <UsageMeter label={t('storage.disk.meter')} used={total - free} limit={total} level={level ?? 'normal'} />
    </>}
    <dl className="storage-breakdown">
      <div><dt>{t('storage.disk.reserve')}</dt><dd>{byteSize(reserve)}</dd></div>
    </dl>
    {level === 'full' && <Notice error>{t('storage.disk.below')}</Notice>}
    {level === 'warning' && <Warning>{t('storage.disk.near')}</Warning>}
  </section>
}

function useNeighborName() {
  const { t } = useI18n()
  return (value: ResidentStorageOut) => value.name || t('storage.neighbors.unnamed', { id: value.user_id })
}

/** Everyone who stores PDFs, images or documents, with both: residents with documents only store no PDFs. */
function neighborRows(storage: StorageOut): NeighborRow[] {
  const rows = new Map<number, NeighborRow>(storage.residents.map(resident => [
    resident.user_id, { ...resident, document_bytes: 0, document_versions: 0 },
  ]))
  for (const resident of storage.documents.residents) {
    const row = rows.get(resident.user_id) ?? {
      user_id: resident.user_id, name: resident.name, account_deleted: resident.account_deleted, quota_bytes: storage.resident_quota_bytes,
      stored_bytes: 0, active_bytes: 0, withdrawn_bytes: 0, active_files: 0, withdrawn_files: 0, image_bytes: 0, image_files: 0,
      document_bytes: 0, document_versions: 0,
    }
    rows.set(resident.user_id, { ...row, document_bytes: resident.stored_bytes, document_versions: resident.versions })
  }
  return [...rows.values()]
}

function NeighborsCard({ storage }: { storage: StorageOut }) {
  const { t } = useI18n()
  const heading = useId(), neighborName = useNeighborName()
  const sort = useTableSort<NeighborColumn>('quota', column => column === 'neighbor' ? 'asc' : 'desc')
  const title = t('storage.neighbors.title'), documentQuota = storage.documents.resident_quota_bytes
  const rows = neighborRows(storage).sort((left, right) => {
    const names = compareText(neighborName(left), neighborName(right))
    const order = sort.key === 'neighbor' ? names : NEIGHBOR_SIZES[sort.key](left) - NEIGHBOR_SIZES[sort.key](right)
    return (sort.direction === 'asc' ? order : -order) || names || left.user_id - right.user_id
  })
  const header = (column: NeighborColumn, numeric = false) => {
    const label = t(`storage.neighbors.columns.${column}`)
    return <SortableHeader label={label} sortLabel={t('storage.sortBy', { column: label })} numeric={numeric}
      active={sort.key === column} direction={sort.direction} change={() => sort.change(column)} />
  }
  return <section className="card" aria-labelledby={heading}>
    <h2 id={heading}>{title}</h2>
    {rows.length === 0 ? <p className="empty">{t('storage.neighbors.empty')}</p>
      : <div className="table-scroll"><table className="storage-table" aria-label={title}>
        <thead><tr>
          {header('neighbor')}{header('active', true)}{header('withdrawn', true)}{header('images', true)}{header('quota')}{header('documents')}
        </tr></thead>
        <tbody>{rows.map(resident => {
          const name = neighborName(resident)
          return <tr key={resident.user_id}>
            <th scope="row"><span className="storage-neighbor">{name}</span>
              {resident.account_deleted && <span className="tag">{t('storage.neighbors.deleted')}</span>}</th>
            <td className="numeric">{byteSize(resident.active_bytes)}<small>{t('storage.files', { count: resident.active_files })}</small></td>
            <td className="numeric">{byteSize(resident.withdrawn_bytes)}<small>{t('storage.files', { count: resident.withdrawn_files })}</small></td>
            <td className="numeric">{byteSize(resident.image_bytes)}<small>{t('storage.imageFiles', { count: resident.image_files })}</small></td>
            <td className="storage-quota">{t('storage.usage', { used: byteSize(resident.stored_bytes), limit: byteSize(resident.quota_bytes) })}
              <UsageMeter label={t('storage.neighbors.meter', { name })} used={resident.stored_bytes} limit={resident.quota_bytes}
                level={quotaLevel(resident.stored_bytes, resident.quota_bytes)} /></td>
            <td className="storage-quota">{t('storage.usage', { used: byteSize(resident.document_bytes), limit: byteSize(documentQuota) })}
              <UsageMeter label={t('storage.neighbors.documentsMeter', { name })} used={resident.document_bytes} limit={documentQuota}
                level={quotaLevel(resident.document_bytes, documentQuota)} />
              <small>{t('storage.documents.versions', { count: resident.document_versions })}</small></td>
          </tr>
        })}</tbody>
      </table></div>}
  </section>
}

function PurgeDialog({ item, close, done }: { item: StoredAttachmentOut; close: () => void; done: (outcome: Outcome) => void }) {
  const { t } = useI18n()
  const operation = useAction(false)
  // The shared message for this code is about uploads: say what failed here instead.
  const storageFailure = operation.failure instanceof ApiError && operation.failure.code === 'action_storage_error'
  const author = authorName(item.author, t), size = byteSize(item.size)
  return <Modal title={t('storage.purge.title')} close={close} disabled={operation.busy}>
    <p><strong className="storage-filename">{item.filename}</strong> · {size}</p>
    <p className="muted">{t('storage.withdrawnPDFs.uploadedBy', { name: author })}<br />
      {t('storage.purge.action', { action: `#${item.action_id} · ${item.action_title}` })}</p>
    <ul className="storage-purge-facts">
      <li>{t('storage.purge.forever')}</li>
      <li>{t('storage.purge.history')}</li>
      <li>{item.author.kind === 'resident' ? t('storage.purge.freesNeighbor', { size, name: author }) : t('storage.purge.freesCommunity', { size })}</li>
    </ul>
    {storageFailure ? <Notice error>{t('storage.purge.storageError')}</Notice> : operation.notice}
    <div className="inline">
      <button type="button" className="secondary danger" disabled={operation.busy} onClick={() => void operation.run(async () => {
        try {
          await api<ActionAttachmentOut>(`/admin/storage/attachments/${item.id}/purge`, 'POST', { version: item.version })
        } catch (error) {
          if (!(error instanceof ApiError && error.code === 'action_stale')) throw error
          done({ kind: 'stale' })
          return
        }
        done({ kind: 'purged', filename: item.filename, size: item.size })
      })}><Icon name={operation.busy ? 'spinner' : 'trash'} size={16} className={operation.busy ? 'icon-spin' : undefined} />
        {operation.busy ? t('storage.purge.deleting') : t('storage.purge.confirm')}</button>
      <button type="button" className="secondary" disabled={operation.busy} onClick={close}>{t('common.cancel')}</button>
    </div>
  </Modal>
}

function WithdrawnTime({ value }: { value: string }) {
  return <time dateTime={value} title={connectionTime(value)}>{dateTimeFormat({ dateStyle: 'medium' }).format(new Date(value))}</time>
}

// The administrator's own copy, also while Actions is turned off.
function storedPdfUrl(item: StoredAttachmentOut, action: 'preview' | 'download'): string {
  return `/api/admin/storage/attachments/${item.id}/${action}`
}

// The latest withdrawn first, 5 per page.
function WithdrawnPDFs() {
  const { t, rich } = useI18n()
  const [page, setPage] = useState(1), [search, setSearch] = useState('')
  const [purging, setPurging] = useState<StoredAttachmentOut | null>(null)
  const [outcome, setOutcome] = useState<Outcome | null>(null)
  const heading = useRef<HTMLHeadingElement>(null), headingId = useId()
  const q = search.trim()
  const params = new URLSearchParams({ page: String(page) })
  if (q) params.set('q', q)
  const query = useQuery({
    queryKey: ['admin', 'storage', 'withdrawn', page, q],
    queryFn: () => api<StoredAttachmentPage>(`/admin/storage/withdrawn?${params}`),
    placeholderData: keepPreviousData, staleTime: 0,
  })
  // The deleted row took the focus with it: continue from the list, where the outcome is announced.
  useEffect(() => { if (outcome) heading.current?.focus() }, [outcome])
  function finish(next: Outcome) {
    setPurging(null); setOutcome(next)
    void cache.invalidateQueries({ queryKey: ['admin', 'storage'] })
    // Action pages and histories cached in this session must stop offering the file.
    void cache.invalidateQueries({ queryKey: ['actions'] })
  }
  const title = t('storage.withdrawnPDFs.title')
  return <section className="card" aria-labelledby={headingId}>
    <h2 id={headingId} ref={heading} tabIndex={-1}>{title}</h2>
    <label className="storage-search">{t('storage.withdrawnPDFs.search')}<input type="search" maxLength={200} value={search}
      onChange={event => { setSearch(event.target.value); setPage(1) }} /></label>
    {outcome?.kind === 'purged' && <Notice>{t('storage.withdrawnPDFs.purged', { filename: outcome.filename, size: byteSize(outcome.size) })}</Notice>}
    {outcome?.kind === 'stale' && <Notice error>{t('storage.withdrawnPDFs.stale')}</Notice>}
    {query.isPending && <Notice>{t('storage.withdrawnPDFs.loading')}</Notice>}
    {query.error && <><Notice error>{errorMessage(query.error)}</Notice>
      <button type="button" className="secondary" disabled={query.isFetching} onClick={() => void query.refetch()}>{t('common.retryLoading')}</button></>}
    {query.data && <>
      {query.data.total > 0 && <p className="muted">{q ? t('storage.search.results', { count: query.data.total })
        : t('storage.withdrawnPDFs.total', { count: query.data.total })}</p>}
      {query.data.items.length === 0
        ? <p className="empty">{page > 1 ? t('storage.withdrawnPDFs.empty.page')
          : q ? t('storage.search.empty', { query: q }) : t('storage.withdrawnPDFs.empty.all')}</p>
        : <ul className="action-attachment-list storage-withdrawn-list" aria-label={title} aria-busy={query.isFetching}>
          {query.data.items.map(item => {
            const withdrawnAt = item.withdrawn_at
            return <li key={item.id}>
              <div className="action-file-info"><strong>{item.filename}</strong>
                <p className="muted">{byteSize(item.size)} · {t('storage.withdrawnPDFs.uploadedBy', { name: authorName(item.author, t) })}
                  {withdrawnAt && <> · {rich('storage.withdrawnPDFs.withdrawnAt', { time: () => <WithdrawnTime value={withdrawnAt} /> })}</>}</p>
                <p><Link to={`/actions/${item.action_id}`}>#{item.action_id} · {item.action_title}</Link></p>
              </div>
              <div className="storage-file-actions">
                <PreviewLink file={{
                  name: item.filename, kind: 'pdf', path: `/admin/storage/attachments/${item.id}/preview`, download: storedPdfUrl(item, 'download'),
                }} className="button secondary icon-button"
                  aria-label={t('actions.pdf.view', { filename: item.filename })} title={t('actions.pdf.viewTitle')}><Icon name="eye" /></PreviewLink>
                <a className="button secondary icon-button" href={storedPdfUrl(item, 'download')} download=""
                  aria-label={t('actions.pdf.download', { filename: item.filename })} title={t('actions.pdf.downloadTitle')}><Icon name="download" /></a>
                <button type="button" className="secondary danger" aria-label={t('storage.withdrawnPDFs.deleteLabel', { filename: item.filename })}
                  onClick={() => { setOutcome(null); setPurging(item) }}><Icon name="trash" size={16} />{t('storage.withdrawnPDFs.delete')}</button>
              </div>
            </li>
          })}
        </ul>}
      <Pagination page={page} pages={query.data.pages} change={setPage} busy={query.isFetching} label={t('storage.withdrawnPDFs.pagination')} />
    </>}
    {purging && <PurgeDialog key={purging.id} item={purging} close={() => setPurging(null)} done={finish} />}
  </section>
}

function imageFileUrl(item: StoredImageOut): string {
  return `/api/admin/storage/images/${item.id}/file`
}

function ImagePurgeDialog({ item, close, done }: { item: StoredImageOut; close: () => void; done: (outcome: Outcome) => void }) {
  const { t } = useI18n()
  const operation = useAction(false)
  // The shared message for this code is about uploads: say what failed here instead.
  const storageFailure = operation.failure instanceof ApiError && operation.failure.code === 'image_storage_error'
  const author = authorName(item.author, t), size = byteSize(item.size)
  return <Modal title={t('storage.imagePurge.title')} close={close} disabled={operation.busy}>
    <img className="storage-image-preview" src={imageFileUrl(item)} alt={item.filename} />
    <p><strong className="storage-filename">{item.filename}</strong> · {size}</p>
    <p className="muted">{t('storage.withdrawnPDFs.uploadedBy', { name: author })}<br />{t(`storage.storedImages.sections.${item.scope}`)}</p>
    <ul className="storage-purge-facts">
      <li>{t('storage.purge.forever')}</li>
      <li>{t('storage.imagePurge.texts')}</li>
      <li>{item.author.kind === 'resident' ? t('storage.purge.freesNeighbor', { size, name: author }) : t('storage.purge.freesCommunity', { size })}</li>
    </ul>
    {storageFailure ? <Notice error>{t('storage.purge.storageError')}</Notice> : operation.notice}
    <div className="inline">
      <button type="button" className="secondary danger" disabled={operation.busy} onClick={() => void operation.run(async () => {
        await api<StoredImageOut>(`/admin/storage/images/${item.id}/purge`, 'POST')
        done({ kind: 'purged', filename: item.filename, size: item.size })
      })}><Icon name={operation.busy ? 'spinner' : 'trash'} size={16} className={operation.busy ? 'icon-spin' : undefined} />
        {operation.busy ? t('storage.purge.deleting') : t('storage.purge.confirm')}</button>
      <button type="button" className="secondary" disabled={operation.busy} onClick={close}>{t('common.cancel')}</button>
    </div>
  </Modal>
}

// The newest first, 5 per page.
function StoredImages() {
  const { t, rich } = useI18n()
  const [page, setPage] = useState(1), [search, setSearch] = useState('')
  const [purging, setPurging] = useState<StoredImageOut | null>(null)
  const [outcome, setOutcome] = useState<Outcome | null>(null)
  const heading = useRef<HTMLHeadingElement>(null), headingId = useId()
  const q = search.trim()
  const params = new URLSearchParams({ page: String(page) })
  if (q) params.set('q', q)
  const query = useQuery({
    queryKey: ['admin', 'storage', 'images', page, q],
    queryFn: () => api<StoredImagePage>(`/admin/storage/images?${params}`),
    placeholderData: keepPreviousData, staleTime: 0,
  })
  // The deleted row took the focus with it: continue from the list, where the outcome is announced.
  useEffect(() => { if (outcome) heading.current?.focus() }, [outcome])
  function finish(next: Outcome) {
    setPurging(null); setOutcome(next)
    void cache.invalidateQueries({ queryKey: ['admin', 'storage'] })
  }
  const title = t('storage.storedImages.title')
  return <section className="card" aria-labelledby={headingId}>
    <h2 id={headingId} ref={heading} tabIndex={-1}>{title}</h2>
    <label className="storage-search">{t('storage.storedImages.search')}<input type="search" maxLength={200} value={search}
      onChange={event => { setSearch(event.target.value); setPage(1) }} /></label>
    {outcome?.kind === 'purged' && <Notice>{t('storage.storedImages.purged', { filename: outcome.filename, size: byteSize(outcome.size) })}</Notice>}
    {query.isPending && <Notice>{t('storage.storedImages.loading')}</Notice>}
    {query.error && <><Notice error>{errorMessage(query.error)}</Notice>
      <button type="button" className="secondary" disabled={query.isFetching} onClick={() => void query.refetch()}>{t('common.retryLoading')}</button></>}
    {query.data && <>
      {query.data.total > 0 && <p className="muted">{q ? t('storage.search.results', { count: query.data.total })
        : t('storage.storedImages.total', { count: query.data.total })}</p>}
      {query.data.items.length === 0
        ? <p className="empty">{page > 1 ? t('storage.storedImages.empty.page')
          : q ? t('storage.search.empty', { query: q }) : t('storage.storedImages.empty.all')}</p>
        : <ul className="action-attachment-list storage-image-list" aria-label={title} aria-busy={query.isFetching}>
          {query.data.items.map(item => <li key={item.id}>
            <PreviewLink className="storage-image-thumb" file={{
              name: item.filename, kind: 'image', path: `/admin/storage/images/${item.id}/file`, download: imageFileUrl(item),
            }} aria-label={t('storage.storedImages.open', { filename: item.filename })}>
              <img src={imageFileUrl(item)} alt="" loading="lazy" decoding="async" />
            </PreviewLink>
            <div className="action-file-info"><strong>{item.filename}</strong>
              <p className="muted">{t('storage.storedImages.details', {
                size: byteSize(item.size), width: formatNumber(item.width), height: formatNumber(item.height),
                section: t(`storage.storedImages.sections.${item.scope}`),
              })}</p>
              <p className="muted">{t('storage.withdrawnPDFs.uploadedBy', { name: authorName(item.author, t) })} · {rich('storage.storedImages.uploadedAt', {
                time: () => <WithdrawnTime value={item.created_at} />,
              })}</p>
            </div>
            <button type="button" className="secondary danger" aria-label={t('storage.storedImages.deleteLabel', { filename: item.filename })}
              onClick={() => { setOutcome(null); setPurging(item) }}><Icon name="trash" size={16} />{t('storage.storedImages.delete')}</button>
          </li>)}
        </ul>}
      <Pagination page={page} pages={query.data.pages} change={setPage} busy={query.isFetching} label={t('storage.storedImages.pagination')} />
    </>}
    {purging && <ImagePurgeDialog key={purging.id} item={purging} close={() => setPurging(null)} done={finish} />}
  </section>
}

function RefreshButton() {
  const { t } = useI18n()
  const fetching = useIsFetching({ queryKey: ['admin', 'storage'] }) > 0
  return <button type="button" className="secondary" disabled={fetching} onClick={() => void cache.invalidateQueries({ queryKey: ['admin', 'storage'] })}>
    <Icon name="refresh" size={16} />{t('storage.refresh')}</button>
}

export function StoragePage() {
  const { t } = useI18n()
  const summary = useQuery({
    queryKey: ['admin', 'storage', 'summary'], queryFn: () => api<StorageOut>('/admin/storage'), staleTime: 0,
  })
  return <>
    <div className="page-heading"><div><p className="eyebrow">{t('storage.eyebrow')}</p><h1>{t('storage.title')}</h1>
      <p className="muted">{t('storage.description')}</p></div>
      <RefreshButton />
    </div>
    {summary.isPending && <Notice>{t('storage.loading')}</Notice>}
    {summary.error && <><Notice error>{errorMessage(summary.error)}</Notice>
      <button type="button" className="secondary" disabled={summary.isFetching} onClick={() => void summary.refetch()}>{t('common.retryLoading')}</button></>}
    {summary.data && <>
      <div className="storage-summary">
        <CommunityCard usage={summary.data.community} />
        <AdministratorCard usage={summary.data.administrator} />
        <DocumentStorageCard storage={summary.data.documents} />
        <DiskCard disk={summary.data.disk} />
      </div>
      <DocumentLimitsCard storage={summary.data.documents} />
      <NeighborsCard storage={summary.data} />
    </>}
  </>
}

// The files that keep using space until the administrator deletes them permanently.
export function CleanupPage() {
  const { t } = useI18n()
  return <>
    <div className="page-heading"><div><p className="eyebrow">{t('storage.eyebrow')}</p><h1>{t('storage.cleanup.title')}</h1>
      <p className="muted">{t('storage.cleanup.description')}</p></div>
      <RefreshButton />
    </div>
    <WithdrawnPDFs />
    <StoredImages />
    <PreviousDocumentVersions />
  </>
}
