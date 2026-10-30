import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router'
import { api, codeMessage, errorMessage } from './api/client'
import type { GoogleStartOut } from './api/schema.gen'
import { useI18n } from './i18n'
import { Notice, useFeatures } from './shared'

export function GoogleIcon() {
  return <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true" focusable="false" style={{ flexShrink: 0 }}>
    <path fill="#4285F4" d="M21.6 12.23c0-.71-.06-1.39-.18-2.05H12v3.88h5.38a4.6 4.6 0 0 1-2 3.02v2.51h3.24c1.89-1.74 2.98-4.31 2.98-7.36Z" />
    <path fill="#34A853" d="M12 22c2.7 0 4.96-.9 6.62-2.41l-3.24-2.51c-.9.6-2.05.96-3.38.96-2.6 0-4.81-1.76-5.6-4.12H3.06v2.59A10 10 0 0 0 12 22Z" />
    <path fill="#FBBC05" d="M6.4 13.92a6 6 0 0 1 0-3.84V7.49H3.06a10 10 0 0 0 0 9.02l3.34-2.59Z" />
    <path fill="#EA4335" d="M12 5.96c1.47 0 2.79.5 3.82 1.49l2.87-2.87A9.6 9.6 0 0 0 12 2a10 10 0 0 0-8.94 5.49l3.34 2.59C7.19 7.72 9.4 5.96 12 5.96Z" />
  </svg>
}

export function GoogleResult() {
  const { t } = useI18n()
  const [params, setParams] = useSearchParams()
  const [result] = useState(() => ({
    error: params.get('google_error'), linked: params.get('google') === 'linked',
    invitation: params.get('invitation') === 'retry',
  }))
  useEffect(() => {
    if (params.has('google_error') || params.has('google')) {
      setParams(previous => {
        const next = new URLSearchParams(previous)
        next.delete('google_error'); next.delete('google'); next.delete('invitation')
        return next
      }, { replace: true })
    }
  }, [params, setParams])
  return <>{result.error && <Notice error>{codeMessage(result.error)}{result.invitation && ` ${t('accounts.google.reopenInvitation')}`}</Notice>}
    {result.linked && <Notice>{t('accounts.google.linked')}</Notice>}</>
}

export function GoogleSignIn({ invitationToken, returnPath = '/', disabled = false }: {
  invitationToken?: string; returnPath?: string; disabled?: boolean
}) {
  const { t } = useI18n()
  const features = useFeatures()
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  if (features.error) return <Notice error>{errorMessage(features.error)}</Notice>
  if (!features.data?.google_login) return null
  async function start() {
    setBusy(true); setError('')
    try {
      const result = await api<GoogleStartOut>('/auth/google/start', 'POST', {
        invitation_token: invitationToken, return_path: returnPath,
      })
      window.location.assign(result.authorization_url)
    } catch (cause) {
      setError(errorMessage(cause)); setBusy(false)
    }
  }
  return <div className="google-access">
    <button type="button" className="secondary google-button" disabled={disabled || busy} onClick={() => void start()}><GoogleIcon />{busy ? t('accounts.google.opening') : t('accounts.google.continue')}</button>
    <p className="muted">{invitationToken ? t('accounts.google.invitationHelp') : t('accounts.google.signInHelp')}</p>
    {error && <Notice error>{error}</Notice>}
    <span className="auth-divider">{t('accounts.google.divider')}</span>
  </div>
}
