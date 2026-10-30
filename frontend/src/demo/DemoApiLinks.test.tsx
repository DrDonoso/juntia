import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { DemoApiLinks, dispositionFilename } from './DemoApiLinks'

const createObjectURL = URL.createObjectURL, revokeObjectURL = URL.revokeObjectURL
let downloads: { href: string; download: string }[]
let fetcher: ReturnType<typeof vi.fn>

beforeEach(() => {
  downloads = []
  fetcher = vi.fn(async () => new Response(new Blob(['%PDF-1.4'], { type: 'application/pdf' }), {
    headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': 'attachment; filename="statement-2026-09.pdf"' },
  }))
  vi.stubGlobal('fetch', fetcher)
  URL.createObjectURL = vi.fn(() => 'blob:http://localhost:3000/demo-file')
  URL.revokeObjectURL = vi.fn()
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    downloads.push({ href: this.href, download: this.download })
  })
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  URL.createObjectURL = createObjectURL
  URL.revokeObjectURL = revokeObjectURL
})

describe('links to API files', () => {
  test('a plain link downloads the file through the demo API instead of leaving the demo', async () => {
    const user = userEvent.setup()
    render(<><DemoApiLinks /><a href="/api/admin/statements/abc/original">Download</a></>)
    await user.click(screen.getByRole('link', { name: 'Download' }))
    await waitFor(() => expect(downloads).toEqual([{ href: 'blob:http://localhost:3000/demo-file', download: 'statement-2026-09.pdf' }]))
    expect(fetcher).toHaveBeenCalledWith(new URL('/api/admin/statements/abc/original', location.origin), { credentials: 'same-origin' })
  })

  test('a new-tab link opens the file in a new tab', async () => {
    const user = userEvent.setup()
    const tab = { opener: window as unknown, location: { href: '' }, close: vi.fn() }
    const open = vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window)
    render(<><DemoApiLinks /><a href="/api/actions/items/1/attachments/x/preview" target="_blank" rel="noopener noreferrer">Preview</a></>)
    await user.click(screen.getByRole('link', { name: 'Preview' }))
    expect(open).toHaveBeenCalledWith('', '_blank')
    await waitFor(() => expect(tab.location.href).toBe('blob:http://localhost:3000/demo-file'))
    expect(tab.opener).toBeNull()
    expect(downloads).toEqual([])
  })

  test('a failed answer closes the new tab and is reported', async () => {
    const user = userEvent.setup()
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    fetcher.mockResolvedValue(new Response(JSON.stringify({ code: 'action_attachment_not_found' }), { status: 404 }))
    const tab = { opener: null, location: { href: '' }, close: vi.fn() }
    vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window)
    render(<><DemoApiLinks /><a href="/api/actions/items/1/attachments/x/preview" target="_blank">Preview</a></>)
    await user.click(screen.getByRole('link', { name: 'Preview' }))
    await waitFor(() => expect(tab.close).toHaveBeenCalled())
    expect(error).toHaveBeenCalled()
  })

  test('other links keep their normal behaviour', async () => {
    const user = userEvent.setup()
    const prevented: boolean[] = []
    const record = (event: MouseEvent) => {
      prevented.push(event.defaultPrevented)
      event.preventDefault()
    }
    document.addEventListener('click', record)
    try {
      render(<><DemoApiLinks /><a href="/transactions">Transactions</a><a href="https://example.com/api/x">Elsewhere</a></>)
      await user.click(screen.getByRole('link', { name: 'Transactions' }))
      await user.click(screen.getByRole('link', { name: 'Elsewhere' }))
    } finally {
      document.removeEventListener('click', record)
    }
    expect(prevented).toEqual([false, false])
    expect(fetcher).not.toHaveBeenCalled()
  })

  test('file names come from Content-Disposition', () => {
    expect(dispositionFilename('attachment; filename="statement 2026-09.pdf"')).toBe('statement 2026-09.pdf')
    expect(dispositionFilename("inline; filename*=UTF-8''minutes%20of%20the%20meeting.pdf")).toBe('minutes of the meeting.pdf')
    expect(dispositionFilename('attachment; filename=plain.pdf')).toBe('plain.pdf')
    expect(dispositionFilename('attachment')).toBeNull()
    expect(dispositionFilename(null)).toBeNull()
  })
})
