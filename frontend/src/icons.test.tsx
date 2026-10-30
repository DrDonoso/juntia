import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, test } from 'vitest'
import { Icon, type IconName } from './icons'

afterEach(cleanup)

const names: IconName[] = [
  'home', 'dashboard', 'receipt', 'file-text', 'settings', 'menu', 'close', 'check',
  'upload', 'download', 'edit', 'trash', 'refresh', 'spinner', 'user', 'tag', 'arrow-up', 'arrow-down',
  'arrow-left', 'arrow-right', 'sun', 'moon', 'eye', 'eye-off', 'copy', 'more',
  'mail', 'phone', 'sort', 'grip', 'globe',
]

test.each(names)('%s uses a decorative, theme-aware SVG instead of a font glyph', name => {
  const { container } = render(<Icon name={name} />)
  const svg = container.querySelector('svg')!
  expect(svg).toHaveClass('icon')
  expect(svg).toHaveAttribute('viewBox', '0 0 24 24')
  expect(svg).toHaveAttribute('width', '20')
  expect(svg).toHaveAttribute('height', '20')
  expect(svg).toHaveAttribute('fill', 'none')
  expect(svg).toHaveAttribute('stroke', 'currentColor')
  expect(svg).toHaveAttribute('stroke-width', '2')
  expect(svg).toHaveAttribute('stroke-linecap', 'round')
  expect(svg).toHaveAttribute('stroke-linejoin', 'round')
  expect(svg).toHaveAttribute('aria-hidden', 'true')
  expect(svg).toHaveAttribute('focusable', 'false')
  expect(svg.children.length).toBeGreaterThan(0)
  expect(svg.textContent).toBe('')
})

test('custom sizes and animation classes preserve the shared icon styling', () => {
  const { container } = render(<Icon name="spinner" size={44} className="loading-spinner icon-spin" />)
  const svg = container.querySelector('svg')!
  expect(svg).toHaveClass('icon', 'loading-spinner', 'icon-spin')
  expect(svg).toHaveAttribute('width', '44')
  expect(svg).toHaveAttribute('height', '44')
})

test('decorative icons do not change the accessible name of their controls', () => {
  render(<button type="button" aria-label="Contacts"><Icon name="mail" /></button>)
  expect(screen.getByRole('button', { name: 'Contacts' })).toHaveAccessibleName('Contacts')
  expect(screen.queryByRole('img')).toBeNull()
})
