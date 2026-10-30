import { useLayoutEffect, useRef } from 'react'
import { useI18n } from '../i18n'
import { DEMO_REPOSITORY_URL } from './config'

/**
 * Persistent, slim bar at the bottom of every page: this is a demo with synthetic data that resets
 * on reload. Its height is published as `--demo-banner-height` so demo.css can keep the page's
 * footer and the sidebar clear of it.
 */
export function DemoBanner() {
  const { t } = useI18n()
  const banner = useRef<HTMLElement>(null)
  useLayoutEffect(() => {
    const element = banner.current
    if (!element) return
    const root = document.documentElement
    const publish = () => root.style.setProperty('--demo-banner-height', `${element.offsetHeight}px`)
    publish()
    const observer = new ResizeObserver(publish)
    observer.observe(element)
    return () => {
      observer.disconnect()
      root.style.removeProperty('--demo-banner-height')
    }
  }, [])
  return <aside ref={banner} className="demo-banner" aria-label={t('demo.banner.label')}>
    <p>{t('demo.banner.text')}</p>
    <a href={DEMO_REPOSITORY_URL} target="_blank" rel="noopener noreferrer" aria-label={t('demo.banner.sourceLabel')}>{t('demo.banner.source')}</a>
  </aside>
}
