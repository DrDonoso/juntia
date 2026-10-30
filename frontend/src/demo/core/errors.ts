/**
 * An API error answered like the backend's `AppError` (src/juntia/errors.py): JSON
 * `{"code": "...", "fields": {...}}` with the HTTP status, 422 by default, and `fields` only when
 * there are some. The frontend translates the code (`errors.codes.<code>`) and reads the fields.
 */
export class DemoApiError extends Error {
  readonly code: string
  readonly status: number
  readonly fields?: Readonly<Record<string, string>>

  constructor(code: string, status = 422, fields?: Readonly<Record<string, string>>) {
    super(`${code} (${status})`)
    this.name = 'DemoApiError'
    this.code = code
    this.status = status
    this.fields = fields
  }

  /** The JSON body the backend would send. */
  get payload(): { code: string; fields?: Readonly<Record<string, string>> } {
    return this.fields && Object.keys(this.fields).length > 0 ? { code: this.code, fields: this.fields } : { code: this.code }
  }
}

/** Error code of features that need real infrastructure (email, Google, AI, real PDF parsing). */
export const DEMO_UNAVAILABLE = 'demo_unavailable'

/** HTTP status of {@link DEMO_UNAVAILABLE}: refused on purpose, unlike the catch-all's 501 for a missing handler. */
export const DEMO_UNAVAILABLE_STATUS = 403
