import { useMemo } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { api, errorMessage } from './api/client'
import type { SearchResultsOut } from './api/schema.gen'
import { useEventConfig } from './event-time'
import { useI18n } from './i18n'
import { Icon } from './icons'
import { HitContent, hitPath, isSearchable, resultsPath, searchWords, type SearchHit, type SearchKind } from './search'
import { Notice, Pagination } from './shared'

// The results and the search they answer, which the page shows while the next ones load.
type Results = SearchResultsOut & { q: string; kind: SearchKind | null }

const KINDS: readonly SearchKind[] = ['action', 'event', 'folder', 'file', 'neighbor', 'contact', 'transaction']
// The server's search.MAX_PAGE.
const MAX_PAGE = 500

function kindParam(value: string | null): SearchKind | null {
  return KINDS.find(kind => kind === value) ?? null
}

function pageParam(value: string | null): number {
  return value && /^[1-9][0-9]{0,2}$/.test(value) ? Math.min(Number(value), MAX_PAGE) : 1
}

function FilterLink({ to, current, label, count }: { to: string; current: boolean; label: string; count: number }) {
  return <Link to={to} className="search-filter" aria-current={current ? 'page' : undefined}>
    {label} <span className="search-count">{count}</span>
  </Link>
}

function ResultList({ hits, words, zone }: { hits: readonly SearchHit[]; words: readonly string[]; zone: string | undefined }) {
  return <ul className="search-list">{hits.map(hit => <li key={`${hit.kind}:${hit.id}`}>
    <Link to={hitPath(hit)} className="search-hit"><HitContent hit={hit} words={words} zone={zone} /></Link>
  </li>)}</ul>
}

/** The best few of each kind, kind after kind, with a link to all of them when there are more. */
function Overview({ results, words, zone }: { results: Results; words: readonly string[]; zone: string | undefined }) {
  const { t } = useI18n()
  const groups: { kind: SearchKind; hits: SearchHit[] }[] = []
  for (const hit of results.items) {
    const last = groups.at(-1)
    if (last?.kind === hit.kind) last.hits.push(hit)
    else groups.push({ kind: hit.kind, hits: [hit] })
  }
  return groups.map(({ kind, hits }) => {
    const total = results.counts.find(count => count.kind === kind)?.total ?? hits.length
    return <section key={kind} className="card search-group" aria-labelledby={`search-group-${kind}`}>
      <h2 id={`search-group-${kind}`}>{t(`search.plural.${kind}`)} <span className="search-count">{total}</span></h2>
      <ResultList hits={hits} words={words} zone={zone} />
      {total > hits.length && <Link to={resultsPath(results.q, kind)} className="button secondary search-group-more">
        {t(`search.page.seeKind.${kind}`, { count: total })}<Icon name="arrow-right" size={16} />
      </Link>}
    </section>
  })
}

/**
 * Every result of a search (`/search?q=`), which the box at the top opens: the best few of each
 * kind, or every item of one kind (`kind=`), page by page (`page=`).
 */
export function SearchResultsPage() {
  const { t } = useI18n()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const q = (params.get('q') ?? '').trim()
  const kind = kindParam(params.get('kind'))
  const page = kind ? pageParam(params.get('page')) : 1
  const searchable = isSearchable(q)
  const query = useQuery({
    queryKey: ['search', 'results', q, kind, page],
    queryFn: async ({ signal }): Promise<Results> => {
      const search = new URLSearchParams({ q })
      if (kind) search.set('kind', kind)
      if (page > 1) search.set('page', String(page))
      return { ...await api<SearchResultsOut>(`/search/results?${search}`, 'GET', undefined, signal), q, kind }
    },
    enabled: searchable, placeholderData: keepPreviousData,
  })
  const results = searchable ? query.data : undefined
  const words = useMemo(() => results ? searchWords(results.q) : [], [results])
  const config = useEventConfig(Boolean(results?.items.some(hit => hit.kind === 'event')))
  const zone = config.data?.timezone
  const total = results?.counts.reduce((sum, count) => sum + count.total, 0) ?? 0
  return <>
    <div className="page-heading"><div>
      <p className="eyebrow">{t('search.page.eyebrow')}</p>
      <h1>{q ? t('search.page.title', { query: q }) : t('search.page.untitled')}</h1>
    </div></div>
    {!searchable && <Notice>{t('search.page.short')}</Notice>}
    {searchable && !results && !query.error && <Notice>{t('search.loading')}</Notice>}
    {query.error && <Notice error>{errorMessage(query.error)}</Notice>}
    {results && !results.counts.length && <Notice>{t('search.empty', { query: results.q })}</Notice>}
    {results && results.counts.length > 0 && <>
      <nav className="search-filters" aria-label={t('search.page.filters')}>
        <FilterLink to={resultsPath(q)} current={kind === null} label={t('search.page.all')} count={total} />
        {results.counts.map(count => <FilterLink key={count.kind} to={resultsPath(q, count.kind)} current={kind === count.kind}
          label={t(`search.plural.${count.kind}`)} count={count.total} />)}
      </nav>
      <div className="search-page-results" aria-busy={query.isFetching}>
        {results.kind === null ? <Overview results={results} words={words} zone={zone} /> : <>
          {results.items.length > 0
            ? <section className="card search-group" aria-label={t(`search.plural.${results.kind}`)}>
              <ResultList hits={results.items} words={words} zone={zone} />
            </section>
            : <Notice>{t('search.empty', { query: results.q })}</Notice>}
          <Pagination page={page} pages={results.pages} change={next => navigate(resultsPath(q, kind, next))}
            busy={query.isFetching} label={t('search.results')} />
        </>}
      </div>
    </>}
  </>
}
