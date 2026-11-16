import { useEffect, useRef, useState, type ComponentPropsWithoutRef, type MouseEvent, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { errorMessage, readBytes, readFile } from './api/client'
import { useI18n } from './i18n'
import { Icon } from './icons'
import { Modal, Notice } from './shared'
import { TextContent } from './text-preview'

/** What the portal's viewer shows: PDFs in the browser's own PDF viewer, pictures, videos, and text and CSV files. */
export type PreviewKind = 'pdf' | 'image' | 'video' | 'text'

export type PreviewFile = {
  name: string
  // The preview's address without /api, as the API client takes it, and the download's with it.
  path: string
  download: string
} & (
  | { kind: Exclude<PreviewKind, 'text'> }
  // The viewer reads the beginning of text files, and shows CSV files as a table.
  | { kind: 'text'; extension: string; size: number }
)

/** How the viewer shows a file served as `mediaType`, if it does. */
export function previewKind(mediaType: string): PreviewKind | null {
  const type = mediaType.split(';', 1)[0].trim().toLowerCase()
  if (type === 'application/pdf') return 'pdf'
  if (type.startsWith('image/')) return 'image'
  if (type.startsWith('video/')) return 'video'
  if (type.startsWith('text/')) return 'text'
  return null
}

/** A plain click, which opens the viewer: other clicks keep the link's behavior, such as a new tab. */
export const plainClick = (event: MouseEvent) => event.button === 0 && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey

/**
 * Whether a file opens in the portal's viewer, also where new tabs lose the session (such as
 * embedded browsers). PDFs need a browser that shows them inside a page, on a computer: phones and
 * tablets show them better in a tab of their own.
 */
export function opensInViewer(kind: PreviewKind): boolean {
  if (kind !== 'pdf') return true
  return navigator.pdfViewerEnabled === true && typeof window.matchMedia === 'function' && window.matchMedia('(pointer: fine)').matches
}

type Source = { state: 'ready'; url: string } | { state: 'failed'; error: unknown }

/**
 * The address the viewer loads, once a first byte of the file has been read: a file deleted
 * meanwhile or an expired session is explained instead of shown as the server's raw answer. The
 * demo answers the API in its service worker, which frames do not go through: it shows a copy.
 */
function useSource(file: PreviewFile): Source | null {
  const [source, setSource] = useState<Source | null>(null)
  useEffect(() => {
    const controller = new AbortController(), { signal } = controller
    let copy = ''
    async function load(): Promise<string> {
      if (import.meta.env.VITE_DEMO === '1' && file.kind === 'pdf') {
        const content = await readFile(file.path, signal)
        signal.throwIfAborted()
        copy = URL.createObjectURL(content)
        return copy
      }
      await readBytes(file.path, 1, signal)
      return `/api${file.path}`
    }
    load().then(url => { if (!signal.aborted) setSource({ state: 'ready', url }) },
      (error: unknown) => { if (!signal.aborted) setSource({ state: 'failed', error }) })
    return () => {
      controller.abort()
      if (copy) URL.revokeObjectURL(copy)
    }
  }, [file.path, file.kind])
  return source
}

function Media({ file }: { file: PreviewFile }) {
  const { t } = useI18n()
  const source = useSource(file)
  const [broken, setBroken] = useState(false)
  if (!source) return <Notice>{t('common.viewer.loading')}</Notice>
  if (source.state === 'failed') return <Notice error>{errorMessage(source.error)}</Notice>
  // Readable, but not in this browser: HEIC pictures outside Safari, or some phone videos.
  if (broken) return <p className="empty">{file.kind === 'video' ? t('common.viewer.video') : t('common.viewer.image')}</p>
  if (file.kind === 'pdf') return <iframe className="file-preview-frame" src={source.url} title={file.name} />
  return <div className="file-preview-media">{file.kind === 'video'
    ? <video src={source.url} controls preload="metadata" aria-label={file.name} onError={() => setBroken(true)} />
    : <img src={source.url} alt={file.name} onError={() => setBroken(true)} />}</div>
}

/** A file shown in the portal, with its download. */
export function FilePreview({ file, close, restoreFocusRef }: {
  file: PreviewFile; close: () => void; restoreFocusRef?: RefObject<HTMLElement | null>
}) {
  const { t } = useI18n()
  return <Modal title={file.name} close={close} className={`file-preview-dialog file-preview-${file.kind}`} restoreFocusRef={restoreFocusRef}
    actions={<a className="button secondary" href={file.download} download=""><Icon name="download" size={16} />{t('common.viewer.download')}</a>}>
    {file.kind === 'text'
      ? <TextContent name={file.name} extension={file.extension} size={file.size} path={file.path} />
      : <Media file={file} />}
  </Modal>
}

/**
 * A link to a file's preview. A plain click opens the portal's viewer; other clicks, and PDFs
 * where the viewer leaves them to the browser, open a new tab. The viewer is rendered in the body,
 * so the styles of the list that holds the link do not reach it.
 */
export function PreviewLink({ file, onClick, children, ...props }: { file: PreviewFile }
  & Omit<ComponentPropsWithoutRef<'a'>, 'href' | 'target' | 'rel' | 'download'>) {
  const [open, setOpen] = useState(false)
  const link = useRef<HTMLAnchorElement>(null)
  return <>
    <a ref={link} href={`/api${file.path}`} target="_blank" rel="noopener noreferrer" {...props} onClick={event => {
      onClick?.(event)
      if (event.defaultPrevented || !plainClick(event) || !opensInViewer(file.kind)) return
      event.preventDefault()
      setOpen(true)
    }}>{children}</a>
    {open && createPortal(<FilePreview file={file} close={() => setOpen(false)} restoreFocusRef={link} />, document.body)}
  </>
}
