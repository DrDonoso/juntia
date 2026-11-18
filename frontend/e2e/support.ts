import { expect, type Page } from '@playwright/test'

/**
 * The administrator account that `scripts/smoke_server.py` creates, without a dwelling. Against another
 * server (`E2E_BASE_URL`), `E2E_ADMIN_EMAIL` and `E2E_ADMIN_PASSWORD` name one of its administrators.
 */
export const administrator = {
  name: 'Browser Test',
  email: process.env.E2E_ADMIN_EMAIL || 'browser-test@example.org',
  password: process.env.E2E_ADMIN_PASSWORD || 'synthetic-browser-test-password',
}

/** Headers of a write request from `page`: same origin, and the header that guards against CSRF. */
export function writeHeaders(page: Page) {
  return { Origin: new URL(page.url()).origin, 'X-Juntia-Request': '1' }
}

/**
 * Signs in as the administrator at /login and waits for `path` to open (the administration by default).
 * Every sign-in counts towards the login throttle, so on the smoke server the attempts start afresh.
 */
export async function signInAsAdministrator(page: Page, path = '/admin') {
  await page.goto(`/login?next=${encodeURIComponent(path)}`)
  await page.getByLabel('Email', { exact: true }).fill(administrator.email)
  await page.getByLabel('Password', { exact: true }).fill(administrator.password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await page.waitForURL(url => url.pathname + url.search === path)
  if (process.env.E2E_BASE_URL) return
  const reset = await page.request.post('/api/admin/test-reset-login-attempts', { headers: writeHeaders(page) })
  expect(reset.status()).toBe(204)
}
