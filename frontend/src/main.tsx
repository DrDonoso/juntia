import { Component, Suspense, lazy, useEffect, useRef, useState, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter, Navigate, NavLink, Outlet, Route, Routes, useLocation } from 'react-router'
import { api, cache, clearPrivateData, errorMessage, signedOut } from './api/client'
import { ForgotPassword, LoginNoticeProvider, PasswordLink, ReaderGate, ResidentLogin, useAdminAuth, useReaderAuth, useSessionLifecycle } from './auth'
import { Notice, profileInitials, useAction, useFeatureLifecycle, useFeatures, useGeneralSettings } from './shared'
import { Icon } from './icons'
import { PrivacyContext, storedPrivacy } from './privacy'
import { I18nRoot, LanguageSelect, useI18n } from './i18n'
import './styles/app.css'

const Overview = lazy(() => import('./reader').then(m => ({ default: m.Overview })))
const Transactions = lazy(() => import('./reader').then(m => ({ default: m.Transactions })))
const Statements = lazy(() => import('./reader').then(m => ({ default: m.Statements })))
const Login = lazy(() => import('./admin').then(m => ({ default: m.Login })))
const ImportPage = lazy(() => import('./admin').then(m => ({ default: m.ImportPage })))
const RulesPage = lazy(() => import('./admin').then(m => ({ default: m.RulesPage })))
const CatalogPage = lazy(() => import('./admin').then(m => ({ default: m.CatalogPage })))
const CommunityLabelsPage = lazy(() => import('./community-labels').then(m => ({ default: m.CommunityLabelsPage })))
const StoragePage = lazy(() => import('./storage').then(m => ({ default: m.StoragePage })))
const GeneralPage = lazy(() => import('./admin').then(m => ({ default: m.GeneralPage })))
const FeaturesPage = lazy(() => import('./admin').then(m => ({ default: m.FeaturesPage })))
const UsersPage = lazy(() => import('./users').then(m => ({ default: m.UsersPage })))
const DwellingsPage = lazy(() => import('./users').then(m => ({ default: m.DwellingsPage })))
const ProfilePage = lazy(() => import('./profile').then(m => ({ default: m.ProfilePage })))
const NeighborsPage = lazy(() => import('./neighbors').then(m => ({ default: m.NeighborsPage })))
const ContactsPage = lazy(() => import('./contacts').then(m => ({ default: m.ContactsPage })))
const ActionsPage = lazy(() => import('./community-actions').then(m => ({ default: m.ActionsPage })))
const ActionDetailPage = lazy(() => import('./community-actions').then(m => ({ default: m.ActionDetailPage })))
const EventsPage = lazy(() => import('./community-events').then(m => ({ default: m.EventsPage })))
const EventDetailPage = lazy(() => import('./community-events').then(m => ({ default: m.EventDetailPage })))
// The public demo's banner, welcome dialog and sign-in help (src/demo). The literal
// `import.meta.env.VITE_DEMO` check lets the bundler drop the demo from normal builds.
const DemoChrome = import.meta.env.VITE_DEMO === '1' ? lazy(() => import('./demo/DemoChrome')) : null
function BoundaryFallback() {
  const { t } = useI18n()
  return <section className="card"><h1>{t('shell.crash.title')}</h1><p>{t('shell.crash.description')}</p><button onClick={() => location.reload()}>{t('shell.crash.reload')}</button></section>
}
class Boundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  componentDidCatch(error: Error) { console.error('Application rendering failed:', error.name) }
  render() {
    return this.state.failed ? <BoundaryFallback /> : this.props.children
  }
}
function NavigationGroup({ title, children }: { title: string; children: ReactNode }) {
  return <div className="nav-group" role="group" aria-label={title}>
    <span className="nav-group-label" aria-hidden="true">{title}</span>
    <div className="nav-group-links">{children}</div>
  </div>
}
const compactNavigationQuery = '(max-width: 720px)'
function storedSidebarCollapsed() {
  try { return localStorage.getItem('juntia_sidebar_collapsed') === '1' }
  catch { console.warn('Sidebar preference could not be read.'); return false }
}
export function Shell() {
  const { t } = useI18n()
  const auth = useAdminAuth(), reader = useReaderAuth(), action = useAction()
  useSessionLifecycle(reader.data, auth.data?.authenticated)
  const general = useGeneralSettings()
  const features = useFeatures(true)
  useFeatureLifecycle(features.data)
  const actionsEnabled = features.data?.actions === true && !features.error
  const eventsEnabled = features.data?.events === true && !features.error
  const location = useLocation()
  const isAdmin = location.pathname === '/admin' || location.pathname.startsWith('/admin/')
  const isFinanceView = location.pathname === '/' || location.pathname === '/transactions'
  const isContactsView = location.pathname === '/contacts'
  const isActionView = /^\/actions(?:\/[1-9][0-9]*)?$/.test(location.pathname)
  const isEventView = /^\/events(?:\/[1-9][0-9]*)?$/.test(location.pathname)
  const communityName = general.data?.community_name || t('shell.defaultCommunityName')
  const [theme, setTheme] = useState(document.documentElement.dataset.theme || 'light')
  const [hideValues, setHideValues] = useState(storedPrivacy)
  const [compactNavigation, setCompactNavigation] = useState(() => window.matchMedia(compactNavigationQuery).matches)
  const [desktopCollapsed, setDesktopCollapsed] = useState(storedSidebarCollapsed)
  const [openMenu, setOpenMenu] = useState<'navigation' | 'user' | null>(null)
  const sidebar = useRef<HTMLElement>(null), navigationButton = useRef<HTMLButtonElement>(null)
  const userMenu = useRef<HTMLElement>(null), userButton = useRef<HTMLButtonElement>(null)
  const sidebarExpanded = compactNavigation ? openMenu === 'navigation' : !desktopCollapsed
  const privateValues = isFinanceView && hideValues
  useEffect(() => {
    document.title = communityName
    document.querySelector('meta[name="apple-mobile-web-app-title"]')?.setAttribute('content', communityName)
  }, [communityName])
  useEffect(() => {
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#0c1420' : '#f4f6f9')
  }, [theme])
  useEffect(() => {
    setOpenMenu(null)
  }, [location, auth.data?.authenticated, reader.data?.authenticated])
  useEffect(() => {
    const query = window.matchMedia(compactNavigationQuery)
    function resize() {
      if (sidebar.current?.contains(document.activeElement)) navigationButton.current?.focus()
      if (userMenu.current?.contains(document.activeElement)) userButton.current?.focus()
      setCompactNavigation(query.matches)
      setOpenMenu(null)
    }
    query.addEventListener('change', resize)
    return () => query.removeEventListener('change', resize)
  }, [])
  useEffect(() => {
    if (!openMenu) return
    const panel = openMenu === 'navigation' ? sidebar.current : userMenu.current
    const trigger = openMenu === 'navigation' ? navigationButton.current : userButton.current
    panel?.querySelector<HTMLElement>(openMenu === 'navigation' ? 'nav a, .sidebar-return' : 'a, button')?.focus()
    function dismiss(event: PointerEvent | FocusEvent) {
      if (event.target instanceof Node && !panel?.contains(event.target) && !trigger?.contains(event.target)) setOpenMenu(null)
    }
    function escape(event: KeyboardEvent) {
      if (event.key !== 'Escape') return
      event.preventDefault()
      setOpenMenu(null)
      trigger?.focus()
    }
    document.addEventListener('pointerdown', dismiss)
    document.addEventListener('focusin', dismiss)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('pointerdown', dismiss)
      document.removeEventListener('focusin', dismiss)
      document.removeEventListener('keydown', escape)
    }
  }, [openMenu])
  function toggleNavigation() {
    if (compactNavigation) {
      setOpenMenu(previous => previous === 'navigation' ? null : 'navigation')
      return
    }
    setOpenMenu(null)
    const next = !desktopCollapsed
    setDesktopCollapsed(next)
    try { localStorage.setItem('juntia_sidebar_collapsed', next ? '1' : '0') }
    catch { console.warn('Sidebar preference could not be stored.') }
  }
  function closeMenu() {
    setOpenMenu(null)
    document.getElementById('content')?.focus()
  }
  function logout() {
    closeMenu()
    void action.run(async () => {
      await api('/auth/logout', 'POST'); await clearPrivateData(true)
      cache.setQueryData(['auth'], { authenticated: false, username: null }); cache.setQueryData(['reader-auth'], signedOut)
    })
  }
  function toggleTheme() {
    const next = theme === 'dark' ? 'light' : 'dark'
    setTheme(next); document.documentElement.dataset.theme = next
    try { localStorage.setItem('juntia_theme', next) }
    catch { console.warn('Theme preference could not be stored.') }
  }
  function togglePrivacy() {
    const next = !hideValues
    setHideValues(next)
    try { localStorage.setItem('juntia_hide_values', next ? '1' : '0') }
    catch { console.warn('Privacy preference could not be stored.') }
  }
  return <PrivacyContext value={privateValues}><a className="skip-link" href="#content">{t('shell.skipToContent')}</a>
    <header className="topbar">
      <button ref={navigationButton} type="button" className="quiet icon-button navigation-toggle" title={t('shell.navigationMenu')} aria-label={t('shell.navigationMenu')} aria-controls="site-navigation" aria-expanded={sidebarExpanded} onClick={toggleNavigation}><Icon name={compactNavigation && sidebarExpanded ? 'close' : 'menu'} /></button>
      <span className="community-title" title={communityName}>{communityName}</span>
      <div className="topbar-actions">
        {isFinanceView && reader.data?.authenticated && <button className="quiet icon-button" title={hideValues ? t('shell.showAmounts') : t('shell.hideAmounts')} aria-label={hideValues ? t('shell.showAmounts') : t('shell.hideAmounts')} aria-pressed={hideValues} onClick={togglePrivacy}><Icon name={hideValues ? 'eye-off' : 'eye'} /></button>}
        <button className="quiet icon-button" title={theme === 'dark' ? t('shell.lightMode') : t('shell.darkMode')} aria-label={theme === 'dark' ? t('shell.lightMode') : t('shell.darkMode')} aria-pressed={theme === 'dark'} onClick={toggleTheme}><Icon name={theme === 'dark' ? 'sun' : 'moon'} /></button>
        {(auth.data?.authenticated || reader.data?.authenticated) && <div className="user-controls">
          <button ref={userButton} type="button" className="quiet icon-button profile-button" title={t('shell.userMenu')} aria-label={t('shell.userMenu')} aria-controls="user-menu" aria-expanded={openMenu === 'user'} onClick={() => setOpenMenu(previous => previous === 'user' ? null : 'user')}>
            <span className="profile-avatar" aria-hidden="true">{profileInitials(reader.data?.name || auth.data?.username || t('shell.defaultUserName'))}</span>
          </button>
          <nav ref={userMenu} id="user-menu" className="user-menu" aria-label={t('shell.userOptions')} hidden={openMenu !== 'user'}>
            {reader.data?.authenticated && <NavLink to="/profile" onClick={closeMenu}>{t('shell.myProfile')}</NavLink>}
            <LanguageSelect className="user-menu-language" />
            <button type="button" className="quiet" disabled={action.busy} onClick={logout}>{t('shell.signOut')}</button>
          </nav>
        </div>}
      </div>
    </header>
    {compactNavigation && openMenu === 'navigation' && <div className="sidebar-backdrop" aria-hidden="true" />}
    <aside ref={sidebar} id="site-navigation" className={`sidebar${sidebarExpanded ? '' : ' sidebar-closed'}`} inert={!sidebarExpanded} aria-hidden={!sidebarExpanded} onClick={event => {
      if (openMenu === 'navigation' && event.target instanceof Element && event.target.closest('a')) closeMenu()
    }}><NavLink to={isAdmin ? '/admin' : '/'} className="brand"><img src="/icon.svg" alt="" width="38" height="38" /><span>Juntia<strong>{t('shell.brandTagline')}</strong></span></NavLink>
      <span className="nav-label">{isAdmin ? t('shell.adminLabel') : t('shell.portalLabel')}</span>
      {isAdmin ? <>
        {auth.data?.authenticated && <nav aria-label={t('shell.navigation.admin')}>
          <NavigationGroup title={t('shell.groups.finances')}>
            <NavLink to="/admin" end><Icon name="upload" />{t('shell.links.import')}</NavLink>
            <NavLink to="/admin/transactions"><Icon name="receipt" />{t('shell.links.classifyTransactions')}</NavLink>
            <NavLink to="/admin/rules"><Icon name="refresh" />{t('shell.links.rules')}</NavLink>
            <NavLink to="/admin/catalog"><Icon name="tag" />{t('shell.links.catalog')}</NavLink>
            <NavLink to="/admin/statements"><Icon name="file-text" />{t('shell.links.statements')}</NavLink>
          </NavigationGroup>
          <NavigationGroup title={t('shell.groups.settings')}>
            <NavLink to="/admin/general"><Icon name="settings" />{t('shell.links.general')}</NavLink>
            <NavLink to="/admin/features"><Icon name="settings" />{t('shell.links.features')}</NavLink>
            <NavLink to="/admin/dwellings"><Icon name="home" />{t('shell.links.dwellings')}</NavLink>
            <NavLink to="/admin/users"><Icon name="user" />{t('shell.links.users')}</NavLink>
            <NavLink to="/admin/labels"><Icon name="tag" />{t('shell.links.communityLabels')}</NavLink>
            <NavLink to="/admin/deleted-contacts"><Icon name="file-text" />{t('shell.links.deletedContacts')}</NavLink>
            <NavLink to="/admin/storage"><Icon name="dashboard" />{t('shell.links.storage')}</NavLink>
          </NavigationGroup>
        </nav>}
      </> : reader.data?.authenticated && <nav aria-label={t('shell.navigation.main')}>
        <NavigationGroup title={t('shell.groups.finances')}>
          <NavLink to="/" end><Icon name="dashboard" />{t('shell.links.overview')}</NavLink>
          <NavLink to="/transactions"><Icon name="receipt" />{t('shell.links.transactions')}</NavLink>
        </NavigationGroup>
        {(actionsEnabled || eventsEnabled) && <NavigationGroup title={t('shell.groups.management')}>
          {actionsEnabled && <NavLink to="/actions"><Icon name="check" />{t('shell.links.actions')}</NavLink>}
          {eventsEnabled && <NavLink to="/events"><Icon name="calendar" />{t('shell.links.events')}</NavLink>}
        </NavigationGroup>}
        <NavigationGroup title={t('shell.groups.community')}>
          <NavLink to="/neighbors"><Icon name="user" />{t('shell.links.neighbors')}</NavLink>
          <NavLink to="/contacts"><Icon name="mail" />{t('shell.links.contacts')}</NavLink>
        </NavigationGroup>
      </nav>}
      {isAdmin && <div className="sidebar-footer">
        <NavLink to="/" className="sidebar-return"><Icon name="arrow-left" size={16} />{t('shell.links.communityPortal')}</NavLink>
      </div>}
    </aside>
    <div className={`workspace${desktopCollapsed ? ' desktop-collapsed' : ''}`} data-private-values={privateValues || undefined}>
      <main id="content" tabIndex={-1}>{action.notice}{general.error && <Notice error>{errorMessage(general.error)}</Notice>}{features.error && <Notice error>{errorMessage(features.error)}</Notice>}<Boundary><Suspense fallback={<Notice>{t('shell.loadingPage')}</Notice>}><Outlet /></Suspense></Boundary></main>
      <footer className="app-footer">{isAdmin ? t('shell.footer.admin') : isEventView ? t('shell.footer.events') : isContactsView ? t('shell.footer.contacts') : isActionView ? t('shell.footer.actions') : t('shell.footer.finances')}</footer>
    </div>
  </PrivacyContext>
}
function AdminGate() {
  const { t } = useI18n()
  const query = useAdminAuth(), reader = useReaderAuth()
  if (query.isPending) return <Notice>{t('auth.checkingSession')}</Notice>
  if (query.error) return <Notice error>{errorMessage(query.error)}</Notice>
  if (!query.data?.authenticated) return <Login />
  if (reader.error) return <Notice error>{errorMessage(reader.error)}</Notice>
  if (reader.data?.kind !== 'administrator') return <Notice>{t('auth.checkingSession')}</Notice>
  return <Outlet />
}

function LegacyCommunityRedirect() {
  const location = useLocation(), params = new URLSearchParams(location.search)
  const deleted = location.pathname === '/admin/contacts' && params.get('deleted') === '1'
  if (location.pathname === '/admin/contacts') params.delete('deleted')
  return <Navigate replace to={{
    pathname: deleted ? '/admin/deleted-contacts' : location.pathname.replace(/^\/admin/, ''),
    search: params.toString(), hash: location.hash,
  }} />
}

function NotFound() {
  const { t } = useI18n()
  return <Notice error>{t('shell.notFound')}</Notice>
}

// Subscribing here re-renders the whole tree on a language switch, so plain formatters follow it too.
function App() {
  useI18n()
  return <I18nRoot><QueryClientProvider client={cache}><LoginNoticeProvider><BrowserRouter><Routes><Route element={<Shell />}>
    <Route path="login" element={<ResidentLogin />} />
    <Route path="forgot-password" element={<ForgotPassword />} />
    <Route path="activate" element={<PasswordLink key="invitation" invitation />} />
    <Route path="reset-password" element={<PasswordLink key="recovery" invitation={false} />} />
    <Route element={<ReaderGate />}><Route index element={<Overview />} /><Route path="transactions" element={<Transactions />} /><Route path="profile" element={<ProfilePage />} /><Route path="neighbors" element={<NeighborsPage />} /></Route>
    <Route element={<ReaderGate />}><Route path="actions" element={<ActionsPage />} /><Route path="actions/:itemId" element={<ActionDetailPage />} /></Route>
    <Route element={<ReaderGate />}><Route path="contacts" element={<ContactsPage />} /></Route>
    <Route element={<ReaderGate />}><Route path="events" element={<EventsPage />} /><Route path="events/:eventId" element={<EventDetailPage />} /></Route>
    <Route path="admin" element={<AdminGate />}><Route index element={<ImportPage />} />
      <Route path="general" element={<GeneralPage />} />
      <Route path="features" element={<FeaturesPage />} />
      <Route path="users" element={<UsersPage />} /><Route path="dwellings" element={<DwellingsPage />} />
      <Route path="labels" element={<CommunityLabelsPage />} />
      <Route path="deleted-contacts" element={<ContactsPage deleted />} />
      <Route path="storage" element={<StoragePage />} />
      <Route path="neighbors" element={<LegacyCommunityRedirect />} />
      <Route path="contacts" element={<LegacyCommunityRedirect />} />
      <Route path="actions" element={<LegacyCommunityRedirect />} /><Route path="actions/:itemId" element={<LegacyCommunityRedirect />} />
      <Route path="transactions" element={<Transactions editable />} /><Route path="rules" element={<RulesPage />} />
      <Route path="catalog" element={<CatalogPage />} /><Route path="statements" element={<Statements />} />
    </Route><Route path="*" element={<NotFound />} />
  </Route></Routes>{DemoChrome && <Suspense fallback={null}><DemoChrome /></Suspense>}</BrowserRouter></LoginNoticeProvider></QueryClientProvider></I18nRoot>
}

const container = document.getElementById('root')
const render = (root: HTMLElement) => createRoot(root).render(<App />)
// The public demo (`vite build --mode demo`) answers /api in the browser: its service worker must
// run before the app's first request. The literal check lets the bundler drop the demo (and MSW).
if (container && import.meta.env.VITE_DEMO === '1') {
  void import('./demo/browser').then(({ startDemo }) => startDemo(container)).then(
    started => { if (started) render(container) },
    (error: unknown) => console.error('The demo could not start:', error),
  )
} else if (container) render(container)
