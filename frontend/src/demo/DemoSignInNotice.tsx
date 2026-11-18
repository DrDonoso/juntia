import { useEffect, useLayoutEffect, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useLocation } from 'react-router'
import { safeReturnPath } from '../auth'
import { useI18n } from '../i18n'
import { ADMINISTRATOR_ID, SAMPLE_NEIGHBOR_ID, castResident } from './cast'
import { DEMO_PASSWORD } from './config'
import { residentPasswordChanged } from './store/people'

const strong = (chunks: ReactNode) => <strong>{chunks}</strong>

/** The sign-in form on screen, found by the autocomplete tokens the app gives its email and password fields. */
function findForm(): HTMLFormElement | null {
  for (const form of document.querySelectorAll<HTMLFormElement>('#content section.login form')) {
    const email = form.querySelector<HTMLInputElement>('input[type="email"][autocomplete="username"]')
    const password = form.querySelector<HTMLInputElement>('input[type="password"][autocomplete="current-password"]')
    if (email && password) return form
  }
  return null
}

/** The sign-in form of the current page, followed as the page renders. */
function useSignInForm(active: boolean): HTMLFormElement | null {
  const [form, setForm] = useState<HTMLFormElement | null>(null)
  useEffect(() => {
    if (!active) {
      setForm(null)
      return
    }
    const update = () => setForm(findForm())
    update()
    const observer = new MutationObserver(update)
    observer.observe(document.body, { childList: true, subtree: true })
    return () => observer.disconnect()
  }, [active])
  return form
}

const prefilled = new WeakSet<HTMLFormElement>()

/** Types a value the way a person would, so the form's React state follows. */
function typeValue(input: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

/** Fills an untouched sign-in form once with the demo credentials (the password only when known). */
function prefill(form: HTMLFormElement, email: string, password: string | null): void {
  if (prefilled.has(form)) return
  prefilled.add(form)
  const user = form.querySelector<HTMLInputElement>('input[autocomplete="username"]')
  const secret = form.querySelector<HTMLInputElement>('input[type="password"]')
  if (!user || !secret || user.value || secret.value) return
  typeValue(user, email)
  if (password !== null) typeValue(secret, password)
}

/** Whether signing in returns to the administration: the sign-in goes to `next` when it is a safe page (`safeReturnPath`). */
function returnsToAdministration(search: string): boolean {
  return /^\/admin(?:[/?]|$)/.test(safeReturnPath(new URLSearchParams(search).get('next')))
}

/**
 * Demo help on the sign-in screen (/login): the credentials, right above the form, which arrives
 * filled in with them. They are the sample neighbor's, or the administrator's (James Okafor, the
 * president) when signing in returns to the administration (`/login?next=/admin…`, where the app
 * sends whoever opens it signed out). The screen itself is the app's; the notice is placed next to
 * its form so it needs no demo code. Once that account has chosen another password in My profile,
 * `demo` no longer works for it: the form then only gets the email.
 */
export function DemoSignInNotice() {
  const { rich } = useI18n()
  const location = useLocation()
  const signIn = location.pathname === '/login'
  const form = useSignInForm(signIn)
  const [host, setHost] = useState<HTMLElement | null>(null)
  const administration = signIn && returnsToAdministration(location.search)
  const account = castResident(administration ? ADMINISTRATOR_ID : SAMPLE_NEIGHBOR_ID)
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
    if (form) prefill(form, account.email, residentPasswordChanged(account.id) ? null : DEMO_PASSWORD)
  }, [form, account])
  if (!host || !signIn) return null
  return createPortal(<p className="notice demo-sign-in-notice" role="note">
    {administration
      ? rich('demo.signIn.admin', { strong }, { name: account.name, email: account.email, password: DEMO_PASSWORD })
      : rich('demo.signIn.resident', { strong }, { email: account.email, password: DEMO_PASSWORD })}
  </p>, host)
}
