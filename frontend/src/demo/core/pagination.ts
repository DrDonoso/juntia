/**
 * Paginated answers in the backend's shape (`ActionPage`, `ContactPage`, `TransactionPage`…):
 * `pages` is at least 1, and a page after the last one is empty rather than an error. Page sizes
 * are per route, like the backend's: transactions and contacts 50, actions, labels and events 20.
 */
export interface Page<T> {
  items: T[]
  page: number
  pages: number
  total: number
}

export function pageCount(total: number, size: number): number {
  return Math.max(1, Math.ceil(total / size))
}

/** The `page` (1-based) of `items`, `size` per page. */
export function paginate<T>(items: readonly T[], page: number, size: number): Page<T> {
  return {
    items: items.slice((page - 1) * size, page * size),
    page,
    pages: pageCount(items.length, size),
    total: items.length,
  }
}
