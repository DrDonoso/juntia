import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { RESIDENTS } from '../cast'
import { readZip, readZipMember } from '../core'
import { resetDemo } from '../store'
import { sha256Hex } from '../store/community-sha256'
import { checkContent } from '../store/shared-document-files'
import { openDeletions, sharedDocumentsStore, type SharedDocumentsState } from '../store/shared-documents'

// Thursday 29 October 2026, midday (local time), like the other demo tests.
const NOW = new Date(2026, 9, 29, 12)

beforeEach(() => resetDemo({ now: () => NOW }))
afterEach(() => resetDemo())

/** The documents with each file's fingerprint instead of its bytes, as JSON (comparable across builds). */
function snapshot(state: SharedDocumentsState): string {
  return JSON.stringify({ ...state, versions: state.versions.map(({ bytes, ...rest }) => ({ ...rest, bytes: sha256Hex(bytes) })), sequences: null, random: null })
}

/** Every text of the scenario: names, history details and the files' contents (the parts of office files). */
async function texts(state: SharedDocumentsState): Promise<string> {
  const contents = await Promise.all(state.versions.map(async version => {
    if (version.extension !== 'docx') return new TextDecoder('latin1').decode(version.bytes)
    const parts = await Promise.all((readZip(version.bytes) ?? []).map(record => readZipMember(version.bytes, record, version.bytes.length)))
    return parts.map(part => new TextDecoder().decode(part ?? new Uint8Array())).join('\n')
  }))
  return [snapshot(state), ...contents].join('\n')
}

describe('the shared documents scenario', () => {
  test('is the same on every build of the same day', () => {
    const first = snapshot(sharedDocumentsStore())
    resetDemo({ now: () => NOW })
    expect(snapshot(sharedDocumentsStore())).toBe(first)
  })

  test('happened in the past, with ids in chronological order, whatever the day', () => {
    // Around New Year the two meetings' minutes share their year folder or not.
    for (const time of [NOW, new Date(2026, 11, 30, 23, 50), new Date(2027, 0, 2, 0, 30), new Date(2027, 2, 28, 1, 0)]) {
      resetDemo({ now: () => time })
      const state = sharedDocumentsStore()
      const years = state.folders.filter(folder => /^\d{4}$/.test(folder.name)).map(folder => folder.name)
      expect(years.length, time.toISOString()).toBeGreaterThanOrEqual(1)
      expect(new Set(years).size).toBe(years.length)
      for (const rows of [state.folders, state.documents, state.events]) {
        const dates = [...rows].sort((a, b) => a.id - b.id).map(row => row.createdAt)
        expect(dates).toEqual([...dates].sort())
        expect(dates.every(value => Date.parse(value) <= time.getTime())).toBe(true)
      }
    }
  })

  test('history replays to the current folders and files, whose files pass the upload checks', async () => {
    const state = sharedDocumentsStore()
    for (const item of [...state.folders, ...state.documents]) {
      const folder = 'parentId' in item
      const events = state.events.filter(event => (folder ? event.folderId : event.documentId) === item.id)
      expect(events[0]).toMatchObject({ kind: 'created', createdAt: item.createdAt, author: item.author })
      const named = events.filter(event => ['created', 'renamed'].includes(event.kind)).at(-1)
      expect(named?.details.name, item.name).toBe(item.name)
      const changes = events.filter(event => ['renamed', 'moved', 'deleted', 'restored', 'version_added'].includes(event.kind))
      expect(item.version, item.name).toBe(1 + changes.length)
      expect(item.deletedAt).toBe(events.find(event => event.kind === 'deleted')?.createdAt ?? null)
    }
    for (const document of state.documents) {
      const versions = state.versions.filter(version => version.documentId === document.id)
      expect(versions.map(version => version.number)).toEqual(Array.from({ length: document.currentNumber }, (_, index) => index + 1))
      for (const version of versions) {
        expect(version).toMatchObject({ size: version.bytes.length, sha256: sha256Hex(version.bytes), purgedAt: null })
        await expect(checkContent(version.bytes, version.extension), document.name).resolves.toBeUndefined()
      }
    }
  })

  test('shows every kind of change: renames, a move, earlier versions and deletions for the administrator', () => {
    const state = sharedDocumentsStore()
    const kinds = new Set(state.events.map(event => event.kind))
    expect([...kinds].sort()).toEqual(['created', 'deleted', 'moved', 'renamed', 'version_added'])
    expect(new Set(state.documents.map(document => document.kind))).toEqual(new Set(['pdf', 'text', 'document']))
    expect(openDeletions(state).map(deletion => [deletion.name, deletion.folderId === null ? 'file' : 'folder', deletion.author.name])).toEqual([
      ['Roof claim photos', 'folder', 'Chloe Dubois'], ['Parking spaces - draft.pdf', 'file', 'Daniel Mensah'],
    ])
    const earlier = state.documents.filter(document => document.currentNumber > 1)
    expect(earlier.map(document => [document.name, document.author.kind])).toEqual([['House rules.pdf', 'administrator'], ['Claims log.csv', 'resident']])
    expect(state.settings).toEqual({ manage_policy: 'creator', max_file_mb: 50, max_video_mb: 1024, user_quota_mb: 2048, community_quota_mb: 20480 })
    expect(state.uploads).toEqual([])
  })

  test('authors come from the cast, the visitor owns a folder, and it is written in English', async () => {
    const state = sharedDocumentsStore()
    for (const { author } of [...state.folders, ...state.documents, ...state.versions, ...state.events, ...state.deletions]) {
      if (author.kind === 'administrator') expect(author).toEqual({ kind: 'administrator', name: 'Technical administrator', user_id: null })
      else expect(RESIDENTS.find(resident => resident.id === author.user_id)?.name).toBe(author.name)
    }
    const visitor = state.folders.filter(folder => folder.author.user_id === 6)
    expect(visitor.map(folder => folder.name)).toEqual(['Garden'])
    expect(state.documents.filter(document => document.folderId === visitor[0].id).every(document => document.author.user_id === 6)).toBe(true)
    const written = await texts(state)
    expect(written).toContain('Welcome to Maple Court!')
    expect(written).not.toMatch(/[\u00e1\u00e9\u00ed\u00f3\u00fa\u00f1\u00bf\u00a1\u00c1\u00c9\u00cd\u00d3\u00da\u00d1]/)
  })
})
