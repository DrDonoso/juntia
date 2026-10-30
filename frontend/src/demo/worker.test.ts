import mswPackage from 'msw/package.json'
import { describe, expect, test } from 'vitest'
import worker from '../../public/mockServiceWorker.js?raw'

describe('the mock service worker', () => {
  test('the committed worker script matches the installed MSW (after upgrading msw, run `npx msw init`)', () => {
    expect(worker).toContain(`const PACKAGE_VERSION = '${mswPackage.version}'`)
  })
})
