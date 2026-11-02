import { useState } from 'react'
import { MemoryRouter } from 'react-router'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { CommunityImageOut } from './api/schema.gen'
import { MarkdownField, imageAlt, insertBlock, type ImageScope } from './markdown-field'

type Upload = { path: string; file: File; uploadId: string; finish: (response?: Response) => void }
let uploads: Upload[]
let uploading: boolean[]

function gif(name: string): File {
  // A 1×1 GIF: sent as it is, without decoding.
  return new File([new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0, 0, 0, 0, 0x3b])], name, { type: 'image/gif' })
}

function imageOut(uploadId: string, scope: ImageScope = 'actions'): CommunityImageOut {
  return {
    id: uploadId, url: `/api/${scope}/images/${uploadId}`, filename: 'image.gif', media_type: 'image/gif', size: 14,
    width: 1, height: 1, created_at: '2026-10-10T10:00:00Z',
  }
}

function Field({ initial = '', maxLength = 20000, disabled = false, scope = 'actions' }: {
  initial?: string; maxLength?: number; disabled?: boolean; scope?: ImageScope
}) {
  const [value, setValue] = useState(initial)
  return <MemoryRouter>
    <MarkdownField label="Description" scope={scope} maxLength={maxLength} value={value} disabled={disabled}
      change={update => setValue(update)} onUploadingChange={value => uploading.push(value)} />
    <output data-testid="value">{value}</output>
  </MemoryRouter>
}

function text() {
  return screen.getByTestId('value').textContent ?? ''
}

function textarea() {
  return screen.getByLabelText('Description') as HTMLTextAreaElement
}

function paste(files: File[], plain = '') {
  const field = textarea()
  field.focus()
  return fireEvent.paste(field, { clipboardData: { files, getData: (type: string) => type === 'text/plain' ? plain : '' } })
}

beforeEach(() => {
  uploads = []
  uploading = []
  vi.stubGlobal('fetch', vi.fn((path: string, options: RequestInit) => new Promise<Response>(resolve => {
    const data = options.body as FormData
    const uploadId = String(data.get('upload_id'))
    uploads.push({
      path, file: data.get('file') as File, uploadId,
      finish: response => resolve(response ?? new Response(JSON.stringify(imageOut(uploadId, path.includes('/events/') ? 'events' : 'actions')), { status: 201 })),
    })
  })))
})
afterEach(() => {
  cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals()
})

test('image descriptions come from the file name, and blocks go on lines of their own', () => {
  expect(imageAlt('Roof leak [north].jpg', 'Image')).toBe('Roof leak north')
  expect(imageAlt('image.png', 'Imagen')).toBe('Imagen')
  expect(imageAlt('.png', 'Image')).toBe('Image')
  expect(imageAlt('a\\b\nc', 'Image')).toBe('a b c')
  expect(imageAlt('x'.repeat(150), 'Image')).toBe('x'.repeat(100))
  expect(insertBlock('', 0, 0, 'IMG')).toEqual(['IMG', 3])
  expect(insertBlock('Before after', 6, 6, 'IMG')).toEqual(['Before\nIMG\n after', 11])
  expect(insertBlock('Line\n', 5, 5, 'IMG')).toEqual(['Line\nIMG', 8])
  expect(insertBlock('Replace THIS now', 8, 12, 'IMG')).toEqual(['Replace \nIMG\n now', 13])
})

test('a pasted image shows a placeholder while it uploads, then its Markdown', async () => {
  render(<Field initial="Roof:" />)
  textarea().setSelectionRange(5, 5)
  expect(paste([gif('leak.gif')])).toBe(false)
  expect(text()).toMatch(/^Roof:\n!\[Uploading leak…\]\(#upload-[0-9a-f]{8}\)$/)
  expect(await screen.findByText('Uploading 1 image…')).toHaveAttribute('role', 'status')
  await waitFor(() => expect(uploads).toHaveLength(1))
  expect(uploads[0].path).toBe('/api/actions/images')
  expect(uploads[0].file.name).toBe('leak.gif')
  expect(uploads[0].uploadId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  expect(uploading.at(-1)).toBe(true)
  await act(async () => uploads[0].finish())
  expect(text()).toBe(`Roof:\n![leak](/api/actions/images/${uploads[0].uploadId})`)
  expect(screen.queryByText(/^Uploading/)).toBeNull()
  expect(uploading.at(-1)).toBe(false)
})

test('dollar signs in file names stay as they are', async () => {
  render(<Field initial={'Before\n\nAfter'} />)
  textarea().setSelectionRange(7, 7)
  paste([gif("Budget $' and $&.gif")])
  await waitFor(() => expect(uploads).toHaveLength(1))
  await act(async () => uploads[0].finish())
  expect(text()).toBe(`Before\n![Budget $' and $&](/api/actions/images/${uploads[0].uploadId})\nAfter`)
})

test('copied cells keep their text: a picture that comes with text is not uploaded', () => {
  render(<Field />)
  expect(paste([gif('cells.gif')], 'Door\t120')).toBe(true)
  expect(text()).toBe('')
  expect(fetch).not.toHaveBeenCalled()
})

test('dropped images upload one at a time in order, and other files are refused', async () => {
  render(<Field scope="events" />)
  const files = [gif('first.gif'), new File(['%PDF-1.7'], 'minutes.pdf', { type: 'application/pdf' }), gif('second.gif')]
  fireEvent.dragOver(textarea(), { dataTransfer: { types: ['Files'], files, dropEffect: 'none' } })
  expect(textarea()).toHaveClass('markdown-dropping')
  fireEvent.drop(textarea(), { dataTransfer: { types: ['Files'], files } })
  expect(textarea()).not.toHaveClass('markdown-dropping')
  expect(screen.getByRole('alert')).toHaveTextContent('minutes.pdf is not a PNG, JPEG, GIF or WebP image.')
  expect(screen.getByText('Uploading 2 images…')).toBeVisible()
  await waitFor(() => expect(uploads).toHaveLength(1))
  expect(uploads[0]).toMatchObject({ path: '/api/events/images', file: expect.objectContaining({ name: 'first.gif' }) })
  await act(async () => uploads[0].finish())
  await waitFor(() => expect(uploads).toHaveLength(2))
  await act(async () => uploads[1].finish())
  expect(text()).toBe(`![first](/api/events/images/${uploads[0].uploadId})\n![second](/api/events/images/${uploads[1].uploadId})`)
})

test('"Add image" chooses pictures on devices where pasting is awkward', async () => {
  const user = userEvent.setup()
  render(<Field />)
  const button = screen.getByRole('button', { name: 'Add image to Description' })
  expect(button).toHaveTextContent('Add image')
  await user.upload(screen.getByLabelText('Add image to Description', { selector: 'input' }), gif('photo.gif'))
  await waitFor(() => expect(uploads).toHaveLength(1))
  await act(async () => uploads[0].finish())
  expect(text()).toBe(`![photo](/api/actions/images/${uploads[0].uploadId})`)
})

test('a failed upload removes its placeholder and says why', async () => {
  render(<Field initial="Text" />)
  textarea().setSelectionRange(4, 4)
  paste([gif('leak.gif')])
  await waitFor(() => expect(uploads).toHaveLength(1))
  await act(async () => uploads[0].finish(new Response(JSON.stringify({ code: 'action_storage_user_quota' }), { status: 409 })))
  expect(text()).toBe('Text\n')
  expect(screen.getByRole('alert')).toHaveTextContent('leak.gif could not be added: This file does not fit in your storage quota.')
  expect(uploading.at(-1)).toBe(false)
})

test('a text without room for an image refuses it before uploading', () => {
  render(<Field initial={'x'.repeat(60)} maxLength={200} />)
  paste([gif('leak.gif')])
  expect(screen.getByRole('alert')).toHaveTextContent('There is no room left in the text for more images.')
  expect(text()).toBe('x'.repeat(60))
  expect(fetch).not.toHaveBeenCalled()
})

test('a disabled field accepts no images', () => {
  render(<Field disabled />)
  expect(screen.getByRole('button', { name: 'Add image to Description' })).toBeDisabled()
  paste([gif('leak.gif')])
  fireEvent.drop(textarea(), { dataTransfer: { types: ['Files'], files: [gif('drop.gif')] } })
  expect(text()).toBe('')
  expect(fetch).not.toHaveBeenCalled()
})

test('Preview shows the rendered Markdown, and the tabs follow the arrow keys', async () => {
  const user = userEvent.setup()
  render(<Field initial={'**Bold** text\n\n![Plan](/api/actions/images/0b0f7d2e-5a1c-4c33-9a7e-2f1d6c8e9b10)'} />)
  const tabs = within(screen.getByRole('tablist', { name: 'Editing mode: Description' }))
  const write = tabs.getByRole('tab', { name: 'Write' }), preview = tabs.getByRole('tab', { name: 'Preview' })
  expect(write).toHaveAttribute('aria-selected', 'true')
  expect(screen.getByRole('tabpanel')).toContainElement(textarea())
  await user.click(preview)
  expect(preview).toHaveAttribute('aria-selected', 'true')
  expect(screen.queryByLabelText('Description')).toBeNull()
  const panel = screen.getByRole('tabpanel', { name: 'Preview' })
  expect(within(panel).getByText('Bold').tagName).toBe('STRONG')
  expect(within(panel).getByRole('img', { name: 'Plan' })).toBeVisible()
  fireEvent.keyDown(preview, { key: 'ArrowLeft' })
  expect(write).toHaveAttribute('aria-selected', 'true')
  expect(write).toHaveFocus()
  expect(textarea()).toHaveValue('**Bold** text\n\n![Plan](/api/actions/images/0b0f7d2e-5a1c-4c33-9a7e-2f1d6c8e9b10)')
  fireEvent.keyDown(write, { key: 'End' })
  expect(preview).toHaveFocus()
})

test('the help says what can be added and that images are kept', () => {
  render(<Field />)
  expect(textarea()).toHaveAccessibleDescription(
    'Markdown is supported. Paste, drop or add PNG, JPEG, GIF or WebP images (up to 10 MiB each): every member can see them, and they stay stored even if you remove them from the text.',
  )
})
