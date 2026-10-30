/**
 * Finance endpoints of the demo API (the routes ../README.md assigns to finance): the readers'
 * ledger, summary and catalogs here, the administration in ./finance-admin.ts and the statements
 * and imports in ./finance-imports.ts.
 */
import type { CatalogOut, SummaryOut, TransactionPage } from '../../api/schema.gen'
import { http, pageParam, queryChoice, route, type HttpHandler } from '../core'
import { financeStore } from '../store/finance'
import { financeAdminHandlers, kindParam } from './finance-admin'
import { financeImportHandlers } from './finance-imports'
import { SORTS, catalogOf, filterTransactions, readFilters, summaryOf, transactionPage } from './finance-queries'

const readerHandlers: HttpHandler[] = [
  http.get('/api/transactions', route('session', ({ url }): TransactionPage => {
    const filters = readFilters(url)
    const page = pageParam(url)
    const sort = queryChoice(url, 'sort', SORTS, 'date')
    const direction = url.searchParams.has('direction') ? queryChoice(url, 'direction', ['asc', 'desc'] as const, 'desc') : null
    const state = financeStore()
    return transactionPage(state, filterTransactions(state, filters), page, sort, direction)
  })),
  http.get('/api/summary', route('session', ({ url }): SummaryOut => {
    const state = financeStore()
    return summaryOf(state, filterTransactions(state, readFilters(url)))
  })),
  http.get('/api/catalog/:kind', route('session', ({ params }): CatalogOut[] => catalogOf(financeStore(), kindParam(params)))),
]

export const financeHandlers: HttpHandler[] = [...readerHandlers, ...financeAdminHandlers, ...financeImportHandlers]
