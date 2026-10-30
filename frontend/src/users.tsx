import { useRef, useState, type FormEvent, type ReactNode, type RefObject } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, useSearchParams } from 'react-router'
import { api, ApiError, cache, errorMessage } from './api/client'
import type { DwellingOut, PresidencyOut, UserOut } from './api/schema.gen'
import { DwellingLayoutEditor } from './dwelling-layout-editor'
import { collator, lowerCase, useI18n } from './i18n'
import { Icon } from './icons'
import { Modal, Notice, PhoneField, PhoneLink, PresidentBadge, coefficientPercent, connectionTime, useAction, useFeatures } from './shared'
const userSortColumns = [
  { key: 'name', label: 'accounts.users.columns.name' },
  { key: 'phone', label: 'accounts.users.columns.phone' },
  { key: 'dwelling_label', label: 'accounts.users.columns.dwelling' },
  { key: 'status', label: 'accounts.users.columns.status' },
  { key: 'last_login_at', label: 'accounts.users.columns.lastSignIn' },
] as const
type UserSort = typeof userSortColumns[number]['key']
const strong = (chunks: ReactNode) => <strong>{chunks}</strong>

function userSorting(params: URLSearchParams): { sort: UserSort; direction: 'asc' | 'desc' } {
  const sort = userSortColumns.find(column => column.key === params.get('sort'))?.key || 'name'
  const rawDirection = params.get('direction')
  const direction = rawDirection === 'asc' || rawDirection === 'desc'
    ? rawDirection : sort === 'last_login_at' ? 'desc' : 'asc'
  return { sort, direction }
}

function compareUsers(left: UserOut, right: UserOut, sort: UserSort, direction: 'asc' | 'desc', statusLabel: (status: UserOut['status']) => string) {
  const leftValue = sort === 'status' ? statusLabel(left.status) : left[sort]
  const rightValue = sort === 'status' ? statusLabel(right.status) : right[sort]
  if (!leftValue && rightValue) return 1
  if (leftValue && !rightValue) return -1
  const text = collator()
  const compared = !leftValue || !rightValue ? 0
    : sort === 'last_login_at' ? Date.parse(leftValue) - Date.parse(rightValue)
    : text.compare(leftValue, rightValue)
  return (direction === 'asc' ? compared : -compared)
    || text.compare(left.name, right.name) || left.id - right.id
}

async function management<T>(path: string, method: string, body: unknown): Promise<T> {
  try { return await api<T>(path, method, body) }
  catch (error) {
    // A delivery failure can follow a successfully persisted account change.
    await Promise.all([
      cache.invalidateQueries({ queryKey: ['admin', 'users'] }),
      cache.invalidateQueries({ queryKey: ['admin', 'dwellings'] }),
      cache.invalidateQueries({ queryKey: ['admin', 'presidency'] }),
      cache.invalidateQueries({ queryKey: ['neighbors'] }),
      cache.invalidateQueries({ queryKey: ['features'] }),
    ])
    throw error
  }
}

function useDwellings() {
  return useQuery({ queryKey: ['admin', 'dwellings'], queryFn: () => api<DwellingOut[]>('/admin/dwellings') })
}

function DwellingForm({ value, close, coefficientEnabled }: { value: DwellingOut | null; close: () => void; coefficientEnabled: boolean }) {
  const { t } = useI18n()
  const [label, setLabel] = useState(value?.label || '')
  const [coefficient, setCoefficient] = useState(value?.coefficient || '')
  const action = useAction()
  function submit(event: FormEvent) {
    event.preventDefault()
    void action.run(async () => {
      const body = { label, ...(coefficientEnabled ? { coefficient } : {}) }
      await management(
        value ? `/admin/dwellings/${value.id}` : '/admin/dwellings',
        value ? 'PATCH' : 'POST', value ? { ...body, version: value.version } : body,
      )
      close()
    })
  }
  return <Modal title={value ? t('accounts.dwellings.form.editTitle') : t('accounts.dwellings.create')} close={close} disabled={action.busy}>
    <form onSubmit={submit}>
      <label>{t('accounts.dwellings.form.name')}<input required maxLength={150} placeholder={t('accounts.dwellings.form.namePlaceholder')} value={label} onChange={event => setLabel(event.target.value)} disabled={action.busy} /></label>
      {coefficientEnabled && <><label>{t('accounts.dwellings.form.coefficient')}<input type="number" inputMode="decimal" required min="0" max="100" step="0.01" value={coefficient} onChange={event => setCoefficient(event.target.value)} disabled={action.busy} /></label>
        <p className="muted">{t('accounts.dwellings.form.coefficientHelp')}</p></>}
      {action.notice}<div className="inline"><button disabled={action.busy}>{action.busy ? t('common.saving') : t('accounts.dwellings.form.save')}</button><button type="button" className="secondary" disabled={action.busy} onClick={close}>{t('common.cancel')}</button></div>
    </form>
  </Modal>
}

export function DwellingsPage() {
  const { t } = useI18n()
  const query = useDwellings(), features = useFeatures()
  const [editing, setEditing] = useState<DwellingOut | null | undefined>(undefined)
  const [organizing, setOrganizing] = useState(false)
  const organizeButton = useRef<HTMLButtonElement>(null)
  return <><div className="page-heading"><div><p className="eyebrow">{t('accounts.adminEyebrow')}</p><h1>{t('accounts.dwellings.title')}</h1>
    <p className="muted">{t('accounts.dwellings.description')}</p></div>
    <div className="inline"><button ref={organizeButton} className="secondary" disabled={!query.data || !!query.error} onClick={() => setOrganizing(true)}>{t('accounts.dwellings.arrange')}</button>
      <button disabled={!features.data || !!features.error} onClick={() => setEditing(null)}>{t('accounts.dwellings.create')}</button></div></div>
    {(query.isPending || features.isPending) && <Notice>{t('accounts.dwellings.loading')}</Notice>}{(query.error || features.error) && <Notice error>{errorMessage(query.error || features.error)}</Notice>}
    {query.data && features.data && !features.error && <section className="card">
      {query.data.length === 0 ? <p className="empty">{t('accounts.dwellings.empty')}</p>
        : <div className="table-scroll"><table aria-label={t('accounts.dwellings.table')}><thead><tr><th>{t('accounts.dwellings.dwelling')}</th>{features.data.coefficient && <th>{t('accounts.dwellings.coefficient')}</th>}<th>{t('accounts.dwellings.linkedUsers')}</th><th>{t('accounts.actionsColumn')}</th></tr></thead>
          <tbody>{query.data.map(value => <tr key={value.id}><td>{value.label}</td>{features.data.coefficient && <td className="nowrap">{coefficientPercent(value.coefficient)}</td>}
            <td><Link to={`/admin/users?dwelling=${value.id}`}>{t('accounts.dwellings.accounts', { count: value.user_count })}</Link></td>
            <td><button className="secondary" aria-label={t('accounts.dwellings.editLabel', { label: value.label })} onClick={() => setEditing(value)}>{t('common.edit')}</button></td>
          </tr>)}</tbody></table></div>}
    </section>}
    {editing !== undefined && features.data && !features.error && <DwellingForm value={editing} coefficientEnabled={features.data.coefficient} close={() => setEditing(undefined)} />}
    {organizing && query.data && <DwellingLayoutEditor dwellings={query.data} close={() => setOrganizing(false)} restoreFocusRef={organizeButton} />}
  </>
}

function UserForm({ value, dwellings, close, coefficientEnabled, isPresident }: {
  value: UserOut | null; dwellings: DwellingOut[]; close: () => void; coefficientEnabled: boolean; isPresident: boolean
}) {
  const { t } = useI18n()
  const [name, setName] = useState(value?.name || ''), [email, setEmail] = useState(value?.email || '')
  const [phone, setPhone] = useState(value?.phone || '')
  const [dwelling, setDwelling] = useState(value ? String(value.dwelling_id) : '')
  const action = useAction()
  const selected = dwellings.find(unit => String(unit.id) === dwelling)
  const emailChanged = value && email.trim().toLowerCase() !== value.email
  function submit(event: FormEvent) {
    event.preventDefault()
    void action.run(async () => {
      const body = { name, phone, email: email.trim(), dwelling_id: Number(dwelling) }
      await management(
        value ? `/admin/users/${value.id}` : '/admin/users',
        value ? 'PATCH' : 'POST', value ? { ...body, version: value.version } : body,
      )
      close()
    })
  }
  return <Modal title={value ? t('accounts.users.form.editTitle') : t('accounts.users.invite')} close={close} disabled={action.busy}>
    <form onSubmit={submit}>
      <label>{t('accounts.users.form.name')}<input required maxLength={150} autoComplete="off" value={name} onChange={event => setName(event.target.value)} disabled={action.busy} /></label>
      <label>{t('accounts.users.form.email')}<input type="email" required maxLength={254} autoComplete="off" value={email} onChange={event => setEmail(event.target.value)} disabled={action.busy} /></label>
      <PhoneField value={phone} change={setPhone} disabled={action.busy} autoComplete="off" />
      <p className="muted">{t('accounts.users.form.visibility')}</p>
      <label>{t('accounts.users.form.dwelling')}<select required value={dwelling} onChange={event => setDwelling(event.target.value)} disabled={action.busy}>
        <option value="">{t('accounts.users.form.selectDwelling')}</option>{dwellings.map(unit => <option key={unit.id} value={unit.id}>{unit.label}</option>)}
      </select></label>
      {selected && coefficientEnabled && <p className="muted">{t('accounts.users.form.coefficient', { coefficient: coefficientPercent(selected.coefficient) })}</p>}
      {!value && <p className="muted">{t('accounts.users.form.invitationHelp')}</p>}
      {emailChanged && <Notice>{value.status === 'disabled' ? t('accounts.users.form.emailChangeDisabled') : t('accounts.users.form.emailChangeActive')}</Notice>}
      {emailChanged && isPresident && <Notice>{t('accounts.users.form.emailChangePresident')}</Notice>}
      {action.notice}<div className="inline"><button disabled={action.busy || !selected}>{action.busy ? t('common.saving') : value ? t('accounts.users.form.save') : t('accounts.users.form.send')}</button><button type="button" className="secondary" disabled={action.busy} onClick={close}>{t('common.cancel')}</button></div>
    </form>
  </Modal>
}

function StatusConfirmation({ user, close, isPresident }: { user: UserOut; close: () => void; isPresident: boolean }) {
  const { t } = useI18n()
  const action = useAction(), disabling = user.status !== 'disabled'
  return <Modal title={disabling ? t('accounts.users.statusChange.deactivateTitle') : t('accounts.users.statusChange.reactivateTitle')} close={close} disabled={action.busy}>
    <p>{user.name} — {user.email}</p>
    <p>{disabling ? t('accounts.users.statusChange.deactivateHelp') : t('accounts.users.statusChange.reactivateHelp')}</p>
    {disabling && isPresident && <Notice>{t('accounts.users.statusChange.president')}</Notice>}
    {action.notice}<div className="inline">
      <button disabled={action.busy} onClick={() => void action.run(async () => {
        await management(`/admin/users/${user.id}/status`, 'PATCH', { disabled: disabling, version: user.version }); close()
      })}>{action.busy ? t('common.saving') : disabling ? t('accounts.users.statusChange.confirmDeactivation') : t('accounts.users.statusChange.confirmReactivation')}</button>
      <button type="button" className="secondary" disabled={action.busy} onClick={close}>{t('common.cancel')}</button>
    </div>
  </Modal>
}

function DeleteUserConfirmation({ user, close, action, restoreFocusRef, isPresident }: {
  user: UserOut; close: () => void; action: ReturnType<typeof useAction>; restoreFocusRef: RefObject<HTMLButtonElement | null>
  isPresident: boolean
}) {
  const { t, rich } = useI18n()
  const [email, setEmail] = useState('')
  const confirmed = email.trim().toLowerCase() === user.email
  return <Modal title={t('accounts.users.deletion.title')} close={close} disabled={action.busy} restoreFocusRef={restoreFocusRef}>
    <p><strong>{user.name}</strong> — {user.email}</p>
    <p>{t('accounts.users.deletion.warning')}</p>
    <p>{rich('accounts.users.deletion.kept', { strong }, { dwelling: user.dwelling_label })}</p>
    <p>{t('accounts.users.deletion.authorship')}</p>
    {isPresident && <Notice>{t('accounts.users.deletion.president')}</Notice>}
    <form onSubmit={event => { event.preventDefault(); void action.run(async () => {
      await management(`/admin/users/${user.id}`, 'DELETE', { email: email.trim(), version: user.version })
      close()
    }, t('accounts.users.deletion.deleted')) }}>
      <label>{t('accounts.users.deletion.confirmEmail')}<input type="email" autoComplete="off" required maxLength={254} value={email} onChange={event => setEmail(event.target.value)} disabled={action.busy} /></label>
      {action.notice}
      <div className="inline"><button className="secondary danger" disabled={action.busy || !confirmed}>{action.busy ? t('accounts.users.deletion.deleting') : t('accounts.users.deletion.submit')}</button>
        <button type="button" className="secondary" disabled={action.busy} onClick={close}>{t('common.cancel')}</button></div>
    </form>
  </Modal>
}

function PresidencyForm({ value, users, close, action, restoreFocusRef }: {
  value: PresidencyOut; users: UserOut[]; close: () => void; action: ReturnType<typeof useAction>
  restoreFocusRef: RefObject<HTMLButtonElement | null>
}) {
  const { t, rich } = useI18n()
  const [selected, setSelected] = useState(value.president ? String(value.president.id) : '')
  const candidates = users.filter(user => user.status === 'active')
  const next = candidates.find(user => String(user.id) === selected)
  const changed = selected !== (value.president ? String(value.president.id) : '')
  const eligible = selected === '' || !!next
  const stale = action.failure instanceof ApiError && action.failure.code === 'presidency_stale'
  return <Modal title={t('accounts.presidency.change')} close={close} disabled={action.busy} restoreFocusRef={restoreFocusRef}>
    <form onSubmit={event => { event.preventDefault(); void action.run(async () => {
      const saved = await management<PresidencyOut>('/admin/presidency', 'PUT', { user_id: selected ? Number(selected) : null, version: value.version })
      cache.setQueryData(['admin', 'presidency'], saved)
      close()
    }, selected ? t('accounts.presidency.form.updated') : t('accounts.presidency.form.cleared')) }}>
      <p>{rich('accounts.presidency.form.current', { strong }, {
        holder: value.president ? `${value.president.name} · ${value.president.dwelling_label}` : t('accounts.presidency.unassigned'),
      })}</p>
      <label>{t('accounts.presidency.form.next')}<select value={selected} onChange={event => { setSelected(event.target.value); if (!stale) action.reset() }} disabled={action.busy}>
        <option value="">{t('accounts.presidency.unassigned')}</option>
        {candidates.map(user => <option key={user.id} value={user.id}>{user.name} · {user.dwelling_label}</option>)}
      </select></label>
      <p className="muted">{t('accounts.presidency.form.candidates')}</p>
      {!eligible && <Notice error>{t('accounts.presidency.form.ineligible')}</Notice>}
      {changed && eligible && <div className="presidency-change">
        <Icon name="medal" size={24} />
        <p>{next
          ? value.president
            ? rich('accounts.presidency.form.transfer', { strong }, { from: value.president.name, to: next.name })
            : rich('accounts.presidency.form.assign', { strong }, { name: next.name })
          : rich('accounts.presidency.form.clear', { strong })}
          {value.president && <> {t('accounts.presidency.form.medal', { name: value.president.name })}</>}</p>
      </div>}
      {action.notice}
      <div className="inline">
        <button disabled={action.busy || !changed || !eligible || stale}>{action.busy ? t('common.saving') : t('accounts.presidency.form.confirm')}</button>
        <button type="button" className="secondary" disabled={action.busy} onClick={close}>{t('common.cancel')}</button>
      </div>
    </form>
  </Modal>
}

export function UsersPage() {
  const { t, rich } = useI18n()
  const query = useQuery({ queryKey: ['admin', 'users'], queryFn: () => api<UserOut[]>('/admin/users') })
  const presidency = useQuery({ queryKey: ['admin', 'presidency'], queryFn: () => api<PresidencyOut>('/admin/presidency') })
  const dwellings = useDwellings(), features = useFeatures(), action = useAction()
  const presidencyAction = useAction()
  const [changingPresidency, setChangingPresidency] = useState<PresidencyOut | null>(null)
  const presidencyButton = useRef<HTMLButtonElement>(null)
  const presidencyReady = !!presidency.data && !presidency.error
  const coefficientEnabled = features.data?.coefficient === true && !features.error
  const [params, setParams] = useSearchParams()
  const [editing, setEditing] = useState<UserOut | null | undefined>(undefined)
  const [statusUser, setStatusUser] = useState<UserOut | null>(null)
  const [deletingUser, setDeletingUser] = useState<UserOut | null>(null)
  const inviteButton = useRef<HTMLButtonElement>(null)
  const selected = params.get('dwelling') || ''
  const { sort, direction } = userSorting(params)
  const rows = query.data?.filter(user => !selected || String(user.dwelling_id) === selected)
    .sort((left, right) => compareUsers(left, right, sort, direction, status => t(`accounts.users.status.${status}`)))
  function changeSort(column: UserSort) {
    setParams(previous => {
      const next = new URLSearchParams(previous)
      const { sort: current, direction: currentDirection } = userSorting(next)
      next.set('sort', column)
      next.set('direction', current === column ? currentDirection === 'asc' ? 'desc' : 'asc' : column === 'last_login_at' ? 'desc' : 'asc')
      return next
    }, { replace: true })
  }
  function changeDwelling(value: string) {
    setParams(previous => {
      const next = new URLSearchParams(previous)
      if (value) next.set('dwelling', value)
      else next.delete('dwelling')
      return next
    })
  }
  return <><div className="page-heading"><div><p className="eyebrow">{t('accounts.adminEyebrow')}</p><h1>{t('accounts.users.title')}</h1>
    <p className="muted">{t('accounts.users.description')}</p></div>
    <button ref={inviteButton} disabled={!dwellings.data?.length} onClick={() => setEditing(null)}>{t('accounts.users.invite')}</button></div>
    {(query.isPending || dwellings.isPending) && <Notice>{t('accounts.users.loading')}</Notice>}
    {(query.error || dwellings.error) && <Notice error>{errorMessage(query.error || dwellings.error)}</Notice>}
    {features.error && <Notice error>{errorMessage(features.error)}</Notice>}
    {dwellings.data?.length === 0 && <Notice>{rich('accounts.users.needsDwelling', { link: chunks => <Link to="/admin/dwellings">{chunks}</Link> })}</Notice>}
    <section className="card presidency-card" aria-labelledby="presidency-heading">
      <div className="presidency-overview">
        <div className="presidency-identity">
          <span className="presidency-emblem" aria-hidden="true"><Icon name="medal" size={28} /></span>
          <div><h2 id="presidency-heading">{t('accounts.presidency.title')}</h2>
            {presidency.isPending && <Notice>{t('accounts.presidency.loading')}</Notice>}
            {presidency.error && <Notice error>{errorMessage(presidency.error)}</Notice>}
            {presidencyReady && <p>{presidency.data?.president
              ? <><strong>{presidency.data.president.name}</strong><span className="muted"> · {presidency.data.president.dwelling_label}</span></>
              : <span className="muted">{t('accounts.presidency.unassigned')}</span>}</p>}
          </div>
        </div>
        <button ref={presidencyButton} className="secondary" disabled={!presidencyReady || !query.data || !!query.error}
          onClick={() => { if (presidency.data) { presidencyAction.reset(); setChangingPresidency(presidency.data) } }}>
          {t('accounts.presidency.change')}
        </button>
      </div>
      <p className="muted presidency-help">{t('accounts.presidency.help')}</p>
      {!changingPresidency && presidencyAction.notice}
      {presidency.error && <button type="button" className="quiet" onClick={() => void presidency.refetch()}>{t('accounts.presidency.retry')}</button>}
    </section>
    {dwellings.data && dwellings.data.length > 0 && <section className="filters" aria-label={t('accounts.users.filters')}><label>{t('accounts.users.filterByDwelling')}<select value={selected} onChange={event => changeDwelling(event.target.value)}>
      <option value="">{t('accounts.users.allDwellings')}</option>{dwellings.data.map(unit => <option key={unit.id} value={unit.id}>{unit.label}</option>)}
    </select></label></section>}
    {action.notice}
    {rows && <section className="card">
      {rows.length === 0 ? <p className="empty">{t('accounts.users.empty')}</p>
        : <div className="table-scroll"><table className="users-table" aria-label={t('accounts.users.table')}><thead><tr>{userSortColumns.map(column => {
          const active = sort === column.key
          const label = t(column.label)
          return <th key={column.key} scope="col" aria-label={label} aria-sort={active ? direction === 'asc' ? 'ascending' : 'descending' : 'none'}>
            <button type="button" className="table-sort-button" aria-label={t('accounts.users.sortBy', { column: lowerCase(label) })} onClick={() => changeSort(column.key)}>
              {label}<Icon name={active ? direction === 'asc' ? 'arrow-up' : 'arrow-down' : 'sort'} size={14} />
            </button>
          </th>
        })}<th scope="col">{t('accounts.actionsColumn')}</th></tr></thead>
          <tbody>{rows.map(user => <tr key={user.id}><td><div className="user-name"><strong>{user.name}</strong>
            {presidencyReady && presidency.data?.president?.id === user.id && <PresidentBadge name={user.name} />}</div><small>{user.email}</small></td>
            <td><PhoneLink phone={user.phone} name={user.name} /></td>
            <td>{user.dwelling_label}{coefficientEnabled && <small className="nowrap">{coefficientPercent(user.coefficient)}</small>}</td>
            <td><span className="tag">{t(`accounts.users.status.${user.status}`)}</span>
              {user.google_linked && <small>{user.has_password ? t('accounts.users.signInMethods.googleAndPassword') : t('accounts.users.signInMethods.google')}</small>}
              {user.status === 'pending' && <>
              <small>{t(`accounts.users.invitation.${user.invitation_status}`)}</small>
              {user.invitation_expires_at && <small>{t('accounts.users.expires', { date: connectionTime(user.invitation_expires_at) })}</small>}
            </>}</td>
            <td>{user.last_login_at ? <time dateTime={user.last_login_at}>{connectionTime(user.last_login_at)}</time> : t('common.never')}</td>
            <td><div className="user-actions"><button className="secondary" disabled={action.busy || !presidencyReady} aria-label={t('accounts.users.editLabel', { email: user.email })} onClick={() => setEditing(user)}>{t('common.edit')}</button>
              {user.status === 'pending' && <button className="secondary" disabled={action.busy} aria-label={t('accounts.users.resendLabel', { email: user.email })} onClick={() => void action.run(async () => {
                await management(`/admin/users/${user.id}/invite`, 'POST', { version: user.version })
              }, t('accounts.users.resent'))}>{t('accounts.users.resend')}</button>}
              <button className="quiet" disabled={action.busy || !presidencyReady} aria-label={user.status === 'disabled' ? t('accounts.users.reactivateLabel', { email: user.email }) : t('accounts.users.deactivateLabel', { email: user.email })} onClick={() => setStatusUser(user)}>{user.status === 'disabled' ? t('accounts.users.reactivate') : t('accounts.users.deactivate')}</button>
              <button className="quiet danger" disabled={action.busy || !presidencyReady} aria-label={t('accounts.users.deleteLabel', { email: user.email })} onClick={() => setDeletingUser(user)}>{t('common.delete')}</button>
            </div></td>
          </tr>)}</tbody></table></div>}
    </section>}
    {editing !== undefined && dwellings.data && <UserForm value={editing} dwellings={dwellings.data} coefficientEnabled={coefficientEnabled} close={() => setEditing(undefined)} isPresident={!!editing && presidency.data?.president?.id === editing.id} />}
    {statusUser && <StatusConfirmation user={statusUser} close={() => setStatusUser(null)} isPresident={presidency.data?.president?.id === statusUser.id} />}
    {deletingUser && <DeleteUserConfirmation user={deletingUser} close={() => setDeletingUser(null)} action={action} restoreFocusRef={inviteButton} isPresident={presidency.data?.president?.id === deletingUser.id} />}
    {changingPresidency && query.data && <PresidencyForm value={changingPresidency} users={query.data} action={presidencyAction} restoreFocusRef={presidencyButton} close={() => setChangingPresidency(null)} />}
  </>
}
