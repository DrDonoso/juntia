# Contributing to Juntia

Thank you for your interest in Juntia! Bug reports, fixes, translations,
documentation and ideas are all welcome.

Juntia is maintained in spare time, so replies can take a few days. For anything
bigger than a small fix, please
[open an issue](https://github.com/DrDonoso/juntia/issues/new/choose) first so we
can agree on the approach before you invest time in it.

## Contents

- [Ground rules](#ground-rules)
- [Project layout](#project-layout)
- [Prerequisites](#prerequisites)
- [Setting up](#setting-up)
- [Running locally](#running-locally)
- [Checks before opening a pull request](#checks-before-opening-a-pull-request)
- [Rules for changes](#rules-for-changes)
- [Commit messages](#commit-messages)
- [Pull requests](#pull-requests)
- [Reporting bugs and requesting features](#reporting-bugs-and-requesting-features)

## Ground rules

- This project follows the [Code of Conduct](CODE_OF_CONDUCT.md). By taking
  part, you agree to uphold it.
- **Report security vulnerabilities privately**, as described in the
  [security policy](SECURITY.md), never in public issues or pull requests.
- **Never share real data.** Juntia handles a community's bank statements and its
  residents' personal data. Do not add real statements, exported movements,
  backups, credentials, or screenshots showing real names, addresses, emails,
  phone numbers or IBANs to issues, pull requests, tests or fixtures. Use
  [synthetic data](#synthetic-data-only) instead.
- Write code, comments, commit messages, documentation and pull requests in
  English. Spanish belongs only in the Spanish translations.
- By contributing, you agree that your contributions are licensed under the
  [MIT License](LICENSE).

## Project layout

| Path | Contents |
| --- | --- |
| `src/juntia/` | FastAPI backend: application factory (`app.py`), API routes, SQLAlchemy models (`db.py`), settings (`config.py`), the bank-statement PDF parser (`parser.py`) and the import pipeline (`imports.py`) |
| `alembic/` | Database migrations, numbered in `alembic/versions/` |
| `tests/` | Backend tests (pytest) |
| `scripts/` | OpenAPI export, dependency audit and the synthetic server used by the browser tests |
| `frontend/src/` | React and TypeScript application |
| `frontend/src/i18n/` | Translation runtime and messages: `locales/en/` (the source of truth) and `locales/es/` |
| `frontend/src/api/` | API client, OpenAPI contract (`openapi.json`) and the types generated from it (`schema.gen.ts`) |
| `frontend/src/demo/` | Static demo: mock API handlers and synthetic data that run in the browser |
| `frontend/e2e/` | Playwright browser tests |
| `docs/` | Documentation, including the [security model](docs/security-model.md) |

## Prerequisites

- **Python 3.12 or newer.** Python 3.14 is the production baseline used by CI
  and the Docker image.
- **[uv](https://docs.astral.sh/uv/)**, which installs the Python dependencies
  from the committed `uv.lock`.
- **Node.js 26 and npm** for the frontend.
- **Docker** for PostgreSQL and the local Compose stack.

## Setting up

Fork the repository, clone your fork and install the locked dependencies:

```bash
git clone https://github.com/<your-user>/juntia.git
cd juntia
uv sync --locked --extra test    # creates .venv with the runtime and test dependencies
cd frontend
npm ci
npx playwright install chromium  # browser for the end-to-end tests
```

The commands in this guide use a POSIX shell. In Windows PowerShell, set
environment variables with `$env:NAME = "value"` before running a command.

## Running locally

### With Docker

The local Compose file builds the image from your checkout and runs it with its
own PostgreSQL database:

```bash
cp .env.example .env    # set POSTGRES_PASSWORD and AUTH_SECRET
docker compose -f docker-compose.local.yml up -d --build
```

Generate each secret with `openssl rand -hex 32`. Open
<http://localhost:7778>; the administration is at <http://localhost:7778/admin>
with the fixed local credentials `admin` / `admin`. This stack is only published
on `127.0.0.1`: never expose it through a proxy, tunnel or shared network. The
[README](README.md#deploy-with-docker) and [docs/deployment.md](docs/deployment.md)
cover server deployment, and [docs/configuration.md](docs/configuration.md)
describes every setting.

### With hot reload

Run the API with Uvicorn and the frontend with the Vite dev server, which
forwards `/api` to port 7778. The API needs a PostgreSQL database, for example a
throwaway container:

```bash
docker run -d --name juntia-dev-db -p 127.0.0.1:5433:5432 \
  -e POSTGRES_USER=juntia -e POSTGRES_PASSWORD=juntia-dev -e POSTGRES_DB=juntia \
  postgres:18-alpine

export DATABASE_URL=postgresql+asyncpg://juntia:juntia-dev@127.0.0.1:5433/juntia
export ADMIN_USERNAME=admin ADMIN_PASSWORD=admin ALLOW_INSECURE_LOCAL_ADMIN=true
export AUTH_SECRET="$(openssl rand -hex 32)"
export PUBLIC_ORIGIN=http://localhost:5173 AUTH_COOKIE_SECURE=false
uv run --no-sync alembic upgrade head
uv run --no-sync python seed.py
uv run --no-sync uvicorn juntia.app:app --reload --reload-dir src --port 7778
```

In a second terminal, start Vite and open <http://localhost:5173> (the
administration is at `/admin`, with `admin` / `admin`):

```bash
cd frontend
npm run dev
```

The static demo needs no backend: run `npm run dev:demo` in `frontend` to work
on it. [docs/demo.md](docs/demo.md) explains how it works.

## Checks before opening a pull request

CI runs these checks on every pull request. Running them locally first saves a
round trip. [docs/development.md](docs/development.md) describes the test suites,
their options and CI in more detail.

### Backend

From the repository root:

```bash
uv run --no-sync pytest -q
uv run --no-sync ruff check src tests scripts alembic seed.py
uv run --no-sync mypy
uv run --no-sync python scripts/export_openapi.py --check
```

Without `TEST_DATABASE_URL`, every test uses its own temporary SQLite database.
CI runs the suite on PostgreSQL 18, which also enables a few concurrency tests
that SQLite skips. To do the same, point `TEST_DATABASE_URL` at a **disposable**
PostgreSQL database named `juntia_test`. The fixtures drop and recreate every
table, refuse any other database name, and must not run in parallel against the
same database. Never point it at a database with real data.

```bash
docker run -d --name juntia-test-db -p 127.0.0.1:5432:5432 \
  -e POSTGRES_PASSWORD=juntia-test -e POSTGRES_DB=juntia_test postgres:18-alpine
TEST_DATABASE_URL=postgresql+asyncpg://postgres:juntia-test@127.0.0.1:5432/juntia_test \
  uv run --no-sync pytest -q
```

If you change Python or npm dependencies, commit the updated `uv.lock` or
`frontend/package-lock.json`, and run
`uv run --no-sync python scripts/audit_dependencies.py`, which checks the locked
versions against the OSV vulnerability database.

### Frontend

From `frontend/`:

```bash
npm run gen:api -- --check   # schema.gen.ts matches openapi.json
npm run lint
npm test                     # unit tests (Vitest)
npm run build
npm run e2e                  # browser tests against the build
npm run build:demo           # the static demo, into dist-demo/
npm run e2e:demo             # browser tests of the built demo
```

`npm run e2e` tests the output of the last `npm run build`, served by a
disposable server with synthetic data that runs from the repository's `.venv` on
port 7889 (set `E2E_PORT` to change it). In the same way, `npm run e2e:demo`
tests the output of the last `npm run build:demo` and refuses to run without it.
Run a single file with `npm run e2e -- events.spec.ts`. If Playwright cannot
download its browser, set `PLAYWRIGHT_CHANNEL=msedge` or
`PLAYWRIGHT_CHANNEL=chrome` to use an installed one.

## Rules for changes

### Translations

The interface is available in English (the default) and Spanish.

- Every user-facing string goes through the i18n layer in `frontend/src/i18n/`:
  `useI18n().t('namespace.key')` in components and `t()` elsewhere. This includes
  `aria-label`, `title`, `placeholder` and `alt` texts. Never hard-code text.
- Add every key to both `frontend/src/i18n/locales/en/<namespace>.ts` (the source
  of truth) and `frontend/src/i18n/locales/es/<namespace>.ts`. TypeScript and the
  parity test in `frontend/src/i18n/i18n.test.tsx` fail when keys, plural forms
  or placeholders differ, or when a message is empty.
- Never hard-code a locale such as `'es-ES'`. Format numbers, dates, money and
  sorting with the locale-aware helpers from `frontend/src/i18n/` and
  `frontend/src/shared.tsx`, which follow the active language.
- Put links and emphasis inside messages with `rich()`; never use
  `dangerouslySetInnerHTML`.
- A new API error code needs a message under `codes` in both
  `locales/en/errors.ts` and `locales/es/errors.ts`.
- Server-generated texts, such as emails and first-run defaults, exist in English
  and Spanish and follow the `APP_LANGUAGE` setting: update both.

### API changes

The frontend types are generated from the backend's OpenAPI contract, and CI
fails when a generated file is stale. After changing routes, request or response
models, or error responses, regenerate both files and commit them; never edit
them by hand:

```bash
uv run --no-sync python scripts/export_openapi.py   # frontend/src/api/openapi.json
cd frontend && npm run gen:api                       # frontend/src/api/schema.gen.ts
```

### Database changes

Every schema change needs a new Alembic migration in `alembic/versions/`, named
`NNNN_short_description.py`, with `revision` set to the next number and
`down_revision` to the previous one. Implement both `upgrade()` and
`downgrade()`; when a downgrade would destroy data, make it refuse with a clear
message, as the existing migrations do. Migrations must work on PostgreSQL and
SQLite. Keep the models in `src/juntia/db.py` in sync and add migration tests
like the existing `tests/test_*_migration.py`.

### The demo

The [public demo](https://demo.juntia.drdonoso.com) is the same frontend with a
mock API that runs in the browser (`frontend/src/demo/`). Every API operation
needs a demo handler that mirrors the backend's behavior and error codes, or an
explicit entry marking it as unavailable in the demo. A unit test fails when an
operation in `openapi.json` has neither.

### Synthetic data only

Tests, fixtures, demo data, screenshots and examples must be fictitious:

- invented names and addresses, never real people or communities;
- email addresses under `example.com` or `example.org`;
- phone numbers from the UK fiction range `+44 20 7946 0000` to
  `+44 20 7946 0999`;
- IBANs with a valid checksum on the non-existent bank code `9999`;
- statement PDFs generated by the tests themselves. Git ignores `*.pdf` so that
  real statements cannot be committed by accident.

### Security

Keep the [security model](docs/security-model.md) in mind: the separation
between residents and the administrator, origin and anti-CSRF checks on every
mutation, request size limits, and private storage of statements and
attachments. Never weaken these controls, never log personal or financial data,
and update the security model when a change affects it.

## Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/) in English:
`<type>(<optional scope>): <summary>`, with the summary in the imperative mood
and without a final period. Common types are `feat`, `fix`, `docs`, `refactor`,
`test`, `ci` and `chore`. Use the body to explain why the change is needed.

```text
fix(imports): reject statements from a different account
```

## Pull requests

- Create a branch from an up-to-date `main` in your fork.
- Keep each pull request focused on one change; open separate pull requests for
  unrelated fixes or refactorings.
- Add or update tests and documentation, including `.env.example` for new
  settings.
- Fill in the pull request template: what changed, why, the related issue, and
  how you validated it (the commands you ran and any manual checks).
- For interface changes, add screenshots or a short recording that use
  synthetic data only, ideally in both languages when text changes.
- All CI checks must pass before a pull request can be merged, and the
  maintainer may ask for changes first.

## Reporting bugs and requesting features

Search the [existing issues](https://github.com/DrDonoso/juntia/issues) first,
then [open a new issue](https://github.com/DrDonoso/juntia/issues/new/choose) with
the bug report or feature request template. You can try the
[live demo](https://demo.juntia.drdonoso.com) to check whether a problem also
happens there. Remove personal and financial data from logs and screenshots
before posting them, and report security vulnerabilities privately as described
in the [security policy](SECURITY.md).
