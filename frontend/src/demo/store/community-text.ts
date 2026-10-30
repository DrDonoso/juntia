/**
 * Text rules of the community domain, as the backend applies them (src/juntia/contracts.py,
 * community_action_files.py and query_sql.py): label and tag names, multi-line texts, PDF names and
 * the accent-insensitive search keys of contacts and events.
 */
import { characterCount, displayName, hasControlCharacters } from '../core/validation'

/** Python's `str.casefold()` for names and search keys (ß becomes ss, like the backend). */
export function casefold(value: string): string {
  return value.toUpperCase().toLowerCase()
}

/** Backend `fold_text`: case-folded, compatibility-decomposed and without combining marks. */
export function foldText(value: string): string {
  return casefold(value).normalize('NFKD').replace(/\p{Mn}/gu, '')
}

/** Label and tag names (`action_labels`, `TagIn.name`): NFKC, visible, at most 100 characters; null when invalid. */
export function labelName(value: string): string | null {
  const name = displayName(value.normalize('NFKC'))
  return name !== null && characterCount(name) <= 100 ? name : null
}

/** Catalogue key of a label or tag name (`normalized_name`): unique per catalogue. */
export function labelKey(name: string): string {
  return casefold(name.normalize('NFKC'))
}

/** Backend `action_text`: line breaks normalized, trimmed, no control characters but newlines and tabs; null when invalid. */
export function actionText(value: string): string | null {
  const text = value.replace(/\r\n?/g, '\n').trim()
  return hasControlCharacters(text.replace(/[\n\t]/g, '')) ? null : text
}

const FORMAT_OR_CONTROL = /[\p{Cc}\p{Cf}]/u

/**
 * Name an uploaded PDF keeps (`stage_pdf`): its base name without control or format characters,
 * the stem cut to 251 characters and a lower-case `.pdf`; null unless it names a PDF.
 */
export function uploadedPdfName(filename: string): string | null {
  const base = filename.split(/[/\\]/).at(-1) ?? ''
  const name = Array.from(base).filter(character => !FORMAT_OR_CONTROL.test(character)).join('').trim()
  if (!name.toLowerCase().endsWith('.pdf') || characterCount(name) <= 4) return null
  return `${Array.from(name).slice(0, -4).slice(0, 251).join('')}.pdf`
}

/** Backend `ActionAttachmentEdit.filename`: a visible name of at most 251 characters plus `.pdf`; null when invalid. */
export function renamedPdfName(value: string): string | null {
  if (Array.from(value).some(character => character === '/' || character === '\\' || FORMAT_OR_CONTROL.test(character))) return null
  const name = value.trim()
  const stem = name.toLowerCase().endsWith('.pdf') ? Array.from(name).slice(0, -4).join('').trim() : name
  return stem.replace(/^[ .]+|[ .]+$/g, '') && characterCount(stem) <= 251 ? `${stem}.pdf` : null
}

/** Canonical form of a UUID (`str(UUID(value))`), or null when `value` is not one. */
export function canonicalUuid(value: string): string | null {
  const hex = value.trim().toLowerCase().replace(/^urn:uuid:/, '').replace(/^\{(.*)\}$/, '$1')
  const digits = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/.test(hex) ? hex.replaceAll('-', '') : null
  return digits && `${digits.slice(0, 8)}-${digits.slice(8, 12)}-${digits.slice(12, 16)}-${digits.slice(16, 20)}-${digits.slice(20)}`
}
