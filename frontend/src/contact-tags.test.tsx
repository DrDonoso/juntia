import { useState } from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterAll, afterEach, beforeAll, expect, test, vi } from 'vitest'
import { ContactTagPicker, appendContactTag, type ContactTagChoice, type TagPickerTexts } from './contact-tags'
import { I18nRoot, setLanguage } from './i18n'

const available = [
  { id: 1, name: 'Lift', color: '#21639f' },
  { id: 2, name: 'Emergency service', color: '#ffff00' },
]
const originalScroll = HTMLElement.prototype.scrollIntoView
beforeAll(() => { HTMLElement.prototype.scrollIntoView = function () {} })
afterAll(() => { HTMLElement.prototype.scrollIntoView = originalScroll })
afterEach(cleanup)

function Picker({ initial = [], disabled = false, submitted = () => {}, texts }: {
  initial?: ContactTagChoice[]; disabled?: boolean; submitted?: () => void; texts?: Partial<TagPickerTexts>
}) {
  const [selected, setSelected] = useState(initial), [input, setInput] = useState(''), [error, setError] = useState<string>()
  return <I18nRoot><form onSubmit={event => { event.preventDefault(); submitted() }}>
    <ContactTagPicker selected={selected} available={available} input={input} disabled={disabled} error={error} texts={texts}
      changeInput={value => { setInput(value); setError(undefined) }}
      add={text => {
        const result = appendContactTag(selected, text, available)
        setError(result.error)
        if (result.error) return false
        setSelected(result.tags); setInput('')
        return true
      }}
      remove={index => setSelected(previous => previous.filter((_, position) => position !== index))} />
    <button type="submit">Save</button>
  </form></I18nRoot>
}

test.each(['{Enter}', ',', ' '])('%s adds the typed name once without selecting a match or submitting', async delimiter => {
  const user = userEvent.setup(), submitted = vi.fn()
  render(<Picker submitted={submitted} />)
  const input = screen.getByRole('combobox', { name: 'Tags' })
  await user.type(input, 'lif')
  expect(screen.getByRole('option', { name: 'Lift' })).toBeVisible()
  await user.keyboard(delimiter)
  expect(screen.getAllByRole('button', { name: 'Remove lif' })).toHaveLength(1)
  expect(screen.queryByRole('button', { name: 'Remove Lift' })).toBeNull()
  expect(input).toHaveValue('')
  expect(input).toHaveFocus()
  expect(input).toHaveAttribute('aria-expanded', 'false')
  expect(submitted).not.toHaveBeenCalled()
})

test.each(['{Enter}', ',', ' '])('%s accepts an active multi-word suggestion and preserves its color', async delimiter => {
  const user = userEvent.setup()
  render(<Picker />)
  const input = screen.getByRole('combobox', { name: 'Tags' })
  await user.type(input, 'emer')
  await user.keyboard('{ArrowDown}')
  expect(input).toHaveAttribute('aria-activedescendant')
  await user.keyboard(delimiter)
  expect(screen.getByRole('button', { name: 'Remove Emergency service' }).closest('.tag')).toHaveStyle({
    backgroundColor: '#ffff00', color: '#000000',
  })
  expect(screen.queryByRole('button', { name: 'Remove emer' })).toBeNull()
  expect(input).toHaveValue('')
  expect(input).toHaveAttribute('aria-expanded', 'false')
})

test('clicking a suggestion closes the menu even when other suggestions remain', async () => {
  const user = userEvent.setup()
  render(<Picker />)
  const input = screen.getByRole('combobox', { name: 'Tags' })
  await user.click(input)
  await user.click(screen.getByRole('option', { name: 'Lift' }))
  expect(screen.getByRole('button', { name: 'Remove Lift' })).toBeVisible()
  expect(input).toHaveFocus()
  expect(input).toHaveAttribute('aria-expanded', 'false')
  await user.click(input)
  expect(screen.getByRole('option', { name: 'Emergency service' })).toBeVisible()
})

test('resizing dismisses suggestions without committing or losing input focus', async () => {
  const user = userEvent.setup()
  render(<Picker />)
  const input = screen.getByRole('combobox', { name: 'Tags' })
  await user.type(input, 'lif')
  expect(screen.getByRole('listbox')).toBeVisible()
  fireEvent.resize(window)
  expect(screen.queryByRole('listbox')).toBeNull()
  expect(input).toHaveValue('lif')
  expect(input).toHaveFocus()
  expect(screen.queryByRole('grid')).toBeNull()
})

test('clicking the visible submit control commits pending text while suggestions are open', async () => {
  const user = userEvent.setup(), submitted = vi.fn()
  render(<Picker submitted={submitted} />)
  const input = screen.getByRole('combobox', { name: 'Tags' })
  await user.type(input, 'lif')
  expect(screen.getByRole('option', { name: 'Lift' })).toBeVisible()
  await user.click(screen.getByText('Save', { exact: true }))
  expect(submitted).toHaveBeenCalledOnce()
  expect(screen.getByRole('button', { name: 'Remove lif' })).toBeVisible()
  expect(screen.queryByRole('button', { name: 'Remove Lift' })).toBeNull()
  expect(input).toHaveValue('')
  expect(input).toHaveAttribute('aria-expanded', 'false')
})

test('space separates consecutive tags while pasted multi-word names stay together', async () => {
  const user = userEvent.setup()
  render(<Picker />)
  const input = screen.getByRole('combobox', { name: 'Tags' })
  await user.type(input, 'new urgent new ')
  expect(screen.getAllByRole('button', { name: /^Remove / })).toHaveLength(2)
  expect(screen.getByRole('button', { name: 'Remove new' })).toBeVisible()
  expect(screen.getByRole('button', { name: 'Remove urgent' })).toBeVisible()
  await user.paste('  new tag  ')
  await user.keyboard('{Enter}')
  expect(screen.getByRole('button', { name: 'Remove new tag' })).toBeVisible()
  expect(input).toHaveValue('')
})

test('separators do not commit while composing text', async () => {
  const user = userEvent.setup(), submitted = vi.fn()
  render(<Picker submitted={submitted} />)
  const input = screen.getByRole('combobox', { name: 'Tags' })
  await user.click(input)
  fireEvent.compositionStart(input)
  fireEvent.change(input, { target: { value: 'new' } })
  for (const key of [' ', ',', 'Enter']) fireEvent.keyDown(input, { key, isComposing: true })
  expect(screen.queryByRole('button', { name: /^Remove / })).toBeNull()
  expect(input).toHaveValue('new')
  expect(submitted).not.toHaveBeenCalled()
  fireEvent.compositionEnd(input)
  await user.keyboard(' ')
  expect(screen.getByRole('button', { name: 'Remove new' })).toBeVisible()
})

test('invalid text remains editable and its error is associated with the input', async () => {
  const user = userEvent.setup()
  render(<Picker />)
  const input = screen.getByRole('combobox', { name: 'Tags' })
  await user.click(input)
  fireEvent.change(input, { target: { value: '\ufdfa'.repeat(100) } })
  await user.keyboard(' ')
  expect(screen.getByRole('alert')).toHaveTextContent('Enter a valid tag of up to 100 characters.')
  expect(input).toHaveAttribute('aria-invalid', 'true')
  expect(input).toHaveAccessibleDescription(expect.stringContaining('up to 100 characters'))
  expect(input).toHaveValue('\ufdfa'.repeat(100))
  expect(screen.queryByRole('button', { name: /^Remove / })).toBeNull()
})

test('selected tags support arrow navigation and keyboard removal, returning focus to the input', async () => {
  const user = userEvent.setup()
  render(<Picker initial={available} />)
  const grid = within(screen.getByRole('grid', { name: 'Selected tags' }))
  await user.click(grid.getAllByRole('row')[0])
  await user.keyboard('{ArrowRight}')
  expect(grid.getAllByRole('row')[1]).toHaveFocus()
  await user.keyboard('{Delete}')
  expect(screen.queryByRole('button', { name: 'Remove Emergency service' })).toBeNull()
  const input = screen.getByRole('combobox', { name: 'Tags' })
  expect(input).toHaveFocus()
  await user.keyboard('{Backspace}')
  expect(screen.queryByRole('grid')).toBeNull()
  expect(input).toHaveFocus()
})

test('disabled tags cannot be edited or removed', async () => {
  const user = userEvent.setup()
  render(<Picker initial={available} disabled />)
  expect(screen.getByRole('combobox', { name: 'Tags' })).toBeDisabled()
  const remove = screen.getByRole('button', { name: 'Remove Lift' })
  expect(remove).toBeDisabled()
  await user.click(remove)
  expect(screen.getAllByRole('button', { name: /^Remove / })).toHaveLength(2)
})

test('the picker follows the interface language, including a switch while it is open', async () => {
  const user = userEvent.setup()
  setLanguage('es')
  render(<Picker />)
  const input = screen.getByRole('combobox', { name: 'Etiquetas' })
  expect(input).toHaveAttribute('placeholder', 'Escribe para buscar o crear…')
  expect(input).toHaveAccessibleDescription(expect.stringContaining('Enter o coma'))
  await user.click(input)
  expect(screen.getByRole('listbox')).toHaveAttribute('aria-label', 'Etiquetas disponibles')
  await user.click(screen.getByRole('option', { name: 'Lift' }))
  expect(screen.getByRole('grid', { name: 'Etiquetas seleccionadas' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Quitar Lift' })).toBeVisible()
  expect(screen.getByLabelText('Vista previa de etiqueta')).toBeInTheDocument()
  fireEvent.change(input, { target: { value: '\ufdfa'.repeat(100) } })
  await user.keyboard(' ')
  expect(screen.getByRole('alert')).toHaveTextContent(/hasta 100 caracteres/)
  act(() => setLanguage('en'))
  expect(screen.getByRole('combobox', { name: 'Tags' })).toBe(input)
  expect(screen.getByRole('grid', { name: 'Selected tags' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Remove Lift' })).toBeVisible()
  expect(screen.getByLabelText('Tag preview')).toBeInTheDocument()
})

test('the picker names contact tags by default and callers can rename what it edits', async () => {
  const user = userEvent.setup()
  const labels: TagPickerTexts = { label: 'Labels', selected: 'Selected labels', available: 'Available labels', preview: 'Label preview' }
  const defaults = render(<Picker initial={[available[0]]} />)
  expect(screen.getByRole('grid', { name: 'Selected tags' })).toBeInTheDocument()
  expect(screen.getByLabelText('Tag preview')).toBeInTheDocument()
  // While suggestions are open, React Aria hides everything else from assistive technology.
  await user.click(screen.getByRole('combobox', { name: 'Tags' }))
  expect(screen.getByRole('listbox')).toHaveAttribute('aria-label', 'Available tags')
  defaults.unmount()

  const renamed = render(<Picker initial={[available[0]]} texts={labels} />)
  expect(screen.queryByRole('combobox', { name: 'Tags' })).toBeNull()
  const input = screen.getByRole('combobox', { name: 'Labels' })
  expect(input).toHaveAccessibleDescription('Press Space, Enter or comma to add.')
  expect(screen.getByRole('grid', { name: 'Selected labels' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Remove Lift' })).toBeVisible()
  expect(screen.getByLabelText('Label preview')).toBeInTheDocument()
  expect(screen.queryByLabelText('Tag preview')).toBeNull()
  await user.click(input)
  expect(screen.getByRole('listbox')).toHaveAttribute('aria-label', 'Available labels')
  renamed.unmount()

  render(<Picker initial={[available[0]]} texts={{ label: labels.label }} />)
  expect(screen.getByRole('combobox', { name: 'Labels' })).toBeInTheDocument()
  expect(screen.getByRole('grid', { name: 'Selected tags' })).toBeInTheDocument()
  expect(screen.getByLabelText('Tag preview')).toBeInTheDocument()
})
