/**
 * What's new: tells the signed-in person what changed since they last looked, once, on every
 * device, and lists every note again from the user menu. The notes ship with the interface
 * (./notes.ts); the server only keeps which ones each account has read (`/api/whats-new`).
 * Loaded after the page by main.tsx, so the notes never delay it.
 */
import { useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router'
import { api, cache } from '../api/client'
import type { WhatsNewOut } from '../api/schema.gen'
import { Icon } from '../icons'
import { dateTimeFormat, upperCase, useI18n } from '../i18n'
import { Modal } from '../shared'
import { NOTES, byKind, byMonth, isVisibleTo, noteIcon, type Note } from './notes'
import './whats-new.css'

/** News shown before "Show N more". */
export const NEWS_SHOWN = 6
/** Ids saved per request (the API takes up to 500). */
const BATCH = 500
const QUERY_KEY = ['whats-new'] as const

interface Plan {
  /** What to tell the person, in the order shown. */
  readonly news: readonly Note[]
  /** Every note they have not read, theirs or not: all of them count as read afterwards. */
  readonly unread: readonly string[]
}

function planFor({ seen }: WhatsNewOut, administrator: boolean): Plan {
  // A new account has nothing to catch up on: only what comes later is news to them.
  if (seen === null) return { news: [], unread: NOTES.map(note => note.id) }
  const read = new Set(seen)
  const unread = NOTES.filter(note => !read.has(note.id))
  return { news: byKind(unread.filter(note => isVisibleTo(note, administrator))), unread: unread.map(note => note.id) }
}

/** Records notes as read. A failed save only means seeing them again next time. */
function markRead(ids: readonly string[]) {
  if (ids.length === 0) return
  cache.setQueryData<WhatsNewOut>(QUERY_KEY, current => ({ seen: [...new Set([...(current?.seen ?? []), ...ids])].sort() }))
  for (let start = 0; start < ids.length; start += BATCH) {
    api('/whats-new/seen', 'POST', { ids: ids.slice(start, start + BATCH) }).catch(() => undefined)
  }
}

export interface WhatsNewProps {
  /** Administrators also read the notes about the administration pages. */
  administrator: boolean
  /** The list of every note, opened from the user menu. */
  allOpen: boolean
  onAllOpenChange: (open: boolean) => void
  /** Where the focus returns when that list closes (the user menu's button). */
  restoreFocusRef?: RefObject<HTMLElement | null>
}

/**
 * Once the notes the account has read are known, the unread ones meant for it open in a dialog.
 * Closing it (or the list of every note) counts every unread note as read, as does having none
 * meant for it (notes for administrators, for other people). Errors stay silent: the page goes on.
 */
export function WhatsNew({ administrator, allOpen, onAllOpenChange, restoreFocusRef }: WhatsNewProps) {
  const seen = useQuery({
    queryKey: QUERY_KEY, queryFn: ({ signal }) => api<WhatsNewOut>('/whats-new', 'GET', undefined, signal),
    staleTime: Infinity, retry: false,
  })
  const [plan, setPlan] = useState<Plan | null>(null)
  const [news, setNews] = useState<'pending' | 'open' | 'closed'>('pending')
  const allNotes = useMemo(() => NOTES.filter(note => isVisibleTo(note, administrator)), [administrator])

  // Decided from the first answer: the cached one changes as the notes are marked as read.
  if (plan === null && seen.data) setPlan(planFor(seen.data, administrator))
  if (plan && plan.news.length > 0 && news === 'pending' && !allOpen) setNews('open')

  const done = plan !== null && (plan.news.length === 0 || news === 'closed')
  useEffect(() => {
    if (done && plan) markRead(plan.unread)
  }, [done, plan])

  return <>
    {news === 'open' && plan && <NewsDialog notes={plan.news} close={() => setNews('closed')} />}
    {allOpen && <AllNotesDialog notes={allNotes} restoreFocusRef={restoreFocusRef} close={() => {
      onAllOpenChange(false)
      // They have just seen every note.
      setNews('closed')
    }} />}
  </>
}

function NoteCard({ note, heading: Heading, leave, focusTitle = false }: {
  note: Note
  /** Under the dialog's title (h3), or under a month (h4). */
  heading: 'h3' | 'h4'
  /** Its link was followed: the dialog closes. */
  leave: () => void
  /** Moves the focus to its title (the first of the notes "Show more" reveals). */
  focusTitle?: boolean
}) {
  const { t, language } = useI18n()
  const title = useRef<HTMLHeadingElement>(null)
  const text = note[language]
  useEffect(() => {
    if (focusTitle) title.current?.focus()
  }, [focusTitle])
  return <li className={`whats-new-note whats-new-${note.kind}`}>
    <span className="whats-new-icon" aria-hidden="true"><Icon name={noteIcon(note)} size={20} /></span>
    <div className="whats-new-text">
      <p className="whats-new-tags">
        <span className="whats-new-kind">{t(`whatsNew.kinds.${note.kind}`)}</span>
        {note.audience === 'admins' && <span className="whats-new-audience">{t('whatsNew.adminsOnly')}</span>}
      </p>
      <Heading ref={title} className="whats-new-title" tabIndex={focusTitle ? -1 : undefined}>{text.title}</Heading>
      <p className="whats-new-body">{text.body}</p>
      {note.link && <Link className="button secondary whats-new-go" to={note.link} onClick={leave}
        aria-label={t('whatsNew.goThereLabel', { title: text.title })}>
        {t('whatsNew.goThere')}<Icon name="arrow-right" size={16} />
      </Link>}
    </div>
  </li>
}

/** What is new since the person last looked: the first {@link NEWS_SHOWN}, then all of them on request. */
export function NewsDialog({ notes, close }: { notes: readonly Note[]; close: () => void }) {
  const { t } = useI18n()
  const [expanded, setExpanded] = useState(false)
  const shown = expanded ? notes : notes.slice(0, NEWS_SHOWN)
  const hidden = notes.length - shown.length
  return <Modal title={t('whatsNew.title')} close={close} className="whats-new">
    <p className="whats-new-intro">{t('whatsNew.intro')}</p>
    <ul className="whats-new-notes">
      {shown.map((note, index) => <NoteCard key={note.id} note={note} heading="h3" leave={close}
        focusTitle={expanded && index === NEWS_SHOWN} />)}
    </ul>
    {hidden > 0 && <button type="button" className="quiet whats-new-more" onClick={() => setExpanded(true)}>
      {t('whatsNew.showMore', { count: hidden })}
    </button>}
    <div className="whats-new-actions"><button type="button" onClick={close}>{t('whatsNew.gotIt')}</button></div>
  </Modal>
}

/** `2026-11-01` → "November 2026" / "Noviembre de 2026". */
function monthName(month: string): string {
  const name = dateTimeFormat({ month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${month}T00:00:00Z`))
  return upperCase(name.charAt(0)) + name.slice(1)
}

/** Every note, by month, newest first. */
export function AllNotesDialog({ notes, close, restoreFocusRef }: {
  notes: readonly Note[]
  close: () => void
  restoreFocusRef?: RefObject<HTMLElement | null>
}) {
  const { t } = useI18n()
  const months = byMonth(notes)
  return <Modal title={t('whatsNew.title')} close={close} className="whats-new" restoreFocusRef={restoreFocusRef}>
    <p className="whats-new-intro">{t(months.length > 0 ? 'whatsNew.allIntro' : 'whatsNew.empty')}</p>
    {months.map(({ month, notes: monthNotes }) => <section key={month} className="whats-new-month">
      <h3 className="whats-new-month-title">{monthName(month)}</h3>
      <ul className="whats-new-notes">
        {monthNotes.map(note => <NoteCard key={note.id} note={note} heading="h4" leave={close} />)}
      </ul>
    </section>)}
  </Modal>
}
