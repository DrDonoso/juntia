// Event times in the community's time zone: its setting and how dates and times read. Kept apart
// from community-event-shared.tsx, which brings the editors, so the shell's search can show them.
import { useQuery } from '@tanstack/react-query'
import { api } from './api/client'
import type { EventConfigOut, EventSnapshot } from './api/schema.gen'
import { dateTimeFormat, t } from './i18n'
import { day } from './shared'

export type EventSchedule = Pick<EventSnapshot, 'all_day' | 'starts_at' | 'ends_at' | 'starts_on' | 'ends_on'>

export function useEventConfig(enabled = true) {
  return useQuery({
    queryKey: ['events', 'config'],
    queryFn: ({ signal }) => api<EventConfigOut>('/events/config', 'GET', undefined, signal),
    enabled,
  })
}

// Wall-clock time in the community zone as `YYYY-MM-DDTHH:mm:ss` for drafts and comparisons;
// the fixed en-GB parts are parsed, never displayed.
export function localInput(value: string, zone: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(value))
  function part(type: Intl.DateTimeFormatPartTypes) {
    const result = parts.find(part => part.type === type)?.value
    if (!result) throw new Error(t('events.errors.unreadableDate'))
    return result
  }
  return `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}:${part('second')}`
}

export function shiftDay(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00Z`)
  if (!value || Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new Error(t('events.errors.invalidDate'))
  }
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

export function eventRange(value: EventSchedule, zone: string, compact = false): string {
  if (value.all_day) {
    if (!value.starts_on || !value.ends_on) throw new Error(t('events.errors.invalidInterval'))
    const last = shiftDay(value.ends_on, -1)
    if (last !== value.starts_on) return t('events.schedule.allDayRange', { start: day(value.starts_on), end: day(last) })
    return compact ? t('events.schedule.allDay') : t('events.schedule.allDayOn', { date: day(value.starts_on) })
  }
  if (!value.starts_at || !value.ends_at) throw new Error(t('events.errors.invalidSchedule'))
  const sameDay = localInput(value.starts_at, zone).slice(0, 10) === localInput(value.ends_at, zone).slice(0, 10)
  const format = dateTimeFormat({
    timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    ...(compact && sameDay ? {} : { year: 'numeric', month: '2-digit', day: '2-digit' } as const),
  })
  return t('events.schedule.range', { start: format.format(new Date(value.starts_at)), end: format.format(new Date(value.ends_at)) })
}
