import { useRef, useState } from 'react'
import { parseDate, parseTime } from '@internationalized/date'
import {
  Button, Calendar, CalendarCell, CalendarGrid, CalendarGridBody, CalendarGridHeader,
  CalendarHeaderCell, CalendarHeading, DateInput, DatePicker, DateSegment, Dialog,
  FieldError, Group, Label, Popover, TimeField,
} from 'react-aria-components'
import { useI18n } from './i18n'
import { Icon } from './icons'

export function focusEventDateField(form: HTMLFormElement, name: string, preferTime: boolean): boolean {
  const field = Array.from(form.querySelectorAll<HTMLElement>('[data-event-date-field]'))
    .find(element => element.dataset.eventDateField === name)
  const target = field?.querySelector<HTMLElement>(preferTime ? '[data-type="hour"]' : '[data-type="day"]')
  if (!target) return false
  target.focus()
  return true
}

// Segments, weekdays and month names follow the active language through the nearest React Aria
// I18nProvider (I18nRoot at the app root): day/month/year, 24-hour times and Monday-first weeks in
// both supported locales.
export function EventDateField({ name, label, timeLabel = label, value, change, today, withTime = false, min, disabled = false, error, errorId }: {
  name: string; label: string; timeLabel?: string; value: string; change: (value: string) => void; today: string
  withTime?: boolean; min?: string; disabled?: boolean; error?: string; errorId?: string
}) {
  const { t } = useI18n()
  const ref = useRef<HTMLDivElement>(null)
  const [portal, setPortal] = useState<Element>()
  const [placement, setPlacement] = useState<'top start' | 'bottom start'>('top start')
  const [maxHeight, setMaxHeight] = useState<number>()
  const [date = '', time = ''] = value.split('T')
  const [minDate = '', minTime = ''] = (min || '').split('T')
  return <DatePicker key={`${name}:${withTime ? 'time' : 'date'}`} ref={ref} className="event-date-field"
    data-event-date-field={name} data-with-time={withTime || undefined} name={name}
    value={date ? parseDate(date) : null} minValue={minDate ? parseDate(minDate) : undefined}
    placeholderValue={parseDate(today)} granularity="day" shouldForceLeadingZeros
    firstDayOfWeek="mon" isRequired isDisabled={disabled} isInvalid={error ? true : undefined}
    aria-describedby={error ? errorId : undefined} validationBehavior="native"
    onChange={next => change(withTime ? `${next?.toString() || ''}T${time}` : next?.toString() || '')}
    onOpenChange={open => {
      if (!open || !ref.current) return
      const dialog = ref.current.closest('dialog')
      const control = ref.current.querySelector('.event-date-control') || ref.current
      const anchor = control.getBoundingClientRect(), bounds = dialog?.getBoundingClientRect()
      const viewport = window.visualViewport
      const viewportTop = viewport?.offsetTop || 0
      const viewportBottom = viewportTop + (viewport?.height || window.innerHeight)
      // The native dialog's scrollable content can be taller than its visible area.
      const top = Math.max(viewportTop, bounds?.top ?? viewportTop)
      const bottom = Math.min(viewportBottom, bounds?.bottom ?? viewportBottom)
      const above = Math.max(0, anchor.top - top - 14)
      const below = Math.max(0, bottom - anchor.bottom - 14)
      setPortal(dialog || document.body)
      setPlacement(above >= below ? 'top start' : 'bottom start')
      setMaxHeight(Math.max(above, below))
    }}>
    <Label className="event-date-label">{label}</Label>
    <Group className="event-date-control">
      <DateInput className="event-date-input">
        {segment => <DateSegment segment={segment} data-type={segment.type} className="event-date-segment" />}
      </DateInput>
      {withTime && <>
        <span className="event-time-separator" aria-hidden="true">, </span>
        <TimeField className="event-time-field" aria-label={timeLabel} name={`${name}_time`}
          value={time ? parseTime(time) : null} minValue={date === minDate && minTime ? parseTime(minTime) : undefined}
          granularity="minute" hourCycle={24} shouldForceLeadingZeros isRequired isDisabled={disabled}
          isInvalid={error ? true : undefined} aria-describedby={error ? errorId : undefined} validationBehavior="native"
          onChange={next => change(`${date}T${next?.set({ second: 0, millisecond: 0 }).toString() || ''}`)}>
          <DateInput className="event-time-input">
            {segment => <DateSegment segment={segment} data-type={segment.type} className="event-date-segment" />}
          </DateInput>
          {!error && <FieldError className="notice error">
            {({ validationDetails }) => validationDetails.valueMissing ? t('events.dateField.timeMissing') : t('events.dateField.timeInvalid')}
          </FieldError>}
        </TimeField>
      </>}
      {/* DatePicker appends the field label to its trigger's accessible name. */}
      <Button className="quiet icon-button" aria-label={t('events.dateField.openCalendar')}><Icon name="calendar" size={18} /></Button>
    </Group>
    {!error && <FieldError className="notice error">
      {({ validationDetails }) => validationDetails.valueMissing
        ? t('events.dateField.dateMissing')
        : t('events.dateField.dateInvalid')}
    </FieldError>}
    <Popover className="event-calendar-popover" placement={placement} offset={6} maxHeight={maxHeight} shouldFlip={false}
      UNSTABLE_portalContainer={portal}>
      <Dialog className="event-calendar-dialog" aria-label={t('events.dateField.calendar', { label })}>
        <Calendar className="event-calendar" firstDayOfWeek="mon">
          <header>
            <Button slot="previous" className="quiet icon-button" aria-label={t('events.dateField.previousMonth')}><Icon name="arrow-left" size={18} /></Button>
            <CalendarHeading />
            <Button slot="next" className="quiet icon-button" aria-label={t('events.dateField.nextMonth')}><Icon name="arrow-right" size={18} /></Button>
          </header>
          <CalendarGrid className="event-calendar-grid" weekdayStyle="short">
            <CalendarGridHeader>{day => <CalendarHeaderCell>{day}</CalendarHeaderCell>}</CalendarGridHeader>
            <CalendarGridBody>{date => <CalendarCell date={date} className="event-calendar-cell" />}</CalendarGridBody>
          </CalendarGrid>
        </Calendar>
      </Dialog>
    </Popover>
  </DatePicker>
}
