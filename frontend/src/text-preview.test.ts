import { expect, test } from 'vitest'
import { decodeText, parseCsv } from './text-preview'

const bytes = (text: string) => Uint8Array.from(text, char => char.charCodeAt(0))

test('text is read in the encoding it was saved with', () => {
  expect(decodeText(new TextEncoder().encode('Año 2026'))).toBe('Año 2026')
  expect(decodeText(Uint8Array.of(0xef, 0xbb, 0xbf, ...new TextEncoder().encode('Año')))).toBe('Año')
  expect(decodeText(Uint8Array.of(0xff, 0xfe, 0x41, 0x00, 0xf1, 0x00))).toBe('Añ')
  // Not UTF-8: what spreadsheet programs save on Spanish computers.
  expect(decodeText(bytes('A\xf1o \x80'))).toBe('Año €')
  // A file read in part may stop inside a character without being taken for Windows-1252.
  const cut = new TextEncoder().encode('Añ').subarray(0, 2)
  expect(decodeText(cut, true)).toBe('A')
})

test('CSV files split on their separator, with quoted fields and blank lines skipped', () => {
  expect(parseCsv('vivienda;cuota\r\n1º A;"45,00"\r\n\r\n2º B;"con ""comillas""\ny salto"\n')).toEqual([
    ['vivienda', 'cuota'], ['1º A', '45,00'], ['2º B', 'con "comillas"\ny salto'],
  ])
  expect(parseCsv('a,b\n1,2')).toEqual([['a', 'b'], ['1', '2']])
  expect(parseCsv('a\tb\n1\t2\n')).toEqual([['a', 'b'], ['1', '2']])
})
