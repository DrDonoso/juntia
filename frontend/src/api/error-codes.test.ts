import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { errors as english } from '../i18n/locales/en/errors'
import { errors as spanish } from '../i18n/locales/es/errors'

const backend = join(import.meta.dirname, '..', '..', '..', 'src', 'juntia')

// Codes that can never reach the UI, so they need no message.
const unreachable = new Map([
  // Served instead of the app when frontend/dist is missing: there is no UI to show it.
  ['frontend_not_built', 'app.py'],
  // Only answered by /health, which container health checks call and the app never requests.
  ['not_ready', 'app.py'],
])

const OPENERS: Record<string, string> = { '(': ')', '[': ']', '{': '}' }

// Index just past the string literal that starts at `start`.
function skipString(text: string, start: number): number {
  const quote = text[start]
  let index = start + 1
  while (index < text.length && text[index] !== quote) index += text[index] === '\\' ? 2 : 1
  return index + 1
}

// Index of the bracket closing the one at `start`.
function closing(text: string, start: number): number {
  const stack = [OPENERS[text[start]]]
  for (let index = start + 1; index < text.length;) {
    const char = text[index]
    if (char === '"' || char === "'") { index = skipString(text, index); continue }
    if (char in OPENERS) stack.push(OPENERS[char])
    else if (char === stack.at(-1)) {
      stack.pop()
      if (!stack.length) return index
    }
    index++
  }
  throw new Error(`Unbalanced ${text[start]} in the backend sources`)
}

// The Python expression starting at `start`: up to a comma, a closing bracket or the end of its line.
function expressionAt(text: string, start: number): string {
  let index = start
  while (index < text.length) {
    const char = text[index]
    if (char === '"' || char === "'") index = skipString(text, index)
    else if (char in OPENERS) index = closing(text, index) + 1
    else if (',)]}\n#'.includes(char)) break
    else index++
  }
  return text.slice(start, index)
}

// The string literals an expression can produce: `"a" if test else "b"` yields a and b, never the test.
function results(expression: string): string[] {
  let value = expression.trim()
  while (value.startsWith('(') && closing(value, 0) === value.length - 1) value = value.slice(1, -1).trim()
  return value.split(/\b(?:if|else)\b/).filter((_, index) => index % 2 === 0)
    .flatMap(part => /^[\s(]*(["'])([a-z][a-z0-9_]*)\1[\s)]*$/.exec(part)?.[2] ?? [])
}

// Codes produced by `expression`; a bare variable resolves to the values assigned to it in the file.
function codesOf(text: string, expression: string): string[] {
  const name = expression.trim()
  if (!/^[A-Za-z_]\w*$/.test(name)) return results(name)
  return [...text.matchAll(new RegExp(String.raw`^[ \t]*${name}[ \t]*=(?!=)[ \t]*`, 'gm'))]
    .flatMap(match => results(expressionAt(text, match.index + match[0].length)))
}

// Each value of the Python dict literal that opens at `start`.
function dictValues(text: string, start: number): string[] {
  const values: string[] = []
  const end = closing(text, start)
  for (let index = start + 1; index < end;) {
    const char = text[index]
    if (char === '"' || char === "'") index = skipString(text, index)
    else if (char in OPENERS) index = closing(text, index) + 1
    else if (char === ':') {
      const value = expressionAt(text, index + 1)
      values.push(value)
      index += 1 + value.length
    } else index++
  }
  return values
}

/**
 * Error codes the backend can answer, read from every way it produces them:
 * `AppError("code")` (also through a variable such as `code = "a" if test else "b"`), the codes of
 * pydantic validators, `{"code": …}` responses written by the middleware, Google sign-in and calendar
 * errors, and the per-field codes of validation errors. The PDF parser runs in a subprocess and
 * reports its own `AppError` codes, which are read from parser.py like the others.
 */
function backendCodes(): Map<string, Set<string>> {
  const codes = new Map<string, Set<string>>()
  for (const file of readdirSync(backend, { recursive: true, encoding: 'utf8' }).filter(name => name.endsWith('.py'))) {
    const text = readFileSync(join(backend, file), 'utf8')
    const add = (expression: string) => {
      for (const code of codesOf(text, expression)) codes.set(code, (codes.get(code) ?? new Set()).add(file))
    }
    for (const pattern of [
      /\b(?:AppError|PydanticCustomError)\(\s*/g,
      /["']code["']\s*:\s*/g,
      /\[\s*["']code["']\s*\]\s*=(?!=)\s*/g,
      /\bgoogle_error\s*=(?!=)\s*/g,
      /["']google_error["']\s*:\s*/g,
    ]) for (const match of text.matchAll(pattern)) add(expressionAt(text, match.index + match[0].length))
    // Per-field codes: `fields[name] = …`, `fields.update(name=…)`, and `fields = {…}` / `codes = {…}` maps.
    for (const match of text.matchAll(/\bfields\s*\[/g)) {
      const end = closing(text, match.index + match[0].length - 1)
      const assignment = /^\s*=(?!=)\s*/.exec(text.slice(end + 1))
      if (assignment) add(expressionAt(text, end + 1 + assignment[0].length))
    }
    for (const match of text.matchAll(/\bfields\.update\(/g)) {
      const start = match.index + match[0].length - 1
      for (const argument of text.slice(start + 1, closing(text, start)).matchAll(/\b\w+\s*=(?!=)\s*/g)) {
        add(expressionAt(text, start + 1 + argument.index + argument[0].length))
      }
    }
    for (const match of text.matchAll(/\b(?:fields|codes)\s*(?::[^=\n]+)?=\s*\{/g)) {
      dictValues(text, match.index + match[0].length - 1).forEach(add)
    }
  }
  return codes
}

const codes = backendCodes()

test('the backend sources yield every kind of error code', () => {
  for (const code of [
    'action_storage_user_quota', // AppError("…")
    'login_throttled', 'request_throttled', // a variable assigned in both branches of a conditional
    'request_too_large', 'upload_too_large', 'request_busy', // {"code": …} answered by the middleware
    'contact_channel_required', // a pydantic validator
    'contact_name_invalid', 'contact_tag_color_invalid', // per-field codes of validation errors
    'event_field_invalid', 'event_time_nonexistent', 'event_time_ambiguous',
    'google_access_denied', 'event_calendar_too_long', // Google sign-in and calendar link errors
    'dwelling_layout_invalid', 'internal_error', 'invalid_request',
  ]) expect(codes.has(code), code).toBe(true)
  expect(codes.size).toBeGreaterThan(100)
  for (const code of codes.keys()) expect(code).toMatch(/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/)
})

test('every backend error code has a message in English and Spanish', () => {
  const translated = (dictionary: Readonly<Record<string, string>>, code: string) =>
    Object.hasOwn(dictionary, code) && dictionary[code].trim() !== ''
  const missing = [...codes]
    .filter(([code]) => !unreachable.has(code) && !(translated(english.codes, code) && translated(spanish.codes, code)))
    .map(([code, files]) => `${code} (${[...files].join(', ')})`)
  expect(missing).toEqual([])
})

test('the codes allowed without a message still exist where documented', () => {
  for (const [code, file] of unreachable) expect([...codes.get(code) ?? []], code).toContain(file)
})
