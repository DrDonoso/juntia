# Deployment

How to run Juntia on a server with Docker Compose, keep it up to date, back it up and operate its
storage. Every setting is described in [configuration.md](configuration.md); the protections the
deployment relies on are explained in the [security model](security-model.md).

## Contents

- [Requirements](#requirements)
- [Installing](#installing)
- [What happens at startup](#what-happens-at-startup)
- [Reverse proxy and HTTPS](#reverse-proxy-and-https)
  - [Trusted proxies](#trusted-proxies)
  - [Examples](#examples)
  - [Access policies](#access-policies)
- [Several hostnames](#several-hostnames)
- [Request limits](#request-limits)
- [After the first start](#after-the-first-start)
- [Releases and image tags](#releases-and-image-tags)
- [Updating](#updating)
  - [Rolling back](#rolling-back)
- [Backup and restore](#backup-and-restore)
- [Migration notes](#migration-notes)
- [Storage quotas and purging](#storage-quotas-and-purging)
- [Troubleshooting](#troubleshooting)

## Requirements

- A server with Docker Engine and the Docker Compose plugin. The published image is built for
  `linux/amd64`.
- On its own, Juntia serves `http://localhost:7778` on the server itself. To open it from other
  devices or the Internet, you also need a domain name and a reverse proxy that terminates HTTPS:
  the session cookies must then be `Secure` (`AUTH_COOKIE_SECURE=true`), which requires every
  configured origin to use `https`.
- Disk space for two named volumes: `pgdata` (PostgreSQL) and `uploads` (statement originals and
  community action PDFs). Action PDFs are capped by the
  [storage quotas](#storage-quotas-and-purging) (2 GiB for the community by default), and uploads
  keep 1 GiB free on the volume by default.
- Optional: an SMTP account (needed to invite residents and recover passwords), a Google OAuth web
  client, and an OpenAI-compatible API.

## Installing

1. Create a directory and download the Compose file and the environment template:

   ```sh
   mkdir juntia && cd juntia
   curl -fsSLO https://raw.githubusercontent.com/DrDonoso/juntia/main/docker-compose.yml
   curl -fsSL https://raw.githubusercontent.com/DrDonoso/juntia/main/.env.example -o .env
   chmod 600 .env
   ```

   The Compose file names the project `juntia`, so the volumes are `juntia_pgdata` and
   `juntia_uploads` and the network is `juntia_default`, whatever the directory is called.

2. Edit `.env`. Generate `POSTGRES_PASSWORD` and `AUTH_SECRET` with `openssl rand -hex 32` (two
   different values), choose `ADMIN_USERNAME` and an `ADMIN_PASSWORD` of at least 15 characters, and
   set `APP_LANGUAGE` (`en` or `es`) and `TZ`. The default `PUBLIC_ORIGIN=http://localhost:7778`
   with `AUTH_COOKIE_SECURE=false` serves the server itself. To open Juntia from other devices, set
   `PUBLIC_ORIGIN` to the HTTPS address residents will open, `AUTH_COOKIE_SECURE=true` and
   `APP_BIND_ADDRESS` (see [trusted proxies](#trusted-proxies)). Pin `IMAGE_TAG` to a
   [release](#releases-and-image-tags) for controlled updates. Leave SMTP, Google and AI empty
   until you need them.

3. Start the stack and check it:

   ```sh
   docker compose up -d
   docker compose ps                   # the api service becomes "healthy"
   docker compose logs --tail=100 api
   curl -fsS http://127.0.0.1:7778/health
   ```

   `/health` answers `{"status":"ok"}` once the database is initialized, and `/api/version` returns
   the image tag and build date. Use the address and port you published if they differ.

4. Open `http://localhost:7778` on the server, or configure the
   [reverse proxy](#reverse-proxy-and-https) to open Juntia from other devices. Then follow
   [after the first start](#after-the-first-start).

## What happens at startup

The container runs as the unprivileged user `app` (uid 1000) with `no-new-privileges` and a
restrictive `umask`, so the files it writes are private. On every start it:

1. applies the database migrations (`alembic upgrade head`);
2. on the first start of a new installation only, creates the default categories, tags and
   community name in `APP_LANGUAGE` (existing data is never renamed);
3. removes expired import previews, then serves the API and the web app with Uvicorn on port 7778,
   with access logs disabled.

PostgreSQL is reachable only from the `api` service on the Compose network; its port is never
published. Docker checks `/health` every 15 seconds.

## Reverse proxy and HTTPS

Put an HTTPS reverse proxy in front of Juntia and proxy every path (the web app, `/api`, `/assets`,
`/icons`, `/fonts` and `/manifest.webmanifest`) to the published port. The proxy must:

- **keep the original `Host` header.** Juntia answers `400 invalid_host` to hostnames that are not
  in `PUBLIC_ORIGIN` (other than the loopback names), and it ignores `X-Forwarded-Host`;
- **send `X-Forwarded-For` and `X-Forwarded-Proto`**, and be listed in
  [`TRUSTED_PROXY_IPS`](#trusted-proxies);
- **pass the `Origin` and `X-Juntia-Request` headers unchanged**: every change is rejected without
  them;
- **accept request bodies of at least 21 MiB.** PDFs may be 20 MiB, sent in a multipart envelope of
  up to 20 MiB plus 64 KiB. nginx allows only 1 MiB by default;
- **not cache responses.** Juntia sends `Cache-Control: no-store`; do not override it with a CDN or
  proxy cache rule;
- **not log query strings or sensitive headers.** URLs can contain search terms and the Google
  sign-in callback carries one-time codes. Juntia itself keeps no access log; redact these in the
  proxy's logs too.

The usual 60-second proxy timeouts are enough: parsing a statement is limited to 45 seconds and each
AI request to 30 seconds.

### Trusted proxies

Uvicorn trusts `X-Forwarded-For` and `X-Forwarded-Proto` only from the addresses in
`TRUSTED_PROXY_IPS` (comma-separated IP addresses or CIDR networks; default `127.0.0.1`). What
matters is the address the **container** sees, and with Docker that is rarely `127.0.0.1`:

| Where the proxy runs | `APP_BIND_ADDRESS` | Proxy target | `TRUSTED_PROXY_IPS` |
| --- | --- | --- | --- |
| On the same host (installed directly, such as Caddy, nginx or `cloudflared`) | `127.0.0.1` (default) | `http://127.0.0.1:7778` | The gateway of the `juntia_default` network, for example `172.18.0.1` |
| On another machine | `0.0.0.0` or the server's LAN address, with a firewall rule that admits only the proxy | `http://<server address>:7778` | The proxy machine's address |
| In a container on the same host, joined to the `juntia_default` network | `127.0.0.1` (the proxy does not use the published port) | `http://api:7778` | The subnet of `juntia_default`, for example `172.18.0.0/16` |

For a proxy in a container, joining Juntia's network (declare `juntia_default` as an `external`
network in the proxy's Compose file) gives it a stable, private path. A container can also reach
Juntia through the host, with `APP_BIND_ADDRESS=0.0.0.0` or a LAN address and a firewall rule, as
`.env.example` describes; then trust the address its connections arrive from, which depends on your
Docker networking.

Find the gateway and subnet of the Compose network with:

```sh
docker network inspect juntia_default --format '{{range .IPAM.Config}}{{.Subnet}} {{.Gateway}}{{end}}'
```

If the proxy is not trusted, the forwarded headers are ignored silently: every visitor appears to
come from the proxy, so they all share one sign-in throttling budget, and Google sign-in fails after
returning from Google because the callback looks like plain HTTP. Never use `*`.

`docker compose down` deletes the network, and the next `up` may give it a different address. Check
the value again after recreating the network, or pin the subnet with a
`docker-compose.override.yml` next to `docker-compose.yml` (Compose merges it automatically):

```yaml
networks:
  default:
    ipam:
      config:
        - subnet: 172.30.78.0/24   # pick an unused private range; the gateway is 172.30.78.1
```

When you publish the port beyond loopback, also restrict it with a firewall: otherwise anyone who
reaches the port can bypass the proxy and any access policy in front of it.

### Examples

**Caddy** on the same host obtains certificates automatically and sends the forwarded headers:

```caddyfile
juntia.example.com {
    reverse_proxy 127.0.0.1:7778
}
```

**nginx** on the same host (certificate settings omitted):

```nginx
server {
    listen 443 ssl;
    server_name juntia.example.com;
    client_max_body_size 21m;

    location / {
        proxy_pass http://127.0.0.1:7778;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

**Cloudflare Tunnel**, Nginx Proxy Manager, Traefik and other proxies work the same way: point them
at the published port (or at `api:7778` from a container joined to `juntia_default`), keep the
`Host` header, allow 21 MiB bodies and add their address to `TRUSTED_PROXY_IPS`.

After editing `.env`, recreate the application container with
`docker compose up -d --no-deps --force-recreate api`.

### Access policies

An external access policy (a VPN, Cloudflare Access, an authenticating proxy) can add defense in
depth, but it does not replace Juntia's own sign-in. If you use one, protect **every** hostname in
`PUBLIC_ORIGIN` entirely, including `/api` and document downloads, and make sure nobody can reach
the published port directly. The web app manifest is requested with credentials, so an access
gate can authorize it.

## Several hostnames

`PUBLIC_ORIGIN` accepts a comma-separated list, for example a public and an internal address:

```dotenv
PUBLIC_ORIGIN=https://juntia.example.com,https://juntia.internal.example.com
```

- Every hostname serves the same community and database, without redirects between them.
- Session cookies are host-only, so people sign in separately on each hostname. Adding a hostname
  does not invalidate existing sessions.
- Invitation and recovery emails always link to the **first** origin.
- Google sign-in needs one authorized redirect URI per origin
  (`<origin>/api/auth/google/callback`), including any non-default port.
- An access policy must protect every hostname.

Before changing the list on a live server, keep a protected copy of `.env`, note the running image,
change the list and recreate only `api`
(`docker compose up -d --no-deps --force-recreate api`). Check `/health` and sign in through every
hostname. To roll back, restore the previous `.env` and recreate `api` again. The database and its
volumes are not involved.

## Request limits

Juntia bounds what it receives before doing any work:

- **Body sizes per operation:** 16 KiB for sign-in and account-access requests, 32 KiB to start
  Google sign-in, 512 KiB for ordinary JSON, 12 MiB for the dwelling layout, and 20 MiB plus 64 KiB
  for PDF uploads and import confirmations. Each PDF is limited to exactly 20 MiB. Declared lengths
  are checked first and bytes are counted while receiving, also without `Content-Length`.
- **Early authorization:** changes to the administration, actions and events check the session
  (and the Actions or Events switch) before receiving the body.
- **Temporary storage:** bodies above 64 KiB are spooled to a temporary file inside the container
  and replayed in 64 KiB chunks. Receiving a body must finish within 30 seconds.
- **Concurrency:** the application admits at most 16 concurrent changes, 4 per client address and 4
  with a large body. Beyond that it answers `503 request_busy` with `Retry-After: 1` instead of
  queueing uploads. Reads are not limited this way.
- **Sign-in throttling:** per client address and per account (for example 10 administrator attempts
  per address and username and 50 per address in five minutes), stored in the database so they
  survive restarts. See the [security model](security-model.md#administrator-credentials).

These are application safeguards, not protection against distributed denial of service. Size the
proxy limits and the container's resources accordingly, and keep the client address trustworthy
with [trusted proxies](#trusted-proxies).

## After the first start

1. Open `/admin` on your hostname and sign in with `ADMIN_USERNAME` and `ADMIN_PASSWORD`. The
   administration is deliberately not linked from the residents' navigation.
2. **Settings > General:** set the community name, shown in the header, the browser tab and on
   home screens.
3. **Settings > Dwellings:** create the dwellings, then **Arrange dwellings** to lay them out like
   the building.
4. **Settings > Users:** invite the residents (requires SMTP) and, if you like, assign the
   presidency.
5. **Finances > Import:** upload a statement PDF, confirm the detected IBAN, review and save. See
   [importing statements](importing-statements.md).
6. **Settings > Features:** turn Events on (off by default), or turn Actions or the ownership
   coefficients off.

The technical administrator can also open the residents' pages with the **Community portal** link,
without a resident account.

## Releases and image tags

Every change merged into `main` (except documentation-only changes) runs the complete CI and then
publishes two tags of [`drdonoso/juntia`](https://hub.docker.com/r/drdonoso/juntia):

- `latest`, which moves with every release;
- an immutable CalVer tag: `YYYYMMDD` (for example `20261029`), or `YYYYMMDD.02`, `YYYYMMDD.03` and
  so on for later releases on the same day.

Each release also gets a [GitHub release](https://github.com/DrDonoso/juntia/releases) with
generated notes. `/api/version` returns the tag and build date of the running image. The release
image is built from scratch, without a build cache, by a job that only runs on `main` and is the
only place holding the Docker Hub credentials (a GitHub environment named `release`). Nothing
deploys automatically: you choose when to update.

Pin `IMAGE_TAG` to a CalVer tag in production. `latest` is convenient for trying Juntia out, but it
is not a rollback reference.

## Updating

1. Read the release notes of every release since yours.
2. [Back up](#backup-and-restore) the database and the uploads volume, keep a protected copy of
   `.env`, and note the running image (`docker compose images`).
3. Set `IMAGE_TAG` to the new release, then:

   ```sh
   docker compose pull
   docker compose up -d
   docker compose ps
   ```

4. Check `/health`, `/api/version` and a sign-in through every hostname.

The new image applies its migrations when it starts. An older image cannot undo them and refuses to
start on a database migrated by a newer one, so the backup is your way back.

### Rolling back

Restore the previous `.env` and `IMAGE_TAG` **together**. If the newer version applied migrations,
also restore the database and uploads backup taken before the update (see
[restore](#restore)); changes made after the update are lost. Some migrations can be downgraded
with Alembic from the newer image, but most refuse when data would be lost (see
[migration notes](#migration-notes)), so restoring the backup is the reliable path. Never delete
the volumes as part of an update or a rollback.

## Backup and restore

Back up **both** volumes together: the PostgreSQL database and the uploads volume. The uploads hold
the original statement PDFs (top level) and every community action PDF, active or withdrawn (in
`actions/`). Backups contain personal data: residents' names, emails, phone numbers and password
hashes, shared contacts (deleted ones included), and the complete history of actions, events and
contacts. Keep them encrypted, outside the web root and outside version control.

### Backup

On a Linux server, in the stack's directory, into a new private directory:

```sh
umask 077
mkdir backup
docker compose stop api
docker compose exec -T db pg_dump -U juntia -d juntia -Fc > backup/database.dump
docker compose cp api:/app/data/uploads backup/uploads
docker compose start api
```

Stopping only `api` gives a consistent copy while the database keeps running. Record the image tag
and keep a protected copy of `.env` separately. If any command fails, start `api` again
deliberately and treat the backup as incomplete.

Purged PDFs disappear from the uploads volume, but backups taken before the purge still contain
them until those backups expire.

### Restore

Restore into a **fresh** stack (new volumes) with the image tag recorded in the backup, so leftovers
from the current data cannot mix with the restored data. On the recovery server, in a new directory
with `docker-compose.yml`, the saved `.env` and the backup:

```sh
docker compose up --no-start
docker compose up -d --wait db
docker compose exec -T db pg_restore -U juntia -d juntia --no-owner < backup/database.dump
docker compose cp backup/uploads/. api:/app/data/uploads
docker compose run --rm --no-deps --user root --entrypoint sh api -c 'chown -R 1000:1000 /app/data/uploads'
docker compose up -d
```

- Restore the database **before** `api` starts for the first time. If it already started, it has
  migrated and seeded the empty database: stop `api`, drop and recreate the database
  (`docker compose exec -T db dropdb -U juntia juntia`, then `createdb -U juntia juntia`) and
  restore again.
- Generate a new `AUTH_SECRET` before starting `api`: sessions and invitation or recovery links
  from the time of the backup stop working. Pending residents may need a new invitation.
- Verify `/health`, sign-in, balances and totals, a statement and an action PDF download, and that
  importing an already imported statement finds only duplicates, before you expose the restored
  instance.

These commands replace data: run them only against the intended recovery stack.

## Migration notes

Migrations run in a transaction, also on SQLite, and many refuse to downgrade when that would lose
data. Before downgrading, handle the data they protect, or simply restore a backup.

| Migration | What it adds | Downgrade |
| --- | --- | --- |
| `0004` | Two-decimal ownership coefficients (existing values rounded half up) | Cannot recover the discarded precision. |
| `0006` | Optional ownership coefficients | Refused until every missing coefficient is filled in. |
| `0007` | Google sign-in | Refused while any account is linked to Google. |
| `0009` | Community actions | Refused while actions exist. |
| `0010` | Shared contacts | Refused while contacts, contact tags or their history exist. |
| `0011` | Dwelling layout | Refused while a layout is saved, even an empty one. |
| `0012` | Derived transaction order | Discards the derived index only; upgrading rebuilds it. |
| `0013` | Runtime feature switches (coefficients and Actions start on) | Refused while the ownership coefficients or Actions switch is off. |
| `0014` | PDF renames | Refused while renamed PDFs or their history exist. |
| `0015` | Action label colors | Refused while any action label has a saved color or has been edited. |
| `0016` | Community events (switch off by default) | Refused while events or their history exist, or while Events is on. |
| `0017` | Community presidency | Clear the presidency first. |
| `0018` | Purge of withdrawn action PDFs | Refused while purged records exist. |
| `0019` | English default for the community name column (existing names are kept) | Restores the previous default. |
| `0020` | Transaction keys of the current statement reader (stored transactions are re-keyed) | Refused while transactions exist: restore the backup taken before upgrading. |

## Storage quotas and purging

Community action PDFs are limited by bytes stored, not only by the 20 active PDFs per action:

- **Per resident** (`ACTION_STORAGE_USER_QUOTA_MB`, 250 MiB by default): the PDFs a resident has
  attached.
- **Community-wide** (`ACTION_STORAGE_COMMUNITY_QUOTA_MB`, 2048 MiB by default): every action PDF,
  the technical administrator's included.
- **Free-disk reserve** (`MIN_FREE_DISK_MB`, 1024 MiB by default): action PDF uploads and statement
  imports are refused when they would leave less free space on the uploads volume. With Docker's
  default volumes, the uploads and the database usually share a disk, so the reserve also leaves
  room for the database.

Every stored PDF counts, **active or withdrawn**, until the administrator purges it: withdrawing a
PDF keeps its file, its bytes and its history. Retrying an upload with the same upload ID is never
counted twice. Checks run in this order and a refused upload writes nothing:

| Error | Status | Meaning |
| --- | --- | --- |
| `storage_low_space` | 507 | The free-disk reserve would be crossed, free space could not be read, or the disk filled up while writing. Retry later. |
| `action_storage_user_quota` | 409 | The uploader's quota would be exceeded. |
| `action_storage_community_quota` | 409 | The community quota would be exceeded. |

The server logs a warning whenever the community quota or the disk reserve refuses an upload.
Statement imports are subject to the disk reserve only; deleting a statement deletes its original.

**Monitoring.** **Settings > Storage** (`/admin/storage`) shows the community total against its
quota, the technical administrator's PDFs, the server disk's free space against the reserve, and
each resident against the personal quota (accounts deleted since keep their totals). Its
**Withdrawn PDFs** list shows the withdrawn PDFs that still use space, largest or oldest withdrawal
first, optionally for one uploader.

**Purging** a withdrawn PDF (**Delete permanently** in that list) deletes its file for good and
frees its bytes at once. Its record and its history stay: the action's history gains an entry,
"Permanently deleted a withdrawn PDF", with the file name, size and SHA-256 checksum, so the
community can still see what existed. Then:

- only withdrawn PDFs can be purged (`409 action_attachment_active` otherwise);
- downloads and previews of a purged PDF answer `410 action_attachment_purged`;
- purging again is harmless and also deletes a copy that a restored uploads backup brought back;
- if the file cannot be deleted, nothing changes (`503 action_storage_error`); if the database
  commit fails after the file was deleted, the PDF still shows as withdrawn and counted, its download
  reports the file missing, and purging it again completes the operation;
- there is no undo, except restoring a backup taken before the purge.

To free space you can purge withdrawn PDFs, raise the quotas or enlarge the volume. Lowering a quota
below the current usage is allowed; uploads are then refused until enough is purged. Migration
`0018` refuses to downgrade while purged records exist.

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| The container stops right after starting | A setting is invalid (the log names it: `docker compose logs api`), or the database was migrated by a newer image. |
| `400 invalid_host` | The proxy does not keep the `Host` header, or the hostname is missing from `PUBLIC_ORIGIN`. |
| `403 invalid_origin` when signing in | The browser's origin (scheme, hostname and port) is not exactly in `PUBLIC_ORIGIN`, or the proxy strips the `Origin` or `X-Juntia-Request` header. |
| Uploads fail with `413` | The proxy's body limit is below 21 MiB (nginx: `client_max_body_size`). |
| Google sign-in fails after returning from Google | `TRUSTED_PROXY_IPS` does not match the proxy, the `Host` header was changed, or the redirect URI is not registered for that origin. |
| `503 request_busy` | Too many simultaneous changes; the client retries after a second. |
| `507 storage_low_space` | Free space on the uploads volume is below `MIN_FREE_DISK_MB`. |
| Invitations report that email is not configured | `SMTP_HOST` and `SMTP_FROM` are empty, or `.env` changed without recreating `api`. |
| A changed setting has no effect | The container was restarted instead of recreated: `docker compose up -d --no-deps --force-recreate api`. |
