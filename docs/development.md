# Development

How to work on Juntia's code: the toolchain, the test suites, the generated files, translations,
continuous integration and releases. Start with [CONTRIBUTING.md](../CONTRIBUTING.md), which covers
setting up, running Juntia locally and the rules every pull request follows; this page goes deeper.

## Contents

- [Toolchain](#toolchain)
- [Repository layout](#repository-layout)
- [Backend checks](#backend-checks)
  - [PostgreSQL test database](#postgresql-test-database)
  - [Test groups](#test-groups)
- [Frontend checks](#frontend-checks)
  - [Browser tests](#browser-tests)
  - [The synthetic test server](#the-synthetic-test-server)
  - [Google sign-in tests](#google-sign-in-tests)
- [The demo](#the-demo)
- [API contract and generated types](#api-contract-and-generated-types)
- [Database migrations](#database-migrations)
- [Translations](#translations)
- [What's new notes](#whats-new-notes)
- [Icons](#icons)
- [Notification kinds](#notification-kinds)
- [Dependencies](#dependencies)
- [Continuous integration](#continuous-integration)
- [Supply chain](#supply-chain)
- [Releases](#releases)
- [Development and test variables](#development-and-test-variables)

## Toolchain

| Tool | Version |
| --- | --- |
| Python | 3.14 in CI and the image; 3.12 or newer works for development |
| [uv](https://docs.astral.sh/uv/) | 0.12.19 in CI and the image |
| Node.js and npm | Node 26 in CI and the image |
| PostgreSQL | 18 |
| Docker with Compose | for the database and the local stack |

The backend uses FastAPI, SQLAlchemy (async), Alembic and Pydantic; the frontend React 19,
TypeScript 7, Vite 8, TanStack Query and React Aria. Install everything with
`uv sync --locked --extra test` at the root and `npm ci` in `frontend/`, as described in
[CONTRIBUTING.md](../CONTRIBUTING.md#setting-up).

## Repository layout

| Path | Contents |
| --- | --- |
| `src/juntia/` | Backend: application factory (`app.py`), routes, models (`db.py`), settings (`config.py`), server-side texts (`texts.py`), the statement parser (`parser.py`) and the import pipeline (`imports.py`) |
| `alembic/versions/` | Database migrations, numbered `0001` to `0018` and onwards |
| `tests/` | Backend tests (pytest) |
| `scripts/` | OpenAPI export, dependency audit, the synthetic server used by browser tests and the *What's new* section of each release |
| `frontend/src/` | The React application; `i18n/` holds translations, `api/` the client and generated types, `demo/` the static demo, `whats-new/` the What's new notes |
| `frontend/e2e/` | Playwright browser tests |
| `docs/` | This documentation |

## Backend checks

From the repository root:

```sh
uv run --no-sync pytest -q
uv run --no-sync ruff check src tests scripts alembic seed.py
uv run --no-sync mypy
uv run --no-sync python scripts/export_openapi.py --check
uv run --no-sync python scripts/audit_dependencies.py
```

Without `TEST_DATABASE_URL`, every test uses its own temporary SQLite database, and the few tests
that need PostgreSQL (mainly concurrency) are skipped. Every API test runs the whole migration chain.
The `admin` fixture (`tests/conftest.py`) creates its administrator through `POST /api/auth/setup`,
like the first visitor of a new installation.

The test of OCR needs [Tesseract](https://github.com/tesseract-ocr/tesseract) with its English
model, as in CI and the image (`sudo apt install tesseract-ocr tesseract-ocr-eng tesseract-ocr-spa`
on Debian and Ubuntu, `brew install tesseract tesseract-lang` on macOS); without it, it is skipped.
The test clients never start the background reader of shared documents: tests read the waiting
files themselves with `client.portal.call(client.app.state.document_reader.drain)`. Nor do they
start the notifier: tests run its rounds at the moment they choose with
`client.portal.call(client.app.state.notifier.tick, moment)`, and give it a `webpush.WebPush` on an
`httpx.MockTransport` (`tests/push_support.py`), so nothing reaches a real push service.

### PostgreSQL test database

CI runs the suite on PostgreSQL 18. To do the same, point `TEST_DATABASE_URL` at a **disposable**
database named `juntia_test`, for example in a throwaway container:

```sh
docker run -d --name juntia-test-db -p 127.0.0.1:5432:5432 \
  -e POSTGRES_PASSWORD=juntia-test -e POSTGRES_DB=juntia_test postgres:18-alpine
TEST_DATABASE_URL=postgresql+asyncpg://postgres:juntia-test@127.0.0.1:5432/juntia_test \
  uv run --no-sync pytest -q
```

The fixtures drop and recreate every table between tests and refuse any other database name.
Never point it at a database with real data, and never run two test processes against the same
database at once.

### Test groups

CI splits the backend suite into two groups with
[pytest-split](https://github.com/jerry-git/pytest-split), the committed `.test_durations` profile
and the `least_duration` algorithm. Both groups collect the whole suite and run disjoint halves;
new tests get an estimated duration and are never left out. The dependency audit, Ruff, mypy and
the OpenAPI check run once, in group 1. Each group prints its 25 slowest test phases and uploads a
JUnit file (`pytest-results-1`, `pytest-results-2`), also when tests fail.

To reproduce a group, with the PostgreSQL configuration above:

```sh
uv run --no-sync pytest -q --splits 2 --group 1 --splitting-algorithm least_duration --durations=25
uv run --no-sync pytest -q --splits 2 --group 2 --splitting-algorithm least_duration --durations=25
```

Run them one after the other when they share a database. After substantial changes to the suite,
refresh the profile with a full, unsplit PostgreSQL run on CI-like versions and commit
`.test_durations`:

```sh
uv run --no-sync pytest -q --store-durations --durations=25
```

## Frontend checks

From `frontend/`:

```sh
npm run gen:api -- --check   # schema.gen.ts matches openapi.json
npm run lint                 # oxlint
npm test                     # unit tests (Vitest)
npm run build                # type check and production build into dist/
npm run e2e                  # browser tests against dist/
```

`npx vitest run <files>` runs selected unit tests, and `npx tsc --noEmit` type-checks without
building.

### Browser tests

`npm run e2e` tests the output of the last `npm run build`. Playwright starts two
[synthetic test servers](#the-synthetic-test-server) from the repository's `.venv`, each with its
own temporary SQLite database: the usual one on port 7889, with an administrator account, and one
without accounts, like a new installation, on the next port, for `first-run.spec.ts`. It runs the
specs in Chromium with one worker, in British English. Specs sign in as the administrator with
`signInAsAdministrator(page, path)` from `e2e/support.ts`. Run one file with
`npm run e2e -- events.spec.ts`.

- Install the browser with `npx playwright install chromium`. When browsers cannot be downloaded,
  `PLAYWRIGHT_CHANNEL=msedge` (or `chrome`) uses an installed one.
- `E2E_PORT` and `E2E_FIRST_RUN_PORT` (default `E2E_PORT` + 1) change the ports, for example when a
  manual preview already uses 7889. Running several suites at the same time needs different ports.
- CI splits the suite with `--shard=1/2` and `--shard=2/2`; reproduce a shard with
  `npm run e2e -- --shard=1/2`. Each shard builds the app and starts its own servers.
- CI also checks the contacts layout and touch navigation in WebKit:
  `npx playwright install webkit`, then
  `npm run e2e -- navigation.spec.ts --browser=webkit --grep "contacts keep|OS glyphs"`.
- The feature-switch specs change switches through the administration and restore the defaults when
  they finish; they need no environment variables.
- `E2E_BASE_URL`, with `E2E_ADMIN_EMAIL` and `E2E_ADMIN_PASSWORD` (an administrator account of that
  deployment), runs the suite against an existing deployment instead, without starting the servers.
  Use it only with an isolated, empty instance: the tests create data. The tests that need the
  server's captured mailbox or a new installation, such as `first-run.spec.ts`, are skipped then.

Browser tests never use a real statement, database, AI provider or mail recipient.

### The synthetic test server

`scripts/smoke_server.py` is a disposable, loopback-only Juntia for browser tests and manual
previews. It applies the migrations to a SQLite database, seeds it, creates the administrator
account `browser-test@example.org` with the password `synthetic-browser-test-password` ("Browser
Test", without a dwelling) unless it starts with `--first-run` or already has accounts, and
captures emails in memory instead of sending them. Options:

| Option | Default | Meaning |
| --- | --- | --- |
| `--port` | `7889` | Loopback port. |
| `--data-dir` | a temporary directory | Keep the database and uploads in this folder between runs. |
| `--language` | `en` | `APP_LANGUAGE` for emails and first-run defaults (`en` or `es`). |
| `--fake-google` | off | A synthetic Google provider, for the Google tests only. |
| `--first-run` | off | Start without any account, like a new installation, so that `/login` offers to create the administration account. |

It also exposes test-only endpoints, such as the captured mailbox and a reset of the sign-in
counters of the synthetic administrator and its client, which `signInAsAdministrator` calls after
each sign-in. They exist only in this script, never in the application. Never deploy it.

### Google sign-in tests

```sh
E2E_GOOGLE=true npm run e2e -- google.spec.ts
```

The server starts with `--fake-google` and Playwright intercepts the navigation to Google, so no
real Google account, credentials or network traffic is involved. The backend's token checks
(signature, issuer, audience, nonce and expiry) are tested with locally signed fixtures.

## The demo

The public demo is the same frontend built with `--mode demo`, with the API answered in the browser.
Its commands, structure and deployment are described in [demo.md](demo.md). Build it before
running its browser tests:

```sh
npm run build:demo
npm run e2e:demo
```

Every API operation needs a demo handler or an explicit "unavailable in the demo" answer; a unit
test fails otherwise.

## API contract and generated types

The frontend's API types are generated from the backend's OpenAPI contract, and CI fails when either
file is stale. After changing routes, request or response models or error responses, regenerate
both and commit them; never edit them by hand:

```sh
uv run --no-sync python scripts/export_openapi.py   # writes frontend/src/api/openapi.json
cd frontend && npm run gen:api                       # writes frontend/src/api/schema.gen.ts
```

The running application does not expose OpenAPI documentation.

## Database migrations

Every schema change needs a new Alembic migration in `alembic/versions/`, named
`NNNN_short_description.py`, with `revision` set to the next number and `down_revision` to the
previous one. Implement `downgrade()` too; when it would destroy data, make it refuse with a clear
message, as the existing migrations do (see [migration notes](deployment.md#migration-notes)).
Migrations must run on PostgreSQL and SQLite, inside a transaction. Keep the models in
`src/juntia/db.py` in step and add tests like `tests/test_*_migration.py`.

The application applies migrations at startup (`alembic upgrade head`) and `python seed.py` creates
the defaults of a new installation in `APP_LANGUAGE` and opens its first-run screen, where the first
visitor creates the administration account.

## Translations

- The interface is translated in `frontend/src/i18n/`. English (`locales/en/`) is the source of
  truth; Spanish (`locales/es/`) must have exactly the same keys, plural forms and placeholders.
  TypeScript and the parity test in `src/i18n/i18n.test.tsx` fail otherwise.
- Every user-visible string, including `aria-label`, `title`, `placeholder` and `alt`, goes through
  `useI18n().t('namespace.key')` (or `t()` outside components). Rich text uses `rich()`, never
  `dangerouslySetInnerHTML`.
- Never hard-code a locale such as `'es-ES'`: format dates, numbers, money and sorting with the
  helpers in `src/i18n/` and `src/shared.tsx`, which follow the active language (`en-GB` or
  `es-ES`).
- Every API error code needs a message in `locales/en/errors.ts` and `locales/es/errors.ts`.
- Server-generated texts (emails, first-run defaults, fallback labels) live in `src/juntia/texts.py`
  in both languages and follow `APP_LANGUAGE`.
- Tests run in English by default; call `setLanguage('es')` to assert Spanish.

## What's new notes

A change people will notice comes with a note in the same pull request: the next time each person
opens Juntia, a window (**What's new**) tells them what changed since they last looked, once, and
the user menu keeps every note. Accounts opening Juntia for the first time start with nothing to
catch up on. A note is a JSON file in `frontend/src/whats-new/notes/` named
`YYYY-MM-DD-short-name.json` (the day it is written; lower-case letters, digits and hyphens):

```json
{
  "kind": "new",
  "audience": "everyone",
  "icon": "folder",
  "link": "/documents",
  "en": {
    "title": "Keep the community's papers in Documents",
    "body": "Minutes, insurance papers and house rules now live in Documents, in the menu on the left. Open any of them on your phone or computer."
  },
  "es": {
    "title": "Guarda los papeles de la comunidad en Documentos",
    "body": "Las actas, el seguro y las normas están ahora en Documentos, en el menú de la izquierda. Ábrelos desde el móvil o el ordenador."
  }
}
```

- `kind`: `new` (something people can do now), `improved` (something works better) or `fixed` (a
  problem people noticed is gone). The window shows new things first, then improvements, then fixes.
- `audience`: `everyone`, or `admins` for the administration pages (only administrators see those
  notes).
- `icon` (optional): an icon of `frontend/src/icons.tsx`; without it, the icon of its kind.
- `link` (optional): a page of the app where it can be tried, the same for every community
  (`/documents`, `/admin/storage`; administration pages only in `admins` notes). The note then gets
  a **Take me there** button.
- `en`, `es`: a `title` (70 characters at most) saying what people can do now, and a `body` (300 at
  most) with one or two short sentences on what it means for them and where to find it.

Write for a neighbor, not a developer: everyday words, no technical ones (server, version, cache,
browser, API, upload limits…), "tú" in Spanish like the rest of the interface, one change per note.
Fixes only deserve a note when people noticed the problem. Dependency updates, refactoring, CI,
documentation and invisible fixes need none. The file name is the note's id: once released, never
rename or delete a note (people would see it again, or lose it from the list); correct its texts
instead. `src/whats-new/notes.test.ts` checks every note (name, date, fields, icon, link and both
languages), and the [release](#releases) on GitHub lists, in English, the notes added since the
previous release.

## Icons

Interface icons are SVG components in `frontend/src/icons.tsx` (a 24×24 canvas, 2-pixel strokes and
`currentColor`), so every platform shows the same shapes in both themes. Do not use emoji or Unicode
symbols as icons.

The favicon, Apple touch icon and Android icons are generated from `frontend/public/icon.svg` with
`npm run gen:icons` in `frontend/`, which needs Playwright's Chromium (or
`PLAYWRIGHT_CHANNEL=msedge`). It also draws the badge of push notifications in Android's status bar
(`icons/badge-96.png`), a white silhouette of the icon.

## Notification kinds

A kind of [notification](features.md#notifications) is declared once and told in both languages:

1. its name in `NotificationKind` (`src/juntia/contracts.py`), and in `KINDS`
   (`src/juntia/notifications.py`) who receives it (`everyone` or `administrators`) and the page it
   opens;
2. when it appears: a condition that `evaluate` brings up to date on every round of the notifier
   (as `statement_missing`), resolving it when the condition stops holding, or a call that creates
   it when something happens; `create` never makes the same one twice for an account (its `key`),
   and `queue` sends its push messages;
3. its push message in `push_text`, with the texts in `src/juntia/texts.py`;
4. its texts in `frontend/src/i18n/locales/*/notifications.ts` (`kinds.<kind>`: the title and text
   under the bell, the name and description of its switch) and in `TEXTS` of
   `frontend/src/notifications/notifications.tsx`;
5. the demo's handler (`frontend/src/demo/handlers/notifications.ts`) and the
   [features](features.md#notifications).

No migration is needed: notifications keep their kind and parameters, and accounts the kinds they
turned off.

## Dependencies

- Lockfiles (`uv.lock`, `frontend/package-lock.json`) reference the public PyPI and npm registries
  with integrity hashes. If your network needs a package mirror, never commit its URLs and never
  weaken TLS verification.
- `scripts/audit_dependencies.py` checks every locked package, development and test dependencies
  included, against the [OSV](https://osv.dev) database. It sends only public package names and
  versions. Any advisory, or an incomplete or unavailable answer, fails the check. The only
  exceptions are the temporary waivers listed in the script (`WAIVERS`), for advisories that have no
  fixed version yet: each one accepts a single advisory for a single locked version, gives the
  reason, and stops applying on its expiry date, when the check fails again until the dependency is
  fixed or the waiver is reviewed and renewed. Every run lists the advisories it waives (as warnings
  in GitHub Actions) and the waivers that no longer match one, to be removed.
- After upgrading `msw`, run `npx msw init` in `frontend/` so `public/mockServiceWorker.js` matches;
  a unit test fails otherwise.

## Continuous integration

**CI** (`.github/workflows/ci.yml`) runs on every pull request to `main`, on demand, and from the
publish workflow:

| Job | What it does |
| --- | --- |
| `backend` | Two [test groups](#test-groups) on PostgreSQL 18, with Tesseract installed for the test of OCR. Group 1 also runs the dependency audit, Ruff, mypy and the OpenAPI check. |
| `frontend` | Two shards of the browser tests, each building the app. Shard 1 also runs the API type check, lint and unit tests; shard 2 adds the WebKit checks and the Google sign-in tests. |
| `demo` | Builds the demo and runs its browser smoke test. |
| `docker` | Builds the production image, reads a picture with its OCR in English and Spanish, and smoke-tests it with Compose: health, an unauthenticated request refused, the administration account created once through `/api/auth/setup`, OCR available to the server, `python -m juntia.admins list` in the container and the web app. |
| `application` | The required check: it fails unless every other job succeeded, including when one was cancelled or skipped. |

A new push to a pull request cancels the CI run of its previous commit; that run then ends with a
failed `application` check.

## Supply chain

- Every action is pinned to a full commit SHA, with its version in a comment. Every workflow starts
  from `permissions: {}` and each job asks only for what it needs; checkouts never persist the token.
  No workflow uses `pull_request_target`, and pull requests from forks get no secrets.
- **CodeQL** (`codeql.yml`) analyzes Python, JavaScript/TypeScript and the workflows with the
  `security-extended` queries on pull requests, pushes to `main`, every Monday and on demand.
  Generated files are excluded (`.github/codeql/codeql-config.yml`).
- **Dependency review** (`dependency-review.yml`) fails pull requests that add a dependency with a
  high or critical vulnerability. It covers npm and GitHub Actions; Python is covered by the OSV
  audit, because the dependency graph does not read `uv.lock`.
- **Dependabot** (`.github/dependabot.yml`) proposes updates every Monday, after a 10-day cooldown,
  for uv, npm, GitHub Actions, the Dockerfile and the Compose files. Minor and patch updates are
  grouped per ecosystem; packages that must move together share a group; PostgreSQL major versions
  are ignored because existing data needs a dump and restore.
- Keep `node-version`, `python-version` and the uv version in `ci.yml` in step with the Dockerfile,
  and the CI PostgreSQL image in step with `docker-compose.yml`.

## Releases

Merging into `main` (except documentation-only changes) starts **Build and publish Docker image**
(`docker-deploy.yml`). It runs the complete CI again, then a `publish` job that runs only on `main`
and in the `release` environment, the only place holding the Docker Hub credentials. That job:

1. computes the CalVer version: `YYYYMMDD`, or `YYYYMMDD.02`, `YYYYMMDD.03`… for later releases on
   the same day;
2. builds the image from scratch, without the Actions cache, so nothing another job wrote to the
   cache can reach a published image;
3. pushes `drdonoso/juntia:latest` and `drdonoso/juntia:<version>`, with the version and build date
   baked in for `/api/version`;
4. creates a GitHub release with generated notes, headed by a *What's new* section in English with
   the [notes](#whats-new-notes) added since the previous release (`scripts/release_notes.py`; none
   when there are none, and the release is still published if the section cannot be written).

Releases never deploy to a server. See [releases and image tags](deployment.md#releases-and-image-tags).

## Development and test variables

These variables are for development and tests only. Never set them on a server.

| Variable | Used by | Meaning |
| --- | --- | --- |
| `TEST_DATABASE_URL` | pytest | Disposable PostgreSQL database named `juntia_test`; without it, tests use SQLite. |
| `PRIVATE_STATEMENT_PATH` | pytest | Path to a real statement, to check the parser locally against it. The test is skipped without it. Never commit the file or its contents. |
| `PRIVATE_STATEMENT_ROWS`, `PRIVATE_STATEMENT_FIRST_DATE`, `PRIVATE_STATEMENT_LAST_DATE`, `PRIVATE_STATEMENT_VALUE_DATE_DIFFERENCES` | pytest | Optional expectations for that private statement (row count, earliest and latest ISO booking dates, number of rows whose value date differs from the booking date); without them the test checks only generic invariants. |
| `E2E_PORT` | `npm run e2e` | Port of the synthetic test server (default 7889). |
| `E2E_FIRST_RUN_PORT` | `npm run e2e` | Port of the second synthetic test server, without accounts, for `first-run.spec.ts` (default `E2E_PORT` + 1). |
| `E2E_BASE_URL`, `E2E_ADMIN_EMAIL`, `E2E_ADMIN_PASSWORD` | `npm run e2e` | Run against an existing, isolated and empty deployment instead, signing in with one of its administrator accounts. |
| `E2E_GOOGLE` | `npm run e2e` | `true` runs `google.spec.ts` with the synthetic Google provider. |
| `PLAYWRIGHT_CHANNEL` | Playwright, `gen:icons` | Use an installed browser such as `msedge` or `chrome`. |
| `DEMO_E2E_PORT` | `npm run e2e:demo` | Port of the demo preview (default 4183). |
| `DEMO_E2E_BASE_URL` | `npm run e2e:demo` | Check a deployed demo, such as `https://demo.juntia.drdonoso.com`. |
| `VITE_DEMO` | Vite | Set to `1` by `frontend/.env.demo` in demo mode; never set it for production builds. |
