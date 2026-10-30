import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, test } from 'vitest'
import type { DwellingLayout, DwellingNeighborsOut } from './api/schema.gen'
import { cellKey, DwellingZoneGrid, emptyDwellingLayout, layoutCellCount, moveDwelling, placedDwellings, rowName } from './dwelling-layout'
import { setLanguage, translate, type Translate } from './i18n'
import { NeighborsDirectory } from './neighbors'

afterEach(cleanup)

const spanish: Translate = (key, ...args) => translate('es', key, ...args)

function layout(): DwellingLayout {
  return { ...emptyDwellingLayout, zones: [
    { id: 'block', name: 'Block', columns: 3, rows: [
      { id: 'upper', name: 'Floor 2', cells: [2, null, 3] },
      { id: 'lower', name: 'Ground floor', cells: [1, null, null] },
    ] },
    { id: 'outside', name: 'Courtyard', columns: 1, rows: [{ id: 'patio', name: '', cells: [4] }] },
  ] }
}

const lower = { zone: 'block', row: 'lower', column: 0 }
const gap = { zone: 'block', row: 'upper', column: 1 }
const patio = { zone: 'outside', row: 'patio', column: 0 }

test('moving and swapping preserve exact cells, gaps and the original document', () => {
  const original = layout(), snapshot = structuredClone(original)
  const moved = moveDwelling(original, 1, gap)
  expect(moved.zones[0].rows.map(row => row.cells)).toEqual([[2, 1, 3], [null, null, null]])
  const swapped = moveDwelling(original, 1, patio)
  expect(swapped.zones[0].rows[1].cells).toEqual([4, null, null])
  expect(swapped.zones[1].rows[0].cells).toEqual([1])
  expect(original).toEqual(snapshot)
  expect(moveDwelling(original, 1, lower)).toBe(original)
})

test('tray moves unplace the displaced dwelling without copying or compacting anything', () => {
  const result = moveDwelling(layout(), 5, patio)
  expect([...placedDwellings(result)].sort()).toEqual([1, 2, 3, 5])
  expect(result.zones[0].rows[0].cells).toEqual([2, null, 3])
  const removed = moveDwelling(result, 5, null)
  expect(removed.zones[1].rows[0].cells).toEqual([null])
  expect(layoutCellCount(removed)).toBe(7)
})

test.each([[false, false], [true, false], [false, true], [true, true]])('moving dwellings preserves display options (%s, %s)', (rows, columns) => {
  const original = { ...layout(), show_row_names: rows, show_column_names: columns }
  for (const target of [gap, patio, null]) {
    expect(moveDwelling(original, 1, target)).toMatchObject({ show_row_names: rows, show_column_names: columns })
  }
})

test.each([
  { ...gap, zone: 'missing' }, { ...gap, row: 'missing' },
  { ...gap, column: -1 }, { ...gap, column: 3 }, { ...gap, column: 1.5 },
])('invalid targets fail explicitly without changing the document: %j', target => {
  const original = layout()
  expect(() => moveDwelling(original, 1, target)).toThrow('The destination cell no longer exists. Select another position.')
  expect(original).toEqual(layout())
})

test('invalid dwellings and rows fail with messages in the active language', () => {
  expect(() => moveDwelling(layout(), 0, gap)).toThrow('Select a valid dwelling.')
  expect(() => rowName(layout().zones[0], 'missing')).toThrow('The row no longer exists.')
  expect(rowName(layout().zones[1], 'patio')).toBe('Row 1')
  setLanguage('es')
  expect(() => moveDwelling(layout(), 1, { ...gap, column: 3 })).toThrow(spanish('neighbors.layout.missingTarget'))
  expect(() => moveDwelling(layout(), 0, gap)).toThrow(spanish('neighbors.layout.invalidDwelling'))
  expect(() => rowName(layout().zones[0], 'missing')).toThrow('La fila ya no existe.')
  expect(rowName(layout().zones[1], 'patio')).toBe('Fila 1')
  expect(rowName(layout().zones[0], 'lower')).toBe('Ground floor')
})

test('the grid includes empty cells in DOM order with an independently scrollable region', () => {
  const zone = layout().zones[0]
  const { container } = render(<DwellingZoneGrid zone={zone} renderCell={(position, id) => <span>{cellKey(position)}: {id ?? 'empty'}</span>} />)
  expect([...container.querySelectorAll('[data-cell]')].map(node => node.getAttribute('data-cell'))).toEqual([
    'cell:block:upper:0', 'cell:block:upper:1', 'cell:block:upper:2',
    'cell:block:lower:0', 'cell:block:lower:1', 'cell:block:lower:2',
  ])
  expect(screen.getByRole('region', { name: 'Layout of Block; scroll horizontally to see all the columns' })).toHaveAttribute('tabindex', '0')
  expect([...container.querySelectorAll('.dwelling-layout-column')].map(node => node.textContent)).toEqual(['Column 1', 'Column 2', 'Column 3'])
})

test('the grid labels follow a switch to Spanish while keeping server names', () => {
  const zone = { ...layout().zones[0], rows: [{ id: 'unnamed', name: '', cells: [null, null, null] }, ...layout().zones[0].rows] }
  const { container } = render(<DwellingZoneGrid zone={zone} renderCell={() => null} />)
  expect(container.querySelector('.dwelling-layout-row-name .sr-only')).toHaveTextContent('Row 1')
  act(() => setLanguage('es'))
  expect(screen.getByRole('region', { name: spanish('neighbors.layout.region', { zone: 'Block' }) })).toBeVisible()
  expect([...container.querySelectorAll('.dwelling-layout-column')].map(node => node.textContent)).toEqual(['Columna 1', 'Columna 2', 'Columna 3'])
  expect([...container.querySelectorAll('.dwelling-layout-row-name')].map(node => node.textContent)).toEqual(['Fila 1', 'Floor 2', 'Ground floor'])
})

const dwellings: DwellingNeighborsOut[] = [
  { id: 1, label: 'Ground A', neighbors: [{ id: 10, name: 'Alex', phone: '+442079460101', email: 'alex@example.org', is_president: true }] },
  { id: 2, label: '2 A', neighbors: [] },
  { id: 3, label: '2 C', neighbors: [] },
  { id: 4, label: 'Courtyard house', neighbors: [] },
  { id: 5, label: 'New dwelling', neighbors: [] },
]

test('directory uses positions instead of catalog ordering and retains contacts and unplaced homes', () => {
  const { container } = render(<NeighborsDirectory dwellings={dwellings} layout={layout()} currentUserId={10} />)
  expect([...container.querySelectorAll('.neighbor-dwelling > header h3')].map(node => node.textContent)).toEqual(['2 A', '2 C', 'Ground A', 'Courtyard house', 'New dwelling'])
  expect(screen.getByRole('region', { name: 'Other dwellings' })).toHaveTextContent('New dwelling')
  expect(screen.getByText('You')).toBeVisible()
  expect(screen.getByRole('button', { name: 'Alex: Community president' })).toBeVisible()
  expect(screen.getByRole('link', { name: /Call Alex/ })).toHaveAttribute('href', 'tel:+442079460101')
  expect(screen.getByRole('link', { name: /Email Alex/ })).toHaveAttribute('href', 'mailto:alex%40example.org')
  expect(container.querySelector('[data-cell="cell:block:upper:1"] .neighbor-dwelling')).toBeNull()
})

test.each([[false, false], [true, false], [false, true], [true, true]])('directory heading visibility keeps every cell in place (%s, %s)', (rows, columns) => {
  const { container } = render(<NeighborsDirectory dwellings={dwellings} layout={{ ...layout(), show_row_names: rows, show_column_names: columns }} />)
  const grid = container.querySelector('.dwelling-layout-grid')
  expect(grid?.querySelectorAll('.dwelling-layout-row-name')).toHaveLength(rows ? 2 : 0)
  expect(grid?.querySelectorAll('.dwelling-layout-column')).toHaveLength(columns ? 3 : 0)
  expect(grid?.children).toHaveLength(6 + (rows ? 2 : 0) + (columns ? 3 : 0) + (rows && columns ? 1 : 0))
  expect(grid).toHaveStyle({
    gridTemplateColumns: `${rows ? 'var(--dwelling-row-width) ' : ''}repeat(3, minmax(var(--dwelling-cell-width), 1fr))`,
  })
  expect([...grid!.querySelectorAll('[data-cell]')].map(cell => cell.getAttribute('data-cell'))).toEqual([
    'cell:block:upper:0', 'cell:block:upper:1', 'cell:block:upper:2',
    'cell:block:lower:0', 'cell:block:lower:1', 'cell:block:lower:2',
  ])
  expect(screen.getByRole('heading', { name: 'Block' })).toBeVisible()
})

test('an unconfigured directory retains the original flat order', () => {
  const { container } = render(<NeighborsDirectory dwellings={dwellings} layout={null} />)
  expect([...container.querySelectorAll('.neighbor-dwelling h2')].map(node => node.textContent)).toEqual(dwellings.map(dwelling => dwelling.label))
  expect(container.querySelector('.neighbor-grid')).not.toBeNull()
  expect(screen.queryByRole('region', { name: 'Other dwellings' })).toBeNull()
})

test('a missing dwelling is an explicit error, not a silently empty slot', () => {
  render(<NeighborsDirectory dwellings={dwellings.filter(dwelling => dwelling.id !== 2)} layout={layout()} />)
  expect(screen.getByRole('alert')).toHaveTextContent('A dwelling in this cell is no longer available')
})

test('the positioned directory renders in Spanish', () => {
  setLanguage('es')
  render(<NeighborsDirectory dwellings={dwellings.filter(dwelling => dwelling.id !== 2)} layout={layout()} currentUserId={10} />)
  expect(screen.getByRole('region', { name: 'Otras viviendas' })).toHaveTextContent('New dwelling')
  expect(screen.getByRole('alert')).toHaveTextContent(spanish('neighbors.directory.missingDwelling'))
  expect(screen.getByText(spanish('neighbors.directory.you'))).toBeVisible()
  expect(screen.getByRole('button', { name: 'Alex: Presidente/a de la comunidad' })).toBeVisible()
  expect(screen.getByRole('region', { name: /^Plano de Block; / })).toBeVisible()
})
