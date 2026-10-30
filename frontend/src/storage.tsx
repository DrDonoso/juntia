import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { keepPreviousData, useIsFetching, useQuery } from '@tanstack/react-query'
import { Link } from 'react-router'
import { ApiError, api, cache, errorMessage } from './api/client'
import type {
  ActionAttachmentOut, CommunityStorageOut, DiskSpaceOut, ResidentStorageOut, StorageOut, StorageUsageOut, StoredAttachmentOut,
  StoredAttachmentPage,
} from './api/schema.gen'
import { byteSize } from './community-action-shared'
import { compareText, dateTimeFormat, formatNumber, useI18n } from './i18n'
import { Icon } from './icons'
import { Modal, Notice, Pagination, authorName, connectionTime, useAction } from './shared'

// The server environment variables behind each limit, in whole MiB.
const SETTINGS = {
  neighbor: 'ACTION_STORAGE_USER_QUOTA_MB',
  community: 'ACTION_STORAGE_COMMUNITY_QUOTA_MB',
  reserve: 'MIN_FREE_DISK_MB',
} as const

type Level = 'normal' | 'warning' | 'full'
type Sort = 'largest' | 'oldest'
type Author = { id: number; name: string; deleted: boolean }
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
    <p className="muted storage-hint">{t('storage.community.hint')}</p>
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
    <p className="muted">{t('storage.administrator.hint')}</p>
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
    <p className="muted">{t('storage.disk.reserve', { size: byteSize(reserve) })}</p>
    {level === 'full' && <Notice error>{t('storage.disk.below')}</Notice>}
    {level === 'warning' && <Warning>{t('storage.disk.near')}</Warning>}
  </section>
}

function useNeighborName() {
  const { t } = useI18n()
  return (value: ResidentStorageOut) => value.name || t('storage.neighbors.unnamed', { id: value.user_id })
}

function NeighborsCard({ storage }: { storage: StorageOut }) {
  const { t } = useI18n()
  const heading = useId(), neighborName = useNeighborName()
  const title = t('storage.neighbors.title')
  return <section className="card" aria-labelledby={heading}>
    <h2 id={heading}>{title}</h2>
    <p className="muted">{t('storage.neighbors.description', { size: byteSize(storage.resident_quota_bytes) })}</p>
    {storage.residents.length === 0 ? <p className="empty">{t('storage.neighbors.empty')}</p>
      : <div className="table-scroll"><table className="storage-table" aria-label={title}>
        <thead><tr>
          <th scope="col">{t('storage.neighbors.columns.neighbor')}</th>
          <th scope="col" className="numeric">{t('storage.neighbors.columns.active')}</th>
          <th scope="col" className="numeric">{t('storage.neighbors.columns.withdrawn')}</th>
          <th scope="col">{t('storage.neighbors.columns.quota')}</th>
        </tr></thead>
        <tbody>{storage.residents.map(resident => {
          const name = neighborName(resident)
          return <tr key={resident.user_id}>
            <th scope="row"><span className="storage-neighbor">{name}</span>
              {resident.account_deleted && <span className="tag">{t('storage.neighbors.deleted')}</span>}</th>
            <td className="numeric">{byteSize(resident.active_bytes)}<small>{t('storage.files', { count: resident.active_files })}</small></td>
            <td className="numeric">{byteSize(resident.withdrawn_bytes)}<small>{t('storage.files', { count: resident.withdrawn_files })}</small></td>
            <td className="storage-quota">{t('storage.usage', { used: byteSize(resident.stored_bytes), limit: byteSize(resident.quota_bytes) })}
              <UsageMeter label={t('storage.neighbors.meter', { name })} used={resident.stored_bytes} limit={resident.quota_bytes}
                level={quotaLevel(resident.stored_bytes, resident.quota_bytes)} /></td>
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

function WithdrawnPDFs({ residents }: { residents: ResidentStorageOut[] }) {
  const { t, rich } = useI18n()
  const neighborName = useNeighborName()
  const [sort, setSort] = useState<Sort>('largest'), [page, setPage] = useState(1)
  const [author, setAuthor] = useState<Author | null>(null)
  const [purging, setPurging] = useState<StoredAttachmentOut | null>(null)
  const [outcome, setOutcome] = useState<Outcome | null>(null)
  const heading = useRef<HTMLHeadingElement>(null), headingId = useId()
  const params = new URLSearchParams({ page: String(page), sort })
  if (author) params.set('user_id', String(author.id))
  const query = useQuery({
    queryKey: ['admin', 'storage', 'withdrawn', params.toString()],
    queryFn: () => api<StoredAttachmentPage>(`/admin/storage/withdrawn?${params}`),
    placeholderData: keepPreviousData, staleTime: 0,
  })
  // The deleted row took the focus with it: continue from the list, where the outcome is announced.
  useEffect(() => { if (outcome) heading.current?.focus() }, [outcome])
  const authors: Author[] = residents.filter(resident => resident.withdrawn_files > 0 || resident.user_id === author?.id)
    .map(resident => ({ id: resident.user_id, name: neighborName(resident), deleted: resident.account_deleted }))
  if (author && !authors.some(option => option.id === author.id)) authors.push(author)
  authors.sort((left, right) => compareText(left.name, right.name))
  function finish(next: Outcome) {
    setPurging(null); setOutcome(next)
    void cache.invalidateQueries({ queryKey: ['admin', 'storage'] })
    // Action pages and histories cached in this session must stop offering the file.
    void cache.invalidateQueries({ queryKey: ['actions'] })
  }
  const title = t('storage.withdrawnPDFs.title')
  return <section className="card" aria-labelledby={headingId}>
    <h2 id={headingId} ref={heading} tabIndex={-1}>{title}</h2>
    <p className="muted">{t('storage.withdrawnPDFs.description')}</p>
    <div className="storage-filters">
      <label>{t('storage.withdrawnPDFs.sort')}<select value={sort} onChange={event => {
        setSort(event.target.value === 'oldest' ? 'oldest' : 'largest'); setPage(1)
      }}>
        <option value="largest">{t('storage.withdrawnPDFs.sorts.largest')}</option>
        <option value="oldest">{t('storage.withdrawnPDFs.sorts.oldest')}</option>
      </select></label>
      <label>{t('storage.withdrawnPDFs.author')}<select value={author ? String(author.id) : ''} onChange={event => {
        setAuthor(authors.find(option => String(option.id) === event.target.value) ?? null); setPage(1)
      }}>
        <option value="">{t('storage.withdrawnPDFs.everyone')}</option>
        {authors.map(option => <option key={option.id} value={option.id}>
          {option.deleted ? t('storage.withdrawnPDFs.deletedAuthor', { name: option.name }) : option.name}</option>)}
      </select></label>
    </div>
    {outcome?.kind === 'purged' && <Notice>{t('storage.withdrawnPDFs.purged', { filename: outcome.filename, size: byteSize(outcome.size) })}</Notice>}
    {outcome?.kind === 'stale' && <Notice error>{t('storage.withdrawnPDFs.stale')}</Notice>}
    {query.isPending && <Notice>{t('storage.withdrawnPDFs.loading')}</Notice>}
    {query.error && <><Notice error>{errorMessage(query.error)}</Notice>
      <button type="button" className="secondary" disabled={query.isFetching} onClick={() => void query.refetch()}>{t('common.retryLoading')}</button></>}
    {query.data && <>
      {query.data.total > 0 && <p className="muted">{t('storage.withdrawnPDFs.total', { count: query.data.total })}</p>}
      {query.data.items.length === 0
        ? <p className="empty">{page > 1 ? t('storage.withdrawnPDFs.empty.page') : author ? t('storage.withdrawnPDFs.empty.author') : t('storage.withdrawnPDFs.empty.all')}</p>
        : <ul className="action-attachment-list storage-withdrawn-list" aria-label={title} aria-busy={query.isFetching}>
          {query.data.items.map(item => {
            const withdrawnAt = item.withdrawn_at
            return <li key={item.id}>
              <div className="action-file-info"><strong>{item.filename}</strong>
                <p className="muted">{byteSize(item.size)} · {t('storage.withdrawnPDFs.uploadedBy', { name: authorName(item.author, t) })}</p>
                {withdrawnAt && <p className="muted">{rich('storage.withdrawnPDFs.withdrawnAt', { time: () => <WithdrawnTime value={withdrawnAt} /> })}</p>}
                <p><Link to={`/actions/${item.action_id}`}>#{item.action_id} · {item.action_title}</Link></p>
              </div>
              <button type="button" className="secondary danger" aria-label={t('storage.withdrawnPDFs.deleteLabel', { filename: item.filename })}
                onClick={() => { setOutcome(null); setPurging(item) }}><Icon name="trash" size={16} />{t('storage.withdrawnPDFs.delete')}</button>
            </li>
          })}
        </ul>}
      <Pagination page={page} pages={query.data.pages} change={setPage} busy={query.isFetching} label={t('storage.withdrawnPDFs.pagination')} />
    </>}
    {purging && <PurgeDialog key={purging.id} item={purging} close={() => setPurging(null)} done={finish} />}
  </section>
}

function LimitsHelp({ storage }: { storage: StorageOut }) {
  const { t } = useI18n()
  const heading = useId()
  const limits = [
    { label: 'storage.help.neighborQuota', bytes: storage.resident_quota_bytes, setting: SETTINGS.neighbor },
    { label: 'storage.help.communityQuota', bytes: storage.community.quota_bytes, setting: SETTINGS.community },
    { label: 'storage.help.reserve', bytes: storage.disk.reserve_bytes, setting: SETTINGS.reserve },
  ] as const
  return <section className="card storage-help" aria-labelledby={heading}>
    <h2 id={heading}>{t('storage.help.title')}</h2>
    <dl className="storage-limits">{limits.map(limit => <div key={limit.setting}>
      <dt>{t(limit.label)}</dt><dd><strong>{byteSize(limit.bytes)}</strong><code>{limit.setting}</code></dd>
    </div>)}</dl>
    <ul className="storage-help-list">
      <li>{t('storage.help.counting')}</li>
      <li>{t('storage.help.withdrawn')}</li>
      <li>{t('storage.help.reserveRule')}</li>
      <li>{t('storage.help.change')}</li>
      <li>{t('storage.help.permanent')}</li>
    </ul>
  </section>
}

export function StoragePage() {
  const { t } = useI18n()
  const summary = useQuery({
    queryKey: ['admin', 'storage', 'summary'], queryFn: () => api<StorageOut>('/admin/storage'), staleTime: 0,
  })
  const fetching = useIsFetching({ queryKey: ['admin', 'storage'] }) > 0
  return <>
    <div className="page-heading"><div><p className="eyebrow">{t('storage.eyebrow')}</p><h1>{t('storage.title')}</h1>
      <p className="muted">{t('storage.description')}</p></div>
      <button type="button" className="secondary" disabled={fetching} onClick={() => void cache.invalidateQueries({ queryKey: ['admin', 'storage'] })}>
        <Icon name="refresh" size={16} />{t('storage.refresh')}</button>
    </div>
    {summary.isPending && <Notice>{t('storage.loading')}</Notice>}
    {summary.error && <><Notice error>{errorMessage(summary.error)}</Notice>
      <button type="button" className="secondary" disabled={summary.isFetching} onClick={() => void summary.refetch()}>{t('common.retryLoading')}</button></>}
    {summary.data && <>
      <div className="storage-summary">
        <CommunityCard usage={summary.data.community} />
        <AdministratorCard usage={summary.data.administrator} />
        <DiskCard disk={summary.data.disk} />
      </div>
      <NeighborsCard storage={summary.data} />
    </>}
    <WithdrawnPDFs residents={summary.data?.residents ?? []} />
    {summary.data && <LimitsHelp storage={summary.data} />}
  </>
}
