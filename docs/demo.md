# The public demo

[demo.juntia.drdonoso.com](https://demo.juntia.drdonoso.com) is a static copy of Juntia that runs
entirely in the visitor's browser, with synthetic data. There is no server behind it: nothing is
stored, and reloading the page starts the demo again.

## Contents

- [Using the demo](#using-the-demo)
- [The data](#the-data)
- [What needs a real server](#what-needs-a-real-server)
- [Running it locally](#running-it-locally)
- [Updating the screenshots](#updating-the-screenshots)
- [How it works](#how-it-works)
- [Deploying to Cloudflare](#deploying-to-cloudflare)

## Using the demo

- The demo opens signed in as **Olivia Bennett**, a neighbor of the fictional community
  **Maple Court**. A welcome dialog, shown once per page load, offers **Explore as a neighbor** or
  **Open administration**, which signs in the demo administrator.
- A banner at the bottom reminds that the data is synthetic and that changes are lost on reload, and
  links to the source code.
- Credentials, shown and filled in on the sign-in screens:
  - administration (`/admin`): `demo` / `demo`;
  - residents (`/login`): the email of any active neighbor, such as `olivia.bennett@example.com`,
    with the password `demo`.
- Everything can be changed: actions, comments and PDFs, events, contacts, profiles, users,
  dwellings and their layout, rules, categories, imports and settings. Changes last until the page is
  reloaded.
- The language selector switches between English and Spanish, like in a real installation.

## The data

All data is invented, deterministic and relative to the current date, so the demo always looks
recent:

- **Maple Court**: twelve dwellings, `1A` to `4C`, with ownership coefficients adding up to 100, and
  their neighbors: active accounts, pending invitations and a deactivated account. **James Okafor**
  (`1A`) is the president. Emails use `example.com`, phone numbers the UK fiction range
  `+44 20 7946 0xxx`, and the bank account a checksum-valid IBAN on the non-existent bank code
  `9999`.
- **Finances**: thirteen months of statements with monthly fees by ownership coefficient, utilities,
  cleaning, insurance, lift maintenance, repairs, a special assessment for the roof, refunds and bank
  fees, plus categories, tags and rules in English.
- **Actions** in every status, with labels, comments, generated PDF documents and their history;
  **events** in the past, ongoing and upcoming, several linked to actions; **contacts** with tags,
  edits and a few deleted ones.

## What needs a real server

Features that depend on real infrastructure are simulated or explain that they need a real server:

- **Statement import:** any valid PDF you select is read as a canned synthetic statement, which you
  can review and confirm like a real one. Real bank PDFs are never parsed.
- **AI classification** is reported as not configured.
- **Email:** invitations are recorded as accepted by the mail server, but nothing is sent, so
  invited neighbors stay pending; password recovery answers as usual without sending anything.
- **Google sign-in** and linking answer "This feature needs a real server, so it is not available in
  the demo."
- **Storage administration** shows invented disk figures; the PDF quotas and permanent deletion
  behave as on a real server.

## Running it locally

In `frontend/` (no backend or database needed):

| Command | What it does |
| --- | --- |
| `npm run dev:demo` | Vite development server in demo mode. |
| `npm run build:demo` | Type-checks and builds the demo into `dist-demo/` (never touches `dist/`). |
| `npm run preview:demo` | Serves `dist-demo/` with the demo's security headers. |
| `npm run e2e:demo` | Playwright test of the **built** demo, on port 4183 (`DEMO_E2E_PORT`): smoke checks plus a crawl of every page, as a neighbor and as the administrator, in English and Spanish, with accessibility (axe) checks. It fails on any request the demo does not answer. Run `npm run build:demo` first. |
| `npx vitest run src/demo` | Unit tests of the demo API and data. |

`DEMO_E2E_BASE_URL=https://demo.juntia.drdonoso.com npm run e2e:demo` checks the deployed demo
instead of a local build.

The demo relies on a service worker, which browsers allow only in secure contexts: `localhost`,
`127.0.0.1` and HTTPS work. Elsewhere, and in browsers or private windows without service workers,
the demo explains why it cannot start.

## Updating the screenshots

The screenshots in the [README](../README.md) and in [features.md](features.md) come from the demo.
To capture them again, in `frontend/`:

```bash
npm run build:demo
npm run screenshots
```

[`scripts/capture-screenshots.mjs`](../frontend/scripts/capture-screenshots.mjs) serves
`dist-demo/` on port 4183, unless something already answers on `SCREENSHOT_BASE_URL`, and writes
`docs/screenshots/*.png` with Playwright's Chromium: in English, with the light theme, at 1440×900
and on a 390×844 phone, with the demo banner hidden. The data is relative to the day of the
capture. The script fails if a page logs an error or makes an `/api` request the demo doesn't
answer; `SCREENSHOT_ONLY=overview,mobile` captures only some images. Optimize the images losslessly
before committing them, for example with
`docker run --rm -v "$PWD/../docs/screenshots:/work" ghcr.io/shssoichiro/oxipng -o 4 --strip safe --recursive /work`.

## How it works

- The demo is the normal frontend built with `vite build --mode demo`, which loads
  `frontend/.env.demo` (`VITE_DEMO=1`) and writes `dist-demo/`.
- [Mock Service Worker](https://mswjs.io) answers every `/api` request in the browser from an
  in-memory store. The handlers mirror the backend's validation, permissions, pagination and error
  codes, using the generated API types. A request nobody handles gets a `501` and a console error,
  and a unit test fails if an API operation has neither a handler nor an explicit "unavailable in the
  demo" answer.
- Production builds contain no demo code: `main.tsx` loads it only behind a build-time check, and
  `mockServiceWorker.js` is removed from `dist/`.
- The static host gets a `_headers` file with the backend's security headers and Content Security
  Policy, plus `worker-src 'self'` for the service worker, and a static web app manifest.

The code lives in `frontend/src/demo/`; its [README](../frontend/src/demo/README.md) explains the
structure and how to write handlers.

## Deploying to Cloudflare

The demo is served by Cloudflare Workers as static assets, configured in
[`frontend/wrangler.jsonc`](../frontend/wrangler.jsonc): a Worker named `juntia-demo` that serves
`dist-demo/` with a single-page-application fallback, on the custom domain
`demo.juntia.drdonoso.com`. There is no Worker script and no secret.

With **Workers Builds** (Cloudflare dashboard, **Workers & Pages**, create an application by
importing the `DrDonoso/juntia` repository):

| Setting | Value |
| --- | --- |
| Root directory | `/frontend` |
| Build command | `npm run build:demo` |
| Deploy command | `npx wrangler@4 deploy` |
| Environment variable | `NODE_VERSION=24` |

The custom domain comes from `wrangler.jsonc` and needs the domain's zone in the same Cloudflare
account; otherwise, add the domain in the Worker's **Domains & Routes** settings and remove `routes`
from the file. From a terminal, run `npx wrangler@4 login` once, then
`npm run build:demo && npx wrangler@4 deploy`.

To publish your own copy, change `name` and `routes` in `wrangler.jsonc`.
