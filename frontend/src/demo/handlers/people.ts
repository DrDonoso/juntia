/**
 * People endpoints of the demo API (the routes ../README.md assigns to people), after
 * src/juntia/users.py, api.py and queries.py: the Neighbors directory and its layout, dwellings,
 * the presidency and the general settings and feature flags here; the users administration in
 * people-users.ts; the neighbor's own account (profile, password, sessions, invitation and recovery
 * links, Google) in people-account.ts.
 */
import type {
  DwellingLayout, DwellingLayoutLimits, DwellingLayoutOut, DwellingLayoutRow, DwellingLayoutZone, DwellingNeighborsOut,
  DwellingOut, FeatureFlagsOut, GeneralSettings, PresidencyOut,
} from '../../api/schema.gen'
import {
  Body, DemoApiError, MAX_ID, displayName, hasControlCharacters, http, parseBody, readJson, route, type HttpHandler,
} from '../core'
import { coreStore, findDwelling, findResident, type DemoDwelling } from '../store/core'
import { peopleStore } from '../store/people'
import { featureFlags } from './core'
import { peopleAccountHandlers } from './people-account'
import { POSITIVE, anyIdParam, visibleCoefficient } from './people-shared'
import { peopleUserHandlers } from './people-users'

// --- Sorting (backend queries.dwelling_sort_key and query_sql.fold_text) ---

/** Case- and accent-insensitive form of a text (casefold, NFKD, no combining marks). */
function foldText(value: string): string {
  return value.toLowerCase().normalize('NFKD').replace(/\p{Mn}/gu, '')
}

type NaturalPart = readonly [number, number, string]
type DwellingSortKey = readonly [number, number, readonly NaturalPart[], string]

const compareText = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0

function naturalParts(value: string): NaturalPart[] {
  return value.split(/([0-9]+)/).filter(part => part.trim())
    .map(part => /^[0-9]+$/.test(part) ? [0, Number(part), ''] as const : [1, 0, part.trim()] as const)
}

/**
 * Natural order of dwelling names, floor by floor: `-1`, ground floor, mezzanine, `1A`, `1B`… `10A`,
 * attic, then any other name. The words are the backend's (Spanish floor names); the demo's names
 * (`1A`…`4C`) are numbered floors.
 */
function dwellingSortKey(label: string): DwellingSortKey {
  const text = foldText(label.replace(/[\u00aa\u00b0\u00ba]/g, '')).replace(/[.,/]+/g, ' ').trim()
  const floor = /^(?:(?:piso|planta)\s*)?(-?[0-9]+)\s*[- ]*(.*)$/.exec(text)
  if (floor) return [0, Number(floor[1]) * 2, naturalParts(floor[2]), text]
  const ground = /^(?:bajos?|pb|planta baja)(?:\s+(.*))?$/.exec(text)
  if (ground) return [0, 0, naturalParts(ground[1] ?? ''), text]
  const mezzanine = /^entresuelo(?:\s+(.*))?$/.exec(text)
  // Numbered floors are doubled so the mezzanine fits between the ground and first floors.
  if (mezzanine) return [0, 1, naturalParts(mezzanine[1] ?? ''), text]
  const attic = /^atico(?:\s+(.*))?$/.exec(text)
  if (attic) return [1, 0, naturalParts(attic[1] ?? ''), text]
  return [2, 0, naturalParts(text), text]
}

function compareParts(left: readonly NaturalPart[], right: readonly NaturalPart[]): number {
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    const [a, b] = [left[index], right[index]]
    const compared = a[0] - b[0] || a[1] - b[1] || compareText(a[2], b[2])
    if (compared) return compared
  }
  return left.length - right.length
}

/** Order of dwelling names in the directory and the dwellings list. */
function compareDwellingLabels(left: string, right: string): number {
  const [a, b] = [dwellingSortKey(left), dwellingSortKey(right)]
  return a[0] - b[0] || a[1] - b[1] || compareParts(a[2], b[2]) || compareText(a[3], b[3]) || compareText(left, right)
}

function sortedDwellings(): DemoDwelling[] {
  return [...coreStore().dwellings].sort((left, right) => compareDwellingLabels(left.label, right.label) || left.id - right.id)
}

// --- Neighbors directory and layout ---

/** `GET /api/neighbors`: every dwelling with its active neighbors (name order), the president marked. */
function neighborDirectory(): DwellingNeighborsOut[] {
  const { residents } = coreStore()
  const { presidentId } = peopleStore().presidency
  return sortedDwellings().map(dwelling => ({
    id: dwelling.id,
    label: dwelling.label,
    neighbors: residents
      .filter(resident => resident.dwellingId === dwelling.id && resident.activated && !resident.disabled)
      .sort((left, right) => compareText(foldText(left.name), foldText(right.name)) || left.id - right.id)
      .map(resident => ({
        id: resident.id, name: resident.name, email: resident.email, phone: resident.phone,
        is_president: resident.id === presidentId,
      })),
  }))
}

/** `contracts.LAYOUT_LIMITS`, also announced to the layout editor. */
const LAYOUT_LIMITS: DwellingLayoutLimits = { zones: 50, rows: 100, columns: 24, cells: 10000 }

const LAYOUT_ID = /^[A-Za-z0-9_-]+$/

function layoutOut(): DwellingLayoutOut {
  const { version, layout } = peopleStore().layout
  return { version, layout, limits: { ...LAYOUT_LIMITS } }
}

function layoutId(body: Body, key: string): string {
  const value = body.text(key, { min: 1, max: 64 })
  if (!body.failed(key) && !LAYOUT_ID.test(value)) body.fail(key, 'string_pattern_mismatch')
  return value
}

/** A list field without a default (`min` items at least). */
function requiredList<T>(body: Body, key: string, { min, max }: { min: number; max: number }, read: (item: Body) => T): T[] {
  const value = body.raw(key)
  if (value === undefined) return body.fail(key, 'missing') ?? []
  if (Array.isArray(value) && value.length < min) return body.fail(key, 'too_short') ?? []
  return body.list(key, { max }, read)
}

/** `cells`: 1 to 24 dwelling ids (strict integers) or nulls for gaps. */
function layoutCells(body: Body): (number | null)[] {
  const value = body.raw('cells')
  if (value === undefined) return body.fail('cells', 'missing') ?? []
  if (!Array.isArray(value)) return body.fail('cells', 'list_type') ?? []
  if (value.length < 1) return body.fail('cells', 'too_short') ?? []
  if (value.length > LAYOUT_LIMITS.columns) return body.fail('cells', 'too_long') ?? []
  return value.map((cell: unknown, index) => {
    if (cell === null) return null
    if (typeof cell !== 'number' || !Number.isInteger(cell)) return body.fail(`cells.${index}`, 'int_type')
    if (cell < 1 || cell > MAX_ID) return body.fail(`cells.${index}`, cell < 1 ? 'greater_than_equal' : 'less_than_equal')
    return cell
  })
}

function layoutRow(body: Body): DwellingLayoutRow {
  const id = layoutId(body, 'id')
  const raw = body.text('name', { max: 150 })
  // Optional name: empty, or a visible name with its whitespace collapsed.
  const name = body.failed('name') || raw === '' ? '' : displayName(raw) ?? body.fail('name', 'value_error') ?? ''
  return { id, name, cells: layoutCells(body) }
}

function layoutZone(body: Body): DwellingLayoutZone {
  const id = layoutId(body, 'id')
  const name = body.name('name', { max: 150 })
  const columns = body.int('columns', { min: 1, max: LAYOUT_LIMITS.columns })
  const rows = requiredList(body, 'rows', { min: 1, max: LAYOUT_LIMITS.rows }, layoutRow)
  if (!body.failed('columns') && rows.some(row => row.cells.length !== columns)) body.fail('rows', 'value_error')
  return { id, name, columns, rows }
}

function dwellingLayout(body: Body): DwellingLayout {
  const zones = requiredList(body, 'zones', { min: 0, max: LAYOUT_LIMITS.zones }, layoutZone)
  const layout = { zones, show_row_names: body.bool('show_row_names', false), show_column_names: body.bool('show_column_names', false) }
  const cells = zones.flatMap(zone => zone.rows.flatMap(row => row.cells))
  const unique = (values: readonly unknown[]) => new Set(values).size === values.length
  if (
    cells.length > LAYOUT_LIMITS.cells || !unique(zones.map(zone => zone.id))
    || !unique(zones.flatMap(zone => zone.rows.map(row => row.id))) || !unique(cells.filter(cell => cell !== null))
  ) body.fail('zones', 'value_error')
  return layout
}

/** `PUT /api/admin/dwellings/layout`: any broken contract is 422 `dwelling_layout_invalid`. */
async function saveLayout(request: Request): Promise<DwellingLayoutOut> {
  let json: unknown
  try {
    json = await readJson(request)
  } catch {
    throw new DemoApiError('dwelling_layout_invalid')
  }
  const input = parseBody(json, body => ({
    version: body.int('version', { min: 0, max: 2_147_483_646 }),
    layout: body.object('layout', dwellingLayout),
  }), { code: 'dwelling_layout_invalid' })
  if (!input.layout) throw new DemoApiError('dwelling_layout_invalid')
  const placed = input.layout.zones.flatMap(zone => zone.rows.flatMap(row => row.cells)).filter(cell => cell !== null)
  if (placed.some(id => !findDwelling(id))) throw new DemoApiError('dwelling_layout_missing')
  const saved = peopleStore().layout
  if (saved.version !== input.version) throw new DemoApiError('dwelling_layout_stale', 409)
  saved.layout = input.layout
  saved.version += 1
  return layoutOut()
}

// --- Dwellings ---

function dwellingOut(dwelling: DemoDwelling): DwellingOut {
  return {
    label: dwelling.label,
    coefficient: visibleCoefficient(dwelling),
    id: dwelling.id,
    version: dwelling.version,
    user_count: coreStore().residents.filter(resident => resident.dwellingId === dwelling.id).length,
  }
}

interface DwellingInput {
  label: string
  coefficient: string | null
  /** Whether the body had `coefficient` (even null), like pydantic's `model_fields_set`. */
  coefficientSupplied: boolean
}

function dwellingInput(body: Body): DwellingInput {
  return {
    label: body.name('label', { max: 150 }),
    coefficient: body.decimal('coefficient', { min: 0, max: 100, places: 2, nullable: true }),
    coefficientSupplied: body.present.has('coefficient'),
  }
}

/** Backend `coefficient_update`: required while the feature is on, refused while it is off. */
function coefficientUpdate(input: DwellingInput, existing: string | null): string | null {
  if (!coreStore().features.coefficient) {
    if (input.coefficientSupplied) throw new DemoApiError('coefficient_disabled', 409)
    return existing
  }
  const value = input.coefficientSupplied ? input.coefficient : existing
  if (value === null) throw new DemoApiError('coefficient_required')
  return value
}

/** Dwelling names are unique (the database's unique index: 409 `record_conflict`). */
function requireFreeLabel(label: string, self?: DemoDwelling): void {
  if (coreStore().dwellings.some(dwelling => dwelling !== self && dwelling.label === label)) throw new DemoApiError('record_conflict', 409)
}

// --- Presidency ---

function presidencyOut(): PresidencyOut {
  const { presidentId, version } = peopleStore().presidency
  const president = presidentId === null ? undefined : findResident(presidentId)
  const dwelling = president && findDwelling(president.dwellingId)
  return {
    president: president && dwelling
      ? { id: president.id, name: president.name, dwelling_id: dwelling.id, dwelling_label: dwelling.label }
      : null,
    version,
  }
}

// --- Settings ---

/** `GeneralSettings.community_name`: 1 to 150 characters, whitespace collapsed, visible characters only. */
function communityName(body: Body): string {
  const value = body.text('community_name', { min: 1, max: 150 })
  if (body.failed('community_name')) return value
  const name = value.split(/\s+/).filter(Boolean).join(' ')
  return name && !hasControlCharacters(name) ? name : body.fail('community_name', 'value_error') ?? ''
}

const FEATURES = ['coefficient', 'actions', 'events'] as const

const structureHandlers: HttpHandler[] = [
  http.get('/api/neighbors', route('session', () => neighborDirectory())),
  http.get('/api/neighbors/layout', route('session', () => layoutOut())),
  http.put('/api/admin/dwellings/layout', route('admin', ({ request }) => saveLayout(request))),
  http.get('/api/admin/dwellings', route('admin', () => sortedDwellings().map(dwellingOut))),
  http.post('/api/admin/dwellings', route('admin', async ({ request }) => {
    const input = parseBody(await readJson(request), dwellingInput)
    const coefficient = coefficientUpdate(input, null)
    requireFreeLabel(input.label)
    const { dwellings, sequences } = coreStore()
    const dwelling: DemoDwelling = { id: sequences.dwelling.next(), label: input.label, coefficient, version: 1 }
    dwellings.push(dwelling)
    return dwellingOut(dwelling)
  }, { status: 201 })),
  http.patch('/api/admin/dwellings/:dwellingId', route('admin', async ({ request, params }) => {
    const id = anyIdParam(params, 'dwellingId')
    const input = parseBody(await readJson(request), body => ({ ...dwellingInput(body), version: body.int('version', POSITIVE) }))
    const dwelling = findDwelling(id)
    if (!dwelling) throw new DemoApiError('dwelling_not_found', 404)
    if (dwelling.version !== input.version) throw new DemoApiError('record_stale', 409)
    const coefficient = coefficientUpdate(input, dwelling.coefficient)
    requireFreeLabel(input.label, dwelling)
    dwelling.label = input.label
    dwelling.coefficient = coefficient
    dwelling.version += 1
    return dwellingOut(dwelling)
  })),
  http.get('/api/admin/presidency', route('admin', () => presidencyOut())),
  http.put('/api/admin/presidency', route('admin', async ({ request }) => {
    const input = parseBody(await readJson(request), body => {
      if (!body.present.has('user_id')) body.fail('user_id', 'missing')
      return {
        userId: body.optionalInt('user_id', { min: 1, max: MAX_ID }),
        version: body.int('version', { min: 0, max: 2_147_483_646 }),
      }
    })
    if (input.userId !== null) {
      const candidate = findResident(input.userId)
      if (!candidate) throw new DemoApiError('user_not_found', 404)
      if (candidate.disabled || !candidate.activated) throw new DemoApiError('presidency_inactive', 409)
    }
    const { presidency } = peopleStore()
    if (presidency.version !== input.version) throw new DemoApiError('presidency_stale', 409)
    presidency.presidentId = input.userId
    presidency.version += 1
    return presidencyOut()
  })),
  http.patch('/api/admin/settings/general', route('admin', async ({ request }): Promise<GeneralSettings> => {
    const { general } = coreStore()
    general.community_name = parseBody(await readJson(request), communityName)
    return { ...general }
  })),
  http.patch('/api/admin/settings/features/:feature', route('admin', async ({ request, params }): Promise<FeatureFlagsOut> => {
    const feature = FEATURES.find(name => name === params.feature)
    if (!feature) throw new DemoApiError('invalid_request')
    coreStore().features[feature] = parseBody(await readJson(request), body => body.bool('enabled'))
    return featureFlags()
  })),
]

export const peopleHandlers: HttpHandler[] = [...structureHandlers, ...peopleUserHandlers, ...peopleAccountHandlers]
