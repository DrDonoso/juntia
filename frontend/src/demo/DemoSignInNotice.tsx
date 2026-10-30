import { useEffect, useLayoutEffect, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useLocation } from 'react-router'
import { useAdminAuth } from '../auth'
import { useI18n } from '../i18n'
import { SAMPLE_NEIGHBOR_ID, castResident } from './cast'
import { DEMO_ADMIN_USERNAME, DEMO_PASSWORD } from './config'
import { residentPasswordChanged } from './store/people'

type SignIn = 'resident' | 'admin'

const strong = (chunks: ReactNode) => <strong>{chunks}</strong>

/**
 * The sign-in form on screen: both forms name their fields with these autocomplete tokens, and
 * only the neighbor's identifier is an email field.
 */
function findForm(kind: SignIn): HTMLFormElement | null {
  for (const form of document.querySelectorAll<HTMLFormElement>('#content section.login form')) {
    const username = form.querySelector<HTMLInputElement>('input[autocomplete="username"]')
    const password = form.querySelector<HTMLInputElement>('input[type="password"][autocomplete="current-password"]')
    if (username && password && (username.type === 'email') === (kind === 'resident')) return form
  }
  return null
}

/** The sign-in form of the current page, followed as the page renders. */
function useSignInForm(kind: SignIn | null): HTMLFormElement | null {
  const [form, setForm] = useState<HTMLFormElement | null>(null)
  useEffect(() => {
    if (!kind) {
      setForm(null)
      return
    }
    const update = () => setForm(findForm(kind))
    update()
    const observer = new MutationObserver(update)
    observer.observe(document.body, { childList: true, subtree: true })
    return () => observer.disconnect()
  }, [kind])
  return form
}

const prefilled = new WeakSet<HTMLFormElement>()

/** Types a value the way a person would, so the form's React state follows. */
function typeValue(input: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

/** Fills an untouched sign-in form once with the demo credentials (the password only when known). */
function prefill(form: HTMLFormElement, username: string, password: string | null): void {
  if (prefilled.has(form)) return
  prefilled.add(form)
  const user = form.querySelector<HTMLInputElement>('input[autocomplete="username"]')
  const secret = form.querySelector<HTMLInputElement>('input[type="password"]')
  if (!user || !secret || user.value || secret.value) return
  typeValue(user, username)
  if (password !== null) typeValue(secret, password)
}

/**
 * Demo help on the neighbor (/login) and administration (/admin) sign-in screens: the credentials,
 * right above the form, which arrives filled in. The screens themselves are the app's; the notice
 * is placed next to their form so they need no demo code. Once the sample neighbor has chosen
 * another password in My profile, `demo` no longer works for them: the form then only gets the email.
 */
export function DemoSignInNotice() {
  const { rich } = useI18n()
  const location = useLocation(), admin = useAdminAuth()
  const kind: SignIn | null = location.pathname === '/login' ? 'resident'
    : (location.pathname === '/admin' || location.pathname.startsWith('/admin/')) && admin.data?.authenticated === false ? 'admin'
      : null
  const form = useSignInForm(kind)
  const [host, setHost] = useState<HTMLElement | null>(null)
  const email = castResident(SAMPLE_NEIGHBOR_ID).email
  useLayoutEffect(() => {
    if (!form) return
    const element = document.createElement('div')
    element.className = 'demo-sign-in'
    form.before(element)
    setHost(element)
    return () => {
      element.remove()
      setHost(null)
    }
  }, [form])
  useEffect(() => {
    if (!form || !kind) return
    if (kind === 'admin') prefill(form, DEMO_ADMIN_USERNAME, DEMO_PASSWORD)
    else prefill(form, email, residentPasswordChanged(SAMPLE_NEIGHBOR_ID) ? null : DEMO_PASSWORD)
  }, [form, kind, email])
  if (!host || !kind) return null
  return createPortal(<p className="notice demo-sign-in-notice" role="note">
    {kind === 'admin'
      ? rich('demo.signIn.admin', { strong }, { username: DEMO_ADMIN_USERNAME, password: DEMO_PASSWORD })
      : rich('demo.signIn.resident', { strong }, { email, password: DEMO_PASSWORD })}
  </p>, host)
}
