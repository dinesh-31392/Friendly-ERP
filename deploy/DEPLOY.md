# Friendly CRM — Deployment Guide (Hostinger VPS, KVM 4)

Everything runs in Docker on a single VPS: **PostgreSQL 16** (the database),
the **Fastify API** (auth + leads + metadata, RLS-enforced), and **nginx**
serving the CRM app and proxying `/api`. KVM 4 (4 vCPU / 16 GB) is more than
enough — this stack idles under 1 GB.

> The CRM also runs fully standalone in demo mode (browser localStorage) the
> moment nginx serves it — the backend activates real multi-tenant auth and
> the leads API when you flip the SPA's API flag (Step 7).

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

## Step 4 — Upload the package

From your local machine (where `friendly-crm-deploy.zip` is):

```bash
scp friendly-crm-deploy.zip root@YOUR_VPS_IP:/opt/
ssh root@YOUR_VPS_IP
cd /opt && apt-get install -y unzip && unzip friendly-crm-deploy.zip -d friendly-crm
cd friendly-crm/deploy
```

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

Open `http://YOUR_VPS_IP` in a browser. This build ships with **no seed data and
no default credentials**, so the first load shows **first-run setup**: create your
platform administrator there, then sign in. Setup runs once — once an account
exists the screen is replaced by the normal sign-in form.

## Step 7 — Switch the app to the real backend

In the browser console on your CRM page:

```js
localStorage.setItem('friendly_crm_api_url', window.location.origin); location.reload();
```

Login now authenticates against PostgreSQL (JWT + argon2id + row-level
security), and the Leads page reads from the API. Remove the key to fall back
to demo mode. (When the Phase-2 write APIs land, this flag becomes the default.)

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
./deploy/enable-https.sh crm.yourdomain.com you@yourdomain.com
```

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
| Login screen shows "Set up Friendly CRM" | Expected on a fresh install — there are no default accounts. Create your administrator there. |
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
