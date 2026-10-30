import { afterEach, expect, test, vi } from 'vitest'
import { setLanguage } from '../i18n'
import { ApiError, api, cache, clearPrivateData, codeMessage, downloadFile, errorMessage, signedOut } from './client'

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); cache.clear() })

function deferredResponse() {
  let resolveResponse: (response: Response) => void = () => { throw new Error('Response not initialized') }
  const promise = new Promise<Response>(resolve => { resolveResponse = resolve })
  return { promise, resolve: (response: Response) => resolveResponse(response) }
}

test('GET requests do not send a body and successful JSON is preserved', async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ amount: '42.10' })))
  vi.stubGlobal('fetch', fetcher)
  expect(await api('/summary')).toEqual({ amount: '42.10' })
  expect(fetcher.mock.calls[0][1]).not.toHaveProperty('body')
})

test('writes carry the anti-CSRF header and JSON content type', async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
  vi.stubGlobal('fetch', fetcher)
  await api('/admin/catalog/tags/1', 'DELETE')
  expect(fetcher.mock.calls[0][1].headers).toEqual({
    'X-Juntia-Request': '1', 'Content-Type': 'application/json',
  })
})

test('failed finance reads never become zero or demo data', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: 'internal_error' }), { status: 500 })))
  await expect(api('/summary')).rejects.toThrow('The operation could not be completed')
})

test.each([
  ['request_too_large', 413, 'size allowed'],
  ['request_busy', 503, 'operations are in progress'],
  ['request_storage_error', 503, 'could not be received'],
])('request limit error %s is localized and does not sign out the user', async (code, status, message) => {
  cache.setQueryData(['reader-auth'], { ...signedOut, authenticated: true, kind: 'resident', user_id: 1 })
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ code }), { status })))
  await expect(api('/contacts', 'POST', {})).rejects.toThrow(message)
  expect(cache.getQueryData(['reader-auth'])).toMatchObject({ authenticated: true, user_id: 1 })
})

test('expired admin sessions clear the privileged cache', async () => {
  cache.setQueryData(['auth'], { authenticated: true })
  cache.setQueryData(['admin', 'rules'], [{ name: 'Private' }])
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: 'authentication_required' }), { status: 401 })))
  await expect(api('/admin/rules')).rejects.toThrow('session')
  expect(cache.getQueryData(['admin', 'rules'])).toBeUndefined()
  expect(cache.getQueryData(['auth'])).toEqual({ authenticated: false, username: null })
})

test('expired reader sessions clear every private cache and authentication state', async () => {
  cache.setQueryData(['reader-auth'], { ...signedOut, authenticated: true, kind: 'resident', user_id: 1 })
  for (const key of ['summary', 'transactions', 'catalog', 'neighbors', 'actions', 'contacts']) cache.setQueryData([key], { private: true })
  cache.setQueryData(['general-settings'], { community_name: 'Public branding' })
  cache.setQueryData(['features'], { coefficient: false })
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: 'authentication_required' }), { status: 401 })))
  await expect(api('/summary')).rejects.toThrow('session')
  expect(cache.getQueryData(['reader-auth'])).toEqual(signedOut)
  for (const key of ['summary', 'transactions', 'catalog', 'neighbors', 'actions', 'contacts']) expect(cache.getQueryData([key])).toBeUndefined()
  expect(cache.getQueryData(['general-settings'])).toEqual({ community_name: 'Public branding' })
  expect(cache.getQueryData(['features'])).toEqual({ coefficient: false })
})

test('a failed administrator request does not sign out a resident', async () => {
  const resident = { ...signedOut, authenticated: true, kind: 'resident', user_id: 1 }
  cache.setQueryData(['reader-auth'], resident)
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: 'authentication_required' }), { status: 401 })))
  await expect(api('/admin/users')).rejects.toThrow('session')
  expect(cache.getQueryData(['reader-auth'])).toEqual(resident)
})

test.each(['/summary', '/neighbors', '/actions/items', '/contacts', '/contact-tags', '/contact-history', '/auth/profile', '/auth/session', '/admin/auth/session'])('an old response to %s cannot cross an identity change', async path => {
  const response = deferredResponse()
  vi.stubGlobal('fetch', vi.fn().mockReturnValue(response.promise))
  const pending = api(path)
  const rejected = expect(pending).rejects.toThrow('session has changed')
  await clearPrivateData()
  cache.setQueryData(['reader-auth'], { ...signedOut, authenticated: true, kind: 'resident', user_id: 2 })
  response.resolve(new Response(JSON.stringify({ private: 'previous user data' })))
  await rejected
  expect(cache.getQueryData(['reader-auth'])).toMatchObject({ user_id: 2, authenticated: true })
})

test('structured conflicts retain their code for an explicit editor reconciliation', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: 'action_stale' }), { status: 409 })))
  const pending = api('/actions/items/1', 'PATCH', { version: 1, title: 'Changed' })
  await expect(pending).rejects.toBeInstanceOf(ApiError)
  await expect(pending).rejects.toMatchObject({ code: 'action_stale', status: 409 })
})

test('field error codes are preserved without accepting non-string values', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
    code: 'invalid_request', fields: { email: 'contact_email_invalid', phone: 123, name: null },
  }), { status: 422 })))
  await expect(api('/contacts', 'POST', {})).rejects.toMatchObject({
    code: 'invalid_request', status: 422, fields: { email: 'contact_email_invalid' },
  })
})

test('a disabled actions response clears only action data and refreshes feature availability', async () => {
  cache.setQueryData(['features'], { actions: true, coefficient: true, events: false, google_login: false })
  cache.setQueryData(['actions', 'list'], { private: true })
  cache.setQueryData(['contacts', 'list'], { retained: true })
  cache.setQueryData(['summary'], { retained: true })
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: 'actions_disabled' }), { status: 404 })))
  await expect(api('/actions/items')).rejects.toMatchObject({ code: 'actions_disabled' })
  expect(cache.getQueryData(['actions', 'list'])).toBeUndefined()
  expect(cache.getQueryData(['features'])).toEqual({ actions: false, coefficient: true, events: false, google_login: false })
  expect(cache.getQueryData(['summary'])).toEqual({ retained: true })
  expect(cache.getQueryData(['contacts', 'list'])).toEqual({ retained: true })
})

test('private downloads use the authenticated API and release their object URL', async () => {
  const create = vi.fn(() => 'blob:synthetic-pdf'), revoke = vi.fn()
  class DownloadURL extends URL {
    static createObjectURL = create
    static revokeObjectURL = revoke
  }
  vi.stubGlobal('URL', DownloadURL)
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  const fetcher = vi.fn().mockResolvedValue(new Response('synthetic PDF', { headers: { 'content-type': 'application/pdf' } }))
  vi.stubGlobal('fetch', fetcher)
  await downloadFile('/actions/items/1/attachments/identifier/download', 'quote.pdf')
  expect(fetcher).toHaveBeenCalledWith('/api/actions/items/1/attachments/identifier/download', expect.objectContaining({ credentials: 'same-origin', method: 'GET' }))
  expect(click).toHaveBeenCalledOnce()
  expect(create).toHaveBeenCalledOnce()
  expect(revoke).toHaveBeenCalledWith('blob:synthetic-pdf')
  expect(document.querySelector('a[download]')).toBeNull()
})

test('a PDF finishing after an identity change is never offered for download', async () => {
  let finish: (blob: Blob) => void = () => { throw new Error('Body not started') }
  let markStarted: () => void = () => { throw new Error('Body signal not initialized') }
  const started = new Promise<void>(resolve => { markStarted = resolve })
  const body = new Promise<Blob>(resolve => { finish = resolve })
  const response = new Response('synthetic PDF')
  vi.spyOn(response, 'blob').mockImplementation(() => { markStarted(); return body })
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response))
  const pending = downloadFile('/actions/items/1/attachments/identifier/download', 'quote.pdf')
  const rejected = expect(pending).rejects.toMatchObject({ code: 'session_changed' })
  await started
  await clearPrivateData()
  finish(new Blob(['synthetic PDF']))
  await rejected
  expect(document.querySelector('a[download]')).toBeNull()
})

test('error messages follow the active language, including errors created before a switch', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ code: 'invalid_iban' }), { status: 422 })))
  const english = await api('/admin/imports/preview', 'POST', {}).catch((error: unknown) => error)
  expect(english).toBeInstanceOf(ApiError)
  expect((english as ApiError).message).toBe('The IBAN is incomplete or its check digits are not valid.')
  setLanguage('es')
  expect(errorMessage(english)).toBe('El IBAN está incompleto o sus dígitos de control no son válidos.')
  await expect(api('/admin/imports/preview', 'POST', {})).rejects.toThrow('El IBAN está incompleto o sus dígitos de control no son válidos.')
  expect(codeMessage('contact_email_invalid')).toBe('Escribe un correo electrónico válido, por ejemplo nombre@dominio.es.')
})

test.each(['teapot', '', 'constructor', 'toString', '__proto__', 'codes', 'generic'])('unknown error code %j falls back to a generic message', code => {
  expect(new ApiError(code, 418).message).toBe('The request could not be completed (418).')
  expect(errorMessage(new ApiError(code, 418))).toBe('The request could not be completed (418).')
  expect(codeMessage(code)).toBe('The operation could not be completed.')
})

test('errors without an API code keep their message or use the generic one', () => {
  expect(errorMessage(new TypeError('Failed to fetch'))).toBe('Failed to fetch')
  expect(errorMessage('unexpected')).toBe('The operation could not be completed.')
  setLanguage('es')
  expect(errorMessage(null)).toBe('No se ha podido completar la operación.')
})
