# The public demo (`src/demo`)

A static, backend-less copy of Juntia: the whole `/api` is answered in the visitor's browser by
[Mock Service Worker](https://mswjs.io) from synthetic English data kept in memory. Every change
lasts until the page is reloaded; a reload starts again from the same scenario. It is published at
<https://demo.juntia.drdonoso.com> (Cloudflare Workers static assets).

## Commands (in `frontend/`)

| Command | What it does |
|---|---|
| `npm run dev:demo` | Vite dev server in demo mode (no backend, no proxy). |
| `npm run build:demo` | Type-checks and builds the demo into `dist-demo/` (never touches `dist/`). |
| `npm run preview:demo` | Serves `dist-demo/` with the demo's security headers. |
| `npm run e2e:demo` | Playwright tests of the built demo (`playwright.demo.config.ts`, port 4183, `DEMO_E2E_PORT`; build first): smoke tests and a crawl of every page in English and Spanish. `DEMO_E2E_BASE_URL=https://demo.juntia.drdonoso.com` checks a deployed demo instead. |
| `npx vitest run src/demo` | Unit tests of the demo API, data and UI, including the OpenAPI coverage guard. |

## How it works

- **Build switch.** `vite build --mode demo` loads `frontend/.env.demo` (`VITE_DEMO=1`). `main.tsx`
  imports `./demo/browser` and `./demo/DemoChrome` only behind literal
  `import.meta.env.VITE_DEMO === '1'` checks, so normal builds contain no demo code; the
  `juntia:without-mock-service-worker` plugin also removes `mockServiceWorker.js` from `dist/`.
- **Start.** `startDemo()` (`browser.ts`) registers `public/mockServiceWorker.js` with every handler
  (`onUnhandledRequest: 'bypass'`, quiet) before the first render. Without service workers
  (insecure origin, some private windows) it shows a translated explanation instead of the app.
- **Chrome.** `DemoChrome.tsx` adds a persistent banner (`DemoBanner`), a welcome dialog once per
  page load (`DemoWelcome`: "Explore as a neighbor" / "Open administration"), the credentials on
  the `/login` and `/admin` sign-in screens, filled in (`DemoSignInNotice`), and serves plain links
  to API files through the demo API (`DemoApiLinks`: navigations bypass the service worker). Texts
  live in the `demo` i18n namespace (English and Spanish).
- **Static host.** `vite.config.ts` writes `dist-demo/_headers` (the backend's CSP and security
  headers plus `worker-src 'self'`; `no-cache` for the worker, immutable `/assets/*`) and a
  `manifest.webmanifest` (the backend serves the production one), and titles the page "Juntia demo".

## Deployment (Cloudflare Workers Builds)

`frontend/wrangler.jsonc` describes a static-assets Worker `juntia-demo` serving `./dist-demo` with
the SPA fallback (`not_found_handling: "single-page-application"`) and the custom domain
`demo.juntia.drdonoso.com`. Import the GitHub repository in Workers & Pages with root directory
`/frontend`, build command `npm run build:demo`, deploy command `npx wrangler@4 deploy` and the
variable `NODE_VERSION=24`. From a terminal: `npm run build:demo && npx wrangler@4 deploy`.

## Layout

```
src/demo/
  config.ts            IS_DEMO, demo credentials (demo / demo), seed, repository URL
  cast.ts              Maple Court: dwellings, neighbors, president, sample neighbor (shared contract)
  core/                shared toolkit, re-exported by core/index.ts
    clock.ts           the demo's "now" and calendar helpers (today(), daysAgo(), instant()…)
    random.ts          seeded PRNG: demoRandom('<domain>:<topic>')
    ids.ts             auto-increment ids (IdSequence)
    errors.ts          DemoApiError: the backend's {"code", "fields"?} errors
    http.ts            route(): the backend's request pipeline; path/query parsers; demoUnavailable()
    validation.ts      Body / parseBody(): pydantic-like body contracts
    pagination.ts      paginate(): {items, page, pages, total}
    pdf.ts             demoPdf(), pdfResponse(), looksLikePdf(): synthetic PDFs and file answers
    session.ts         sessions, guards (requireResident/requireAdmin/requireAnySession), actorOf()
  scenario/<domain>.ts initial data, deterministic and relative to today
  store/<domain>.ts    the data of this page load: <domain>Store() and reset<Domain>Store()
  store/core.ts        shared state: session, features, general settings, account, dwellings, neighbors
  store/storage.ts     storage of the action PDFs, computed from the community store (no state of its own)
  store/index.ts       resetDemo(): every store back to its scenario
  handlers/<domain>.ts the MSW handlers of each domain (an exported array)
  handlers/index.ts    all handlers, UNAVAILABLE_IN_DEMO and the /api catch-all (501, console error)
  handlers/coverage.test.ts  the OpenAPI coverage guard
  testing.ts           Vitest helpers: demoRequest(), stubFetchWithDemo()
```

Domains are `core` (this foundation), `finance`, `community`, `people` and `storage`. Each domain
owns exactly its `scenario/`, `store/` and `handlers/` module plus its own test files;
`handlers/index.ts` and `store/index.ts` import them.

## The cast (`cast.ts`)

Community **Maple Court**, bank account `ES3099990001230123456789` ("Community account", a
checksum-valid IBAN on the non-existent bank 9999), twelve dwellings `1A`…`4C` (ids 1–12, ownership
coefficients adding up to 100.00) and eighteen neighbors (ids 1–18) with `@example.com` emails and
UK fiction phone numbers stored normalized (`+442079460xxx`):

- 15 active, 2 pending invitations (Ethan Brooks, 4B: sent yesterday; Hannah Schmidt, 4C:
  expired), and 1 disabled account (Noah Patel); some dwellings have two neighbors, and every
  dwelling has an active one (Lucas Moreau, id 17, in 4B and Zara Ahmed, id 18, in 4C).
- President: **James Okafor** (id 1, 1A). Sample neighbor (the visitor): **Olivia Bennett** (id 6,
  2B, `olivia.bennett@example.com`).
- Every active neighbor signs in with the password `demo`, or with the one they choose in My
  profile during the visit (`demo` then stops working for them until a reload, and the sign-in
  screen only fills in the sample neighbor's email); the administrator is `demo` / `demo`.
  Administrators always appear as **Technical administrator** (`ADMINISTRATOR_ACTOR_NAME`).

Never change an id or a name: the domains build on them. Add people at the end if needed.

## Writing a domain module

1. **Data.** Build the initial data in `scenario/<domain>.ts` with `demoRandom('<domain>:<topic>')`
   (never `Math.random`) and dates relative to `today()` (never `new Date()`; `instant(day, '18:30')`
   for datetimes, `nowIso()` for writes). Replace the stub type with your state's shape; keep the
   `<domain>Scenario()`, `<domain>Store()` and `reset<Domain>Store()` exports. Use `IdSequence` per
   table and `random.uuid()` for string ids.
2. **Handlers.** Export `<domain>Handlers` from `handlers/<domain>.ts`, importing from `../core`
   (never from `msw` directly: the MSW version stays a core detail), `../cast`, `../store/core` and
   the generated types of `../../api/schema.gen`. Wrap every resolver in
   `route(access, resolver, options)`:
   - `access`: `'public'`, `'session'` (any reader: finance, neighbors, contacts, actions, events),
     `'resident'` (own profile: 403 `resident_profile_required` for the administrator) or `'admin'`
     (`/api/admin/*`). `route` also refuses writes without `X-Juntia-Request` (403
     `invalid_origin`) and turns thrown `DemoApiError`s into the backend's error JSON.
   - `options.feature: 'actions' | 'events'` answers 404 `actions_disabled` / `events_disabled`
     while the feature is off; `options.status: 201 | 204` for creations and deletions.
   - Validate bodies with `parseBody(await readJson(request), body => …)` (unknown fields refused,
     422 `invalid_request`; map `DemoValidationError.invalid` to field codes with
     `parseBody(…, { fields })` where the backend reports fields: events, contacts, tags) and
     parameters with `idParam`, `pageParam`, `queryText`, `queryChoice`, `queryInts`, `queryBool`,
     `queryDay`.
   - Return the API types (`TransactionPage`, `ActionOut`…); paginate with
     `paginate(items, pageParam(url), size)` using the backend's page sizes (transactions and
     contacts 50; actions, labels, comments, attachments and events 20).
   - Mirror the backend's rules and error codes (read `src/juntia/*.py`): optimistic `version`
     checks (409 `*_stale`), ownership (403 `action_owner_required`), not-found codes, history
     entries. Every error code the UI can get must exist in `errors.codes` (it does for the
     backend's codes).
   - Paths use MSW syntax (`/api/actions/items/:itemId`). MSW takes the first match, so put static
     segments before parameters (`/api/events/agenda` before `/api/events/:eventId`).
   - Files: build documents with `demoPdf(title, lines)` and answer with
     `pdfResponse(bytes, filename, 'attachment' | 'inline')` (the backend's Content-Disposition
     forms); check uploads with `looksLikePdf(bytes)` like the backend. The app downloads with
     `fetch`, and plain `<a href="/api/…">` links are fetched by `DemoApiLinks`.
3. **Shared state.** Neighbors and dwellings live in `coreStore()` (`DemoResident`, `DemoDwelling`):
   change them in place and bump `version`. Call `revokeResidentSessions(id)` when an account is
   disabled or deleted or its email or password changes; `findResident`, `residentStatus`,
   `invitationStatus` and `canSignIn` follow the backend. Author fields come from
   `actorOf(identity)`. Feature flags (`coreStore().features`), the community name
   (`coreStore().general`) and the account (`coreStore().account`) are changed by their admin
   routes (see the table).
4. **Unavailable features.** Anything that needs real infrastructure answers `demoUnavailable()`
   (403 `demo_unavailable`, translated as "This feature needs a real server, so it is not available
   in the demo."): Google sign-in and linking, AI classification, real PDF parsing (the import
   returns a canned synthetic preview instead), email delivery (invitations and recovery are
   simulated without email). Operations that answer it entirely are listed, with the reason, in
   `UNAVAILABLE_IN_DEMO` (`handlers/index.ts`).
5. **Data rules.** English synthetic data only (the server language is English: categories
   "Regular fees", "Water", "Cleaning"…, tags "Recurring", "Direct debit"…, fallbacks
   "Uncategorized" / "No merchant", ICS files `event-{id}.ics`); `@example.com` emails, UK fiction
   phone numbers, IBANs on bank 9999; no real people or places; no Spanish-specific characters
   outside `src/i18n/locales/es`.
6. **Tests.** Next to your module (`handlers/<domain>.test.ts`, `scenario/<domain>.test.ts`…):
   `beforeEach(() => resetDemo({ now: () => new Date(2026, 9, 29, 12) }))` pins the clock, and
   `demoRequest(method, path, { body })` from `../testing` answers through every handler. UI tests
   can route the app's own requests to the demo with `stubFetchWithDemo()` (then
   `vi.unstubAllGlobals()` in `afterEach`). Run `npx vitest run src/demo`.

## Who answers which route

Every operation of `src/api/openapi.json` belongs to exactly one module (`{x}` is `:x` in MSW).

- **core** (`handlers/core.ts`): `GET /api/auth/session`, `POST /api/auth/login`,
  `POST /api/auth/logout`, `GET /api/admin/auth/session`, `POST /api/admin/auth/login`,
  `POST /api/admin/auth/logout`, `GET /api/features`, `GET /api/settings/general`,
  `GET /api/version`, `GET /api/account`, `GET /health`.
- **finance**: `GET /api/transactions`, `GET /api/summary`, `GET /api/catalog/{kind}`,
  `PATCH /api/admin/account`, `POST /api/admin/catalog/{kind}`,
  `PATCH|DELETE /api/admin/catalog/{kind}/{item_id}`, `GET|POST /api/admin/rules`,
  `PUT|DELETE /api/admin/rules/{rule_id}`, `POST /api/admin/rules/preview`,
  `POST /api/admin/rules/apply`, `GET /api/admin/statements`,
  `DELETE /api/admin/statements/{import_id}`, `GET /api/admin/statements/{import_id}/original`,
  `GET /api/admin/statements/{import_id}/removal`, `POST /api/admin/imports/preview`,
  `GET /api/admin/imports/{preview_id}`, `POST /api/admin/imports/{preview_id}/account`,
  `POST /api/admin/imports/{preview_id}/ai`, `POST /api/admin/imports/{preview_id}/confirm`,
  `PATCH /api/admin/transactions/{transaction_id}`.
- **community**: everything under `/api/actions/` (board, items, attachments with download and
  preview, comments, history, labels), `GET /api/admin/action-labels`,
  `GET|PATCH /api/admin/action-labels/{label_id}`, everything under `/api/events` (list, create,
  agenda, config, item, calendar, `calendar.ics`, history), `GET|POST /api/contacts`,
  `GET|PATCH|DELETE /api/contacts/{contact_id}`, `GET|POST /api/contact-tags`,
  `PATCH /api/contact-tags/{tag_id}`, `GET /api/contact-history`, `GET /api/admin/contact-tags`,
  `GET|PATCH /api/admin/contact-tags/{tag_id}`, `GET /api/admin/contacts/deleted`.
- **people**: `GET /api/neighbors`, `GET /api/neighbors/layout`, `GET|POST /api/admin/users`,
  `PATCH|DELETE /api/admin/users/{user_id}`, `POST /api/admin/users/{user_id}/invite`,
  `PATCH /api/admin/users/{user_id}/status`, `GET|POST /api/admin/dwellings`,
  `PATCH /api/admin/dwellings/{dwelling_id}`, `PUT /api/admin/dwellings/layout`,
  `GET|PUT /api/admin/presidency`, `GET|PATCH /api/auth/profile`, `POST /api/auth/profile/password`,
  `DELETE /api/auth/profile/sessions`, `POST /api/auth/activate`, `POST /api/auth/forgot-password`,
  `POST /api/auth/reset-password`, `POST /api/auth/google/start`, `POST|DELETE /api/auth/google/link`,
  `PATCH /api/admin/settings/general`, `PATCH /api/admin/settings/features/{feature}`.
- **storage** (`handlers/storage.ts`, SEC-03): `GET /api/admin/storage`,
  `GET /api/admin/storage/withdrawn`, `POST /api/admin/storage/attachments/{attachment_id}/purge`.

Any other `/api` request reaches the catch-all: a 501 `not_implemented` and a console error
starting with `[demo] Unhandled API request:`. Two guards keep it that way:

- **OpenAPI coverage** (`handlers/coverage.test.ts`): every operation of `src/api/openapi.json`
  needs a handler (`info.method` and `info.path` of the MSW handlers, whatever their parameters are
  called) unless `UNAVAILABLE_IN_DEMO` lists it with a reason; every handler must be an operation
  of the API, answered by one handler only; and every listed operation that has a handler must
  answer `demo_unavailable`. After a backend contract change (`npm run gen:api`), the test names
  the operations to add. Today every operation has a handler, and the list holds Google sign-in,
  linking and unlinking and AI classification.
- **Every page in the browser** (`e2e/demo.spec.ts`): as the sample neighbor (welcome dialog,
  "Explore as a neighbor") and as the administrator ("Open administration"), in English and in
  Spanish (the browser's language), the crawl opens every link of the "Main navigation" and
  "Administration navigation" landmarks as found on screen, so new pages are covered without
  editing the test, plus My profile, the actions' Kanban board and an action with a withdrawn PDF.
  Each page must load its data, show a visible `h1` with `<html lang>` in the right language and
  pass axe's WCAG 2 A and AA rules with no serious or critical violation (`KNOWN_VIOLATIONS` may
  tolerate a rule on one element of an app component, with a comment, until its owner fixes it;
  it is empty). In every test, an unserved request, an `/api` answer of 500 or more, an `/api`
  response that did not come from the service worker, a console error or an uncaught error fails.

## Storage of action PDFs (SEC-03)

`store/storage.ts` computes everything from the community store's attachments: active and
withdrawn PDFs use storage until the administrator purges them. The backend's default settings
apply: 250 MiB per resident (`ACTION_STORAGE_USER_QUOTA_MB`), 2048 MiB for the community
(`ACTION_STORAGE_COMMUNITY_QUOTA_MB`; the administrator has no quota of their own) and a 1024 MiB
disk reserve (`MIN_FREE_DISK_MB`). The upload volume is synthetic: 64 GiB, about 41.3 GiB free, minus
the PDFs stored now, so uploads and purges move it.

- Uploads check the uploader's quota, then the community's (409 `action_storage_user_quota` /
  `action_storage_community_quota`), after the other checks and never for a retried upload id.
  The disk reserve (507 `storage_low_space`) is not simulated: the synthetic volume never runs low.
- The storage page lists the residents who store PDFs (largest first; deleted accounts by the
  author name of their latest PDF) and the withdrawn PDFs still stored (`sort=largest|oldest`,
  `user_id`, 20 per page). The scenario has three, by different authors: Daniel Mensah's quote
  attached by mistake (CCTV), the administrator's draft quote (lift) and Grace Liu's outdated
  subsidy summary (solar panels).
- A purge (`{version}`, administrator only) answers 409 `action_attachment_active` for active PDFs
  and 409 `action_stale` for another version, and the purged PDF unchanged when repeated. It sets
  `purged_at`, bumps the PDF's version, empties its bytes and records an `attachment_purged` entry
  by the Technical administrator (`filename`, `size` and `sha256` to null); the action's activity
  date moves, not its version. Downloads and previews then answer 410 `action_attachment_purged`.
