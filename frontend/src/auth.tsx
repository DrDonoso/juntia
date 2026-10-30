import { createContext, useContext, useEffect, useId, useState, type FormEvent, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, Navigate, Outlet, useLocation, useNavigate, useSearchParams } from 'react-router'
import { api, cache, clearPrivateData, errorMessage, signedOut } from './api/client'
import type { AuthOut, UserAuthOut } from './api/schema.gen'
import { MIN_PASSWORD_LENGTH, Notice, focusFormField, hasControlCharacters, useAction, validateNewPassword, type NewPasswordError } from './shared'
import { GoogleResult, GoogleSignIn } from './google'
import { LanguageSelect, useI18n } from './i18n'

export type LoginNotice = 'password-updated' | 'sessions-closed' | 'google-unlinked'
const LoginNoticeContext = createContext<{
  notice: LoginNotice | null
  setNotice: (notice: LoginNotice | null) => void
} | null>(null)

export function LoginNoticeProvider({ children }: { children: ReactNode }) {
  const [notice, setNotice] = useState<LoginNotice | null>(null)
  return <LoginNoticeContext value={{ notice, setNotice }}>{children}</LoginNoticeContext>
}

export function useLoginNotice() {
  const value = useContext(LoginNoticeContext)
  if (!value) throw new Error('Login notice provider is missing')
  return value
}

export function useAdminAuth() {
  return useQuery({
    queryKey: ['auth'], queryFn: () => api<AuthOut>('/admin/auth/session'), retry: false,
    refetchInterval: query => query.state.data?.authenticated ? 30_000 : false,
  })
}

export function useReaderAuth() {
  return useQuery({
    queryKey: ['reader-auth'], queryFn: async () => {
      const next = await api<UserAuthOut>('/auth/session')
      const previous = cache.getQueryData<UserAuthOut>(['reader-auth'])
      if (previous && (previous.authenticated !== next.authenticated
        || previous.kind !== next.kind || previous.user_id !== next.user_id)) await clearPrivateData()
      return next
    }, retry: false,
    refetchInterval: query => query.state.data?.authenticated ? 30_000 : false,
  })
}

export function useSessionLifecycle(reader: UserAuthOut | undefined, administrator: boolean | undefined) {
  useEffect(() => {
    // The administrator session check also migrates the legacy cookie path.
    if (administrator) void cache.invalidateQueries({ queryKey: ['reader-auth'] })
  }, [administrator])
  useEffect(() => {
    if (!reader?.authenticated || !reader.expires_at) return
    const remaining = new Date(reader.expires_at).getTime() - Date.now()
    const timer = window.setTimeout(() => {
      if (remaining > 2_147_483_647) {
        void cache.invalidateQueries({ queryKey: ['reader-auth'] })
        return
      }
      void clearPrivateData(true)
      cache.setQueryData(['reader-auth'], signedOut)
      if (reader.kind === 'administrator') cache.setQueryData(['auth'], { authenticated: false, username: null })
    }, Math.min(2_147_483_647, Math.max(0, remaining)))
    return () => window.clearTimeout(timer)
  }, [reader?.authenticated, reader?.expires_at, reader?.kind])
}

export function safeReturnPath(value: string | null): string {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.includes('\\') || hasControlCharacters(value)) return '/'
  const parsed = new URL(value, window.location.origin)
  const readerRoute = ['/', '/transactions', '/profile', '/neighbors', '/actions', '/contacts', '/events'].includes(parsed.pathname)
    || /^\/(?:actions|events)\/[1-9][0-9]{0,9}$/.test(parsed.pathname)
  if (parsed.origin !== window.location.origin || !readerRoute) return '/'
  return parsed.pathname + parsed.search
}

export function ReaderGate() {
  const { t } = useI18n()
  const reader = useReaderAuth(), admin = useAdminAuth(), location = useLocation()
  if (reader.isPending || admin.isPending || admin.data?.authenticated && !reader.data?.authenticated && reader.isFetching) return <Notice>{t('auth.checkingSession')}</Notice>
  if (reader.error) return <Notice error>{errorMessage(reader.error)}</Notice>
  if (!reader.data?.authenticated) {
    return <Navigate to={`/login?next=${encodeURIComponent(location.pathname + location.search)}`} replace />
  }
  return <Outlet />
}

/** Eyebrow of a sign-in card with the language picker, for visitors who have not signed in yet. */
export function AuthCardHeader({ eyebrow }: { eyebrow?: string }) {
  return <div className="auth-card-header">
    {eyebrow && <p className="eyebrow">{eyebrow}</p>}
    <LanguageSelect />
  </div>
}

export function ResidentLogin() {
  const { t } = useI18n()
  const [email, setEmail] = useState(''), [password, setPassword] = useState('')
  const [params] = useSearchParams()
  const navigate = useNavigate(), reader = useReaderAuth(), action = useAction()
  const { notice, setNotice } = useLoginNotice()
  const target = safeReturnPath(params.get('next'))
  if (reader.data?.authenticated) return <Navigate to={target} replace />
  return <section className="card login"><AuthCardHeader eyebrow={t('auth.login.eyebrow')} /><h1>{t('auth.login.title')}</h1>
    {notice === 'password-updated' && <Notice>{t('auth.login.passwordUpdated')}</Notice>}
    {notice === 'sessions-closed' && <Notice>{t('auth.login.sessionsClosed')}</Notice>}
    {notice === 'google-unlinked' && <Notice>{t('auth.login.googleUnlinked')}</Notice>}
    <GoogleResult />
    <p className="muted">{t('auth.login.help')}</p>
    <GoogleSignIn returnPath={target} disabled={action.busy} />
    <form onSubmit={event => { event.preventDefault(); void action.run(async () => {
      const result = await api<UserAuthOut>('/auth/login', 'POST', { email: email.trim(), password })
      setPassword('')
      await clearPrivateData(true)
      cache.setQueryData(['reader-auth'], result)
      setNotice(null)
      navigate(target, { replace: true })
    }) }}>
      <label>{t('auth.email')}<input type="email" autoComplete="username" required maxLength={254} value={email} onChange={event => setEmail(event.target.value)} disabled={action.busy} /></label>
      <label>{t('auth.password')}<input type="password" autoComplete="current-password" required value={password} onChange={event => setPassword(event.target.value)} disabled={action.busy} /></label>
      {action.notice}<button disabled={action.busy}>{action.busy ? t('auth.login.submitting') : t('auth.login.submit')}</button>
    </form>
    <p><Link to="/forgot-password">{t('auth.login.forgotPassword')}</Link></p>
  </section>
}

export function ForgotPassword() {
  const { t } = useI18n()
  const [email, setEmail] = useState(''), [sent, setSent] = useState(false)
  const action = useAction()
  return <section className="card login"><AuthCardHeader /><h1>{t('auth.forgot.title')}</h1>
    <p className="muted">{t('auth.forgot.expiry')}</p>
    {sent ? <Notice>{t('auth.forgot.sent')}</Notice>
      : <form onSubmit={event => { event.preventDefault(); void action.run(async () => {
        await api('/auth/forgot-password', 'POST', { email: email.trim() }); setSent(true)
      }) }}>
        <label>{t('auth.email')}<input type="email" autoComplete="email" required maxLength={254} value={email} onChange={event => setEmail(event.target.value)} disabled={action.busy} /></label>
        {action.notice}<button disabled={action.busy}>{action.busy ? t('auth.forgot.submitting') : t('auth.forgot.submit')}</button>
      </form>}
    <p><Link to="/login">{t('auth.backToSignIn')}</Link></p>
  </section>
}

export function PasswordLink({ invitation }: { invitation: boolean }) {
  const { t } = useI18n()
  const location = useLocation(), navigate = useNavigate()
  const [token, setToken] = useState(() => new URLSearchParams(location.hash.slice(1)).get('token') || '')
  const [password, setPassword] = useState(''), [confirmation, setConfirmation] = useState('')
  const [error, setError] = useState<NewPasswordError | null>(null), [done, setDone] = useState(false)
  const errorId = useId()
  const action = useAction()
  useEffect(() => {
    if (location.hash) navigate(location.pathname + location.search, { replace: true })
  }, [location.hash, location.pathname, location.search, navigate])
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const invalid = validateNewPassword(password, confirmation)
    setError(invalid)
    if (invalid) { focusFormField(event.currentTarget, invalid.field); return }
    void action.run(async () => {
      await api(`/auth/${invitation ? 'activate' : 'reset-password'}`, 'POST', { token, password })
      setToken(''); setPassword(''); setConfirmation(''); setDone(true)
      await clearPrivateData(true)
      await cache.invalidateQueries({ queryKey: ['reader-auth'] })
    })
  }
  return <section className="card login"><AuthCardHeader /><h1>{done ? t('auth.link.doneTitle') : invitation ? t('auth.link.activateTitle') : t('auth.link.resetTitle')}</h1>
    {done ? <Notice>{t('auth.link.done')}</Notice>
      : !/^[a-f0-9]{64}$/.test(token) ? <Notice error>{invitation ? t('auth.link.invalidInvitation') : t('auth.link.invalidRecovery')}</Notice>
        : <>{invitation && <GoogleSignIn invitationToken={token} disabled={action.busy} />}
          <p className="muted">{t('auth.link.help', { min: MIN_PASSWORD_LENGTH })}</p>
          <form className="password-form" noValidate onSubmit={submit}>
            <label>{t('auth.link.newPassword')}<input name="password" type="password" autoComplete="new-password" required minLength={MIN_PASSWORD_LENGTH} value={password} onChange={event => setPassword(event.target.value)} disabled={action.busy} aria-invalid={error?.field === 'password' || undefined} aria-describedby={error?.field === 'password' ? errorId : undefined} /></label>
            <label>{t('auth.link.repeatPassword')}<input name="confirmation" type="password" autoComplete="new-password" required minLength={MIN_PASSWORD_LENGTH} value={confirmation} onChange={event => setConfirmation(event.target.value)} disabled={action.busy} aria-invalid={error?.field === 'confirmation' || undefined} aria-describedby={error?.field === 'confirmation' ? errorId : undefined} /></label>
            {error && <Notice id={errorId} error>{error.message}</Notice>}{action.notice}
            <button disabled={action.busy}>{action.busy ? t('auth.link.submitting') : t('auth.link.submit')}</button>
          </form></>}
    <p><Link to="/login">{t('auth.backToSignIn')}</Link></p>
    {!invitation && !done && <p><Link to="/forgot-password">{t('auth.link.requestAnother')}</Link></p>}
  </section>
}
