import { useEffect } from 'react'
import { DemoApiLinks } from './DemoApiLinks'
import { DemoBanner } from './DemoBanner'
import { DemoSignInNotice } from './DemoSignInNotice'
import { DemoWelcome } from './DemoWelcome'
import './demo.css'

/**
 * Everything the public demo adds to the app's screens: the banner, the welcome dialog, the
 * sign-in help, and links to API files served through the demo API. main.tsx mounts it inside
 * the router, only in the demo build.
 */
export default function DemoChrome() {
  useEffect(() => {
    const root = document.documentElement
    root.dataset.demo = 'true'
    return () => {
      delete root.dataset.demo
    }
  }, [])
  return <>
    <DemoBanner />
    <DemoWelcome />
    <DemoSignInNotice />
    <DemoApiLinks />
  </>
}
