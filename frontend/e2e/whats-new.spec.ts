import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'
import type { WhatsNewOut } from '../src/api/schema.gen'
import { signInAsAdministrator } from './support'

/** The first note (src/whats-new/notes/). */
const LAUNCH_NOTE = '2026-11-17-whats-new'

test('an account starts with nothing new to read, and finds every note in the user menu', async ({ page }) => {
  test.skip(Boolean(process.env.E2E_BASE_URL), 'Needs the smoke server, whose administrator has read no note yet')
  const answered = page.waitForResponse(response => response.url().endsWith('/api/whats-new') && response.request().method() === 'GET')
  await signInAsAdministrator(page, '/')
  await answered
  // The first visit of an account marks every note as read, without showing them.
  await expect.poll(async () => ((await (await page.request.get('/api/whats-new')).json()) as WhatsNewOut).seen).toContain(LAUNCH_NOTE)
  await expect(page.getByRole('dialog', { name: "What's new" })).toHaveCount(0)

  const avatar = page.getByRole('button', { name: 'User menu' })
  await avatar.click()
  await page.getByRole('navigation', { name: 'User options', exact: true }).getByRole('button', { name: "What's new", exact: true }).click()
  const dialog = page.getByRole('dialog', { name: "What's new" })
  await expect(dialog.getByRole('heading', { name: "Now we tell you what's new", level: 4 })).toBeVisible()
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await expect(avatar).toBeFocused()
})
