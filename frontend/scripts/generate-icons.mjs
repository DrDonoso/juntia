import { chromium } from '@playwright/test'
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const publicDir = resolve(dirname(fileURLToPath(import.meta.url)), '../public')
const svg = readFileSync(resolve(publicDir, 'icon.svg'), 'utf8')
mkdirSync(resolve(publicDir, 'icons'), { recursive: true })
const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 })
  for (const [name, size, maskable] of [
    ['favicon-32.png', 32, false], ['apple-touch-icon.png', 180, false],
    ['icon-192.png', 192, false], ['icon-512.png', 512, false],
    ['icon-maskable-512.png', 512, true],
  ]) {
    const opaque = maskable || name === 'apple-touch-icon.png'
    await page.setViewportSize({ width: size, height: size })
    await page.setContent(`<html><head><style>
      html,body{margin:0;width:100%;height:100%;background:${opaque ? '#123a6b' : 'transparent'}}
      body{display:grid;place-items:center}svg{width:${maskable ? '78%' : '100%'};height:${maskable ? '78%' : '100%'}}
      </style></head><body>${svg}</body></html>`)
    await page.screenshot({ path: resolve(publicDir, 'icons', name), omitBackground: !opaque })
  }
} finally {
  await browser.close()
}
