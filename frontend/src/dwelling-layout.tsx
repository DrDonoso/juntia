import { Fragment, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from './api/client'
import type { DwellingLayout, DwellingLayoutOut, DwellingLayoutZone } from './api/schema.gen'
import { t, useI18n } from './i18n'

export const layoutQueryKey = ['neighbors', 'layout'] as const
export const emptyDwellingLayout: DwellingLayout = { zones: [], show_row_names: false, show_column_names: false }

export function useDwellingLayout() {
  return useQuery({ queryKey: layoutQueryKey, queryFn: () => api<DwellingLayoutOut>('/neighbors/layout') })
}

export interface CellPosition {
  zone: string
  row: string
  column: number
}

export function cellKey(position: CellPosition): string {
  return `cell:${position.zone}:${position.row}:${position.column}`
}

export function placedDwellings(layout: DwellingLayout): Set<number> {
  return new Set(layout.zones.flatMap(zone => zone.rows.flatMap(row => row.cells.filter(id => id !== null))))
}

export function layoutCellCount(layout: DwellingLayout): number {
  return layout.zones.reduce((count, zone) => count + zone.columns * zone.rows.length, 0)
}

export function moveDwelling(layout: DwellingLayout, id: number, target: CellPosition | null): DwellingLayout {
  if (!Number.isInteger(id) || id < 1) throw new Error(t('neighbors.layout.invalidDwelling'))
  const destination = target && layout.zones.find(zone => zone.id === target.zone)?.rows.find(row => row.id === target.row)
  if (target && (!destination || !Number.isInteger(target.column) || target.column < 0 || target.column >= destination.cells.length)) {
    throw new Error(t('neighbors.layout.missingTarget'))
  }
  const displaced = target && destination ? destination.cells[target.column] : null
  if (displaced === id) return layout
  return {
    ...layout,
    zones: layout.zones.map(zone => ({
      ...zone, rows: zone.rows.map(row => ({
        ...row, cells: row.cells.map((cell, column) => {
          if (target && zone.id === target.zone && row.id === target.row && column === target.column) return id
          return cell === id ? displaced : cell
        }),
      })),
    })),
  }
}

export function rowName(zone: DwellingLayoutZone, rowId: string): string {
  const index = zone.rows.findIndex(row => row.id === rowId)
  if (index < 0) throw new Error(t('neighbors.layout.missingRow'))
  return zone.rows[index].name || t('neighbors.layout.row', { number: index + 1 })
}

export function DwellingZoneGrid({ zone, renderCell, compact = false, showRowNames = true, showColumnNames = true }: {
  zone: DwellingLayoutZone
  renderCell: (position: CellPosition, dwellingId: number | null) => ReactNode
  compact?: boolean
  showRowNames?: boolean
  showColumnNames?: boolean
}) {
  const { t } = useI18n()
  return <div className={`dwelling-layout-scroll${compact ? ' compact' : ''}`} tabIndex={0} role="region"
    aria-label={t('neighbors.layout.region', { zone: zone.name })}>
    <div className="dwelling-layout-grid" style={{ gridTemplateColumns: `${showRowNames ? 'var(--dwelling-row-width) ' : ''}repeat(${zone.columns}, minmax(var(--dwelling-cell-width), 1fr))` }}>
      {showColumnNames && <>
        {showRowNames && <span aria-hidden="true" />}
        {Array.from({ length: zone.columns }, (_, column) => <span className="dwelling-layout-column" key={column}>{t('neighbors.layout.column', { number: column + 1 })}</span>)}
      </>}
      {zone.rows.map(row => <Fragment key={row.id}>
        {showRowNames && <div className="dwelling-layout-row-name">{row.name || <span className="sr-only">{rowName(zone, row.id)}</span>}</div>}
        {row.cells.map((dwellingId, column) => {
          const position = { zone: zone.id, row: row.id, column }
          return <div className="dwelling-layout-cell" key={cellKey(position)} data-cell={cellKey(position)}>
            {renderCell(position, dwellingId)}
          </div>
        })}
      </Fragment>)}
    </div>
  </div>
}
