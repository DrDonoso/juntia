/**
 * People data of the demo beyond the core identities of ../store/core.ts (neighbors and dwellings):
 * the layout of the Neighbors directory, the presidency and the passwords neighbors change during a
 * visit. It is built from the cast alone (`demoRandom('people:layout')` for the layout's ids), so
 * every visit starts from the same Maple Court.
 */
import type { DwellingLayout } from '../../api/schema.gen'
import { DWELLINGS, PRESIDENT_ID, type CastDwelling } from '../cast'
import { demoRandom } from '../core/random'

export interface PeopleScenario {
  /** The saved layout of the Neighbors directory and its optimistic version (backend `state.dwelling_layout*`). */
  layout: { version: number; layout: DwellingLayout | null }
  /** Holder of the presidency (an active neighbor, or null) and its optimistic version. */
  presidency: { presidentId: number | null; version: number }
  /** Passwords changed in My profile during this visit, by neighbor id; everybody else signs in with `demo`. */
  passwords: Map<number, string>
}

const ORDINAL_SUFFIXES: Readonly<Record<number, string>> = { 1: 'st', 2: 'nd', 3: 'rd' }

/** "Ground floor", "1st floor", "2nd floor"… */
export function floorName(floor: number): string {
  if (floor === 0) return 'Ground floor'
  const last = Math.abs(floor) % 100
  const suffix = last >= 11 && last <= 13 ? 'th' : ORDINAL_SUFFIXES[last % 10] ?? 'th'
  return `${floor}${suffix} floor`
}

/**
 * Maple Court as its administrator arranged it in Dwellings › Arrange dwellings: one zone, the top
 * floor first, one column per door (1A–1C … 4A–4C), floor names shown and column numbers hidden
 * (each dwelling's name already tells its door).
 */
export function mapleCourtLayout(dwellings: readonly CastDwelling[] = DWELLINGS): DwellingLayout {
  const random = demoRandom('people:layout')
  const positions = dwellings.flatMap(dwelling => {
    const match = /^(\d+)([A-Z])$/.exec(dwelling.label)
    return match ? [{ id: dwelling.id, floor: Number(match[1]), door: match[2] }] : []
  })
  const doors = [...new Set(positions.map(position => position.door))].sort()
  const floors = [...new Set(positions.map(position => position.floor))].sort((left, right) => right - left)
  return {
    zones: [{
      id: random.uuid(),
      name: 'Main building',
      columns: doors.length,
      rows: floors.map(floor => ({
        id: random.uuid(),
        name: floorName(floor),
        cells: doors.map(door => positions.find(position => position.floor === floor && position.door === door)?.id ?? null),
      })),
    }],
    show_row_names: true,
    show_column_names: false,
  }
}

export function peopleScenario(): PeopleScenario {
  return {
    // The administrator saved the layout once and elected James Okafor once: both versions are 1.
    layout: { version: 1, layout: mapleCourtLayout() },
    presidency: { presidentId: PRESIDENT_ID, version: 1 },
    passwords: new Map(),
  }
}
