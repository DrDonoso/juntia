# Security policy

Juntia is a self-hosted application that stores a residential community's
financial and personal data: bank movements and original statement PDFs,
residents' accounts and contact details, shared contacts, and community actions
with their attachments. A vulnerability can expose neighbors' private
information, so reports are taken seriously.

## Supported versions

Only the latest release is supported: the `drdonoso/juntia:latest` image, which
is also the newest CalVer tag (for example `20261029`). Fixes ship as a new
release; there are no backports to older tags.

## Reporting a vulnerability

**Please do not open a public issue or pull request for security problems.**

Report them privately through GitHub's private vulnerability reporting:

1. Open the [vulnerability report form](https://github.com/DrDonoso/juntia/security/advisories/new),
   also reachable from the repository's **Security** tab with **Report a
   vulnerability**.
2. Describe the problem and submit it. The report stays private between you and
   the maintainer.

If you cannot use the form, contact [@DrDonoso](https://github.com/DrDonoso)
through the contact details on their GitHub profile, and share the details only
once you have a private channel.

Please include:

- the affected version or image tag (the running version is returned by
  `/api/version`);
- steps to reproduce, ideally a minimal proof of concept;
- the impact: what an attacker could read, change or disrupt, and the access
  they need (anonymous visitor, resident or administrator);
- any suggested fix or mitigation.

**Never include real bank statements, personal data, credentials, session
cookies or backups.** Reproduce the problem with synthetic data on your own
instance, for example the local Docker Compose stack described in
[CONTRIBUTING.md](CONTRIBUTING.md#running-locally).

Expect an initial response within 7 days. Juntia follows coordinated disclosure:
the maintainer confirms the problem, keeps you informed, releases a fix and then
publishes a security advisory that credits you, unless you prefer otherwise.
Please keep the details private until the fix is released, and allow a reasonable
time for it.

## Scope

**In scope:**

- Authentication and session handling: resident passwords and Google sign-in,
  invitations, password recovery, the administrator session, cookies and login
  throttling.
- Authorization between residents and the administrator: a resident reaching
  administrator-only data or operations (statements, original PDFs, imports,
  user management, settings), or changing data they should not be able to.
- Cross-site request forgery and origin checks.
- Uploads and PDF handling: statement imports and action attachments, file
  storage and downloads, parser abuse and storage limits.
- Statement imports, classification rules and the optional AI classification.
- Exposure of personal or financial data through the API, the interface, caches
  or logs.
- Injection and path traversal: SQL, HTML or script, headers and file paths.
- The container image, Compose files and CI workflows in this repository.

**Out of scope:**

- Deployments that ignore the documented setup: served without HTTPS, with the
  application or PostgreSQL ports exposed contrary to the documentation, with
  default or weak secrets, or exposing the local Compose stack (`admin` /
  `admin`) beyond the local machine.
- Denial of service that requires very large resources, such as volumetric
  attacks or floods of requests.
- Social engineering, phishing and physical access.
- Issues in third-party services such as Google, the configured AI provider,
  the SMTP server, GitHub or Docker Hub: report them to the vendor. Vulnerable
  dependencies without an exploitable path in Juntia belong upstream.
- The [public demo](https://demo.juntia.drdonoso.com), which runs entirely in the
  browser with synthetic data and the published `demo` / `demo` credentials.

## Security model and deployment hardening

The [security model](docs/security-model.md) describes how Juntia protects data
(sessions, roles, origin checks, upload limits and data handling) and the
hardening every deployment needs: unique secrets, HTTPS, a private database and
upload storage, and narrowly trusted reverse proxies.
