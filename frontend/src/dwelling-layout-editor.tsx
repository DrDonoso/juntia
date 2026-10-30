import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode, type RefObject } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Accessibility, Feedback } from '@dnd-kit/dom'
import { DragDropProvider, useDraggable, useDroppable } from '@dnd-kit/react'
import { ApiError, api, cache, errorMessage } from './api/client'
import type { DwellingLayout, DwellingLayoutOut, DwellingLayoutZone, DwellingNeighborsOut, DwellingOut } from './api/schema.gen'
import { cellKey, DwellingZoneGrid, emptyDwellingLayout, layoutCellCount, layoutQueryKey, moveDwelling, placedDwellings, rowName, useDwellingLayout, type CellPosition } from './dwelling-layout'
import { formatNumber, t, useI18n } from './i18n'
import { Icon } from './icons'
import { NeighborsDirectory } from './neighbors'
import { Modal, Notice, useAction } from './shared'

interface EditorProps {
  dwellings: DwellingOut[]
  close: () => void
  restoreFocusRef: RefObject<HTMLButtonElement | null>
}

// The texts are looked up while rendering, so an open confirmation follows the active language.
interface Confirmation {
  kind: 'discard' | 'reload' | 'remove'
  affected?: string[]
  accept: () => void
}

const feedback = Feedback.configure({ dropAnimation: null })

function reordered<T>(items: T[], index: number, direction: -1 | 1): T[] {
  const target = index + direction
  if (target < 0 || target >= items.length) throw new Error(t('neighbors.editor.outOfBounds'))
  const next = [...items]
  const [item] = next.splice(index, 1)
  next.splice(target, 0, item)
  return next
}

function Tile({ dwelling, busy, move }: { dwelling: DwellingOut; busy: boolean; move: () => void }) {
  const { t } = useI18n()
  const { ref, handleRef, isDragging } = useDraggable({ id: dwelling.id, disabled: busy })
  return <div ref={ref} className={`layout-tile${isDragging ? ' dragging' : ''}`} data-dwelling-id={dwelling.id}>
    <div><button ref={handleRef} type="button" className="quiet icon-button layout-drag-handle" disabled={busy} aria-label={t('neighbors.editor.tile.drag', { dwelling: dwelling.label })}>
      <Icon name="grip" />
    </button><strong>{dwelling.label}</strong></div>
    <button type="button" className="secondary" disabled={busy} aria-label={t('neighbors.editor.tile.move', { dwelling: dwelling.label })} onClick={move}>{t('neighbors.editor.tile.moveTo')}</button>
  </div>
}

function DropTarget({ id, label, busy, children, tray = false }: {
  id: string; label: string; busy: boolean; children: ReactNode; tray?: boolean
}) {
  const { ref, isDropTarget } = useDroppable({ id, disabled: busy, accept: source => typeof source.id === 'number' })
  return <div ref={ref} className={`${tray ? 'layout-tray' : 'layout-drop'}${isDropTarget ? ' drag-over' : ''}`} data-drop={id} role="group" aria-label={label}>
    {children}
  </div>
}

function MoveDialog({ dwelling, layout, close, move }: {
  dwelling: DwellingOut; layout: DwellingLayout; close: () => void; move: (position: CellPosition | null) => void
}) {
  const { t } = useI18n()
  const [zoneId, setZoneId] = useState(''), [rowId, setRowId] = useState(''), [column, setColumn] = useState(0)
  const zone = layout.zones.find(value => value.id === zoneId)
  function submit(event: FormEvent) {
    event.preventDefault()
    move(zone ? { zone: zone.id, row: rowId, column } : null)
  }
  return <Modal title={t('neighbors.editor.moveDialog.title', { dwelling: dwelling.label })} close={close}>
    <form onSubmit={submit}>
      <label>{t('neighbors.editor.moveDialog.zone')}<select value={zoneId} onChange={event => {
        const next = layout.zones.find(value => value.id === event.target.value)
        setZoneId(event.target.value); setRowId(next?.rows[0].id || ''); setColumn(0)
      }}><option value="">{t('neighbors.editor.unplaced.title')}</option>{layout.zones.map(value => <option key={value.id} value={value.id}>{value.name}</option>)}</select></label>
      {zone && <>
        <label>{t('neighbors.editor.moveDialog.row')}<select value={rowId} onChange={event => setRowId(event.target.value)}>
          {zone.rows.map(row => <option key={row.id} value={row.id}>{rowName(zone, row.id)}</option>)}
        </select></label>
        <label>{t('neighbors.editor.moveDialog.column')}<select value={column} onChange={event => setColumn(Number(event.target.value))}>
          {Array.from({ length: zone.columns }, (_, index) => <option key={index} value={index}>{t('neighbors.layout.column', { number: index + 1 })}</option>)}
        </select></label>
        <p className="muted">{t('neighbors.editor.moveDialog.swap')}</p>
      </>}
      <div className="inline"><button>{t('neighbors.editor.moveDialog.submit')}</button><button type="button" className="secondary" onClick={close}>{t('common.cancel')}</button></div>
    </form>
  </Modal>
}

function Preview({ layout }: { layout: DwellingLayout }) {
  const { t } = useI18n()
  const query = useQuery({ queryKey: ['neighbors'], queryFn: () => api<DwellingNeighborsOut[]>('/neighbors') })
  return <section aria-label={t('neighbors.editor.previewPanel.region')}>
    <Notice>{t('neighbors.editor.previewPanel.notice')}</Notice>
    {query.isPending && <Notice>{t('neighbors.page.loading')}</Notice>}
    {query.error && <Notice error>{errorMessage(query.error)}</Notice>}
    {query.data && <NeighborsDirectory dwellings={query.data} layout={layout} />}
  </section>
}

function LoadedEditor({ initial, loadError, dwellings, close, restoreFocusRef }: EditorProps & { initial: DwellingLayoutOut; loadError?: unknown }) {
  const { t } = useI18n()
  const [base, setBase] = useState(initial)
  const [draft, setDraft] = useState<DwellingLayout>(() => structuredClone(initial.layout ?? emptyDwellingLayout))
  const [preview, setPreview] = useState(false), [dragging, setDragging] = useState(false)
  const [moving, setMoving] = useState<DwellingOut | null>(null)
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null)
  const [announcement, setAnnouncement] = useState('')
  const [movementFailed, setMovementFailed] = useState(false)
  const operation = useAction(false), running = useRef(false)
  const dirty = JSON.stringify(draft) !== JSON.stringify(base.layout ?? emptyDwellingLayout)
  const stale = initial.version > base.version || operation.failure instanceof ApiError && operation.failure.code === 'dwelling_layout_stale'
  const byId = useMemo(() => new Map(dwellings.map(dwelling => [dwelling.id, dwelling])), [dwellings])
  const placed = placedDwellings(draft)
  const unplaced = dwellings.filter(dwelling => !placed.has(dwelling.id))
  const cells = layoutCellCount(draft), limits = base.limits
  const targets = useMemo(() => new Map(draft.zones.flatMap(zone => zone.rows.flatMap(row => row.cells.map((_id, column) => {
    const position = { zone: zone.id, row: row.id, column }
    return [cellKey(position), { position, label: t('neighbors.editor.cell.target', { zone: zone.name, row: rowName(zone, row.id), number: column + 1 }) }] as const
  })))), [draft, t])
  const accessibility = useMemo(() => {
    const options: NonNullable<ConstructorParameters<typeof Accessibility>[1]> = {
      screenReaderInstructions: { draggable: t('neighbors.editor.drag.instructions') },
      announcements: {
        dragstart: event => {
          const dwelling = byId.get(Number(event.operation.source?.id))?.label
          return dwelling ? t('neighbors.editor.drag.pickedUp', { dwelling }) : t('neighbors.editor.drag.pickedUpUnknown')
        },
        dragover: event => {
          if (event.operation.target?.id === 'unplaced') return t('neighbors.editor.drag.overUnplaced')
          const target = targets.get(String(event.operation.target?.id))?.label
          return target ? t('neighbors.editor.drag.over', { target }) : t('neighbors.editor.drag.overOutside')
        },
        dragend: event => event.canceled || !event.operation.target ? t('neighbors.editor.drag.cancelled') : t('neighbors.editor.drag.dropped'),
      },
    }
    return Accessibility.configure(options)
  }, [byId, targets, t])
  useEffect(() => {
    if (!dirty && !operation.busy) return
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault() }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty, operation.busy])

  function run(work: () => Promise<void>, message = '') {
    if (running.current) return
    running.current = true
    void operation.run(work, message).finally(() => { running.current = false })
  }
  function requestClose() {
    if (dirty) setConfirmation({ kind: 'discard', accept: close })
    else close()
  }
  function reload() {
    run(async () => {
      const saved = await api<DwellingLayoutOut>('/neighbors/layout')
      setBase(saved); setDraft(structuredClone(saved.layout ?? emptyDwellingLayout)); setPreview(false); setAnnouncement('')
      cache.setQueryData(layoutQueryKey, saved)
    }, t('neighbors.editor.reloaded'))
  }
  function requestReload() {
    if (dirty) setConfirmation({ kind: 'reload', accept: reload })
    else reload()
  }
  function save(event: FormEvent) {
    event.preventDefault()
    run(async () => {
      const layout = { ...draft, zones: draft.zones.map(zone => ({
        ...zone, name: zone.name.trim().replace(/\s+/g, ' '),
        rows: zone.rows.map(row => ({ ...row, name: row.name.trim().replace(/\s+/g, ' ') })),
      })) }
      if (layout.zones.some(zone => !zone.name)) throw new Error(t('neighbors.editor.zoneNameRequired'))
      const saved = await api<DwellingLayoutOut>('/admin/dwellings/layout', 'PUT', { version: base.version, layout })
      setBase(saved); setDraft(structuredClone(saved.layout ?? emptyDwellingLayout)); setAnnouncement('')
      cache.setQueryData(layoutQueryKey, saved)
      await cache.invalidateQueries({ queryKey: ['neighbors'] })
    }, t('neighbors.editor.saved'))
  }
  function move(id: number, position: CellPosition | null) {
    if (!byId.has(id) || position && !targets.has(cellKey(position))) {
      setMovementFailed(true)
      return
    }
    setMovementFailed(false)
    setDraft(moveDwelling(draft, id, position))
    setMoving(null)
    const dwelling = byId.get(id)?.label ?? ''
    setAnnouncement(position
      ? t('neighbors.editor.moved', { dwelling, target: targets.get(cellKey(position))?.label ?? '' })
      : t('neighbors.editor.movedToUnplaced', { dwelling }))
  }
  function replaceZone(zone: DwellingLayoutZone) {
    setDraft({ ...draft, zones: draft.zones.map(value => value.id === zone.id ? zone : value) })
  }
  function removeStructure(next: DwellingLayout, affected: (number | null)[]) {
    const labels = affected.flatMap(id => id === null ? [] : [byId.get(id)?.label || t('neighbors.editor.fallbackDwelling', { id })])
    if (labels.length) setConfirmation({ kind: 'remove', affected: labels, accept: () => setDraft(next) })
    else setDraft(next)
  }
  function rowControls(zone: DwellingLayoutZone) {
    return <details className="layout-structure"><summary>{t('neighbors.editor.rows.summary')}</summary>
      {zone.rows.map((row, index) => <div className="layout-row-controls" key={row.id}>
        <label>{t('neighbors.layout.row', { number: index + 1 })}<input value={row.name} maxLength={150} placeholder={t('neighbors.editor.rows.placeholder')} disabled={operation.busy}
          aria-label={t('neighbors.editor.rows.nameLabel', { number: index + 1, zone: zone.name })}
          onChange={event => replaceZone({ ...zone, rows: zone.rows.map(value => value.id === row.id ? { ...value, name: event.target.value } : value) })} /></label>
        <button type="button" className="quiet icon-button" disabled={operation.busy || index === 0} aria-label={t('neighbors.editor.rows.moveUp', { row: rowName(zone, row.id), zone: zone.name })}
          onClick={() => replaceZone({ ...zone, rows: reordered(zone.rows, index, -1) })}><Icon name="arrow-up" /></button>
        <button type="button" className="quiet icon-button" disabled={operation.busy || index === zone.rows.length - 1} aria-label={t('neighbors.editor.rows.moveDown', { row: rowName(zone, row.id), zone: zone.name })}
          onClick={() => replaceZone({ ...zone, rows: reordered(zone.rows, index, 1) })}><Icon name="arrow-down" /></button>
        <button type="button" className="quiet danger" disabled={operation.busy || zone.rows.length === 1} aria-label={t('neighbors.editor.rows.removeLabel', { row: rowName(zone, row.id), zone: zone.name })}
          onClick={() => removeStructure({ ...draft, zones: draft.zones.map(value => value.id === zone.id ? { ...zone, rows: zone.rows.filter(value => value.id !== row.id) } : value) }, row.cells)}>{t('neighbors.editor.rows.remove')}</button>
      </div>)}
      <div className="inline">
        <button type="button" className="secondary" disabled={operation.busy || zone.rows.length >= limits.rows || cells + zone.columns > limits.cells}
          onClick={() => replaceZone({ ...zone, rows: [...zone.rows, { id: crypto.randomUUID(), name: '', cells: Array.from({ length: zone.columns }, () => null) }] })}>{t('neighbors.editor.rows.add')}</button>
        <button type="button" className="secondary" disabled={operation.busy || zone.columns >= limits.columns || cells + zone.rows.length > limits.cells}
          onClick={() => replaceZone({ ...zone, columns: zone.columns + 1, rows: zone.rows.map(row => ({ ...row, cells: [...row.cells, null] })) })}>{t('neighbors.editor.columns.add')}</button>
      </div>
      {zone.columns > 1 && <div className="layout-remove-columns">{Array.from({ length: zone.columns }, (_, column) => <button type="button" className="quiet danger" key={column}
        disabled={operation.busy} aria-label={t('neighbors.editor.columns.removeLabel', { number: column + 1, zone: zone.name })} onClick={() => removeStructure({
          ...draft,
          zones: draft.zones.map(value => value.id === zone.id ? { ...zone, columns: zone.columns - 1, rows: zone.rows.map(row => ({ ...row, cells: row.cells.filter((_id, index) => index !== column) })) } : value),
        }, zone.rows.map(row => row.cells[column]))}>{t('neighbors.editor.columns.remove', { number: column + 1 })}</button>)}</div>}
    </details>
  }

  return <Modal title={t('neighbors.editor.title')} close={requestClose} disabled={operation.busy || dragging} className="dwelling-layout-editor" restoreFocusRef={restoreFocusRef}>
    <p className="muted">{t('neighbors.editor.intro')}</p>
    {!!loadError && <Notice error>{errorMessage(loadError)}</Notice>}
    {operation.notice}
    {movementFailed && <Notice error>{t('neighbors.editor.movementUnavailable')}</Notice>}
    {stale && <Notice>{t('neighbors.editor.stale')}</Notice>}
    <p className="sr-only" role="status" aria-live="polite">{announcement}</p>
    <form onSubmit={save}>
      <div className="layout-toolbar">
        <span className="tag">{dirty ? t('neighbors.editor.unsaved') : t('neighbors.editor.noChanges')}</span>
        <span className="muted">{t('neighbors.editor.placed', { count: dwellings.length, placed: formatNumber(placed.size) })}</span>
        <button type="button" className="secondary" disabled={operation.busy} aria-pressed={preview} onClick={() => setPreview(!preview)}>{preview ? t('neighbors.editor.backToEditor') : t('neighbors.editor.preview')}</button>
        <button type="button" className="quiet" disabled={operation.busy} onClick={requestReload}>{t('neighbors.editor.loadSaved')}</button>
      </div>
      <fieldset className="layout-display-options">
        <legend>{t('neighbors.editor.display.legend')}</legend>
        <div className="inline">
          <label className="check"><input type="checkbox" checked={draft.show_row_names} disabled={operation.busy}
            onChange={event => setDraft({ ...draft, show_row_names: event.target.checked })} />{t('neighbors.editor.display.rowNames')}</label>
          <label className="check"><input type="checkbox" checked={draft.show_column_names} disabled={operation.busy}
            onChange={event => setDraft({ ...draft, show_column_names: event.target.checked })} />{t('neighbors.editor.display.columnNames')}</label>
        </div>
        <p className="muted">{t('neighbors.editor.display.help')}</p>
      </fieldset>
      {preview ? <Preview layout={draft} /> : <DragDropProvider plugins={defaults => defaults.map(plugin => plugin === Accessibility ? accessibility : plugin === Feedback ? feedback : plugin)}
        onDragStart={() => setDragging(true)} onDragEnd={event => {
          setDragging(false)
          if (event.canceled || !event.operation.target) return
          const id = event.operation.source?.id
          if (typeof id !== 'number') return
          if (event.operation.target.id === 'unplaced') move(id, null)
          else {
            const target = targets.get(String(event.operation.target.id))
            if (target) move(id, target.position)
          }
        }}>
        <p className="muted">{t('neighbors.editor.dragHelp')}</p>
        <div className="layout-editor-content">
          <aside aria-label={t('neighbors.editor.unplaced.region')}>
            <h3>{t('neighbors.editor.unplaced.title')} <span className="tag">{formatNumber(unplaced.length)}</span></h3>
            <DropTarget id="unplaced" label={t('neighbors.editor.unplaced.dropTarget')} busy={operation.busy} tray>
              {unplaced.map(dwelling => <Tile key={dwelling.id} dwelling={dwelling} busy={operation.busy} move={() => setMoving(dwelling)} />)}
              {unplaced.length === 0 && <p className="muted">{t('neighbors.editor.unplaced.allPlaced')}</p>}
            </DropTarget>
          </aside>
          <div className="layout-editor-zones">
            {draft.zones.map((zone, index) => <section className="layout-editor-zone" key={zone.id} aria-label={t('neighbors.editor.zone.region', { zone: zone.name })}>
              <div className="layout-zone-controls">
                <label>{t('neighbors.editor.zone.name')}<input required maxLength={150} value={zone.name} aria-label={t('neighbors.editor.zone.nameLabel', { number: index + 1 })} disabled={operation.busy}
                  onChange={event => replaceZone({ ...zone, name: event.target.value })} /></label>
                <button type="button" className="quiet icon-button" disabled={operation.busy || index === 0} aria-label={t('neighbors.editor.zone.moveUp', { zone: zone.name })}
                  onClick={() => setDraft({ ...draft, zones: reordered(draft.zones, index, -1) })}><Icon name="arrow-up" /></button>
                <button type="button" className="quiet icon-button" disabled={operation.busy || index === draft.zones.length - 1} aria-label={t('neighbors.editor.zone.moveDown', { zone: zone.name })}
                  onClick={() => setDraft({ ...draft, zones: reordered(draft.zones, index, 1) })}><Icon name="arrow-down" /></button>
                <button type="button" className="quiet danger" disabled={operation.busy} aria-label={t('neighbors.editor.zone.removeLabel', { zone: zone.name })}
                  onClick={() => removeStructure({ ...draft, zones: draft.zones.filter(value => value.id !== zone.id) }, zone.rows.flatMap(row => row.cells))}>{t('neighbors.editor.zone.remove')}</button>
              </div>
              {rowControls(zone)}
              <DwellingZoneGrid zone={zone} compact renderCell={(position, id) => {
                const dwelling = id === null ? null : byId.get(id)
                return <DropTarget id={cellKey(position)} label={targets.get(cellKey(position))?.label || t('neighbors.editor.cell.label')} busy={operation.busy}>
                  {dwelling ? <Tile dwelling={dwelling} busy={operation.busy} move={() => setMoving(dwelling)} />
                    : id === null ? <span className="layout-empty-cell">{t('neighbors.editor.cell.empty')}</span>
                      : <Notice error>{t('neighbors.editor.cell.missing')}</Notice>}
                </DropTarget>
              }} />
            </section>)}
            {draft.zones.length === 0 && <Notice>{t('neighbors.editor.zone.empty')}</Notice>}
            <button type="button" className="secondary" disabled={operation.busy || draft.zones.length >= limits.zones || cells + 2 > limits.cells}
              onClick={() => setDraft({ ...draft, zones: [...draft.zones, {
                id: crypto.randomUUID(), name: t('neighbors.editor.zone.defaultName', { number: draft.zones.length + 1 }), columns: 2,
                rows: [{ id: crypto.randomUUID(), name: '', cells: [null, null] }],
              }] })}>{t('neighbors.editor.zone.add')}</button>
            <p className="muted layout-limits">{t('neighbors.editor.zone.limits', {
              zones: formatNumber(limits.zones), rows: formatNumber(limits.rows), columns: formatNumber(limits.columns), cells: formatNumber(limits.cells),
            })}</p>
          </div>
        </div>
      </DragDropProvider>}
      <div className="layout-editor-footer"><button disabled={operation.busy || !dirty}>{operation.busy ? t('common.saving') : t('neighbors.editor.save')}</button>
        <button type="button" className="secondary" disabled={operation.busy} onClick={requestClose}>{t('common.cancel')}</button></div>
    </form>
    {moving && <MoveDialog dwelling={moving} layout={draft} close={() => setMoving(null)} move={position => move(moving.id, position)} />}
    {confirmation && <Modal title={t(`neighbors.editor.confirm.${confirmation.kind}.title`)} close={() => setConfirmation(null)} disabled={operation.busy}>
      <p>{t(`neighbors.editor.confirm.${confirmation.kind}.message`)}</p>
      {confirmation.affected && <ul>{confirmation.affected.map(label => <li key={label}>{label}</li>)}</ul>}
      <div className="inline"><button type="button" className="secondary danger" onClick={() => {
        const accept = confirmation.accept; setConfirmation(null); accept()
      }}>{t('neighbors.editor.confirm.accept')}</button><button type="button" className="secondary" onClick={() => setConfirmation(null)}>{t('neighbors.editor.confirm.keepEditing')}</button></div>
    </Modal>}
  </Modal>
}

export function DwellingLayoutEditor(props: EditorProps) {
  const { t } = useI18n()
  const query = useDwellingLayout()
  if (query.data) return <LoadedEditor {...props} initial={query.data} loadError={query.error} />
  return <Modal title={t('neighbors.editor.title')} close={props.close} className="dwelling-layout-editor" restoreFocusRef={props.restoreFocusRef}>
    {query.isPending && <Notice>{t('neighbors.editor.loading')}</Notice>}
    {query.error && <><Notice error>{errorMessage(query.error)}</Notice><button type="button" className="secondary" onClick={() => void query.refetch()}>{t('common.retry')}</button></>}
  </Modal>
}
