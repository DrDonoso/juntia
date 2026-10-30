# Configuration

Juntia is configured with environment variables. This page documents every variable the
application, the Compose files and the image read, with defaults and validation rules. Settings
that live in the database, such as the feature switches, are managed in the administration instead
(see [Settings that are not environment variables](#settings-that-are-not-environment-variables)).

## Contents

- [How settings are read](#how-settings-are-read)
- [Quick reference](#quick-reference)
- [Required settings](#required-settings)
- [Origins, cookies and proxies](#origins-cookies-and-proxies)
- [Network and image](#network-and-image)
- [Language and time zone](#language-and-time-zone)
- [Storage limits](#storage-limits)
- [Email (SMTP)](#email-smtp)
- [Google sign-in](#google-sign-in)
- [AI classification](#ai-classification)
- [Sessions and import previews](#sessions-and-import-previews)
- [Set by Compose or the image](#set-by-compose-or-the-image)
- [Local Compose only](#local-compose-only)
- [Settings that are not environment variables](#settings-that-are-not-environment-variables)
- [Applying changes](#applying-changes)
- [Development and test variables](#development-and-test-variables)

## How settings are read

- **With Docker Compose**, Compose reads `.env` next to `docker-compose.yml` and substitutes its values
  into the Compose file. Only the variables the Compose file passes to a service reach the
  container: `.env` itself is never copied into the image.
- **Outside Docker**, the application reads its environment and, if present, a `.env` file in its
  working directory; real environment variables win over `.env` entries.
- Names are case-insensitive for the application, but write them in upper case as shown.
- Invalid values stop the application at startup with an explanatory error, without echoing
  secrets. Fix the value and start it again.
- Copy [`.env.example`](../.env.example) to `.env`, keep it out of version control and readable only
  by the deployment owner (`chmod 600 .env`). Environment variables are not an encrypted secret
  store: privileged users of the host can read them.

## Quick reference

| Variable | Default | Section |
| --- | --- | --- |
| `POSTGRES_PASSWORD` | required | [Required settings](#required-settings) |
| `AUTH_SECRET` | required | [Required settings](#required-settings) |
| `ADMIN_USERNAME` | required (`admin` in `.env.example`) | [Required settings](#required-settings) |
| `ADMIN_PASSWORD` | required | [Required settings](#required-settings) |
| `PUBLIC_ORIGIN` | required by the server Compose file (`http://localhost:7778` in `.env.example`) | [Origins, cookies and proxies](#origins-cookies-and-proxies) |
| `AUTH_COOKIE_SECURE` | `true` (`false` in `.env.example`) | [Origins, cookies and proxies](#origins-cookies-and-proxies) |
| `TRUSTED_PROXY_IPS` | `127.0.0.1` | [Origins, cookies and proxies](#origins-cookies-and-proxies) |
| `APP_BIND_ADDRESS` | `127.0.0.1` | [Network and image](#network-and-image) |
| `APP_PORT` | `7778` | [Network and image](#network-and-image) |
| `IMAGE_TAG` | `latest` | [Network and image](#network-and-image) |
| `APP_LANGUAGE` | `en` | [Language and time zone](#language-and-time-zone) |
| `TZ` | `Europe/Madrid` | [Language and time zone](#language-and-time-zone) |
| `ACTION_STORAGE_USER_QUOTA_MB` | `250` | [Storage limits](#storage-limits) |
| `ACTION_STORAGE_COMMUNITY_QUOTA_MB` | `2048` | [Storage limits](#storage-limits) |
| `MIN_FREE_DISK_MB` | `1024` | [Storage limits](#storage-limits) |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURITY`, `SMTP_USERNAME`, `SMTP_PASSWORD`, `SMTP_FROM`, `SMTP_TIMEOUT` | email off | [Email (SMTP)](#email-smtp) |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google off | [Google sign-in](#google-sign-in) |
| `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_MODEL` | AI off | [AI classification](#ai-classification) |
| `SESSION_HOURS`, `PREVIEW_HOURS` | `12`, `24` | [Sessions and import previews](#sessions-and-import-previews) |
| `DATABASE_URL`, `UPLOAD_DIR`, `BUILD_DATE` | set for you | [Set by Compose or the image](#set-by-compose-or-the-image) |
| `LOCAL_PUBLIC_ORIGIN`, `ALLOW_INSECURE_LOCAL_ADMIN` | local stack only | [Local Compose only](#local-compose-only) |

## Required settings

| Variable | Description and rules |
| --- | --- |
| `POSTGRES_PASSWORD` | Password of the `juntia` database role. Compose inserts it into the database URL, so it must be URL-safe: generate it with `openssl rand -hex 32` (or `python3 -c "import secrets; print(secrets.token_hex(32))"`). It only initializes a **new** database volume; to change it later, change the role's password in PostgreSQL as well (`ALTER ROLE juntia PASSWORD '…'`) before updating `.env`. |
| `AUTH_SECRET` | Secret that binds session, invitation, recovery and Google sign-in tokens. At least 32 characters; generate it like the database password. Changing it signs everyone out and invalidates pending invitation and recovery links. Rotate it when you restore a backup. |
| `ADMIN_USERNAME` | Username of the technical administrator (`/admin`). 1 to 150 characters; surrounding spaces are removed. It is never shown to residents: content the administrator writes appears as "Technical administrator". |
| `ADMIN_PASSWORD` | Password of the technical administrator. At least 15 characters and at most 72 UTF-8 bytes (bcrypt's limit; longer passwords are rejected, never truncated). Placeholders starting with `changeme` or `replace-me` are refused. There are no default credentials and no setup page. |
| `PUBLIC_ORIGIN` | The browser origin(s) of the deployment. See [Origins, cookies and proxies](#origins-cookies-and-proxies). |

## Origins, cookies and proxies

| Variable | Default | Description and rules |
| --- | --- | --- |
| `PUBLIC_ORIGIN` | required by `docker-compose.yml` (`http://localhost:7778` in `.env.example`, which serves the server itself) | One origin, or a comma-separated list such as `https://juntia.example.com,https://juntia.internal.example.com` (not a JSON array). |
| `AUTH_COOKIE_SECURE` | `true` (`false` in `.env.example`) | Marks the session cookies `Secure` and sends `Strict-Transport-Security`. While it is `true`, **every** `PUBLIC_ORIGIN` entry must use HTTPS. Set `false` only for plain HTTP on the server itself (`http://localhost`, as in `.env.example`) or for local development; keep `true` whenever residents use HTTPS addresses. |
| `TRUSTED_PROXY_IPS` | `127.0.0.1` | Reverse proxies whose `X-Forwarded-For` and `X-Forwarded-Proto` headers are trusted: a comma-separated list of IP addresses or CIDR networks (for example `172.18.0.1` or `10.0.0.0/24`). |

**`PUBLIC_ORIGIN` rules.** Spaces around entries and a trailing `/` are accepted. Scheme and hostname
are normalized to lower case (internationalized names to their ASCII form), default ports (80 and
443) are removed and duplicates are dropped, keeping the first occurrence. Non-default ports are
significant. Each entry must be a plain `http` or `https` origin: empty entries, invalid hostnames
or ports, user names or passwords, wildcards, paths, query strings and fragments stop the startup.
IPv6 addresses go in brackets (`http://[::1]:7778`).

What the list does:

- Requests whose `Host` header is not one of the listed hostnames are rejected with
  `400 invalid_host`. The loopback names `localhost`, `127.0.0.1` and `::1` are always accepted as
  well, on every route (they serve the container's health check and local access).
- Every `POST`, `PUT`, `PATCH` and `DELETE` must carry exactly one `Origin` header that equals a
  listed origin (scheme, hostname and port) plus `X-Juntia-Request: 1`, or it is rejected with
  `403 invalid_origin`.
- The **first** entry is the canonical address used in invitation and password recovery emails.
- Every listed origin serves the same community and database. Cookies are host-only, so people sign
  in separately on each hostname. Adding an origin does not invalidate existing sessions.

The list is not a bind address and grants no permission by itself: sign-in and authorization still
apply to every request, and there is no CORS.

**`TRUSTED_PROXY_IPS` rules.** The value is passed to Uvicorn's `--forwarded-allow-ips`. It must
contain the address the **container** sees for your reverse proxy:

- a proxy on the same host, connecting to the published port, appears as the gateway of the Compose
  network (find it with `docker network inspect juntia_default --format '{{range .IPAM.Config}}{{.Gateway}}{{end}}'`),
  not as `127.0.0.1`;
- a proxy on another machine appears with that machine's address.

When the proxy is not trusted, the forwarded headers are ignored: every visitor appears to come from
the proxy, so all of them share one sign-in throttling budget, and Google sign-in fails because the
callback looks like plain HTTP. Never use `*`, and do not trust addresses that untrusted clients can
connect from. Malformed entries are ignored silently rather than reported, so double-check the
value. More in [the deployment guide](deployment.md#trusted-proxies).

## Network and image

These variables are read by Docker Compose, not by the application.

| Variable | Default | Description |
| --- | --- | --- |
| `APP_BIND_ADDRESS` | `127.0.0.1` | Host address the app port is published on (server Compose file: `${APP_BIND_ADDRESS:-127.0.0.1}:${APP_PORT:-7778}:7778`). The default lets only processes on the same host, such as a local reverse proxy, reach Juntia. Set `0.0.0.0` (all interfaces) or a LAN address when the reverse proxy runs on another machine or in a container that cannot reach the host's loopback, and restrict the port with a firewall so nobody can bypass the proxy. The local Compose file always uses `127.0.0.1`. |
| `APP_PORT` | `7778` | Host port. The container always listens on 7778. |
| `IMAGE_TAG` | `latest` | Tag of `drdonoso/juntia` that the server Compose file runs. Pin a CalVer release such as `20261029` for controlled updates; see [releases and image tags](deployment.md#releases-and-image-tags). |

The database is never published: only the `api` service can reach it, on the Compose network.

## Language and time zone

| Variable | Default | Description and rules |
| --- | --- | --- |
| `APP_LANGUAGE` | `en` | Language of the texts the **server** writes: `en` (English) or `es` (Spanish). Case-insensitive; an empty value means `en`; any other value stops the startup ("APP_LANGUAGE must be en or es"). |
| `TZ` | `Europe/Madrid` | The community's [IANA time zone](https://en.wikipedia.org/wiki/List_of_tz_database_time_zones), such as `Europe/London`. An unknown zone stops the startup. |

`APP_LANGUAGE` affects:

- invitation and password recovery emails (subject, body and `Content-Language` header);
- the defaults created on the **first start of a new installation**: 13 categories, 6 tags and the
  community name ("Residential community"), and the account name given on the first statement
  import ("Community account");
- fallback labels in API responses, such as "Uncategorized" and "No merchant" in the summary and
  "Technical administrator" as the author of content the administrator writes (the web interface
  shows these in each reader's own language);
- the description and language of the web app manifest used for home-screen installation.

It never renames existing data: categories, tags or names created earlier keep their text. It does
not choose the interface language either: the web app follows each browser's language (English when
it is neither English nor Spanish), and everyone can switch it from the user menu or the sign-in
screens; the choice is kept in that browser. `python seed.py` also reads `APP_LANGUAGE`; the
browser-test server takes `--language en|es` instead (`scripts/smoke_server.py`).

`TZ` controls how event dates and times are entered and shown, including daylight-saving changes,
whatever the time zone of each visitor's device. Timed events are stored as instants and all-day
events as dates, so changing `TZ` later changes their presentation, not the stored values. Local
times that do not exist or happen twice at a daylight-saving change are rejected with a field error.

## Storage limits

| Variable | Default | Description and rules |
| --- | --- | --- |
| `ACTION_STORAGE_USER_QUOTA_MB` | `250` | Storage each resident may use for the PDFs they attach to actions. |
| `ACTION_STORAGE_COMMUNITY_QUOTA_MB` | `2048` | Storage for all action PDFs together, the technical administrator's included (the administrator has no budget of their own). |
| `MIN_FREE_DISK_MB` | `1024` | Free space to keep on the uploads volume. Action PDF uploads and statement imports that would leave less are refused. |

All three are whole numbers of MiB (1 MiB = 1,048,576 bytes) between 1 and 1,073,741,824; any other
value stops the startup. Every stored action PDF counts, active or withdrawn, until the
administrator deletes it permanently (purges it) in **Settings > Storage**. A refused upload writes
nothing. Details, error codes and the purge are in the [deployment guide](deployment.md#storage-quotas-and-purging) and the
[security model](security-model.md#storage-quotas-and-retention).

Lowering a quota below the current usage is allowed: new uploads are then refused until enough
withdrawn PDFs are purged.

## Email (SMTP)

Email sends invitations, re-invitations after an email change, and password recovery links. Leave
`SMTP_HOST` and `SMTP_FROM` empty to turn it off: everything else keeps working, but inviting a
resident reports that email is not configured.

| Variable | Default | Description and rules |
| --- | --- | --- |
| `SMTP_HOST` | empty | SMTP server hostname, without spaces. Required together with `SMTP_FROM`. |
| `SMTP_PORT` | `587` | 1 to 65535. Usually 587 with `starttls` and 465 with `tls`. |
| `SMTP_SECURITY` | `starttls` | `starttls`, `tls` (implicit TLS) or `none`. Certificates are verified. `none` (plain text) is only accepted for a loopback SMTP server on a local HTTP deployment with non-Secure cookies. |
| `SMTP_USERNAME`, `SMTP_PASSWORD` | empty | Set both or neither; a TLS-protected relay that needs no authentication can omit both. |
| `SMTP_FROM` | empty | Sender mailbox, such as `community@example.com`. A bare address, not `Name <address>`. |
| `SMTP_TIMEOUT` | `10` | Seconds per SMTP operation, 1 to 60. |

Delivery failures are logged without addresses, tokens or passwords. "Accepted by SMTP" in the
administration means the server accepted the message, not that it reached the inbox.

## Google sign-in

Optional, invitation-only Google sign-in. Leave both values empty to keep password-only sign-in.

| Variable | Default | Description and rules |
| --- | --- | --- |
| `GOOGLE_CLIENT_ID` | empty | OAuth client ID of type **Web application**, ending in `.apps.googleusercontent.com`. |
| `GOOGLE_CLIENT_SECRET` | empty | Its client secret, without spaces. Never commit it. |

Both are required together, and every `PUBLIC_ORIGIN` must use HTTPS (HTTP is allowed only on
loopback). In the Google Cloud console, register `<origin>/api/auth/google/callback` as an
authorized redirect URI for **each** origin, for example
`https://juntia.example.com/api/auth/google/callback`. See [Google sign-in](features.md#google-sign-in)
for the behavior.

## AI classification

Optional classification suggestions during statement imports. AI is enabled only when both
`OPENAI_API_KEY` and `OPENAI_MODEL` are set.

| Variable | Default | Description |
| --- | --- | --- |
| `OPENAI_API_KEY` | empty | API key of the provider. |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | Base URL of any OpenAI-compatible API that supports chat completions with JSON output. |
| `OPENAI_MODEL` | empty | Model name. |

The provider receives sanitized transaction descriptions and the names of your categories and tags,
never the PDF, the IBAN, the amounts or the balances. Sanitizing is not anonymization: read
[AI classification](importing-statements.md#ai-classification) before turning it on.

## Sessions and import previews

| Variable | Default | Description and rules |
| --- | --- | --- |
| `SESSION_HOURS` | `12` | Lifetime of resident and administrator sessions, 1 to 168 hours. |
| `PREVIEW_HOURS` | `24` | Lifetime of an unconfirmed statement import preview, 1 to 168 hours. |

The Compose files do not pass these two variables to the container. To change them, add them to the
`environment` of the `api` service.

## Set by Compose or the image

| Variable | Value | Description |
| --- | --- | --- |
| `DATABASE_URL` | `postgresql+asyncpg://juntia:${POSTGRES_PASSWORD}@db:5432/juntia` | SQLAlchemy URL of the database, built by the Compose files. Required when running outside Compose; it must use an async driver (`postgresql+asyncpg://`). |
| `UPLOAD_DIR` | `/app/data/uploads` (application default: `data/uploads`) | Where statement originals and import previews (top level) and action PDFs (`actions/`) are stored: the `uploads` volume. |
| `IMAGE_TAG`, `BUILD_DATE` | set when the image is built | Reported by `/api/version`. Outside an image, the version is `development`. |

The database service uses the fixed role and database name `juntia`.

## Local Compose only

`docker-compose.local.yml` builds the image from your checkout for local trials and development.

| Variable | Default | Description and rules |
| --- | --- | --- |
| `LOCAL_PUBLIC_ORIGIN` | `http://localhost:7778` | Passed to the application as `PUBLIC_ORIGIN`. A comma-separated list is accepted, but every entry must use HTTP and the hostname `localhost`, `127.0.0.1` or `[::1]`. If you change `APP_PORT`, include the new port here. |
| `ALLOW_INSECURE_LOCAL_ADMIN` | `false` (the local Compose file sets `true`) | Exempts exactly `admin` / `admin` from the administrator password rules. It requires every origin to be loopback HTTP and `AUTH_COOKIE_SECURE=false`, and nothing else is relaxed. Never set it on a server. |

The local Compose file always signs in the administrator with `admin` / `admin`, uses non-Secure
cookies over HTTP and publishes the port on `127.0.0.1` only. Never expose it through a proxy,
tunnel or shared network.

## Settings that are not environment variables

These are stored in the database, survive restarts and backups, and are changed by the technical
administrator without restarting anything:

- **Features** (`/admin/features`): ownership coefficients, Actions and Events. Older
  `FEATUREFLAG_*` environment variables are no longer read and can be removed from `.env`.
- **General** (`/admin/general`): the community name.
- The bank account's display name, in **Finances > Import**.
- Dwellings, users, the presidency, categories, tags, rules and labels.

See [docs/features.md](features.md#administration).

## Applying changes

Compose passes the environment when it **creates** a container, so a plain restart keeps the old
values. After editing `.env`, recreate the application container:

```sh
docker compose up -d --no-deps --force-recreate api
```

`docker compose up -d` also recreates the containers whose configuration changed. Before changing
origins or credentials on a production server, keep a protected copy of the current `.env` and note
the running image, so you can roll back both together (see
[updating and rolling back](deployment.md#updating)).

## Development and test variables

The test suites and development tools use a few more variables (`TEST_DATABASE_URL`,
`PRIVATE_STATEMENT_PATH`, `E2E_*`, `DEMO_E2E_*`, `PLAYWRIGHT_CHANNEL` and the demo's `VITE_DEMO`).
They are described in [docs/development.md](development.md#development-and-test-variables) and must
never be set on a server.
