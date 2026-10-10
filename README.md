# KVK Dashboard

Live ticketing dashboard for **Koninklijke Toneelgroep Kunst Veredelt Kieldrecht vzw**, built on top of the [Stamhoofd](https://stamhoofd.app) API.

Originally built by Dennis Geleyn ([dennisgeleyn/kvk-dashboard](https://github.com/dennisgeleyn/kvk-dashboard)); this copy lives under the organisation's own GitHub and Cloudflare accounts, and auto-discovers every webshop instead of a manually configured list.

🔗 **https://webmaster-kvk.github.io/kvk-dashboard** _(once GitHub Pages is enabled — see Setup)_

---

## Features

- **Live sales data** — fetches all orders via the Stamhoofd v2 API using keyset-cursor pagination
- **Every production shown automatically** — webshops are fetched live from Stamhoofd on every load, so a newly created production's webshop just appears as a tab, with nothing to configure. The admin can hide specific webshops (e.g. a BBQ or annual meeting that isn't a production) via ⚙ Instellingen — that choice is the only thing stored, everything else is always live.
- **KPI overview** — total revenue, paid revenue, tickets sold, average order value
- **Per-show breakdown** — tickets sold, capacity, seats remaining, and a traffic light:
  - 🟢 **Vrij** — fewer than 194 tickets sold
  - 🟡 **Laatste kaarten** — 194 to 233 tickets sold
  - 🔴 **Uitverkocht** — 234 or more tickets sold
- **Tickets per week** — bar chart with hover tooltip
- **Payment status breakdown** and **recent orders table**
- **Stamhoofd system status** — live status pill in the header
- **Auto-refresh** every 5 minutes
- **Mobile-friendly** — responsive layout, wide logo on desktop / square logo on mobile
- **Debug panel** — visible to admins only
- **Centrally managed settings** — admin sets `orgId`/hidden webshops once via ⚙ Instellingen; every visitor immediately sees the same values, no per-browser config drift

---

## Architecture

```
Browser → Cloudflare Worker → Stamhoofd API
                ↕
           Cloudflare KV  (users, requests, sessions, magic link tokens,
                           app config, rate-limit counters)
                ↕
             Brevo API  (magic link emails + admin notifications)

```
- **Stamhoofd API:** currently pinned to `v421`. The version number lives in one place — `apiBase()` in `app.js`. Stamhoofd increments this number on breaking changes and does not guarantee backward compatibility, so check after major Stamhoofd updates. Orders are fetched via `/webshop/orders?filter=...` (not `/webshop/{id}/orders` as in v1); webshops are listed via `/webshops`; prices are in units of 1/10000 of a euro (e.g. `300000` = €30,00).

### How login works (magic links)

There are no passwords for regular users. Instead:

1. User enters their email on the login screen → Worker sends a one-time login link
2. User copies the link from the email and opens it in their browser
3. Worker validates the token → session is created in KV
4. Sessions last 7 days; tokens expire after 15 minutes and are single-use
5. To log in again after 7 days, they just request a new link

> **Note:** Magic links are currently sent as plain text (not clickable buttons). Once you verify your own domain in Brevo you can disable click tracking and switch back to clickable buttons.

Admin login uses a password (stored as a Worker secret, never in source code).

### Security model

- **API key** — Cloudflare Worker secret, never in the browser or source code
- **Admin password** — Cloudflare Worker secret, validated server-side
- **No passwords stored** for regular users — magic link tokens only
- **Sessions in KV** — invalidated on logout, expire server-side after 7 days
- **`/proxy` requires login** — every request to the real Stamhoofd API needs a valid admin or session token; this is checked by the Worker itself, not just enforced by the dashboard's login screen
- **Strict host validation on `/proxy`** — the Worker only forwards requests (and attaches the API key) when the actual hostname is `api.stamhoofd.app` or `status.stamhoofd.app`, checked via `new URL().hostname` rather than a substring match
- **Rate limiting** — `/auth`, `/magic/request`, and `/requests` allow at most 5 attempts per IP per time window (15 minutes for admin login, 1 hour for the others), enforced server-side in KV; the client-side lockout is a UX nicety on top of this, not the real protection
- **Centrally managed config** — `orgId`/`webshopId` live in KV via `/config`, writable only with a valid admin token, so every visitor sees the same admin-controlled values
- **Email addresses** — display hints are masked (`den***@gmail.com`) and lookups use a SHA-256 hash, but the actual address is also stored in KV (needed to send and resend magic links) — this is pseudonymization for display, not hash-only storage

---

## Setup

### 1. Create a Brevo account

1. Sign up at [brevo.com](https://brevo.com) (free tier: 300 emails/day, send to any recipient)
2. Go to **Senders & IPs → Senders → Add a sender** and verify your email address
3. Go to **Settings → API Keys** and create a new API key

### 2. Deploy the Cloudflare Worker

The worker auto-deploys to Cloudflare via GitHub Actions on every push to `main` that touches `stamhoofd-proxy-worker.js` or `wrangler.toml`.

For the initial manual setup:
1. Create a free account at [workers.cloudflare.com](https://workers.cloudflare.com)
2. Create a new Worker, paste `stamhoofd-proxy-worker.js`, and deploy
3. Note your worker URL (e.g. `https://wandering-boat-05cb.dennisgeleyn.workers.dev`)

#### Add secrets

In **Worker → Settings → Variables & Secrets**, add:

| Secret | Value |
|---|---|
| `STAMHOOFD_API_KEY` | Your Stamhoofd API key |
| `ADMIN_PASSWORD` | Your admin password |
| `BREVO_API_KEY` | Your Brevo API key |
| `NOTIFY_TO` | Your email — receives access request notifications |
| `NOTIFY_FROM` | A verified sender address in your Brevo account |
| `DASHBOARD_URL` | `https://webmaster-kvk.github.io/kvk-dashboard` |

> Secrets are set once in the Cloudflare dashboard and are never touched by GitHub Actions deployments.

#### Create a KV namespace

1. **Cloudflare dashboard → Workers & Pages → KV → Create namespace** (name it anything)
2. **Worker → Settings → Variables → KV Namespace Bindings → Add binding**
   - Variable name: `KVK_STORE` (must be exactly this)
   - Namespace: select the one you just created
3. Copy the namespace ID into `wrangler.toml`

#### GitHub Actions auto-deploy

Add these two secrets to your GitHub repo (**Settings → Secrets and variables → Actions**):

| Secret | Where to find it |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Cloudflare → My Profile → API Tokens → Create Token → "Edit Cloudflare Workers" template |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare dashboard → Workers & Pages → right sidebar |

From then on, every push to `main` that touches the worker file deploys automatically.

### 3. Configure the dashboard

Open `index.html` and update the `DEFAULTS` block near the top of the script. `proxyUrl` is the one that actually matters here — it must point at your deployed Worker, since the dashboard needs it just to reach `/config`. `orgId` and `webshopId` are only the initial fallback; the live values are managed centrally afterward via ⚙ **Instellingen** as admin, which writes them to the Worker's KV store so every visitor sees the same values:

```js
const DEFAULTS = {
  orgId:     'your-organisation-id',
  webshopId: 'your-webshop-id',
  proxyUrl:  'https://your-worker.workers.dev',
};
```

> After deploying, log in as admin once and click **Opslaan** in ⚙ Instellingen — even with the unchanged values — to write them to the Worker for the first time. Until then, every visitor falls back to the hardcoded `DEFAULTS` above.

### 4. Publish via GitHub Pages

1. Push all files to a GitHub repository
2. **Settings → Pages** → set source to `main` branch, root folder
3. Live at `https://your-username.github.io/your-repo/`

---

## User management

### Admin login

On the login screen, type `admin` or `beheerder` as the email address. A password prompt appears inline — no separate page.

### Granting access

1. User clicks **"Toegang aanvragen"**, fills in name and email
2. You receive an email notification
3. Log in as admin → **⚙ Instellingen** → **Gebruikersbeheer**
4. Click **Goedkeuren** → user is approved and immediately receives a magic login link by email

### Resending a magic link

If a user's link has expired or was lost, click **Stuur nieuwe link** next to their name in **Gebruikersbeheer**. You'll be prompted for their email address if it isn't stored yet (this only happens for users approved before this feature was added).

### Revoking access

Click **Verwijderen** next to a user in **Gebruikersbeheer**. Their active sessions expire within 7 days at most.

---

## Files

| File | Description |
|---|---|
| `index.html` | Dashboard markup — links to `styles.css` and `app.js`, logos embedded |
| `styles.css` | All dashboard styling — extracted from `index.html` for maintainability |
| `app.js` | All dashboard logic — config, auth, data fetching, UI rendering || `stamhoofd-proxy-worker.js` | Cloudflare Worker: API proxy, admin auth, magic links, KV user management |
| `wrangler.toml` | Wrangler config for automated Cloudflare deployments |
| `.github/workflows/deploy-worker.yml` | GitHub Actions workflow — auto-deploys worker on push |
| `README.md` | This file |

---

## Credits

Originally built by Dennis Geleyn. This copy adds automatic webshop discovery and moved to the organisation's own accounts.

Built for internal use by **Koninklijke Toneelgroep Kunst Veredelt Kieldrecht vzw**  
Registered office: Kouterstraat 261, 9130 Kieldrecht, Belgium  
Company number: 1010.418.811 — RPR Ghent, Dendermonde division

Built with [Claude](https://claude.ai) by Anthropic.
