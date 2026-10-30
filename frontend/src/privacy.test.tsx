import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, test } from 'vitest'
import { setLanguage } from './i18n'
import { PrivacyContext, PrivateValue, storedPrivacy } from './privacy'

afterEach(() => { cleanup(); localStorage.clear() })

test('amounts are visible by default', () => {
  expect(storedPrivacy()).toBe(false)
  render(<PrivateValue>€123.45</PrivateValue>)
  expect(screen.getByText('€123.45')).not.toHaveAttribute('aria-hidden')
  expect(screen.queryByText('Hidden amount')).toBeNull()
})

test('privacy blurs the original value and supplies a non-sensitive accessible label', () => {
  localStorage.setItem('juntia_hide_values', '1')
  expect(storedPrivacy()).toBe(true)
  const { rerender } = render(<PrivacyContext value={true}><PrivateValue>€123.45</PrivateValue></PrivacyContext>)
  expect(screen.getByText('€123.45')).toHaveAttribute('aria-hidden', 'true')
  expect(screen.getByText('€123.45')).toHaveAttribute('data-hidden', 'true')
  expect(screen.getByText('Hidden amount')).toBeInTheDocument()
  rerender(<PrivacyContext value={false}><PrivateValue>€123.45</PrivateValue></PrivacyContext>)
  expect(screen.getByText('€123.45')).not.toHaveAttribute('data-hidden')
})

test('the hidden-amount label follows the active language unless a custom label is given', () => {
  setLanguage('es')
  const { rerender } = render(<PrivacyContext value={true}><PrivateValue>€123.45</PrivateValue></PrivacyContext>)
  expect(screen.getByText('Importe oculto')).toBeInTheDocument()
  rerender(<PrivacyContext value={true}><PrivateValue hiddenLabel="Hidden balance">€123.45</PrivateValue></PrivacyContext>)
  expect(screen.getByText('Hidden balance')).toBeInTheDocument()
})
