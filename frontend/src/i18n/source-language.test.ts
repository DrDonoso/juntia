import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { expect, test } from 'vitest'

// Spanish text belongs in src/i18n/locales/es: production code, comments and assets stay in English.
const SPANISH = /[áéíóúüñÁÉÍÓÚÜÑ¿¡]/u
// The language picker names Spanish in its own language.
const LANGUAGE_NAME = /Español/gu
const frontend = join(import.meta.dirname, '..', '..')
const spanishLocale = join(frontend, 'src', 'i18n', 'locales', 'es') + sep

function files(directory: string, pattern: RegExp): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return files(path, pattern)
    return pattern.test(entry.name) ? [path] : []
  })
}

function productionSources(): string[] {
  return [
    ...files(join(frontend, 'src'), /\.(tsx?|css)$/).filter(path =>
      !path.startsWith(spanishLocale) && !/\.test\.tsx?$/.test(path) && !path.endsWith('test-setup.ts')),
    ...files(join(frontend, 'scripts'), /\.m?js$/),
    ...files(join(frontend, 'public'), /\.(js|svg|json|webmanifest)$/),
    join(frontend, 'index.html'),
    join(frontend, 'vite.config.ts'),
    join(frontend, 'playwright.config.ts'),
    join(frontend, 'playwright.demo.config.ts'),
  ]
}

test('production frontend source outside the Spanish locale contains no Spanish text', () => {
  const sources = productionSources()
  expect(sources.length).toBeGreaterThan(50)
  const findings = sources.flatMap(path => readFileSync(path, 'utf8').split('\n').flatMap((line, index) =>
    SPANISH.test(line.replace(LANGUAGE_NAME, '')) ? [`${relative(frontend, path)}:${index + 1}: ${line.trim()}`] : []))
  expect(findings).toEqual([])
})
