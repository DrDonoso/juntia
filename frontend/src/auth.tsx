import { createContext, useContext, useEffect, useId, useState, type FormEvent, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, Navigate, Outlet, useLocation, useNavigate, useSearchParams } from 'react-router'
import { api, cache, clearPrivateData, errorMessage, signedOut } from './api/client'
import type { SetupOut, UserAuthOut } from './api/schema.gen'
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

/**
 * The signed-in account, checked every 30 seconds: whether it is an administrator is read from
 * the server each time, so a granted or revoked role shows at once.
 */
export function useReaderAuth() {
  return useQuery({
    queryKey: ['reader-auth'], queryFn: async ({ signal }) => {
      const next = await api<UserAuthOut>('/auth/session', 'GET', undefined, signal)
      // A newer check (several refused requests ask for one each) replaces this one: only the
      // latest may clear the private data, or the newer check would see a changed session.
      signal.throwIfAborted()
      const previous = cache.getQueryData<UserAuthOut>(['reader-auth'])
      if (previous && (previous.authenticated !== next.authenticated
        || previous.user_id !== next.user_id || previous.administrator !== next.administrator)) await clearPrivateData()
      return next
    }, retry: false,
    refetchInterval: query => query.state.data?.authenticated ? 30_000 : false,
  })
}

/** Whether this is a new installation, where the first visitor creates the administration account. */
export function useSetup() {
  return useQuery({ queryKey: ['setup'], queryFn: () => api<SetupOut>('/auth/setup'), retry: false, staleTime: 0 })
}

export function useSessionLifecycle(reader: UserAuthOut | undefined) {
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
    }, Math.min(2_147_483_647, Math.max(0, remaining)))
    return () => window.clearTimeout(timer)
  }, [reader?.authenticated, reader?.expires_at])
}

export function safeReturnPath(value: string | null): string {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.includes('\\') || hasControlCharacters(value)) return '/'
  const parsed = new URL(value, window.location.origin)
  // The pages of the portal and of the administration (backend: contracts.reader_route).
  const readerRoute = ['/', '/transactions', '/profile', '/neighbors', '/actions', '/contacts', '/events', '/documents', '/search', '/admin'].includes(parsed.pathname)
    || /^\/(?:actions|events|documents\/folders)\/[1-9][0-9]{0,9}$/.test(parsed.pathname)
    || /^\/admin\/[a-z]{1,30}(?:-[a-z]{1,30}){0,3}$/.test(parsed.pathname)
  if (parsed.origin !== window.location.origin || !readerRoute) return '/'
  return parsed.pathname + parsed.search
}

export function ReaderGate() {
  const { t } = useI18n()
  const reader = useReaderAuth(), location = useLocation()
  if (reader.isPending) return <Notice>{t('auth.checkingSession')}</Notice>
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

/** First run: the first visitor creates the administration account, then opens the administration. */
function Setup({ onCreated }: { onCreated: (account: UserAuthOut) => void }) {
  const { t } = useI18n()
  const [name, setName] = useState(''), [email, setEmail] = useState('')
  const [password, setPassword] = useState(''), [confirmation, setConfirmation] = useState('')
  const [error, setError] = useState<NewPasswordError | null>(null)
  const errorId = useId()
  const action = useAction()
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const invalid = validateNewPassword(password, confirmation)
    setError(invalid)
    if (invalid) { focusFormField(event.currentTarget, invalid.field); return }
    void action.run(async () => {
      const result = await api<UserAuthOut>('/auth/setup', 'POST', { name: name.trim(), email: email.trim(), password })
      setPassword(''); setConfirmation('')
      await clearPrivateData(true)
      onCreated(result)
    })
  }
  return <section className="card login"><AuthCardHeader eyebrow={t('auth.setup.eyebrow')} /><h1>{t('auth.setup.title')}</h1>
    <p className="muted">{t('auth.setup.help')}</p>
    <form className="password-form" onSubmit={submit}>
      <label>{t('auth.setup.name')}<input name="name" autoComplete="name" required maxLength={150} value={name} onChange={event => setName(event.target.value)} disabled={action.busy} /></label>
      <label>{t('auth.email')}<input name="email" type="email" autoComplete="username" required maxLength={254} value={email} onChange={event => setEmail(event.target.value)} disabled={action.busy} /></label>
      <label>{t('auth.password')}<input name="password" type="password" autoComplete="new-password" value={password} onChange={event => setPassword(event.target.value)} disabled={action.busy} aria-invalid={error?.field === 'password' || undefined} aria-describedby={error?.field === 'password' ? errorId : undefined} /></label>
      <label>{t('auth.link.repeatPassword')}<input name="confirmation" type="password" autoComplete="new-password" value={confirmation} onChange={event => setConfirmation(event.target.value)} disabled={action.busy} aria-invalid={error?.field === 'confirmation' || undefined} aria-describedby={error?.field === 'confirmation' ? errorId : undefined} /></label>
      <p className="muted">{t('auth.setup.passwordHelp', { min: MIN_PASSWORD_LENGTH })}</p>
      {error && <Notice id={errorId} error>{error.message}</Notice>}{action.notice}
      <button disabled={action.busy}>{action.busy ? t('auth.setup.submitting') : t('auth.setup.submit')}</button>
    </form>
  </section>
}

export function Login() {
  const { t } = useI18n()
  const [email, setEmail] = useState(''), [password, setPassword] = useState('')
  const [params] = useSearchParams()
  const navigate = useNavigate(), reader = useReaderAuth(), setup = useSetup(), action = useAction()
  const { notice, setNotice } = useLoginNotice()
  // The new administration account opens the administration, never the return path of the sign-in.
  const [created, setCreated] = useState<UserAuthOut | null>(null)
  useEffect(() => {
    if (!created) return
    cache.setQueryData(['reader-auth'], created)
    cache.setQueryData<SetupOut>(['setup'], { available: false })
  }, [created])
  const target = safeReturnPath(params.get('next'))
  if (created) return <Navigate to="/admin" replace />
  if (reader.data?.authenticated) return <Navigate to={target} replace />
  if (setup.isPending) return <Notice>{t('auth.checkingSession')}</Notice>
  if (setup.data?.available) return <Setup onCreated={setCreated} />
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
