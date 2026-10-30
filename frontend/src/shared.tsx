import { useState, type ReactNode, type RefObject, useEffect, useLayoutEffect, useRef, useId } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useSearchParams } from 'react-router'
import { Button, Tooltip, TooltipTrigger } from 'react-aria-components'
import { api, cache, errorMessage, refreshEventData } from './api/client'
import type { ActorOut, CatalogOut, FeatureFlagsOut, GeneralSettings } from './api/schema.gen'
import { PrivateValue } from './privacy'
import { Icon } from './icons'
import { dateTimeFormat, numberFormat, t, upperCase, useI18n, type Translate } from './i18n'

// Formatters use the active language; components showing them re-render on a language switch.
export const money = (value: string | number | null) => value === null ? '—'
  : numberFormat({ style: 'currency', currency: 'EUR' }).format(Number(value))
// Both supported locales (en-GB, es-ES) write calendar dates day-first: DD/MM/YYYY.
export const day = (value: string | null) => value ? value.slice(0, 10).split('-').reverse().join('/') : '—'
export const coefficientPercent = (value: string | null) => value === null ? t('common.notSet')
  : t('common.percent', { value: numberFormat({ minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(value)) })
export const connectionTime = (value: string | null) => value
  ? dateTimeFormat({ year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'short' }).format(new Date(value))
  : t('common.never')
// The server names every administrator author with a fixed label in its own language, never with
// their login: show that label in the reader's language instead. Residents keep their names.
export const authorName = (author: Pick<ActorOut, 'kind' | 'name'>, translate: Translate = t) =>
  author.kind === 'administrator' ? translate('common.technicalAdministrator') : author.name
export const profileInitials = (name: string) => upperCase(name.trim().split(/\s+/).slice(0, 2).map(word => [...word][0]).join(''))
export const hasControlCharacters = (value: string) => Array.from(value).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
export const MIN_PASSWORD_LENGTH = 10
export type NewPasswordError = { field: 'password' | 'confirmation'; message: string }
export function validateNewPassword(password: string, confirmation: string): NewPasswordError | null {
  if (!password.trim()) return { field: 'password', message: t('auth.passwordRules.required') }
  if ([...password].length < MIN_PASSWORD_LENGTH) return { field: 'password', message: t('auth.passwordRules.tooShort', { min: MIN_PASSWORD_LENGTH }) }
  if (new TextEncoder().encode(password).length > 72) return { field: 'password', message: t('auth.passwordRules.tooLong') }
  if (!confirmation) return { field: 'confirmation', message: t('auth.passwordRules.confirmationRequired') }
  if (password !== confirmation) return { field: 'confirmation', message: t('auth.passwordRules.mismatch') }
  return null
}
export function focusFormField(form: HTMLFormElement, name: string) {
  const field = form.elements.namedItem(name)
  if (field instanceof HTMLElement) field.focus()
  else console.warn('The invalid form field could not be focused.')
}
export function phoneValidationMessage(value: string): string {
  return value.trim() && !/^\+?[0-9]{7,15}$/.test(value.replace(/[\s().-]/g, ''))
    ? t('common.phone.invalid')
    : ''
}
export function RequiredMark() {
  return <span className="required-mark" aria-hidden="true">*</span>
}
export function PhoneField({ value, change, disabled = false, autoComplete = 'tel', showHint = true, required = false, error, name }: {
  value: string; change: (value: string) => void; disabled?: boolean; autoComplete?: 'tel' | 'off'
  showHint?: boolean; required?: boolean; error?: string; name?: string
}) {
  const { t } = useI18n()
  const hint = useId()
  return <div className="phone-field">
    <label htmlFor={`${hint}-input`}><span>{t('common.phone.label')} {required && <RequiredMark />}</span></label>
    <input id={`${hint}-input`} name={name} type="tel" inputMode="tel" autoComplete={autoComplete} maxLength={30} placeholder={t('common.phone.placeholder')} value={value} required={required} aria-invalid={!!error || undefined} aria-describedby={error ? `${hint}-error` : showHint ? hint : undefined} disabled={disabled} onChange={event => {
      event.currentTarget.setCustomValidity(phoneValidationMessage(event.target.value))
      change(event.target.value)
    }} />
    {showHint && <p id={hint} className="muted">{t('common.phone.hint')}</p>}
    {error && <Notice id={`${hint}-error`} error>{error}</Notice>}
  </div>
}
export function PhoneLink({ phone, name }: { phone: string; name: string }) {
  const { t } = useI18n()
  return phone ? <a className="phone-link" href={`tel:${phone}`} aria-label={t('common.phone.call', { name, phone })}>{phone}</a>
    : <span className="muted">{t('common.phone.missing')}</span>
}
export function PresidentBadge({ name }: { name: string }) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const opening = useRef(0)
  const [container, setContainer] = useState<Element | null>(null)
  useEffect(() => () => cancelAnimationFrame(opening.current), [])
  function changeOpen(next: boolean) {
    cancelAnimationFrame(opening.current)
    if (next) setContainer(trigger.current?.closest('dialog, main') ?? null)
    // Focusing an off-screen medal scrolls it into view, and React Aria closes open tooltips on the
    // scroll event that the next frame dispatches before its animation frame callbacks: open after it.
    if (next && document.activeElement === trigger.current) {
      opening.current = requestAnimationFrame(() => { if (document.activeElement === trigger.current) setOpen(true) })
      return
    }
    setOpen(next)
  }
  return <TooltipTrigger isOpen={open} onOpenChange={changeOpen} delay={0} closeDelay={150} shouldCloseOnPress={false}>
    <Button ref={trigger} className="president-badge" aria-label={t('common.president.label', { name })}
      onHoverStart={() => changeOpen(true)}
      onPress={event => changeOpen(event.pointerType === 'touch' ? !open : true)}>
      <Icon name="medal" size={20} />
    </Button>
    <Tooltip className="president-tooltip" placement="top" offset={8} UNSTABLE_portalContainer={container ?? undefined}>{t('common.president.title')}</Tooltip>
  </TooltipTrigger>
}
export function EmailContact({ email, name }: { email: string; name: string }) {
  const { t } = useI18n()
  const [status, setStatus] = useState<'idle' | 'copying' | 'copied' | 'failed'>('idle')
  async function copy() {
    setStatus('copying')
    if (!navigator.clipboard?.writeText) { setStatus('failed'); return }
    try {
      await navigator.clipboard.writeText(email)
      setStatus('copied')
    } catch (error) {
      console.warn('Email copy failed:', error instanceof Error ? error.name : 'UnknownError')
      setStatus('failed')
    }
  }
  return <div>
    <div className="neighbor-email-row">
      <a className="neighbor-email" href={`mailto:${encodeURIComponent(email)}`} aria-label={t('common.email.send', { name, email })}>{email}</a>
      <button type="button" className="quiet email-copy" aria-label={t('common.email.copy', { name, email })} title={status === 'copied' ? t('common.email.copied') : t('common.email.copyTitle')} disabled={status === 'copying'} onClick={() => void copy()}>
        <Icon name={status === 'copied' ? 'check' : 'copy'} />
      </button>
    </div>
    <span className="email-copy-status muted" role="status">{status === 'copied' ? t('common.email.copied') : ''}</span>
    {status === 'failed' && <Notice error>{t('common.email.copyFailed')}</Notice>}
  </div>
}
export function Pagination({ page, pages, change, busy = false, label }: {
  page: number; pages: number; change: (page: number) => void; busy?: boolean; label: string
}) {
  const { t } = useI18n()
  if (pages <= 1 && page === 1) return null
  return <nav className="pagination action-pagination" aria-label={label}>
    <button type="button" className="secondary" disabled={busy || page <= 1} onClick={() => change(page - 1)} aria-label={t('common.pagination.previousLabel', { label })}>{t('common.pagination.previous')}</button>
    <span>{t('common.pagination.page', { page, pages })}</span>
    <button type="button" className="secondary" disabled={busy || page >= pages} onClick={() => change(page + 1)} aria-label={t('common.pagination.nextLabel', { label })}>{t('common.pagination.next')}</button>
    {page > pages && <button type="button" className="quiet" disabled={busy} onClick={() => change(1)}>{t('common.pagination.first')}</button>}
  </nav>
}
export type DatePeriod = { start: string; end: string }
export function currentYearPeriod(): DatePeriod {
  const year = new Date().getFullYear()
  return { start: `${year}-01-01`, end: `${year}-12-31` }
}
export function withDefaultPeriod(params: URLSearchParams, period?: DatePeriod): URLSearchParams {
  const next = new URLSearchParams(params)
  if (period) {
    if (!next.has('start')) next.set('start', period.start)
    if (!next.has('end')) next.set('end', period.end)
  }
  return next
}
export function filterRequestParams(params: URLSearchParams): URLSearchParams {
  const next = new URLSearchParams(params)
  for (const key of ['start', 'end']) if (next.get(key) === '') next.delete(key)
  return next
}
export function expenseShare(amount: string, total: string): string {
  return Number(total) > 0
    ? numberFormat({ style: 'percent', minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(Number(amount) / Number(total))
    : '—'
}
export function Money({ value }: { value: string | number | null }) {
  useI18n() // Re-render in the new locale after a language switch.
  return <PrivateValue>{money(value)}</PrivateValue>
}
export function useGeneralSettings() {
  return useQuery({ queryKey: ['general-settings'], queryFn: () => api<GeneralSettings>('/settings/general') })
}
export function useFeatures(live = false) {
  return useQuery({
    queryKey: ['features'], queryFn: () => api<FeatureFlagsOut>('/features'),
    refetchInterval: live ? 5_000 : false,
    refetchOnWindowFocus: live ? 'always' : true,
  })
}
export function useFeatureLifecycle(features: FeatureFlagsOut | undefined) {
  const previous = useRef(features)
  useEffect(() => {
    if (!features) return
    const before = previous.current
    previous.current = features
    if (!before) return
    if (before.coefficient !== features.coefficient) {
      const predicate = (query: { queryKey: readonly unknown[] }) => query.queryKey[0] === 'profile'
        || query.queryKey[0] === 'admin' && ['dwellings', 'users'].includes(String(query.queryKey[1]))
      void cache.cancelQueries({ predicate }).then(() => cache.invalidateQueries({ predicate }))
    }
    if (before.actions !== features.actions) {
      if (!features.actions) cache.removeQueries({ queryKey: ['actions'] })
      else void cache.invalidateQueries({ queryKey: ['actions'] })
    }
    if (before.events !== features.events || before.actions !== features.actions) {
      void refreshEventData(features.events)
    }
  }, [features])
}
export function useCatalog(kind: 'categories' | 'tags') {
  return useQuery({ queryKey: ['catalog', kind], queryFn: () => api<CatalogOut[]>(`/catalog/${kind}`) })
}
export function Notice({ children, error = false, id }: { children: ReactNode; error?: boolean; id?: string }) {
  return <p id={id} className={error ? 'notice error' : 'notice'} role={error ? 'alert' : 'status'}>{children}</p>
}
export function useAction(queryKey?: readonly unknown[] | false) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [failure, setFailure] = useState<unknown>(null)
  async function run(action: () => Promise<void>, message = '') {
    setBusy(true); setError(''); setSuccess(''); setFailure(null)
    try {
      await action()
      if (queryKey !== false) await cache.invalidateQueries(queryKey ? { queryKey } : undefined)
      setSuccess(message)
    }
    catch (cause) { setError(errorMessage(cause)); setFailure(cause) }
    finally { setBusy(false) }
  }
  function reset() { setError(''); setSuccess(''); setFailure(null) }
  return { busy, run, failure, reset, notice: <>{error && <Notice error>{error}</Notice>}{success && <Notice>{success}</Notice>}</> }
}
export function Modal({ title, close, children, disabled = false, className, restoreFocusRef }: {
  title: string; close: () => void; children: ReactNode; disabled?: boolean; className?: string
  restoreFocusRef?: RefObject<HTMLElement | null>
}) {
  const { t } = useI18n()
  const ref = useRef<HTMLDialogElement>(null)
  const openerRef = useRef<Element | null>(null)
  useLayoutEffect(() => {
    const dialog = ref.current
    openerRef.current = restoreFocusRef?.current ?? document.activeElement
    dialog?.showModal()
    return () => { dialog?.close() }
  }, [restoreFocusRef])
  useEffect(() => () => {
    // React must re-enable the launcher before focus is restored during the closing commit.
    const opener = openerRef.current
    if (opener instanceof HTMLElement && opener.isConnected) opener.focus()
  }, [])
  return <dialog ref={ref} className={className} aria-label={title} onCancel={event => {
    // React bubbles cancel from nested dialogs; only the topmost one should close.
    if (event.target !== event.currentTarget) return
    event.preventDefault(); if (!disabled) close()
  }}>
    <header><h2>{title}</h2><button type="button" className="quiet icon-button" disabled={disabled} onClick={close} aria-label={t('common.close')}><Icon name="close" /></button></header>
    {children}
  </dialog>
}
export function Filters({ defaultPeriod }: { defaultPeriod?: DatePeriod }) {
  const { t } = useI18n()
  const [params, setParams] = useSearchParams()
  const effective = withDefaultPeriod(params, defaultPeriod)
  const categories = useCatalog('categories'), tags = useCatalog('tags')
  function change(key: string, value: string) {
    setParams(previous => {
      const next = withDefaultPeriod(previous, defaultPeriod)
      if (value || defaultPeriod && (key === 'start' || key === 'end')) next.set(key, value); else next.delete(key)
      if (key === 'category') {
        next.delete('uncategorized')
        if (value === 'uncategorized') { next.delete('category'); next.set('uncategorized', 'true') }
      }
      next.delete('page')
      return next
    }, { replace: true })
  }
  return <section className="filters" aria-label={t('common.filters.label')}>
    <label>{t('common.filters.from')}<input type="date" value={effective.get('start') || ''} onChange={e => change('start', e.target.value)} /></label>
    <label>{t('common.filters.to')}<input type="date" value={effective.get('end') || ''} onChange={e => change('end', e.target.value)} /></label>
    <label>{t('common.filters.description')}<input type="search" placeholder={t('common.filters.search')} value={params.get('q') || ''} onChange={e => change('q', e.target.value)} /></label>
    <label>{t('common.filters.category')}<select value={params.get('uncategorized') === 'true' ? 'uncategorized' : params.get('category') || ''} onChange={e => change('category', e.target.value)}>
      <option value="">{t('common.filters.allCategories')}</option><option value="uncategorized">{t('common.filters.uncategorized')}</option>{categories.data?.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
    </select></label>
    <label>{t('common.filters.tag')}<select value={params.get('tag') || ''} onChange={e => change('tag', e.target.value)}>
      <option value="">{t('common.filters.allTags')}</option>{tags.data?.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
    </select></label>
    <label>{t('common.filters.type')}<select value={params.get('flow') || ''} onChange={e => change('flow', e.target.value)}>
      <option value="">{t('common.filters.allTypes')}</option><option value="income">{t('common.filters.income')}</option><option value="expense">{t('common.filters.expenses')}</option>
    </select></label>
    <details><summary>{t('common.filters.more')}</summary><div className="inline">
      <label>{t('common.filters.merchant')}<input value={params.get('merchant') || ''} onChange={e => change('merchant', e.target.value)} /></label>
      <label>{t('common.filters.minimum')}<input inputMode="decimal" value={params.get('minimum') || ''} onChange={e => change('minimum', e.target.value.replace(',', '.'))} /></label>
      <label>{t('common.filters.maximum')}<input inputMode="decimal" value={params.get('maximum') || ''} onChange={e => change('maximum', e.target.value.replace(',', '.'))} /></label>
    </div></details>
    {params.has('merchant_exact') && <span className="filter-chip">{t('common.filters.merchantChip', { merchant: params.get('merchant_exact') || t('common.filters.noMerchant') })}<button type="button" className="quiet" aria-label={t('common.filters.removeMerchant')} onClick={() => change('merchant_exact', '')}><Icon name="close" size={14} /></button></span>}
    <button className="quiet" onClick={() => setParams({})}>{t('common.filters.clear')}</button>
    {(categories.error || tags.error) && <Notice error>{errorMessage(categories.error || tags.error)}</Notice>}
  </section>
}
