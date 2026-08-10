# Friendly CRM — Deployment Guide (Hostinger VPS, KVM 4)

Everything runs in Docker on a single VPS: **PostgreSQL 16** (the database),
the **Fastify API** (auth + leads + metadata, RLS-enforced), and **nginx**
serving the CRM app and proxying `/api`. KVM 4 (4 vCPU / 16 GB) is more than
enough — this stack idles under 1 GB.

> **You must build the SPA in API mode (Step 4).** The same codebase can also run
> standalone on browser localStorage — fine for a single-user demo, unsafe as
> multi-tenant SaaS, because then every tenant's data (including passwords) sits
> in the visitor's browser and permission checks are client-side JavaScript.
> Setting `VITE_API_URL` at build time is what makes PostgreSQL — RLS, argon2id,
> JWT — the authority instead.

---

## Step 1 — Create the VPS

1. In hPanel → VPS, choose your KVM 4 plan.
2. OS template: **Ubuntu 24.04 with Docker** (Hostinger offers it pre-installed —
   pick it and skip Step 3). Plain Ubuntu 24.04 also works.
3. Set the root password / SSH key. Note the VPS IP.

## Step 2 — Connect

```bash
ssh root@YOUR_VPS_IP
```

## Step 3 — Install Docker (skip if you picked the Docker template)

```bash
curl -fsSL https://get.docker.com | sh
```

## Step 4 — Build the app in API mode, then upload

Build on your local machine, from the project root:

```bash
npm ci
VITE_API_URL=/ npm run build      # → dist/index.html, API mode (same-origin /api)
```

`VITE_API_URL=/` trims to an empty base URL, meaning "same origin" — the app calls
`/api/...`, which nginx proxies to the API container. **Omit it and you ship the
insecure demo build** (see the note at the top).

> **Windows Git Bash mangles a bare `/` argument** into a filesystem path
> (`C:/Program Files/Git`). On Windows, put `VITE_API_URL=/` in a `.env.local`
> file next to `package.json` and just run `npm run build` — Vite reads it
> literally. This repo already ships that file.

Upload the three directories the compose file needs (`dist/`, `server/`, `deploy/`):

```bash
ssh root@YOUR_VPS_IP 'mkdir -p /opt/friendly-crm'
scp -r dist server deploy root@YOUR_VPS_IP:/opt/friendly-crm/
ssh root@YOUR_VPS_IP
cd /opt/friendly-crm/deploy
```

`dist/` is a build artifact and is **not** in the git repo, so a `git clone` on the
VPS is not enough on its own — either upload `dist/` as above, or install Node on
the VPS and run the same build there.

## Step 5 — Configure secrets

```bash
cp .env.production.example .env
nano .env        # change EVERY value; generate secrets with: openssl rand -hex 24
```

Set `PUBLIC_URL` to `http://YOUR_VPS_IP` for now (change to your https domain later).

## Step 6 — Launch + initialize the database

```bash
docker compose -f docker-compose.prod.yml up -d --build

# Create schema (RLS, RBAC, audit triggers, metadata tables).
# `run --rm migrate` is a ONE-SHOT container that holds the Postgres superuser
# credential and exits — the long-running api container never sees it, so an
# app compromise can't escalate past the RLS-bound app_user.
docker compose -f docker-compose.prod.yml run --rm migrate

# Bootstrap: seeds the permissions catalog and creates YOUR platform admin.
# There are no demo accounts and no default password — pick a real secret here.
docker compose -f docker-compose.prod.yml run --rm \
  -e ADMIN_EMAIL=you@yourcompany.com \
  -e ADMIN_PASSWORD="$(openssl rand -base64 24)" \
  seed
```

The bootstrap prints the address it created. Store the generated password in your
password manager **before** you close the terminal — it is hashed with argon2id
and cannot be read back out of the database.

Verify:

```bash
curl http://localhost/api/health          # → {"ok":true,...}
```

Open `http://YOUR_VPS_IP` and sign in with the `ADMIN_EMAIL` / `ADMIN_PASSWORD`
you just bootstrapped. There is no demo data and no default account.

> The browser-side **"Set up Friendly CRM"** first-run screen belongs to *demo
> mode only*. In API mode identity lives in Postgres, so your administrator comes
> from the `seed` bootstrap above. If the VPS shows you that setup screen, your
> build is in demo mode — rebuild per Step 4.

## Step 7 — Verify you are on the real backend (not demo mode)

If you built with `VITE_API_URL` in Step 4, the app is already
server-authoritative — there is nothing to switch on. Confirm it, because this is
the single most important property of the deployment:

1. Sign in at `http://YOUR_VPS_IP`. There must be **no amber "Demo mode" banner**
   in the header. That banner means the browser is the database — rebuild per
   Step 4, re-upload `dist/`, then
   `docker compose -f docker-compose.prod.yml restart web`.
2. Confirm the request actually reached Postgres:
   ```bash
   docker compose -f docker-compose.prod.yml logs api | tail -20   # POST /api/auth/login 200
   ```
3. Sanity-check that identity is server-side: `friendly_crm_api_token` exists in
   the browser's localStorage, and `friendly_crm_users` does **not**.

A per-browser override remains for pointing a local build at a staging API
(`localStorage.setItem('friendly_crm_api_url', 'https://staging.example.com')`).
That is a developer tool — it must never be how production reaches the backend.

> **Known scope limit:** **Leads are fully server-backed** — create, edit, delete,
> bulk actions and CSV import all go through the API, with RLS, RBAC and the
> immutable audit log enforced by PostgreSQL. Auth and metadata are server-backed
> too. The *other* modules (bookings, inventory, notes/activities, projects…)
> still write through the browser store, so treat this deployment as
> production-grade for **identity, access and the lead pipeline**, and stage the
> remaining modules before relying on them for real customer data.

## Step 8 — Domain + HTTPS (required for the mobile/desktop app)

> **This step is what turns the CRM into an installable app.** Service workers
> and installation require a *secure context*: HTTPS, or `localhost`. On a plain
> `http://YOUR_VPS_IP` deployment the site works fine, but **no Install button
> will ever appear and there is no offline mode** — the browser silently refuses
> to register the service worker. There is no workaround; a real domain +
> certificate is the price of installability.

1. Point an A record (e.g. `crm.yourdomain.com`) at the VPS IP.
2. Edit `nginx.conf`: replace `server_name _;` with your domain.
3. Issue the certificate:
   ```bash
   docker compose -f docker-compose.prod.yml run --rm certbot \
     certonly --webroot -w /var/www/certbot -d crm.yourdomain.com \
     --email you@yourdomain.com --agree-tos --no-eff-email
   ```
4. Uncomment the 443 block + HTTP→HTTPS redirect in `nginx.conf`,
   set the domain in it, update `PUBLIC_URL=https://crm.yourdomain.com` in `.env`, then:
   ```bash
   docker compose -f docker-compose.prod.yml up -d --force-recreate web api
   ```
   Renewal is automatic (the certbot container renews every 12h check).

## Step 8b — Installing the app (phone, tablet, desktop)

Once HTTPS is live, Friendly CRM is a **PWA**: it installs from the browser, with
no app store, no review, and no separate build. Same URL, same code, all devices.

| Device | How |
| --- | --- |
| **Android** (Chrome/Edge) | Tap **Install app** in the header, or Chrome's ⋮ → *Install app* |
| **Windows / macOS / Linux** (Chrome/Edge) | Click **Install app**, or the ⊕ icon in the address bar |
| **iPhone / iPad** (Safari **only**) | **Share** → **Add to Home Screen**. The in-app button shows these steps. |

Notes worth knowing before you tell customers:

- **iOS has no install API.** Apple exposes no `beforeinstallprompt`, so no site
  can show a one-tap install button — it is always the manual Share-sheet flow.
  Chrome/Firefox *on iOS* cannot install at all; it must be Safari.
- **The app works offline** once opened while online. The whole UI is cached by
  the service worker; your data already lives on-device.
- **Updates**: the service worker fetches from the network first and only falls
  back to its cache, so an online user always gets the current build — no "clear
  your cache" support calls. `sw.js` and `index.html` are served `no-cache` (see
  `nginx.conf`); do not put a CDN with long TTLs in front of them.
- **Icons** are generated from source at build time (`npm run icons`, and
  automatically via `prebuild`). Edit `BRAND` in `scripts/generate-icons.mjs` to
  re-brand, then rebuild.

## Step 9 — Backups (do not skip)

Backups are **encrypted and automatic** — the `backup` service runs a daily
AES-256 dump (`deploy/backup.sh`) with 14-day retention into the `backups`
volume. It starts with the stack; just set `BACKUP_PASSPHRASE` in `.env` (store
that passphrase somewhere OTHER than the server).

```bash
# Take a backup right now:
docker compose -f docker-compose.prod.yml exec backup /bin/sh /usr/local/bin/backup.sh

# List them:
docker compose -f docker-compose.prod.yml exec backup ls -lh /backups

# TEST YOUR RESTORE (do this before you need it — an untested backup is a guess):
docker compose -f docker-compose.prod.yml exec backup \
  /bin/sh /usr/local/bin/restore.sh /backups/friendly_crm-YYYYMMDD-HHMMSS.sql.gz.gpg
```

**Get the backups off the box.** A backup on the same VPS dies with the VPS.
Copy the `backups` volume to object storage or another host regularly, e.g.:

```bash
0 4 * * * docker run --rm -v friendly-crm_backups:/b -v /opt/offsite:/o alpine \
  sh -c 'cp -u /b/*.gpg /o/'   # then rsync/aws s3 sync /opt/offsite elsewhere
```

A full `pg_dump` preserves the schema, RLS policies and every `tenant_id`, so
tenant isolation is intact on restore. For the per-tenant immutable design (S3
Object Lock, incremental tiers) see `docs/backend/ARCHITECTURE.md` §3.

### One-command HTTPS after DNS

Once your domain's A record points at the VPS, `enable-https.sh` issues the
certificate and switches nginx to the 443 block for you:

```bash
bash deploy/enable-https.sh crm.yourdomain.com you@yourdomain.com
```

Invoked via `bash` rather than `./` on purpose: files copied from Windows arrive
without the executable bit, so `./enable-https.sh` would fail with "Permission
denied". `bash <script>` does not care. (`chmod +x deploy/*.sh` also works.)

## Updating the app later

Rebuild the SPA locally (`npm run build` in the project root), replace the
`dist/` folder on the VPS, then:

```bash
docker compose -f docker-compose.prod.yml restart web        # SPA only
docker compose -f docker-compose.prod.yml up -d --build api  # backend changes
```

## Troubleshooting

| Symptom | Fix |
|---|---|
| `api` container restarting | `docker compose logs api` — usually a bad `.env` value |
| 502 on `/api` | API still booting; check `depends_on` health with `docker compose ps` |
| Login screen shows "Set up Friendly CRM" | On a VPS this means the build is in **demo mode** — it was made without `VITE_API_URL`. Rebuild (Step 4), re-upload `dist/`, `restart web`. |
| Amber "Demo mode" banner in the header | Same cause as above — the browser, not Postgres, is holding the data. |
| Login says invalid for your admin | Re-run the bootstrap with `ADMIN_EMAIL`/`ADMIN_PASSWORD` (it re-hashes an existing address); confirm with `docker compose exec db psql -U postgres -d friendly_crm -c "select email from users;"` |
| Port 80 busy | Hostinger templates sometimes ship Apache: `systemctl stop apache2 && systemctl disable apache2` |

## What's inside the package

```
dist/                 ← production SPA (single-file build)
server/               ← Fastify API source + Dockerfile
server/migrations/    ← THE DATABASE: full PostgreSQL schema (RLS, RBAC,
                        audit triggers, metadata tables) applied by migrate.ts
deploy/               ← docker-compose.prod.yml, nginx.conf, env template, this guide
docs/backend/         ← architecture spec + annotated schema
```

---

## Step 10 — WhatsApp (optional)

Each sales rep links **their own** number by scanning a QR inside the ERP.
Messages then send from that rep's number, and both directions land on the
lead's timeline automatically.

### 10a — Create the database and start the gateway

```bash
cd /opt/friendly-crm/deploy

# Add EVOLUTION_API_KEY to .env first (openssl rand -hex 24)

# One-shot: create the gateway's database with explicit UTF8 encoding.
# Skipping this is the classic failure — the database inherits a legacy
# codepage and the first emoji in a message kills the send.
docker compose -f docker-compose.prod.yml -f evolution.prod.yml \
  run --rm evolution-db-init

# Start everything, gateway included
docker compose -f docker-compose.prod.yml -f evolution.prod.yml up -d
```

The gateway is **not** published to the internet — only the API container
reaches it over the compose network.

### 10b — HTTPS is required

The gateway calls back into the ERP over webhooks using `PUBLIC_URL`. A phone
will only complete the QR link against a reachable host, so finish **Step 8
(domain + HTTPS)** before linking. `PUBLIC_URL=http://VPS_IP` is fine for
testing the ERP itself, but WhatsApp linking wants the real HTTPS origin.

### 10c — Link a number

In the ERP: **Settings → Integrations → My WhatsApp → Link WhatsApp**, then on
the phone: WhatsApp → Settings → **Linked devices → Link a device** → scan.
The chip flips to *Connected* by itself. QR codes expire in ~40 seconds; press
**New QR** if it lapses.

Repeat per rep — each gets an isolated session, and by default **no one can
read anyone else's conversations** (Settings → Data Storage → Privacy).

### 10d — After a restart

A gateway restart drops the link: Evolution persists the instance status, and
if it was not `open` at shutdown it logs *"Skipping auto-connect"* and stays
closed. Chat history is unaffected — it lives in the ERP database, not the
gateway — but each rep re-scans once. Budget for this in any maintenance
window.

### 10e — Auto-reply

**Settings → Auto-Reply** has two switches, and the difference matters:

| | Risk | Default |
|---|---|---|
| **Reply to incoming messages** | Low — you are answering someone who messaged you | Off, safe to enable |
| **Greet every new lead** | Higher — an *outbound first contact* to someone who has not messaged you | Off; enable knowingly |

Everything queues with a randomised 20–60s delay, respects quiet hours and a
per-rep daily cap, and is cancelled automatically if a human replies first.
Turn on the inbound one first and watch the Queue panel before enabling
new-lead greetings.

> **Honest limitation.** Evolution is an unofficial gateway. Per-rep
> conversational use is what it is for. Bulk or unsolicited messaging risks the
> number being restricted by WhatsApp — that is a platform decision no code
> here can prevent. For high-volume campaigns use the official Meta Cloud API
> path, which the ERP also supports (Settings → Integrations).
