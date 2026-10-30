import { useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { api, cache, clearPrivateData } from '../api/client'
import type { AuthOut, UserAuthOut } from '../api/schema.gen'
import { useReaderAuth } from '../auth'
import { useI18n } from '../i18n'
import { Modal, useAction, useGeneralSettings } from '../shared'
import { DEMO_ADMIN_USERNAME, DEMO_PASSWORD } from './config'

let welcomed = false

/** Shows the welcome dialog again, as a page reload does (tests). */
export function resetDemoWelcome(): void {
  welcomed = false
}

const isAdminPath = (pathname: string) => pathname === '/admin' || pathname.startsWith('/admin/')

/** The welcome dialog, once per page load. */
export function DemoWelcome() {
  const [open, setOpen] = useState(false)
  // Decided after the first commit: React may render and discard a component more than once.
  useEffect(() => {
    if (welcomed) return
    welcomed = true
    setOpen(true)
  }, [])
  return open ? <WelcomeDialog close={() => setOpen(false)} /> : null
}

/**
 * What the demo is, that its data is synthetic and resets on reload, and two ways in. "Open
 * administration" signs the demo administrator in exactly like the /admin sign-in form does.
 */
function WelcomeDialog({ close }: { close: () => void }) {
  const { t } = useI18n()
  const navigate = useNavigate(), location = useLocation()
  const reader = useReaderAuth(), general = useGeneralSettings()
  const action = useAction()
  const resident = reader.data?.kind === 'resident' ? reader.data.name : null
  function explore() {
    close()
    if (isAdminPath(location.pathname)) navigate('/')
  }
  function openAdministration() {
    void action.run(async () => {
      const result = await api<AuthOut>('/admin/auth/login', 'POST', { username: DEMO_ADMIN_USERNAME, password: DEMO_PASSWORD })
      await clearPrivateData(true)
      cache.setQueryData(['reader-auth'], await api<UserAuthOut>('/auth/session'))
      cache.setQueryData(['auth'], result)
      close()
      navigate(isAdminPath(location.pathname) ? location.pathname + location.search : '/admin')
    })
  }
  return <Modal title={t('demo.welcome.title')} close={close} disabled={action.busy} className="demo-welcome">
    <p>{t('demo.welcome.intro')}</p>
    <p>{t('demo.welcome.data')}</p>
    {resident && general.data && <p>{t('demo.welcome.signedIn', { name: resident, community: general.data.community_name })}</p>}
    {action.notice}
    <div className="demo-welcome-actions">
      <button type="button" disabled={action.busy} onClick={explore}>{t('demo.welcome.neighbor')}</button>
      <button type="button" className="secondary" disabled={action.busy} onClick={openAdministration}>
        {action.busy ? t('demo.welcome.openingAdmin') : t('demo.welcome.admin')}
      </button>
    </div>
  </Modal>
}
