import { useId, useState } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { api, cache, errorMessage } from './api/client'
import type { DocumentTextFileOut, DocumentTextFilePage, DocumentTextQueueOut, DocumentTextSummaryOut } from './api/schema.gen'
import { ActionTime } from './community-action-shared'
import { kindIcon, locationText } from './documents'
import { formatNumber, useI18n, type Translate } from './i18n'
import { Icon } from './icons'
import { Notice, Pagination, useAction } from './shared'

type Filter = 'all' | 'pending' | 'failed' | 'empty' | 'partial' | 'ocr' | 'text'
const FILTERS: readonly Filter[] = ['all', 'pending', 'failed', 'empty', 'partial', 'ocr', 'text']
const KEY = ['admin', 'documents', 'text'] as const
// While files wait or one is being read, the page follows the reading.
const REFRESH_MS = 5_000

function working(summary: DocumentTextSummaryOut | undefined): boolean {
  return !!summary && (summary.counts.pending > 0 || summary.reading !== null)
}

/** How a file was read: "Read · 1,234 characters · OCR of 2 pages", or why it could not be. */
export function fileStatus(item: DocumentTextFileOut, translate: Translate): string {
  const parts: string[] = []
  if (item.status === 'pending') {
    parts.push(translate(item.reading ? 'documents.admin.reading.files.status.reading' : 'documents.admin.reading.files.status.pending'))
  } else if (item.status === 'failed') {
    parts.push(`${translate('documents.admin.reading.files.status.failed')}: ${translate(`documents.admin.reading.errors.${item.error ?? 'failed'}`)}`)
  } else if (item.status === 'empty') {
    parts.push(translate('documents.admin.reading.files.status.empty'))
  } else {
    parts.push(translate('documents.admin.reading.files.status.ready'), translate('documents.admin.reading.files.characters', { count: item.characters }))
  }
  if (item.status !== 'pending' && item.ocr_pages > 0) parts.push(translate('documents.admin.reading.files.ocrPages', { count: item.ocr_pages }))
  if (item.status === 'ready' && item.partial) parts.push(translate('documents.admin.reading.files.partial'))
  if (item.needs_ocr) parts.push(translate('documents.admin.reading.files.needsOcr'))
  return parts.join(' · ')
}

function ProgressMeter({ done, total }: { done: number; total: number }) {
  const { t } = useI18n()
  const ratio = total > 0 ? done / total : 1
  return <div className="storage-meter" role="progressbar" aria-label={t('documents.admin.reading.progress.meter')}
    aria-valuemin={0} aria-valuemax={total} aria-valuenow={done} aria-valuetext={t('documents.admin.reading.progress.meterText', {
      done: formatNumber(done), total: formatNumber(total),
      percent: formatNumber(Math.floor(ratio * 1000) / 1000, { style: 'percent', maximumFractionDigits: 1 }),
    })}>
    <span className="storage-meter-fill" style={{ width: `${ratio * 100}%` }} />
  </div>
}

/** How the text of the shared documents is read for the search: progress, OCR and every file's state. */
export function DocumentReadingPage() {
  const { t, rich } = useI18n()
  const [filter, setFilter] = useState<Filter>('all')
  const [page, setPage] = useState(1)
  const [outcome, setOutcome] = useState('')
  const action = useAction(false)
  const progressHeading = useId(), filesHeading = useId()
  const summary = useQuery({
    queryKey: [...KEY, 'summary'],
    queryFn: ({ signal }) => api<DocumentTextSummaryOut>('/admin/documents/text', 'GET', undefined, signal),
    refetchInterval: query => working(query.state.data) ? REFRESH_MS : false,
  })
  const files = useQuery({
    queryKey: [...KEY, 'files', filter, page],
    queryFn: ({ signal }) => api<DocumentTextFilePage>(
      `/admin/documents/text/files?${new URLSearchParams({ status: filter, page: String(page) })}`, 'GET', undefined, signal,
    ),
    placeholderData: keepPreviousData,
    refetchInterval: working(summary.data) ? REFRESH_MS : false,
  })
  function queue(request: () => Promise<string>) {
    setOutcome('')
    void action.run(async () => {
      const message = await request()
      await cache.invalidateQueries({ queryKey: KEY })
      setOutcome(message)
    })
  }
  const retry = () => queue(async () => {
    const result = await api<DocumentTextQueueOut>('/admin/documents/text/retry', 'POST')
    return t('documents.admin.reading.retried', { count: result.queued })
  })
  const readAgain = (item: DocumentTextFileOut) => queue(async () => {
    await api<DocumentTextFileOut>(`/admin/documents/text/files/${item.document_id}/read`, 'POST')
    return t('documents.admin.reading.files.queued', { name: item.name })
  })
  const data = summary.data, counts = data?.counts
  const done = counts ? counts.readable - counts.pending : 0
  const language = data ? t(`documents.admin.reading.engine.languages.${data.engine.language}`) : ''
  const filterName = t(`documents.admin.reading.files.filters.${filter}`)
  return <>
    <div className="page-heading"><div><p className="eyebrow">{t('admin.eyebrow')}</p><h1>{t('documents.admin.reading.title')}</h1>
      <p className="muted">{t('documents.admin.reading.description')}</p></div></div>
    {outcome && <Notice>{outcome}</Notice>}
    {action.notice}
    <section className="card storage-card document-reading-progress" aria-labelledby={progressHeading}>
      <h2 id={progressHeading}>{t('documents.admin.reading.progress.title')}</h2>
      {summary.isPending && <Notice>{t('documents.admin.reading.loading')}</Notice>}
      {summary.error && <><Notice error>{errorMessage(summary.error)}</Notice>
        <button type="button" className="secondary" disabled={summary.isFetching} onClick={() => void summary.refetch()}>{t('common.retryLoading')}</button></>}
      {data && counts && <>
        {counts.readable === 0 ? <p>{t('documents.admin.reading.progress.nothing')}</p> : <>
          <p className="storage-figure">{t('documents.admin.reading.progress.figure', { done: formatNumber(done), count: counts.readable })}</p>
          <ProgressMeter done={done} total={counts.readable} />
          <p>{counts.pending > 0 ? t('documents.admin.reading.progress.waiting', { count: counts.pending }) : t('documents.admin.reading.progress.done')}</p>
        </>}
        {data.reading && <p>{rich('documents.admin.reading.progress.reading', {
          strong: chunks => <strong>{chunks}</strong>, time: () => <ActionTime value={data.reading?.started_at ?? ''} />,
        }, { name: data.reading.name })}</p>}
        <dl className="storage-breakdown">
          {(['text', 'empty', 'failed', 'pending', 'ocr', 'partial'] as const).map(key => <div key={key}>
            <dt>{t(`documents.admin.reading.counts.${key}`)}</dt>
            <dd>{t('documents.admin.reading.counts.files', { count: counts[key] })}</dd>
          </div>)}
          <div><dt>{t('documents.admin.reading.counts.unsupported')}</dt>
            <dd>{t('documents.admin.reading.counts.files', { count: counts.files - counts.readable })}</dd></div>
        </dl>
        {data.engine.available
          ? <p className="muted">{t('documents.admin.reading.engine.available', { version: data.engine.version ?? '', language })}</p>
          : <p className="notice warning" role="status">{t('documents.admin.reading.engine.unavailable', { language })}</p>}
        {counts.needs_ocr > 0 && <p className="muted">{t('documents.admin.reading.engine.needsOcr', { count: counts.needs_ocr })}</p>}
        {counts.failed > 0 && <button type="button" className="secondary" disabled={action.busy} onClick={retry}>
          <Icon name="refresh" size={16} />{t('documents.admin.reading.retry', { count: counts.failed })}</button>}
      </>}
    </section>
    <section className="card" aria-labelledby={filesHeading}>
      <div className="document-reading-header">
        <h2 id={filesHeading}>{t('documents.admin.reading.files.title')}</h2>
        <label>{t('documents.admin.reading.files.filter')}<select value={filter} onChange={event => {
          setFilter(FILTERS.find(value => value === event.target.value) ?? 'all')
          setPage(1)
        }}>
          {FILTERS.map(value => <option key={value} value={value}>{t(`documents.admin.reading.files.filters.${value}`)}</option>)}
        </select></label>
      </div>
      {files.isPending && <Notice>{t('documents.admin.reading.loading')}</Notice>}
      {files.error && <><Notice error>{errorMessage(files.error)}</Notice>
        <button type="button" className="secondary" disabled={files.isFetching} onClick={() => void files.refetch()}>{t('common.retryLoading')}</button></>}
      {files.data && <>
        {files.data.items.length === 0
          ? <p className="empty">{page > 1 ? t('documents.admin.reading.files.emptyPage') : t('documents.admin.reading.files.empty')}</p>
          : <ul className="action-attachment-list document-reading-list" aria-label={t('documents.admin.reading.files.label', { filter: filterName })}
            aria-busy={files.isFetching}>
            {files.data.items.map(item => <li key={item.document_id}>
              <Icon name={kindIcon(item.kind)} size={28} className="document-icon" />
              <div className="action-file-info"><strong>{item.name}</strong>
                <p className="muted">{locationText(item.location.map(folder => folder.name), t)}</p>
                <p className={item.status === 'failed' ? 'document-reading-failed' : 'muted'}>{fileStatus(item, t)}
                  {item.read_at && <> · {rich('documents.admin.reading.files.readAt', { time: () => <ActionTime value={item.read_at ?? ''} /> })}</>}</p>
              </div>
              <button type="button" className="secondary" disabled={action.busy || item.status === 'pending'}
                aria-label={t('documents.admin.reading.files.readAgainLabel', { name: item.name })} onClick={() => readAgain(item)}>
                <Icon name="refresh" size={16} />{t('documents.admin.reading.files.readAgain')}</button>
            </li>)}
          </ul>}
        <Pagination page={page} pages={files.data.pages} change={setPage} busy={files.isFetching} label={t('documents.admin.reading.files.pagination')} />
      </>}
    </section>
  </>
}
