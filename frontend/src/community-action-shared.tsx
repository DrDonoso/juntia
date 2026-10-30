import type { ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ApiError, api, cache, downloadFile, errorMessage } from './api/client'
import type { ActionActorOut, ActionLabelOut, ActionLabelPage, ActionOut, ActionSummaryOut, UserAuthOut } from './api/schema.gen'
import { TagBadge, normalizeTagName, tagColor } from './contact-tags'
import { formatNumber, t, useI18n } from './i18n'
import { Icon } from './icons'
import { Notice, authorName, connectionTime, useAction, useFeatures } from './shared'

export type ActionStatus = ActionSummaryOut['status']
export const actionStatuses: ActionStatus[] = [
  'detected', 'quoting', 'voting', 'approved', 'ordered', 'in_progress', 'done', 'discarded',
]
export const PDF_BYTES = 20 * 1024 * 1024
export const PDF_COUNT = 20

// Translated in the active language; the components that show them re-render on a language switch.
export const commentCountLabel = (count: number) => t('actions.counts.comments', { count })
export const attachmentCountLabel = (count: number) => t('actions.counts.attachments', { count })

export function ActionFeatureGate({ children }: { children: ReactNode }) {
  const features = useFeatures()
  const { t } = useI18n()
  if (features.isPending) return <Notice>{t('actions.gate.checking')}</Notice>
  if (features.error) return <Notice error>{errorMessage(features.error)}</Notice>
  if (!features.data.actions) return <section className="card">
    <h1>{t('actions.gate.title')}</h1>
    <p>{t('actions.gate.description')}</p>
  </section>
  return children
}

export function createUploadId(): string {
  // Unlike randomUUID, getRandomValues also works on the app's HTTP development origins.
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('')
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-')
}

export function isActionStatus(value: string): value is ActionStatus {
  return (actionStatuses as readonly string[]).includes(value)
}

export function actionRequestParams(params: URLSearchParams): URLSearchParams {
  const result = new URLSearchParams()
  for (const key of ['q', 'status', 'label', 'scope']) {
    for (const value of params.getAll(key)) if (value) result.append(key, value)
  }
  return result
}

export function useActionLabels(q = '', page = 1, ids?: string[]) {
  const params = new URLSearchParams({ q, page: String(page) })
  ids?.forEach(id => params.append('id', id))
  return useQuery({
    queryKey: ['actions', 'labels', params.toString()],
    queryFn: () => api<ActionLabelPage>(`/actions/labels?${params}`),
    enabled: ids === undefined || ids.length > 0,
  })
}

export function canModerate(author: ActionActorOut, reader?: UserAuthOut): boolean {
  return reader?.authenticated === true && (reader.kind === 'administrator'
    || reader.kind === 'resident' && author.kind === 'resident' && reader.user_id === author.user_id)
}

export function ActionTime({ value }: { value: string }) {
  return <time dateTime={value}>{connectionTime(value)}</time>
}

export function Actor({ value }: { value: ActionActorOut }) {
  const { t } = useI18n()
  return <span>{authorName(value, t)}</span>
}

export function ActionLabelBadge({ label }: { label: ActionLabelOut }) {
  return <TagBadge tag={{ ...label, color: tagColor(label) }} />
}

export function StatusOptions() {
  const { t } = useI18n()
  return actionStatuses.map(status => <option key={status} value={status}>{t(`actions.status.${status}`)}</option>)
}

export function StatusBadge({ status }: { status: ActionStatus }) {
  const { t } = useI18n()
  return <span className={`tag action-status action-status-${status}`}>{t(`actions.status.${status}`)}</span>
}

export function StatusControl({ item, hideLabel = false }: { item: ActionSummaryOut; hideLabel?: boolean }) {
  const { t } = useI18n()
  const operation = useAction(['actions'])
  const stale = operation.failure instanceof ApiError && operation.failure.code === 'action_stale'
  return <div className="action-status-control">
    <label>{!hideLabel && t('actions.statusControl.label')}<select aria-label={t('actions.statusControl.labelFor', { title: item.title })} value={item.status} disabled={operation.busy} onChange={event => {
      const status = event.target.value
      void operation.run(async () => {
        if (!isActionStatus(status)) throw new ApiError('invalid_request', 422)
        await api(`/actions/items/${item.id}`, 'PATCH', { version: item.version, status })
      }, t('actions.statusControl.saved'))
    }}><StatusOptions /></select></label>
    {operation.notice}
    {stale && <button type="button" className="secondary" disabled={operation.busy} onClick={() => void operation.run(async () => {
      await cache.invalidateQueries({ queryKey: ['actions'] })
    })}>{t('actions.statusControl.checkCurrent')}</button>}
  </div>
}

export { Pagination as ActionPagination } from './shared'

export function PDFControls({ itemId, id, filename, purgedAt, children }: {
  itemId: number; id: string; filename: string; purgedAt?: string | null; children?: ReactNode
}) {
  const { t, rich } = useI18n()
  const operation = useAction(false)
  const endpoint = `/actions/items/${itemId}/attachments/${id}`
  // A purged PDF has no file left: show when it was deleted instead of controls that would fail.
  if (purgedAt) return <p className="muted action-pdf-purged">{rich('actions.pdf.purged', { time: () => <ActionTime value={purgedAt} /> })}</p>
  return <div className="action-pdf-controls">
    <div className="inline">
      <a className="button secondary icon-button" href={`/api${endpoint}/preview`} target="_blank" rel="noopener noreferrer"
        aria-label={t('actions.pdf.view', { filename })} title={t('actions.pdf.viewTitle')}><Icon name="eye" /></a>
      <button type="button" className="secondary icon-button" disabled={operation.busy} aria-label={t('actions.pdf.download', { filename })}
        title={t('actions.pdf.downloadTitle')} onClick={() => void operation.run(async () => {
          try {
            await downloadFile(`${endpoint}/download`, filename)
          } catch (error) {
            // Deleted permanently since it was listed: refresh the views so they stop offering it.
            if (error instanceof ApiError && error.code === 'action_attachment_purged') void cache.invalidateQueries({ queryKey: ['actions'] })
            throw error
          }
        })}><Icon name={operation.busy ? 'spinner' : 'download'} className={operation.busy ? 'icon-spin' : undefined} /></button>
      {children}
    </div>
    {operation.notice}
  </div>
}

const BYTE_UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'] as const

/** Sizes in binary units (1 KiB = 1024 B), like the server's MiB settings, in the active language. */
export function byteSize(size: number): string {
  let value = size, unit = 0
  // Compare the rounded value, so 1,048,575 bytes read "1 MiB" rather than "1,024 KiB".
  while (unit < BYTE_UNITS.length - 1 && Math.round(Math.abs(value) * 100) / 100 >= 1024) {
    value /= 1024
    unit++
  }
  return `${formatNumber(value, { maximumFractionDigits: unit === 0 ? 0 : 2 })} ${BYTE_UNITS[unit]}`
}

export type ActionDraft = { title: string; description: string; labels: string[]; status: ActionStatus }

export function actionDraft(value?: ActionOut | null): ActionDraft {
  return {
    title: value?.title || '', description: value?.description || '',
    labels: value?.labels.map(label => label.name) || [], status: value?.status || 'detected',
  }
}

export function rebaseActionDraft(draft: ActionDraft, base: ActionOut, current: ActionOut): ActionDraft {
  const renamed = new Map(base.labels.map(label => [
    normalizeTagName(label.name), current.labels.find(value => value.id === label.id)?.name || label.name,
  ]))
  const labels = draft.labels.map(name => renamed.get(normalizeTagName(name)) || name)
  return {
    title: draft.title === base.title ? current.title : draft.title,
    description: draft.description === base.description ? current.description : draft.description,
    status: draft.status === base.status ? current.status : draft.status,
    labels: JSON.stringify(draft.labels) === JSON.stringify(base.labels.map(label => label.name))
      ? current.labels.map(label => label.name)
      : [...new Map(labels.map(name => [normalizeTagName(name), name])).values()],
  }
}
