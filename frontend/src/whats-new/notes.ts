/**
 * What's new: short notes, written for every neighbor, about the changes they will notice. Each one
 * is a JSON file in ./notes/ named `YYYY-MM-DD-slug.json`: the name is the note's id and gives its
 * date. A published note is never renamed or deleted (people would see it again, or lose it from
 * the list). How to write them: docs/development.md ("What's new notes"); notes.test.ts checks
 * every file.
 */
import { isIconName, type IconName } from '../icons'
import type { Language } from '../i18n'

/** `new`: something people can do now · `improved`: works better · `fixed`: a problem they noticed is gone. */
export type NoteKind = 'new' | 'improved' | 'fixed'
/** `admins`: about the administration pages (other people never see it). */
export type NoteAudience = 'everyone' | 'admins'

export interface NoteText {
  readonly title: string
  readonly body: string
}

/** Contents of a note file: its texts in every language. */
export type NoteFile = Readonly<Record<Language, NoteText>> & {
  readonly kind: NoteKind
  readonly audience: NoteAudience
  /** An icon of src/icons.tsx; without it, the icon of its kind. */
  readonly icon?: string
  /** A page of the app where it can be tried, such as `/documents`. */
  readonly link?: string
}

export type Note = NoteFile & {
  /** The file name without `.json`. */
  readonly id: string
  /** `YYYY-MM-DD`, the start of the id. */
  readonly date: string
}

/** A note's id (the API checks the same pattern, up to 80 characters). */
export const NOTE_ID = /^\d{4}-\d{2}-\d{2}-[a-z0-9]+(-[a-z0-9]+)*$/

// Without a type argument: Vitest keeps transformed files in a cache unless they contain the exact
// text `import.meta.glob(`, and a cached copy would miss the notes added since.
const FILES = import.meta.glob('./notes/*.json', { eager: true, import: 'default' }) as Record<string, NoteFile>

/** `./notes/2026-11-17-whats-new.json` → `2026-11-17-whats-new`. */
export function noteId(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1).replace(/\.json$/, '')
}

/** Newest first (ids start with their date). */
function newestFirst(a: Note, b: Note): number {
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0
}

/** Every note of this version, newest first. */
export const NOTES: readonly Note[] = Object.entries(FILES)
  .map(([path, file]): Note => {
    const id = noteId(path)
    return { ...file, id, date: id.slice(0, 10) }
  })
  .sort(newestFirst)

export function isVisibleTo(note: Note, administrator: boolean): boolean {
  return administrator || note.audience === 'everyone'
}

const KIND_ORDER: Readonly<Record<NoteKind, number>> = { new: 0, improved: 1, fixed: 2 }

/** What is new first, then what works better, then the fixes; newest first within each kind. */
export function byKind(notes: readonly Note[]): Note[] {
  return [...notes].sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || newestFirst(a, b))
}

export interface NoteMonth {
  /** `YYYY-MM-01`. */
  readonly month: string
  readonly notes: readonly Note[]
}

/** Notes by month, newest month first, each month {@link byKind}. */
export function byMonth(notes: readonly Note[]): NoteMonth[] {
  const months = new Map<string, Note[]>()
  for (const note of [...notes].sort(newestFirst)) {
    const month = `${note.date.slice(0, 7)}-01`
    months.set(month, [...(months.get(month) ?? []), note])
  }
  return Array.from(months, ([month, items]) => ({ month, notes: byKind(items) }))
}

const KIND_ICONS: Readonly<Record<NoteKind, IconName>> = { new: 'sparkles', improved: 'trending-up', fixed: 'check' }

export function noteIcon(note: Pick<Note, 'icon' | 'kind'>): IconName {
  return note.icon && isIconName(note.icon) ? note.icon : KIND_ICONS[note.kind]
}
