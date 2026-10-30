import { useId, useState, type FormEvent } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router'
import { api, cache, clearPrivateData, errorMessage, signedOut } from './api/client'
import type { GoogleStartOut, ProfileOut, UserAuthOut } from './api/schema.gen'
import { useLoginNotice, useReaderAuth, type LoginNotice } from './auth'
import { GoogleIcon, GoogleResult } from './google'
import { useI18n } from './i18n'
import { MIN_PASSWORD_LENGTH, Modal, Notice, PhoneField, coefficientPercent, connectionTime, focusFormField, profileInitials, useAction, useFeatures, validateNewPassword, type NewPasswordError } from './shared'

type FinishSecurityAction = (notice: LoginNotice) => Promise<void>

function PersonalDetailsForm({ profile }: { profile: ProfileOut }) {
  const { t } = useI18n()
  const [draft, setDraft] = useState({ name: profile.name, phone: profile.phone, version: profile.version })
  const action = useAction()
  return <form className="profile-details-form" onSubmit={event => { event.preventDefault(); void action.run(async () => {
    const saved = await api<ProfileOut>('/auth/profile', 'PATCH', draft)
    setDraft({ name: saved.name, phone: saved.phone, version: saved.version })
    cache.setQueryData(['profile', saved.id], saved)
    cache.setQueryData<UserAuthOut>(['reader-auth'], previous => previous && { ...previous, name: saved.name })
  }, t('accounts.profile.detailsSaved'))} }>
    <label>{t('accounts.profile.name')}<input autoComplete="name" required maxLength={150} value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })} disabled={action.busy} /></label>
    <PhoneField value={draft.phone} change={phone => setDraft({ ...draft, phone })} disabled={action.busy} />
    {action.notice}
    <button disabled={action.busy || !draft.name.trim() || draft.name === profile.name && draft.phone === profile.phone}>{action.busy ? t('common.saving') : t('accounts.profile.saveDetails')}</button>
  </form>
}

function PasswordForm({ finish }: { finish: FinishSecurityAction }) {
  const { t } = useI18n()
  const [current, setCurrent] = useState(''), [password, setPassword] = useState(''), [confirmation, setConfirmation] = useState('')
  const [error, setError] = useState<NewPasswordError | { field: 'current_password'; message: string } | null>(null)
  const errorId = useId()
  const action = useAction()
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const invalid = current.trim() ? validateNewPassword(password, confirmation)
      : { field: 'current_password' as const, message: t('accounts.profile.password.currentRequired') }
    setError(invalid)
    if (invalid) { focusFormField(event.currentTarget, invalid.field); return }
    void action.run(async () => {
      await api('/auth/profile/password', 'POST', { current_password: current, password })
      setCurrent(''); setPassword(''); setConfirmation('')
      await finish('password-updated')
    })
  }
  return <section className="card profile-password"><h2>{t('accounts.profile.password.title')}</h2>
    <p className="muted">{t('accounts.profile.password.help', { min: MIN_PASSWORD_LENGTH })}</p>
    <form className="password-form" noValidate onSubmit={submit}>
      <label>{t('accounts.profile.password.current')}<input name="current_password" type="password" autoComplete="current-password" required value={current} onChange={event => setCurrent(event.target.value)} disabled={action.busy} aria-invalid={error?.field === 'current_password' || undefined} aria-describedby={error?.field === 'current_password' ? errorId : undefined} /></label>
      <label>{t('accounts.profile.password.new')}<input name="password" type="password" autoComplete="new-password" required minLength={MIN_PASSWORD_LENGTH} value={password} onChange={event => setPassword(event.target.value)} disabled={action.busy} aria-invalid={error?.field === 'password' || undefined} aria-describedby={error?.field === 'password' ? errorId : undefined} /></label>
      <label>{t('accounts.profile.password.repeat')}<input name="confirmation" type="password" autoComplete="new-password" required minLength={MIN_PASSWORD_LENGTH} value={confirmation} onChange={event => setConfirmation(event.target.value)} disabled={action.busy} aria-invalid={error?.field === 'confirmation' || undefined} aria-describedby={error?.field === 'confirmation' ? errorId : undefined} /></label>
      <p className="muted">{t('accounts.profile.password.signOutWarning')}</p>
      {error && <Notice id={errorId} error>{error.message}</Notice>}{action.notice}
      <button disabled={action.busy}>{action.busy ? t('accounts.profile.password.submitting') : t('accounts.profile.password.submit')}</button>
    </form>
  </section>
}

function CreatePassword({ email }: { email: string }) {
  const { t } = useI18n()
  const action = useAction()
  return <section className="card"><h2>{t('accounts.profile.localPassword.title')}</h2>
    <p className="muted">{t('accounts.profile.localPassword.help')}</p>
    {action.notice}
    <button className="secondary" disabled={action.busy} onClick={() => void action.run(async () => {
      await api('/auth/forgot-password', 'POST', { email })
    }, t('accounts.profile.localPassword.sent'))}>{t('accounts.profile.localPassword.send')}</button>
  </section>
}

function GoogleAccount({ profile, enabled, finish }: {
  profile: ProfileOut; enabled: boolean; finish: FinishSecurityAction
}) {
  const { t } = useI18n()
  const [password, setPassword] = useState('')
  const action = useAction()
  if (!enabled && !profile.google_linked) return null
  return <section className="card google-account"><h2>{t('accounts.profile.google.title')}</h2>
    <p className="muted">{profile.google_linked ? t('accounts.profile.google.linked', { email: profile.email }) : t('accounts.profile.google.linkHelp')}</p>
    {!enabled && <Notice>{profile.has_password ? t('accounts.profile.google.disabledWithPassword') : t('accounts.profile.google.disabledWithoutPassword')}</Notice>}
    {profile.has_password
      ? <form onSubmit={event => { event.preventDefault(); void action.run(async () => {
        if (profile.google_linked) {
          await api('/auth/google/link', 'DELETE', { current_password: password })
          setPassword(''); await finish('google-unlinked')
        } else {
          const result = await api<GoogleStartOut>('/auth/google/link', 'POST', { current_password: password })
          setPassword(''); window.location.assign(result.authorization_url)
        }
      }) }}>
        <label>{profile.google_linked ? t('accounts.profile.google.unlinkPassword') : t('accounts.profile.google.linkPassword')}<input type="password" autoComplete="current-password" required value={password} onChange={event => setPassword(event.target.value)} disabled={action.busy} /></label>
        {profile.google_linked && <p className="muted">{t('accounts.profile.google.unlinkWarning')}</p>}
        {action.notice}<button className="secondary" disabled={action.busy || !profile.google_linked && !enabled}>{!profile.google_linked && <GoogleIcon />}{action.busy ? t('accounts.profile.google.processing') : profile.google_linked ? t('accounts.profile.google.unlink') : t('accounts.profile.google.link')}</button>
      </form>
      : <p className="muted">{t('accounts.profile.google.createPasswordFirst')}</p>}
  </section>
}

function SessionsCard({ finish }: { finish: FinishSecurityAction }) {
  const { t } = useI18n()
  const [confirming, setConfirming] = useState(false)
  const action = useAction()
  return <section className="card"><h2>{t('accounts.profile.sessions.title')}</h2>
    <p className="muted">{t('accounts.profile.sessions.help')}</p>
    <button className="secondary" onClick={() => setConfirming(true)}>{t('accounts.profile.sessions.open')}</button>
    {confirming && <Modal title={t('accounts.profile.sessions.dialogTitle')} close={() => setConfirming(false)} disabled={action.busy}>
      <p>{t('accounts.profile.sessions.warning')}</p>
      {action.notice}<div className="inline">
        <button disabled={action.busy} onClick={() => void action.run(async () => {
          await api('/auth/profile/sessions', 'DELETE')
          await finish('sessions-closed')
        })}>{action.busy ? t('accounts.profile.sessions.closing') : t('accounts.profile.sessions.confirm')}</button>
        <button className="secondary" disabled={action.busy} onClick={() => setConfirming(false)}>{t('common.cancel')}</button>
      </div>
    </Modal>}
  </section>
}

function ResidentProfile({ userId }: { userId: number }) {
  const { t } = useI18n()
  const { setNotice } = useLoginNotice()
  const features = useFeatures()
  const coefficientEnabled = features.data?.coefficient === true && !features.error
  const query = useQuery({ queryKey: ['profile', userId], queryFn: () => api<ProfileOut>('/auth/profile'), retry: false })
  async function finish(notice: LoginNotice) {
    setNotice(notice)
    await clearPrivateData(true)
    cache.setQueryData(['reader-auth'], signedOut)
    cache.setQueryData(['auth'], { authenticated: false, username: null })
  }
  if (query.isPending) return <Notice>{t('accounts.profile.loading')}</Notice>
  if (query.error) return <Notice error>{errorMessage(query.error)}</Notice>
  const profile = query.data
  return <div className="profile-layout">
    <section className="card"><header className="profile-identity">
      <span className="profile-avatar" aria-hidden="true">{profileInitials(profile.name)}</span>
      <div><h2>{profile.name}</h2><p className="muted">{t('accounts.profile.neighborAccount')}</p></div>
    </header>
      <PersonalDetailsForm key={profile.id} profile={profile} />
      <h3>{t('accounts.profile.account.title')}</h3>
      {features.error && <Notice error>{errorMessage(features.error)}</Notice>}
      <dl className="profile-details">
        <dt>{t('accounts.profile.account.email')}</dt><dd>{profile.email}</dd>
        <dt>{t('accounts.profile.account.dwelling')}</dt><dd>{profile.dwelling_label}</dd>
        {coefficientEnabled && <><dt>{t('accounts.profile.account.coefficient')}</dt><dd className="nowrap">{coefficientPercent(profile.coefficient)}</dd></>}
        <dt>{t('accounts.profile.account.lastSignIn')}</dt><dd>{profile.last_login_at ? <time dateTime={profile.last_login_at}>{connectionTime(profile.last_login_at)}</time> : t('common.never')}</dd>
      </dl>
      <p className="muted">{coefficientEnabled ? t('accounts.profile.account.managedWithCoefficient') : t('accounts.profile.account.managed')} {t('accounts.profile.account.lastSignInHelp')}</p>
      <p className="muted">{t('accounts.profile.account.visibility')}</p>
    </section>
    <div className="profile-security">
      {profile.has_password ? <PasswordForm finish={finish} /> : <CreatePassword email={profile.email} />}
      <GoogleAccount profile={profile} enabled={features.data?.google_login === true && !features.error} finish={finish} />
      <SessionsCard finish={finish} />
    </div>
  </div>
}

export function ProfilePage() {
  const { t } = useI18n()
  const session = useReaderAuth()
  const identity = session.data
  return <><div className="page-heading"><div><p className="eyebrow">{t('accounts.profile.eyebrow')}</p><h1>{t('accounts.profile.title')}</h1>
    <p className="muted">{t('accounts.profile.description')}</p></div></div>
    <GoogleResult />
    {identity?.kind === 'administrator'
      ? <section className="card technical-profile"><header className="profile-identity">
        <span className="profile-avatar" aria-hidden="true">{profileInitials(identity.name || t('accounts.profile.technical.fallbackName'))}</span>
        <div><h2>{identity.name}</h2><p className="muted">{t('accounts.profile.technical.role')}</p></div>
      </header>
        <p>{t('accounts.profile.technical.help')}</p>
        <Link to="/admin" className="button secondary">{t('accounts.profile.technical.back')}</Link>
      </section>
      : identity?.kind === 'resident' && identity.user_id !== null
        ? <ResidentProfile key={identity.user_id} userId={identity.user_id} />
        : <Notice error>{t('accounts.profile.unidentified')}</Notice>}
  </>
}
