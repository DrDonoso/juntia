/**
 * Starts the demo's API: the Mock Service Worker (public/mockServiceWorker.js) with every handler.
 * main.tsx awaits it before the first render, because the app requests /api/auth/session at once
 * and a request that escaped the worker would reach the static host and get index.html back.
 */
import { setupWorker } from 'msw/browser'
import { getLanguage, t } from '../i18n'
import { handlers } from './handlers'
import './demo.css'

/** Plain DOM (React never mounted): the demo cannot run without its service worker. */
function showStartError(root: HTMLElement): void {
  document.documentElement.lang = getLanguage()
  const box = document.createElement('section')
  box.className = 'card demo-start-error'
  box.setAttribute('role', 'alert')
  const title = document.createElement('h1')
  title.textContent = t('demo.startError.title')
  const text = document.createElement('p')
  text.textContent = t('demo.startError.description')
  box.append(title, text)
  root.replaceChildren(box)
}

/**
 * Registers the worker and resolves true once it answers the API; without service workers (an
 * insecure origin, some private windows) it shows a translated explanation and resolves false.
 */
export async function startDemo(root: HTMLElement): Promise<boolean> {
  try {
    if (!('serviceWorker' in navigator)) throw new Error('Service workers are not available in this browser context')
    await setupWorker(...handlers).start({
      serviceWorker: { url: '/mockServiceWorker.js' },
      quiet: true,
      // Scripts, styles, fonts and icons come from the static host; /api never gets here (catch-all).
      onUnhandledRequest: 'bypass',
    })
    return true
  } catch (error) {
    console.error('The demo API could not start:', error)
    showStartError(root)
    return false
  }
}
