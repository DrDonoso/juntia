import { useRef, useState, type ReactNode } from 'react'
import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest'
import { cache } from './api/client'
import type { DwellingLayoutOut, DwellingOut } from './api/schema.gen'
import { DwellingLayoutEditor } from './dwelling-layout-editor'
import { emptyDwellingLayout, layoutQueryKey } from './dwelling-layout'
import { setLanguage, translate, type Translate } from './i18n'

vi.mock('@dnd-kit/react', () => ({
  DragDropProvider: ({ children }: { children: ReactNode }) => children,
  useDraggable: () => ({ ref: () => {}, handleRef: () => {}, isDragging: false }),
  useDroppable: () => ({ ref: () => {}, isDropTarget: false }),
}))
const dragAccessibility = vi.hoisted(() => ({ options: null as unknown }))
vi.mock('@dnd-kit/dom', () => ({
  Accessibility: { configure: (options: unknown) => { dragAccessibility.options = options; return options } },
  Feedback: { configure: (options: unknown) => options },
}))

interface DragAccessibility {
  screenReaderInstructions: { draggable: string }
  announcements: Record<'dragstart' | 'dragover' | 'dragend', (event: unknown) => string>
}

const spanish: Translate = (key, ...args) => translate('es', key, ...args)

const showModal = HTMLDialogElement.prototype.showModal, closeModal = HTMLDialogElement.prototype.close
const defaults = cache.getDefaultOptions()
const limits = { zones: 50, rows: 100, columns: 24, cells: 10000 } as const
const dwellings: DwellingOut[] = [1, 2, 3].map(id => ({ id, label: `House ${id}`, coefficient: null, user_count: 0, version: 1 }))
let saved: DwellingLayoutOut
let writes: { version: number; layout: DwellingLayoutOut['layout'] }[]
let failure = ''

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', '') }
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open') }
})
afterAll(() => {
  HTMLDialogElement.prototype.showModal = showModal
  HTMLDialogElement.prototype.close = closeModal
  cache.setDefaultOptions(defaults)
})
beforeEach(() => {
  cache.clear()
  cache.setDefaultOptions({ queries: { retry: false, staleTime: Infinity } })
  writes = []; failure = ''
  saved = { version: 0, layout: { ...emptyDwellingLayout, zones: [{
    id: 'block', name: 'Block', columns: 2,
    rows: [{ id: 'upper', name: 'Floor 1', cells: [2, null] }, { id: 'lower', name: 'Ground floor', cells: [1, null] }],
  }] }, limits }
  cache.setQueryData(layoutQueryKey, saved)
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    if (input === '/api/neighbors/layout') return Response.json(saved)
    if (input === '/api/neighbors') return Response.json(dwellings.map(dwelling => ({ id: dwelling.id, label: dwelling.label, neighbors: [] })))
    if (input === '/api/admin/dwellings/layout') {
      const body = JSON.parse(String(init?.body))
      writes.push(body)
      if (failure) return Response.json({ code: failure }, { status: failure === 'dwelling_layout_stale' ? 409 : 500 })
      saved = { ...saved, version: saved.version + 1, layout: body.layout }
      return Response.json(saved)
    }
    throw new Error(`Unexpected request ${input}`)
  }))
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); cache.clear() })

async function openEditor(title = 'Arrange dwellings') {
  function Host() {
    const [open, setOpen] = useState(false)
    const button = useRef<HTMLButtonElement>(null)
    return <QueryClientProvider client={cache}><button ref={button} onClick={() => setOpen(true)}>{title}</button>
      {open && <DwellingLayoutEditor dwellings={dwellings} close={() => setOpen(false)} restoreFocusRef={button} />}
    </QueryClientProvider>
  }
  render(<Host />)
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: title }))
  return { user, editor: screen.getByRole('dialog', { name: title }) }
}

test('editing and preview are drafts; only Save publishes using the original version', async () => {
  const { user, editor } = await openEditor()
  fireEvent.change(within(editor).getByRole('textbox', { name: 'Name of zone 1' }), { target: { value: 'New block' } })
  expect(writes).toEqual([])
  expect(cache.getQueryData<DwellingLayoutOut>(layoutQueryKey)?.layout?.zones[0].name).toBe('Block')
  await user.click(within(editor).getByRole('button', { name: 'Preview' }))
  expect(await screen.findByRole('region', { name: 'New block' })).toBeVisible()
  expect(writes).toEqual([])
  await user.click(within(editor).getByRole('button', { name: 'Save layout' }))
  await waitFor(() => expect(screen.getByText('Layout saved. It is now available to all neighbors.')).toBeVisible())
  expect(writes).toHaveLength(1)
  expect(writes[0].version).toBe(0)
  expect(saved.layout?.zones[0].name).toBe('New block')
  expect(within(editor).getByRole('button', { name: 'Save layout' })).toBeDisabled()
})

test('keyboard move controls swap occupied cells and retain the empty column', async () => {
  const { user, editor } = await openEditor()
  const move = within(editor).getByRole('button', { name: 'Move dwelling House 1' })
  move.focus(); await user.keyboard('{Enter}')
  const dialog = screen.getByRole('dialog', { name: 'Move dwelling House 1' })
  await user.selectOptions(within(dialog).getByLabelText('Destination zone'), 'block')
  await user.selectOptions(within(dialog).getByLabelText('Destination row'), 'upper')
  await user.keyboard('{Tab}')
  await user.click(within(dialog).getByRole('button', { name: 'Move dwelling' }))
  expect(editor.querySelector('[data-drop="cell:block:upper:0"]')).toHaveTextContent('House 1')
  expect(editor.querySelector('[data-drop="cell:block:lower:0"]')).toHaveTextContent('House 2')
  expect(editor.querySelector('[data-drop="cell:block:upper:1"]')).toHaveTextContent('Empty cell')
  expect(screen.getByText('House 1: Block, Floor 1, column 1. Change not saved yet.')).toBeInTheDocument()
  expect(writes).toEqual([])
})

test('occupied structure requires confirmation and returns its homes to the tray', async () => {
  const { user, editor } = await openEditor()
  await user.click(within(editor).getByRole('button', { name: 'Remove zone Block' }))
  const confirm = screen.getByRole('dialog', { name: 'Remove part of the layout' })
  expect(confirm).toHaveTextContent('These dwellings will move to Unplaced. No dwellings or users will be deleted.')
  expect(confirm).toHaveTextContent('House 1')
  expect(confirm).toHaveTextContent('House 2')
  await user.click(within(confirm).getByRole('button', { name: 'Confirm' }))
  const tray = within(editor).getByRole('complementary', { name: 'Unplaced dwellings' })
  for (const dwelling of dwellings) expect(tray).toHaveTextContent(dwelling.label)
  expect(writes).toEqual([])
})

test('cancel confirms discarding, preserves the saved layout and restores focus', async () => {
  const { user, editor } = await openEditor()
  fireEvent.change(within(editor).getByLabelText('Name of zone 1'), { target: { value: 'Draft' } })
  const beforeUnload = new Event('beforeunload', { cancelable: true })
  window.dispatchEvent(beforeUnload)
  expect(beforeUnload.defaultPrevented).toBe(true)
  fireEvent(editor, new Event('cancel', { cancelable: true, bubbles: true }))
  const confirm = screen.getByRole('dialog', { name: 'Discard changes' })
  await user.click(within(confirm).getByRole('button', { name: 'Confirm' }))
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(screen.getByRole('button', { name: 'Arrange dwellings' })).toHaveFocus()
  expect(saved.layout?.zones[0].name).toBe('Block')
  expect(writes).toEqual([])
})

test.each(['dwelling_layout_stale', 'internal_error'])('%s retains the draft and does not silently adopt a new version', async error => {
  const { user, editor } = await openEditor()
  failure = error
  fireEvent.change(within(editor).getByLabelText('Name of zone 1'), { target: { value: 'My draft' } })
  await user.click(within(editor).getByRole('button', { name: 'Save layout' }))
  expect(await screen.findByRole('alert')).toBeVisible()
  expect(within(editor).getByLabelText('Name of zone 1')).toHaveValue('My draft')
  expect(saved.version).toBe(0)
  saved = { ...saved, version: 2, layout: emptyDwellingLayout }
  act(() => { cache.setQueryData(layoutQueryKey, saved) })
  expect(within(editor).getByLabelText('Name of zone 1')).toHaveValue('My draft')
  await user.click(within(editor).getByRole('button', { name: 'Load saved version' }))
  await user.click(within(screen.getByRole('dialog', { name: 'Load saved layout' })).getByRole('button', { name: 'Confirm' }))
  await waitFor(() => expect(within(editor).queryByLabelText('Name of zone 1')).toBeNull())
})

test('all structural controls retain rectangular rows and stable IDs', async () => {
  const { user, editor } = await openEditor()
  await user.click(within(editor).getByRole('checkbox', { name: 'Show row names' }))
  await user.click(within(editor).getByRole('checkbox', { name: 'Show column names' }))
  await user.click(within(editor).getByText('Edit floors and columns'))
  await user.click(within(editor).getByRole('button', { name: 'Add column' }))
  await user.click(within(editor).getByRole('button', { name: 'Add row' }))
  fireEvent.change(within(editor).getByLabelText('Name of row 3 in Block'), { target: { value: 'Basement' } })
  await user.click(within(editor).getByRole('button', { name: 'Move Basement in Block up' }))
  await user.click(within(editor).getByRole('button', { name: 'Add zone' }))
  await user.click(within(editor).getByRole('button', { name: 'Move zone Zone 2 up' }))
  await user.click(within(editor).getByRole('button', { name: 'Save layout' }))
  await waitFor(() => expect(saved.version).toBe(1))
  const block = saved.layout?.zones.find(zone => zone.id === 'block')
  expect(saved.layout?.zones[1].id).toBe('block')
  expect(block?.rows.map(row => row.cells.length)).toEqual([3, 3, 3])
  expect(block?.rows.map(row => row.name)).toEqual(['Floor 1', 'Basement', 'Ground floor'])
  expect(block?.rows[0].id).toBe('upper')
  expect(saved.layout).toMatchObject({ show_row_names: true, show_column_names: true })
  await user.click(within(editor).getByRole('button', { name: 'Remove column 3 from Block' }))
  await user.click(within(editor).getByRole('button', { name: 'Remove Basement from Block' }))
  await user.click(within(editor).getByRole('button', { name: 'Remove zone Zone 2' }))
  await user.click(within(editor).getByRole('button', { name: 'Save layout' }))
  await waitFor(() => expect(saved.version).toBe(2))
  expect(saved.layout).toMatchObject({ show_row_names: true, show_column_names: true })
  expect(saved.layout?.zones[0].rows.map(row => row.cells)).toEqual([[2, null], [1, null]])
})

test('display preferences preview immediately but only publish on save', async () => {
  const { user, editor } = await openEditor()
  const rows = within(editor).getByRole('checkbox', { name: 'Show row names' })
  const columns = within(editor).getByRole('checkbox', { name: 'Show column names' })
  expect(rows).not.toBeChecked()
  expect(columns).not.toBeChecked()
  expect(editor.querySelectorAll('.dwelling-layout-row-name')).toHaveLength(2)
  expect(editor.querySelectorAll('.dwelling-layout-column')).toHaveLength(2)
  await user.click(within(editor).getByRole('button', { name: 'Preview' }))
  const preview = await screen.findByRole('region', { name: 'Directory preview' })
  await within(preview).findByRole('region', { name: 'Block' })
  expect(preview.querySelector('.dwelling-layout-row-name')).toBeNull()
  expect(preview.querySelector('.dwelling-layout-column')).toBeNull()
  await user.click(rows)
  expect(preview.querySelectorAll('.dwelling-layout-row-name')).toHaveLength(2)
  expect(preview.querySelector('.dwelling-layout-column')).toBeNull()
  await user.click(columns)
  expect(preview.querySelectorAll('.dwelling-layout-column')).toHaveLength(2)
  expect(cache.getQueryData<DwellingLayoutOut>(layoutQueryKey)?.layout).toMatchObject({ show_row_names: false, show_column_names: false })
  expect(writes).toEqual([])
  await user.click(within(editor).getByRole('button', { name: 'Save layout' }))
  await waitFor(() => expect(saved.version).toBe(1))
  expect(saved.layout).toMatchObject({ show_row_names: true, show_column_names: true })
  await user.click(rows)
  await user.click(within(editor).getByRole('button', { name: 'Cancel' }))
  await user.click(within(screen.getByRole('dialog', { name: 'Discard changes' })).getByRole('button', { name: 'Confirm' }))
  await user.click(screen.getByRole('button', { name: 'Arrange dwellings' }))
  expect(screen.getByRole('checkbox', { name: 'Show row names' })).toBeChecked()
  expect(screen.getByRole('checkbox', { name: 'Show column names' })).toBeChecked()
})

test('new unconfigured layouts start with hidden names and retain draft preferences on creation', async () => {
  saved = { ...saved, layout: null }
  cache.setQueryData(layoutQueryKey, saved)
  const { user, editor } = await openEditor()
  expect(within(editor).getByRole('checkbox', { name: 'Show row names' })).not.toBeChecked()
  expect(within(editor).getByRole('button', { name: 'Save layout' })).toBeDisabled()
  expect(editor).toHaveTextContent('Add a zone to get started. Floors and positions are never inferred from the names.')
  await user.click(within(editor).getByRole('checkbox', { name: 'Show column names' }))
  await user.click(within(editor).getByRole('button', { name: 'Add zone' }))
  expect(within(editor).getByLabelText('Name of zone 1')).toHaveValue('Zone 1')
  await user.click(within(editor).getByRole('button', { name: 'Save layout' }))
  await waitFor(() => expect(saved.version).toBe(1))
  expect(saved.layout).toMatchObject({ show_row_names: false, show_column_names: true })
})

test('the toolbar counts placed dwellings and formats the limits for the language', async () => {
  const { editor } = await openEditor()
  expect(editor).toHaveTextContent('2 of 3 dwellings placed')
  const tray = within(editor).getByRole('complementary', { name: 'Unplaced dwellings' })
  expect(within(tray).getByRole('heading', { name: 'Unplaced 1' })).toBeVisible()
  expect(editor).toHaveTextContent('Up to 50 zones, 100 rows per zone, 24 columns and 10,000 cells in total.')
  act(() => setLanguage('es'))
  expect(screen.getByRole('dialog', { name: 'Organizar viviendas' })).toBe(editor)
  expect(editor).toHaveTextContent('2 de 3 viviendas colocadas')
  expect(within(tray).getByRole('heading', { name: 'Sin colocar 1' })).toBeVisible()
  expect(editor).toHaveTextContent('Hasta 50 zonas, 100 filas por zona, 24 columnas y 10.000 casillas en total.')
})

test('drag instructions and announcements name the dwelling and destination in the active language', async () => {
  await openEditor()
  let drag = dragAccessibility.options as DragAccessibility
  expect(drag.screenReaderInstructions.draggable).toBe('Press Space to pick up the dwelling, use the arrow keys to move it and press Space again to drop it. Escape cancels. You can also use the Move to button.')
  expect(drag.announcements.dragstart({ operation: { source: { id: 1 } } })).toBe('You picked up House 1.')
  expect(drag.announcements.dragstart({ operation: { source: { id: 99 } } })).toBe('You picked up a dwelling.')
  expect(drag.announcements.dragover({ operation: { target: { id: 'cell:block:upper:1' } } })).toBe('Destination: Block, Floor 1, column 2.')
  expect(drag.announcements.dragover({ operation: { target: { id: 'unplaced' } } })).toBe('Destination: Unplaced.')
  expect(drag.announcements.dragover({ operation: { target: null } })).toBe('Destination: outside the layout.')
  expect(drag.announcements.dragend({ canceled: true, operation: { target: { id: 'unplaced' } } })).toBe('Move cancelled.')
  expect(drag.announcements.dragend({ canceled: false, operation: { target: { id: 'unplaced' } } })).toBe('Dwelling moved in the draft. Save to publish it.')
  act(() => setLanguage('es'))
  drag = dragAccessibility.options as DragAccessibility
  expect(drag.screenReaderInstructions.draggable).toBe(spanish('neighbors.editor.drag.instructions'))
  expect(drag.announcements.dragstart({ operation: { source: { id: 1 } } })).toBe('Has recogido House 1.')
  expect(drag.announcements.dragover({ operation: { target: { id: 'cell:block:lower:0' } } })).toBe('Destino: Block, Ground floor, columna 1.')
  expect(drag.announcements.dragend({ canceled: true, operation: { target: null } })).toBe('Movimiento cancelado.')
})

test('the editor renders in Spanish, including fallbacks, confirmations and announcements', async () => {
  saved = { ...saved, layout: { ...emptyDwellingLayout, zones: [{
    id: 'block', name: 'Block', columns: 2,
    rows: [{ id: 'upper', name: 'Floor 1', cells: [4, null] }, { id: 'lower', name: '', cells: [1, null] }],
  }] } }
  cache.setQueryData(layoutQueryKey, saved)
  setLanguage('es')
  const { user, editor } = await openEditor('Organizar viviendas')
  expect(editor).toHaveTextContent('Crea zonas para bloques, portales o exteriores.')
  expect(editor).toHaveTextContent('2 de 3 viviendas colocadas')
  expect(within(editor).getByRole('checkbox', { name: 'Mostrar nombres de filas' })).not.toBeChecked()
  expect(within(editor).getByRole('region', { name: 'Editar zona Block' })).toBeVisible()
  expect(within(editor).getByRole('textbox', { name: 'Nombre de la fila 2 de Block' })).toHaveAttribute('placeholder', 'Ej.: Bajos (opcional)')
  expect(within(editor).getByRole('group', { name: 'Block, Fila 2, columna 2' })).toHaveTextContent(spanish('neighbors.editor.cell.empty'))
  expect(within(editor).getByRole('group', { name: 'Block, Floor 1, columna 1' })).toHaveTextContent('Vivienda no disponible. Quita esta casilla antes de guardar.')
  await user.click(within(editor).getByRole('button', { name: 'Mover vivienda House 1' }))
  const dialog = screen.getByRole('dialog', { name: 'Mover vivienda House 1' })
  expect(within(dialog).getByLabelText('Zona de destino')).toHaveDisplayValue('Sin colocar')
  await user.click(within(dialog).getByRole('button', { name: 'Mover vivienda' }))
  expect(screen.getByText('House 1: Sin colocar. Cambio pendiente de guardar.')).toBeInTheDocument()
  expect(within(editor).getByRole('complementary', { name: 'Viviendas sin colocar' })).toHaveTextContent('House 1')
  await user.click(within(editor).getByRole('button', { name: 'Quitar zona Block' }))
  const confirm = screen.getByRole('dialog', { name: 'Quitar parte del plano' })
  expect(confirm).toHaveTextContent(spanish('neighbors.editor.confirm.remove.message'))
  expect(within(confirm).getByRole('listitem')).toHaveTextContent('Vivienda 4')
  await user.click(within(confirm).getByRole('button', { name: 'Seguir editando' }))
  await user.click(within(editor).getByRole('button', { name: 'Cancelar' }))
  expect(screen.getByRole('dialog', { name: 'Descartar cambios' })).toHaveTextContent(spanish('neighbors.editor.confirm.discard.message'))
})
