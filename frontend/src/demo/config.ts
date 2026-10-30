/**
 * Public demo switch, set at BUILD time by `--mode demo` (frontend/.env.demo → `VITE_DEMO=1`).
 *
 * The demo answers the whole API in the browser (MSW service worker, src/demo/handlers) from
 * synthetic data kept in memory: there is no backend and no database, and every change lasts until
 * the page is reloaded. Normal builds load nothing from src/demo: main.tsx imports it only behind
 * a literal `import.meta.env.VITE_DEMO` check, which the bundler removes.
 */
export const IS_DEMO: boolean = import.meta.env.VITE_DEMO === '1'

/** Username of the demo administrator (shown on the /admin sign-in screen: not a secret). */
export const DEMO_ADMIN_USERNAME = 'demo'

/** Password of the demo administrator and of every active neighbor of the demo. */
export const DEMO_PASSWORD = 'demo'

/** Seed of the synthetic data: the same day always gives the same demo. */
export const DEMO_SEED = 20261029

/** Hours a demo session lasts, like the backend's default `SESSION_HOURS`. */
export const DEMO_SESSION_HOURS = 12

/** Source code of Juntia, linked from the demo banner. */
export const DEMO_REPOSITORY_URL = 'https://github.com/DrDonoso/juntia'
