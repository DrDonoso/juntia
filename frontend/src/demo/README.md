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
  page load (`DemoWelcome`: "Explore as a neighbor" / "Open administration", which signs in James
  Okafor, the administrator, through `POST /api/auth/login` and opens `/admin` or the page of it
  that was asked for), the credentials on the `/login` sign-in screen, filled in
  (`DemoSignInNotice`: the sample neighbor's, or James Okafor's when signing in returns to the
  administration, `/login?next=/admin…`, where the app sends whoever opens it signed out), and
  serves plain links to API files through the demo API (`DemoApiLinks`: navigations bypass the
  service worker; clicks the app handles itself, such as its file viewer, are left alone). The
  viewer shows PDFs from a copy read through the demo API, since frames bypass the worker too.
  Texts live in the `demo` i18n namespace (English and Spanish).
- **Sessions.** One per browser, like the backend's single `juntia_user` cookie (`core/session.ts`):
  the visitor starts as the sample neighbor, signing in with any account (the administrator's too)
  replaces the session, and signing out ends it. Administrators are accounts with the
  `administrator` flag, read on every request: `/api/admin/*` answers 401
  `authentication_required` without a session and 403 `administrator_required` to anyone else.
  The first-run setup of a new installation is never available: the demo always has accounts.
- **Static host.** `vite.config.ts` writes `dist-demo/_headers` (the backend's CSP and security
  headers plus `worker-src 'self'` and `frame-src 'self' blob:`; `no-cache` for the worker,
  immutable `/assets/*`) and a
  `manifest.webmanifest` (the backend serves the production one), and titles the page "Juntia demo".

## Deployment (Cloudflare Workers Builds)

`frontend/wrangler.jsonc` describes a static-assets Worker `juntia-demo` serving `./dist-demo` with
the SPA fallback (`not_found_handling: "single-page-application"`) and the custom domain
`demo.juntia.drdonoso.com`. Import the GitHub repository in Workers & Pages with root directory
`/frontend`, build command `npm run build:demo`, deploy command `npx wrangler@4 deploy` and the
variable `NODE_VERSION=24`. From a terminal: `npm run build:demo && npx wrangler@4 deploy`.
For non-production branch builds, use `npx wrangler@4 preview`. The empty `previews` block enables
these isolated Previews; the static demo's assets and compatibility settings remain at the top
level, with no Preview-specific bindings.

## Layout

```
src/demo/
  config.ts            IS_DEMO, the demo password (demo), seed, repository URL
  cast.ts              Maple Court: dwellings, neighbors, president (the administrator), sample neighbor
  core/                shared toolkit, re-exported by core/index.ts
    clock.ts           the demo's "now" and calendar helpers (today(), daysAgo(), instant()…)
    random.ts          seeded PRNG: demoRandom('<domain>:<topic>')
    ids.ts             auto-increment ids (IdSequence)
    errors.ts          DemoApiError: the backend's {"code", "fields"?} errors
    http.ts            route(): the backend's request pipeline; path/query parsers; demoUnavailable()
    validation.ts      Body / parseBody(): pydantic-like body contracts
    pagination.ts      paginate(): {items, page, pages, total}
    pdf.ts             demoPdf(), pdfResponse(), looksLikePdf(): synthetic PDFs and file answers
    zip.ts             zipArchive(), readZip(), readZipMember(): stored ZIP archives, read back
    session.ts         the session: signedInResident(), requireAnySession(), requireAdmin(), actorOf()
  scenario/<domain>.ts initial data, deterministic and relative to today
  store/<domain>.ts    the data of this page load: <domain>Store() and reset<Domain>Store()
  store/core.ts        shared state: session, features, general settings, account, dwellings, accounts, the What's new notes each account has read
  store/storage.ts     storage of PDFs, images and documents, from their stores (no state of its own)
  store/notifications.ts  the notifications each account was told, read and dismissed, and the kinds it turned off
  store/index.ts       resetDemo(): every store back to its scenario
  handlers/<domain>.ts the MSW handlers of each domain (an exported array)
  handlers/index.ts    all handlers, UNAVAILABLE_IN_DEMO and the /api catch-all (501, console error)
  handlers/coverage.test.ts  the OpenAPI coverage guard
  testing.ts           Vitest helpers: demoRequest(), signInAdmin() and signInAs(), stubFetchWithDemo()
```

Domains are `core` (this foundation), `finance`, `community`, `people`, `storage`, `documents`
(shared documents, whose modules are named `shared-documents*.ts`: `scenario/community-documents.ts`
is the catalogue of the actions' PDFs), `search` (the search box at the top of every page, which
only reads the other domains' stores and owns no data) and `notifications` (the bell, whose alerts
follow the finance store, with no scenario of its own). Each domain owns exactly its `scenario/`,
`store/` and `handlers/` module plus its own test files; `handlers/index.ts` and `store/index.ts`
import them.

## The cast (`cast.ts`)

Community **Maple Court**, bank account `ES3099990001230123456789` ("Community account", a
checksum-valid IBAN on the non-existent bank 9999), twelve dwellings `1A`…`4C` (ids 1–12, ownership
coefficients adding up to 100.00) and eighteen neighbors (ids 1–18) with `@example.com` emails and
UK fiction phone numbers stored normalized (`+442079460xxx`):

- 15 active, 2 pending invitations (Ethan Brooks, 4B: sent yesterday; Hannah Schmidt, 4C:
  expired), and 1 disabled account (Noah Patel); some dwellings have two neighbors, and every
  dwelling has an active one (Lucas Moreau, id 17, in 4B and Zara Ahmed, id 18, in 4C).
- President and only administrator: **James Okafor** (id 1, 1A, `james.okafor@example.com`;
  `PRESIDENT_ID`, `ADMINISTRATOR_ID`). Sample neighbor (the visitor): **Olivia Bennett** (id 6, 2B,
  `olivia.bennett@example.com`).
- Every active account, the administrator's included, signs in with its email and the password
  `demo`, or with the one chosen in My profile during the visit (`demo` then stops working for it
  until a reload, and the sign-in screen fills in only its email). Everybody writes under their own
  name, administrators included; **Technical administrator** (`ADMINISTRATOR_ACTOR_NAME`) only names
  the authors of the technical administrator of earlier releases (`kind: 'administrator'`, without
  an account), which the API still shows for old data and the demo does not have.

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
   - `access`: `'public'`, `'session'` (any signed-in account: finance, neighbors, contacts,
     actions, events, documents and the own profile) or `'admin'` (a signed-in administrator:
     `/api/admin/*`; 403 `administrator_required` for anyone else). `route` also refuses writes
     without `X-Juntia-Request` (403 `invalid_origin`) and turns thrown `DemoApiError`s into the
     backend's error JSON.
   - The resolver gets `{ request, params, url, user }`: `user` is the signed-in account
     (`DemoResident`; `user.id` is its user id, `user.administrator` its role), read for this
     request and never null on `session` and `admin` routes, so data kept per person keys on
     `user.id` (statement previews belong to the administrator who uploaded them).
   - `options.feature: 'actions' | 'events' | 'documents'` answers 404 `actions_disabled` /
     `events_disabled` / `documents_disabled` while the feature is off; `options.status: 201 | 204`
     for creations and deletions.
   - Validate bodies with `parseBody(await readJson(request), body => …)` (unknown fields refused,
     422 `invalid_request`; map `DemoValidationError.invalid` to field codes with
     `parseBody(…, { fields })` where the backend reports fields: events, contacts, tags) and
     parameters with `idParam`, `pageParam`, `queryText`, `queryChoice`, `queryInts`, `queryBool`,
     `queryDay`.
   - Return the API types (`TransactionPage`, `ActionOut`…); paginate with
     `paginate(items, pageParam(url), size)` using the backend's page sizes (transactions and
     contacts 50; actions, labels, comments, attachments, events and documents' histories and
     deletions 20).
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
3. **Shared state.** Accounts and dwellings live in `coreStore()` (`DemoResident`, `DemoDwelling`):
   change them in place and bump `version`. Call `revokeResidentSessions(id)` when an account is
   disabled or deleted or its email or password changes; `findResident`, `residentStatus`,
   `invitationStatus` and `canSignIn` follow the backend. Authors come from `actorOf(user)`, a
   `DemoActor`: the author (`resident`, the account's id and name, administrators included) plus
   the role, which lets administrators change what others wrote; records keep only
   `authorship(actor)`. Feature flags (`coreStore().features`), the community name
   (`coreStore().general`) and the account (`coreStore().account`) are changed by their admin
   routes (see the table).
4. **Unavailable features.** Anything that needs real infrastructure answers `demoUnavailable()`
   (403 `demo_unavailable`, translated as "This feature needs a real server, so it is not available
   in the demo."): Google sign-in and linking, AI classification, push notifications on devices, real
   PDF parsing (the import returns a canned synthetic preview instead), email delivery (invitations
   and recovery are simulated without email). Operations that answer it entirely are listed, with
   the reason, in `UNAVAILABLE_IN_DEMO` (`handlers/index.ts`).
5. **Data rules.** English synthetic data only (the server language is English: categories
   "Regular fees", "Water", "Cleaning"…, tags "Recurring", "Direct debit"…, fallbacks
   "Uncategorized" / "No merchant", ICS files `event-{id}.ics`); `@example.com` emails, UK fiction
   phone numbers, IBANs on bank 9999; no real people or places; no Spanish-specific characters
   outside `src/i18n/locales/es`.
6. **Tests.** Next to your module (`handlers/<domain>.test.ts`, `scenario/<domain>.test.ts`…):
   `beforeEach(() => resetDemo({ now: () => new Date(2026, 9, 29, 12) }))` pins the clock, and
   `demoRequest(method, path, { body })` from `../testing` answers through every handler, as the
   sample neighbor until a test signs in someone else: `signInAs(id)` (a cast account, password
   `demo`), `signInAdmin()` (James Okafor) or `asAdministrator(action)` (back to the previous
   session afterwards). UI tests can route the app's own requests to the demo with
   `stubFetchWithDemo()` (then `vi.unstubAllGlobals()` in `afterEach`). Run
   `npx vitest run src/demo`.

## Who answers which route

Every operation of `src/api/openapi.json` belongs to exactly one module (`{x}` is `:x` in MSW).

- **core** (`handlers/core.ts`): `GET /api/auth/session`, `POST /api/auth/login`,
  `POST /api/auth/logout`, `GET|POST /api/auth/setup` (never available: `{"available": false}`, and
  a valid account is refused with 409 `setup_unavailable`), `GET /api/features`,
  `GET /api/settings/general`, `GET /api/version`, `GET /api/account`, `GET /health`.
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
  preview, comments, history, labels, images), `GET /api/admin/action-labels`,
  `GET|PATCH /api/admin/action-labels/{label_id}`, everything under `/api/events` (list, create,
  agenda, config, item, calendar, `calendar.ics`, history, images), `GET|POST /api/contacts`,
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
  `GET /api/admin/storage/withdrawn`, `GET /api/admin/storage/attachments/{attachment_id}/preview|download`,
  `POST /api/admin/storage/attachments/{attachment_id}/purge`,
  `GET /api/admin/storage/images`, `GET /api/admin/storage/images/{image_id}/file`,
  `POST /api/admin/storage/images/{image_id}/purge`, `GET /api/admin/storage/document-versions`,
  `POST /api/admin/storage/document-versions/{version_id}/purge`.
- **documents** (`handlers/shared-documents.ts`): everything under `/api/documents/` (browse, the
  search by name and by text, the folder tree, folders and files with their history, uploads with
  their chunks and completion, downloads, previews and archives), `GET /api/admin/documents/deleted`,
  `POST /api/admin/documents/deletions/{deletion_id}/restore|purge`,
  `GET /api/admin/documents/files/{document_id}` and its `/history`,
  `GET /api/admin/documents/folders/{folder_id}/history`,
  `GET /api/admin/documents/versions/{version_id}/download|preview`,
  `GET /api/admin/documents/text` and `/text/files`, `POST /api/admin/documents/text/retry` and
  `/text/files/{document_id}/read`, `GET|PATCH /api/admin/settings/documents`.
- **search** (`handlers/search.ts`): `GET /api/search`, the search box at the top of every page:
  actions (with their comments and PDF names), events, folders and files (by name and by their
  text), neighbors, contacts and transactions, read from the other domains' stores with the
  backend's rules (`src/juntia/search.py`); `GET /api/search/results`, the page of results, with
  the count of each kind and the best few of each, or a page of one kind.
- **notifications** (`handlers/notifications.ts`): `GET /api/notifications`,
  `POST /api/notifications/read-all`, `POST /api/notifications/{notification_id}/read|dismiss` and
  `PATCH /api/notifications/preferences`, brought up to date on every request from the finance
  store with the backend's rule (`src/juntia/notifications.py`): administrators are told when the
  previous month's statement is missing, which happens once the latest two statements are removed;
  `GET /api/push`, `PUT /api/push/subscription` and `POST /api/push/unsubscribe` answer
  `demo_unavailable` (MSW's is the demo's service worker).

Any other `/api` request reaches the catch-all: a 501 `not_implemented` and a console error
starting with `[demo] Unhandled API request:`. Two guards keep it that way:

- **OpenAPI coverage** (`handlers/coverage.test.ts`): every operation of `src/api/openapi.json`
  needs a handler (`info.method` and `info.path` of the MSW handlers, whatever their parameters are
  called) unless `UNAVAILABLE_IN_DEMO` lists it with a reason; every handler must be an operation
  of the API, answered by one handler only; and every listed operation that has a handler must
  answer `demo_unavailable`. After a backend contract change (`npm run gen:api`), the test names
  the operations to add. Today every operation has a handler, and the list holds Google sign-in,
  linking and unlinking, AI classification and the push notifications of devices.
- **Every page in the browser** (`e2e/demo.spec.ts`): as the sample neighbor (welcome dialog,
  "Explore as a neighbor") and as the administrator, James Okafor ("Open administration"), in
  English and in Spanish (the browser's language), the crawl opens every link of the "Main
  navigation" and "Administration navigation" landmarks as found on screen, so new pages are
  covered without editing the test, plus My profile, the actions' Kanban board and an action with a
  withdrawn PDF. Each page must load its data, show a visible `h1` with `<html lang>` in the right
  language and pass axe's WCAG 2 A and AA rules with no serious or critical violation
  (`KNOWN_VIOLATIONS` may tolerate a rule on one element of an app component, with a comment, until
  its owner fixes it; it is empty). In every test, an unserved request, an `/api` answer of 500 or
  more, an `/api` response that did not come from the service worker, a console error or an
  uncaught error fails.

## Storage of action PDFs and images (SEC-03)

`store/storage.ts` computes everything from the community store's attachments and images: active
and withdrawn PDFs and every image use storage until an administrator purges them. The backend's
default settings apply: 250 MiB per account, administrators included (`ACTION_STORAGE_USER_QUOTA_MB`),
2048 MiB for the community (`ACTION_STORAGE_COMMUNITY_QUOTA_MB`) and a 1024 MiB disk reserve
(`MIN_FREE_DISK_MB`). The upload volume is synthetic: 64 GiB, about 41.3 GiB free, minus the PDFs,
images and shared documents stored now, so uploads and purges move it. Shared documents have
budgets of their own (see [Shared documents](#shared-documents)); the summary reports them in its
`documents` block, and their earlier versions are listed and purged on the same page.

- Uploads of PDFs and images check the uploader's quota, then the community's (409
  `action_storage_user_quota` / `action_storage_community_quota`), after the other checks and never
  for a retried upload id. The disk reserve (507 `storage_low_space`) is not simulated: the
  synthetic volume never runs low.
- Images (`store/community-images.ts`, `handlers/community-images.ts`) are kept in memory with
  their bytes, recognized from their header like the backend (PNG, JPEG, GIF, WebP, 10 MiB, 16,384
  pixels a side, 40 megapixels) and served by the section they were uploaded to. The scenario has
  none.
- The storage page lists the accounts that store PDFs, administrators included (largest first;
  deleted accounts by the author name of their latest PDF), and the withdrawn PDFs still stored (the
  latest withdrawn first, five per page, `q` searching their names without case or accents), which
  administrators can open (`/preview`, `/download`) also while Actions is off. The scenario has
  three, by different authors: Daniel Mensah's quote attached by mistake (CCTV), James Okafor's
  draft quote (lift) and Grace Liu's outdated subsidy summary (solar panels). The summary's
  `administrator` line counts only files of the technical administrator of earlier releases
  (`kind: 'administrator'`, without an account): the demo has none.
- A purge (`{version}`, administrators only) answers 409 `action_attachment_active` for active PDFs
  and 409 `action_stale` for another version, and the purged PDF unchanged when repeated. It sets
  `purged_at`, bumps the PDF's version, empties its bytes and records an `attachment_purged` entry
  under the administrator's own name (`filename`, `size` and `sha256` to null); the action's
  activity date moves, not its version. Downloads and previews then answer 410
  `action_attachment_purged`.
- The images list (the newest first, five per page, `q` by name) shows every stored image, and the
  administration's copy (`/file`) answers while Actions or Events is off. An image purge (no body)
  empties its bytes and sets `purged_at`; repeating it answers the purged image unchanged, and its
  addresses then answer 410 `image_purged`.

## Shared documents

`store/shared-documents.ts` keeps the folders, files, versions (with their bytes), deletions,
history and uploads in progress, and mirrors `community_documents.py`;
`store/shared-document-files.ts` mirrors `document_files.py` (accepted types, name rules, content
checks). The scenario (`scenario/shared-documents.ts`) is a list of dated steps replayed through the
same operations as the API, so the history matches the data: the house rules and their revised
version, meeting minutes in year folders (one moved there), an insurance folder renamed by the
administrator (James Okafor) with a claims log in two versions, a renamed scan, a Word letter, the
sample neighbor's garden folder and rota, and two deletions waiting for administrators (Daniel
Mensah's draft and Chloe Dubois's photos folder). Documents is on in the demo, and its settings are
a new installation's defaults: the `creator` policy, 50 MiB per file, 1 GiB per video, 2 GiB per
account and 20 GiB for the community.

- Rules as on the server: names unique per folder ignoring case and Unicode forms (409
  `document_name_taken`), `document_name_invalid`, ten levels of folders, a thousand items per
  folder, `document_move_into_itself`, `document_stale`, the management policy
  (`document_permission_required`, `document_folder_not_owned`), and the history entries with their
  details. Administrators manage every item whatever the policy, and write under their own name.
- Uploads arrive in chunks of at most 4 MiB (`PUT …/content?offset=` with raw bytes; 413
  `request_too_large` above), resume from `received`, expire a day after their last chunk, and each
  person keeps four open. Completing checks the bytes like the backend (PDF, pictures, ISO-BMFF
  videos, OOXML and OpenDocument with their macro checks, text) and numbers names already taken.
  Files stay in the page's memory, and uploads and stored versions take their bytes from the
  synthetic volume's free space.
- The limits are not fixed: administrators set them with the policy, in Settings > Storage
  (`GET|PATCH /api/admin/settings/documents`, in whole MiB): the largest file and the largest video
  (1 MiB to 10 GiB, so a single file always fits in a ZIP download) and the quotas of each author,
  administrators included, and of the community (1 MiB to 10 TiB; every stored version counts until
  it is purged). A `PATCH` changes only the settings it sends and answers all of them; an empty
  body, `null`, an unknown key or anything but a whole number in range answers 422
  `invalid_request`. A change applies at once to the `limits` of browsing, to the size check when an
  upload starts, to both quota checks (when an upload starts and when it completes) and to the
  storage summary's `quota_bytes` and `resident_quota_bytes`.
- Downloads and previews answer single `Range` requests with 206, and earlier versions download as
  `Name (version N).ext`. Text and CSV files preview as `text/plain`, for the portal's own viewer.
  Archives are ZIPs with stored entries built in memory by `core/zip.ts`.
- The text of each current version is read for the search like on the server
  (`document_index.py`, `document_text.py`) by `store/shared-document-text.ts`: text and CSV files
  (UTF-8 or UTF-16 with a byte order mark, UTF-8, or else Windows-1252), the XML of OOXML and
  OpenDocument files, and the strings PDFs draw (`Tj`, `TJ`, FlateDecode streams included). There
  is no OCR: the reading summary reports it unavailable (English model), and pictures and PDFs
  without text are read as empty and waiting for OCR. Uploads queue their text and replace the
  earlier version's, and purges forget it; the search, the file info and the reading page read
  what is waiting first, so their `pending` is 0. The search lists the folders, the files found by
  name, then those found by their text with an excerpt. The administration's reading page
  (`/api/admin/documents/text…`, also while Documents is off) counts, filters and pages the files,
  reads one again (409 `document_text_unsupported` for videos and HEIC pictures, 404 for deleted
  files) and retries the failed ones.
- Administrators restore deletions (at the top level when their folder is gone, numbered when
  the name is taken) or purges them, lists the earlier versions on the storage page (the latest
  uploaded first, five per page, `q` by document name, with `previewable`), opens and purges them,
  and sets the policy and the limits; these routes work while Documents is off.
- Not simulated: the four concurrent archives (503 `document_archive_busy`), the disk reserve (507
  `storage_low_space`) and missing or unreadable stored files. The demo writes no ZIP64, so an
  archive over 4 GiB answers 422 `document_archive_too_large`, and office files with ZIP64, bzip2
  or LZMA entries are refused as `document_type_mismatch`. A chunk over 4 MiB is refused after the
  session and feature checks, not before them like the server's body limit. A limit written as a
  number with a zero fraction (`50.0`) is accepted: JavaScript's JSON reads it as `50`, while the
  server's strict integers refuse it.
