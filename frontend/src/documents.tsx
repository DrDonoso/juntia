import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent, type MouseEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { Link, useParams, useSearchParams } from 'react-router'
import { ApiError, api, cache, codeMessage, errorMessage } from './api/client'
import type {
  DocumentBrowseOut, DocumentEventOut, DocumentExcerpt, DocumentFolderInfoOut, DocumentFolderOut, DocumentFolderRef, DocumentHistoryPage,
  DocumentInfoOut, DocumentLimitsOut, DocumentOut, DocumentSearchPage, DocumentTextOut, DocumentTreeFolderOut, DocumentVersionOut,
} from './api/schema.gen'
import { useReaderAuth } from './auth'
import { ActionTime, byteSize } from './community-action-shared'
import { extensionOf, uploads, useUploads, type UploadEntry } from './document-upload'
import { FilePreview, opensInViewer, plainClick, type PreviewFile } from './file-preview'
import { compareText, dateTimeFormat, formatNumber, useI18n, type Translate } from './i18n'
import { Icon, type IconName } from './icons'
import { Modal, Notice, Pagination, authorName, useAction, useFeatures } from './shared'

export type DocumentKind = DocumentOut['kind']
export type DocumentItem = { kind: 'folder'; value: DocumentFolderOut } | { kind: 'file'; value: DocumentOut }
type Sort = 'name' | 'modified' | 'size'
type Dialog = { kind: 'folder' } | { kind: 'rename' | 'move' | 'delete' | 'info'; item: DocumentItem } | { kind: 'view'; file: PreviewFile }

const KIND_ICONS: Record<DocumentKind, IconName> = {
  pdf: 'file-text', image: 'image', video: 'video', document: 'file-text', spreadsheet: 'table',
  presentation: 'presentation', text: 'file',
}

export const itemKey = (item: DocumentItem) => `${item.kind}:${item.value.id}`
export const kindIcon = (kind: DocumentKind) => KIND_ICONS[kind]
export const previewUrl = (versionId: string) => `/api/documents/versions/${versionId}/preview`
export const downloadUrl = (versionId: string) => `/api/documents/versions/${versionId}/download`

/** How the portal's viewer shows a file, if it does: PDFs, pictures, videos, and text and CSV files. */
export function documentPreview(file: DocumentOut): PreviewFile | null {
  const { kind } = file
  if (!file.previewable) return null
  const base = { name: file.name, path: `/documents/versions/${file.current.id}/preview`, download: downloadUrl(file.current.id) }
  if (kind === 'text') return { ...base, kind, extension: file.current.extension, size: file.current.size }
  return kind === 'pdf' || kind === 'image' || kind === 'video' ? { ...base, kind } : null
}

/** The folder that holds an item, from the folders above it. */
function folderLink(location: readonly DocumentFolderRef[]): string {
  const parent = location.at(-1)
  return parent ? `/documents/folders/${parent.id}` : '/documents'
}

export function archiveUrl(items: DocumentItem[]): string {
  const params = new URLSearchParams()
  for (const item of items) params.append(item.kind === 'folder' ? 'folder' : 'file', String(item.value.id))
  return `/api/documents/archive?${params}`
}

/** The folders above an item, as people read them: "Documents / Minutes / 2026". */
export function locationText(names: readonly string[], translate: Translate): string {
  return [translate('documents.root'), ...names].join(' / ')
}

function itemSize(item: DocumentItem): number {
  return item.kind === 'folder' ? item.value.size : item.value.current.size
}

function sorted(items: DocumentItem[], sort: Sort): DocumentItem[] {
  return [...items].sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === 'folder' ? -1 : 1
    if (sort === 'modified' && left.value.updated_at !== right.value.updated_at) {
      return left.value.updated_at < right.value.updated_at ? 1 : -1
    }
    if (sort === 'size' && itemSize(left) !== itemSize(right)) return itemSize(right) - itemSize(left)
    return compareText(left.value.name, right.value.name) || left.value.id - right.value.id
  })
}

function folderParam(value: string | undefined): number | null | undefined {
  if (value === undefined) return null
  return /^[1-9][0-9]{0,9}$/.test(value) && Number(value) <= 2147483647 ? Number(value) : undefined
}

function shortDate(value: string): string {
  return dateTimeFormat({ dateStyle: 'medium' }).format(new Date(value))
}

export function DocumentFeatureGate({ children }: { children: ReactNode }) {
  const features = useFeatures()
  const { t } = useI18n()
  if (features.isPending) return <Notice>{t('documents.gate.checking')}</Notice>
  if (features.error) return <Notice error>{errorMessage(features.error)}</Notice>
  if (!features.data.documents) return <section className="card">
    <h1>{t('documents.gate.title')}</h1>
    <p>{t('documents.gate.description')}</p>
  </section>
  return children
}

export function DocumentsPage() {
  return <DocumentFeatureGate><DocumentsBrowser /></DocumentFeatureGate>
}

function DocumentsBrowser() {
  const { t } = useI18n()
  const params = useParams()
  const reader = useReaderAuth()
  const identity = reader.data?.authenticated ? String(reader.data.user_id) : null
  useEffect(() => { if (identity !== null) uploads.claim(identity) }, [identity])
  const folderId = folderParam(params.folderId)
  if (folderId === undefined) return <section className="card"><Notice error>{t('errors.codes.document_folder_not_found')}</Notice>
    <Link to="/documents">{t('documents.backToRoot')}</Link></section>
  return <FolderView key={folderId ?? 'root'} folderId={folderId} />
}

function useBrowse(folderId: number | null) {
  return useQuery({
    queryKey: ['documents', 'browse', folderId ?? 'root'],
    queryFn: ({ signal }) => api<DocumentBrowseOut>(
      folderId === null ? '/documents/browse' : `/documents/browse?folder=${folderId}`, 'GET', undefined, signal,
    ),
  })
}

/** Folders and files anywhere in Documents whose name contains `q`, a page at a time. */
function useSearch(q: string, sort: Sort, page: number) {
  const params = new URLSearchParams({ q, sort, page: String(page) })
  return useQuery({
    queryKey: ['documents', 'search', q, sort, page],
    queryFn: ({ signal }) => api<DocumentSearchPage>(`/documents/search?${params}`, 'GET', undefined, signal),
    enabled: q !== '', placeholderData: keepPreviousData,
  })
}

function pageParam(value: string | null): number {
  const page = Number(value ?? '1')
  return Number.isInteger(page) && page >= 1 && page <= 1000000 ? page : 1
}

function Breadcrumbs({ path }: { path: DocumentFolderRef[] }) {
  const { t } = useI18n()
  // At the top level the title already says where people are.
  if (!path.length) return null
  return <nav className="document-path" aria-label={t('documents.path')}><ol>
    <li><Link to="/documents">{t('documents.root')}</Link></li>
    {path.map((folder, index) => <li key={folder.id}>{index === path.length - 1
      ? <span aria-current="page">{folder.name}</span>
      : <Link to={`/documents/folders/${folder.id}`}>{folder.name}</Link>}</li>)}
  </ol></nav>
}

function accept(limits: DocumentLimitsOut): string {
  return limits.extensions.map(extension => `.${extension}`).join(',')
}

function FolderView({ folderId }: { folderId: number | null }) {
  const { t } = useI18n()
  const query = useBrowse(folderId)
  const [params, setParams] = useSearchParams()
  // The search covers all of Documents, wherever it is typed; the address keeps it for Back.
  const search = params.get('q') ?? '', q = search.trim(), searchPage = pageParam(params.get('page'))
  const linkedFile = params.get('file')
  function closeLinkedFile() {
    setParams(previous => {
      const next = new URLSearchParams(previous)
      next.delete('file')
      return next
    }, { replace: true })
  }
  const [sort, setSort] = useState<Sort>('name')
  const results = useSearch(q, sort, searchPage)
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const [message, setMessage] = useState('')
  const fileInput = useRef<HTMLInputElement>(null), versionInput = useRef<HTMLInputElement>(null)
  const versionTarget = useRef<DocumentOut | null>(null), list = useRef<HTMLHeadingElement>(null)
  const headingId = useId()
  const data = query.data
  const folderName = data?.folder?.name ?? t('documents.title')
  const items = data ? sorted([
    ...data.folders.map(value => ({ kind: 'folder' as const, value })),
    ...data.files.map(value => ({ kind: 'file' as const, value })),
  ], sort) : []
  const found = q ? results.data : undefined
  // The server's order: folders, files found by name, then files found by their text.
  const matches: DocumentItem[] = found ? [
    ...found.folders.map(value => ({ kind: 'folder' as const, value })),
    ...found.files.map(value => ({ kind: 'file' as const, value })),
  ] : []
  const locations = new Map<string, DocumentFolderRef[]>([
    ...(found?.folders ?? []).map(value => [`folder:${value.id}`, value.location] as const),
    ...(found?.files ?? []).map(value => [`file:${value.id}`, value.location] as const),
  ])
  const excerpts = new Map<string, DocumentExcerpt | null>((found?.files ?? []).map(value => [`file:${value.id}`, value.excerpt] as const))
  const shown = q ? matches : items
  const chosen = shown.filter(item => selected.has(itemKey(item)))
  function filter(changes: { q?: string; page?: number }) {
    const next = new URLSearchParams(params)
    if (changes.q !== undefined) {
      if (changes.q) next.set('q', changes.q); else next.delete('q')
      setSelected(new Set())
    }
    if (changes.page && changes.page > 1) next.set('page', String(changes.page)); else next.delete('page')
    setParams(next, { replace: true })
  }
  function toggle(item: DocumentItem) {
    setSelected(previous => {
      const next = new Set(previous), key = itemKey(item)
      if (!next.delete(key)) next.add(key)
      return next
    })
  }
  function finished(text: string) {
    setDialog(null)
    setMessage(text)
    void cache.invalidateQueries({ queryKey: ['documents'] })
    list.current?.focus()
  }
  function newVersion(file: DocumentOut) {
    const input = versionInput.current
    if (!input) return
    versionTarget.current = file
    input.accept = `.${file.current.extension}`
    input.click()
  }
  function act(action: 'rename' | 'move' | 'delete' | 'info', item: DocumentItem) {
    setMessage('')
    setDialog({ kind: action, item })
  }
  return <>
    <div className="page-heading documents-heading">
      <div><p className="eyebrow">{t('documents.eyebrow')}</p><h1>{folderName}</h1><Breadcrumbs path={data?.path ?? []} /></div>
      <div className="inline documents-toolbar">
        <button type="button" className="secondary" disabled={!data} onClick={() => { setMessage(''); setDialog({ kind: 'folder' }) }}>
          <Icon name="folder-plus" />{t('documents.newFolder')}</button>
        <button type="button" disabled={!data} onClick={() => fileInput.current?.click()}><Icon name="upload" />{t('documents.upload')}</button>
        {data && <input ref={fileInput} type="file" multiple hidden accept={accept(data.limits)} aria-label={t('documents.uploadInput')}
          onChange={event => {
            const files = Array.from(event.currentTarget.files ?? [])
            event.currentTarget.value = ''
            if (files.length) uploads.add(files, { folderId }, folderName, data.limits)
          }} />}
        {data && <input ref={versionInput} type="file" hidden aria-label={t('documents.versionInput')} onChange={event => {
          const [file] = Array.from(event.currentTarget.files ?? [])
          const document = versionTarget.current
          event.currentTarget.value = ''
          if (file && document) uploads.add([file], { documentId: document.id }, document.name, data.limits)
        }} />}
      </div>
    </div>
    <p className="notice documents-public"><Icon name="info" size={16} />{t('documents.publicNotice')}</p>
    <UploadQueue />
    {message && <Notice>{message}</Notice>}
    {query.isPending && <Notice>{t('documents.loading')}</Notice>}
    {query.error && <section className="card">
      <Notice error>{errorMessage(query.error)}</Notice>
      {query.error instanceof ApiError && query.error.code === 'document_folder_not_found'
        ? <Link to="/documents">{t('documents.backToRoot')}</Link>
        : <button type="button" className="secondary" disabled={query.isFetching} onClick={() => void query.refetch()}>{t('common.retryLoading')}</button>}
    </section>}
    {data && !query.error && <>
      {chosen.length > 0 && <SelectionBar items={chosen} limits={data.limits} clear={() => setSelected(new Set())} />}
      <section className="card documents-browser" aria-labelledby={headingId}>
        <div className="documents-browser-header">
          <h2 id={headingId} ref={list} tabIndex={-1}>{!q ? t('documents.list.title', { count: items.length })
            : found ? t('documents.search.results', { count: found.total }) : t('documents.search.loading')}</h2>
          <div className="documents-browser-filters">
            <label className="documents-search">{t('documents.search.label')}<input type="search" maxLength={200}
              placeholder={t('documents.search.placeholder')} value={search} onChange={event => filter({ q: event.target.value })} /></label>
            <label>{t('documents.sort.label')}<select value={sort} onChange={event => {
              const value = event.target.value
              setSort(value === 'modified' || value === 'size' ? value : 'name')
              if (searchPage > 1) filter({ page: 1 })
            }}>
              <option value="name">{t('documents.sort.name')}</option>
              <option value="modified">{t('documents.sort.modified')}</option>
              <option value="size">{t('documents.sort.size')}</option>
            </select></label>
          </div>
        </div>
        {q ? <>
          {results.isPending && <Notice>{t('documents.search.loading')}</Notice>}
          {results.error && <><Notice error>{errorMessage(results.error)}</Notice>
            <button type="button" className="secondary" disabled={results.isFetching} onClick={() => void results.refetch()}>{t('common.retryLoading')}</button></>}
          {found && found.pending > 0 && <p className="muted documents-search-pending">
            <Icon name="info" size={16} />{t('documents.search.pending', { count: found.pending })}</p>}
          {found && (matches.length === 0
            ? <p className="empty">{searchPage > 1 ? t('documents.search.emptyPage') : t('documents.search.empty', { query: q })}</p>
            : <ul className="document-grid" aria-label={t('documents.search.listLabel', { query: q })} aria-busy={results.isFetching}
              data-selecting={chosen.length > 0 || undefined}>
              {matches.map(item => <DocumentCard key={itemKey(item)} item={item} selected={selected.has(itemKey(item))}
                toggle={() => toggle(item)} act={action => act(action, item)} newVersion={newVersion}
                view={file => { setMessage(''); setDialog({ kind: 'view', file }) }} location={locations.get(itemKey(item))}
                excerpt={excerpts.get(itemKey(item))} />)}
            </ul>)}
          {found && <Pagination page={searchPage} pages={found.pages} change={page => filter({ page })} busy={results.isFetching}
            label={t('documents.search.pagination')} />}
        </> : items.length === 0 ? <p className="empty">{folderId === null ? t('documents.empty.root') : t('documents.empty.folder')}</p>
          : <ul className="document-grid" aria-label={t('documents.list.label', { folder: folderName })} data-selecting={chosen.length > 0 || undefined}>
            {items.map(item => <DocumentCard key={itemKey(item)} item={item} selected={selected.has(itemKey(item))}
              toggle={() => toggle(item)} act={action => act(action, item)} newVersion={newVersion}
              view={file => { setMessage(''); setDialog({ kind: 'view', file }) }} />)}
          </ul>}
      </section>
    </>}
    {dialog?.kind === 'folder' && <FolderDialog parentId={folderId} close={() => setDialog(null)}
      done={name => finished(t('documents.folderDialog.created', { name }))} />}
    {dialog?.kind === 'rename' && <RenameDialog item={dialog.item} close={() => setDialog(null)}
      done={name => finished(t('documents.rename.done', { name }))} />}
    {dialog?.kind === 'move' && <MoveDialog item={dialog.item} close={() => setDialog(null)}
      done={() => finished(t('documents.move.done', { name: dialog.item.value.name }))} />}
    {dialog?.kind === 'delete' && <DeleteDialog item={dialog.item} close={() => setDialog(null)} done={() => {
      setSelected(previous => { const next = new Set(previous); next.delete(itemKey(dialog.item)); return next })
      finished(t('documents.deletion.done', { name: dialog.item.value.name }))
    }} />}
    {dialog?.kind === 'info' && <InfoDialog item={dialog.item} close={() => setDialog(null)}
      newVersion={dialog.item.kind === 'file' ? () => {
        if (dialog.item.kind === 'file') newVersion(dialog.item.value)
        setDialog(null)
      } : undefined} />}
    {dialog?.kind === 'view' && <FilePreview file={dialog.file} close={() => setDialog(null)} />}
    {linkedFile !== null && <LinkedFile key={linkedFile} raw={linkedFile} close={closeLinkedFile} newVersion={newVersion} />}
  </>
}

/**
 * The file the address names (`?file=<id>`, which the search opens): in the viewer, or its details
 * when the viewer does not show it here.
 */
function LinkedFile({ raw, close, newVersion }: { raw: string; close: () => void; newVersion: (file: DocumentOut) => void }) {
  const { t } = useI18n()
  const id = folderParam(raw)
  const query = useQuery({
    queryKey: ['documents', 'file', id],
    queryFn: ({ signal }) => api<DocumentInfoOut>(`/documents/files/${id}`, 'GET', undefined, signal),
    enabled: typeof id === 'number',
  })
  const value = query.data
  if (value) {
    const preview = documentPreview(value)
    return preview && opensInViewer(preview.kind) ? <FilePreview file={preview} close={close} />
      : <InfoDialog item={{ kind: 'file', value }} close={close} newVersion={() => { close(); newVersion(value) }} />
  }
  if (typeof id === 'number' && !query.error) return null
  return <Modal title={t('documents.info.missing')} close={close}>
    <Notice error>{query.error ? errorMessage(query.error) : codeMessage('document_not_found')}</Notice>
  </Modal>
}

type MenuOption = {
  id: string; label: string; icon: IconName; danger?: boolean
} & ({ run: () => void; href?: undefined } | { href: string; newTab?: boolean; run?: undefined })

export function ItemMenu({ label, options }: { label: string; options: MenuOption[] }) {
  const { t } = useI18n()
  const id = useId(), trigger = useRef<HTMLButtonElement>(null), menu = useRef<HTMLDivElement>(null)
  const entries = useRef<(HTMLElement | null)[]>([])
  const [open, setOpen] = useState<'first' | 'last' | null>(null)
  const [position, setPosition] = useState({ top: 0, left: 0 })
  const place = useCallback(() => {
    if (!trigger.current || !menu.current) return
    const bounds = trigger.current.getBoundingClientRect()
    const height = menu.current.offsetHeight, width = menu.current.offsetWidth
    const next = {
      left: Math.max(8, Math.min(bounds.right - width, window.innerWidth - width - 8)),
      top: Math.max(8, bounds.bottom + height + 8 <= window.innerHeight ? bounds.bottom + 4 : bounds.top - height - 4),
    }
    setPosition(previous => previous.left === next.left && previous.top === next.top ? previous : next)
  }, [])
  useLayoutEffect(() => {
    if (!open) return
    place()
    entries.current[open === 'last' ? options.length - 1 : 0]?.focus({ preventScroll: true })
  }, [open, place, options.length])
  useEffect(() => {
    if (!open) return
    function outside(event: PointerEvent) {
      if (event.target instanceof Node && !menu.current?.contains(event.target) && !trigger.current?.contains(event.target)) setOpen(null)
    }
    document.addEventListener('pointerdown', outside)
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      document.removeEventListener('pointerdown', outside)
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [open, place])
  function dismiss() { setOpen(null); trigger.current?.focus({ preventScroll: true }) }
  return <div className="document-menu">
    <button ref={trigger} type="button" className="quiet icon-button" title={t('documents.menu.title')} aria-label={label}
      aria-haspopup="menu" aria-expanded={!!open} aria-controls={open ? id : undefined}
      onClick={() => setOpen(open ? null : 'first')} onKeyDown={event => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault(); setOpen(event.key === 'ArrowUp' ? 'last' : 'first')
        }
      }}><Icon name="more-vertical" /></button>
    {open && createPortal(<div id={id} ref={menu} role="menu" aria-label={label} className="contact-menu document-menu-list" style={position}
      onKeyDown={event => {
        const current = entries.current.findIndex(entry => entry === document.activeElement)
        let next: number | undefined
        if (event.key === 'ArrowDown') next = (current + 1) % options.length
        if (event.key === 'ArrowUp') next = (current + options.length - 1) % options.length
        if (event.key === 'Home') next = 0
        if (event.key === 'End') next = options.length - 1
        if (next !== undefined) { event.preventDefault(); entries.current[next]?.focus({ preventScroll: true }) }
        if (event.key === 'Escape') { event.preventDefault(); dismiss() }
        if (event.key === 'Tab') dismiss()
      }}>
      {options.map((option, index) => {
        const className = `quiet${option.danger ? ' danger' : ''}`
        const content = <><Icon name={option.icon} size={18} />{option.label}</>
        return option.href !== undefined
          ? <a key={option.id} ref={node => { entries.current[index] = node }} role="menuitem" className={`button ${className}`}
            href={option.href} {...option.newTab ? { target: '_blank', rel: 'noopener noreferrer' } : { download: '' }}
            onClick={() => setOpen(null)}>{content}</a>
          : <button key={option.id} ref={node => { entries.current[index] = node }} role="menuitem" type="button"
            className={className} onClick={() => { dismiss(); option.run() }}>{content}</button>
      })}
    </div>, document.body)}
  </div>
}

function DocumentCard({ item, selected, toggle, act, newVersion, view, location, excerpt }: {
  item: DocumentItem; selected: boolean; toggle: () => void
  act: (action: 'rename' | 'move' | 'delete' | 'info') => void; newVersion: (file: DocumentOut) => void
  view: (file: PreviewFile) => void
  // The folders above a search result.
  location?: DocumentFolderRef[]
  // Where the text of a file found by its text contains the search.
  excerpt?: DocumentExcerpt | null
}) {
  const { t } = useI18n()
  const name = item.value.name
  const options: MenuOption[] = []
  const preview = item.kind === 'file' ? documentPreview(item.value) : null
  // Left to the browser: PDFs on phones and tablets.
  const viewer = preview && opensInViewer(preview.kind) ? preview : null
  const openViewer = (event: MouseEvent<HTMLAnchorElement>) => {
    if (!preview || !plainClick(event) || !opensInViewer(preview.kind)) return
    event.preventDefault()
    view(preview)
  }
  if (item.kind === 'file') {
    const file = item.value
    if (preview) options.push(viewer
      ? { id: 'preview', label: t('documents.menu.preview'), icon: 'eye', run: () => view(viewer) }
      : { id: 'preview', label: t('documents.menu.preview'), icon: 'eye', href: previewUrl(file.current.id), newTab: true })
    options.push({ id: 'download', label: t('documents.menu.download'), icon: 'download', href: downloadUrl(file.current.id) })
  } else {
    options.push({ id: 'download', label: t('documents.menu.downloadFolder'), icon: 'download', href: archiveUrl([item]) })
  }
  options.push({ id: 'select', label: selected ? t('documents.menu.unselect') : t('documents.menu.select'), icon: 'check', run: toggle })
  if (item.value.can_manage) {
    options.push({ id: 'rename', label: t('documents.menu.rename'), icon: 'edit', run: () => act('rename') })
    options.push({ id: 'move', label: t('documents.menu.move'), icon: 'move', run: () => act('move') })
    if (item.kind === 'file') {
      const file = item.value
      options.push({ id: 'version', label: t('documents.menu.newVersion'), icon: 'upload', run: () => newVersion(file) })
    }
  }
  options.push({ id: 'info', label: t('documents.menu.info'), icon: 'info', run: () => act('info') })
  if (item.kind === 'file' ? item.value.can_manage : item.value.can_delete) {
    options.push({ id: 'delete', label: t('documents.menu.delete'), icon: 'trash', danger: true, run: () => act('delete') })
  }
  return <li className={`document-card${selected ? ' selected' : ''}`}>
    <input type="checkbox" className="document-check" checked={selected} onChange={toggle} aria-label={t('documents.card.select', { name })} />
    {item.kind === 'folder'
      ? <Link className="document-open" to={`/documents/folders/${item.value.id}`}>
        <Icon name="folder" size={40} className="document-icon document-icon-folder" /><span className="document-name">{name}</span></Link>
      : <a className="document-open" href={item.value.previewable ? previewUrl(item.value.current.id) : downloadUrl(item.value.current.id)}
        {...item.value.previewable ? { target: '_blank', rel: 'noopener noreferrer' } : { download: '' }} onClick={openViewer}>
        <Icon name={kindIcon(item.value.kind)} size={40} className={`document-icon document-icon-${item.value.kind}`} />
        <span className="document-name">{name}</span></a>}
    <p className="document-meta">{item.kind === 'folder'
      ? t('documents.card.folderMeta', { count: item.value.file_count, size: byteSize(item.value.size) })
      : t('documents.card.fileMeta', { size: byteSize(item.value.current.size), date: shortDate(item.value.updated_at) })}
      {item.kind === 'file' && item.value.version_count > 1 && <span className="tag">{t('documents.card.version', { number: item.value.version_count })}</span>}
    </p>
    {location && <p className="document-location"><Link to={folderLink(location)}><Icon name="folder" size={14} />
      {t('documents.card.location', { location: locationText(location.map(folder => folder.name), t) })}</Link></p>}
    {excerpt && <p className="document-excerpt">{excerpt.before}<mark>{excerpt.match}</mark>{excerpt.after}</p>}
    <div className="document-card-actions">
      {preview && <a className="button quiet icon-button" href={`/api${preview.path}`}
        target="_blank" rel="noopener noreferrer" aria-label={t('documents.card.preview', { name })}
        title={t('documents.card.previewTitle')} onClick={openViewer}>
        <Icon name="eye" /></a>}
      <ItemMenu label={t('documents.menu.label', { name })} options={options} />
    </div>
  </li>
}

function SelectionBar({ items, limits, clear }: { items: DocumentItem[]; limits: DocumentLimitsOut; clear: () => void }) {
  const { t } = useI18n()
  const files = items.reduce((total, item) => total + (item.kind === 'folder' ? item.value.file_count : 1), 0)
  const size = items.reduce((total, item) => total + itemSize(item), 0)
  const tooMany = items.length > limits.archive_max_items
  const tooLarge = files > limits.archive_max_files || size > limits.archive_max_bytes
  return <section className="card document-selection" aria-label={t('documents.selection.label')}>
    <p role="status"><strong>{t('documents.selection.count', { count: items.length })}</strong>
      {' · '}{t('documents.selection.contents', { count: files, size: byteSize(size) })}</p>
    <div className="inline">
      {tooMany || tooLarge
        ? <button type="button" disabled><Icon name="download" />{t('documents.selection.download')}</button>
        : <a className="button" href={archiveUrl(items)} download=""><Icon name="download" />{t('documents.selection.download')}</a>}
      <button type="button" className="secondary" onClick={clear}>{t('documents.selection.clear')}</button>
    </div>
    {tooMany && <Notice error>{t('documents.selection.tooMany', { count: limits.archive_max_items })}</Notice>}
    {!tooMany && tooLarge && <Notice error>{t('documents.selection.tooLarge', {
      files: formatNumber(limits.archive_max_files), size: byteSize(limits.archive_max_bytes),
    })}</Notice>}
  </section>
}

function uploadStatus(entry: UploadEntry, translate: Translate): string {
  switch (entry.state) {
    case 'waiting': return translate('documents.uploads.states.waiting')
    case 'uploading': return translate('documents.uploads.states.uploading', {
      sent: byteSize(entry.sent), total: byteSize(entry.file.size),
      percent: formatNumber(entry.file.size ? entry.sent / entry.file.size : 1, { style: 'percent' }),
    })
    case 'checking': return translate('documents.uploads.states.checking')
    case 'done': return translate('documents.uploads.states.done', { name: entry.result?.name ?? entry.file.name })
    case 'cancelled': return translate('documents.uploads.states.cancelled')
    case 'failed': return translate('documents.uploads.states.failed')
  }
}

function uploadProblem(entry: UploadEntry, translate: Translate): string {
  if (entry.problem === 'unsupported') return translate('documents.uploads.problems.unsupported')
  if (entry.problem === 'empty') return translate('documents.uploads.problems.empty')
  if (entry.problem === 'too_large') return translate('documents.uploads.problems.tooLarge', { size: byteSize(entry.limitBytes) })
  return errorMessage(entry.error)
}

function UploadQueue() {
  const { t } = useI18n()
  const entries = useUploads(), heading = useId()
  if (!entries.length) return null
  const finished = entries.some(entry => entry.state === 'done' || entry.state === 'cancelled')
  return <section className="card document-uploads" aria-labelledby={heading}>
    <div className="documents-browser-header">
      <h2 id={heading}>{t('documents.uploads.title')}</h2>
      {finished && <button type="button" className="quiet" onClick={() => uploads.clearFinished()}>{t('documents.uploads.clear')}</button>}
    </div>
    <p className="muted">{t('documents.uploads.keepOpen')}</p>
    <ul className="document-upload-list">{entries.map(entry => {
      const active = entry.state === 'waiting' || entry.state === 'uploading' || entry.state === 'checking'
      return <li key={entry.key} data-state={entry.state}>
        <div className="document-upload-info">
          <strong className="document-name">{entry.file.name}</strong>
          <span className="muted">{t('documents.uploads.destination', { folder: entry.destination })}</span>
        </div>
        {entry.state !== 'failed' && entry.state !== 'cancelled' && <progress max={entry.file.size || 1} value={entry.state === 'done' ? entry.file.size || 1 : entry.sent}
          aria-label={t('documents.uploads.progress', { name: entry.file.name })} />}
        <p className="muted" role="status">{uploadStatus(entry, t)}</p>
        {entry.state === 'failed' && <Notice error>{uploadProblem(entry, t)}</Notice>}
        <div className="inline">
          {entry.state === 'failed' && !entry.problem && <button type="button" className="secondary" onClick={() => uploads.retry(entry.key)}>
            <Icon name="refresh" size={16} />{t('documents.uploads.retry')}</button>}
          {active && <button type="button" className="secondary" onClick={() => uploads.cancel(entry.key)}>{t('documents.uploads.cancel')}</button>}
          {!active && <button type="button" className="quiet" onClick={() => uploads.dismiss(entry.key)}
            aria-label={t('documents.uploads.dismissLabel', { name: entry.file.name })}>{t('documents.uploads.dismiss')}</button>}
        </div>
      </li>
    })}</ul>
  </section>
}

function nameError(error: unknown, translate: Translate): string {
  return error instanceof ApiError && error.fields.name ? translate(error.fields.name === 'document_name_taken'
    ? 'errors.codes.document_name_taken' : 'errors.codes.document_name_invalid') : ''
}

function FolderDialog({ parentId, close, done }: { parentId: number | null; close: () => void; done: (name: string) => void }) {
  const { t } = useI18n()
  const [name, setName] = useState('')
  const operation = useAction(false), id = useId()
  const fieldError = nameError(operation.failure, t)
  function submit(event: FormEvent) {
    event.preventDefault()
    void operation.run(async () => {
      const folder = await api<DocumentFolderOut>('/documents/folders', 'POST', { name, parent_id: parentId })
      done(folder.name)
    })
  }
  return <Modal title={t('documents.folderDialog.title')} close={close} disabled={operation.busy}>
    <form onSubmit={submit}>
      <label htmlFor={id}>{t('documents.folderDialog.name')}</label>
      <input id={id} required maxLength={200} value={name} autoFocus aria-invalid={!!fieldError || undefined}
        aria-describedby={`${id}-rules`} onChange={event => { setName(event.target.value); operation.reset() }} />
      <p id={`${id}-rules`} className="muted">{t('documents.nameRules')}</p>
      {fieldError ? <Notice error>{fieldError}</Notice> : operation.notice}
      <div className="inline">
        <button disabled={operation.busy || !name.trim()}>{operation.busy ? t('documents.folderDialog.creating') : t('documents.folderDialog.create')}</button>
        <button type="button" className="secondary" disabled={operation.busy} onClick={close}>{t('common.cancel')}</button>
      </div>
    </form>
  </Modal>
}

function itemPath(item: DocumentItem): string {
  return item.kind === 'folder' ? `/documents/folders/${item.value.id}` : `/documents/files/${item.value.id}`
}

function RenameDialog({ item, close, done }: { item: DocumentItem; close: () => void; done: (name: string) => void }) {
  const { t } = useI18n()
  const extension = item.kind === 'file' ? extensionOf(item.value.name) : ''
  const suffix = extension ? item.value.name.slice(-(extension.length + 1)) : ''
  const [name, setName] = useState(suffix ? item.value.name.slice(0, -suffix.length) : item.value.name)
  const operation = useAction(false), id = useId()
  const fieldError = nameError(operation.failure, t)
  function submit(event: FormEvent) {
    event.preventDefault()
    void operation.run(async () => {
      const saved = await api<DocumentOut | DocumentFolderOut>(itemPath(item), 'PATCH', {
        version: item.value.version, name: name + suffix,
      })
      done(saved.name)
    })
  }
  return <Modal title={t('documents.rename.title', { name: item.value.name })} close={close} disabled={operation.busy}>
    <form onSubmit={submit}>
      <label htmlFor={id}>{t('documents.rename.name')}</label>
      <div className="document-name-field"><input id={id} required maxLength={200} value={name} autoFocus aria-invalid={!!fieldError || undefined}
        aria-describedby={`${id}-rules`} onChange={event => { setName(event.target.value); operation.reset() }} />
        {suffix && <span className="muted">{suffix}</span>}</div>
      <p id={`${id}-rules`} className="muted">{suffix ? t('documents.rename.extension', { extension: suffix }) : t('documents.nameRules')}</p>
      {fieldError ? <Notice error>{fieldError}</Notice> : operation.notice}
      <div className="inline">
        <button disabled={operation.busy || !name.trim()}>{operation.busy ? t('common.saving') : t('documents.rename.save')}</button>
        <button type="button" className="secondary" disabled={operation.busy} onClick={close}>{t('common.cancel')}</button>
      </div>
    </form>
  </Modal>
}

type TreeOption = { id: number | null; name: string; depth: number; disabled: boolean; current: boolean }

export function folderOptions(folders: DocumentTreeFolderOut[], item: DocumentItem): TreeOption[] {
  const children = new Map<number | null, DocumentTreeFolderOut[]>()
  for (const folder of folders) children.set(folder.parent_id, [...children.get(folder.parent_id) ?? [], folder])
  const parent = item.kind === 'folder' ? item.value.parent_id : item.value.folder_id
  const options: TreeOption[] = [{ id: null, name: '', depth: 0, disabled: parent === null, current: parent === null }]
  const visit = (parentId: number | null, depth: number, excluded: boolean) => {
    const level = [...children.get(parentId) ?? []].sort((left, right) => compareText(left.name, right.name))
    for (const folder of level) {
      // A folder cannot go inside itself or inside a folder it holds.
      const inside = excluded || item.kind === 'folder' && folder.id === item.value.id
      options.push({ id: folder.id, name: folder.name, depth, disabled: inside || folder.id === parent, current: folder.id === parent })
      visit(folder.id, depth + 1, inside)
    }
  }
  visit(null, 1, false)
  return options
}

function MoveDialog({ item, close, done }: { item: DocumentItem; close: () => void; done: () => void }) {
  const { t } = useI18n()
  const tree = useQuery({ queryKey: ['documents', 'folders'], queryFn: () => api<DocumentTreeFolderOut[]>('/documents/folders'), staleTime: 0 })
  const [target, setTarget] = useState<string>('')
  const operation = useAction(false), legend = useId()
  const options = tree.data ? folderOptions(tree.data, item) : []
  return <Modal title={t('documents.move.title', { name: item.value.name })} close={close} disabled={operation.busy} className="document-move">
    {tree.isPending && <Notice>{t('documents.move.loading')}</Notice>}
    {tree.error && <Notice error>{errorMessage(tree.error)}</Notice>}
    {tree.data && <form onSubmit={event => {
      event.preventDefault()
      void operation.run(async () => {
        await api(itemPath(item), 'PATCH', { version: item.value.version, folder_id: target === 'root' ? null : Number(target) })
        done()
      })
    }}>
      <fieldset aria-labelledby={legend}>
        <legend id={legend}>{t('documents.move.destination')}</legend>
        <div className="document-tree">{options.map(option => {
          const value = option.id === null ? 'root' : String(option.id)
          return <label key={value} className="check" style={{ paddingInlineStart: `${option.depth * 18}px` }}>
            <input type="radio" name="destination" value={value} checked={target === value} disabled={option.disabled}
              onChange={() => { setTarget(value); operation.reset() }} />
            <Icon name="folder" size={16} />
            <span>{option.id === null ? t('documents.root') : option.name}{option.current && <> <span className="muted">{t('documents.move.current')}</span></>}</span>
          </label>
        })}</div>
      </fieldset>
      {operation.notice}
      <div className="inline">
        <button disabled={operation.busy || !target}>{operation.busy ? t('documents.move.saving') : t('documents.move.save')}</button>
        <button type="button" className="secondary" disabled={operation.busy} onClick={close}>{t('common.cancel')}</button>
      </div>
    </form>}
  </Modal>
}

function DeleteDialog({ item, close, done }: { item: DocumentItem; close: () => void; done: () => void }) {
  const { t } = useI18n()
  const operation = useAction(false)
  return <Modal title={t('documents.deletion.title', { name: item.value.name })} close={close} disabled={operation.busy}>
    <p>{item.kind === 'folder'
      ? t('documents.deletion.folder', { count: item.value.file_count + item.value.folder_count })
      : t('documents.deletion.file')}</p>
    <p className="muted">{t('documents.deletion.retention')}</p>
    {operation.notice}
    <div className="inline">
      <button type="button" className="secondary danger" disabled={operation.busy} onClick={() => void operation.run(async () => {
        await api(itemPath(item), 'DELETE', { version: item.value.version })
        done()
      })}><Icon name={operation.busy ? 'spinner' : 'trash'} size={16} className={operation.busy ? 'icon-spin' : undefined} />
        {operation.busy ? t('documents.deletion.deleting') : t('documents.deletion.confirm')}</button>
      <button type="button" className="secondary" disabled={operation.busy} onClick={close}>{t('common.cancel')}</button>
    </div>
  </Modal>
}

export function eventText(event: DocumentEventOut, folder: boolean, translate: Translate): string {
  const location = event.location ? locationText(event.location, translate) : ''
  const size = event.size === null ? '' : byteSize(event.size)
  switch (event.kind) {
    case 'created': return folder ? translate('documents.history.createdFolder', { location })
      : translate('documents.history.createdFile', { location, size })
    case 'version_added': return translate('documents.history.versionAdded', { number: event.number ?? 0, size })
    case 'renamed': return translate('documents.history.renamed', { previous: event.previous_name ?? '', name: event.name ?? '' })
    case 'moved': return translate('documents.history.moved', {
      previous: locationText(event.previous_location ?? [], translate), location,
    })
    case 'deleted': return event.folder ? translate('documents.history.deletedWith', { folder: event.folder })
      : translate('documents.history.deleted')
    case 'restored':
      if (event.folder) return translate('documents.history.restoredWith', { folder: event.folder })
      return event.previous_name ? translate('documents.history.restoredRenamed', { location, name: event.name ?? '', previous: event.previous_name })
        : translate('documents.history.restored', { location })
    case 'purged': return event.folder ? translate('documents.history.purgedWith', { folder: event.folder })
      : translate('documents.history.purged')
    case 'version_purged': return translate('documents.history.versionPurged', { number: event.number ?? 0, size })
  }
}

export function DocumentHistory({ path, queryKey, folder }: { path: string; queryKey: readonly unknown[]; folder: boolean }) {
  const { t } = useI18n()
  const [page, setPage] = useState(1), heading = useId()
  const query = useQuery({
    queryKey: [...queryKey, 'history', page],
    queryFn: ({ signal }) => api<DocumentHistoryPage>(`${path}/history?page=${page}`, 'GET', undefined, signal),
  })
  return <section className="document-history" aria-labelledby={heading}>
    <h3 id={heading}>{t('documents.history.title')}</h3>
    {query.isPending && <Notice>{t('documents.history.loading')}</Notice>}
    {query.error && <Notice error>{errorMessage(query.error)}</Notice>}
    {query.data && <>
      <ol className="document-timeline">{query.data.items.map(event => <li key={event.id}>
        <ActionTime value={event.created_at} />
        <strong>{authorName(event.author, t)}</strong>
        <p>{eventText(event, folder, t)}</p>
      </li>)}</ol>
      <Pagination page={page} pages={query.data.pages} change={setPage} busy={query.isFetching} label={t('documents.history.pagination')} />
    </>}
  </section>
}

const HISTORY_HIDDEN = 'juntia_document_history_hidden'

function historyShown(): boolean {
  try { return localStorage.getItem(HISTORY_HIDDEN) !== '1' } catch { return true }
}

/** The details of a file or folder and, unless people hide it, its history as a timeline beside them. */
export function DocumentInfoDialog({ title, close, history, children }: {
  title: string; close: () => void; history: ReactNode; children: ReactNode
}) {
  const { t } = useI18n()
  const [shown, setShown] = useState(historyShown)
  const id = useId()
  function toggle() {
    const next = !shown
    setShown(next)
    try { localStorage.setItem(HISTORY_HIDDEN, next ? '0' : '1') } catch { /* Then the choice lasts until the page reloads. */ }
  }
  return <Modal title={title} close={close} className={`document-info${shown ? ' with-history' : ''}`}
    actions={<button type="button" className="secondary document-history-toggle" aria-expanded={shown} aria-controls={shown ? id : undefined}
      onClick={toggle}><Icon name="history" size={18} />{shown ? t('documents.history.hide') : t('documents.history.show')}</button>}>
    <div className="document-info-layout">
      <div className="document-info-main">{children}</div>
      {shown && <div id={id} className="document-info-history">{history}</div>}
    </div>
  </Modal>
}

export function VersionList({ versions, current, download }: {
  versions: DocumentVersionOut[]; current: number; download: (version: DocumentVersionOut) => string
}) {
  const { t, rich } = useI18n()
  return <ol className="document-versions">{versions.map(version => <li key={version.id}>
    <div className="action-file-info">
      <strong>{t('documents.info.versionNumber', { number: version.number })}</strong>
      {version.number === current && <span className="tag">{t('documents.info.current')}</span>}
      <p className="muted">{byteSize(version.size)} · {authorName(version.author, t)} · <ActionTime value={version.created_at} /></p>
    </div>
    {version.purged_at
      ? <p className="muted">{rich('documents.info.purged', { time: () => <ActionTime value={version.purged_at ?? ''} /> })}</p>
      : <a className="button secondary" href={download(version)} download="" aria-label={t('documents.info.downloadVersion', { number: version.number })}>
        <Icon name="download" size={16} />{t('documents.menu.download')}</a>}
  </li>)}</ol>
}

/** What the search knows of a file's text, as the Info dialog says it. */
export function textStatus(text: DocumentTextOut, translate: Translate): string {
  if (text.status !== 'ready') return translate(`documents.info.textStatus.${text.status}`)
  const read = text.ocr_pages > 0 ? translate('documents.info.textStatus.ocr', { count: text.ocr_pages }) : translate('documents.info.textStatus.ready')
  return text.partial ? `${read} ${translate('documents.info.textStatus.partial')}` : read
}

export function FileDetails({ value }: { value: DocumentInfoOut }) {
  const { t } = useI18n()
  return <dl className="document-details">
    <div><dt>{t('documents.info.type')}</dt><dd>{t(`documents.kinds.${value.kind}`)} · .{value.current.extension}</dd></div>
    <div><dt>{t('documents.info.size')}</dt><dd>{byteSize(value.current.size)}</dd></div>
    <div><dt>{t('documents.info.location')}</dt><dd>{locationText(value.location.map(folder => folder.name), t)}</dd></div>
    <div><dt>{t('documents.info.uploadedBy')}</dt><dd>{authorName(value.author, t)} · <ActionTime value={value.created_at} /></dd></div>
    <div><dt>{t('documents.info.modified')}</dt><dd><ActionTime value={value.updated_at} /></dd></div>
    {value.text && <div><dt>{t('documents.info.text')}</dt><dd>{textStatus(value.text, t)}</dd></div>}
  </dl>
}

function InfoDialog({ item, close, newVersion }: { item: DocumentItem; close: () => void; newVersion?: () => void }) {
  const { t } = useI18n()
  const path = itemPath(item)
  const query = useQuery({
    queryKey: ['documents', item.kind, item.value.id],
    queryFn: ({ signal }) => api<DocumentInfoOut | DocumentFolderInfoOut>(path, 'GET', undefined, signal),
  })
  const value = query.data
  return <DocumentInfoDialog title={t('documents.info.title', { name: item.value.name })} close={close}
    history={<DocumentHistory path={path} queryKey={['documents', item.kind, item.value.id]} folder={item.kind === 'folder'} />}>
    {query.isPending && <Notice>{t('documents.info.loading')}</Notice>}
    {query.error && <Notice error>{errorMessage(query.error)}</Notice>}
    {value && 'current' in value && <>
      <FileDetails value={value} />
      <h3>{t('documents.info.versions')}</h3>
      <VersionList versions={value.versions} current={value.current.number} download={version => downloadUrl(version.id)} />
      {value.can_manage && newVersion && <button type="button" className="secondary" onClick={newVersion}>
        <Icon name="upload" size={16} />{t('documents.menu.newVersion')}</button>}
    </>}
    {value && !('current' in value) && <dl className="document-details">
      <div><dt>{t('documents.info.contents')}</dt><dd>{t('documents.info.folderContents', { count: value.file_count, folders: value.folder_count })}</dd></div>
      <div><dt>{t('documents.info.size')}</dt><dd>{byteSize(value.size)}</dd></div>
      <div><dt>{t('documents.info.location')}</dt><dd>{locationText(value.location.map(folder => folder.name), t)}</dd></div>
      <div><dt>{t('documents.info.createdBy')}</dt><dd>{authorName(value.author, t)} · <ActionTime value={value.created_at} /></dd></div>
      <div><dt>{t('documents.info.modified')}</dt><dd><ActionTime value={value.updated_at} /></dd></div>
    </dl>}
  </DocumentInfoDialog>
}

export { shortDate as documentDate }
