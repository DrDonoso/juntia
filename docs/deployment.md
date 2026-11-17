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
- [Administrators](#administrators)
  - [The administration account](#the-administration-account)
  - [The administrators command](#the-administrators-command)
  - [Lost administrator access](#lost-administrator-access)
- [Releases and image tags](#releases-and-image-tags)
- [Updating](#updating)
  - [Upgrading to administrator accounts](#upgrading-to-administrator-accounts)
  - [Rolling back](#rolling-back)
- [Backup and restore](#backup-and-restore)
- [Migration notes](#migration-notes)
- [Storage quotas and purging](#storage-quotas-and-purging)
- [Shared documents](#shared-documents)
  - [Reading the text of documents](#reading-the-text-of-documents)
- [Troubleshooting](#troubleshooting)

## Requirements

- A server with Docker Engine and the Docker Compose plugin. The published image is built for
  `linux/amd64`.
- On its own, Juntia serves `http://localhost:7778` on the server itself. To open it from other
  devices or the Internet, you also need a domain name and a reverse proxy that terminates HTTPS:
  the session cookies must then be `Secure` (`AUTH_COOKIE_SECURE=true`), which requires every
  configured origin to use `https`.
- Disk space for two named volumes: `pgdata` (PostgreSQL) and `uploads` (statement originals,
  community action PDFs and the images pasted into texts). PDFs and images are capped by the
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
   different values), and set `APP_LANGUAGE` (`en` or `es`) and `TZ`. There are no administrator
   credentials: you create the administration account in step 4. Keep the default
   `PUBLIC_ORIGIN=http://localhost:7778`, `AUTH_COOKIE_SECURE=false` and
   `APP_BIND_ADDRESS=127.0.0.1` for now: they serve only the server itself, which keeps Juntia out
   of reach until that account exists. Pin `IMAGE_TAG` to a [release](#releases-and-image-tags) for
   controlled updates. Leave SMTP, Google and AI empty until you need them.

3. Start the stack and check it:

   ```sh
   docker compose up -d
   docker compose ps                   # the api service becomes "healthy"
   docker compose logs --tail=100 api
   curl -fsS http://127.0.0.1:7778/health
   ```

   `/health` answers `{"status":"ok"}` once the database is initialized, and `/api/version` returns
   the image tag and build date. Use the address and port you published if they differ.

4. Right away, create the administration account: open `http://localhost:7778` on the server, or on
   your computer through an SSH tunnel (`ssh -L 7778:127.0.0.1:7778 <server>`), and fill in
   **Create the administration account**. Then check that it is no longer offered (see
   [the administration account](#the-administration-account)):

   ```sh
   curl -fsS http://127.0.0.1:7778/api/auth/setup    # {"available":false}
   ```

5. To open Juntia from other devices or the Internet, set `PUBLIC_ORIGIN` to the HTTPS address
   residents will open, `AUTH_COOKIE_SECURE=true` and, if your proxy needs it, `APP_BIND_ADDRESS`
   (see [trusted proxies](#trusted-proxies)), apply them with `docker compose up -d` and configure
   the [reverse proxy](#reverse-proxy-and-https). Then follow
   [after the first start](#after-the-first-start).

## What happens at startup

The container runs as the unprivileged user `app` (uid 1000) with `no-new-privileges` and a
restrictive `umask`, so the files it writes are private. On every start it:

1. applies the database migrations (`alembic upgrade head`);
2. on the first start of a new installation only, creates the default categories, tags and
   community name in `APP_LANGUAGE` (existing data is never renamed) and offers its first visitor
   the creation of the [administration account](#the-administration-account);
3. logs a warning for each retired setting it still receives (`ADMIN_USERNAME`, `ADMIN_PASSWORD`,
   `ALLOW_INSECURE_LOCAL_ADMIN`), and when accounts exist but none is an administrator (see
   [lost administrator access](#lost-administrator-access));
4. removes expired import previews and queues the shared documents whose text has never been read
   ([reading the text of documents](#reading-the-text-of-documents)), then serves the API and the
   web app with Uvicorn on port 7778, with access logs disabled, and reads those documents in the
   background.

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
  up to 20 MiB plus 64 KiB. nginx allows only 1 MiB by default. Shared documents, videos included,
  travel in chunks of at most 4 MiB, so they need no larger limit;
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
  Google sign-in, 512 KiB for ordinary JSON, 4 MiB for each chunk of a shared document, 12 MiB for
  the dwelling layout, 10 MiB plus 64 KiB for the images pasted into actions, comments and events,
  and 20 MiB plus 64 KiB for PDF uploads and import confirmations. Each image is limited to exactly
  10 MiB and each PDF to exactly 20 MiB.
  Declared lengths are checked first and bytes are counted while receiving, also without
  `Content-Length`.
- **Early authorization:** changes to the administration, actions, events and documents check the
  session (the administrator role for the administration, and the Actions, Events or Documents
  switch) before receiving the body.
- **Temporary storage:** bodies above 64 KiB are spooled to a temporary file inside the container
  and replayed in 64 KiB chunks. Receiving a body must finish within 30 seconds.
- **Concurrency:** the application admits at most 16 concurrent changes, 4 per client address and 4
  with a large body. Beyond that it answers `503 request_busy` with `Retry-After: 1` instead of
  queueing uploads. Reads are not limited this way.
- **Sign-in throttling:** per client address and per account: 10 sign-in attempts per email (for
  an administrator, per address and email) and 50 per address in five minutes, and 5 attempts per
  email and 20 per address in an hour to create the administration account. The counters are stored
  in the database, so they survive restarts. See the
  [security model](security-model.md#administrator-accounts).

These are application safeguards, not protection against distributed denial of service. Size the
proxy limits and the container's resources accordingly, and keep the client address trustworthy
with [trusted proxies](#trusted-proxies).

## After the first start

1. Sign in at `/login` on your hostname with the administration account, and open
   **Administration** in the user menu (the avatar at the top right). The administration is not
   linked from the residents' navigation.
2. **Settings > General:** set the community name, shown in the header, the browser tab and on
   home screens.
3. **Settings > Dwellings:** create the dwellings, then **Arrange dwellings** to lay them out like
   the building.
4. **Settings > Users:** invite the residents (requires SMTP), tick **Administrator** for whoever
   should administer too and, if you like, assign the presidency.
5. **Finances > Import:** upload a statement PDF, confirm the detected IBAN, review and save. See
   [importing statements](importing-statements.md).
6. **Settings > Features:** turn Events on (off by default), or turn Actions or the ownership
   coefficients off.

Administrators use the residents' pages too: **Community portal**, in the user menu or at the bottom
of the administration's sidebar, opens them with the same session. The administration account has
no dwelling, so it is not listed in Neighbors and cannot hold the presidency: if you live in the
community, give it your dwelling in **Settings > Users**.

## Administrators

Administrators are accounts with the administrator role. They sign in at `/login` like everyone else
and open the administration from the user menu; there are no administrator credentials in `.env`.
In **Settings > Users**, administrators invite people and give or take the role with the
**Administrator** checkbox (see [managing users](features.md#managing-users)); the change applies
at once, without signing anyone out.

### The administration account

A new installation has no accounts. Until the first one exists, `/login` shows **Create the
administration account** instead of the sign-in: your name, email and a password of at least 10
characters, twice. It creates an active administrator without a dwelling, signs it in and opens the
administration. It is offered only while the installation has no accounts, and never on an
installation upgraded from a release with a technical administrator (see
[upgrading to administrator accounts](#upgrading-to-administrator-accounts)).

Until someone creates that account, **whoever reaches Juntia first can create it** and administer
the community. Create it right after the first start, while Juntia is only reachable from the server
itself (the default `PUBLIC_ORIGIN` and `APP_BIND_ADDRESS`; from another computer, through an SSH
tunnel) and before you publish its hostname. Then check that it is no longer offered:
`GET /api/auth/setup` must answer `{"available":false}`.

### The administrators command

`python -m juntia.admins` manages administrators from the server, with the application's settings
and database. Run it inside the container:

```sh
docker compose exec api python -m juntia.admins list
docker compose exec api python -m juntia.admins grant EMAIL
docker compose exec api python -m juntia.admins revoke EMAIL
docker compose exec api python -m juntia.admins invite EMAIL --name NAME
docker compose exec api python -m juntia.admins password-link EMAIL
```

| Command | What it does |
| --- | --- |
| `list` | Lists the administrators: email, name, status (`active`, `pending` or `disabled`) and dwelling (`no dwelling` when it has none). |
| `grant EMAIL` | Makes an existing **active** account an administrator. Its password and Google link are kept, so it also works for an account that signs in only with Google. |
| `revoke EMAIL` | Takes the role away. Refused for the last active administrator, and for an account without a dwelling: assign one in **Settings > Users** first. |
| `invite EMAIL --name NAME` | Creates a pending administrator without a dwelling and prints its activation link, valid for 72 hours, to choose a password (or to continue with Google, when it is configured). For an upgraded installation without accounts, or without SMTP. It also closes the first-run screen. |
| `password-link EMAIL` | Prints a link to choose a new password: a recovery link, valid for one hour, for an active account, or a new activation link, valid for 72 hours, for a pending one. Refused for a deactivated account. For lost access without email. |

Nothing is sent by email: the links are printed for every `PUBLIC_ORIGIN` entry, and each works
once. Treat them like passwords until they are used. The command exits with status 1 when it refuses
something (the reason is printed on standard error) and 2 when the settings are invalid.

### Lost administrator access

- An administrator who forgot their password uses **Forgot your password?** on the sign-in page,
  like everyone, when email is configured.
- If another administrator can still sign in, they give the role in **Settings > Users**.
- Otherwise, on the server, with [the administrators command](#the-administrators-command):
  `grant EMAIL` makes an existing active account an administrator, `invite EMAIL --name NAME`
  creates a new administrator, and `password-link EMAIL` prints a link to choose a new password when
  it was forgotten and email is not configured.

While accounts exist but none is an administrator, every start logs "No account is an
administrator: grant the role with `python -m juntia.admins grant EMAIL`".

## Releases and image tags

Every change merged into `main` (except documentation-only changes) runs the complete CI and then
publishes two tags of [`drdonoso/juntia`](https://hub.docker.com/r/drdonoso/juntia):

- `latest`, which moves with every release;
- an immutable CalVer tag: `YYYYMMDD` (for example `20261029`), or `YYYYMMDD.02`, `YYYYMMDD.03` and
  so on for later releases on the same day.

Each release also gets a [GitHub release](https://github.com/DrDonoso/juntia/releases): a *What's
new* section with the notes people will see in the app, when the release brings any, then the
generated list of changes. `/api/version` returns the tag and build date of the running image. The
release image is built from scratch, without a build cache, by a job that only runs on `main` and is
the only place holding the Docker Hub credentials (a GitHub environment named `release`). Nothing
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

### Upgrading to administrator accounts

**For the release that introduces administrator accounts (migration `0024`), when you upgrade from
an earlier one.** Earlier releases had a technical administrator, defined by `ADMIN_USERNAME` and
`ADMIN_PASSWORD` in `.env`, with its own sign-in at `/admin`; administrators are now accounts with
the administrator role:

1. [Back up](#backup-and-restore) the database and the uploads volume first.
2. Upgrade as usual, with the steps above: the container applies the migrations
   (`alembic upgrade head`) when it starts. Migration `0024` makes nobody an administrator, ends the
   technical administrator's sessions and never offers the first-run screen.
3. Give the role to an existing active account, for example your own neighbor account, or one that
   signs in only with Google:

   ```sh
   docker compose exec api python -m juntia.admins grant EMAIL
   ```

   If the installation has no accounts (only the technical administrator was used), create an
   administrator instead, and open the activation link it prints to choose a password:

   ```sh
   docker compose exec api python -m juntia.admins invite EMAIL --name NAME
   ```

4. Sign in at `/login` with that account and open **Administration** in the user menu. The
   technical administrator's sign-in at `/admin` and its `/api/admin/auth/*` endpoints are gone:
   scripts that used them sign in with an administrator account through `/api/auth/login` instead.
5. Remove `ADMIN_USERNAME`, `ADMIN_PASSWORD` and `ALLOW_INSECURE_LOCAL_ADMIN` from `.env`, and the
   `ADMIN_USERNAME` and `ADMIN_PASSWORD` lines from your copy of `docker-compose.yml` (or download it
   again): a Compose file that still contains `${ADMIN_USERNAME:?Set ADMIN_USERNAME}` refuses to
   start once `.env` no longer sets it. Apply the change with `docker compose up -d`. As long as the
   server receives these settings, it ignores them and logs a warning at every start.

What the technical administrator wrote keeps its "Technical administrator" label, in each reader's
language. Its uploads count only towards the community quotas, and **Settings > Storage** shows them
apart while any remain. Administrators now write under their own names, and their uploads count
towards the personal quotas like everyone else's. To go back, [roll back](#rolling-back) with the
previous `.env`, which still has `ADMIN_USERNAME` and `ADMIN_PASSWORD`; downgrading migration
`0024` with Alembic is refused while an account has no dwelling (assign one or delete those
accounts first).

More commands, such as `list`, `revoke` and `password-link`, are described in
[the administrators command](#the-administrators-command).

### Rolling back

Restore the previous `.env` and `IMAGE_TAG` **together**. If the newer version applied migrations,
also restore the database and uploads backup taken before the update (see
[restore](#restore)); changes made after the update are lost. Some migrations can be downgraded
with Alembic from the newer image, but most refuse when data would be lost (see
[migration notes](#migration-notes)), so restoring the backup is the reliable path. Never delete
the volumes as part of an update or a rollback.

## Backup and restore

Back up **both** volumes together: the PostgreSQL database and the uploads volume. The uploads hold
the original statement PDFs (top level), every community action PDF, active or withdrawn (in
`actions/`), every image pasted into a description or comment (in `images/`), and every version of
every shared document, deleted ones included, with the unfinished uploads (in `documents/`).
Backups contain personal data: residents' names, emails, phone numbers and password hashes, shared
contacts (deleted ones included), the images members pasted, the documents they shared, and the
complete history of actions, events, contacts and documents. Keep them encrypted, outside the web
root and outside version control.

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

Purged PDFs, images and documents disappear from the uploads volume, but backups taken before the
purge still contain them until those backups expire.

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
| `0021` | Images pasted into the Markdown of actions, comments and events | Refused while images exist, purged ones included. |
| `0022` | Shared documents (switch off by default) | Refused while folders, documents, uploads or their history exist, purged ones included, or while Documents is on. |
| `0023` | The text of shared documents, for their search | Discards the text read; upgrading again reads every document again. |
| `0024` | Administrator accounts: the administrator role, accounts without a dwelling for administrators, and the end of the technical administrator's sessions (nobody becomes an administrator; see [upgrading](#upgrading-to-administrator-accounts)) | Refused while an account has no dwelling. Drops the role: earlier releases use `ADMIN_USERNAME` and `ADMIN_PASSWORD` again. |
| `0025` | Which What's new notes each account has read (accounts that had signed in see the notes of this version once) | Forgets which notes were read: upgrading again shows every note once more to accounts that had signed in. |

## Storage quotas and purging

Community action PDFs and the images pasted into descriptions and comments are limited by bytes
stored, not only by the 20 active PDFs per action:

- **Per person** (`ACTION_STORAGE_USER_QUOTA_MB`, 250 MiB by default): the PDFs and images each
  account has uploaded, administrators included.
- **Community-wide** (`ACTION_STORAGE_COMMUNITY_QUOTA_MB`, 2048 MiB by default): every action PDF
  and every image, including those the technical administrator of earlier releases uploaded, which
  count only here.
- **Free-disk reserve** (`MIN_FREE_DISK_MB`, 1024 MiB by default): uploads of PDFs and images and
  statement imports are refused when they would leave less free space on the uploads volume. With
  Docker's default volumes, the uploads and the database usually share a disk, so the reserve also
  leaves room for the database.

Every stored PDF counts, **active or withdrawn**, until an administrator purges it: withdrawing a
PDF keeps its file, its bytes and its history. Every image counts too, also after it is removed
from its text, because earlier versions in the history may still show it. Retrying an upload with
the same upload ID is never counted twice. Checks run in this order and a refused upload writes
nothing:

| Error | Status | Meaning |
| --- | --- | --- |
| `storage_low_space` | 507 | The free-disk reserve would be crossed, free space could not be read, or the disk filled up while writing. Retry later. |
| `action_storage_user_quota` | 409 | The uploader's quota would be exceeded. |
| `action_storage_community_quota` | 409 | The community quota would be exceeded. |

The server logs a warning whenever the community quota or the disk reserve refuses an upload.
Statement imports are subject to the disk reserve only; deleting a statement deletes its original.

**Monitoring.** **Settings > Storage** (`/admin/storage`) shows the community total against its
quota, the server disk's free space against the reserve, and each person, administrators included,
against the personal quota and the documents quota (accounts deleted since keep their totals), in a
table that sorts by any column; a **Technical administrator** card shows the PDFs and images of the
technical administrator of earlier releases while any remain. **Housekeeping > Free up space**
(`/admin/cleanup`) lists what can be purged: its **Withdrawn PDFs** list shows the withdrawn PDFs
that still use space, the latest withdrawn first, 5 per page, each with its uploader, an eye to view
it and a download button, also while Actions is turned off; its **Images in texts** list shows every
stored image with a thumbnail, the newest first. Both lists find files by name, ignoring capitals
and accents.

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

**Purging an image** (**Delete permanently** in **Images in texts**) works the same way, for any
stored image: images cannot be withdrawn, and a member who removes one from a text does not delete
it. Its file is deleted for good and its bytes are freed; its record stays, so every description,
comment or history entry that shows it displays "Image not available" (`410 image_purged`).
Purging again is harmless, and if the file cannot be deleted nothing changes
(`503 image_storage_error`). Images have no history entry of their own.

## Shared documents

**Documents** (`/documents`) is off by default: turn it on in **Settings > Features**, where you
also choose who can rename, move, replace and delete documents (whoever created them, only
administrators, or every neighbor). It has its own limits and quotas, separate from those
of actions. They are not environment variables: change them in **Settings > Storage > Shared
documents limits**, with a slider or an exact size in whole MiB for each, and they apply at once.

- **Types.** PDF; JPG, PNG, GIF, WebP and HEIC/HEIF pictures; Word, Excel and PowerPoint (DOCX,
  XLSX, PPTX) and OpenDocument (ODT, ODS, ODP) files; plain text and CSV; and MP4, M4V and MOV
  videos, the formats phones record. The extension decides the type and the server checks that the
  content matches it: Office and OpenDocument files with macros, scripts, ActiveX controls or
  embedded objects are refused, and so is any file whose content is not of its type. See the
  [security model](security-model.md#shared-documents) for what these checks do and do not cover.
- **Sizes.** Up to 50 MiB per file and 1 GiB per video by default, adjustable from 1 MiB to 10 GiB
  (the size of a ZIP download). They apply to uploads started afterwards. Videos are stored as they
  are, without converting them.
- **Uploads in chunks.** The browser sends each file in chunks of 256 KiB to 4 MiB, sized to take a
  few seconds each on the current connection, and the server assembles it in `documents/` on the
  uploads volume. An interrupted upload continues where it stopped when it is retried within a day
  of its last chunk. Each person keeps at most 4 unfinished uploads (starting a fifth discards the
  least recently active one); expired ones are discarded when uploads start and at startup, which
  also removes partial files that no upload refers to. The type is checked once the file is
  complete, so a large video may show "Checking the file…" for a moment.
- **Quotas.** Every stored version counts, current, earlier or deleted, until an administrator
  purges it: towards the documents quota of whoever uploaded that version, administrators included
  (2 GiB by default), and towards the community documents quota (20 GiB), which also counts what
  the technical administrator of earlier releases uploaded; both are adjustable from 1 MiB to
  10 TiB. Both are checked when an upload starts and again when it completes, with the values saved
  at that moment. Lowering a quota below the current usage is allowed: the page warns about it, and
  uploads are refused until enough is purged. Unfinished uploads count towards neither, but each
  chunk must leave `MIN_FREE_DISK_MB` free on the uploads volume.
- **Folders.** Up to 10 levels of folders and 1000 items (files and folders) in each folder. Names
  have up to 200 characters without `/ \ : * ? " < > |`, are unique in their folder regardless of
  case, and are not names Windows reserves (such as `CON` or `NUL`), so that downloaded ZIP files
  extract everywhere.
- **Downloads.** Files, whole folders and selections of up to 100 items download as ZIP files of up
  to 5000 files and 10 GiB, built while they are sent, without compression (most documents and
  videos are already compressed). At most 4 ZIP downloads run at the same time; more answer
  `503 document_archive_busy`.

| Error | Status | Meaning |
| --- | --- | --- |
| `document_type_unsupported` | 415 | The extension is not one of the accepted types. |
| `document_type_mismatch` | 415 | The content does not match the extension. The upload is discarded. |
| `document_macros_unsupported` | 415 | The Office or OpenDocument file contains macros, scripts, ActiveX controls or embedded objects. The upload is discarded. |
| `document_too_large` | 413 | The file exceeds the largest file or, for videos, the largest video set in Storage. |
| `storage_low_space` | 507 | The free-disk reserve would be crossed. |
| `document_storage_user_quota` | 409 | The uploader's documents quota would be exceeded. |
| `document_storage_community_quota` | 409 | The community documents quota would be exceeded. |
| `document_folder_full`, `document_depth_limit` | 409 | The folder already holds 1000 items, or the folder would be more than 10 levels deep. |
| `document_archive_items`, `document_archive_too_large` | 422 | The ZIP download would exceed 100 selected items, 5000 files or 10 GiB. |

**Deleting and purging.** A deleted file or folder disappears for residents at once, with
everything inside it, but keeps its files, its bytes and its history. **Deleted documents**
(`/admin/deleted-documents`) lists each deletion with who made it and where it was. Administrators
can:

- **restore** it, with everything deleted together with it, where it was, or at the top level when
  that folder no longer exists; a number is added to its name when the name is in use there;
- **delete it permanently** (purge): every version of every file in it is deleted from the uploads
  volume and its bytes are freed at once. Names and history stay, so the history still shows what
  existed and who deleted it, but it can no longer be restored or downloaded (`410
  document_version_purged`). Purging again is harmless and also removes a copy that a restored
  uploads backup brought back. If a file cannot be deleted, nothing changes (`503
  document_storage_error`).

Replacing a file with a new version keeps the earlier versions, downloadable from **Info**.
**Settings > Storage** shows the documents quotas, each person's usage and unfinished uploads.
**Housekeeping > Free up space** has an **Earlier versions of documents** list, the latest uploaded
first, 5 per page and searchable by name, where administrators can preview or download each
earlier version and purge them one by one, also while Documents is turned off; the current version
of a file is only purged with the file. Text and CSV files are previewed in Juntia's own viewer,
which reads their first MiB as plain text (UTF-8, UTF-16 with a byte order mark, or Windows-1252).
Migration `0022` refuses to downgrade while documents exist, purged ones included.

### Reading the text of documents

So that the search also finds files by the words inside them, the server reads the text of the
current version of every PDF, Word, Excel, PowerPoint, OpenDocument, text and CSV file, and of JPG,
PNG, GIF and WebP pictures. Videos and HEIC pictures are found by name only. Nothing is sent
outside the server.

- **When.** Each file is read in the background a moment after its upload completes, one at a
  time, the newest first. Every start queues the files whose text was never read, so the first
  start of a version with this feature reads every existing document, which can take a while on a
  large archive. **Housekeeping > Document reading** (`/admin/document-reading`) shows the progress,
  each file's state and why a file could not be read, and reads files again.
- **OCR.** Scanned pages and pictures are read with
  [Tesseract](https://github.com/tesseract-ocr/tesseract), which the image includes with its
  English and Spanish models (about 100 MB of the image). The model follows `APP_LANGUAGE`; after
  changing it, the next start reads the scanned files again. A PDF page is scanned when it has no
  text or little text over a picture. OCR takes a few seconds per page on one processor core;
  other files are read in a moment.
- **Limits.** Each file is read in a separate low-priority process with at most 2 GiB of memory
  and 20 minutes of processor time, stopped after 15 minutes. The search keeps the first 500,000
  characters of each file, read in up to 10 minutes from its first 500 pages, with OCR on up to
  100 of them; longer files are searchable in part. Pictures over 150 megapixels and files
  protected with a password are not read, and stay searchable by name.
- **Storage.** The text is kept in the database, so its backups include it, and is deleted when a
  new version replaces the file or the file is purged.
- **Without Docker.** Install Tesseract with the model of `APP_LANGUAGE` (`tesseract-ocr-eng` or
  `tesseract-ocr-spa` on Debian and Ubuntu). Without it, the server logs a warning at startup and
  reads everything but scanned pages and pictures, which it reads at the first start after
  Tesseract is installed.

Asking to read again a file whose text is never read, such as a video, answers
`409 document_text_unsupported`.

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| The container stops right after starting | A setting is invalid (the log names it: `docker compose logs api`), or the database was migrated by a newer image. |
| `400 invalid_host` | The proxy does not keep the `Host` header, or the hostname is missing from `PUBLIC_ORIGIN`. |
| `403 invalid_origin` when signing in | The browser's origin (scheme, hostname and port) is not exactly in `PUBLIC_ORIGIN`, or the proxy strips the `Origin` or `X-Juntia-Request` header. |
| Uploads fail with `413` | The proxy's body limit is below 21 MiB (nginx: `client_max_body_size`). `413 image_too_large` with a smaller body means the image itself exceeds 10 MiB. |
| Google sign-in fails after returning from Google | `TRUSTED_PROXY_IPS` does not match the proxy, the `Host` header was changed, or the redirect URI is not registered for that origin. |
| `503 request_busy` | Too many simultaneous changes; the client retries after a second. |
| `507 storage_low_space` | Free space on the uploads volume is below `MIN_FREE_DISK_MB`. |
| Invitations report that email is not configured | `SMTP_HOST` and `SMTP_FROM` are empty, or `.env` changed without recreating `api`. |
| Nobody can open the administration | No account has the administrator role (every start then logs "No account is an administrator"), or no administrator can sign in: see [lost administrator access](#lost-administrator-access). |
| The log says `ADMIN_USERNAME`, `ADMIN_PASSWORD` or `ALLOW_INSECURE_LOCAL_ADMIN` "is no longer used" | It belonged to the technical administrator of earlier releases: remove it from `.env` and from your Compose file (see [upgrading to administrator accounts](#upgrading-to-administrator-accounts)). |
| `docker compose` refuses to start and asks to set `ADMIN_USERNAME` | Your copy of `docker-compose.yml` is older than administrator accounts: remove its `ADMIN_USERNAME` and `ADMIN_PASSWORD` lines, or download it again. |
| A changed setting has no effect | The container was restarted instead of recreated: `docker compose up -d --no-deps --force-recreate api`. |
