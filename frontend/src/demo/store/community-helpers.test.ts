import { describe, expect, test } from 'vitest'
import { sha256Hex } from './community-sha256'
import { actionText, canonicalUuid, casefold, foldText, labelKey, labelName, renamedPdfName, uploadedPdfName } from './community-text'
import { apiInstant, dayNumber, dayOfNumber, wallClock, zonedDateTime, zonedDay, zonedInstant, zonedInstants, type WallClock } from './community-time'

const bytes = (text: string) => new TextEncoder().encode(text)

describe('sha256Hex', () => {
  test('matches the FIPS 180-4 test vectors', () => {
    expect(sha256Hex(bytes(''))).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    expect(sha256Hex(bytes('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    expect(sha256Hex(bytes('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')))
      .toBe('248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1')
    expect(sha256Hex(new Uint8Array(1_000_000).fill(0x61))).toBe('cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0')
  })

  test('handles every padding boundary', () => {
    // 55, 56 and 64 bytes cross the one-block length limit of the padding.
    expect(sha256Hex(bytes('a'.repeat(55)))).toBe('9f4390f8d30c2dd92ec9f095b65e2b9ae9b0a925a5258e241c9f1e910f734318')
    expect(sha256Hex(bytes('a'.repeat(56)))).toBe('b35439a4ac6f0948b6d6f9e3c6af0f5f590ce20f1bde7090ef7970686ec6738a')
    expect(sha256Hex(bytes('a'.repeat(64)))).toBe('ffe054fe7ae0cb6dc65c3af9b61d5209f439851db43d0ba5997337df154668eb')
  })
})

describe('community text rules', () => {
  test('case folding and accent-insensitive search keys follow the backend', () => {
    expect(casefold('Straße')).toBe('strasse')
    expect(foldText('Caf\u00e9 \uff21\u0301')).toBe('cafe a')
    expect(labelKey('\uff32oof')).toBe('roof')
  })

  test('label names are NFKC display names of at most 100 characters', () => {
    expect(labelName('  \uff32oof   repairs ')).toBe('Roof repairs')
    expect(labelName(' ')).toBeNull()
    expect(labelName('Name\ninjection')).toBeNull()
    expect(labelName('a'.repeat(100))).toBe('a'.repeat(100))
    expect(labelName('\ufdfa'.repeat(10))).toBeNull()
  })

  test('multi-line texts are trimmed and keep only newlines and tabs', () => {
    expect(actionText('  First\r\nSecond\rThird\tend  ')).toBe('First\nSecond\nThird\tend')
    expect(actionText('Text\u0000bad')).toBeNull()
    expect(actionText('   ')).toBe('')
  })

  test('uploaded PDFs keep their base name with a lower-case extension', () => {
    expect(uploadedPdfName('../../quote.PDF')).toBe('quote.pdf')
    expect(uploadedPdfName('C:\\Users\\me\\Roof quote.pdf')).toBe('Roof quote.pdf')
    expect(uploadedPdfName('hidden\u202e.pdf')).toBe('hidden.pdf')
    expect(uploadedPdfName(`${'a'.repeat(300)}.pdf`)).toBe(`${'a'.repeat(251)}.pdf`)
    for (const name of ['quote.png', '.pdf', '', 'pdf']) expect(uploadedPdfName(name)).toBeNull()
  })

  test('renamed PDFs follow ActionAttachmentEdit', () => {
    expect(renamedPdfName('  Revised quote.PDF  ')).toBe('Revised quote.pdf')
    expect(renamedPdfName('Approved quote')).toBe('Approved quote.pdf')
    expect(renamedPdfName('a'.repeat(251))).toBe(`${'a'.repeat(251)}.pdf`)
    for (const name of ['', ' ', '.pdf', ' .PDF ', '...pdf', 'a'.repeat(252), '../outside.pdf', '..\\outside.pdf', 'line\nbreak.pdf', 'tab\tname.pdf', 'hidden\u202e.pdf']) {
      expect(renamedPdfName(name), name).toBeNull()
    }
  })

  test('UUIDs are read like Python and written in canonical form', () => {
    expect(canonicalUuid('0F8FAD5B-D9CB-469F-A165-70867728950E')).toBe('0f8fad5b-d9cb-469f-a165-70867728950e')
    expect(canonicalUuid('0f8fad5bd9cb469fa16570867728950e')).toBe('0f8fad5b-d9cb-469f-a165-70867728950e')
    expect(canonicalUuid('{0f8fad5b-d9cb-469f-a165-70867728950e}')).toBe('0f8fad5b-d9cb-469f-a165-70867728950e')
    expect(canonicalUuid('not-a-uuid')).toBeNull()
  })
})

describe('community time zone', () => {
  const clock = (text: string): WallClock => {
    const [day, time] = text.split('T')
    const [year, month, date] = day.split('-').map(Number)
    const [hour, minute] = time.split(':').map(Number)
    return { year, month, day: date, hour, minute, second: 0, millisecond: 0 }
  }
  const instants = (text: string) => zonedInstants(clock(text)).map(apiInstant)

  test('converts wall-clock times of Europe/Madrid like the backend', () => {
    expect(instants('2030-05-10T18:00')).toEqual(['2030-05-10T16:00:00Z'])
    expect(instants('2027-01-10T18:00')).toEqual(['2027-01-10T17:00:00Z'])
    expect(instants('2026-03-29T01:30')).toEqual(['2026-03-29T00:30:00Z'])
    expect(instants('2026-10-25T01:30')).toEqual(['2026-10-24T23:30:00Z'])
    expect(instants('2026-10-25T04:30')).toEqual(['2026-10-25T03:30:00Z'])
  })

  test('finds no instant in the spring gap and two in the autumn overlap', () => {
    expect(instants('2026-03-29T02:30')).toEqual([])
    expect(instants('2026-10-25T02:30')).toEqual(['2026-10-25T00:30:00Z', '2026-10-25T01:30:00Z'])
    expect(() => zonedInstant('2026-03-29', '02:30')).toThrow()
    expect(zonedInstant('2026-11-05', '19:00')).toBe('2026-11-05T18:00:00Z')
  })

  test('reads days and local times in the community zone, whatever the machine zone', () => {
    const instant = Date.parse('2030-05-10T22:30:00Z')
    expect(zonedDay(instant)).toBe('2030-05-11')
    expect(zonedDateTime(instant)).toBe('2030-05-11T00:30:00.000')
    expect(wallClock(instant, 'America/New_York')).toMatchObject({ year: 2030, month: 5, day: 10, hour: 18, minute: 30 })
    expect(apiInstant(Date.parse('2030-05-10T16:00:00.250Z'))).toBe('2030-05-10T16:00:00.250Z')
  })

  test('counts calendar days from 1970-01-01', () => {
    expect(dayNumber('1970-01-01')).toBe(0)
    expect(dayNumber('2030-05-10')).toBe(22044)
    expect(dayOfNumber(dayNumber('2028-02-29') + 1)).toBe('2028-03-01')
    expect(dayOfNumber(dayNumber('9999-12-31'))).toBe('9999-12-31')
  })
})
