import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import type { NotificationOut, NotificationsOut } from '../src/api/schema.gen'
import { signInAsAdministrator } from './support'

function missingStatement(id: number, month: string, minutesAgo: number): NotificationOut {
  return {
    id, kind: 'statement_missing', params: { month }, link: '/admin', read: false,
    created_at: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
  }
}

/** Answers the bell's requests with two missing statements, as the server lists them. */
async function twoAlerts(page: Page) {
  let items = [missingStatement(2, '2026-11', 5), missingStatement(1, '2026-10', 60 * 24 * 32)]
  const answer = (): NotificationsOut => ({
    kinds: [{ kind: 'statement_missing', enabled: true }], unread: items.filter(item => !item.read).length, items,
  })
  await page.route('**/api/notifications', route => route.fulfill({ json: answer() }))
  await page.route('**/api/notifications/read-all', route => {
    items = items.map(item => ({ ...item, read: true }))
    return route.fulfill({ json: answer() })
  })
  await page.route(/\/api\/notifications\/\d+\/(read|dismiss)$/, route => {
    const [, id, action] = /\/(\d+)\/(read|dismiss)$/.exec(route.request().url())!
    items = action === 'dismiss'
      ? items.filter(item => item.id !== Number(id))
      : items.map(item => item.id === Number(id) ? { ...item, read: true } : item)
    return route.fulfill({ json: answer() })
  })
}

test('the bell lists the administrator\'s notifications, by keyboard too, and opens their page', async ({ page }) => {
  await twoAlerts(page)
  await signInAsAdministrator(page, '/')
  const bell = page.getByRole('button', { name: /^Notifications/ })
  await expect(bell).toHaveAccessibleName('Notifications: 2 unread')
  await expect(bell).toHaveText('2')
  await bell.click()
  const panel = page.getByRole('dialog', { name: 'Notifications' })
  await expect(panel.getByRole('button', { name: 'Mark all as read' })).toBeFocused()
  await expect(panel.getByRole('link', { name: 'Missing statement: November 2026', exact: true })).toBeVisible()
  await expect(panel.getByText('5 minutes ago')).toBeVisible()
  await expect(panel.getByText('last month')).toBeVisible()
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])

  await panel.getByRole('button', { name: 'Dismiss: Missing statement: October 2026' }).click()
  await expect(panel.getByRole('link', { name: 'Missing statement: October 2026' })).toHaveCount(0)
  await expect(bell).toHaveAccessibleName('Notifications: 1 unread')
  await expect(panel).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(panel).toBeHidden()
  await expect(bell).toBeFocused()

  await page.keyboard.press('Enter')
  await panel.getByRole('link', { name: 'Missing statement: November 2026', exact: true }).click()
  await page.waitForURL(url => url.pathname === '/admin')
  await expect(panel).toBeHidden()
  await expect(bell).toHaveAccessibleName('Notifications')
  await expect(bell).toHaveText('')
})

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 } })

  test('the panel takes the width of the screen under the top bar', async ({ page }) => {
    await twoAlerts(page)
    await signInAsAdministrator(page, '/')
    await page.getByRole('button', { name: 'Notifications: 2 unread', exact: true }).click()
    const panel = page.getByRole('dialog', { name: 'Notifications' })
    const box = (await panel.boundingBox())!
    const bar = (await page.locator('.topbar').boundingBox())!
    // Under the top bar (over its 1-pixel border, like the search), across the whole screen.
    expect({ x: box.x, width: box.width }).toEqual({ x: 0, width: 390 })
    expect(Math.abs(box.y - (bar.y + bar.height))).toBeLessThanOrEqual(1)
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
    await panel.getByRole('button', { name: 'Mark all as read' }).click()
    await expect(page.getByRole('button', { name: 'Notifications', exact: true })).toBeVisible()
  })
})

test.describe('in My profile', () => {
  test('the administrator chooses the notifications, from the bell', async ({ page }) => {
    // Chromium's headless shell denies notifications to every site: this one has not been asked yet.
    await page.addInitScript(() => Object.defineProperty(Notification, 'permission', { get: () => 'default' }))
    await signInAsAdministrator(page, '/')
    await page.getByRole('button', { name: /^Notifications/ }).click()
    await page.getByRole('dialog', { name: 'Notifications' }).getByRole('link', { name: 'Notification settings' }).click()
    await page.waitForURL(url => url.pathname === '/profile' && url.hash === '#notifications')
    const card = page.getByRole('region', { name: 'Notifications' })
    await expect(card.getByRole('heading', { name: 'Notifications', level: 2 })).toBeFocused()
    // The smoke server's address is a secure context, where Chromium offers push notifications.
    await expect(card.getByRole('switch', { name: 'Notifications on this device' })).toHaveAttribute('aria-checked', 'false')
    const kind = card.getByRole('switch', { name: 'Missing bank statement' })
    await expect(kind).toHaveAttribute('aria-checked', 'true')
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
    await kind.click()
    await expect(kind).toHaveAttribute('aria-checked', 'false')
    await page.reload()
    await expect(kind).toHaveAttribute('aria-checked', 'false')
    await kind.click()
    await expect(kind).toHaveAttribute('aria-checked', 'true')
  })
})
