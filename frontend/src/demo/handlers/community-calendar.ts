/**
 * Calendar exports of an event (src/juntia/event_calendar.py): the Google Calendar link and the
 * iCalendar file, written like the backend's `icalendar` library writes it (property order, TEXT
 * escaping, CRLF lines folded at 75 octets) so calendar apps get the same file from the demo.
 */
import type { EventCalendarOut } from '../../api/schema.gen'
import type { DemoEvent } from '../store/community-model'

/** Longest Google Calendar link the backend hands out. */
export const GOOGLE_URL_LIMIT = 8000

/** `20261105T180000Z`. */
function compactInstant(value: string): string {
  return new Date(value).toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/[-:]/g, '')
}

/** `20261105`. */
function compactDay(value: string): string {
  return value.replaceAll('-', '')
}

function interval(event: DemoEvent): [string, string] {
  return event.allDay
    ? [compactDay(event.startsOn ?? ''), compactDay(event.endsOn ?? '')]
    : [compactInstant(event.startsAt ?? ''), compactInstant(event.endsAt ?? '')]
}

/** Python's `quote_plus`: only letters, digits and `_.-~` stay; spaces become `+`. */
function quotePlus(value: string): string {
  return encodeURIComponent(value)
    .replace(/[!'()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)
    .replaceAll('%20', '+')
}

export function eventUrl(event: DemoEvent, origin: string): string {
  return `${origin}/events/${event.id}`
}

/** `calendar_links`: a prefilled Google Calendar page, unless the link would be too long. */
export function googleCalendar(event: DemoEvent, origin: string, zone: string): EventCalendarOut {
  const [start, end] = interval(event)
  const query: [string, string][] = [
    ['action', 'TEMPLATE'], ['text', event.title], ['dates', `${start}/${end}`], ['ctz', zone],
    ['details', `${event.description}\n\n${eventUrl(event, origin)}`.trim()], ['location', event.location],
  ]
  const url = `https://calendar.google.com/calendar/render?${query.map(([key, value]) => `${key}=${quotePlus(value)}`).join('&')}`
  return url.length > GOOGLE_URL_LIMIT ? { google_url: null, google_error: 'event_calendar_too_long' } : { google_url: url, google_error: null }
}

/** iCalendar TEXT escaping (`icalendar.parser._escape_char`, in its order). */
export function escapeText(value: string): string {
  return value.replaceAll('\\N', '\n').replaceAll('\\', '\\\\').replaceAll(';', '\\;').replaceAll(',', '\\,')
    .replaceAll('\r\n', '\\n').replaceAll('\n', '\\n').replaceAll('\r', '\\n')
}

function octets(character: string): number {
  const code = character.codePointAt(0) ?? 0
  return code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4
}

/**
 * RFC 5545 folding like `icalendar.parser._foldline`: lines of at most 75 octets, continued after
 * CRLF and a space, never splitting a character nor leaving an escape's backslash at a line end.
 */
export function foldLine(line: string): string {
  const lines: string[] = []
  let current: string[] = []
  let size = 0
  for (const character of line) {
    const length = octets(character)
    if (current.length > 0 && size + length >= 75) {
      const last = current.at(-1)
      if (current.length > 1 && (last === '\\' || last === '^')) {
        current.pop()
        lines.push(current.join(''))
        current = [last]
        size = 1
      } else {
        lines.push(current.join(''))
        current = []
        size = 0
      }
    }
    current.push(character)
    size += length
  }
  if (current.length > 0) lines.push(current.join(''))
  return lines.join('\r\n ')
}

/** `calendar_file`: one VEVENT; its UID stays and its SEQUENCE grows with every saved change. */
export function calendarFile(event: DemoEvent, origin: string): string {
  const [start, end] = interval(event)
  const value = event.allDay ? ';VALUE=DATE:' : ':'
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Juntia//Community events//EN', 'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    `SUMMARY:${escapeText(event.title)}`,
    `DTSTART${value}${start}`,
    `DTEND${value}${end}`,
    `DTSTAMP:${compactInstant(event.updatedAt)}`,
    `UID:${escapeText(`${event.calendarUid}@juntia`)}`,
    `SEQUENCE:${event.version - 1}`,
    `CREATED:${compactInstant(event.createdAt)}`,
    `DESCRIPTION:${escapeText(event.description)}`,
    `LAST-MODIFIED:${compactInstant(event.updatedAt)}`,
    `LOCATION:${escapeText(event.location)}`,
    `URL:${eventUrl(event, origin)}`,
    'END:VEVENT', 'END:VCALENDAR',
  ]
  return lines.map(foldLine).join('\r\n') + '\r\n'
}
