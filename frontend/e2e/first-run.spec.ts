import { expect, test } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'

// A second smoke server starts without accounts, like a new installation (playwright.config.ts).
test.use({ baseURL: `http://127.0.0.1:${process.env.E2E_FIRST_RUN_PORT}` })

test('the first visitor creates the administration account and opens the administration', async ({ page }) => {
  test.skip(Boolean(process.env.E2E_BASE_URL), 'Requires a new disposable installation')
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  expect(await (await page.request.get('/api/auth/setup')).json()).toEqual({ available: true })
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Create the administration account', exact: true })).toBeVisible()
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
  await page.screenshot({ path: 'test-results/first-run.png', fullPage: true })
  const email = 'first-administrator@example.org', password = 'synthetic first administrator password'
  await page.getByLabel('Your name', { exact: true }).fill('First Administrator')
  await page.getByLabel('Email', { exact: true }).fill(email)
  await page.getByLabel('Password', { exact: true }).fill('too short')
  await page.getByLabel('Repeat password', { exact: true }).fill('too short')
  const create = page.getByRole('button', { name: 'Create the account and open the administration', exact: true })
  await create.click()
  await expect(page.getByRole('alert')).toContainText('at least 10 characters')
  await page.getByLabel('Password', { exact: true }).fill(password)
  await page.getByLabel('Repeat password', { exact: true }).fill(password)
  await create.click()
  await expect(page).toHaveURL(/\/admin$/)
  await expect(page.getByRole('heading', { name: 'Import statement', exact: true })).toBeVisible()
  expect(await (await page.request.get('/api/auth/setup')).json()).toEqual({ available: false })

  await page.getByRole('button', { name: 'User menu' }).click()
  await page.getByRole('button', { name: 'Sign out', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Create the administration account' })).toHaveCount(0)
  await page.getByLabel('Email', { exact: true }).fill(email)
  await page.getByLabel('Password', { exact: true }).fill(password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Import statement', exact: true })).toBeVisible()
  expect(errors).toEqual([])
})
