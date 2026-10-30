import { test, expect, type Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import type { AIRequest, ConfirmIn, PreviewOut } from '../src/api/schema.gen'

async function mockImport(page: Page, { count = 62, initialAccount = false, failBatch = 0, holdFirstBatch = false, holdBatch = 0 } = {}) {
  const state = {
    aiRequests: [] as AIRequest[],
    confirmation: null as ConfirmIn | null,
    unexpected: [] as string[],
    accountConfirmed: !initialAccount,
  }
  let release: () => void = () => undefined
  const gate = new Promise<void>(resolve => { release = resolve })
  let preview: PreviewOut = {
    id: '00000000-0000-4000-8000-000000000001', filename: 'synthetic.pdf',
    iban: 'ES8099990001450000000001', initial_account: initialAccount,
    account_confirmed: !initialAccount, version: 1, ai_enabled: true, ai_in_progress: false,
    expires_at: '2099-01-01T00:00:00Z', committed_import_id: null,
    rows: Array.from({ length: count }, (_, ordinal) => ({
      ordinal, page: 1, booking_date: '2026-10-02', value_date: '2026-10-02',
      description: `Synthetic transaction ${ordinal}`, amount: '-10.00',
      balance_after: String(1000 + ordinal * 10), status: 'new', candidates: [],
      category_id: null, merchant: '', tags: [], classification_source: 'unclassified',
      matched_rule: null, skip_ai: false, ai_reviewed: false,
    })),
  }
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname.replace('/api', '')
    const json = (value: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) })
    if (path === '/admin/auth/session') return json({ authenticated: true, username: 'browser-test' })
    if (path === '/auth/session') return json({ authenticated: true, kind: 'administrator', name: 'browser-test', email: null, user_id: null, dwelling_id: null, expires_at: '2099-01-01T00:00:00Z' })
    if (path === '/settings/general') return json({ community_name: 'Synthetic community' })
    if (path === '/features') return json({ actions: true, coefficient: true, events: false, google_login: false })
    if (path === '/version') return json({ version: 'development', build_date: '' })
    if (path === '/account') return json(initialAccount && !state.confirmation ? null : { iban: preview.iban, name: 'Community account' })
    if (path === '/catalog/categories') return json([{ id: 1, name: 'Cleaning', color: '#08735a' }, { id: 2, name: 'Maintenance', color: '#21639f' }])
    if (path === '/catalog/tags') return json([{ id: 1, name: 'Recurring', color: '#64748b' }])
    if (path === '/admin/imports/preview') return json(preview)
    if (path === `/admin/imports/${preview.id}`) return json(preview)
    if (path === `/admin/imports/${preview.id}/account`) {
      state.accountConfirmed = true
      preview = { ...preview, account_confirmed: true, version: preview.version + 1 }
      return json(preview)
    }
    if (path === `/admin/imports/${preview.id}/ai`) {
      const body: AIRequest = route.request().postDataJSON()
      state.aiRequests.push(body)
      if (!state.accountConfirmed) return json({ code: 'account_confirmation_required' }, 409)
      if (holdFirstBatch && state.aiRequests.length === 1 || state.aiRequests.length === holdBatch) await gate
      if (state.aiRequests.length === failBatch) return json({ code: 'ai_failed' }, 502)
      const eligible = preview.rows.filter(row => !row.ai_reviewed && !body.exclude_ordinals?.includes(row.ordinal)).slice(0, 30)
      preview = {
        ...preview, version: preview.version + 1,
        rows: preview.rows.map(row => eligible.some(item => item.ordinal === row.ordinal)
          ? { ...row, ai_reviewed: true, category_id: 1, merchant: `Merchant ${row.ordinal}`, tags: [1], classification_source: 'ai' }
          : row),
      }
      return json(preview)
    }
    if (path === `/admin/imports/${preview.id}/confirm`) {
      state.confirmation = route.request().postDataJSON()
      return json({
        id: preview.id, filename: preview.filename, created_at: '2026-10-02T12:00:00Z',
        start_date: '2026-10-02', end_date: '2026-10-02', opening_balance: '1200.00',
        closing_balance: '1000.00', inserted: count, duplicates: 0, count,
      })
    }
    state.unexpected.push(path)
    return route.abort()
  })
  return { state, release }
}

async function choosePdf(page: Page) {
  await page.goto('/admin')
  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: 'Select PDF', exact: true }).click()
  await (await chooser).setFiles({
    name: 'synthetic.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-synthetic-browser-fixture'),
  })
  return page.getByRole('dialog', { name: 'Review import', exact: true })
}

test('automatic suggestions cover all batches inside an accessible review modal', async ({ page }) => {
  const mocked = await mockImport(page, { holdFirstBatch: true })
  const review = await choosePdf(page)
  await expect(review).toBeVisible()
  await expect(review.getByRole('status')).toContainText('Generating categories')
  await expect(review.locator('.loading-spinner')).toBeVisible()
  await expect(review.locator('.import-review-controls')).toBeHidden()
  await expect(review.locator('.import-review-controls')).toHaveAttribute('inert', '')
  await expect(review.locator('.import-review-controls')).toHaveAttribute('aria-busy', 'true')
  await expect(review.getByRole('combobox')).toHaveCount(0)
  await expect(review.getByRole('button', { name: 'Close', exact: true })).toBeDisabled()
  await page.keyboard.press('Tab')
  expect(await page.evaluate(() => document.activeElement?.closest('.import-review-controls') === null)).toBe(true)
  await page.keyboard.press('Escape')
  await expect(review).toBeVisible()
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
  await page.screenshot({ path: 'test-results/import-loading-desktop.png', fullPage: true })
  expect(mocked.state.confirmation).toBeNull()
  mocked.release()
  await expect(review.getByText('62 AI suggestions ready.', { exact: false })).toBeVisible()
  await expect(review.locator('.loading-spinner')).toHaveCount(0)
  await expect(review.locator('.import-review-controls')).toBeVisible()
  await expect(review.locator('.import-review-controls')).toHaveAttribute('aria-busy', 'false')
  expect(mocked.state.aiRequests).toHaveLength(3)
  expect(mocked.state.aiRequests.map(request => request.version)).toEqual([1, 2, 3])
  expect(mocked.state.aiRequests.every(request => Object.keys(request).sort().join() === 'exclude_ordinals,version')).toBe(true)
  await expect(review.getByText('Merchant 0', { exact: true })).toBeVisible()
  await expect(review.getByText('Cleaning', { exact: true }).first()).toBeVisible()
  await expect(review.getByText('Recurring', { exact: true }).first()).toBeVisible()
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
  await page.screenshot({ path: 'test-results/import-modal-desktop.png', fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  expect(await review.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
  await page.screenshot({ path: 'test-results/import-modal-mobile.png', fullPage: true })
  const row = review.locator('tbody tr').first()
  await row.getByText('Edit classification', { exact: true }).click()
  await row.getByRole('combobox', { name: 'Category', exact: true }).selectOption('2')
  await row.getByRole('textbox', { name: 'Merchant', exact: true }).fill('Manual correction')
  const tagInput = row.getByRole('combobox', { name: 'Tags', exact: true })
  await tagInput.fill('fam')
  await expect(row.getByLabel('Tag preview')).toHaveCSS('background-color', 'rgb(43, 204, 180)')
  await tagInput.press('Enter')
  await expect(row.getByRole('button', { name: 'Remove fam' })).toBeVisible()
  await review.getByRole('button', { name: 'Next', exact: true }).click()
  await review.getByRole('button', { name: 'Previous', exact: true }).click()
  await row.getByText('Edit classification', { exact: true }).click()
  await expect(row.getByRole('button', { name: 'Remove fam' })).toBeVisible()
  expect(mocked.state.confirmation).toBeNull()
  await review.getByRole('button', { name: 'Confirm and save the import' }).click()
  await expect(review).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Select PDF' })).toBeFocused()
  expect(mocked.state.confirmation?.decisions?.find(row => row.ordinal === 0)?.enrichment).toEqual({
    category_id: 2, merchant: 'Manual correction', tags: [1], new_tags: [{ name: 'fam', color: '#2bccb4' }],
  })
  expect(mocked.state.unexpected).toEqual([])
})

test('the first IBAN must be confirmed before automatic AI starts', async ({ page }) => {
  const mocked = await mockImport(page, { count: 3, initialAccount: true })
  const review = await choosePdf(page)
  await expect(review.getByRole('button', { name: 'Confirm detected account' })).toBeVisible()
  expect(mocked.state.aiRequests).toHaveLength(0)
  await review.getByLabel('I confirm that this IBAN belongs to the community account.').check()
  await review.getByRole('button', { name: 'Confirm detected account' }).click()
  await expect(review.getByText('3 AI suggestions ready.', { exact: false })).toBeVisible()
  expect(mocked.state.aiRequests).toHaveLength(1)
  expect(mocked.state.confirmation).toBeNull()
  page.once('dialog', dialog => void dialog.accept())
  await review.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(review).toHaveCount(0)
  expect(mocked.state.confirmation).toBeNull()
})

test('AI errors retain successful batches and retries preserve manual corrections', async ({ page }) => {
  const mocked = await mockImport(page, { count: 35, failBatch: 2, holdBatch: 3 })
  const review = await choosePdf(page)
  await expect(review.getByRole('alert')).toContainText('The AI could not classify')
  await expect(review.getByRole('button', { name: 'Confirm and save the import' })).toBeDisabled()
  await expect(review.getByText('Merchant 0', { exact: true })).toBeVisible()
  await review.getByRole('button', { name: 'Next', exact: true }).click()
  const row = review.locator('tbody tr').first()
  await row.getByText('Edit classification', { exact: true }).click()
  await row.getByRole('combobox', { name: 'Category', exact: true }).selectOption('2')
  await row.getByRole('combobox', { name: 'Tags', exact: true }).fill('fam')
  await row.getByRole('combobox', { name: 'Tags', exact: true }).press('Enter')
  await review.getByRole('button', { name: 'Retry pending suggestions' }).click()
  await expect(review.locator('.loading-spinner')).toBeVisible()
  await expect(review.locator('.import-review-controls')).toBeHidden()
  expect(mocked.state.confirmation).toBeNull()
  mocked.release()
  await expect(review.getByText('34 AI suggestions ready.', { exact: false })).toBeVisible()
  expect(mocked.state.aiRequests.at(-1)?.exclude_ordinals).toEqual([30])
  await expect(row.getByRole('combobox', { name: 'Category', exact: true })).toHaveValue('2')
  await review.getByRole('button', { name: 'Confirm and save the import' }).click()
  await expect(review).toHaveCount(0)
  expect(mocked.state.confirmation?.decisions?.find(row => row.ordinal === 30)?.enrichment?.category_id).toBe(2)
  expect(mocked.state.confirmation?.decisions?.find(row => row.ordinal === 30)?.enrichment?.new_tags).toEqual([{ name: 'fam', color: '#2bccb4' }])
})

test('continuing without AI requires an explicit choice after an error', async ({ page }) => {
  const mocked = await mockImport(page, { count: 3, failBatch: 1, holdFirstBatch: true })
  const review = await choosePdf(page)
  await expect(review.locator('.loading-spinner')).toBeVisible()
  mocked.release()
  await expect(review.getByRole('alert')).toBeVisible()
  await expect(review.locator('.loading-spinner')).toHaveCount(0)
  await expect(review.locator('.import-review-controls')).toBeVisible()
  await expect(review.getByRole('button', { name: 'Close', exact: true })).toBeEnabled()
  const save = review.getByRole('button', { name: 'Confirm and save the import' })
  await expect(save).toBeDisabled()
  await review.getByRole('button', { name: 'Continue with rules and manual editing' }).click()
  await expect(save).toBeEnabled()
  await save.click()
  await expect(review).toHaveCount(0)
  expect(mocked.state.aiRequests).toHaveLength(1)
  expect(mocked.state.confirmation).not.toBeNull()
})

test('loading stays blocking between AI batches on mobile and supports reduced motion', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const mocked = await mockImport(page, { count: 62, holdBatch: 2 })
  const review = await choosePdf(page)
  await expect(review.getByRole('status')).toContainText('30 of 62 transactions')
  await expect(review.locator('.loading-spinner')).toBeVisible()
  await expect(review.locator('.loading-spinner')).toHaveCSS('animation-name', 'none')
  await expect(review.locator('.import-review-controls')).toBeHidden()
  await expect(review.getByRole('button', { name: 'Close', exact: true })).toBeDisabled()
  expect(await review.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
  await page.screenshot({ path: 'test-results/import-loading-mobile.png', fullPage: true })
  mocked.release()
  await expect(review.getByText('62 AI suggestions ready.', { exact: false })).toBeVisible()
  await expect(review.locator('.loading-spinner')).toHaveCount(0)
  await expect(review.getByRole('button', { name: 'Confirm and save the import' })).toBeEnabled()
})
