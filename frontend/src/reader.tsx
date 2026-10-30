import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, PieChart, Pie, Cell, CartesianGrid } from 'recharts'
import { api, errorMessage } from './api/client'
import type { CategoryBreakdown, DeleteImpact, ImportOut, MerchantBreakdown, SummaryOut, TransactionOut, TransactionPage } from './api/schema.gen'
import { Filters, Money, Notice, currentYearPeriod, day, expenseShare, filterRequestParams, money, useAction, useCatalog, withDefaultPeriod } from './shared'
import { TransactionDetail, TransactionTags, metadataDraft } from './transaction-metadata'
import { PrivateValue, usePrivateValues } from './privacy'
import { Icon } from './icons'
import { formatNumber, useI18n } from './i18n'

const transactionSortColumns = [
  { key: 'date', numeric: false },
  { key: 'description', numeric: false },
  { key: 'category', numeric: false },
  { key: 'amount', numeric: true },
  { key: 'balance', numeric: true },
] as const
type TransactionSort = typeof transactionSortColumns[number]['key']
function isTransactionSort(value: string | null): value is TransactionSort {
  return transactionSortColumns.some(column => column.key === value)
}
function transactionSorting(params: URLSearchParams): { sort: TransactionSort; direction: 'asc' | 'desc' } {
  const rawSort = params.get('sort')
  const sort = isTransactionSort(rawSort) ? rawSort : 'date'
  const rawDirection = params.get('direction')
  const direction = rawDirection === 'asc' || rawDirection === 'desc'
    ? rawDirection
    : rawSort === 'oldest' || sort !== 'date' ? 'asc' : 'desc'
  return { sort, direction }
}

export function Transactions({ editable = false }: { editable?: boolean }) {
  const { t } = useI18n()
  const [params, setParams] = useSearchParams()
  const requestParams = filterRequestParams(params)
  const { sort, direction } = transactionSorting(params)
  requestParams.set('sort', sort)
  requestParams.set('direction', direction)
  const [selected, setSelected] = useState<TransactionOut | null>(null)
  const categories = useCatalog('categories'), tags = useCatalog('tags')
  const query = useQuery({ queryKey: ['transactions', requestParams.toString()], queryFn: () => api<TransactionPage>(`/transactions?${requestParams}`) })
  function paginate(page: number) { setParams(previous => { const next = new URLSearchParams(previous); next.set('page', String(page)); return next }) }
  function changeSort(column: TransactionSort) {
    setParams(previous => {
      const next = new URLSearchParams(previous)
      const { sort: current, direction: currentDirection } = transactionSorting(next)
      next.set('sort', column)
      next.set('direction', current === column ? currentDirection === 'asc' ? 'desc' : 'asc' : column === 'date' ? 'desc' : 'asc')
      next.delete('page')
      return next
    }, { replace: true })
  }
  return <>
    <div className="page-heading"><div><p className="eyebrow">{t('finance.transactions.eyebrow')}</p><h1>{t('finance.transactions.title')}</h1></div></div>
    <Filters />
    {query.isPending && <Notice>{t('finance.transactions.loading')}</Notice>}
    {query.error && <Notice error>{errorMessage(query.error)}</Notice>}
    {(categories.error || tags.error) && <Notice error>{errorMessage(categories.error || tags.error)}</Notice>}
    {query.data && !query.error && <section className="card">
      <header><h2>{t('finance.transactionCount', { count: query.data.total })}</h2><span className="muted">{t('finance.transactions.amountsInEuros')}</span></header>
      {!query.data.total ? <p className="empty">{t('finance.transactions.empty')}</p> : <div className="table-scroll">
        <table className="transactions-table"><caption className="sr-only">{t('finance.transactions.caption')}</caption><thead><tr>{transactionSortColumns.map(column => {
          const active = sort === column.key
          const label = t(`finance.transactions.columns.${column.key}`)
          return <th key={column.key} scope="col" className={column.numeric ? 'numeric' : undefined} aria-label={label} aria-sort={active ? direction === 'asc' ? 'ascending' : 'descending' : 'none'}>
            <button type="button" className="table-sort-button" aria-label={t(`finance.transactions.sortBy.${column.key}`)} onClick={() => changeSort(column.key)}>
              {label}<Icon name={active ? direction === 'asc' ? 'arrow-up' : 'arrow-down' : 'sort'} size={14} />
            </button>
          </th>
        })}<th scope="col"><span className="sr-only">{t('finance.transactions.columns.details')}</span></th></tr></thead>
          <tbody>{query.data.items.map(row => <tr key={row.id}>
            <td className="nowrap">{day(row.booking_date)}</td><td className="concept"><span>{row.description}</span>{row.merchant && <small className="muted">{row.merchant}</small>}</td>
            <td><span className="badge"><i style={{ background: categories.data?.find(c => c.id === row.category_id)?.color || '#64748b' }} />{row.category_id === null ? t('finance.uncategorized') : categories.data?.find(c => c.id === row.category_id)?.name || t('finance.categoryNumber', { id: row.category_id })}</span>
              <TransactionTags value={metadataDraft(row)} available={tags.data || []} /></td>
            <td className={`numeric ${Number(row.amount) < 0 ? 'expense' : 'income'}`}><Money value={row.amount} /></td><td className="numeric"><Money value={row.balance_after} /></td>
            <td><button className="quiet" onClick={() => setSelected(row)} aria-label={t('finance.transactions.view', { date: day(row.booking_date), description: row.description })}>{editable ? t('common.edit') : t('finance.transactions.details')}</button></td>
          </tr>)}</tbody></table>
      </div>}
      <footer className="pagination"><button className="secondary" disabled={query.data.page <= 1} onClick={() => paginate(query.data!.page - 1)}>{t('common.pagination.previous')}</button>
        <span>{t('common.pagination.page', { page: query.data.page, pages: query.data.pages })}</span><button className="secondary" disabled={query.data.page >= query.data.pages} onClick={() => paginate(query.data!.page + 1)}>{t('common.pagination.next')}</button></footer>
    </section>}
    {selected && <TransactionDetail key={`${selected.id}:${selected.version}`} value={selected} editable={editable} close={() => setSelected(null)} />}
  </>
}

export function Overview() {
  const { t } = useI18n()
  const privateValues = usePrivateValues()
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const period = currentYearPeriod()
  const effective = withDefaultPeriod(params, period)
  const requestParams = filterRequestParams(effective)
  function categoryPath(categoryId: number | null) {
    const next = new URLSearchParams(effective)
    if (categoryId === null) { next.delete('category'); next.set('uncategorized', 'true') }
    else { next.set('category', String(categoryId)); next.delete('uncategorized') }
    next.set('flow', 'expense'); next.delete('page')
    return `/transactions?${next}`
  }
  function merchantPath(merchant: string) {
    const next = new URLSearchParams(effective)
    next.set('merchant_exact', merchant); next.set('flow', 'expense'); next.delete('page')
    return `/transactions?${next}`
  }
  // The server names missing categories and merchants in its own language: the browser language wins.
  function categoryName(row: CategoryBreakdown) {
    return row.category_id === null ? t('finance.uncategorized') : row.name
  }
  function merchantName(row: MerchantBreakdown) {
    return row.merchant ? row.name : t('finance.noMerchant')
  }
  const query = useQuery({ queryKey: ['summary', requestParams.toString()], queryFn: () => api<SummaryOut>(`/summary?${requestParams}`) })
  const data = query.data
  return <>
    <div className="page-heading"><div><p className="eyebrow">{t('finance.overview.eyebrow')}</p><h1>{t('finance.overview.title')}</h1>
      </div><Link className="button secondary" to={`/transactions?${effective}`}>{t('finance.overview.viewTransactions')}<Icon name="arrow-right" size={16} /></Link></div>
    <Filters defaultPeriod={period} />
    {query.isPending && <Notice>{t('finance.overview.loading')}</Notice>}
    {query.error && <Notice error>{errorMessage(query.error)}</Notice>}
    {data && !query.error && <>
      <section className="kpis" aria-label={t('finance.overview.summary')}>
        <article className="kpi hero"><span>{t('finance.overview.balance')}</span><strong><Money value={data.balance} /></strong><small>{data.balance_date ? t('finance.overview.balanceDate', { date: day(data.balance_date) }) : t('finance.overview.noStatements')}</small></article>
        <article className="kpi"><span>{t('finance.overview.income')}</span><strong className="income"><Money value={data.income} /></strong><small>{t('finance.overview.incomeHint')}</small></article>
        <article className="kpi"><span>{t('finance.overview.expense')}</span><strong className="expense"><Money value={data.expense} /></strong><small>{t('finance.overview.expenseHint')}</small></article>
        <article className="kpi"><span>{t('finance.overview.net')}</span><strong><Money value={data.net} /></strong><small>{t('finance.transactionCount', { count: data.count })}</small></article>
      </section>
      <p className="coverage">{data.coverage_end ? t('finance.overview.coverage', { date: day(data.coverage_end) }) : t('finance.overview.noData')}</p>
      {data.balance_date && data.balance === null && <Notice error>{t('finance.overview.balanceConflict')}</Notice>}
      <div className="dashboard-grid">
        <section className="card"><header><h2>{t('finance.overview.monthly.title')}</h2><span className="muted">{t('finance.overview.monthly.subtitle')}</span></header>
          {data.monthly.length ? <><div className="chart" inert={privateValues} aria-hidden={privateValues || undefined}><ResponsiveContainer width="100%" height={260}>
            <BarChart barGap={8} barCategoryGap="15%" data={data.monthly.map(row => ({ ...row, income: Number(row.income), expense: Number(row.expense) }))}>
              <CartesianGrid stroke="var(--border)" vertical={false} /><XAxis dataKey="month" /><YAxis width={70} tickFormatter={value => formatNumber(Number(value), { notation: 'compact' })} />
              <Tooltip formatter={value => money(String(value ?? 0))} /><Bar maxBarSize={40} isAnimationActive={false} dataKey="income" name={t('finance.overview.monthly.income')} fill="var(--income-fill)" radius={[4, 4, 0, 0]} /><Bar maxBarSize={40} isAnimationActive={false} dataKey="expense" name={t('finance.overview.monthly.expenses')} fill="var(--expense-fill)" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer></div><div className="table-scroll"><table><caption className="sr-only">{t('finance.overview.monthly.caption')}</caption><thead><tr><th>{t('finance.overview.monthly.month')}</th><th>{t('finance.overview.monthly.income')}</th><th>{t('finance.overview.monthly.expenses')}</th><th>{t('finance.overview.monthly.net')}</th></tr></thead><tbody>
            {data.monthly.map(row => <tr key={row.month}><td>{row.month}</td><td><Money value={row.income} /></td><td><Money value={row.expense} /></td><td className={`numeric ${Number(row.net) > 0 ? 'income' : Number(row.net) < 0 ? 'expense' : ''}`}><Money value={row.net} /></td></tr>)}
          </tbody></table></div></> : <p className="empty">{t('finance.overview.monthly.empty')}</p>}
        </section>
        <section className="card"><header><h2>{t('finance.overview.categories.title')}</h2></header>
          {data.categories.length ? <><div className="chart category-chart" aria-hidden={privateValues || undefined}><ResponsiveContainer width="100%" height={220}><PieChart accessibilityLayer={!privateValues}><Pie rootTabIndex={privateValues ? -1 : 0} isAnimationActive={false} onClick={(_, index) => navigate(categoryPath(data.categories[index].category_id))} data={data.categories.map(row => ({ ...row, name: categoryName(row), value: Number(row.amount) }))} dataKey="value" nameKey="name" innerRadius={60} outerRadius={90}>
            {data.categories.map(row => <Cell key={row.category_id ?? 'uncategorized'} fill={row.color} />)}</Pie><Tooltip formatter={value => `${money(String(value ?? 0))} · ${expenseShare(String(value ?? 0), data.expense)}`} /></PieChart></ResponsiveContainer></div>
            <ul className="breakdown">{data.categories.map(row => <li key={row.category_id ?? 'uncategorized'}><Link className="breakdown-link" to={categoryPath(row.category_id)} aria-label={row.category_id === null ? t('finance.overview.categories.viewUncategorized') : t('finance.overview.categories.view', { name: row.name })}>
              <span className="badge breakdown-label"><i style={{ background: row.color }} />{categoryName(row)}</span>
              <span className="breakdown-values"><strong><Money value={row.amount} /></strong><span className="category-share"><PrivateValue hiddenLabel={t('finance.overview.categories.hiddenShare')}>{expenseShare(row.amount, data.expense)}</PrivateValue></span></span>
            </Link></li>)}</ul>
          </> : <p className="empty">{t('finance.overview.categories.empty')}</p>}
        </section>
        <section className="card providers-card"><header><h2>{t('finance.overview.merchants.title')}</h2></header><ul className="breakdown">{data.merchants.map(row => <li key={row.merchant}><Link className="breakdown-link" to={merchantPath(row.merchant)} aria-label={row.merchant ? t('finance.overview.merchants.view', { name: row.name }) : t('finance.overview.merchants.viewNoMerchant')}><span className="breakdown-label">{merchantName(row)}</span><strong><Money value={row.amount} /></strong></Link></li>)}</ul>{!data.merchants.length && <p className="empty">{t('finance.overview.merchants.empty')}</p>}</section>
      </div>
    </>}
  </>
}

export function Statements() {
  const { t } = useI18n()
  const query = useQuery({ queryKey: ['admin', 'statements'], queryFn: () => api<ImportOut[]>('/admin/statements') })
  const action = useAction()
  return <>
    <div className="page-heading"><div><p className="eyebrow">{t('finance.statements.eyebrow')}</p><h1>{t('finance.statements.title')}</h1><p className="muted">{t('finance.statements.subtitle')}</p></div></div>
    {action.notice}{query.isPending && <Notice>{t('finance.statements.loading')}</Notice>}{query.error && <Notice error>{errorMessage(query.error)}</Notice>}
    {query.data && !query.data.length && <section className="card empty">{t('finance.statements.empty')}</section>}
    <div className="statement-list">{query.data?.map(record => <article key={record.id} className="card">
      <header><div><h2>{record.filename}</h2><p className="muted">{day(record.start_date)} — {day(record.end_date)}</p></div><span className="tag">{t('finance.statements.reconciled')}</span></header>
      <p>{[
        t('finance.transactionCount', { count: record.count }),
        t('finance.statements.inserted', { count: record.inserted }),
        t('finance.statements.duplicates', { count: record.duplicates }),
      ].join(' · ')}</p>
      <div className="statement-balances"><span>{t('finance.statements.openingBalance')} <strong>{money(record.opening_balance)}</strong></span><span>{t('finance.statements.closingBalance')} <strong>{money(record.closing_balance)}</strong></span></div>
      <footer className="inline"><a className="button secondary" href={`/api/admin/statements/${record.id}/original`}>{t('finance.statements.download')}</a>
        <button className="danger quiet" disabled={action.busy} onClick={() => void action.run(async () => {
          const impact = await api<DeleteImpact>(`/admin/statements/${record.id}/removal`)
          const question = [
            t('finance.statements.confirmDelete.removed', { count: impact.removed_transactions }),
            t('finance.statements.confirmDelete.retained', { count: impact.retained_transactions }),
            t('finance.statements.confirmDelete.question'),
          ].join(' ')
          if (window.confirm(question)) {
            await api(`/admin/statements/${record.id}`, 'DELETE', { revision: impact.revision })
          }
        })}>{t('finance.statements.delete')}</button></footer>
    </article>)}</div>
  </>
}
