import { test, expect, type Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import type { SummaryOut } from '../src/api/schema.gen'

async function mockDashboard(page: Page) {
  await page.clock.setFixedTime(new Date('2027-06-15T12:00:00Z'))
  const requests = { summaries: [] as URL[], transactions: [] as URL[] }
  const summary: SummaryOut = {
    income: '120.00', expense: '140.00', net: '-20.00', count: 4,
    balance: '280.00', balance_date: '2027-02-15',
    coverage_start: '2027-01-03', coverage_end: '2027-02-15',
    monthly: [
      { month: '2027-01', income: '120.00', expense: '100.00', net: '20.00' },
      { month: '2027-02', income: '0.00', expense: '40.00', net: '-40.00' },
    ],
    categories: [
      { category_id: 5, name: 'Cleaning', color: '#08735a', amount: '84.00' },
      { category_id: null, name: 'Uncategorized', color: '#64748b', amount: '56.00' },
    ],
    merchants: [
      { merchant: 'Servi & Co', name: 'Servi & Co', color: '#21639f', amount: '84.00' },
      { merchant: '', name: 'No merchant', color: '#21639f', amount: '56.00' },
    ],
    daily: [],
  }
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url())
    const path = url.pathname.replace('/api', '')
    const json = (value: unknown) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(value) })
    if (path === '/admin/auth/session') return json({ authenticated: false, username: null })
    if (path === '/auth/session') return json({ authenticated: true, kind: 'resident', name: 'Synthetic neighbor', email: 'resident@example.org', user_id: 1, dwelling_id: 1, expires_at: '2099-01-01T00:00:00Z' })
    if (path === '/settings/general') return json({ community_name: 'Synthetic community' })
    if (path === '/catalog/categories') return json([{ id: 5, name: 'Cleaning', color: '#08735a' }])
    if (path === '/catalog/tags') return json([{ id: 1, name: 'Recurring', color: '#64748b' }, { id: 2, name: 'Direct debit', color: '#64748b' }])
    if (path === '/summary') { requests.summaries.push(url); return json(summary) }
    if (path === '/transactions') { requests.transactions.push(url); return json({ items: [], total: 0, page: 1, pages: 1 }) }
    return route.abort()
  })
  return requests
}

function expectContext(url: URL) {
  expect(url.pathname).toBe('/transactions')
  expect(url.searchParams.get('start')).toBe('2026-02-01')
  expect(url.searchParams.get('end')).toBe('2026-11-30')
  expect(url.searchParams.get('q')).toBe('receipt')
  expect(url.searchParams.getAll('tag')).toEqual(['1', '2'])
  expect(url.searchParams.get('merchant')).toBe('Servi')
  expect(url.searchParams.get('minimum')).toBe('-999')
  expect(url.searchParams.get('maximum')).toBe('-1')
  expect(url.searchParams.get('flow')).toBe('expense')
  expect(url.searchParams.has('page')).toBe(false)
}

const customContext = 'start=2026-02-01&end=2026-11-30&q=receipt&tag=1&tag=2&merchant=Servi&minimum=-999&maximum=-1'

test('home opens the current year, displays actual coverage and readable monthly/category values', async ({ page }) => {
  const requests = await mockDashboard(page)
  await page.goto('/')
  await expect(page.getByLabel('From', { exact: true })).toHaveValue('2027-01-01')
  await expect(page.getByLabel('To', { exact: true })).toHaveValue('2027-12-31')
  await expect(page.locator('p.coverage')).toHaveText('Data available up to 15/02/2027.')
  expect(requests.summaries.at(-1)?.searchParams.get('start')).toBe('2027-01-01')
  await expect(page.locator('.category-share').nth(0)).toHaveText(/60\.0\s*%/)
  await expect(page.locator('.category-share').nth(1)).toHaveText(/40\.0\s*%/)
  await expect(page.locator('.page-heading p.muted')).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'Expense calendar' })).toHaveCount(0)
  const table = page.getByRole('table', { name: 'Monthly trend data' })
  await expect(table.getByRole('row').nth(1).locator('td').last()).toHaveClass(/income/)
  await expect(table.getByRole('row').nth(2).locator('td').last()).toHaveClass(/expense/)
  const income = await page.locator('.recharts-bar').nth(0).locator('.recharts-rectangle').first().boundingBox()
  const expense = await page.locator('.recharts-bar').nth(1).locator('.recharts-rectangle').first().boundingBox()
  expect(income).not.toBeNull(); expect(expense).not.toBeNull()
  expect(expense!.x - income!.x - income!.width).toBeGreaterThanOrEqual(7.9)
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
  await page.screenshot({ path: 'test-results/dashboard-refined.png', fullPage: true })
  await page.getByRole('link', { name: 'View transactions', exact: true }).click()
  expect(new URL(page.url()).searchParams.get('start')).toBe('2027-01-01')
  expect(new URL(page.url()).searchParams.get('end')).toBe('2027-12-31')
})

test('category names and donut slices preserve all home filters in transaction links', async ({ page }) => {
  await mockDashboard(page)
  await page.goto(`/?${customContext}`)
  await page.getByRole('link', { name: 'View transactions in category Cleaning', exact: true }).click()
  expectContext(new URL(page.url()))
  expect(new URL(page.url()).searchParams.get('category')).toBe('5')
  await page.goto(`/?${customContext}`)
  await page.getByRole('button', { name: 'Hide amounts', exact: true }).click()
  const sector = page.locator('.category-chart .recharts-pie-sector path').first()
  await expect(sector).toBeVisible()
  const bounds = await sector.boundingBox()
  await sector.click({ position: { x: 12, y: bounds!.height / 2 } })
  await expect(page.getByRole('heading', { name: 'Transactions', exact: true, level: 1 })).toBeVisible()
  expectContext(new URL(page.url()))
  expect(new URL(page.url()).searchParams.get('category')).toBe('5')
})

test('uncategorized and exact provider drilldowns remain visible and removable', async ({ page }) => {
  await mockDashboard(page)
  await page.goto(`/?${customContext}`)
  await page.getByRole('link', { name: 'View uncategorized transactions', exact: true }).click()
  expectContext(new URL(page.url()))
  expect(new URL(page.url()).searchParams.get('uncategorized')).toBe('true')
  await expect(page.getByRole('combobox', { name: 'Category', exact: true })).toHaveValue('uncategorized')
  await page.goto(`/?${customContext}&category=5`)
  await page.getByRole('link', { name: 'View transactions from merchant Servi & Co', exact: true }).click()
  expectContext(new URL(page.url()))
  expect(new URL(page.url()).searchParams.get('category')).toBe('5')
  expect(new URL(page.url()).searchParams.get('merchant_exact')).toBe('Servi & Co')
  await expect(page.locator('.filter-chip')).toContainText('Merchant: Servi & Co')
  await page.getByRole('button', { name: 'Remove merchant filter' }).click()
  expect(new URL(page.url()).searchParams.has('merchant_exact')).toBe(false)
  expect(new URL(page.url()).searchParams.get('merchant')).toBe('Servi')
  await page.goto('/')
  await page.getByRole('link', { name: 'View transactions without a merchant', exact: true }).click()
  expect(new URL(page.url()).searchParams.has('merchant_exact')).toBe(true)
  expect(new URL(page.url()).searchParams.get('merchant_exact')).toBe('')
})

test('open date bounds survive drilldowns and category shares respect privacy on mobile', async ({ page }) => {
  const requests = await mockDashboard(page)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')
  await page.getByLabel('From', { exact: true }).fill('')
  await expect(page.getByLabel('From', { exact: true })).toHaveValue('')
  await expect.poll(() => requests.summaries.at(-1)?.searchParams.has('start')).toBe(false)
  await page.getByRole('button', { name: 'Hide amounts', exact: true }).click()
  await expect(page.locator('.category-share .sensitive-value').first()).toHaveCSS('filter', 'blur(6px)')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
  await page.getByRole('link', { name: 'View transactions in category Cleaning', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Transactions', exact: true, level: 1 })).toBeVisible()
  expect(new URL(page.url()).searchParams.has('start')).toBe(true)
  expect(new URL(page.url()).searchParams.get('start')).toBe('')
  await expect.poll(() => requests.transactions.at(-1)?.searchParams.has('start')).toBe(false)
  expect(new URL(page.url()).searchParams.get('end')).toBe('2027-12-31')
})
