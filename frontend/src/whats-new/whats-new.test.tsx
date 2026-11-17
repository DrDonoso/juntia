import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { cache, signedOut } from '../api/client'
import type { WhatsNewOut, WhatsNewSeenIn } from '../api/schema.gen'
import { LoginNoticeProvider } from '../auth'
import { I18nRoot, setLanguage } from '../i18n'
import { Shell as AppShell } from '../main'
import type { Note } from './notes'
import { NEWS_SHOWN, NewsDialog, WhatsNew } from './whats-new'

const { FIXTURES, note } = vi.hoisted(() => {
  const note = (id: string, kind: Note['kind'], extra: Partial<Note> = {}): Note => ({
    id,
    date: id.slice(0, 10),
    kind,
    audience: 'everyone',
    en: { title: `Title ${id}`, body: `Text ${id}` },
    es: { title: `Título ${id}`, body: `Texto ${id}` },
    ...extra,
  })
  // Newest first, as the real NOTES.
  const FIXTURES: Note[] = [
    note('2026-12-20-folders', 'new', { link: '/documents' }),
    note('2026-12-10-storage', 'new', { audience: 'admins', icon: 'dashboard', link: '/admin/storage' }),
    note('2026-12-05-search', 'improved'),
    note('2026-11-30-uploads', 'fixed'),
    note('2026-11-17-whats-new', 'new'),
  ]
  return { FIXTURES, note }
})

vi.mock('./notes', async importOriginal => ({ ...(await importOriginal<typeof import('./notes')>()), NOTES: FIXTURES }))

const ALL_IDS = FIXTURES.map(item => item.id)
const except = (...ids: string[]) => ALL_IDS.filter(id => !ids.includes(id))
const defaults = cache.getDefaultOptions()
const { showModal, close } = HTMLDialogElement.prototype

/** The notes read so far, as answered by the API (or a pending answer); what each save sent. */
let seen: WhatsNewOut | (() => Promise<Response>)
let saved: string[][]
let saveFails: boolean

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', '') }
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open') }
})
afterAll(() => {
  Object.assign(HTMLDialogElement.prototype, { showModal, close })
  cache.setDefaultOptions(defaults)
})
beforeEach(() => {
  cache.clear()
  cache.setDefaultOptions({ queries: { retry: false } })
  seen = { seen: [] }
  saved = []
  saveFails = false
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    if (input === '/api/whats-new' && (init?.method ?? 'GET') === 'GET') {
      return typeof seen === 'function' ? seen() : Response.json(seen)
    }
    if (input === '/api/whats-new/seen' && init?.method === 'POST') {
      const { ids } = JSON.parse(String(init.body)) as WhatsNewSeenIn
      saved.push(ids)
      return saveFails ? Response.json({ code: 'internal_error' }, { status: 500 }) : Response.json({ seen: ids })
    }
    throw new Error(`Unexpected request ${input}`)
  }))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); cache.clear() })

function Page() {
  return <p>Page {useLocation().pathname}</p>
}

/** The shell's part: the user menu opens the list of every note. */
function Shell({ administrator }: { administrator: boolean }) {
  const [open, setOpen] = useState(false)
  return <>
    <Page />
    <button type="button" onClick={() => setOpen(true)}>Open every note</button>
    <WhatsNew administrator={administrator} allOpen={open} onAllOpenChange={setOpen} />
  </>
}

function renderWhatsNew({ administrator = false } = {}) {
  return render(<QueryClientProvider client={cache}><MemoryRouter initialEntries={['/']}>
    <Routes><Route path="*" element={<Shell administrator={administrator} />} /></Routes>
  </MemoryRouter></QueryClientProvider>)
}

const news = () => screen.queryByRole('dialog', { name: "What's new" })

function titles(container: HTMLElement, level = 3): string[] {
  return within(container).getAllByRole('heading', { level }).map(heading => heading.textContent ?? '')
}

describe("what's new", () => {
  it('starts a new account with nothing to catch up on: every note counts as read, none is shown', async () => {
    seen = { seen: null }
    renderWhatsNew()
    await waitFor(() => expect(saved).toEqual([ALL_IDS]))
    expect(news()).not.toBeInTheDocument()
  })

  it('tells what is new since the last visit, new things first, and marks it all as read once closed', async () => {
    seen = { seen: ['2026-11-17-whats-new'] }
    const user = userEvent.setup()
    renderWhatsNew()
    const dialog = await screen.findByRole('dialog', { name: "What's new" })
    expect(within(dialog).getByText("Here's what's new since you last came in.")).toBeInTheDocument()
    // Someone who is not an administrator never sees the administrators' note.
    expect(titles(dialog)).toEqual(['Title 2026-12-20-folders', 'Title 2026-12-05-search', 'Title 2026-11-30-uploads'])
    expect(within(dialog).getAllByRole('listitem').map(item => within(item).getByText(/^(New|Improved|Fixed)$/).textContent))
      .toEqual(['New', 'Improved', 'Fixed'])
    expect(within(dialog).getByRole('link', { name: 'Take me there: Title 2026-12-20-folders' })).toHaveAttribute('href', '/documents')
    expect(saved).toEqual([])

    await user.click(within(dialog).getByRole('button', { name: 'Got it!' }))
    expect(news()).not.toBeInTheDocument()
    // Every unread note counts as read, the administrators' one too.
    await waitFor(() => expect(saved).toEqual([except('2026-11-17-whats-new')]))
  })

  it("shows administrators their own notes, and a note's link takes them there", async () => {
    seen = { seen: except('2026-12-10-storage') }
    const user = userEvent.setup()
    renderWhatsNew({ administrator: true })
    const dialog = await screen.findByRole('dialog', { name: "What's new" })
    expect(titles(dialog)).toEqual(['Title 2026-12-10-storage'])
    expect(within(dialog).getByText('Administrators only')).toBeInTheDocument()

    await user.click(within(dialog).getByRole('link', { name: 'Take me there: Title 2026-12-10-storage' }))
    expect(screen.getByText('Page /admin/storage')).toBeInTheDocument()
    expect(news()).not.toBeInTheDocument()
    await waitFor(() => expect(saved).toEqual([['2026-12-10-storage']]))
  })

  it('shows nothing to someone whose only unread notes are for administrators, and marks them as read', async () => {
    seen = { seen: except('2026-12-10-storage') }
    renderWhatsNew()
    await waitFor(() => expect(saved).toEqual([['2026-12-10-storage']]))
    expect(news()).not.toBeInTheDocument()
  })

  it('closes quietly when the notes cannot be saved (they show again next time)', async () => {
    seen = { seen: except('2026-12-05-search') }
    saveFails = true
    const user = userEvent.setup()
    renderWhatsNew()
    await user.click(await screen.findByRole('button', { name: 'Got it!' }))
    await waitFor(() => expect(saved).toEqual([['2026-12-05-search']]))
    expect(news()).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('lists every note by month from the user menu, administrators included', async () => {
    seen = { seen: ALL_IDS }
    const user = userEvent.setup()
    renderWhatsNew({ administrator: true })
    await waitFor(() => expect(cache.getQueryData(['whats-new'])).toEqual({ seen: ALL_IDS }))
    expect(news()).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Open every note' }))
    const dialog = await screen.findByRole('dialog', { name: "What's new" })
    expect(within(dialog).getByText('Everything new in the portal, newest first.')).toBeInTheDocument()
    expect(titles(dialog)).toEqual(['December 2026', 'November 2026'])
    expect(titles(dialog, 4)).toEqual([
      'Title 2026-12-20-folders',
      'Title 2026-12-10-storage',
      'Title 2026-12-05-search',
      'Title 2026-11-17-whats-new',
      'Title 2026-11-30-uploads',
    ])
    act(() => setLanguage('es'))
    expect(titles(screen.getByRole('dialog', { name: 'Novedades' }))).toEqual(['Diciembre de 2026', 'Noviembre de 2026'])

    await user.click(within(screen.getByRole('dialog', { name: 'Novedades' })).getByRole('button', { name: 'Cerrar' }))
    expect(screen.queryByRole('dialog', { name: 'Novedades' })).not.toBeInTheDocument()
    expect(saved).toEqual([])
  })

  it('counts unread notes as read once the list of every note was seen, without showing them again', async () => {
    let answer: (response: Response) => void = () => undefined
    seen = () => new Promise<Response>(resolve => { answer = resolve })
    const user = userEvent.setup()
    renderWhatsNew()
    await user.click(screen.getByRole('button', { name: 'Open every note' }))
    const dialog = await screen.findByRole('dialog', { name: "What's new" })
    expect(within(dialog).queryByText('Administrators only')).not.toBeInTheDocument()
    expect(titles(dialog, 4)).toHaveLength(4)
    await user.click(within(dialog).getByRole('button', { name: 'Close' }))
    expect(news()).not.toBeInTheDocument()

    // The notes read so far arrive only now: what was unread counts as read, and is not shown.
    await act(async () => answer(Response.json({ seen: except('2026-12-05-search') })))
    await waitFor(() => expect(saved).toEqual([['2026-12-05-search']]))
    expect(news()).not.toBeInTheDocument()
  })

  it('shows the first news and the rest on request, in the chosen language', async () => {
    setLanguage('es')
    const user = userEvent.setup()
    const notes = Array.from({ length: NEWS_SHOWN + 2 }, (_, index) => note(`2026-12-${String(index + 1).padStart(2, '0')}-n`, 'new'))
    const onClose = vi.fn()
    render(<MemoryRouter><NewsDialog notes={notes} close={onClose} /></MemoryRouter>)
    const dialog = screen.getByRole('dialog', { name: 'Novedades' })
    expect(titles(dialog)).toEqual(notes.slice(0, NEWS_SHOWN).map(item => `Título ${item.id}`))

    await user.click(within(dialog).getByRole('button', { name: 'Ver 2 novedades más' }))
    expect(titles(dialog)).toEqual(notes.map(item => `Título ${item.id}`))
    expect(within(dialog).getByRole('heading', { name: `Título ${notes[NEWS_SHOWN].id}` })).toHaveFocus()
    expect(within(dialog).queryByRole('button', { name: /más/ })).not.toBeInTheDocument()

    await user.click(within(dialog).getByRole('button', { name: '¡Entendido!' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

describe("what's new in the app's shell", () => {
  it('opens the list of every note from the user menu, and gives the focus back to the menu button', async () => {
    seen = { seen: ALL_IDS }
    vi.stubGlobal('matchMedia', (media: string) => ({ media, matches: false, addEventListener() {}, removeEventListener() {} }))
    cache.setQueryData(['reader-auth'], {
      ...signedOut, authenticated: true, administrator: false, name: 'Alex Morgan', email: 'alex@example.org',
      user_id: 1, dwelling_id: 1, expires_at: '2099-01-01T00:00:00Z',
    })
    cache.setQueryData(['general-settings'], { community_name: 'Maple Court' })
    cache.setQueryData(['features'], { actions: true, coefficient: true, events: true, documents: true, google_login: false })
    const user = userEvent.setup()
    render(<I18nRoot><QueryClientProvider client={cache}><LoginNoticeProvider><MemoryRouter initialEntries={['/']}>
      <Routes><Route element={<AppShell />}><Route index element={<p>Overview page</p>} /></Route></Routes>
    </MemoryRouter></LoginNoticeProvider></QueryClientProvider></I18nRoot>)
    await waitFor(() => expect(cache.getQueryData(['whats-new'])).toEqual({ seen: ALL_IDS }))
    expect(news()).not.toBeInTheDocument()

    const avatar = screen.getByRole('button', { name: /^User menu/ })
    await user.click(avatar)
    await user.click(within(screen.getByRole('navigation', { name: 'User options' })).getByRole('button', { name: "What's new" }))
    const dialog = await screen.findByRole('dialog', { name: "What's new" })
    // Every note but the administrators' one.
    expect(titles(dialog, 4)).toHaveLength(4)
    await user.click(within(dialog).getByRole('button', { name: 'Close' }))
    expect(news()).not.toBeInTheDocument()
    expect(avatar).toHaveFocus()
    expect(saved).toEqual([])
  })
})
