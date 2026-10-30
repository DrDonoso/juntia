import { useState } from 'react'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { EventDateField } from './event-date-field'
import { I18nRoot, resetLanguage, setLanguage, useI18n } from './i18n'

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
  })
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

function americanBrowser() {
  Object.defineProperty(navigator, 'languages', { configurable: true, get: () => ['en-US', 'en'] })
  Object.defineProperty(navigator, 'language', { configurable: true, get: () => 'en-US' })
  resetLanguage()
}

function weekday(element: HTMLElement) {
  return (element.getAttribute('aria-label') || element.textContent || '').toLowerCase()
}

function Field({ initial = '2026-10-27', withTime = false, change = () => {}, disabled = false }: {
  initial?: string; withTime?: boolean; change?: (value: string) => void; disabled?: boolean
}) {
  const [value, setValue] = useState(initial)
  return <I18nRoot><EventDateField name="date" label="Date" timeLabel="Time" today="2026-10-16"
    value={value} withTime={withTime} disabled={disabled} change={value => { setValue(value); change(value) }} /></I18nRoot>
}

function LocalizedField({ initial = '2026-10-27T18:45:00' }: { initial?: string }) {
  const { t } = useI18n()
  const [value, setValue] = useState(initial)
  return <EventDateField name="starts_at" label={t('events.editor.fields.start')} timeLabel={t('events.editor.fields.startTime')}
    today="2026-10-16" withTime value={value} change={setValue} />
}

test('dates are day/month/year even in an American browser', () => {
  americanBrowser()
  render(<Field />)
  const input = screen.getByRole('group', { name: 'Date' })
  expect(input.textContent).toBe('27/10/2026')
  expect(Array.from(input.querySelectorAll('[role="spinbutton"]')).map(element => element.getAttribute('data-type'))).toEqual(['day', 'month', 'year'])
})

test.each([
  ['2026-10-27T00:05:00', '00', '05'],
  ['2026-10-27T18:45:00', '18', '45'],
  ['2026-10-27T23:59:00', '23', '59'],
])('time %s is fixed 24-hour hh:mm without seconds or AM/PM', (initial, hour, minute) => {
  americanBrowser()
  render(<Field initial={initial} withTime />)
  const input = screen.getByRole('group', { name: 'Date' })
  expect(input.querySelector('[data-type="hour"]')).toHaveTextContent(hour)
  expect(input.querySelector('[data-type="minute"]')).toHaveTextContent(minute)
  expect(input).toHaveTextContent(`${hour}:${minute}`)
  expect(input.querySelector('[data-type="second"]')).toBeNull()
  expect(input.querySelector('[data-type="dayPeriod"]')).toBeNull()
})

test('time segments accept keyboard edits and return a minute-precision local ISO value', async () => {
  const user = userEvent.setup(), change = vi.fn()
  render(<Field initial="2026-10-27T18:00:30" withTime change={change} />)
  const group = screen.getByRole('group', { name: 'Date' })
  await user.click(group.querySelector<HTMLElement>('[data-type="hour"]')!)
  await user.keyboard('23')
  await user.click(group.querySelector<HTMLElement>('[data-type="minute"]')!)
  await user.keyboard('45')
  await user.tab()
  expect(change).toHaveBeenLastCalledWith('2026-10-27T23:45:00')
  expect(group).toHaveTextContent('23:45')
})

test('the calendar starts on Monday and ends on Sunday regardless of browser locale', async () => {
  const user = userEvent.setup()
  americanBrowser()
  render(<Field />)
  await user.click(screen.getByRole('button', { name: 'Open calendar for Date' }))
  const headings = await screen.findAllByRole('columnheader', { hidden: true })
  expect(document.querySelector('.event-calendar-popover')).toHaveAttribute('data-placement', 'bottom')
  expect(headings).toHaveLength(7)
  expect(weekday(headings[0])).toMatch(/^mo/)
  expect(weekday(headings[6])).toMatch(/^su/)
  expect(document.querySelector('.react-aria-CalendarHeading')).toHaveTextContent('October 2026')
  await user.click(screen.getByRole('button', { name: 'Next month' }))
  expect(document.querySelector('.react-aria-CalendarHeading')).toHaveTextContent('November 2026')
  await user.keyboard('{Escape}')
  expect(screen.queryByRole('dialog')).toBeNull()
  await waitFor(() => expect(screen.getByRole('button', { name: 'Open calendar for Date' })).toHaveFocus())
})

test('date and time controls follow the active language', async () => {
  const user = userEvent.setup()
  render(<I18nRoot><LocalizedField /></I18nRoot>)
  const start = screen.getByRole('group', { name: 'Start' })
  expect(start).toHaveTextContent('27/10/2026')
  expect(start).toHaveTextContent('18:45')
  expect(within(start).getByRole('spinbutton', { name: 'hour, Start time' })).toHaveTextContent('18')
  await user.click(screen.getByRole('button', { name: 'Open calendar for Start' }))
  const calendar = await screen.findByRole('dialog', { name: 'Calendar for Start' })
  const headings = within(calendar).getAllByRole('columnheader', { hidden: true })
  expect(weekday(headings[0])).toMatch(/^mo/)
  expect(weekday(headings[6])).toMatch(/^su/)
  expect(calendar.querySelector('.react-aria-CalendarHeading')).toHaveTextContent('October 2026')
  expect(within(calendar).getByRole('button', { name: 'Previous month' })).toBeVisible()
  await user.keyboard('{Escape}')
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

  act(() => setLanguage('es'))
  const spanishStart = screen.getByRole('group', { name: 'Inicio' })
  expect(spanishStart).toHaveTextContent('27/10/2026')
  expect(spanishStart).toHaveTextContent('18:45')
  expect(spanishStart.querySelector('[data-type="dayPeriod"]')).toBeNull()
  expect(within(spanishStart).getByRole('spinbutton', { name: 'hora, Hora de inicio' })).toHaveTextContent('18')
  await user.click(screen.getByRole('button', { name: 'Abrir calendario de Inicio' }))
  const spanishCalendar = await screen.findByRole('dialog', { name: 'Calendario de Inicio' })
  const spanishHeadings = within(spanishCalendar).getAllByRole('columnheader', { hidden: true })
  expect(weekday(spanishHeadings[0])).toMatch(/^lu/)
  expect(weekday(spanishHeadings[6])).toMatch(/^do/)
  expect(spanishCalendar.querySelector('.react-aria-CalendarHeading')).toHaveTextContent(/octubre de 2026/i)
  await user.click(within(spanishCalendar).getByRole('button', { name: 'Mes siguiente' }))
  expect(spanishCalendar.querySelector('.react-aria-CalendarHeading')).toHaveTextContent(/noviembre de 2026/i)
})

test('disabled date/time fields cannot open their calendar or edit their segments', () => {
  render(<Field initial="2026-10-27T18:00:00" withTime disabled />)
  expect(screen.getByRole('button', { name: 'Open calendar for Date' })).toBeDisabled()
  for (const segment of screen.getAllByRole('spinbutton')) expect(segment).not.toHaveAttribute('contenteditable', 'true')
})

test('an incomplete date/time blocks submission and shows a field error', async () => {
  const user = userEvent.setup(), submit = vi.fn()
  render(<form onSubmit={event => { event.preventDefault(); submit() }}>
    <Field initial="" withTime />
    <button type="submit">Save</button>
  </form>)
  await user.click(screen.getByRole('button', { name: 'Save' }))
  expect(submit).not.toHaveBeenCalled()
  expect(await screen.findByText('Enter the date.')).toBeVisible()
  expect(await screen.findByText('Enter the time.')).toBeVisible()
  act(() => setLanguage('es'))
  expect(screen.getByText('Completa la fecha.')).toBeVisible()
  expect(screen.getByText('Completa la hora.')).toBeVisible()
})

test('a preserved date does not select a time or allow submission until the hour is chosen', async () => {
  const user = userEvent.setup(), submit = vi.fn(), change = vi.fn()
  render(<form onSubmit={event => { event.preventDefault(); submit() }}>
    <Field initial="2026-10-27T" withTime change={change} />
    <button type="submit">Save</button>
  </form>)
  const group = screen.getByRole('group', { name: 'Date' })
  expect(group).toHaveTextContent('27/10/2026')
  expect(group.querySelector('[data-type="hour"]')).toHaveAttribute('data-placeholder', 'true')
  expect(group.querySelector('[data-type="minute"]')).toHaveAttribute('data-placeholder', 'true')
  await user.click(screen.getByRole('button', { name: 'Save' }))
  expect(submit).not.toHaveBeenCalled()
  expect(await screen.findByText('Enter the time.')).toBeVisible()
  await user.click(group.querySelector<HTMLElement>('[data-type="hour"]')!)
  await user.keyboard('09')
  await user.click(group.querySelector<HTMLElement>('[data-type="minute"]')!)
  await user.keyboard('30')
  await user.tab()
  expect(change).toHaveBeenLastCalledWith('2026-10-27T09:30:00')
  await user.click(screen.getByRole('button', { name: 'Save' }))
  expect(submit).toHaveBeenCalledOnce()
})

test('changing a date-only field into an empty date/time field resets its internal date type', () => {
  const props = { name: 'date', label: 'Date', timeLabel: 'Time', today: '2026-10-16', change: vi.fn() }
  const { rerender } = render(<I18nRoot><EventDateField {...props} value="2026-10-27" /></I18nRoot>)
  expect(() => rerender(<I18nRoot><EventDateField {...props} value="" withTime /></I18nRoot>)).not.toThrow()
  expect(screen.getByRole('group', { name: 'Date' }).querySelector('[data-type="hour"]')).not.toBeNull()
  expect(screen.getByRole('spinbutton', { name: /hour/i })).toBeVisible()
  rerender(<I18nRoot><EventDateField {...props} value="2026-10-27" /></I18nRoot>)
  expect(screen.getByRole('group', { name: 'Date' })).toHaveTextContent('27/10/2026')
  expect(screen.queryByRole('spinbutton', { name: /hour/i })).toBeNull()
})
