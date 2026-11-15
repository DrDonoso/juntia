import { useId, useMemo } from 'react'
import { byteSize } from './community-action-shared'
import { formatNumber, useI18n } from './i18n'
import { InfoTip, Notice } from './shared'

const MIB = 1024 * 1024
// The slider stops at round sizes: these multiples of 1, 10 and 100 MiB, GiB and TiB.
const ROUND = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8]
const UNITS = [1, 1024, 1024 * 1024]

/** The sizes the slider stops at, in whole MiB: round sizes between min and max, both included. */
export function sizeStops(min: number, max: number): number[] {
  const values = new Set([min, max])
  for (const unit of UNITS) {
    for (const power of [1, 10, 100]) {
      for (const base of ROUND) {
        const value = base * power * unit
        if (Number.isInteger(value) && value > min && value < max) values.add(value)
      }
    }
  }
  return [...values].sort((left, right) => left - right)
}

/** The stop closest to a size on the slider's scale, which is logarithmic like the stops. */
export function nearestStop(stops: readonly number[], size: number): number {
  let best = 0
  if (!(size > 0)) return best
  for (let index = 1; index < stops.length; index++) {
    if (Math.abs(Math.log(stops[index] / size)) < Math.abs(Math.log(stops[best] / size))) best = index
  }
  return best
}

/** A whole number of MiB between min and max, or null. */
export function parseSize(text: string, min: number, max: number): number | null {
  const trimmed = text.trim()
  if (!/^[0-9]{1,10}$/.test(trimmed)) return null
  const value = Number(trimmed)
  return value >= min && value <= max ? value : null
}

/**
 * A size in whole MiB: a slider between min and max that stops at round sizes, and a box to type an
 * exact one, which moves the slider. `value` is the box's text, valid or not; while it is not a
 * number, the slider stays at `fallback`.
 */
export function SizeField({ label, help, min, max, value, fallback, change, disabled = false, warning }: {
  label: string; help: string; min: number; max: number; value: string; fallback: number
  change: (value: string) => void; disabled?: boolean; warning?: string
}) {
  const { t } = useI18n()
  const id = useId()
  const stops = useMemo(() => sizeStops(min, max), [min, max])
  const size = parseSize(value, min, max)
  const typed = value.trim() === '' ? Number.NaN : Number(value)
  // Out of range, the slider waits at the nearest end until the size is valid again.
  const position = nearestStop(stops, size ?? (Number.isFinite(typed) ? Math.min(max, Math.max(min, typed)) : fallback))
  const notes = [`${id}-hint`, ...size === null ? [`${id}-error`] : warning ? [`${id}-warning`] : []].join(' ')
  return <div className="size-field">
    <div className="size-field-header">
      <span className="size-field-label">
        <label id={`${id}-label`} htmlFor={`${id}-input`}>{label}</label>
        <InfoTip label={t('common.moreInfo', { name: label })}>{help}</InfoTip>
      </span>
      <span className="size-field-value" aria-hidden="true">{size === null ? '' : byteSize(size * MIB)}</span>
    </div>
    <div className="size-field-controls">
      <div className="size-field-slider">
        <input type="range" min={0} max={stops.length - 1} step={1} value={position} disabled={disabled}
          aria-labelledby={`${id}-label`} aria-valuetext={byteSize((size ?? stops[position]) * MIB)}
          onChange={event => change(String(stops[Number(event.currentTarget.value)]))} />
        <div className="size-field-scale" aria-hidden="true"><span>{byteSize(min * MIB)}</span><span>{byteSize(max * MIB)}</span></div>
      </div>
      <span className="size-field-number">
        <input id={`${id}-input`} type="text" inputMode="numeric" autoComplete="off" spellCheck={false} value={value}
          disabled={disabled} aria-invalid={size === null || undefined} aria-describedby={notes}
          onChange={event => change(event.currentTarget.value)} />
        <span aria-hidden="true">MiB</span>
      </span>
    </div>
    <p id={`${id}-hint`} className="sr-only">{t('common.sizeField.hint', { min: byteSize(min * MIB), max: byteSize(max * MIB) })}</p>
    {size === null && <Notice id={`${id}-error`} error>
      {t('common.sizeField.invalid', { min: formatNumber(min), max: formatNumber(max) })}</Notice>}
    {size !== null && warning && <p id={`${id}-warning`} className="notice warning size-field-warning">{warning}</p>}
  </div>
}
