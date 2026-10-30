# Security model

Juntia is a single-community application, not a multi-tenant service.
Financial reads require an active invited resident or technical administrator
session. Residents can view community financial movements but cannot write
financial data or access statement metadata, original bank PDFs, user management,
or AI operations. Community actions are intentionally collaborative as described below.
An external access policy can provide defense in depth; apply it to every allowed
hostname/access route and prevent direct origin bypass when using one.
Allowing a second URL does not create a separate community or bypass login.

## Administrator credentials

Set unique `ADMIN_USERNAME`, `ADMIN_PASSWORD`, and `AUTH_SECRET` values in the
server environment. Production has no default credentials or public setup endpoint.
Keep `.env` readable only by the deployment owner. Environment variables are not
an encrypted secret store and remain visible to privileged host/container
operators. Never prefix server secrets with `VITE_`.

`docker-compose.local.yml` intentionally uses `admin` / `admin` and explicitly
enables `ALLOW_INSECURE_LOCAL_ADMIN`. That exception is disabled by default,
requires every configured origin to be loopback HTTP, and only exempts this exact
credential pair from the minimum password length. Local Compose fixes the published address to
`127.0.0.1`; never expose it through a proxy, tunnel, or shared network. Use the
server Compose file with strong credentials for any shared deployment.
`LOCAL_PUBLIC_ORIGIN` is passed to `PUBLIC_ORIGIN` and may contain a CSV only if
every hostname is exactly `localhost`, `127.0.0.1`, or `::1`, with non-Secure
cookies. Mixing a remote origin or HTTPS into that list fails startup.
Database passwords and `AUTH_SECRET` still require unique local values.

The server verifies a bcrypt password hash and stores only hashes of random
session tokens. Cookies are host-only (no Domain attribute), HttpOnly and SameSite
Strict, with Secure enabled in production and Path `/api`. They are not
automatically shared between hostnames; sign in on each hostname separately.
Adding an origin alone does not invalidate existing sessions.
Credential/secret rotation invalidates existing sessions after
process restart; logout revokes the current token. With Compose, recreate the API
container after editing `.env` (a plain restart retains its old environment).
Rotate `AUTH_SECRET` when restoring a backup so old sessions cannot reappear.
Administrative mutations require a valid technical administrator session,
and same-origin POST/PUT/PATCH/DELETE requests, including login initiation,
require exactly one configured Origin and `X-Juntia-Request: 1`. Google's GET
callback has separate protocol state, browser binding, nonce and PKCE protection
described below.
Administrative login uses shared, atomic database counters: 10 attempts per
client-address/username pair and 50 per client address in five minutes. A client
cannot consume another address's allowance by guessing the administrator name;
changing names or untrusted forwarded headers does not evade the address limit.
Successful attempts also count. These counters survive process restarts, expire
at the window boundary, and are separate from resident limits. The legacy
`State.login_attempts` field is no longer used for authentication.
Empty or overlong password input is rejected even if the configured password
matches the dummy value used to keep bcrypt verification on the failure path.
Clients behind the same trusted address share its allowance. Distributed attacks
still require appropriate proxy/access-policy protection; there is no global
account lockout that anonymous clients can trigger. The client address is the
proxy's unless `TRUSTED_PROXY_IPS` lists it: with Docker, a proxy on the same
host reaches the container from the Compose network's gateway, not `127.0.0.1`
(see [trusted proxies](deployment.md#trusted-proxies)). Without that setting,
every visitor shares the proxy's allowance.

The administrator's login name is never shown to residents. Every record the
technical administrator authors (actions, comments, PDFs, events, contacts and all
their history entries) is returned with the fixed author label "Technical
administrator" (in `APP_LANGUAGE`) instead of `ADMIN_USERNAME`. The label is
applied when records are read, so entries saved before this rule existed are
covered too, and the interface always renders administrator authors with the
label in the reader's own language. Only the administrator's own session
responses contain its username.

Cookie names do not use the `__Host-` prefix, because that prefix requires
`Path=/` while Juntia scopes its session cookies to `/api` (and the short-lived
Google sign-in cookie to `/api/auth`). Without it, a site on a sibling subdomain
of the same registrable domain (for example `other.example.com` next to
`juntia.example.com`) could set a cookie with the same name for the parent
domain. The server uses the last of duplicate cookies, so such a planted cookie
could sign a visitor into an account chosen by the attacker. Host Juntia on a
domain whose sibling subdomains you control, and do not let untrusted parties
publish content on other subdomains of it.

## Resident accounts and invitations

Only the technical administrator can create dwellings and invite residents.
There are no public registration/setup endpoints or resident administrator roles.
Emails are validated, normalized, and uniquely constrained. A resident belongs
to exactly one dwelling; its coefficient is shared metadata, not an authorization
boundary. Every active resident can read the same community ledger.

Resident passwords use bcrypt, with a minimum of 10 characters and a maximum of
72 UTF-8 bytes; overlong inputs are rejected, never silently truncated. Resident
forms count Unicode code points for the minimum and show localized inline errors
without exposing storage details. This does not relax the independent technical
administrator password policy. Session
and account-link tokens are random, purpose-bound, and stored only as hashes
bound to `AUTH_SECRET`. Resident and technical administrator cookies are
separate. Both are HttpOnly/SameSite Strict, Secure in production, and scoped to
`/api`; legacy administrator cookies are migrated without extending expiry.
The interface's logout revokes both browser identities and clears private caches.

Invitations expire after 72 hours and recovery links after one hour. Acceptance
requires an explicit password-submission POST or a verified Google callback
after same-origin initiation from the invitation. GETs from email scanners do
not consume invitation links. Tokens are
single-use and consumed atomically. Changing a password or email, or disabling a
user, revokes resident sessions and outstanding links. Reactivation never
resurrects old sessions. A disabled or unactivated account cannot use password
recovery to obtain access. The last connection records successful password or Google
authentication, not browsing activity.

The resident profile resolves its owner exclusively from the authenticated
session, never a client-supplied user ID. Display name and contact phone are self-editable;
email, dwelling, coefficient and account state remain administrator-managed.
Password changes require the current password, are throttled separately, and
recheck session/account validity after password verification. Password changes
and the explicit all-devices logout revoke sessions and pending account links
without updating the last-login timestamp. The technical administrator cannot
edit its environment-backed credentials through resident profile endpoints.

Permanent resident deletion is administrator-only and requires the current
record version and matching normalized email as explicit confirmation. The user
row is locked while its session/token/Google-flow records and then the user are
removed in one transaction. A failed deletion rolls back revocation as well.
Dwelling and finance records are not deleted. A fresh invitation can reuse the
email but not the deleted resident ID; old sessions and links do not transfer.
Google consent outside this application and expiring abuse-prevention counters
are unaffected. No self-service or anonymous user-deletion endpoint is exposed.

The authenticated neighbors directory exposes only dwelling labels and active
residents' IDs, names, account emails and voluntarily supplied/admin-managed contact phones.
This community-only email visibility is intentional. It excludes pending/disabled accounts, credentials, invitation details,
coefficients and last-login information. Its API uses the same authenticated
reader gate as financial data; no anonymous directory is available.
Phone entry explicitly discloses community visibility and may be left blank.
Numbers are normalized to digits with an optional leading `+`; dialer control
characters and URI schemes are rejected before producing `tel:` links.
Contact phones are not verified identities or authentication factors. Updating
a number does not change credentials, revoke sessions or count as a login.

Login is limited to 10 attempts per identity and 50 per client address per
five-minute window. Recovery is limited to 5 requests per identity and 20 per
client per hour; administrator invitations to 10 per identity and 200 per client
per hour. Token submissions are separately limited. Counters are persisted,
expired records are cleaned up, and resident limits do not consume the technical
administrator's allowance. Trust only configured proxies for the client address.

SMTP secrets remain in server configuration. STARTTLS/implicit TLS verifies
certificates; plaintext is restricted to explicit loopback development. SMTP
calls have bounded timeouts and do not hold the financial-state lock. Failures
are logged without exception strings or recipient/token values. Administrator
actions surface send failures while retaining recoverable pending records.
Public recovery responses stay neutral to avoid exposing account existence;
SMTP delivery runs after the response so its latency cannot disclose membership.
Operators must monitor sanitized delivery failures; in-process recovery mail
may need to be requested again after a server restart. SMTP acceptance is not
proof of final delivery. No raw resident-session, invitation or recovery token is
returned by a production API.

Email links use only the first normalized origin in `PUBLIC_ORIGIN`, carry tokens in fragments, and
are removed from the browser address bar when opened. Do not add third-party
analytics to these screens. Tokens and passwords must not enter logs, browser
storage, screenshots, or monitoring payloads. Preserve the no-referrer policy.
Only branding, feature availability, assets, health/version and account-access flows remain public.
Protect backups containing resident emails and password hashes; rotating
`AUTH_SECRET` also invalidates restored resident sessions and account links.

## Google authentication

Google is optional and server-configured through `GOOGLE_CLIENT_ID` and
`GOOGLE_CLIENT_SECRET`. The application requests only `openid email profile` and never
grants administrator permissions through Google. It neither creates a resident
nor assigns a dwelling from a Google response. Initial association requires
either a valid invitation for that verified email or an active resident session
and the current local password. This applies to Gmail, Workspace and third-party
email accounts alike: a Google email match is never sufficient for automatic
account linking. The stable Google `sub` is unique in the database; it is not
derived from the email address.

Only invitation activation imports the optional full name from the verified ID
token. The existing resident-name validation applies; missing or invalid names
leave the administrator-supplied name unchanged without blocking activation.
Invalid names are logged without including their contents. Google profile names
are not verified legal identities, and later logins or account linking never
overwrite resident names.

The server-side code flow uses a short-lived, hashed database state bound to the
browser, origin and (for linking) the resident session/version. State is consumed
atomically before contacting the provider. PKCE verifiers and nonces are derived
from unpredictable state using `AUTH_SECRET`; invitation tokens are never sent
to Google. A separate `juntia_google` cookie is HttpOnly, host-only, scoped to
`/api/auth`, expires in ten minutes and uses SameSite **Lax** for the top-level
redirect from Google. Normal resident and administrator session cookies remain
SameSite **Strict**. Expired/replayed state or cross-browser/origin callbacks fail.

Token exchange and signing-key retrieval use fixed Google HTTPS endpoints,
bounded timeouts and verified TLS, without following arbitrary redirects.
Validation requires an RS256 signature using Google's cached public keys, the
configured audience, Google's issuer, expiry, issue time, nonce, a verified email
and a subject. Authorized-party claims are checked where present/required.
User, invitation and session eligibility are rechecked after the provider
response, so deactivation, resends, logout and password/email changes cannot be
undone by an old linking/activation flow.

Existing local passwords are preserved when linking Google. Google-only users
can add a password via the existing SMTP recovery proof; password creation/reset
retains their Google association and revokes local sessions. Unlinking requires
a local password and revokes sessions. Changing the account email removes both
password eligibility and the Google association until a new invitation is
accepted. Activation is stored explicitly, never represented by a fabricated
password hash.

Google codes, ID/access/refresh tokens, client secrets and raw protocol state
must not enter logs or analytics. No Google token is persisted. Callback query
parameters must be redacted at proxies; production access logs stay disabled.
No third-party Google JavaScript is loaded into pages containing financial data.
Synthetic-provider overrides live only in the disposable browser-test script.

## Shared contacts and retained history

The contacts, contact-tag and contact-history APIs require a current active
resident or technical administrator session. All members may create, edit and
withdraw any contact and create/edit shared colored contact tags. These rights
do not grant financial, account-management, community-action moderation or
administrative permissions. Contact tags are separate from both other catalogs,
and contacts do not depend on the community-actions feature flag.

Mutation authentication shares the account/session-locking and revalidation
helper used by community actions, without adopting that domain's feature gate
or ownership rules. Versions and database serialization reject stale edits or
removals. Origin/header protection applies to every mutation. A change and its
server-authored history event are one transaction; rejected and unchanged saves
do not create events. Contacts never advance the financial import revision.

Removal is logical, not erasure: former contact details, notes, tag snapshots
and authorship remain readable by authenticated members in the history. Actor
IDs/names are historical snapshots, not cascading references to accounts.
The deletion confirmation discloses retention. Only the technical administrator
can enumerate removed contacts through `/api/admin/contacts/deleted`; the
individual history retains its existing authenticated read-only access.
There are no application
endpoints for editing/deleting history or restoring removed contacts, and the
schema downgrade refuses to silently destroy contact/tag/history data.
This is an application audit trail, not a tamper-proof external log.

Notes are rendered as plain text. Emails and normalized phones are validated
before constructing mail/dialer links, and colors accept only six-digit hex.
Copying requires browser clipboard permission or an explicit manual fallback.
Opening a link delegates to the device, not an SMTP or telephony service.
Private queries are cleared on logout, revocation and identity changes, and
responses from the previous identity cannot repopulate that cache.

## Community actions and retained PDFs

`/api/actions` requires an active resident or technical administrator session for
every read, mutation and download, including historical documents. Community
actions deliberately allow every member to create and edit any action or change
its state. This does not grant financial write access or access to administration.
Only a contribution's author or the technical administrator can edit or withdraw a
comment, or rename or withdraw a PDF. Parent-action identifiers are checked when
resolving comments and attachments.

Actors and timestamps are resolved on the server. Mutations recheck the session
after acquiring account/session locks, and after staging uploaded content.
Per-action serialization and resource versions prevent stale overwrites and
overruns of the 20-active-PDF limit; the byte quotas below are additionally
serialized across all actions. Each mutation and its audit event share a
database transaction; rejected/no-op edits do not invent history. Action changes
do not advance the financial import revision.

The history is append-only through the application, not a tamper-proof external
audit log. Previous text, actor names at the time of the action and withdrawn
PDFs remain visible to all authenticated members, including after the original
author changes name, is deactivated or is deleted. Actor IDs are snapshots;
resident IDs are not reused, so a newly invited account cannot acquire ownership
of an earlier account's contributions. The interface discloses this retention.
There is no endpoint to delete actions, comments or history entries. The only
permanent deletion is the administrator's purge of a withdrawn PDF's file (see
[storage quotas and retention](#storage-quotas-and-retention)), which keeps its
record and history. Do not publish content that must later be erased through the
ordinary withdrawal controls.

Each PDF is limited to 20 MiB, with at most 20 active PDFs per action. Multiple
selection uses one bounded request per file. Basic filename, header (`%PDF-`) and
end-of-file (`%%EOF`) checks are not antivirus scanning, authenticity
verification or complete PDF validation. Do not treat a member-uploaded PDF as
trusted content. No banking parser, OCR or AI service receives these attachments.

Downloads are served with `Content-Disposition: attachment`. The eye icon opens a
separate, equally authenticated preview endpoint that serves the same file
**inline, on the application's own origin**, in a new tab. Both responses carry
`Content-Type: application/pdf`, `nosniff`, `no-store` and the application's
Content Security Policy (`script-src 'self'`, `object-src 'none'`,
`frame-ancestors 'none'`). The browser displays the preview in its built-in PDF
viewer, isolated from the application's pages, and the review found no way for a
document to run script in the application's origin through this path. Two
residual risks remain:

- a resident can upload a convincing fake document, such as a forged invoice or a
  notice asking neighbors to sign in elsewhere, and it is displayed under the
  community's trusted address. Treat member-uploaded PDFs as untrusted, whatever
  address shows them;
- the preview relies on the browser's PDF engine. Flaws in PDF viewers have let
  documents run script before (for example CVE-2024-4367 in outdated versions of
  Firefox), so keep browsers up to date.

There is no setting to turn the inline preview off.

Storage uses immutable, server-generated names in `UPLOAD_DIR/actions`, never
client paths. Upload identifiers make retries idempotent without sharing ownership
across accounts/actions. File staging and publication use compensating cleanup;
after an ambiguous commit, cleanup checks for a retained database reference.
If that check cannot reach the database, it logs the need for reconciliation
and preserves the possible original rather than destroying evidence. Only remove
an orphan after confirming it has no retained attachment record. Back up both
volumes consistently, including withdrawn documents. The schema downgrade guard
refuses to drop a nonempty backlog.

### Storage quotas and retention

Withdrawn PDFs stay on disk and remain downloadable from the history, so storage
is bounded by bytes, not only by the number of active files:

- **Quotas.** Every stored action PDF, active or withdrawn, counts until it is
  purged: against its author's quota (`ACTION_STORAGE_USER_QUOTA_MB`, 250 MiB by
  default) and against the community quota (`ACTION_STORAGE_COMMUNITY_QUOTA_MB`,
  2048 MiB by default), which also covers the technical administrator. Withdrawing
  never frees quota, so repeatedly uploading and withdrawing PDFs cannot fill the
  disk. Uploads over a quota fail with `409 action_storage_user_quota` or
  `409 action_storage_community_quota`, checked in that order.
- **Serialization.** The quota check and the insert run under a lock shared by
  every action (a transaction-level advisory lock on PostgreSQL, the single
  writer on SQLite), so concurrent uploads cannot exceed a budget together. A
  retry with the same upload ID is answered from the stored record and never
  counted twice.
- **Free-disk reserve.** Before an action PDF or a statement import is written,
  the server checks the free space of the uploads volume and keeps
  `MIN_FREE_DISK_MB` (1024 MiB by default) free. It answers
  `507 storage_low_space`, which can be retried later, when the reserve would be
  crossed, when the free space cannot be read, or when the disk fills up while
  writing.
- Rejected uploads leave no file and no history event. The server logs a warning
  whenever the community quota or the reserve refuses an upload. Installations
  already over a quota refuse new uploads until enough is purged.
- **Purge.** Only the technical administrator can purge, through
  `/api/admin/storage` (the **Storage** page), with the usual Origin and
  anti-CSRF checks; it keeps working while Actions is off. Only withdrawn PDFs
  can be purged (`409 action_attachment_active`). A purge deletes the file but
  keeps the attachment record and adds an `attachment_purged` history event,
  authored by the administrator, with the file name, size and SHA-256 checksum.
  It frees the quota at once, and later downloads and previews answer
  `410 action_attachment_purged`. It does not change the action's version.
- **Purge failures.** The file is deleted inside the database transaction: if
  the deletion fails, nothing is committed (`503 action_storage_error`), so the
  database never claims a file is gone while it is still on disk. If the commit
  fails after the deletion, the PDF still shows as withdrawn and counted, its
  download reports the source as missing, and repeating the purge completes it.
  Repeating a purge on a purged PDF succeeds unchanged and also deletes a copy
  that a restored uploads backup brought back.
- **Retention.** Purging is irreversible within the application. Backups taken
  before a purge still contain the file until they expire, and comments' earlier
  text is never purged. Migration `0018` refuses to downgrade while purged
  records exist.

## Community events

`/api/events` requires an active resident or technical administrator session and
the Events switch (off by default) for every read, change and calendar export.
Every member can create, edit and delete any event; versions reject stale
changes, and each change and its history entry share a transaction. Deletion is
logical: deleted events and their history stay readable by members and cannot be
edited or exported. Links to actions, and filtering by action, also require the
Actions switch; while it is off, link information is hidden but kept.

Calendar exports are built on the server. The Google Calendar link uses the fixed
`https://calendar.google.com` prefix with URL-encoded values, and the `.ics` file
is named after the event's integer identifier (`event-<id>.ics`). The input rules
reject carriage returns and unexpected control characters, and the calendar
library escapes line breaks, semicolons and commas, so event text cannot inject
calendar fields. The interface checks an `event=` address parameter as a
positive integer before requesting anything.

## Deployment controls

The **Actions** switch defaults to on. When it is off, both navigations hide
Actions, direct pages show its disabled state, and all authenticated
`/api/actions` requests (including downloads) return `actions_disabled` with 404.
The server enforces the switch independently of the UI. Anonymous API requests
still require authentication. This retains all action data, audit history and
files for later re-enablement; it is not an erasure or backup policy. Financial
permissions and user/session management are unchanged. The **Events** switch
defaults to off and works the same way for `/api/events` (`events_disabled`).

**Ownership coefficients** is an administrator-controlled setting, not a
user preference or an authorization role. With it disabled, coefficient values
are masked in dwelling, user and personal-profile responses and coefficient
writes are rejected server-side. Existing values remain stored for later
re-enablement. All existing authentication and administrator checks still apply.

The switches are persisted in the database and managed at `/admin/features`, not
through `.env`. Each switch's PATCH endpoint requires an administrator session,
an authorized Origin and the anti-CSRF header. Only the known switches
(`coefficient`, `actions`, `events`) and strict boolean values are accepted. The
server reads the current database values
for each relevant request, including rechecking after staging an action upload;
there is no per-process flag cache. Updates do not revoke sessions or alter
financial revisions. The browser refreshes flags every five seconds while
visible and on focus; API enforcement does not wait for that refresh.
`/api/features` exposes only effective booleans, never credentials or the
environment. Google availability remains derived from server-side credentials.
Migration `0013` initializes the coefficient and Actions switches as enabled;
operators upgrading a deployment with previously disabled environment flags must
disable them in administration before reopening access. Backups include these
saved settings.

`PUBLIC_ORIGIN` accepts a single URL as before, or a comma-separated allowlist,
for example `https://juntia.example.com,https://juntia.internal.example.com`.
Whitespace around entries and root slashes are normalized along with scheme,
hostname, and default ports; duplicates are removed in order. Every entry is
validated. Empty entries, wildcards, credentials, non-root paths, queries,
fragments, and invalid URL/port syntax reject the whole configuration without
echoing credentials. Secure cookies require HTTPS for **all** entries.

Host checks accept the exact hostnames in `PUBLIC_ORIGIN` and, on **every**
route, the loopback names `localhost`, `127.0.0.1` and `::1`, which the
container's health check and local access use. Other `Host` values get
`400 invalid_host`. Accepting the loopback names grants nothing by itself:
cookies are host-only, so sessions issued for a configured hostname are not sent
to a loopback name; changes still require an allowed Origin; and Google sign-in
is bound to a configured origin. The host check guards against misrouted
requests and is not an access control: restrict who can reach the published
port. Origin checks compare the complete scheme, hostname, and effective
port, not just a hostname. Missing, `null`, duplicate, and multi-value Origin
headers are rejected; CSV parsing applies only to configuration. These checks
remain separate from session authorization and do not enable permissive CORS.

The server Compose file publishes the application port on `127.0.0.1` by default
(`APP_BIND_ADDRESS`), so only a reverse proxy on the same host can reach it.
Publish it on `0.0.0.0` or a LAN address only when the proxy runs on another host
or container, and then firewall the port so that neither the proxy nor an access
policy in front of it can be bypassed. PostgreSQL is never published. Any access
beyond the server itself requires HTTPS: set `AUTH_COOKIE_SECURE=true` (the
Compose default when the variable is unset; `.env.example` sets `false` for
`http://localhost`), which requires HTTPS origins, so a TLS-terminating reverse
proxy is needed, and responses then carry `Strict-Transport-Security`.

Use HTTPS, restrict trusted proxy IPs, and preserve the Host header.
`TRUSTED_PROXY_IPS` remains independent of the origin allowlist: do not broaden it
to `*` or trust arbitrary `X-Forwarded-Host`/`Forwarded` values to authorize hosts.
List only the address the container sees for your proxy (see
[trusted proxies](deployment.md#trusted-proxies)).
Deploy a validated compatible image before applying CSV configuration, keep a
protected environment backup and recoverable previous image, and recreate only
`api` to apply the environment. Roll back the image and environment together.
The application rejects unexpected hostnames,
sets security headers and no-store responses, and does not expose API docs.
Do not override no-store behavior with an external cache rule.
Production access logging is disabled to avoid recording personal search terms
in URLs. Apply the same query/header redaction policy to external proxy logs.

The **Hide amounts** button (the eye icon) is only a visual privacy aid. It is
enabled explicitly by the user and defaults to showing values; it does not remove
data from the API or DOM and is not a substitute for access control. No service
worker caches banking data for home-screen installation.

## Data handling

Keep PostgreSQL and upload storage private. Original filenames never determine
filesystem paths; downloads resolve a validated document identifier. Uploads
are bounded before multipart processing, and statement imports and action PDFs
are refused when they would cross the free-disk reserve (see
[storage quotas and retention](#storage-quotas-and-retention)). Bank statements
are parsed in a time-limited child process. Financial data, action descriptions
and comments are never a template or executable HTML.

Mutation bodies have operation-specific byte limits: 16 KiB for account-access
requests, 32 KiB for Google initiation with a return URL, 512 KiB for ordinary
JSON, and 12 MiB for dwelling layouts. Import confirmations and PDF multipart
requests retain the 20 MiB plus 64 KiB request envelope; each PDF is still limited
to exactly 20 MiB. JSON budgets account for escaped supplementary Unicode.
Declared excessive lengths are rejected immediately, and bytes are also counted
while receiving, including chunked requests without `Content-Length`.

Administrative, community-action and event mutations check the current session
before receiving their body. The Actions and Events switches are checked then as
well. Existing route authorization and mutation revalidation still run after reception.
Bodies spool to a temporary file above 64 KiB and are replayed in chunks no larger
than 64 KiB, instead of retaining a full upload and another copy in memory.
Temporary files close on success, rejection, disconnect and cancellation; staging
failures are logged without body contents and return an explicit error.

Each API worker admits at most 16 concurrent mutations, four per client address,
and four operations with a large-body budget. Reservations cover reception and
the downstream operation, not just the first chunk, and are released on every
exit. Overload returns `503 request_busy` with `Retry-After: 1`, without queueing
more bodies; GET requests are not subject to this mutation budget. Reception
retains its 30-second deadline. These are per-worker safeguards, not a replacement
for ingress limits, container resource budgets, reliable temporary storage or
distributed denial-of-service protection. Trust proxy client addresses narrowly.

Contact and transaction pages are filtered, counted, ordered and paginated in
SQL before ORM entities are materialized. Notes and tags are loaded only for the
requested contact page. Summaries aggregate financial facts in SQL rather than
loading every transaction. Broad searches and exact counts still require database
work; pagination is not a replacement for database resource budgets or storage
quotas.

Migration `0012` materializes canonical bank ordering in a separate derived
table. Administrative imports/removals rebuild it in the same locked transaction
as the financial change, and cyclic evidence still rejects the whole operation.
Readers do not reconstruct the source graph for each page. Filters retain the
full ledger's canonical tie order. Missing index entries fail explicitly.
The index contains no new authority or editable financial fields and can be
recreated from the retained facts. Keep migrations and the deployed image aligned.

Original parsed fields and transaction identities are immutable through the API.
IBAN checks run before enrichment and again during atomic confirmation.
No mismatch bypass is available. Reconciliation does not prove a PDF's
authenticity or account ownership; the administrator must trust its source.

When AI is configured, uploading a statement automatically requests classification
after source-account validation; the first IBAN must still be explicitly
confirmed. The upload screen discloses this behavior. Only server-selected,
sanitized concepts and catalog labels are sent, never the PDF, account header,
amount columns, or balances. Automatic masking cannot reliably remove every
personal name or confidential detail. Review the provider's retention/privacy
policy before uploading, prefer a suitable private endpoint where necessary, or
do not enable AI. Suggestions remain in an administrator-bound preview until the
administrator reviews and confirms the import.

Do not commit real PDFs, extracted bank data, screenshots containing personal
information, credentials, backups, or private package-feed URLs. The automated
fixtures are synthetic.

## Dependency advisories

The frontend lock resolves `source-map-js` to 1.2.2, outside the vulnerable range
for GHSA-68fv-2mgg-jv7q (CVE-2026-93749). It remains a development/build dependency,
not an additional runtime service. Lockfiles retain public registry URLs and
package-manager integrity hashes.

`scripts/audit_dependencies.py` runs in CI and includes transitive, development
and test entries from both lockfiles. Only public package identifiers and exact
versions are sent to OSV; local project names, private registry entries, code
and secrets are never submitted. An advisory, malformed/incomplete response or
service failure is explicit and fails the check. Absence of a known advisory is
not proof of safety and does not replace image scanning or deployment review.

## Reporting

Report vulnerabilities privately as described in the [security policy](../SECURITY.md),
never in a public issue, and use only synthetic reproductions: no real bank
records, personal data or credentials.
