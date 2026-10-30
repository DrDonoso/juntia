// Types of the demo build (vite.config.ts). Declarations only: nothing here reaches a bundle.

interface ImportMetaEnv {
  /** `'1'` in the public demo build (`--mode demo`, frontend/.env.demo). */
  readonly VITE_DEMO?: string
}

/** Day of the build (`YYYY-MM-DD`), answered by the demo's `/api/version`. */
declare const __DEMO_BUILD_DATE__: string
