import { useState } from 'react'
import { api, errorMessage } from './api/client'
import type { CatalogOut, EnrichmentIn, TransactionOut } from './api/schema.gen'
import { ContactTagPicker, DEFAULT_TAG_COLOR, TagBadge, appendContactTag, normalizeTagName, paletteColor, type ContactTagChoice } from './contact-tags'
import { Modal, Money, Notice, day, useAction, useCatalog } from './shared'
import { useI18n } from './i18n'

export type MetadataDraft = { category_id: number | null; merchant: string; tags: ContactTagChoice[]; tagInput: string }

export function metadataDraft(value: EnrichmentIn): MetadataDraft {
  return {
    category_id: value.category_id ?? null, merchant: value.merchant || '', tagInput: '',
    tags: [
      ...(value.tags || []).map(id => ({ id, name: `#${id}`, color: DEFAULT_TAG_COLOR })),
      ...(value.new_tags || []).map(tag => ({ id: null, name: tag.name, color: tag.color ?? paletteColor(normalizeTagName(tag.name)) })),
    ],
  }
}

function metadataTags(value: MetadataDraft, available: CatalogOut[]): ContactTagChoice[] {
  return value.tags.map(tag => tag.id === null ? tag : available.find(item => item.id === tag.id) || tag)
}

export function prepareMetadata(value: MetadataDraft, available: CatalogOut[]): EnrichmentIn {
  const selection = appendContactTag(metadataTags(value, available), value.tagInput, available)
  if (selection.error) throw new Error(selection.error)
  const newTags = selection.tags.filter(tag => tag.id === null).map(({ name, color }) => ({ name, color }))
  return {
    category_id: value.category_id, merchant: value.merchant,
    tags: selection.tags.flatMap(tag => tag.id === null ? [] : [tag.id]),
    ...(newTags.length ? { new_tags: newTags } : {}),
  }
}

export function TransactionTags({ value, available }: { value: MetadataDraft; available: CatalogOut[] }) {
  return <div className="chips">{metadataTags(value, available).map(tag => <TagBadge key={tag.id ?? `new:${tag.name}`} tag={tag} />)}</div>
}

export function MetadataFields({ value, change, disabled = false }: {
  value: MetadataDraft; change: (value: MetadataDraft) => void; disabled?: boolean
}) {
  const { t } = useI18n()
  const categories = useCatalog('categories'), tags = useCatalog('tags')
  const [error, setError] = useState('')
  const available = tags.data || [], selected = metadataTags(value, available)
  function add(text: string): boolean {
    const selection = appendContactTag(selected, text, available)
    setError(selection.error || '')
    if (selection.error) return false
    change({ ...value, tags: selection.tags, tagInput: '' })
    return true
  }
  return <div className="metadata-fields">
    <label>{t('finance.metadata.category')}<select disabled={disabled} value={value.category_id ?? ''} onChange={event => change({ ...value, category_id: event.target.value ? Number(event.target.value) : null })}>
      <option value="">{t('finance.uncategorized')}</option>{categories.data?.map(category => <option key={category.id} value={category.id}>{category.name}</option>)}
    </select></label>
    <label>{t('finance.metadata.merchant')}<input disabled={disabled} maxLength={200} value={value.merchant || ''} onChange={event => change({ ...value, merchant: event.target.value })} /></label>
    <ContactTagPicker selected={selected} available={available} input={value.tagInput}
      changeInput={text => { change({ ...value, tagInput: text }); setError('') }} add={add}
      remove={index => { change({ ...value, tags: selected.filter((_, position) => position !== index) }); setError('') }}
      disabled={disabled || !tags.data || !!tags.error} error={error || undefined} />
    {(categories.error || tags.error) && <Notice error>{errorMessage(categories.error || tags.error)}</Notice>}
  </div>
}

export function TransactionDetail({ value, editable, close }: { value: TransactionOut; editable: boolean; close: () => void }) {
  const { t } = useI18n()
  const [metadata, setMetadata] = useState(() => metadataDraft(value))
  const action = useAction(), tags = useCatalog('tags')
  return <Modal title={t('finance.detail.title')} close={close} disabled={action.busy}>
    <p className="original">{value.description}</p>
    <dl className="details-grid"><dt>{t('finance.detail.bookingDate')}</dt><dd>{day(value.booking_date)}</dd><dt>{t('finance.detail.valueDate')}</dt><dd>{day(value.value_date)}</dd>
      <dt>{t('finance.detail.amount')}</dt><dd><Money value={value.amount} /></dd><dt>{t('finance.detail.balance')}</dt><dd><Money value={value.balance_after} /></dd><dt>{t('finance.detail.id')}</dt><dd>{value.id}</dd></dl>
    {editable && <form onSubmit={event => { event.preventDefault(); void action.run(async () => {
      await api(`/admin/transactions/${value.id}`, 'PATCH', { ...prepareMetadata(metadata, tags.data || []), version: value.version })
      close()
    }) }}>
      <MetadataFields value={metadata} change={setMetadata} disabled={action.busy} />{action.notice}<button disabled={action.busy}>{t('finance.detail.save')}</button>
    </form>}
  </Modal>
}
