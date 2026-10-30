import { useId, useRef, useState, type ReactNode, type RefObject } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, useSearchParams } from 'react-router'
import { ApiError, api, codeMessage, errorMessage } from './api/client'
import { ContactActions } from './contact-actions'
import { ContactTagPicker, Tags, appendContactTag, type ContactTagChoice } from './contact-tags'
import { useI18n } from './i18n'
import { Icon } from './icons'
import type { ContactEventOut, ContactHistoryPage, ContactOut, ContactPage, ContactSnapshot, ContactTagIn, ContactTagOut } from './api/schema.gen'
import { EmailContact, Modal, Notice, Pagination, PhoneField, PhoneLink, RequiredMark, authorName, connectionTime, focusFormField, hasControlCharacters, phoneValidationMessage, useAction } from './shared'

export { tagTextColor } from './contact-tags'
const sortFields = {
  name: 'contacts.fields.name', company: 'contacts.fields.company', email: 'contacts.fields.email',
  phone: 'contacts.fields.phone', tags: 'contacts.fields.tags', notes: 'contacts.fields.notes',
  created_at: 'contacts.fields.createdAt', updated_at: 'contacts.fields.updatedAt',
} as const
type Sort = keyof typeof sortFields
function isSort(value: string): value is Sort { return Object.hasOwn(sortFields, value) }
const tableFields: Sort[] = ['name', 'company', 'email', 'phone', 'tags']
type Draft = { name: string; company: string; email: string; phone: string; notes: string; tags: ContactTagChoice[] }
type ContactErrors = Partial<Record<keyof Draft, string>>
const draftFields: (keyof Draft)[] = ['name', 'company', 'email', 'phone', 'tags', 'notes']

export function validateContactDraft(draft: Draft): ContactErrors {
  const errors: ContactErrors = {}
  if (!draft.name.trim() || draft.name.length > 150 || hasControlCharacters(draft.name)) errors.name = codeMessage('contact_name_invalid')
  if (draft.company.length > 150 || hasControlCharacters(draft.company)) errors.company = codeMessage('contact_company_invalid')
  const email = draft.email.trim()
  if (email && (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) errors.email = codeMessage('contact_email_invalid')
  if (phoneValidationMessage(draft.phone)) errors.phone = codeMessage('contact_phone_invalid')
  if (!email && !draft.phone.trim()) errors.email = errors.phone = codeMessage('contact_channel_required')
  if (draft.tags.length > 30) errors.tags = codeMessage('contact_tags_invalid')
  if (draft.notes.length > 20000 || hasControlCharacters(draft.notes.replace(/[\r\n\t]/g, ''))) errors.notes = codeMessage('contact_notes_invalid')
  return errors
}

function responseErrors(error: unknown): ContactErrors {
  const result: ContactErrors = {}
  if (error instanceof ApiError) {
    for (const field of draftFields) if (error.fields[field]) result[field] = codeMessage(error.fields[field])
  }
  return result
}

function draftFor(value?: ContactOut | null): Draft {
  return {
    name: value?.name || '', company: value?.company || '', email: value?.email || '',
    phone: value?.phone || '', notes: value?.notes || '',
    tags: value?.tags.map(tag => ({ id: tag.id, name: tag.name, color: tag.color })) || [],
  }
}

export function rebaseContactDraft(draft: Draft, base: ContactOut, current: ContactOut): Draft {
  const old = draftFor(base), next = draftFor(current)
  const identities = (tags: ContactTagChoice[]) => tags.map(tag => tag.id === null ? `new:${tag.name}:${tag.color}` : `id:${tag.id}`).sort()
  return {
    name: draft.name === old.name ? next.name : draft.name,
    company: draft.company === old.company ? next.company : draft.company,
    email: draft.email === old.email ? next.email : draft.email,
    phone: draft.phone === old.phone ? next.phone : draft.phone,
    notes: draft.notes === old.notes ? next.notes : draft.notes,
    tags: JSON.stringify(identities(draft.tags)) === JSON.stringify(identities(old.tags)) ? next.tags : draft.tags,
  }
}

function useTags() {
  return useQuery({ queryKey: ['contacts', 'tags'], queryFn: () => api<ContactTagOut[]>('/contact-tags') })
}
function ContactTime({ value }: { value: string }) {
  return <time dateTime={value}>{connectionTime(value)}</time>
}
function ContactDetails({ value, close }: { value: ContactOut; close: () => void }) {
  const { t } = useI18n()
  return <Modal title={value.name} close={close} className="contact-modal contact-details">
    <div className="inline contact-detail-actions">
      {value.email
        ? <a className="button secondary icon-button" href={`mailto:${encodeURIComponent(value.email)}`} aria-label={t('contacts.details.sendEmail', { name: value.name })} title={t('contacts.details.sendEmailTitle')}><Icon name="mail" /></a>
        : <button type="button" className="secondary icon-button" disabled aria-label={t('contacts.details.emailUnavailable')} title={t('contacts.missing.email')}><Icon name="mail" /></button>}
      {value.phone
        ? <a className="button secondary icon-button" href={`tel:${value.phone}`} aria-label={t('contacts.details.call', { name: value.name })} title={t('contacts.details.callTitle')}><Icon name="phone" /></a>
        : <button type="button" className="secondary icon-button" disabled aria-label={t('contacts.details.phoneUnavailable')} title={t('contacts.missing.phone')}><Icon name="phone" /></button>}
    </div>
    <dl className="profile-details">
      <dt>{t('contacts.fields.company')}</dt><dd>{value.company || t('contacts.missing.value')}</dd>
      <dt>{t('contacts.fields.emailAddress')}</dt><dd>{value.email || t('contacts.missing.value')}</dd>
      <dt>{t('contacts.fields.phone')}</dt><dd>{value.phone || t('contacts.missing.value')}</dd>
      <dt>{t('contacts.fields.tags')}</dt><dd><Tags tags={value.tags} /></dd>
      <dt>{t('contacts.fields.notes')}</dt><dd className="contact-notes">{value.notes || t('contacts.missing.notes')}</dd>
      <dt>{t('contacts.fields.createdAt')}</dt><dd><ContactTime value={value.created_at} /></dd>
      <dt>{t('contacts.fields.updatedAt')}</dt><dd><ContactTime value={value.updated_at} /></dd>
      {value.deleted_at && <><dt>{t('contacts.fields.deletedAt')}</dt><dd><ContactTime value={value.deleted_at} /></dd></>}
    </dl>
  </Modal>
}
function isStale(error: unknown) { return error instanceof ApiError && error.code === 'contact_stale' }

function ContactForm({ value, close }: { value: ContactOut | null; close: () => void }) {
  const { t } = useI18n()
  const [base, setBase] = useState(value), [draft, setDraft] = useState(() => draftFor(value))
  const [current, setCurrent] = useState<ContactOut | null>(null)
  const [errors, setErrors] = useState<ContactErrors>({})
  const [validated, setValidated] = useState(false)
  const [tagInput, setTagInput] = useState('')
  const tags = useTags(), action = useAction(['contacts'])
  const available = tags.data || value?.tags || []
  const formId = useId()
  const stale = isStale(action.failure)
  function text(field: 'name' | 'company' | 'email' | 'phone' | 'notes', value: string) {
    const next = { ...draft, [field]: value }
    setDraft(next)
    setErrors(previous => {
      const result = { ...previous }
      const local = validated ? validateContactDraft(next) : {}
      result[field] = local[field]
      if (field === 'email' || field === 'phone') { result.email = local.email; result.phone = local.phone }
      return result
    })
  }
  function addTag(text: string): boolean {
    const result = appendContactTag(draft.tags, text, available)
    setErrors(previous => ({ ...previous, tags: result.error }))
    if (result.error) return false
    setDraft(previous => ({ ...previous, tags: result.tags }))
    setTagInput('')
    return true
  }
  return <Modal title={value ? t('contacts.form.editTitle') : t('contacts.form.newTitle')} close={close} disabled={action.busy} className="contact-modal">
    <form className="contact-form" noValidate onSubmit={event => {
      event.preventDefault()
      if (action.busy || stale) return
      const form = event.currentTarget, selection = appendContactTag(draft.tags, tagInput, available)
      const candidate = { ...draft, tags: selection.tags }
      const invalid = validateContactDraft(candidate)
      if (selection.error) invalid.tags = selection.error
      setValidated(true); setErrors(invalid); action.reset()
      const first = draftFields.find(field => invalid[field])
      if (first) { focusFormField(form, first); return }
      setDraft(candidate); setTagInput('')
      void action.run(async () => {
        const newTags = candidate.tags.filter(tag => tag.id === null).map(tag => ({ name: tag.name, color: tag.color }))
        const body = {
          ...candidate, email: candidate.email.trim() || null,
          tags: candidate.tags.flatMap(tag => tag.id === null ? [] : [tag.id]),
          ...(newTags.length ? { new_tags: newTags } : {}), ...(base ? { version: base.version } : {}),
        }
        try {
          await api(base ? `/contacts/${base.id}` : '/contacts', base ? 'PATCH' : 'POST', body)
          close()
        } catch (cause) {
          const invalid = responseErrors(cause)
          setErrors(invalid)
          const first = draftFields.find(field => invalid[field])
          if (first) requestAnimationFrame(() => focusFormField(form, first))
          throw cause
        }
      })
    }}>
      <div className="form-grid">
        <div className="form-field"><label htmlFor={`${formId}-name`}><span>{t('contacts.fields.name')} <RequiredMark /></span></label>
          <input id={`${formId}-name`} name="name" autoFocus required maxLength={150} value={draft.name} disabled={action.busy} aria-invalid={!!errors.name || undefined} aria-describedby={errors.name ? `${formId}-name-error` : undefined} onChange={event => text('name', event.target.value)} />
          {errors.name && <Notice id={`${formId}-name-error`} error>{errors.name}</Notice>}</div>
        <div className="form-field"><label htmlFor={`${formId}-company`}>{t('contacts.fields.company')}</label>
          <input id={`${formId}-company`} name="company" maxLength={150} value={draft.company} disabled={action.busy} aria-invalid={!!errors.company || undefined} aria-describedby={errors.company ? `${formId}-company-error` : undefined} onChange={event => text('company', event.target.value)} />
          {errors.company && <Notice id={`${formId}-company-error`} error>{errors.company}</Notice>}</div>
        <div className="form-field"><label htmlFor={`${formId}-email`}><span>{t('contacts.fields.emailAddress')} {!draft.phone.trim() && <RequiredMark />}</span></label>
          <input id={`${formId}-email`} name="email" type="email" autoComplete="off" maxLength={254} value={draft.email} required={!draft.phone.trim()} disabled={action.busy} aria-invalid={!!errors.email || undefined} aria-describedby={errors.email ? `${formId}-email-error` : undefined} onChange={event => text('email', event.target.value)} />
          {errors.email && <Notice id={`${formId}-email-error`} error>{errors.email}</Notice>}</div>
        <PhoneField name="phone" value={draft.phone} change={value => text('phone', value)} disabled={action.busy} autoComplete="off" showHint={false} required={!draft.email.trim()} error={errors.phone} />
      </div>
      {tags.isPending && <Notice>{t('contacts.form.loadingTags')}</Notice>}
      {tags.error && <Notice error>{errorMessage(tags.error)}</Notice>}
      <ContactTagPicker selected={draft.tags} available={available} input={tagInput}
        changeInput={text => { setTagInput(text); setErrors(previous => ({ ...previous, tags: undefined })) }}
        add={addTag} remove={index => {
          setDraft(previous => ({ ...previous, tags: previous.tags.filter((_, position) => position !== index) }))
          setErrors(previous => ({ ...previous, tags: undefined }))
        }} disabled={action.busy || tags.isPending || !!tags.error} error={errors.tags} />
      <div className="contact-notes-field"><label htmlFor={`${formId}-notes`}>{t('contacts.fields.notes')}</label>
        <textarea id={`${formId}-notes`} name="notes" maxLength={20000} value={draft.notes} disabled={action.busy} aria-invalid={!!errors.notes || undefined} aria-describedby={errors.notes ? `${formId}-notes-error` : undefined} onChange={event => text('notes', event.target.value)} />
        {errors.notes && <Notice id={`${formId}-notes-error`} error>{errors.notes}</Notice>}</div>
      {current && <details open><summary>{t('contacts.form.currentVersion', { name: current.name })}</summary>
        <p>{t('contacts.form.currentVersionHelp')}</p>
        <dl className="profile-details"><dt>{t('contacts.fields.name')}</dt><dd>{current.name}</dd><dt>{t('contacts.fields.company')}</dt><dd>{current.company || t('contacts.missing.value')}</dd>
          <dt>{t('contacts.fields.email')}</dt><dd>{current.email || t('contacts.missing.value')}</dd><dt>{t('contacts.fields.phone')}</dt><dd>{current.phone || t('contacts.missing.value')}</dd>
          <dt>{t('contacts.fields.tags')}</dt><dd><Tags tags={current.tags} /></dd><dt>{t('contacts.fields.notes')}</dt><dd className="contact-notes">{current.notes || t('contacts.missing.notes')}</dd></dl>
      </details>}
      {!draftFields.some(field => errors[field]) && action.notice}
      {stale && base && <button type="button" className="secondary" disabled={action.busy} onClick={() => void action.run(async () => {
        const latest = await api<ContactOut>(`/contacts/${base.id}`)
        setDraft(previous => rebaseContactDraft(previous, base, latest))
        setBase(latest); setCurrent(latest)
      })}>{t('contacts.form.reloadCurrent')}</button>}
      <div className="inline"><button disabled={action.busy || tags.isPending || !!tags.error || stale}>{action.busy ? t('common.saving') : t('contacts.form.save')}</button>
        <button type="button" className="secondary" disabled={action.busy} onClick={close}>{t('common.cancel')}</button></div>
    </form>
  </Modal>
}

function DeleteContact({ value, close, restoreFocusRef }: {
  value: ContactOut; close: () => void; restoreFocusRef: RefObject<HTMLButtonElement | null>
}) {
  const { t, rich } = useI18n()
  const [current, setCurrent] = useState(value)
  const action = useAction(['contacts']), stale = isStale(action.failure)
  return <Modal title={t('contacts.remove.title')} close={close} disabled={action.busy} restoreFocusRef={restoreFocusRef}>
    <p>{rich('contacts.remove.warning', { strong: chunks => <strong>{chunks}</strong> }, { name: current.name })}</p>
    <p>{current.company} {current.email} {current.phone}</p>
    <p className="contact-notes">{current.notes}</p>
    <Tags tags={current.tags} />
    <p>{t('contacts.remove.retention')}</p>
    {action.notice}
    {stale && <button type="button" className="secondary" disabled={action.busy} onClick={() => void action.run(async () => {
      setCurrent(await api<ContactOut>(`/contacts/${value.id}`))
    }, t('contacts.remove.reloaded'))}>{t('contacts.remove.reloadCurrent')}</button>}
    <div className="inline"><button type="button" className="secondary danger" disabled={action.busy || stale} onClick={() => void action.run(async () => {
      await api(`/contacts/${current.id}`, 'DELETE', { version: current.version }); close()
    })}>{t('contacts.remove.confirm')}</button><button type="button" className="secondary" disabled={action.busy} onClick={close}>{t('common.cancel')}</button></div>
  </Modal>
}

type HistoryValue = string | ContactTagOut[]
const historyFieldNames = {
  name: 'contacts.fields.name', company: 'contacts.fields.company', email: 'contacts.fields.email',
  phone: 'contacts.fields.phone', notes: 'contacts.fields.notes', tags: 'contacts.fields.tags',
  color: 'contacts.fields.color',
} as const
type HistoryField = keyof typeof historyFieldNames
const historyFieldOrder = Object.keys(historyFieldNames) as HistoryField[]
function historyFields(value: ContactSnapshot | ContactTagIn | null): Partial<Record<HistoryField, HistoryValue>> {
  if (!value) return {}
  if ('tags' in value) return {
    name: value.name, company: value.company, email: value.email || '',
    phone: value.phone, notes: value.notes, tags: value.tags,
  }
  return { name: value.name, color: value.color }
}
function HistoricalValue({ value }: { value: HistoryValue | undefined }) {
  const { t } = useI18n()
  return Array.isArray(value) ? <Tags tags={value} /> : <span className="contact-notes">{value || t('contacts.missing.value')}</span>
}
function EventDetails({ event }: { event: ContactEventOut }) {
  const { t } = useI18n()
  const before = historyFields(event.before), after = historyFields(event.after)
  const changed = historyFieldOrder.filter(key => JSON.stringify(before[key]) !== JSON.stringify(after[key]))
  return <div className="table-scroll"><table className="contact-diff">
    <caption className="sr-only">{t('contacts.history.changes', { name: event.name })}</caption>
    <thead><tr><th scope="col">{t('contacts.history.field')}</th><th scope="col">{t('contacts.history.before')}</th><th scope="col">{t('contacts.history.after')}</th></tr></thead>
    <tbody>{changed.map(field => <tr key={field}><th scope="row">{t(historyFieldNames[field])}</th>
      <td><HistoricalValue value={before[field]} /></td><td><HistoricalValue value={after[field]} /></td></tr>)}</tbody>
  </table></div>
}

function ContactHistory({ contact, close }: { contact: ContactOut; close: () => void }) {
  const { t } = useI18n()
  const [page, setPage] = useState(1)
  const params = new URLSearchParams({ page: String(page), contact_id: String(contact.id) })
  const query = useQuery({
    queryKey: ['contacts', 'history', params.toString()],
    queryFn: () => api<ContactHistoryPage>(`/contact-history?${params}`),
  })
  return <Modal title={t('contacts.history.title', { name: contact.name })} close={close} className="contact-modal">
    <p className="muted">{t('contacts.history.description')}</p>
    {query.isPending && <Notice>{t('contacts.history.loading')}</Notice>}
    {query.error && <Notice error>{errorMessage(query.error)}</Notice>}
    {query.data?.total === 0 && <p className="empty">{t('contacts.history.empty')}</p>}
    <ol className="contact-events">{query.data?.items.map(event => <li key={event.id}>
      <header><strong>{t(`contacts.history.events.${event.target}.${event.kind}`, { name: event.name })}</strong>
        <span>{authorName(event.author, t)}</span>
        <ContactTime value={event.created_at} /></header>
      <EventDetails event={event} />
    </li>)}</ol>
    {query.data && <Pagination page={page} pages={query.data.pages} change={setPage} busy={query.isFetching} label={t('contacts.history.pagination')} />}
  </Modal>
}

export function ContactsPage({ deleted = false }: { deleted?: boolean }) {
  const { t } = useI18n()
  const [params, setParams] = useSearchParams()
  const q = params.get('q') || '', rawSort = params.get('sort') || 'name'
  const sort: Sort = isSort(rawSort) ? rawSort : 'name'
  const direction = params.get('direction') === 'desc' ? 'desc' : 'asc'
  const rawPage = Number(params.get('page') || '1')
  const page = Number.isInteger(rawPage) && rawPage >= 1 && rawPage <= 1000000 ? rawPage : 1
  const endpoint = deleted ? '/admin/contacts/deleted' : '/contacts'
  const request = new URLSearchParams({ q, sort, direction, page: String(page) })
  const query = useQuery({
    queryKey: ['contacts', 'list', endpoint, request.toString()],
    queryFn: () => api<ContactPage>(`${endpoint}?${request}`),
  })
  const [editor, setEditor] = useState<{ value: ContactOut | null } | null>(null)
  const [deleting, setDeleting] = useState<ContactOut | null>(null)
  const [history, setHistory] = useState<ContactOut | null>(null)
  const [details, setDetails] = useState<ContactOut | null>(null)
  const createButton = useRef<HTMLButtonElement>(null)
  function filter(changes: Record<string, string>) {
    const next = new URLSearchParams(params)
    Object.entries(changes).forEach(([key, value]) => value ? next.set(key, value) : next.delete(key))
    if (!('page' in changes)) next.delete('page')
    setParams(next, { replace: true })
  }
  function cell(value: ContactOut, field: Sort): ReactNode {
    if (field === 'name') return <button type="button" className="quiet contact-name" aria-label={t('contacts.viewDetails', { name: value.name })} onClick={() => setDetails(value)}>{value.name}</button>
    if (field === 'email') return value.email ? <EmailContact key={value.email} email={value.email} name={value.name} /> : <span className="muted">{t('contacts.missing.email')}</span>
    if (field === 'phone') return <PhoneLink phone={value.phone} name={value.name} />
    if (field === 'tags') return <Tags tags={value.tags} />
    if (field === 'created_at' || field === 'updated_at') return <ContactTime value={value[field]} />
    return value[field] || t('contacts.missing.value')
  }
  function actions(value: ContactOut) {
    return <ContactActions name={value.name} edit={() => setEditor({ value })} history={() => setHistory(value)} remove={() => setDeleting(value)} readOnly={deleted} />
  }
  return <>
    <div className="page-heading"><div><p className="eyebrow">{deleted ? t('contacts.deleted.eyebrow') : t('contacts.page.eyebrow')}</p><h1>{deleted ? t('contacts.deleted.title') : t('contacts.page.title')}</h1>
      <p className="muted">{deleted ? t('contacts.deleted.description') : t('contacts.page.description')}</p></div>
      <div className="inline">{!deleted && <button ref={createButton} type="button" onClick={() => setEditor({ value: null })}>{t('contacts.page.newContact')}</button>}
        {deleted && <Link to="/contacts" className="button secondary">{t('contacts.deleted.backToContacts')}</Link>}</div>
    </div>
    <div className="filters">
      <label>{t('contacts.search.label')}<input type="search" maxLength={200} placeholder={t('contacts.search.placeholder')} value={q} onChange={event => filter({ q: event.target.value })} /></label>
    </div>
    {query.isPending && <Notice>{t('contacts.loading')}</Notice>}
    {query.error && <Notice error>{errorMessage(query.error)}</Notice>}
    {query.data && <section aria-label={t('contacts.list')} aria-busy={query.isFetching}>
      <p className="muted">{t('contacts.count', { count: query.data.total })}</p>
      {!query.data.items.length && <p className="card empty">{q ? t('contacts.empty.search') : page > 1 ? t('contacts.empty.page') : deleted ? t('contacts.empty.deleted') : t('contacts.empty.none')}</p>}
      {query.data.items.length > 0 && <>
        <div className="card contacts-desktop table-scroll"><table className="contacts-table">
          <caption className="sr-only">{t('contacts.table.caption')}</caption>
          <thead><tr>{tableFields.map(key => <th scope="col" key={key} aria-sort={sort === key ? direction === 'asc' ? 'ascending' : 'descending' : 'none'}>
            <button type="button" className="table-sort-button" onClick={() => filter({ sort: key, direction: sort === key && direction === 'asc' ? 'desc' : 'asc' })}>
              {t(sortFields[key])}{sort === key && <Icon name={direction === 'asc' ? 'arrow-up' : 'arrow-down'} size={14} />}
            </button>
          </th>)}<th scope="col">{t('contacts.table.actions')}</th></tr></thead>
          <tbody>{query.data.items.map(value => <tr key={value.id}>{tableFields.map(field => <td key={field}>{cell(value, field)}</td>)}<td>{actions(value)}</td></tr>)}</tbody>
        </table></div>
        <div className="contacts-mobile">{query.data.items.map(value => <article className="card" key={value.id}>
          <h2>{cell(value, 'name')}</h2><p className="muted">{value.company || t('contacts.missing.company')}</p>
          <div className="neighbor-links">{cell(value, 'email')}{cell(value, 'phone')}{cell(value, 'tags')}</div>
          {actions(value)}
        </article>)}</div>
      </>}
      <Pagination page={page} pages={query.data.pages} change={page => filter({ page: String(page) })} busy={query.isFetching} label={t('contacts.pagination')} />
    </section>}
    {editor && <ContactForm value={editor.value} close={() => setEditor(null)} />}
    {deleting && <DeleteContact value={deleting} close={() => setDeleting(null)} restoreFocusRef={createButton} />}
    {history && <ContactHistory contact={history} close={() => setHistory(null)} />}
    {details && <ContactDetails value={details} close={() => setDetails(null)} />}
  </>
}
