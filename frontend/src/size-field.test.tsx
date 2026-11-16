import { useState } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, test } from 'vitest'
import openapiSource from './api/openapi.json?raw'
import { DOCUMENT_LIMITS } from './documents-admin'
import { SizeField, nearestStop, parseSize, sizeStops } from './size-field'

afterEach(cleanup)

function Field({ initial = '50', max = 10240 }: { initial?: string; max?: number }) {
  const [value, setValue] = useState(initial)
  return <main><SizeField label="Largest file" help="The largest file a neighbor can upload." min={1} max={max}
    value={value} fallback={50} change={setValue} warning={value === '9000' ? 'Larger than the quota.' : undefined} /></main>
}

test('the slider stops at round sizes in MiB, GiB and TiB, with both ends included', () => {
  const stops = sizeStops(1, 10240)
  expect(stops.slice(0, 12)).toEqual([1, 2, 3, 4, 5, 6, 8, 10, 15, 20, 25, 30])
  expect(stops).toEqual(expect.arrayContaining([50, 100, 500, 800, 1024, 1536, 2048, 8192]))
  expect(stops.at(-1)).toBe(10240)
  expect(stops.every((value, index) => Number.isInteger(value) && (index === 0 || value > stops[index - 1]))).toBe(true)
  const quotas = sizeStops(1, 10 * 1024 * 1024)
  expect(quotas).toEqual(expect.arrayContaining([2048, 20480, 1024 * 1024, 1.5 * 1024 * 1024]))
  expect(quotas.at(-1)).toBe(10 * 1024 * 1024)
  expect(sizeStops(7, 9)).toEqual([7, 8, 9])
})

test('typed sizes move the slider to the closest stop on its logarithmic scale', () => {
  const stops = sizeStops(1, 10240)
  expect(stops[nearestStop(stops, 50)]).toBe(50)
  expect(stops[nearestStop(stops, 3000)]).toBe(3072)
  expect(stops[nearestStop(stops, 7)]).toBe(8)
  expect(stops[nearestStop(stops, 100000)]).toBe(10240)
  expect(nearestStop(stops, 0)).toBe(0)
  expect(nearestStop(stops, Number.NaN)).toBe(0)
})

test('only whole MiB within the limits are sizes', () => {
  expect(parseSize(' 2048 ', 1, 10240)).toBe(2048)
  for (const text of ['', '0', '10241', '1.5', '-5', '1e3', '2 048', 'big']) expect(parseSize(text, 1, 10240), text).toBeNull()
})

test('the limits accept exactly what the server accepts', () => {
  const schemas = JSON.parse(openapiSource).components.schemas
  const properties = schemas.DocumentSettingsEdit.properties
  for (const limit of DOCUMENT_LIMITS) {
    const range = properties[limit.key].anyOf.find((option: { type: string }) => option.type === 'integer')
    expect([range.minimum, range.maximum], limit.key).toEqual([limit.min, limit.max])
  }
  expect(Object.keys(schemas.DocumentSettings.properties)).toEqual(expect.arrayContaining(DOCUMENT_LIMITS.map(limit => limit.key)))
})

test('typing a size moves the slider, and the slider fills in the box', () => {
  render(<Field />)
  const box = screen.getByRole('textbox', { name: 'Largest file' })
  const slider = screen.getByRole('slider', { name: 'Largest file' })
  const stops = sizeStops(1, 10240)
  expect(box).toHaveValue('50')
  expect(box).toHaveAccessibleDescription('In whole MiB, from 1 MiB to 10 GiB.')
  expect(slider).toHaveValue(String(stops.indexOf(50)))
  expect(slider).toHaveAttribute('aria-valuetext', '50 MiB')
  fireEvent.change(box, { target: { value: '3000' } })
  expect(slider).toHaveValue(String(stops.indexOf(3072)))
  expect(slider).toHaveAttribute('aria-valuetext', '2.93 GiB')
  expect(screen.getByText('2.93 GiB')).toBeVisible()
  fireEvent.change(slider, { target: { value: String(stops.indexOf(2048)) } })
  expect(box).toHaveValue('2048')
  expect(screen.getByText('2 GiB')).toBeVisible()
})

test('a size out of range is explained, keeps the slider at the end and can carry a warning when valid', () => {
  render(<Field />)
  const box = screen.getByRole('textbox', { name: 'Largest file' })
  const slider = screen.getByRole('slider', { name: 'Largest file' })
  fireEvent.change(box, { target: { value: '20000' } })
  expect(box).toHaveAttribute('aria-invalid', 'true')
  expect(screen.getByRole('alert')).toHaveTextContent('Enter a whole number of MiB from 1 to 10,240.')
  expect(box).toHaveAccessibleDescription('In whole MiB, from 1 MiB to 10 GiB. Enter a whole number of MiB from 1 to 10,240.')
  expect(slider).toHaveValue(String(sizeStops(1, 10240).length - 1))
  fireEvent.change(box, { target: { value: '' } })
  expect(slider).toHaveValue(String(sizeStops(1, 10240).indexOf(50)))
  fireEvent.change(box, { target: { value: '9000' } })
  expect(screen.queryByRole('alert')).toBeNull()
  expect(box).not.toHaveAttribute('aria-invalid')
  expect(box).toHaveAccessibleDescription('In whole MiB, from 1 MiB to 10 GiB. Larger than the quota.')
})

test('the (i) button explains the setting on hover, on keyboard focus and on tap', async () => {
  const user = userEvent.setup()
  render(<Field />)
  const info = screen.getByRole('button', { name: 'More about Largest file' })
  await user.hover(info)
  expect(await screen.findByRole('tooltip')).toHaveTextContent('The largest file a neighbor can upload.')
  await user.unhover(info)
  await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull())
  await user.tab()
  expect(info).toHaveFocus()
  const tooltip = await screen.findByRole('tooltip')
  expect(info).toHaveAttribute('aria-describedby', tooltip.id)
  await user.keyboard('{Escape}')
  await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull())
  fireEvent.pointerDown(info, { pointerType: 'touch' })
  fireEvent.pointerUp(info, { pointerType: 'touch' })
  fireEvent.click(info)
  expect(await screen.findByRole('tooltip')).toBeVisible()
})
