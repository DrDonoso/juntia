import { fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, expect, test } from 'vitest'
import { setLanguage } from './i18n'
import { MarkdownText, isOwnImage } from './markdown'

const IMAGE = '/api/actions/images/0b0f7d2e-5a1c-4c33-9a7e-2f1d6c8e9b10'

afterEach(() => setLanguage('en'))

function show(text: string) {
  return render(<MemoryRouter><MarkdownText text={text} /></MemoryRouter>).container.firstElementChild as HTMLElement
}

test('only the addresses of uploaded images count as own images', () => {
  expect(isOwnImage(IMAGE)).toBe(true)
  expect(isOwnImage('/api/events/images/0B0F7D2E-5A1C-4C33-9A7E-2F1D6C8E9B10')).toBe(true)
  for (const src of [
    undefined, '', 'https://example.org/a.png', '//example.org/api/actions/images/x', `${IMAGE}/extra`, `${IMAGE}?x=1`,
    '/api/actions/items/1/attachments/0b0f7d2e-5a1c-4c33-9a7e-2f1d6c8e9b10/preview', 'data:image/png;base64,AAAA',
  ]) expect(isOwnImage(src), String(src)).toBe(false)
})

test('GitHub-flavored Markdown is rendered and single line breaks are kept', () => {
  const root = show('**Quote** received\nfrom *Apex Lifts*\n\n- ~~old~~ price\n- new price\n\n> Agreed in the meeting\n\n`code` and\n\n```\nblock\n```')
  expect(root).toHaveClass('markdown')
  expect(root.querySelector('strong')).toHaveTextContent('Quote')
  expect(root.querySelector('em')).toHaveTextContent('Apex Lifts')
  expect(root.querySelector('p')?.querySelector('br')).not.toBeNull()
  expect(within(root).getAllByRole('listitem').map(item => item.textContent)).toEqual(['old price', 'new price'])
  expect(root.querySelector('del')).toHaveTextContent('old')
  expect(root.querySelector('blockquote')).toHaveTextContent('Agreed in the meeting')
  expect(root.querySelector('pre code')).toHaveTextContent('block')
})

test('raw HTML is shown as text and unsafe links are not links', () => {
  const root = show('<img src=x onerror=alert(1)> <b>bold</b>\n\n<script>alert(1)</script>\n\n[click](javascript:alert(1)) [mail](mailto:board@example.org)')
  expect(root.querySelector('img, b, script')).toBeNull()
  expect(root).toHaveTextContent('<img src=x onerror=alert(1)> <b>bold</b>')
  expect(root).toHaveTextContent('<script>alert(1)</script>')
  expect(within(root).queryByRole('link', { name: 'click' })).toBeNull()
  expect(within(root).getByText('click').tagName).toBe('SPAN')
  expect(within(root).getByRole('link', { name: 'mail' })).toHaveAttribute('href', 'mailto:board@example.org')
})

test('links open other sites in a new tab and the app in place', () => {
  const root = show('[Supplier](https://example.org/quote) www.example.com [Event](/events?event=4) [File](/api/actions/items/1/attachments/x/preview) [Other](//example.net/x) [Tricky](/\\example.net/x)')
  const external = within(root).getByRole('link', { name: 'Supplier' })
  expect(external).toHaveAttribute('target', '_blank')
  expect(external).toHaveAttribute('rel', 'noopener noreferrer')
  expect(within(root).getByRole('link', { name: 'www.example.com' })).toHaveAttribute('href', 'http://www.example.com')
  const internal = within(root).getByRole('link', { name: 'Event' })
  expect(internal).toHaveAttribute('href', '/events?event=4')
  expect(internal).not.toHaveAttribute('target')
  expect(within(root).getByRole('link', { name: 'File' })).toHaveAttribute('target', '_blank')
  expect(within(root).getByRole('link', { name: 'Other' })).toHaveAttribute('rel', 'noopener noreferrer')
  // Markdown encodes the backslash: the address stays a path of this site.
  expect(within(root).getByRole('link', { name: 'Tricky' })).toHaveAttribute('href', '/%5Cexample.net/x')
})

test('uploaded images are shown and open at full size; other images are never loaded', () => {
  const root = show(`![Roof leak](${IMAGE})\n\n![](${IMAGE.replace('actions', 'events')})\n\n![Tracker](https://example.org/pixel.png)\n\n![Inline](data:image/png;base64,AAAA)`)
  const images = within(root).getAllByRole('img')
  expect(images.map(image => [image.getAttribute('src'), image.getAttribute('alt')])).toEqual([
    [IMAGE, 'Roof leak'], [IMAGE.replace('actions', 'events'), 'Image'],
  ])
  expect(images[0]).toHaveAttribute('loading', 'lazy')
  const link = within(root).getByRole('link', { name: 'Roof leak' })
  expect(link).toHaveAttribute('href', IMAGE)
  expect(link).toHaveAttribute('target', '_blank')
  expect(within(root).getByRole('link', { name: 'Tracker' })).toHaveAttribute('href', 'https://example.org/pixel.png')
  expect(within(root).getByText('Inline').tagName).toBe('SPAN')
  fireEvent.error(images[0])
  expect(within(root).getByText('Image not available: Roof leak')).toBeVisible()
  expect(within(root).getAllByRole('img')).toHaveLength(1)
})

test('headings stay below the page headings and tables and tasks are accessible', () => {
  const root = show('# Title\n## Section\n\n| Item | Price |\n| --- | --- |\n| Door | 120 |\n\n- [x] Quote\n- [ ] Vote')
  expect(root.querySelector('h1, h2')).toBeNull()
  expect(within(root).getByRole('heading', { level: 3, name: 'Title' })).toBeVisible()
  expect(within(root).getByRole('heading', { level: 4, name: 'Section' })).toBeVisible()
  const table = within(root).getByRole('region', { name: 'Table' })
  expect(table).toHaveAttribute('tabindex', '0')
  expect(within(table).getByRole('table')).toHaveTextContent('Door')
  expect(within(root).getByRole('checkbox', { name: 'Completed task' })).toBeChecked()
  expect(within(root).getByRole('checkbox', { name: 'Pending task' })).not.toBeChecked()
  expect(within(root).getAllByRole('checkbox').every(box => box.hasAttribute('disabled'))).toBe(true)
})

test('footnotes get ids of their own text and labels in the active language', () => {
  setLanguage('es')
  render(<MemoryRouter><MarkdownText text={'Note[^1]\n\n[^1]: First'} /><MarkdownText text={'Other[^1]\n\n[^1]: Second'} /></MemoryRouter>)
  const ids = Array.from(document.querySelectorAll('[id]'), element => element.id)
  expect(ids).toHaveLength(6)
  expect(new Set(ids).size).toBe(6)
  for (const reference of document.querySelectorAll('[aria-describedby]')) {
    expect(document.getElementById(reference.getAttribute('aria-describedby') ?? '')).toHaveTextContent('Notas al pie')
  }
  expect(screen.getAllByText('Notas al pie')).toHaveLength(2)
  expect(screen.getAllByRole('link', { name: 'Volver a la referencia 1' })).toHaveLength(2)
})
