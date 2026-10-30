/**
 * The community's time zone (the backend's `TZ`, Europe/Madrid by default): events are entered in
 * its wall-clock time and stored as UTC instants, and the agenda's "today" is its calendar day.
 * Calendar days are counted from 1970-01-01 like the backend's `CALENDAR_EPOCH` day numbers.
 */

export const COMMUNITY_TIME_ZONE = 'Europe/Madrid'

export const DAY_MS = 86_400_000

/** A wall-clock date and time (a naive datetime). */
export interface WallClock {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
  millisecond: number
}

const formats = new Map<string, Intl.DateTimeFormat>()

function format(zone: string): Intl.DateTimeFormat {
  let value = formats.get(zone)
  if (!value) {
    value = new Intl.DateTimeFormat('en-US', {
      timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: 'numeric', second: 'numeric',
    })
    formats.set(zone, value)
  }
  return value
}

const pad = (value: number, length = 2) => String(value).padStart(length, '0')

/** Wall-clock time of an instant (milliseconds since the epoch) in a zone. */
export function wallClock(instant: number, zone = COMMUNITY_TIME_ZONE): WallClock {
  const parts = format(zone).formatToParts(new Date(instant))
  const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find(item => item.type === type)?.value)
  return {
    year: part('year'), month: part('month'), day: part('day'), hour: part('hour'), minute: part('minute'),
    second: part('second'), millisecond: ((instant % 1000) + 1000) % 1000,
  }
}

/** The wall-clock time read as if it were UTC: comparable, and the base of zone offsets. */
export function wallClockValue(clock: WallClock): number {
  const date = new Date(0)
  date.setUTCFullYear(clock.year, clock.month - 1, clock.day)
  date.setUTCHours(clock.hour, clock.minute, clock.second, clock.millisecond)
  return date.getTime()
}

/** `YYYY-MM-DD` of a wall-clock time. */
export function clockDay(clock: WallClock): string {
  return `${pad(clock.year, 4)}-${pad(clock.month)}-${pad(clock.day)}`
}

/** Calendar day of an instant in the zone. */
export function zonedDay(instant: number, zone = COMMUNITY_TIME_ZONE): string {
  return clockDay(wallClock(instant, zone))
}

/** Sortable wall-clock time of an instant in the zone (`YYYY-MM-DDTHH:MM:SS.mmm`). */
export function zonedDateTime(instant: number, zone = COMMUNITY_TIME_ZONE): string {
  const clock = wallClock(instant, zone)
  return `${clockDay(clock)}T${pad(clock.hour)}:${pad(clock.minute)}:${pad(clock.second)}.${pad(clock.millisecond, 3)}`
}

function offset(instant: number, zone: string): number {
  const whole = Math.floor(instant / 1000) * 1000
  return wallClockValue({ ...wallClock(whole, zone), millisecond: 0 }) - whole
}

/**
 * The instants whose wall-clock time in the zone is `clock` (backend `local_to_utc`): none when a
 * daylight saving change skips it, two when it happens twice, otherwise one.
 */
export function zonedInstants(clock: WallClock, zone = COMMUNITY_TIME_ZONE): number[] {
  const naive = wallClockValue(clock)
  // Any daylight saving change is months away from another one: the offsets a day around cover both sides.
  const candidates = new Set([-DAY_MS, 0, DAY_MS].map(shift => naive - offset(naive + shift, zone)))
  return [...candidates].filter(instant => wallClockValue(wallClock(instant, zone)) === naive).sort((a, b) => a - b)
}

/** API instant (`2026-11-05T18:00:00Z`, like the backend) of a wall-clock day and `HH:MM` in the zone. */
export function zonedInstant(day: string, time: string, zone = COMMUNITY_TIME_ZONE): string {
  const [year, month, date] = day.split('-').map(Number)
  const [hour, minute] = time.split(':').map(Number)
  const instants = zonedInstants({ year, month, day: date, hour, minute, second: 0, millisecond: 0 }, zone)
  if (instants.length !== 1) throw new Error(`${day} ${time} is not a single instant in ${zone}`)
  return apiInstant(instants[0])
}

/** An instant as the backend writes it: UTC, `Z`, milliseconds only when there are some. */
export function apiInstant(instant: number): string {
  return new Date(instant).toISOString().replace('.000Z', 'Z')
}

/** Days from 1970-01-01 to a `YYYY-MM-DD` day. */
export function dayNumber(day: string): number {
  const [year, month, date] = day.split('-').map(Number)
  return Math.round(wallClockValue({ year, month, day: date, hour: 0, minute: 0, second: 0, millisecond: 0 }) / DAY_MS)
}

/** The `YYYY-MM-DD` day `number` days after 1970-01-01. */
export function dayOfNumber(number: number): string {
  const date = new Date(number * DAY_MS)
  return `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`
}
