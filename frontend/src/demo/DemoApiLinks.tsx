import { useEffect } from 'react'

/** File name of a `Content-Disposition` header (`filename*=UTF-8''…` first), if any. */
export function dispositionFilename(header: string | null): string | null {
  if (!header) return null
  const encoded = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(header)
  if (encoded) {
    try {
      return decodeURIComponent(encoded[1].trim())
    } catch {
      // Malformed encoding: fall back to the plain name.
    }
  }
  const plain = /filename\s*=\s*"([^"]*)"|filename\s*=\s*([^;]+)/i.exec(header)
  const name = plain ? (plain[1] ?? plain[2]).trim() : ''
  return name || null
}

/** The same-origin link to an /api file that a click landed on, if any. */
function apiLink(event: MouseEvent): { link: HTMLAnchorElement; url: URL } | null {
  if (event.defaultPrevented || (event.button !== 0 && event.button !== 1)) return null
  const link = event.target instanceof Element ? event.target.closest('a[href]') : null
  if (!(link instanceof HTMLAnchorElement)) return null
  const url = new URL(link.href, window.location.href)
  return url.origin === window.location.origin && url.pathname.startsWith('/api/') ? { link, url } : null
}

function download(href: string, filename: string): void {
  const anchor = document.createElement('a')
  anchor.href = href
  anchor.download = filename
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
}

/**
 * Plain links to API files (a statement's original PDF, an action's PDF preview) make the browser
 * navigate, and navigations do not go through the demo's service worker: the static host would
 * answer with the app instead of the file, and leaving the page would restart the demo. A click on
 * such a link fetches the file through the demo API instead, then opens it in a new tab (links with
 * `target="_blank"`, middle or modified clicks) or downloads it.
 */
export function DemoApiLinks() {
  useEffect(() => {
    function intercept(event: MouseEvent) {
      const found = apiLink(event)
      if (!found) return
      event.preventDefault()
      const newTab = found.link.target === '_blank' || event.button === 1 || event.ctrlKey || event.metaKey || event.shiftKey
      // Opened during the click, or the browser would block it as a popup.
      const tab = newTab ? window.open('', '_blank') : null
      if (tab) tab.opener = null
      void fetch(found.url, { credentials: 'same-origin' }).then(async response => {
        if (!response.ok) throw new Error(`The demo answered ${response.status}`)
        const file = URL.createObjectURL(await response.blob())
        if (tab) tab.location.href = file
        else download(file, dispositionFilename(response.headers.get('Content-Disposition')) ?? found.url.pathname.split('/').pop() ?? 'download')
        window.setTimeout(() => URL.revokeObjectURL(file), 60_000)
      }).catch((error: unknown) => {
        tab?.close()
        console.error(`[demo] ${found.url.pathname} could not be opened:`, error)
      })
    }
    document.addEventListener('click', intercept, true)
    document.addEventListener('auxclick', intercept, true)
    return () => {
      document.removeEventListener('click', intercept, true)
      document.removeEventListener('auxclick', intercept, true)
    }
  }, [])
  return null
}
