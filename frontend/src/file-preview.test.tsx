import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest'
import { cache } from './api/client'
import { FilePreview, PreviewLink, opensInViewer, previewKind, type PreviewFile } from './file-preview'
import { I18nRoot } from './i18n'

const pdf: PreviewFile = { name: 'Minutes.pdf', kind: 'pdf', path: '/documents/versions/v1/preview', download: '/api/documents/versions/v1/download' }
const photo: PreviewFile = { ...pdf, name: 'Roof.heic', kind: 'image', path: '/documents/versions/v2/preview' }
const video: PreviewFile = { ...pdf, name: 'Leak.mov', kind: 'video', path: '/documents/versions/v3/preview' }
const originalShow = HTMLDialogElement.prototype.showModal
const originalClose = HTMLDialogElement.prototype.close
let answer: () => Response

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', '') }
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open') }
})
afterAll(() => {
  HTMLDialogElement.prototype.showModal = originalShow
  HTMLDialogElement.prototype.close = originalClose
})
beforeEach(() => {
  answer = () => new Response(new Uint8Array([0x25]), { status: 206 })
  vi.stubGlobal('fetch', vi.fn(async () => answer()))
})
afterEach(() => {
  cleanup(); cache.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks()
  Reflect.deleteProperty(navigator, 'pdfViewerEnabled')
})

/** A browser that shows PDFs inside pages, on a computer or, with `pointer: 'coarse'`, a phone. */
function pdfViewer(enabled: boolean, pointer: 'fine' | 'coarse' = 'fine') {
  Object.defineProperty(navigator, 'pdfViewerEnabled', { configurable: true, value: enabled })
  vi.stubGlobal('matchMedia', vi.fn((query: string) => ({ matches: query === `(pointer: ${pointer})`, media: query })))
}

function show(children: ReactNode) {
  render(<I18nRoot><QueryClientProvider client={cache}>{children}</QueryClientProvider></I18nRoot>)
}

test('the viewer shows PDFs on computers whose browser can, and every picture, video and text', () => {
  expect(opensInViewer('pdf')).toBe(false)
  pdfViewer(true)
  expect(opensInViewer('pdf')).toBe(true)
  pdfViewer(true, 'coarse')
  expect(opensInViewer('pdf')).toBe(false)
  pdfViewer(false)
  expect(opensInViewer('pdf')).toBe(false)
  for (const kind of ['image', 'video', 'text'] as const) expect(opensInViewer(kind)).toBe(true)
  expect(['application/pdf', 'image/heic', 'video/quicktime', 'text/plain; charset=utf-8', 'application/zip'].map(previewKind))
    .toEqual(['pdf', 'image', 'video', 'text', null])
})

test('a PDF opens in a frame of the portal once its first byte has been read', async () => {
  show(<FilePreview file={pdf} close={() => undefined} />)
  const dialog = within(screen.getByRole('dialog', { name: 'Minutes.pdf' }))
  expect(dialog.getByText('Loading the file…')).toBeVisible()
  const frame = await dialog.findByTitle('Minutes.pdf')
  expect(frame.tagName).toBe('IFRAME')
  expect(frame).toHaveAttribute('src', '/api/documents/versions/v1/preview')
  expect(fetch).toHaveBeenCalledWith('/api/documents/versions/v1/preview', expect.objectContaining({ headers: { Range: 'bytes=0-0' } }))
  expect(dialog.getByRole('link', { name: 'Download' })).toHaveAttribute('href', '/api/documents/versions/v1/download')
})

test('a file deleted meanwhile is explained instead of shown', async () => {
  answer = () => new Response(JSON.stringify({ code: 'document_version_purged' }), { status: 410 })
  show(<FilePreview file={pdf} close={() => undefined} />)
  expect(await screen.findByRole('alert')).toHaveTextContent('This version has been deleted permanently.')
  expect(screen.queryByTitle('Minutes.pdf')).toBeNull()
})

test.each([
  { file: photo, element: 'img', message: 'This browser cannot show this picture. Download it to see it.' },
  { file: video, element: 'video', message: 'This browser cannot play this video. Download it to watch it.' },
])('a $element the browser cannot show is explained, with its download', async ({ file, element, message }) => {
  show(<FilePreview file={file} close={() => undefined} />)
  const dialog = within(screen.getByRole('dialog', { name: file.name }))
  const media = element === 'img' ? await dialog.findByRole('img', { name: file.name }) : await dialog.findByLabelText(file.name)
  expect(media.tagName.toLowerCase()).toBe(element)
  expect(media).toHaveAttribute('src', `/api${file.path}`)
  fireEvent.error(media)
  expect(dialog.getByText(message)).toBeVisible()
  expect(dialog.getByRole('link', { name: 'Download' })).toBeVisible()
})

test('a preview link opens the viewer on a plain click and keeps its new tab otherwise', async () => {
  // Whether the link handled each click itself; the browser's own handling is left out.
  const handled: boolean[] = []
  const record = (event: MouseEvent) => { handled.push(event.defaultPrevented); event.preventDefault() }
  document.addEventListener('click', record)
  try {
    pdfViewer(true)
    show(<PreviewLink file={pdf} aria-label="Preview Minutes.pdf">Eye</PreviewLink>)
    const link = screen.getByRole('link', { name: 'Preview Minutes.pdf' })
    expect(link).toHaveAttribute('href', '/api/documents/versions/v1/preview')
    expect(link).toHaveAttribute('target', '_blank')
    fireEvent.click(link, { ctrlKey: true })
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(link)
    const dialog = within(screen.getByRole('dialog', { name: 'Minutes.pdf' }))
    expect(await dialog.findByTitle('Minutes.pdf')).toBeVisible()
    fireEvent.click(dialog.getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    // Phones and tablets show PDFs in a tab of their own.
    pdfViewer(true, 'coarse')
    fireEvent.click(link)
    expect(screen.queryByRole('dialog')).toBeNull()
  } finally {
    document.removeEventListener('click', record)
  }
  expect(handled).toEqual([false, true, false, false])
})
