import { useId } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router'
import { api, errorMessage } from './api/client'
import type { DwellingLayout, DwellingNeighborsOut } from './api/schema.gen'
import { useReaderAuth } from './auth'
import { DwellingZoneGrid, placedDwellings, useDwellingLayout } from './dwelling-layout'
import { useI18n } from './i18n'
import { EmailContact as NeighborEmail, Notice, PhoneLink, PresidentBadge, profileInitials } from './shared'

export { EmailContact as NeighborEmail } from './shared'

function NeighborDwelling({ dwelling, currentUserId, grouped = false }: {
  dwelling: DwellingNeighborsOut; currentUserId?: number | null; grouped?: boolean
}) {
  const { t } = useI18n()
  const headingId = useId(), Heading = grouped ? 'h3' : 'h2', PersonHeading = grouped ? 'h4' : 'h3'
  return <section className="card neighbor-dwelling" aria-labelledby={headingId}>
    <header><Heading id={headingId}>{dwelling.label}</Heading><span className="tag">{t('neighbors.directory.neighborCount', { count: dwelling.neighbors.length })}</span></header>
    {dwelling.neighbors.length === 0
      ? <p className="muted">{t('neighbors.directory.noNeighbors')}</p>
      : <ul className="neighbor-list">{dwelling.neighbors.map(person => <li key={person.id}>
        <span className="profile-avatar" aria-hidden="true">{profileInitials(person.name)}</span>
        <div className="neighbor-contact"><div className="neighbor-name"><PersonHeading>{person.name}</PersonHeading>
          {person.is_president && <PresidentBadge name={person.name} />}
          {person.id === currentUserId && <span className="tag">{t('neighbors.directory.you')}</span>}</div>
          <div className="neighbor-links">
            <NeighborEmail key={person.email} email={person.email} name={person.name} />
            <PhoneLink phone={person.phone} name={person.name} />
          </div>
        </div>
      </li>)}</ul>}
  </section>
}

export function NeighborsDirectory({ dwellings, layout, currentUserId }: {
  dwellings: DwellingNeighborsOut[]; layout: DwellingLayout | null; currentUserId?: number | null
}) {
  const { t } = useI18n()
  if (layout === null) {
    return dwellings.length === 0
      ? <section className="card"><p className="empty">{t('neighbors.directory.empty')}</p></section>
      : <div className="neighbor-grid">{dwellings.map(dwelling => <NeighborDwelling key={dwelling.id} dwelling={dwelling} currentUserId={currentUserId} />)}</div>
  }
  const byId = new Map(dwellings.map(dwelling => [dwelling.id, dwelling]))
  const placed = placedDwellings(layout)
  const unplaced = dwellings.filter(dwelling => !placed.has(dwelling.id))
  return <div className="neighbor-layout">
    {layout.zones.map(zone => <section className="dwelling-layout-zone" key={zone.id} aria-label={zone.name}>
      <h2>{zone.name}</h2>
      <DwellingZoneGrid zone={zone} showRowNames={layout.show_row_names} showColumnNames={layout.show_column_names} renderCell={(_position, id) => {
        if (id === null) return <span className="dwelling-layout-space" aria-hidden="true" />
        const dwelling = byId.get(id)
        return dwelling ? <NeighborDwelling dwelling={dwelling} currentUserId={currentUserId} grouped />
          : <Notice error>{t('neighbors.directory.missingDwelling')}</Notice>
      }} />
    </section>)}
    {unplaced.length > 0 && <section aria-label={t('neighbors.directory.otherDwellings')}><h2>{t('neighbors.directory.otherDwellings')}</h2>
      <div className="neighbor-grid">{unplaced.map(dwelling => <NeighborDwelling key={dwelling.id} dwelling={dwelling} currentUserId={currentUserId} grouped />)}</div>
    </section>}
    {dwellings.length === 0 && <Notice>{t('neighbors.directory.empty')}</Notice>}
  </div>
}

export function NeighborsPage() {
  const { t } = useI18n()
  const session = useReaderAuth()
  const layoutQuery = useDwellingLayout()
  const query = useQuery({
    queryKey: ['neighbors'], queryFn: () => api<DwellingNeighborsOut[]>('/neighbors'),
  })
  return <><div className="page-heading"><div><p className="eyebrow">{t('neighbors.page.eyebrow')}</p><h1>{t('neighbors.page.title')}</h1>
    <p className="muted">{t('neighbors.page.description')}</p></div>
    {session.data?.kind === 'resident' && <Link to="/profile" className="button secondary">{t('neighbors.page.updatePhone')}</Link>}
  </div>
    {(query.isPending || layoutQuery.isPending) && <Notice>{t('neighbors.page.loading')}</Notice>}
    {query.error && <Notice error>{errorMessage(query.error)}</Notice>}
    {layoutQuery.error && <Notice error>{errorMessage(layoutQuery.error)}</Notice>}
    {query.data && layoutQuery.data && <NeighborsDirectory dwellings={query.data} layout={layoutQuery.data.layout} currentUserId={session.data?.user_id} />}
  </>
}
