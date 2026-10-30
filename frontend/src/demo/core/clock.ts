/**
 * The demo's "now": every date of the scenario is relative to it, so the data always reaches the
 * visitor's today. Calendar days are local `YYYY-MM-DD` strings (like the API's dates); instants are
 * ISO 8601 strings in UTC (like the API's datetimes). Tests pin the clock with `resetDemo({ now })`.
 */

let clock: () => Date = () => new Date()

/** Pins the clock (tests); without an argument the demo follows the real time again. */
export function setClock(next?: () => Date): void {
  clock = next ?? (() => new Date())
}

/** Current instant. */
export function now(): Date {
  return clock()
}

/** Current instant as the API writes datetimes. */
export function nowIso(): string {
  return now().toISOString()
}

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/

const pad = (value: number, length = 2) => String(value).padStart(length, '0')

/** Local calendar day of an instant. */
export function isoDay(date: Date): string {
  return `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** Today's local calendar day. */
export function today(): string {
  return isoDay(now())
}

/** Whether `value` is a real calendar day written `YYYY-MM-DD`. */
export function isDay(value: string): boolean {
  const match = DAY.exec(value)
  if (!match) return false
  const [year, month, day] = match.slice(1).map(Number)
  const date = new Date(year, month - 1, day, 12)
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day
}

/** Local noon of a calendar day (noon, so that adding days never trips over a DST change). */
export function parseDay(value: string): Date {
  if (!isDay(value)) throw new Error(`Invalid calendar day: ${value}`)
  const [year, month, day] = value.split('-').map(Number)
  return new Date(year, month - 1, day, 12)
}

export function addDays(day: string, days: number): string {
  const date = parseDay(day)
  date.setDate(date.getDate() + days)
  return isoDay(date)
}

/** Same day of the month `months` later (or earlier), clamped to the length of that month. */
export function addMonths(day: string, months: number): string {
  const date = parseDay(day)
  const target = new Date(date.getFullYear(), date.getMonth() + months, 1, 12)
  const length = new Date(target.getFullYear(), target.getMonth() + 1, 0, 12).getDate()
  target.setDate(Math.min(date.getDate(), length))
  return isoDay(target)
}

/** The day `days` before today. */
export function daysAgo(days: number): string {
  return addDays(today(), -days)
}

/** The day `days` after today. */
export function daysAhead(days: number): string {
  return addDays(today(), days)
}

/** Today's day of the month, `months` before today (clamped to that month's length). */
export function monthsAgo(months: number): string {
  return addMonths(today(), -months)
}

/** First day of the month of `day`. */
export function startOfMonth(day: string): string {
  return `${day.slice(0, 7)}-01`
}

/** Last day of the month of `day`. */
export function endOfMonth(day: string): string {
  return addDays(addMonths(startOfMonth(day), 1), -1)
}

/** Whole days from `from` to `to` (negative when `to` is earlier). */
export function daysBetween(from: string, to: string): number {
  return Math.round((parseDay(to).getTime() - parseDay(from).getTime()) / 86_400_000)
}

/** API instant of a local calendar day and time (`HH:MM`), e.g. `instant(daysAgo(3), '18:30')`. */
export function instant(day: string, time = '12:00'): string {
  const match = /^(\d{2}):(\d{2})$/.exec(time)
  if (!match) throw new Error(`Invalid time: ${time}`)
  const date = parseDay(day)
  date.setHours(Number(match[1]), Number(match[2]), 0, 0)
  return date.toISOString()
}

/** API instant `hours` after now (negative: before now). */
export function hoursFromNow(hours: number): string {
  return new Date(now().getTime() + hours * 3_600_000).toISOString()
}
