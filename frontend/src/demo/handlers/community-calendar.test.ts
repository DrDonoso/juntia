import { describe, expect, test } from 'vitest'
import type { DemoEvent } from '../store/community-model'
import { GOOGLE_URL_LIMIT, calendarFile, escapeText, foldLine, googleCalendar } from './community-calendar'

// References written by the backend's event_calendar.py (icalendar 7) for the same events.
const ORIGIN = 'https://demo.example.com'

const base: DemoEvent = {
  id: 7, calendarUid: '0f8fad5b-d9cb-469f-a165-70867728950e', title: '', description: '', location: '', allDay: false,
  startsAt: null, endsAt: null, startsOn: null, endsOn: null, actionId: null,
  author: { kind: 'administrator', name: 'Technical administrator', user_id: null }, version: 1,
  createdAt: '2026-10-01T08:00:00.000Z', updatedAt: '2026-10-20T09:15:30.123Z', deletedAt: null,
}

const timed: DemoEvent = {
  ...base, startsAt: '2026-11-05T18:00:00Z', endsAt: '2026-11-05T19:30:00Z', version: 3,
  title: "Residents' meeting; budget, roof & lift", location: 'Community room, ground floor',
  description: `Agenda:\n1. Roof repair, quotes\n2. Lift modernisation; vote\nBring your questions \\ comments. ${'Long line '.repeat(12)}`,
}

const allDay: DemoEvent = {
  ...base, id: 12, allDay: true, startsOn: '2026-11-07', endsOn: '2026-11-09',
  title: `Gr\u00fc\u00dfe aus der Nachbarschaft \u2013 na\u00efve \ud83d\ude00 ${'x'.repeat(40)}`,
  description: 'Line one\r\nLine two\rLine three\\N four, five; six',
}

const boundary: DemoEvent = {
  ...base, id: 3, startsAt: '2030-05-10T16:00:00Z', endsAt: '2030-05-10T18:00:00Z', version: 2,
  title: `${'a'.repeat(65)}, b`, description: '^'.repeat(80), location: `${'x'.repeat(66)};`,
}

const HEADER = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Juntia//Community events//EN\r\nCALSCALE:GREGORIAN\r\nBEGIN:VEVENT\r\n'
const STAMPS = 'DTSTAMP:20261020T091530Z\r\nUID:0f8fad5b-d9cb-469f-a165-70867728950e@juntia\r\n'

describe('iCalendar files', () => {
  test('match the backend for a timed event: order, escaping and folding', () => {
    expect(calendarFile(timed, ORIGIN)).toBe(`${HEADER}SUMMARY:Residents' meeting\\; budget\\, roof & lift\r\nDTSTART:20261105T180000Z\r\nDTEND:20261105T193000Z\r\n${STAMPS}SEQUENCE:2\r\nCREATED:20261001T080000Z\r\nDESCRIPTION:Agenda:\\n1. Roof repair\\, quotes\\n2. Lift modernisation\\; vote\r\n \\nBring your questions \\\\ comments. Long line Long line Long line Long lin\r\n e Long line Long line Long line Long line Long line Long line Long line Lo\r\n ng line \r\nLAST-MODIFIED:20261020T091530Z\r\nLOCATION:Community room\\, ground floor\r\nURL:https://demo.example.com/events/7\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`)
  })

  test('match the backend for an all-day event with multi-byte text', () => {
    expect(calendarFile(allDay, ORIGIN)).toBe(`${HEADER}SUMMARY:Gr\u00fc\u00dfe aus der Nachbarschaft \u2013 na\u00efve \ud83d\ude00 xxxxxxxxxxxxxxxxxxxx\r\n xxxxxxxxxxxxxxxxxxxx\r\nDTSTART;VALUE=DATE:20261107\r\nDTEND;VALUE=DATE:20261109\r\n${STAMPS}SEQUENCE:0\r\nCREATED:20261001T080000Z\r\nDESCRIPTION:Line one\\nLine two\\nLine three\\n four\\, five\\; six\r\nLAST-MODIFIED:20261020T091530Z\r\nLOCATION:\r\nURL:https://demo.example.com/events/12\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`)
  })

  test('never leave an escape character at the end of a folded line', () => {
    expect(calendarFile(boundary, ORIGIN)).toBe(`${HEADER}SUMMARY:${'a'.repeat(65)}\r\n \\, b\r\nDTSTART:20300510T160000Z\r\nDTEND:20300510T180000Z\r\n${STAMPS}SEQUENCE:1\r\nCREATED:20261001T080000Z\r\nDESCRIPTION:${'^'.repeat(61)}\r\n ${'^'.repeat(19)}\r\nLAST-MODIFIED:20261020T091530Z\r\nLOCATION:${'x'.repeat(65)}\r\n x\\;\r\nURL:https://demo.example.com/events/3\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`)
  })

  test('keep every line within 75 octets and escape injected lines', () => {
    const file = calendarFile({ ...timed, description: `Text\nBEGIN:VEVENT\n${'\u00e1'.repeat(200)}` }, ORIGIN)
    for (const line of file.split('\r\n')) expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75)
    expect(file.match(/^BEGIN:VEVENT$/gm)).toHaveLength(1)
    expect(escapeText('a\\Nb')).toBe('a\\nb')
    expect(foldLine('short')).toBe('short')
  })
})

describe('Google Calendar links', () => {
  test('match the backend', () => {
    expect(googleCalendar(timed, ORIGIN, 'Europe/Madrid')).toEqual({
      google_url: 'https://calendar.google.com/calendar/render?action=TEMPLATE&text=Residents%27+meeting%3B+budget%2C+roof+%26+lift&dates=20261105T180000Z%2F20261105T193000Z&ctz=Europe%2FMadrid&details=Agenda%3A%0A1.+Roof+repair%2C+quotes%0A2.+Lift+modernisation%3B+vote%0ABring+your+questions+%5C+comments.+Long+line+Long+line+Long+line+Long+line+Long+line+Long+line+Long+line+Long+line+Long+line+Long+line+Long+line+Long+line+%0A%0Ahttps%3A%2F%2Fdemo.example.com%2Fevents%2F7&location=Community+room%2C+ground+floor',
      google_error: null,
    })
    expect(googleCalendar(allDay, ORIGIN, 'Europe/Madrid').google_url).toBe('https://calendar.google.com/calendar/render?action=TEMPLATE&text=Gr%C3%BC%C3%9Fe+aus+der+Nachbarschaft+%E2%80%93+na%C3%AFve+%F0%9F%98%80+xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx&dates=20261107%2F20261109&ctz=Europe%2FMadrid&details=Line+one%0D%0ALine+two%0DLine+three%5CN+four%2C+five%3B+six%0A%0Ahttps%3A%2F%2Fdemo.example.com%2Fevents%2F12&location=')
  })

  test('report links over the limit, accepting the exact boundary', () => {
    const event = { ...timed, title: 'Event', location: '', description: 'x' }
    const overhead = (googleCalendar(event, ORIGIN, 'Europe/Madrid').google_url ?? '').length - 1
    const exact = googleCalendar({ ...event, description: 'x'.repeat(GOOGLE_URL_LIMIT - overhead) }, ORIGIN, 'Europe/Madrid')
    expect(exact.google_url).toHaveLength(GOOGLE_URL_LIMIT)
    expect(googleCalendar({ ...event, description: 'x'.repeat(GOOGLE_URL_LIMIT - overhead + 1) }, ORIGIN, 'Europe/Madrid')).toEqual({
      google_url: null, google_error: 'event_calendar_too_long',
    })
  })
})
