import {
  useEffect, useId, useLayoutEffect, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent,
} from 'react'
import { api, errorMessage } from './api/client'
import type { CommunityImageOut } from './api/schema.gen'
import { byteSize, createUploadId } from './community-action-shared'
import { IMAGE_TYPES, ImagePreparationError, MAX_IMAGE_BYTES, isImageType, prepareImage, type ImageProblem } from './image-upload'
import { useI18n } from './i18n'
import { Icon } from './icons'
import { MarkdownText } from './markdown'
import { Notice } from './shared'

/** The section whose API stores and serves the images of a text. */
export type ImageScope = 'actions' | 'events'
type Mode = 'write' | 'preview'
type Upload = { id: string; file: File; placeholder: string }
// Kept as data, not text, so the messages follow a language switch.
type Problem =
  | { kind: ImageProblem; name: string }
  | { kind: 'failed'; name: string; cause: unknown }
  | { kind: 'tooLong' }

const MODES: readonly Mode[] = ['write', 'preview']
/** The longest Markdown an image can take: a 100-character description, its address and line breaks. */
const IMAGE_MARKDOWN_LENGTH = 170

/** A Markdown image description from a file name: no brackets or line breaks, at most 100 characters. */
export function imageAlt(name: string, fallback: string): string {
  const stem = name.replace(/\.[A-Za-z0-9]{1,5}$/, '').replace(/[[\]\\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100).trim()
  // Pasted pictures are all called "image.png": describe them in the active language instead.
  return !stem || stem.toLowerCase() === 'image' ? fallback : stem
}

/** `insertion` replaces the selection, on lines of its own; returns the text and the caret after it. */
export function insertBlock(text: string, start: number, end: number, insertion: string): [string, number] {
  const before = text.slice(0, start), after = text.slice(end)
  const block = (before && !before.endsWith('\n') ? '\n' : '') + insertion + (after && !after.startsWith('\n') ? '\n' : '')
  return [before + block + after, before.length + block.length]
}

function withoutPlaceholder(text: string, placeholder: string): string {
  return text.includes(`${placeholder}\n`) ? text.replace(`${placeholder}\n`, '') : text.replace(placeholder, '')
}

/**
 * A Markdown text area with Write and Preview tabs. Images pasted, dropped or chosen with "Add
 * image" are prepared in the browser, uploaded one at a time and inserted as `![name](address)`;
 * a placeholder marks each one until its upload ends. `change` receives updates of the latest text,
 * because uploads finish after the person may have kept typing.
 */
export function MarkdownField({
  label, value, change, scope, maxLength, rows = 4, required = false, disabled = false, name, invalid,
  describedBy, onUploadingChange,
}: {
  label: string; value: string; change: (update: (previous: string) => string) => void; scope: ImageScope
  maxLength: number; rows?: number; required?: boolean; disabled?: boolean; name?: string; invalid?: boolean
  describedBy?: string; onUploadingChange?: (uploading: boolean) => void
}) {
  const { t } = useI18n()
  const id = useId()
  const [mode, setMode] = useState<Mode>('write')
  const [pending, setPending] = useState(0)
  const [problems, setProblems] = useState<Problem[]>([])
  const [dragging, setDragging] = useState(false)
  const textarea = useRef<HTMLTextAreaElement>(null), fileInput = useRef<HTMLInputElement>(null)
  const alive = useRef(true), queue = useRef<Promise<void>>(Promise.resolve())
  const selection = useRef({ start: value.length, end: value.length }), caret = useRef<number | null>(null)
  const tabs = useRef<Record<Mode, HTMLButtonElement | null>>({ write: null, preview: null })
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  useEffect(() => { onUploadingChange?.(pending > 0) }, [pending, onUploadingChange])
  useEffect(() => {
    if (!pending) return
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault() }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [pending])
  useLayoutEffect(() => {
    const field = textarea.current
    if (caret.current === null || !field) return
    field.setSelectionRange(caret.current, caret.current)
    selection.current = { start: caret.current, end: caret.current }
    caret.current = null
  }, [value])

  function remember() {
    const field = textarea.current
    if (field) selection.current = { start: field.selectionStart, end: field.selectionEnd }
  }

  async function upload(entry: Upload) {
    let markdown = ''
    try {
      const prepared = await prepareImage(entry.file)
      const data = new FormData()
      data.append('file', prepared.blob, prepared.name)
      data.append('upload_id', entry.id)
      const image = await api<CommunityImageOut>(`/${scope}/images`, 'POST', data)
      markdown = `![${imageAlt(entry.file.name, t('common.markdown.image'))}](${image.url})`
    } catch (cause) {
      const problem: Problem = cause instanceof ImagePreparationError
        ? { kind: cause.problem, name: entry.file.name } : { kind: 'failed', name: entry.file.name, cause }
      if (alive.current) setProblems(previous => [...previous, problem])
    }
    // A function, not a string: `$&` or `$'` in a file name must not be read as replacement patterns.
    change(previous => markdown ? previous.replace(entry.placeholder, () => markdown) : withoutPlaceholder(previous, entry.placeholder))
  }

  function add(files: File[]) {
    if (disabled || !files.length) return
    const found: Problem[] = files.filter(file => !isImageType(file.type)).map(file => ({ kind: 'type', name: file.name }))
    const entries: Upload[] = files.filter(file => isImageType(file.type)).map(file => {
      const uploadId = createUploadId()
      const shown = imageAlt(file.name, t('common.markdown.image'))
      return { id: uploadId, file, placeholder: `![${t('common.markdown.uploading', { name: shown })}](#upload-${uploadId.slice(0, 8)})` }
    })
    const field = textarea.current
    const { start, end } = field && document.activeElement === field
      ? { start: field.selectionStart, end: field.selectionEnd } : selection.current
    if (entries.length && value.length - (end - start) + entries.length * IMAGE_MARKDOWN_LENGTH > maxLength) {
      setProblems([...found, { kind: 'tooLong' }])
      return
    }
    setProblems(found)
    if (!entries.length) return
    change(previous => {
      const [text, position] = insertBlock(previous, Math.min(start, previous.length), Math.min(end, previous.length),
        entries.map(entry => entry.placeholder).join('\n'))
      caret.current = position
      return text
    })
    setMode('write')
    setPending(count => count + entries.length)
    for (const entry of entries) {
      queue.current = queue.current.then(() => upload(entry)).finally(() => {
        if (alive.current) setPending(count => count - 1)
      })
    }
  }

  function paste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const files = Array.from(event.clipboardData.files)
    // Spreadsheets and documents also copy a picture of the selection: their text wins.
    if (!files.length || event.clipboardData.getData('text/plain')) return
    event.preventDefault()
    add(files)
  }

  function dragOver(event: DragEvent<HTMLTextAreaElement>) {
    if (disabled || !Array.from(event.dataTransfer.types).includes('Files')) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
    setDragging(true)
  }

  function drop(event: DragEvent<HTMLTextAreaElement>) {
    setDragging(false)
    const files = Array.from(event.dataTransfer.files)
    if (!files.length) return
    event.preventDefault()
    add(files)
  }

  function moveTab(event: KeyboardEvent<HTMLButtonElement>) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const next = event.key === 'Home' ? 'write' : event.key === 'End' ? 'preview' : mode === 'write' ? 'preview' : 'write'
    setMode(next)
    tabs.current[next]?.focus()
  }

  function message(problem: Problem): string {
    switch (problem.kind) {
      case 'type': return t('common.markdown.unsupported', { name: problem.name })
      case 'tooLarge': return t('common.markdown.tooLarge', { name: problem.name, size: byteSize(MAX_IMAGE_BYTES) })
      case 'unreadable': return t('common.markdown.unreadable', { name: problem.name })
      case 'failed': return t('common.markdown.failed', { name: problem.name, error: errorMessage(problem.cause) })
      case 'tooLong': return t('common.markdown.tooLong')
    }
  }

  const textId = `${id}-text`, panelId = `${id}-panel`, helpId = `${id}-help`
  return <div className="markdown-field">
    <div className="markdown-field-header">
      <label htmlFor={textId}>{label}</label>
      <div className="markdown-field-tabs" role="tablist" aria-label={t('common.markdown.modes', { field: label })}>
        {MODES.map(option => <button key={option} ref={element => { tabs.current[option] = element }} type="button" role="tab"
          id={`${id}-${option}`} className="quiet" aria-selected={mode === option} aria-controls={panelId}
          tabIndex={mode === option ? 0 : -1} onClick={() => setMode(option)} onKeyDown={moveTab}>
          {t(`common.markdown.${option}`)}
        </button>)}
      </div>
    </div>
    <div role="tabpanel" id={panelId} aria-labelledby={`${id}-${mode}`}>
      {mode === 'write'
        ? <textarea ref={textarea} id={textId} name={name} rows={rows} maxLength={maxLength} required={required} value={value}
          disabled={disabled} className={dragging ? 'markdown-dropping' : undefined}
          aria-invalid={invalid || undefined} aria-describedby={[describedBy, helpId].filter(Boolean).join(' ')}
          onChange={event => { const next = event.target.value; change(() => next) }}
          onSelect={remember} onBlur={remember} onPaste={paste} onDragOver={dragOver} onDragLeave={() => setDragging(false)} onDrop={drop} />
        : <div className="markdown-preview" tabIndex={0}>{value.trim()
          ? <MarkdownText text={value} />
          : <p className="muted">{t('common.markdown.emptyPreview')}</p>}</div>}
    </div>
    <div className="markdown-field-footer">
      <input ref={fileInput} type="file" hidden multiple accept={IMAGE_TYPES.join(',')} disabled={disabled}
        aria-label={t('common.markdown.addImageTo', { field: label })}
        onChange={event => { add(Array.from(event.target.files || [])); event.target.value = '' }} />
      <button type="button" className="secondary" disabled={disabled} aria-label={t('common.markdown.addImageTo', { field: label })}
        onClick={() => fileInput.current?.click()}><Icon name="upload" size={16} />{t('common.markdown.addImage')}</button>
      <small id={helpId} className="muted">{t('common.markdown.help', { size: byteSize(MAX_IMAGE_BYTES) })}</small>
    </div>
    {pending > 0 && <Notice>{t('common.markdown.uploadingCount', { count: pending })}</Notice>}
    {problems.map((problem, index) => <Notice key={index} error>{message(problem)}</Notice>)}
  </div>
}
