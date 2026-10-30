import { useRef, useState, type FormEvent } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api, cache, clearPrivateData, errorMessage } from './api/client'
import type {
  AccountOut, AuthOut, CatalogOut, ConfirmIn, FeatureFlagIn, FeatureFlagsOut, GeneralSettings, ImportOut, PreviewOut,
  RowDecision, RuleImpact, RuleIn, RuleOut, UserAuthOut,
} from './api/schema.gen'
import { Modal, Notice, day, money, useAction, useCatalog, useFeatures, useGeneralSettings } from './shared'
import { MetadataFields, TransactionTags, metadataDraft, prepareMetadata, type MetadataDraft } from './transaction-metadata'
import { AuthCardHeader, useLoginNotice } from './auth'
import { Icon } from './icons'
import { formatNumber, useI18n } from './i18n'

function GeneralForm({ value, busy, save }: { value: string; busy: boolean; save: (name: string) => void }) {
  const { t } = useI18n()
  const [name, setName] = useState(value)
  return <form onSubmit={event => { event.preventDefault(); save(name) }}>
    <label>{t('admin.general.name')}<input required maxLength={150} value={name} onChange={event => setName(event.target.value)} disabled={busy} /></label>
    <p className="muted">{t('admin.general.nameHint')}</p>
    <button disabled={busy || !name.trim()}>{busy ? t('common.saving') : t('common.saveChanges')}</button>
  </form>
}

export function GeneralPage() {
  const { t } = useI18n()
  const query = useGeneralSettings()
  const action = useAction()
  return <><div className="page-heading"><div><p className="eyebrow">{t('admin.eyebrow')}</p><h1>{t('admin.general.title')}</h1><p className="muted">{t('admin.general.subtitle')}</p></div></div>
    <section className="card general-settings"><h2>{t('admin.general.section')}</h2>
      {query.isPending && <Notice>{t('admin.general.loading')}</Notice>}
      {query.error && <Notice error>{errorMessage(query.error)}</Notice>}
      {action.notice}
      {query.data && <GeneralForm key={query.data.community_name} value={query.data.community_name} busy={action.busy} save={name => void action.run(async () => {
        const result = await api<GeneralSettings>('/admin/settings/general', 'PATCH', { community_name: name })
        cache.setQueryData(['general-settings'], result)
      }, t('admin.general.saved'))} />}
    </section></>
}

const featureKeys = ['coefficient', 'actions', 'events'] as const

export function FeaturesPage() {
  const { t } = useI18n()
  const query = useFeatures(), action = useAction(false)
  return <div className="feature-flags"><div className="page-heading"><div><p className="eyebrow">{t('admin.eyebrow')}</p><h1>{t('admin.features.title')}</h1>
    <p className="muted">{t('admin.features.subtitle')}</p></div></div>
    {query.isPending && <Notice>{t('admin.features.loading')}</Notice>}
    {query.error && <><Notice error>{errorMessage(query.error)}</Notice><button type="button" className="secondary" disabled={query.isFetching} onClick={() => void query.refetch()}>{t('common.retryLoading')}</button></>}
    {action.notice}
    {action.busy && <Notice>{t('admin.features.saving')}</Notice>}
    {query.data && featureKeys.map(key => {
      const enabled = query.data[key]
      const label = t(`admin.features.${key}.label`)
      return <section key={key} className="card feature-flag" aria-labelledby={`feature-${key}`}>
        <div><h2 id={`feature-${key}`}>{label}</h2><p id={`feature-${key}-description`} className="muted">{t(`admin.features.${key}.description`)}</p></div>
        <button type="button" role="switch" className={enabled ? '' : 'secondary'} aria-checked={enabled}
          aria-labelledby={`feature-${key}`} aria-describedby={`feature-${key}-description`}
          disabled={action.busy || !!query.error} onClick={() => void action.run(async () => {
            const body: FeatureFlagIn = { enabled: !enabled }
            const saved = await api<FeatureFlagsOut>(`/admin/settings/features/${key}`, 'PATCH', body)
            await cache.cancelQueries({ queryKey: ['features'] })
            cache.setQueryData(['features'], saved)
          }, enabled ? t('admin.features.disabledNotice', { feature: label }) : t('admin.features.enabledNotice', { feature: label }))}>
          <Icon name={enabled ? 'check' : 'close'} />{enabled ? t('admin.features.enabled') : t('admin.features.disabled')}
        </button>
      </section>
    })}
    <p className="muted">{t('admin.features.footer')}</p>
  </div>
}

export function Login() {
  const { t } = useI18n()
  const [username, setUsername] = useState(''), [password, setPassword] = useState('')
  const action = useAction()
  const { setNotice } = useLoginNotice()
  return <section className="card login"><AuthCardHeader eyebrow={t('auth.admin.eyebrow')} /><h1>{t('auth.admin.title')}</h1><p className="muted">{t('auth.admin.help')}</p>
    <form onSubmit={event => { event.preventDefault(); void action.run(async () => {
      const result = await api<AuthOut>('/admin/auth/login', 'POST', { username, password })
      await clearPrivateData(true)
      const reader = await api<UserAuthOut>('/auth/session')
      cache.setQueryData(['reader-auth'], reader)
      setPassword(''); cache.setQueryData(['auth'], result)
      setNotice(null)
    }) }}>
      <label>{t('auth.admin.username')}<input autoComplete="username" required value={username} onChange={e => setUsername(e.target.value)} /></label>
      <label>{t('auth.password')}<input type="password" autoComplete="current-password" required value={password} onChange={e => setPassword(e.target.value)} /></label>
      {action.notice}<button disabled={action.busy}>{action.busy ? t('auth.admin.submitting') : t('auth.admin.submit')}</button>
    </form>
  </section>
}

function AccountName({ value }: { value: AccountOut }) {
  const { t } = useI18n()
  const [name, setName] = useState(value.name)
  const action = useAction()
  return <section className="card"><header><h2>{t('admin.account.title')}</h2><span className="tag">{t('admin.account.fixedIban')}</span></header>
    <p className="iban">{value.iban.match(/.{1,4}/g)?.join(' ')}</p>
    <form className="inline" onSubmit={e => { e.preventDefault(); void action.run(async () => {
      await api('/admin/account', 'PATCH', { name })
    }, t('admin.account.saved')) }}><label>{t('admin.account.name')}<input value={name} maxLength={150} required onChange={e => setName(e.target.value)} /></label><button className="secondary" disabled={action.busy}>{t('admin.account.save')}</button></form>{action.notice}
  </section>
}

type Draft = { metadata: MetadataDraft; manual: boolean; choice: string }
function draftsFor(preview: PreviewOut): Record<number, Draft> {
  return Object.fromEntries(preview.rows.map(row => [row.ordinal, {
    metadata: metadataDraft(row), manual: false, choice: '',
  }]))
}
function pendingSuggestions(preview: PreviewOut, excluded: number[] = []) {
  return preview.rows.filter(row => row.status !== 'duplicate' && !row.skip_ai && !row.ai_reviewed && !excluded.includes(row.ordinal))
}

function ImportReview({ preview, update, complete, action, suggest, retry, continueManually, close, aiError, aiBypassed }: {
  preview: PreviewOut; update: (value: PreviewOut) => void; complete: (value: ImportOut) => void
  action: ReturnType<typeof useAction>
  suggest: (value: PreviewOut, excluded?: number[]) => Promise<void>
  retry: (excluded: number[]) => Promise<void>
  continueManually: () => Promise<void>
  close: () => void
  aiError: string; aiBypassed: boolean
}) {
  const { t } = useI18n()
  const categories = useCatalog('categories'), tags = useCatalog('tags')
  const [confirmed, setConfirmed] = useState(false)
  const [drafts, setDrafts] = useState(() => draftsFor(preview))
  const [seenVersion, setSeenVersion] = useState(preview.version)
  const [page, setPage] = useState(0)
  if (seenVersion !== preview.version) {
    setSeenVersion(preview.version)
    const next = draftsFor(preview)
    for (const row of preview.rows) {
      const old = drafts[row.ordinal]
      if (old) next[row.ordinal] = { ...next[row.ordinal], choice: old.choice, ...(old.manual ? { metadata: old.metadata, manual: true } : {}) }
    }
    setDrafts(next)
  }
  const unresolved = preview.rows.filter(row => row.status === 'review' && !drafts[row.ordinal]?.choice).length
  const excluded = preview.rows.filter(row => drafts[row.ordinal]?.manual || drafts[row.ordinal]?.choice.startsWith('existing:')).map(row => row.ordinal)
  async function save() {
    const decisions: RowDecision[] = []
    for (const row of preview.rows) {
      const draft = drafts[row.ordinal]
      if (row.status === 'duplicate') continue
      decisions.push({
        ordinal: row.ordinal,
        create_new: draft.choice === 'new',
        existing_id: draft.choice.startsWith('existing:') ? Number(draft.choice.split(':')[1]) : null,
        enrichment: draft.manual && !draft.choice.startsWith('existing:') ? prepareMetadata(draft.metadata, tags.data || []) : null,
      })
    }
    const body: ConfirmIn = { version: preview.version, decisions }
    return api<ImportOut>(`/admin/imports/${preview.id}/confirm`, 'POST', body)
  }
  async function submit() {
    let result: ImportOut | undefined
    await action.run(async () => { result = await save() })
    if (result) complete(result)
  }
  return <section className="import-review">
    <div className="import-review-summary"><p>{t('admin.import.review.summary', { filename: preview.filename, count: preview.rows.length })}</p><span className="tag">{t('admin.import.review.verified')}</span></div>
    <fieldset className="review-fields" disabled={action.busy}>
    <div className={`account-check${preview.account_confirmed ? ' account-check-confirmed' : ''}`}><strong>{t('admin.import.review.account')}</strong><p className="iban">{preview.iban.match(/.{1,4}/g)?.join(' ')}</p>
      {preview.account_confirmed ? <p className="income">{t('admin.import.review.accountConfirmed')}</p> : <>
        <Notice>{t('admin.import.review.accountDetected')}</Notice>
        <label className="check"><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />{t('admin.import.review.confirmIban')}</label>
        <button disabled={!confirmed || action.busy} onClick={() => void action.run(async () => {
          const next = await api<PreviewOut>(`/admin/imports/${preview.id}/account`, 'POST', { iban: preview.iban, version: preview.version })
          update(next); await suggest(next)
        })}>{t('admin.import.review.confirmAccount')}</button>
        {preview.ai_enabled && <small className="muted">{t('admin.import.review.aiAfterConfirm')}</small>}
      </>}
    </div>
    <p className="coverage">{[
      t('admin.import.review.period', { start: day(preview.rows.at(-1)?.booking_date || null), end: day(preview.rows[0]?.booking_date || null) }),
      t('admin.import.review.newRows', { count: preview.rows.filter(r => r.status === 'new').length }),
      t('admin.import.review.duplicateRows', { count: preview.rows.filter(r => r.status === 'duplicate').length }),
      t('admin.import.review.reviewRows', { count: preview.rows.filter(r => r.status === 'review').length }),
    ].join(' · ')}</p>
    {(categories.error || tags.error) && <Notice error>{errorMessage(categories.error || tags.error)}</Notice>}
    {preview.account_confirmed && <>
      {aiError && <div className="import-ai-error"><Notice error>{aiError}</Notice>
        <div className="inline"><button className="secondary" onClick={() => void action.run(() => retry(excluded))}>{t('admin.import.review.retrySuggestions')}</button>
          {!aiBypassed && <button className="secondary" onClick={() => void action.run(continueManually)}>{t('admin.import.review.continueManually')}</button>}</div>
        {aiBypassed && <Notice>{t('admin.import.review.bypassed')}</Notice>}
      </div>}
      {!preview.ai_enabled && <Notice>{t('admin.import.review.aiDisabled')}</Notice>}
      {preview.ai_enabled && !action.busy && !aiError && <p className="classification-status">{t('admin.import.review.aiReady', { count: preview.rows.filter(row => row.ai_reviewed).length })}</p>}
      <div className="table-scroll"><table><thead><tr><th>{t('admin.import.review.columns.description')}</th><th>{t('admin.import.review.columns.amount')}</th><th>{t('admin.import.review.columns.balance')}</th><th>{t('admin.import.review.columns.decision')}</th></tr></thead>
        <tbody>{preview.rows.slice(page * 30, (page + 1) * 30).map(row => {
          const draft = drafts[row.ordinal]
          const categoryId = draft.metadata.category_id
          return <tr key={row.ordinal}><td className="concept"><small>{t('admin.import.review.dates', { date: day(row.booking_date), valueDate: day(row.value_date) })}</small>{row.description}</td><td className="numeric">{money(row.amount)}</td><td className="numeric">{money(row.balance_after)}</td>
            <td><span className="tag">{t(`admin.import.review.status.${row.status}`)}</span>
              {row.matched_rule && <small>{t('admin.import.review.rule', { name: row.matched_rule })}</small>}{row.ai_reviewed && <small>{t('admin.import.review.aiSuggestion')}</small>}
              <div className="suggested-metadata">
                <span className="badge"><i style={{ background: categories.data?.find(item => item.id === categoryId)?.color || '#64748b' }} />
                  {categoryId == null ? t('finance.uncategorized') : categories.data?.find(item => item.id === categoryId)?.name || t('finance.categoryNumber', { id: categoryId })}</span>
                {draft.metadata.merchant && <small>{draft.metadata.merchant}</small>}
                <TransactionTags value={draft.metadata} available={tags.data || []} />
              </div>
              {row.status === 'review' && <label>{t('admin.import.review.resolve')}<select required value={draft.choice} onChange={e => setDrafts({ ...drafts, [row.ordinal]: { ...draft, choice: e.target.value } })}>
                <option value="">{t('admin.import.review.chooseDecision')}</option><option value="new">{t('admin.import.review.keepNew')}</option>{row.candidates.map(id => <option key={id} value={`existing:${id}`}>{t('admin.import.review.linkExisting', { id })}</option>)}
              </select></label>}
              {row.status !== 'duplicate' && !draft.choice.startsWith('existing:') && <details><summary>{t('admin.import.review.editClassification')}</summary><MetadataFields value={draft.metadata} disabled={action.busy} change={metadata => setDrafts({ ...drafts, [row.ordinal]: { ...draft, metadata, manual: true } })} /></details>}
              {(row.status === 'duplicate' || draft.choice.startsWith('existing:')) && <small>{t('admin.import.review.keepsClassification')}</small>}
            </td></tr>
        })}</tbody></table></div>
      <div className="pagination"><button className="secondary" disabled={!page} onClick={() => setPage(page - 1)}>{t('common.pagination.previous')}</button><span>{t('common.pagination.page', { page: page + 1, pages: Math.ceil(preview.rows.length / 30) })}</span><button className="secondary" disabled={(page + 1) * 30 >= preview.rows.length} onClick={() => setPage(page + 1)}>{t('common.pagination.next')}</button></div>
      {unresolved > 0 && <Notice>{t('admin.import.review.unresolved', { count: unresolved })}</Notice>}
    </>}
    </fieldset>
    <footer className="import-dialog-footer"><button className="secondary" disabled={action.busy} onClick={close}>{t('common.cancel')}</button>
      {preview.account_confirmed && <button disabled={action.busy || unresolved > 0 || Boolean(aiError && !aiBypassed)} onClick={() => void submit()}>{action.busy ? t('admin.import.review.processing') : t('admin.import.review.save')}</button>}
    </footer>
  </section>
}

export function ImportPage() {
  const { t } = useI18n()
  const account = useQuery({ queryKey: ['account'], queryFn: () => api<AccountOut | null>('/account') })
  const [preview, setPreview] = useState<PreviewOut | null>(null)
  const [result, setResult] = useState<ImportOut | null>(null)
  const [open, setOpen] = useState(false)
  const [filename, setFilename] = useState('')
  const [progress, setProgress] = useState('')
  const [aiError, setAiError] = useState('')
  const [aiBypassed, setAiBypassed] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const fileButton = useRef<HTMLButtonElement>(null)
  const action = useAction()
  async function suggest(value: PreviewOut, excluded: number[] = []) {
    setAiError(''); setAiBypassed(false)
    if (!value.account_confirmed || !value.ai_enabled) return
    let current = value
    const total = pendingSuggestions(current, excluded).length
    try {
      if (current.ai_in_progress) throw new Error(t('admin.import.errors.aiBusyRetry'))
      while (pendingSuggestions(current, excluded).length) {
        const remaining = pendingSuggestions(current, excluded).length
        setProgress(t('admin.import.processing.suggesting', { done: formatNumber(total - remaining), count: total }))
        const next = await api<PreviewOut>(`/admin/imports/${current.id}/ai`, 'POST', { version: current.version, exclude_ordinals: excluded })
        setPreview(next)
        if (pendingSuggestions(next, excluded).length >= remaining) throw new Error(t('admin.import.errors.aiIncomplete'))
        current = next
      }
    } catch (error) {
      setAiError(errorMessage(error))
    } finally {
      setProgress('')
    }
  }
  async function refreshPreview() {
    if (!preview) throw new Error(t('admin.import.errors.noPreview'))
    const current = await api<PreviewOut>(`/admin/imports/${preview.id}`)
    setPreview(current)
    if (current.ai_in_progress) throw new Error(t('admin.import.errors.aiBusyContinue'))
    return current
  }
  function close() {
    if (!preview || window.confirm(t('admin.import.discard'))) {
      setOpen(false); setPreview(null); setProgress('')
    }
  }
  function selectFile(file: File) {
    setFilename(file.name); setPreview(null); setResult(null); setAiError(''); setAiBypassed(false); setOpen(true)
    void action.run(async () => {
      setProgress(t('admin.import.processing.reading'))
      try {
        const data = new FormData(); data.append('file', file)
        const next = await api<PreviewOut>('/admin/imports/preview', 'POST', data)
        setPreview(next)
        await suggest(next)
      } finally { setProgress('') }
    })
  }
  return <><div className="page-heading"><div><p className="eyebrow">{t('admin.eyebrow')}</p><h1>{t('admin.import.title')}</h1><p className="muted">{t('admin.import.subtitle')}</p></div></div>
    {account.error && <Notice error>{errorMessage(account.error)}</Notice>}
    {account.data && <AccountName key={account.data.name} value={account.data} />}
    <section className="card upload"><h2>{t('admin.import.upload.title')}</h2><p>{t('admin.import.upload.help')}</p>
      <div className="file-picker"><button ref={fileButton} type="button" disabled={action.busy} onClick={() => fileInput.current?.click()}>{t('admin.import.upload.select')}</button><span className="muted">{filename || t('admin.import.upload.noFile')}</span></div>
      <input ref={fileInput} type="file" hidden aria-label={t('admin.import.upload.input')} accept=".pdf,application/pdf" disabled={action.busy} onChange={event => {
        const file = event.target.files?.[0]
        if (file) selectFile(file)
        event.target.value = ''
      }} />
      <small className="muted">{t('admin.import.upload.privacy')}</small>
    </section>
    {result && <Notice>{t('admin.import.confirmed', { count: result.inserted, duplicates: formatNumber(result.duplicates) })}</Notice>}
    {open && <Modal title={t('admin.import.dialog')} className="import-dialog" disabled={action.busy} close={close} restoreFocusRef={fileButton}>
      <div className="import-dialog-content">
        {action.busy && <section className="import-processing" role="status" aria-live="polite" aria-atomic="true">
          <Icon name="spinner" size={44} className="loading-spinner icon-spin" />
          <h3>{t('admin.import.processing.title')}</h3>
          <p>{progress || t('admin.import.processing.updating')}</p>
          <small className="muted">{t('admin.import.processing.wait')}</small>
        </section>}
        <div className="import-review-controls" hidden={action.busy} inert={action.busy} aria-busy={action.busy}>
          {action.notice}
          {!preview && <p className="muted">{filename}</p>}
          {preview && <ImportReview key={preview.id} preview={preview} update={setPreview} action={action}
            suggest={suggest} retry={async excluded => suggest(await refreshPreview(), excluded)}
            continueManually={async () => { await refreshPreview(); setAiBypassed(true) }}
            close={close} aiError={aiError} aiBypassed={aiBypassed}
            complete={value => { setResult(value); setPreview(null); setOpen(false) }} />}
        </div>
      </div>
    </Modal>}
  </>
}

function CatalogEditor({ kind, item }: { kind: 'categories' | 'tags'; item?: CatalogOut }) {
  const { t } = useI18n()
  const [name, setName] = useState(item?.name || ''), [color, setColor] = useState(item?.color || '#21639f')
  const action = useAction()
  return <form className="catalog-editor" onSubmit={e => { e.preventDefault(); void action.run(async () => {
    await api(`/admin/catalog/${kind}${item ? `/${item.id}` : ''}`, item ? 'PATCH' : 'POST', { name, color })
    if (!item) setName('')
  }, t('admin.catalog.saved')) }}>
    <label>{item ? t('admin.catalog.name') : kind === 'categories' ? t('admin.catalog.newCategory') : t('admin.catalog.newTag')}<input required maxLength={100} value={name} onChange={e => setName(e.target.value)} /></label>
    <label>{t('admin.catalog.color')}<input type="color" value={color} onChange={e => setColor(e.target.value)} /></label><button className="secondary" disabled={action.busy}>{item ? t('common.save') : t('admin.catalog.create')}</button>
    {item && <button type="button" className="quiet danger" disabled={action.busy} onClick={() => {
      if (window.confirm(t('admin.catalog.confirmDelete', { name: item.name }))) void action.run(async () => { await api(`/admin/catalog/${kind}/${item.id}`, 'DELETE') })
    }}>{t('common.delete')}</button>}{action.notice}
  </form>
}
export function CatalogPage() {
  const { t } = useI18n()
  const categories = useCatalog('categories'), tags = useCatalog('tags')
  return <><h1>{t('admin.catalog.title')}</h1><div className="dashboard-grid">{(['categories', 'tags'] as const).map(kind => {
    const query = kind === 'categories' ? categories : tags
    return <section className="card" key={kind}><h2>{kind === 'categories' ? t('admin.catalog.categories') : t('admin.catalog.tags')}</h2><CatalogEditor kind={kind} />
      {query.error && <Notice error>{errorMessage(query.error)}</Notice>}{query.data?.map(item => <CatalogEditor key={`${item.id}:${item.name}:${item.color}`} kind={kind} item={item} />)}
    </section>
  })}</div></>
}

function RuleEditor({ item }: { item?: RuleOut }) {
  const defaults: RuleIn = item ? {
    name: item.name, priority: item.priority, enabled: item.enabled,
    description_mode: item.description_mode, description_value: item.description_value,
    detail_mode: item.detail_mode, detail_value: item.detail_value, amount_sign: item.amount_sign,
    amount_min: item.amount_min, amount_max: item.amount_max, account_ref: item.account_ref, currency: item.currency,
    set_category: item.set_category, set_merchant: item.set_merchant, add_tags: item.add_tags, skip_ai: item.skip_ai,
  } : { name: '', priority: 100, enabled: true, description_mode: 'contains', description_value: '', skip_ai: true, add_tags: [] }
  const [rule, setRule] = useState<RuleIn>(defaults)
  const [impact, setImpact] = useState<RuleImpact | null>(null)
  const { t } = useI18n()
  const action = useAction(), categories = useCatalog('categories'), tags = useCatalog('tags')
  function change(update: Partial<RuleIn>) { setRule({ ...rule, ...update }); setImpact(null) }
  function submit(event: FormEvent) { event.preventDefault(); void action.run(async () => {
    await api(`/admin/rules${item ? `/${item.id}` : ''}`, item ? 'PUT' : 'POST', rule)
    if (!item) setRule(defaults)
  }, t('admin.rules.saved')) }
  return <section className="card rule-editor"><h2>{item ? item.name : t('admin.rules.create')}</h2><form onSubmit={submit}>
    <div className="form-grid"><label>{t('admin.rules.name')}<input required maxLength={100} value={rule.name} onChange={e => change({ name: e.target.value })} /></label>
      <label>{t('admin.rules.priority')}<input type="number" min={0} max={100000} required value={rule.priority ?? 100} onChange={e => change({ priority: Number(e.target.value) })} /></label>
      <label>{t('admin.rules.matchType')}<select value={rule.description_mode} onChange={e => change({ description_mode: e.target.value as RuleIn['description_mode'] })}>
        <option value="contains">{t('admin.rules.contains')}</option><option value="starts_with">{t('admin.rules.startsWith')}</option><option value="exact">{t('admin.rules.exactMatch')}</option><option value="regex">{t('admin.rules.regex')}</option>
      </select></label><label>{t('admin.rules.description')}<input required maxLength={300} value={rule.description_value} onChange={e => change({ description_value: e.target.value })} /></label>
      <label>{t('admin.rules.amountType')}<select value={rule.amount_sign || ''} onChange={e => change({ amount_sign: e.target.value === 'positive' ? 'positive' : e.target.value === 'negative' ? 'negative' : null })}><option value="">{t('admin.rules.anyAmount')}</option><option value="positive">{t('admin.rules.income')}</option><option value="negative">{t('admin.rules.expense')}</option></select></label>
      <label>{t('admin.rules.minimum')}<input inputMode="decimal" value={rule.amount_min ?? ''} onChange={e => change({ amount_min: e.target.value.replace(',', '.') || null })} /></label>
      <label>{t('admin.rules.maximum')}<input inputMode="decimal" value={rule.amount_max ?? ''} onChange={e => change({ amount_max: e.target.value.replace(',', '.') || null })} /></label>
      <label>{t('admin.rules.setCategory')}<select value={rule.set_category ?? ''} onChange={e => change({ set_category: e.target.value ? Number(e.target.value) : null })}><option value="">{t('admin.rules.keepCategory')}</option>{categories.data?.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
      <label>{t('admin.rules.setMerchant')}<input value={rule.set_merchant ?? ''} maxLength={200} onChange={e => change({ set_merchant: e.target.value || null })} /></label>
    </div><fieldset><legend>{t('admin.rules.addTags')}</legend><div className="chips">{tags.data?.map(tag => <label className="check" key={tag.id}><input type="checkbox" checked={rule.add_tags?.includes(tag.id) || false} onChange={e => change({ add_tags: e.target.checked ? [...rule.add_tags || [], tag.id] : rule.add_tags?.filter(id => id !== tag.id) })} />{tag.name}</label>)}</div></fieldset>
    <details><summary>{t('admin.rules.moreConditions')}</summary><div className="form-grid">
      <label>{t('admin.rules.iban')}<input value={rule.account_ref || ''} onChange={e => change({ account_ref: e.target.value || null })} /></label>
      <label>{t('admin.rules.detail')}<select value={rule.detail_mode || ''} onChange={e => change({ detail_mode: e.target.value ? e.target.value as RuleIn['detail_mode'] : null, detail_value: e.target.value ? rule.detail_value || '' : null })}><option value="">{t('admin.rules.noCondition')}</option><option value="contains">{t('admin.rules.contains')}</option><option value="starts_with">{t('admin.rules.startsWith')}</option><option value="exact">{t('admin.rules.matches')}</option><option value="regex">{t('admin.rules.regex')}</option></select></label>
      {rule.detail_mode && <label>{t('admin.rules.detailText')}<input required value={rule.detail_value || ''} onChange={e => change({ detail_value: e.target.value })} /></label>}
      <p className="muted">{t('admin.rules.detailHelp')}</p>
    </div></details>
    <div className="inline"><label className="check"><input type="checkbox" checked={rule.enabled ?? true} onChange={e => change({ enabled: e.target.checked })} />{t('admin.rules.enabled')}</label><label className="check"><input type="checkbox" checked={rule.skip_ai ?? true} onChange={e => change({ skip_ai: e.target.checked })} />{t('admin.rules.skipAi')}</label></div>
    {action.notice}<div className="inline"><button disabled={action.busy}>{t('admin.rules.save')}</button><button type="button" className="secondary" disabled={action.busy} onClick={() => void action.run(async () => setImpact(await api<RuleImpact>('/admin/rules/preview', 'POST', rule)))}>{t('admin.rules.preview')}</button>
      {item && <button type="button" className="quiet danger" disabled={action.busy} onClick={() => {
        if (window.confirm(t('admin.rules.confirmDelete', { name: item.name }))) void action.run(async () => { await api(`/admin/rules/${item.id}`, 'DELETE') })
      }}>{t('admin.rules.delete')}</button>}</div>
    {impact && <div className="notice"><p>{t('admin.rules.impact', { count: impact.count })}</p>
      <ul>{impact.sample.map(row => <li key={row.id}>{day(row.booking_date)} · {row.description} · {money(row.amount)}</li>)}</ul>
      <button type="button" disabled={action.busy || !impact.count} onClick={() => void action.run(async () => {
        await api('/admin/rules/apply', 'POST', { revision: impact.revision, rule }); setImpact(null)
      }, t('admin.rules.applied'))}>{t('admin.rules.apply', { count: impact.count })}</button>
    </div>}
  </form></section>
}
export function RulesPage() {
  const { t } = useI18n()
  const query = useQuery({ queryKey: ['admin', 'rules'], queryFn: () => api<RuleOut[]>('/admin/rules') })
  return <><h1>{t('admin.rules.title')}</h1><p className="coverage">{t('admin.rules.help')}</p>
    {query.error && <Notice error>{errorMessage(query.error)}</Notice>}<RuleEditor />{query.data?.map(rule => <RuleEditor key={JSON.stringify(rule)} item={rule} />)}
  </>
}
