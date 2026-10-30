import { useContext, useEffect, useRef, useState, type RefObject } from 'react'
import {
  Button, ComboBox, ComboBoxStateContext, FieldError, Group, Input, Label,
  ListBox, ListBoxItem, Popover, Tag, TagGroup, TagList, Text,
} from 'react-aria-components'
import { codeMessage } from './api/client'
import type { ContactTagIn, ContactTagOut } from './api/schema.gen'
import { useI18n } from './i18n'
import { hasControlCharacters } from './shared'
import { Icon } from './icons'

export type ContactTagChoice = { id: number | null; name: string; color: string }
type ContactTagOption = { id: number; name: string; color: string }
/** Texts of the picker that name what it edits; each one defaults to the contact tags wording. */
export type TagPickerTexts = { label: string; selected: string; available: string; preview: string }
export const DEFAULT_TAG_COLOR = '#94a3b8'
const palette = [
  '#b94644', '#47a4b4', '#c6c102', '#4963de', '#bd9670',
  '#896385', '#cf7ffd', '#e65909', '#2bccb4', '#d77089',
]
export function normalizeTagName(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase()
}
export function paletteColor(name: string): string {
  // Keep this signed 32-bit hash over UTF-16 code units: tags without a saved color are drawn with
  // it, so changing it would recolor them.
  let hash = 0
  for (const character of name) hash = (hash * 31 + character.charCodeAt(0)) & 0xffffffff
  return palette[Math.abs(hash) % palette.length]
}
export function tagColor(tag: { name: string; color: string | null }): string {
  return tag.color ?? paletteColor(tag.name)
}
export function tagTextColor(color: string): '#000000' | '#ffffff' {
  const channels = [1, 3, 5].map(offset => {
    const value = parseInt(color.slice(offset, offset + 2), 16) / 255
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  })
  const luminance = channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722
  return (luminance + 0.05) / 0.05 >= 1.05 / (luminance + 0.05) ? '#000000' : '#ffffff'
}
export function tagNameError(value: string): string | undefined {
  const normalized = normalizeTagName(value)
  return !normalized || normalized.length > 100 || hasControlCharacters(value)
    ? codeMessage('contact_tag_name_invalid') : undefined
}
export function appendContactTag(selected: ContactTagChoice[], text: string, available: ContactTagOption[]): {
  tags: ContactTagChoice[]; error?: string
} {
  if (!text.trim()) return { tags: selected }
  const error = tagNameError(text)
  if (error) return { tags: selected, error }
  const name = normalizeTagName(text)
  const existing = available.find(tag => normalizeTagName(tag.name) === name)
  if (selected.some(tag => existing && tag.id === existing.id || normalizeTagName(tag.name) === name)) return { tags: selected }
  if (selected.length >= 30) return { tags: selected, error: codeMessage('contact_tags_invalid') }
  const tag = existing
    ? { id: existing.id, name: existing.name, color: existing.color }
    : { id: null, name, color: paletteColor(name) }
  return { tags: [...selected, tag] }
}

export function TagBadge({ tag, preview = false, previewLabel }: { tag: ContactTagIn; preview?: boolean; previewLabel?: string }) {
  const { t } = useI18n()
  return <span className={`tag contact-tag${preview ? ' contact-tag-preview' : ''}`} aria-label={preview ? previewLabel ?? t('contacts.tags.preview') : undefined}
    style={{ backgroundColor: tag.color, color: tagTextColor(tag.color) }}>{tag.name}</span>
}
export function Tags({ tags }: { tags: ContactTagOut[] }) {
  const { t } = useI18n()
  return tags.length ? <div className="contact-tags">{tags.map(tag => <TagBadge key={tag.id} tag={tag} />)}</div> : <span className="muted">{t('contacts.tags.none')}</span>
}

function TagPickerInput({ field, hasTags, add, removeLast, startSearch }: {
  field: RefObject<HTMLInputElement | null>; hasTags: boolean
  add: (value: string) => boolean; removeLast: () => void; startSearch: () => void
}) {
  const { t } = useI18n()
  const state = useContext(ComboBoxStateContext)
  const isOpen = state?.isOpen, close = state?.close
  useEffect(() => {
    if (!isOpen || !close) return
    window.addEventListener('resize', close)
    return () => window.removeEventListener('resize', close)
  }, [isOpen, close])
  // The initial collection-building render does not provide ComboBox state yet.
  if (!state) return null
  function open() { startSearch(); state?.open(null, 'manual') }
  return <Input ref={field} maxLength={100} placeholder={hasTags ? '' : t('contacts.tags.placeholder')}
    onFocus={() => { if (!state.isFocused) open() }} onClick={open}
    onKeyDownCapture={event => {
      if (event.nativeEvent.isComposing) return
      if (event.key === 'Enter' || event.key === ',' || event.key === ' ') {
        // Commit before ComboBox handles Enter so one key never adds or submits twice.
        event.preventDefault(); event.stopPropagation()
        const focusedKey = state.isOpen ? state.selectionManager.focusedKey : null
        const name = focusedKey == null ? state.inputValue : state.collection.getItem(focusedKey)?.textValue ?? state.inputValue
        if (add(name)) state.close()
      } else if (event.key === 'Backspace' && state.inputValue === '' && hasTags) {
        event.preventDefault(); event.stopPropagation(); removeLast()
      } else if (event.key === 'Escape' && state.isOpen) {
        event.preventDefault(); event.stopPropagation(); state.close()
      }
    }} />
}

function TagPickerTags({ selected, available, disabled, remove, field, label }: {
  selected: ContactTagChoice[]; available: ContactTagOption[]; disabled: boolean
  remove: (index: number) => void; field: RefObject<HTMLInputElement | null>; label: string
}) {
  const { t } = useI18n()
  const state = useContext(ComboBoxStateContext)
  // Keep the independent chip collection out of ComboBox's collection-building render.
  if (!state || !selected.length) return null
  return <TagGroup className="contact-tag-group" aria-label={label}
    onRemove={keys => {
      const index = selected.findIndex(choice => keys.has(choice.id ?? `new:${choice.name}`))
      if (index >= 0) { remove(index); field.current?.focus() }
    }}>
    <TagList className="contact-tag-list">
      {selected.map(choice => {
        const tag = choice.id === null ? choice : available.find(tag => tag.id === choice.id) || choice
        const key = choice.id ?? `new:${choice.name}`
        return <Tag id={key} key={key} textValue={tag.name} isDisabled={disabled}
          className="tag contact-tag contact-tag-chip" style={{ backgroundColor: tag.color, color: tagTextColor(tag.color) }}>
          <span className="contact-tag-name">{tag.name}</span>
          <Button slot="remove" className="contact-tag-remove" aria-label={t('contacts.tags.remove')}><Icon name="close" size={14} /></Button>
        </Tag>
      })}
    </TagList>
  </TagGroup>
}

export function ContactTagPicker({ selected, available, input, changeInput, add, remove, disabled, error, texts }: {
  selected: ContactTagChoice[]; available: ContactTagOption[]; input: string
  changeInput: (value: string) => void; add: (value: string) => boolean
  remove: (index: number) => void; disabled: boolean; error?: string; texts?: Partial<TagPickerTexts>
}) {
  const { t } = useI18n()
  const text: TagPickerTexts = {
    label: texts?.label ?? t('contacts.tags.label'),
    selected: texts?.selected ?? t('contacts.tags.selected'),
    available: texts?.available ?? t('contacts.tags.available'),
    preview: texts?.preview ?? t('contacts.tags.preview'),
  }
  const field = useRef<HTMLInputElement>(null)
  const [portal, setPortal] = useState<Element>()
  const [searching, setSearching] = useState(true)
  const query = normalizeTagName(input)
  const unselected = available.filter(tag => !selected.some(choice => choice.id === tag.id || normalizeTagName(choice.name) === normalizeTagName(tag.name)))
  const suggestions = query
    ? unselected.filter(tag => normalizeTagName(tag.name).includes(query))
    : unselected.slice(0, 8)
  const exact = available.find(tag => normalizeTagName(tag.name) === query)
  const previewColor = query ? exact?.color || paletteColor(query) : DEFAULT_TAG_COLOR
  function choose(value: string): boolean {
    if (!add(value)) return false
    // Clearing committed text must not reopen the menu as if the user had typed.
    setSearching(false)
    return true
  }
  return <ComboBox className="contact-tag-field" name="tags" items={suggestions} value={null}
    inputValue={input} onInputChange={value => { setSearching(true); changeInput(value) }}
    allowsCustomValue menuTrigger={searching ? 'focus' : 'manual'}
    isDisabled={disabled} isInvalid={!!error} validationBehavior="aria"
    onBlur={() => { choose(input) }}
    onOpenChange={open => {
      if (open) setPortal(field.current?.closest('dialog') || document.body)
    }}>
    <Label>{text.label}</Label>
    <Group className="contact-tag-input">
      <TagPickerTags selected={selected} available={available} disabled={disabled} remove={remove} field={field} label={text.selected} />
      <TagPickerInput field={field} hasTags={selected.length > 0} add={choose}
        removeLast={() => remove(selected.length - 1)} startSearch={() => setSearching(true)} />
      <span className="contact-preview" style={{ opacity: query ? 1 : 0.4 }}><TagBadge preview previewLabel={text.preview} tag={{ name: input.trim() || '…', color: previewColor }} /></span>
    </Group>
    <Text slot="description" className="muted contact-tag-hint">{t('contacts.tags.hint')}</Text>
    {/* Fixed positioning avoids the native dialog's centered offset and clipping. */}
    <ComboBoxStateContext.Consumer>
      {state => <Popover className="contact-tag-popover" placement="bottom start" offset={4} maxHeight={200}
        style={{ position: 'fixed' }} UNSTABLE_portalContainer={portal} boundaryElement={portal}>
        <ListBox<ContactTagOption> className="contact-tag-options" aria-label={text.available}
          onAction={key => {
            const tag = suggestions.find(tag => tag.id === key)
            if (tag && choose(tag.name)) state?.close()
          }}>
          {tag => <ListBoxItem id={tag.id} textValue={tag.name} className="contact-tag-option"><TagBadge tag={tag} /></ListBoxItem>}
        </ListBox>
      </Popover>}
    </ComboBoxStateContext.Consumer>
    <FieldError className="notice error"><span role="alert">{error}</span></FieldError>
  </ComboBox>
}
