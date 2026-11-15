import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest'
import { Modal } from './shared'

const originalShow = HTMLDialogElement.prototype.showModal
const originalClose = HTMLDialogElement.prototype.close
// Every dialog in these tests spans 100–500 × 100–400; anything else is its backdrop.
const box = { x: 100, y: 100, left: 100, top: 100, right: 500, bottom: 400, width: 400, height: 300 }
const inside = { clientX: 200, clientY: 200 }, edge = { clientX: 110, clientY: 110 }, backdrop = { clientX: 50, clientY: 50 }

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', '') }
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open') }
})
afterAll(() => {
  HTMLDialogElement.prototype.showModal = originalShow
  HTMLDialogElement.prototype.close = originalClose
})
beforeEach(() => {
  vi.spyOn(HTMLDialogElement.prototype, 'getBoundingClientRect').mockReturnValue({ ...box, toJSON: () => box })
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

// Browsers send the clicks on a modal dialog's backdrop to the dialog element itself.
function click(target: Element, point: { clientX: number; clientY: number }) {
  fireEvent.mouseDown(target, point)
  fireEvent.click(target, point)
}

test('a click on the backdrop closes a dialog, unlike clicks inside it or on its edge', () => {
  const close = vi.fn()
  render(<Modal title="Preview" close={close}><p>Body</p></Modal>)
  const dialog = screen.getByRole('dialog', { name: 'Preview' })
  click(screen.getByText('Body'), inside)
  click(dialog, edge)
  expect(close).not.toHaveBeenCalled()
  click(dialog, backdrop)
  expect(close).toHaveBeenCalledOnce()
})

test('selecting text inside a dialog and releasing over the backdrop keeps it open', () => {
  const close = vi.fn()
  render(<Modal title="Rename" close={close}><input aria-label="New name" /></Modal>)
  fireEvent.mouseDown(screen.getByRole('textbox', { name: 'New name' }), inside)
  // The click goes to the closest element shared by the press and the release: the dialog.
  fireEvent.click(screen.getByRole('dialog', { name: 'Rename' }), backdrop)
  expect(close).not.toHaveBeenCalled()
})

test('a busy dialog stays open on a backdrop click', () => {
  const close = vi.fn()
  render(<Modal title="Deleting" close={close} disabled><p>Body</p></Modal>)
  click(screen.getByRole('dialog', { name: 'Deleting' }), backdrop)
  expect(close).not.toHaveBeenCalled()
})

test('the backdrop of a dialog opened from another closes only the topmost one', () => {
  const outer = vi.fn(), inner = vi.fn()
  render(<Modal title="Event" close={outer}><Modal title="History" close={inner}><p>Entries</p></Modal></Modal>)
  click(screen.getByRole('dialog', { name: 'History' }), backdrop)
  expect(inner).toHaveBeenCalledOnce()
  expect(outer).not.toHaveBeenCalled()
})
