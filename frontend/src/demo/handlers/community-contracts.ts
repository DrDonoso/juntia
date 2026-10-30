/**
 * Request contracts of the community routes (src/juntia/contracts.py) and the field codes the
 * backend reports for them (`community_events.validation_fields`, `contacts.validation_fields`).
 */
import { Body, DemoApiError, queryInts, type InvalidFields, type PathParams } from '../core'
import { canonicalUuid, labelName } from '../store/community-text'

/** Key of the errors a contract's model validator raises (pydantic's location `()`). */
export const MODEL = '__model__'

/** Whether every field so far is valid and known: pydantic only runs model validators then. */
export function valid(body: Body, fields: readonly string[]): boolean {
  return Object.keys(body.invalid).length === 0 && [...body.present].every(key => fields.includes(key))
}

/** `version: int = Field(ge=1)`. */
export function version(body: Body): number {
  return body.int('version')
}

/** `TagIn.name`: 1 to 100 characters, then NFKC, visible and still at most 100. */
export function tagName(body: Body, key = 'name'): string {
  const value = body.text(key, { min: 1, max: 100 })
  if (body.failed(key)) return value
  return labelName(value) ?? body.fail(key, 'value_error') ?? ''
}

/** `TagIn.color`: `#rrggbb`, lower-cased; `fallback` when absent (required without one). */
export function tagColor(body: Body, fallback?: string): string {
  const value = body.text('color', { max: 7, fallback })
  if (body.failed('color')) return value
  return /^#[0-9a-fA-F]{6}$/.test(value) ? value.toLowerCase() : (body.fail('color', 'string_pattern_mismatch') ?? '')
}

/** `contacts.validation_fields`: the field codes of contact and tag forms. */
export function contactFields(invalid: InvalidFields, { tag = false } = {}): Record<string, string> {
  const codes: Record<string, string> = {
    name: tag ? 'contact_tag_name_invalid' : 'contact_name_invalid',
    company: 'contact_company_invalid',
    email: 'contact_email_invalid',
    phone: 'contact_phone_invalid',
    notes: 'contact_notes_invalid',
    tags: 'contact_tags_invalid',
    color: 'contact_tag_color_invalid',
  }
  const fields: Record<string, string> = {}
  for (const [key, type] of Object.entries(invalid)) {
    if (type === 'contact_channel_required') {
      fields.email = fields.phone = 'contact_channel_required'
    } else if (type === 'contact_tags_invalid') {
      fields.tags = 'contact_tags_invalid'
    } else if (key === 'new_tags' || key.startsWith('new_tags.')) {
      const last = key.split('.').at(-1)
      fields.tags = last === 'name' ? 'contact_tag_name_invalid' : last === 'color' ? 'contact_tag_color_invalid' : 'contact_tags_invalid'
    } else if (Object.hasOwn(codes, key)) {
      fields[key] = codes[key]
    }
  }
  return fields
}

export const tagFields = (invalid: InvalidFields) => contactFields(invalid, { tag: true })

const EVENT_FIELDS = ['title', 'description', 'location', 'timezone', 'all_day', 'starts_at', 'ends_at', 'starts_on', 'ends_on', 'action_id']
const EVENT_SCHEDULE_FIELDS = ['starts_at', 'ends_at', 'starts_on', 'ends_on', 'all_day']

/** `community_events.validation_fields`: schedule fields report an invalid interval, the others an invalid field. */
export function eventFields(invalid: InvalidFields): Record<string, string> {
  const fields: Record<string, string> = {}
  for (const [key, type] of Object.entries(invalid)) {
    if (type === 'event_interval_invalid') fields.interval = 'event_interval_invalid'
    else if (EVENT_FIELDS.includes(key)) fields[key] = EVENT_SCHEDULE_FIELDS.includes(key) ? 'event_interval_invalid' : 'event_field_invalid'
  }
  return fields
}

/** A `UUID` path parameter in its canonical form (422 `invalid_request` otherwise). */
export function uuidParam(params: PathParams, name: string): string {
  const raw = params[name]
  const value = typeof raw === 'string' ? canonicalUuid(raw) : null
  if (value === null) throw new DemoApiError('invalid_request', 422)
  return value
}

/** Repeated id query parameter (`label=1&label=2`) of at most 20 values, like `Query(max_length=20)`. */
export function idList(url: URL, name: string, max = 20): number[] {
  const values = queryInts(url, name)
  if (values.length > max) throw new DemoApiError('invalid_request', 422)
  return values
}
