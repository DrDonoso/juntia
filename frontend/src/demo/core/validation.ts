/**
 * Request bodies checked like the backend's pydantic contracts (src/juntia/contracts.py): unknown
 * fields are refused (`extra="forbid"`), lengths count characters like Python, names follow
 * `display_name` and phones `contact_phone`. A broken contract answers 422 `{"code":
 * "invalid_request"}` like FastAPI; routes that report fields (events, contacts, tags) map
 * {@link DemoValidationError.invalid} to their codes with `parseBody(…, { fields })`.
 *
 * ```ts
 * const input = parseBody(await readJson(request), body => ({
 *   name: body.name('name'),
 *   phone: body.phone('phone'),
 *   version: body.int('version'),
 * }))
 * ```
 */
import { isDay } from './clock'
import { DemoApiError } from './errors'

export const MAX_ID = 2_147_483_647

/** Invalid fields and pydantic-like error types (`missing`, `string_too_long`, `new_tags.0.name`…). */
export type InvalidFields = Readonly<Record<string, string>>

export class DemoValidationError extends DemoApiError {
  readonly invalid: InvalidFields

  constructor(invalid: InvalidFields, code = 'invalid_request', fields?: Readonly<Record<string, string>>) {
    super(code, 422, fields)
    this.name = 'DemoValidationError'
    this.invalid = invalid
  }
}

/** Characters as Python counts them (code points), for pydantic's `min_length`/`max_length`. */
export function characterCount(value: string): number {
  return [...value].length
}

export function hasControlCharacters(value: string): boolean {
  return Array.from(value).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
}

/** Backend `display_name`: visible characters, whitespace collapsed; null when invalid or blank. */
export function displayName(value: string): string | null {
  if (hasControlCharacters(value)) return null
  const collapsed = value.split(/\s+/).filter(Boolean).join(' ')
  return collapsed || null
}

/** Backend `contact_phone`: `''` for blank, the digits with an optional `+`, or null when invalid. */
export function normalizePhone(value: string): string | null {
  if (!value.trim()) return ''
  const normalized = value.replace(/[\s().-]/g, '')
  return /^\+?[0-9]{7,15}$/.test(normalized) ? normalized : null
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const DECIMAL = /^-?\d+(?:\.\d+)?$/

interface TextOptions {
  min?: number
  max: number
  /** Value when the field is absent (otherwise it is required). */
  fallback?: string
}

interface IntegerOptions {
  min?: number
  max?: number
  fallback?: number
}

/** One JSON object being validated: read every field with the helpers, then call {@link Body.done}. */
export class Body {
  private readonly record: Readonly<Record<string, unknown>>
  private readonly known = new Set<string>()
  private readonly issues: Record<string, string> = {}
  /** Fields present in the object (PATCH-like semantics). */
  readonly present: ReadonlySet<string>

  constructor(value: unknown) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new DemoValidationError({ body: 'model_attributes_type' })
    }
    this.record = value as Readonly<Record<string, unknown>>
    this.present = new Set(Object.keys(this.record))
  }

  /** Records `type` for `field` (the first error of a field wins); returns null for chaining. */
  fail(field: string, type: string): null {
    if (!this.failed(field)) this.issues[field] = type
    return null
  }

  /** Whether `field` already has an error. */
  failed(field: string): boolean {
    return Object.hasOwn(this.issues, field)
  }

  /** Records `type` for `field` unless `condition` holds (rules across fields). */
  check(condition: boolean, field: string, type = 'value_error'): void {
    if (!condition) this.fail(field, type)
  }

  /** The errors found so far. */
  get invalid(): InvalidFields {
    return { ...this.issues }
  }

  /** Throws the collected errors; fields nobody read are refused (`extra_forbidden`). */
  done(): void {
    for (const key of this.present) if (!this.known.has(key)) this.fail(key, 'extra_forbidden')
    if (Object.keys(this.issues).length > 0) throw new DemoValidationError(this.invalid)
  }

  /** The raw value of a field no helper covers (reading it makes it a known field). */
  raw(key: string): unknown {
    this.known.add(key)
    return Object.hasOwn(this.record, key) ? this.record[key] : undefined
  }

  private absent(key: string): boolean {
    return !Object.hasOwn(this.record, key)
  }

  /** A string with pydantic length limits (not stripped). */
  text(key: string, { min = 0, max, fallback }: TextOptions): string {
    const value = this.raw(key)
    if (this.absent(key)) return fallback ?? this.fail(key, 'missing') ?? ''
    if (typeof value !== 'string') return this.fail(key, 'string_type') ?? ''
    const count = characterCount(value)
    if (count < min) return this.fail(key, 'string_too_short') ?? ''
    if (count > max) return this.fail(key, 'string_too_long') ?? ''
    return value
  }

  /** `str | None = None`: absent or null is null. */
  optionalText(key: string, options: Omit<TextOptions, 'fallback'>): string | null {
    if (this.absent(key) || this.record[key] === null) {
      this.raw(key)
      return null
    }
    return this.text(key, options)
  }

  /** A name or label (`display_name`): 1 to `max` characters, visible, whitespace collapsed. */
  name(key: string, { max = 150, fallback }: { max?: number; fallback?: string } = {}): string {
    if (this.absent(key) && fallback !== undefined) {
      this.raw(key)
      return fallback
    }
    const value = this.text(key, { min: 1, max })
    if (this.failed(key)) return value
    return displayName(value) ?? this.fail(key, 'value_error') ?? ''
  }

  /** `EmailStr` of at most 254 characters, lower-cased like `EmailIn`. */
  email(key: string): string {
    const value = this.text(key, { max: 254 })
    if (this.failed(key)) return value
    return EMAIL.test(value) ? value.toLowerCase() : (this.fail(key, 'value_error') ?? '')
  }

  /** Optional phone (`contact_phone`, default `''`). */
  phone(key: string): string {
    const value = this.text(key, { max: 30, fallback: '' })
    if (this.failed(key)) return value
    return normalizePhone(value) ?? this.fail(key, 'value_error') ?? ''
  }

  /** A JSON integer within [min, max] (ids and versions: 1..2147483647 by default). */
  int(key: string, { min = 1, max = MAX_ID, fallback }: IntegerOptions = {}): number {
    const value = this.raw(key)
    if (this.absent(key)) return fallback ?? this.fail(key, 'missing') ?? 0
    if (typeof value !== 'number' || !Number.isInteger(value)) return this.fail(key, 'int_type') ?? 0
    if (value < min) return this.fail(key, 'greater_than_equal') ?? 0
    if (value > max) return this.fail(key, 'less_than_equal') ?? 0
    return value
  }

  /** `int | None = None`. */
  optionalInt(key: string, options: Omit<IntegerOptions, 'fallback'> = {}): number | null {
    if (this.absent(key) || this.record[key] === null) {
      this.raw(key)
      return null
    }
    return this.int(key, options)
  }

  bool(key: string, fallback?: boolean): boolean {
    const value = this.raw(key)
    if (this.absent(key)) return fallback ?? this.fail(key, 'missing') ?? false
    return typeof value === 'boolean' ? value : (this.fail(key, 'bool_type') ?? false)
  }

  literal<T extends string>(key: string, values: readonly T[], fallback?: T): T {
    const value = this.raw(key)
    if (this.absent(key)) return fallback ?? this.fail(key, 'missing') ?? values[0]
    return values.includes(value as T) ? (value as T) : (this.fail(key, 'literal_error') ?? values[0])
  }

  /** `Literal[...] | None = None`. */
  optionalLiteral<T extends string>(key: string, values: readonly T[]): T | null {
    if (this.absent(key) || this.record[key] === null) {
      this.raw(key)
      return null
    }
    return this.literal(key, values)
  }

  /** List of ids (default `[]` when absent). */
  ids(key: string, { max = 1000, unique = false }: { max?: number; unique?: boolean } = {}): number[] {
    const value = this.raw(key)
    if (this.absent(key)) return []
    if (!Array.isArray(value)) return this.fail(key, 'list_type') ?? []
    if (value.length > max) return this.fail(key, 'too_long') ?? []
    if (value.some(item => typeof item !== 'number' || !Number.isInteger(item) || item < 1 || item > MAX_ID)) {
      return this.fail(key, 'int_type') ?? []
    }
    if (unique && new Set(value).size !== value.length) return this.fail(key, 'value_error') ?? []
    return value as number[]
  }

  /**
   * A decimal (JSON number or numeric string) within [min, max] with at most `places` decimals,
   * returned as the API writes it (`'8.90'`); `nullable` fields are null when absent or null.
   */
  decimal(key: string, { min, max, places, nullable = false }: { min: number; max: number; places: number; nullable?: boolean }): string | null {
    const value = this.raw(key)
    if (this.absent(key) || value === null) return nullable ? null : this.fail(key, this.absent(key) ? 'missing' : 'decimal_type')
    const text = typeof value === 'number' && Number.isFinite(value) ? String(value) : typeof value === 'string' ? value.trim() : ''
    if (!DECIMAL.test(text)) return this.fail(key, 'decimal_parsing')
    const decimals = (text.split('.')[1] ?? '').replace(/0+$/, '')
    if (decimals.length > places) return this.fail(key, 'decimal_max_places')
    const number = Number(text)
    if (number < min) return this.fail(key, 'greater_than_equal')
    if (number > max) return this.fail(key, 'less_than_equal')
    return number.toFixed(places)
  }

  /** A calendar day `YYYY-MM-DD`; `nullable` fields are null when absent or null. */
  day(key: string, { nullable = false }: { nullable?: boolean } = {}): string | null {
    const value = this.raw(key)
    if (this.absent(key) || value === null) return nullable ? null : this.fail(key, this.absent(key) ? 'missing' : 'date_type')
    return typeof value === 'string' && isDay(value) ? value : this.fail(key, 'date_from_datetime_parsing')
  }

  /** List of objects, each read by `read`; item errors are recorded as `key.index.field`. */
  list<T>(key: string, { max, fallback = [] }: { max: number; fallback?: T[] }, read: (item: Body) => T): T[] {
    const value = this.raw(key)
    if (this.absent(key)) return fallback
    if (!Array.isArray(value)) return this.fail(key, 'list_type') ?? []
    if (value.length > max) return this.fail(key, 'too_long') ?? []
    const items: T[] = []
    value.forEach((entry, index) => {
      const item = this.nested(`${key}.${index}`, entry, read)
      if (item !== null) items.push(item)
    })
    return items
  }

  /** A nested object read by `read`; its errors are recorded as `key.field`. */
  object<T>(key: string, read: (item: Body) => T): T | null {
    const value = this.raw(key)
    if (this.absent(key)) return this.fail(key, 'missing')
    return this.nested(key, value, read)
  }

  private nested<T>(prefix: string, value: unknown, read: (item: Body) => T): T | null {
    try {
      const body = new Body(value)
      const result = read(body)
      body.done()
      return result
    } catch (error) {
      if (!(error instanceof DemoValidationError)) throw error
      for (const [field, type] of Object.entries(error.invalid)) {
        this.fail(field === 'body' ? prefix : `${prefix}.${field}`, field === 'body' ? 'model_type' : type)
      }
      return null
    }
  }
}

export interface ParseOptions {
  /** Error code instead of `invalid_request` (e.g. `dwelling_layout_invalid`). */
  code?: string
  /** Turns the invalid fields into the `fields` the route reports (events, contacts, tags). */
  fields?: (invalid: InvalidFields) => Readonly<Record<string, string>>
}

/** Validates a JSON value with `read`, which reads every field of the contract. */
export function parseBody<T>(value: unknown, read: (body: Body) => T, options: ParseOptions = {}): T {
  try {
    const body = new Body(value)
    const result = read(body)
    body.done()
    return result
  } catch (error) {
    if (!(error instanceof DemoValidationError)) throw error
    throw new DemoValidationError(error.invalid, options.code, options.fields?.(error.invalid))
  }
}
