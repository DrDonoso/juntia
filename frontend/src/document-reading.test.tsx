import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { ApiError, api, cache } from './api/client'
import type { DocumentTextFileOut, DocumentTextFilePage, DocumentTextSummaryOut } from './api/schema.gen'
import { DocumentReadingPage, fileStatus } from './document-reading'
import { I18nRoot, t } from './i18n'

vi.mock('./api/client', async original => {
  const actual = await original<typeof import('./api/client')>()
  return { ...actual, api: vi.fn() }
})

const time = '2026-02-01T10:00:00Z'

function file(document_id: number, name: string, changes: Partial<DocumentTextFileOut> = {}): DocumentTextFileOut {
  return {
    document_id, name, kind: 'pdf', location: [{ id: 4, name: 'Minutes' }], status: 'ready', reading: false, error: null, characters: 1234,
    ocr_pages: 0, partial: false, needs_ocr: false, read_at: time, ...changes,
  }
}

let summary: DocumentTextSummaryOut, files: Record<string, DocumentTextFilePage>
const defaults = cache.getDefaultOptions()
beforeEach(() => {
  cache.clear()
  cache.setDefaultOptions({ queries: { retry: false }, mutations: { retry: false } })
  summary = {
    engine: { available: true, version: '5.5.0', language: 'es' },
    counts: { files: 6, readable: 5, pending: 2, text: 2, empty: 0, failed: 1, partial: 1, ocr: 1, needs_ocr: 0 },
    reading: { document_id: 3, name: 'Scan 2019.pdf', started_at: time },
  }
  files = {
    'status=all&page=1': { total: 3, page: 1, pages: 1, items: [
      file(3, 'Scan 2019.pdf', { status: 'pending', reading: true, characters: 0, read_at: null }),
      file(2, 'Broken.pdf', { status: 'failed', error: 'encrypted', characters: 0 }),
      file(1, 'Minutes.pdf', { ocr_pages: 2, partial: true }),
    ] },
    'status=failed&page=1': { total: 1, page: 1, pages: 1, items: [file(2, 'Broken.pdf', { status: 'failed', error: 'encrypted', characters: 0 })] },
  }
  vi.mocked(api).mockImplementation(async (url, method = 'GET') => {
    if (method === 'POST' && url === '/admin/documents/text/retry') return { queued: 1 }
    if (method === 'POST' && url === '/admin/documents/text/files/1/read') return file(1, 'Minutes.pdf', { status: 'pending' })
    if (method === 'POST' && url === '/admin/documents/text/files/2/read') throw new ApiError('document_not_found', 404)
    if (method !== 'GET') throw new Error(`Unexpected API request: ${method} ${url}`)
    if (url === '/admin/documents/text') return summary
    const query = url.startsWith('/admin/documents/text/files?') ? url.split('?')[1] : ''
    if (files[query]) return files[query]
    throw new Error(`Unexpected API request: ${method} ${url}`)
  })
})
afterEach(() => {
  cleanup(); cache.clear(); cache.setDefaultOptions(defaults); vi.restoreAllMocks()
})

function page() {
  render(<I18nRoot><QueryClientProvider client={cache}><MemoryRouter><DocumentReadingPage /></MemoryRouter></QueryClientProvider></I18nRoot>)
}

test('the page shows how far the reading has come, what is being read and what OCR reads', async () => {
  page()
  expect(await screen.findByText('3 of 5 files read')).toBeVisible()
  expect(screen.getByRole('progressbar', { name: 'Files read' })).toHaveAttribute('aria-valuetext', '3 of 5 files read (60%)')
  expect(screen.getByText('2 files are waiting to be read.')).toBeVisible()
  expect(screen.getByText(/^Reading now:/)).toHaveTextContent(/^Reading now: Scan 2019\.pdf, since .+\.$/)
  expect(screen.getByText('Read with OCR', { selector: 'dt' }).nextElementSibling).toHaveTextContent('1 file')
  expect(screen.getByText('Found by name only (videos and HEIC pictures)', { selector: 'dt' }).nextElementSibling).toHaveTextContent('1 file')
  expect(screen.getByText('OCR: Tesseract 5.5.0 with its Spanish model.')).toBeVisible()
  const list = within(await screen.findByRole('list', { name: 'Files: Every file' }))
  expect(list.getAllByRole('listitem').map(item => item.querySelector('strong')?.textContent)).toEqual([
    'Scan 2019.pdf', 'Broken.pdf', 'Minutes.pdf',
  ])
  expect(list.getByText(/^Being read now/)).toBeVisible()
  expect(list.getByText(/^Could not be read: it is protected with a password · read$/)).toBeVisible()
  expect(list.getByText(/^Read · 1,234 characters · OCR of 2 pages · only its beginning · read$/)).toBeVisible()
  expect(list.getByRole('button', { name: 'Read again: Scan 2019.pdf' })).toBeDisabled()
})

test('the administrator reads failed files again, one or all of them, and filters the list', async () => {
  const user = userEvent.setup()
  page()
  await user.click(await screen.findByRole('button', { name: 'Read again the file that failed' }))
  expect(api).toHaveBeenCalledWith('/admin/documents/text/retry', 'POST')
  expect(await screen.findByText('1 file will be read again.')).toBeVisible()
  await user.click(screen.getByRole('button', { name: 'Read again: Minutes.pdf' }))
  expect(api).toHaveBeenCalledWith('/admin/documents/text/files/1/read', 'POST')
  expect(await screen.findByText('“Minutes.pdf” will be read again.')).toBeVisible()
  await user.click(screen.getByRole('button', { name: 'Read again: Broken.pdf' }))
  expect(await screen.findByText(t('errors.codes.document_not_found'))).toBeVisible()
  await user.selectOptions(screen.getByRole('combobox', { name: 'Show' }), 'failed')
  const list = within(await screen.findByRole('list', { name: 'Files: Could not be read' }))
  expect(list.getAllByRole('listitem')).toHaveLength(1)
  expect(api).toHaveBeenCalledWith('/admin/documents/text/files?status=failed&page=1', 'GET', undefined, expect.any(AbortSignal))
})

test('without OCR the page says so, and files left for it are counted', async () => {
  summary = {
    engine: { available: false, version: null, language: 'en' },
    counts: { files: 2, readable: 2, pending: 0, text: 1, empty: 1, failed: 0, partial: 0, ocr: 0, needs_ocr: 1 },
    reading: null,
  }
  page()
  expect(await screen.findByText('Every file has been read.')).toBeVisible()
  expect(screen.getByRole('status')).toHaveTextContent(/^OCR is not available on this server.+with its English model/)
  expect(screen.getByText('1 file has scanned pages or a picture that will be read once OCR is available.')).toBeVisible()
  expect(screen.queryByText(/^Reading now/)).toBeNull()
  expect(screen.queryByRole('button', { name: /^Read again the/ })).toBeNull()
})

test('each file says how it was read', () => {
  expect(fileStatus(file(1, 'a.pdf', { status: 'empty', characters: 0, needs_ocr: true }), t)).toBe('No text found · waiting for OCR')
  expect(fileStatus(file(1, 'a.pdf', { status: 'pending', read_at: null }), t)).toBe('Waiting to be read')
  expect(fileStatus(file(1, 'a.pdf', { status: 'failed', error: null }), t)).toBe('Could not be read: an unexpected error, recorded in the server log')
})
