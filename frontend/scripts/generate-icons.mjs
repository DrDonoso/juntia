import { chromium } from '@playwright/test'
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const publicDir = resolve(dirname(fileURLToPath(import.meta.url)), '../public')
const svg = readFileSync(resolve(publicDir, 'icon.svg'), 'utf8')
// Android's status bar shows the badge of push notifications as a silhouette: the buildings and the
// arc of the icon in white on transparent, with the windows cut out.
const badge = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="8 8 48 48">
  <mask id="windows"><rect width="64" height="64" fill="#fff"/>
    <path d="M17 30h2m-2 6h2m12-14h2m-2 7h2m-2 7h2m12-3h2m-2 6h2" stroke="#000" stroke-width="2.5" stroke-linecap="round"/></mask>
  <g fill="#fff" mask="url(#windows)"><path d="M13 27 23 21v23H13Zm14-9 10-5v31H27Z"/><path d="m41 23 10 6v15H41Z"/></g>
  <path d="M13 49c11 7 27 7 38 0" fill="none" stroke="#fff" stroke-width="3.5" stroke-linecap="round"/>
</svg>`
mkdirSync(resolve(publicDir, 'icons'), { recursive: true })
const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 })
  for (const [name, size, maskable, image = svg] of [
    ['favicon-32.png', 32, false], ['apple-touch-icon.png', 180, false],
    ['icon-192.png', 192, false], ['icon-512.png', 512, false],
    ['icon-maskable-512.png', 512, true], ['badge-96.png', 96, false, badge],
  ]) {
    const opaque = maskable || name === 'apple-touch-icon.png'
    await page.setViewportSize({ width: size, height: size })
    await page.setContent(`<html><head><style>
      html,body{margin:0;width:100%;height:100%;background:${opaque ? '#123a6b' : 'transparent'}}
      body{display:grid;place-items:center}svg{width:${maskable ? '78%' : '100%'};height:${maskable ? '78%' : '100%'}}
      </style></head><body>${image}</body></html>`)
    await page.screenshot({ path: resolve(publicDir, 'icons', name), omitBackground: !opaque })
  }
} finally {
  await browser.close()
}
