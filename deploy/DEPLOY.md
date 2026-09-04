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
node deploy/gen-csp.mjs           # → deploy/security-headers*.conf
```

**`gen-csp.mjs` is not optional, and it must run after every build.** The entire
app is inlined into `index.html`, so the Content-Security-Policy pins that inline
script by its sha256 hash rather than allowing `'unsafe-inline'` — which, for a
single-file build, would permit exactly what the policy exists to prevent. The
hash changes with the bundle, so a stale one means the browser refuses the only
script on the page and users get a blank screen. Ship the two generated
`.conf` files alongside `dist/`.

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

### Upgrading a deployment that already exists

If this VPS was set up before migrations 028–030, `run --rm migrate` above
applies them and you should know what changes:

- **028** backfills the permission catalog into tenants that already exist.
  Permission keys were only ever written at bootstrap, so a workspace created
  before HR, procurement, site execution or land/BD shipped was never granted
  their keys — and `has_permission()` has no super-admin bypass, so those four
  modules returned 403 to *every* user in that workspace, including its owner.
  After this migration they work. Nothing is revoked: a role you widened by
  hand keeps what you gave it, and a custom role is left untouched.
- **029** adds 20 composite indexes and revokes the app role's write access to
  the migration ledger. Index creation briefly blocks writes on those tables;
  pre-launch that is free, on a busy database do it in a quiet window.
- **030** adds the `invoices` and `crm_tasks` tables. Nothing to migrate into
  them — they replace data that only ever lived in a browser.

### Onboarding your first builder

The platform admin you just created belongs to the `platform` tenant, which is
the console — not a workspace you sell. Create a real builder workspace with:

```bash
curl -sX POST http://localhost/api/tenants \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"Acme Builders","slug":"acme","email":"ops@acme.com",
       "adminName":"Priya Sharma","adminEmail":"priya@acme.com"}'
```

(`$TOKEN` comes from `POST /api/auth/login` as the platform admin.)

One transaction creates the workspace, its nine roles with their grants, the
lead pipeline, and the administrator. **The response carries `tempPassword` and
that is the only time it is readable** — hand it over out of band; the admin is
forced to change it on first sign-in.

Do this once before you hand the system to anyone. A workspace missing its lead
pipeline signs in perfectly and then refuses every lead with a bare constraint
error, so "it provisioned fine" is not the same as "it works" — verify by
creating one lead as the new admin.

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

## Step 8c — Schedule the monthly rent run (only if you use Leasing)

Skip this entirely if you do not rent units out. If you do, **read it**: rent
invoices are not raised by a background job. Nothing bills your occupants until
`POST /api/leasing/run-billing` is called, and a rental portfolio where nobody
presses the button is a month of rent nobody asked for.

Two ways to run it, in order of preference:

**1. A cron on the VPS.** The endpoint is idempotent — it is keyed on
`(lease_id, period_start)` in the database, so running it twice, or ten times,
raises each period exactly once. That is what makes it safe to schedule
aggressively rather than exactly.

```bash
# /etc/cron.d/friendly-erp-rent — 06:15 on the 1st of every month
15 6 1 * * root curl -sS -X POST https://YOUR_DOMAIN/api/leasing/run-billing \
  -H "Authorization: Bearer $LEASING_CRON_TOKEN" -H 'Content-Type: application/json' -d '{}' \
  >> /var/log/friendly-erp-rent.log 2>&1
```

`LEASING_CRON_TOKEN` is an ordinary login token for a user holding
`manage_leasing`. Tokens last 24h, so **do not** paste a personal one into cron
and forget it — create a dedicated service account for this, and re-issue on a
schedule, or use option 2.

**2. A person.** Leasing → **Run monthly billing**, once a month. The button
reports exactly what it newly raised ("Already up to date" when there is nothing
to do), so it is safe to press whenever anyone is unsure.

Owner payouts are deliberately *not* automated: they move money to a landlord,
so `Prepare statements` is a human action, and approval is a second permission
on top (`approve_owner_payouts`).

## Step 9 — Backups (do not skip)

Backups are **encrypted and automatic** — the `backup` service runs daily with
14-day retention into the `backups` volume. It starts with the stack; just set
`BACKUP_PASSPHRASE` in `.env` (store that passphrase somewhere OTHER than the
server).

**Two artefacts are written each night, and you need both.**

| File | Holds |
|---|---|
| `friendly_crm-<stamp>.sql.gz.gpg` | the database |
| `friendly_crm-files-<stamp>.tar.gz.gpg` | uploaded documents |

The database stores a *storage key*, never the bytes of a file. Restoring the
dump alone gives you a complete list of agreements, KYC scans and demand
letters in which **every download 404s** — an archive that is lost but looks
intact. Restore the pair, and restore matching timestamps: a database newer
than the files references documents that were never archived.

```bash
# Take a backup right now (writes both artefacts):
docker compose -f docker-compose.prod.yml exec backup /bin/sh /usr/local/bin/backup.sh

# List them:
docker compose -f docker-compose.prod.yml exec backup ls -lh /backups

# TEST YOUR RESTORE (do this before you need it — an untested backup is a guess):
docker compose -f docker-compose.prod.yml exec backup \
  /bin/sh /usr/local/bin/restore.sh /backups/friendly_crm-YYYYMMDD-HHMMSS.sql.gz.gpg

# The documents. The backup service mounts the volume READ-ONLY so it can never
# alter what it archives, so a file restore needs its own writable mount:
docker compose -f docker-compose.prod.yml run --rm \
  -v friendly-crm_uploads:/data/uploads backup \
  /bin/sh /usr/local/bin/restore.sh /backups/friendly_crm-files-YYYYMMDD-HHMMSS.tar.gz.gpg
```

**Get the backups off the box.** A backup on the same VPS dies with the VPS.
Copy the `backups` volume to object storage or another host regularly, e.g.:

```bash
0 4 * * * docker run --rm -v friendly-crm_backups:/b -v /opt/offsite:/o alpine \
  sh -c 'cp -u /b/*.gpg /o/'   # then rsync/aws s3 sync /opt/offsite elsewhere
```

### Check the box before you trust it

`preflight` asserts the configuration the API is *actually running with*, not
the one `.env` describes. It exists because every defect it looks for was
found by hand in a deployment that looked correct: a variable filled in
correctly and never passed to the container, or a library default that is
right on a laptop and wrong on a VPS. None of them break the boot — the stack
comes up healthy and the product is quietly missing pieces.

```bash
# Run it where the API runs — same env, same filesystem, same database:
docker compose -f docker-compose.prod.yml run --rm \
  -v friendly-crm_uploads:/data/uploads api node scripts/preflight.mjs
```

It exits non-zero on a **blocker** — something a customer meets on day one
(no SMTP so nobody with MFA can sign in; an unwritable upload directory; a
migration that never ran; a tenant table without forced RLS). Advisories are
worth reading but are often deliberate.

You can also point it at an `.env` file before you ship it:

```bash
cd server && node scripts/preflight.mjs ../deploy/.env
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

Rebuild the SPA locally (`npm run build` in the project root), **re-run
`node deploy/gen-csp.mjs`**, then replace both the `dist/` folder and the two
`deploy/security-headers*.conf` files on the VPS, and:

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

## Step 11 — Sharing a VPS that already hosts another site

If this VPS already serves WordPress (or anything else) on port 80/443, the
base stack will not start: its `web` service publishes those ports and Docker
reports "address already in use".

Nothing else conflicts. Postgres is not published at all, the API is only
`expose`d on the compose network, and a KVM 4 has ample headroom for both — the
ERP idles at roughly 400–700 MB across Postgres, the API and nginx. Check yours
with `free -h` before starting; the number that matters is that Postgres has
room to cache, not that the containers fit.

**Your existing email is unaffected either way.** Mail routing is MX. Whether
you add a subdomain to the WordPress domain or use a completely separate
domain, the Microsoft 365 records on the original domain are untouched. Do not
edit its MX, SPF, DKIM or DMARC.

### 11a — Point the ERP's domain at the VPS

**A separate domain (recommended).** Keeping the ERP off the marketing domain
means a WordPress compromise and an ERP compromise stay separate incidents, and
cookies cannot be shared between them. At the new domain's DNS host:

```
Type  Name  Value          TTL
A     @     YOUR_VPS_IP    300
A     www   YOUR_VPS_IP    300
```

Its nameservers must be somewhere you can edit records — if the domain is
registered at Hostinger, point it at Hostinger's nameservers and use hPanel's
DNS zone editor.

Serve **one** of apex or www and redirect the other; the vhost templates treat
the apex as canonical. Two live hostnames means two session cookies and users
signed in on one but not the other.

That domain needs no MX record at all unless you also want mail on it. The ERP
sends nothing by email — WhatsApp goes out through the gateway, not SMTP.

**A subdomain instead.** One record, `A  erp  YOUR_VPS_IP`, and drop every
`www.ERP_DOMAIN` line from the vhost template.

Either way, wait for it to resolve before issuing a certificate:

```bash
dig +short yournewdomain.com        # must return YOUR_VPS_IP
dig +short www.yournewdomain.com
```

Certbot fails otherwise, and Let's Encrypt rate-limits repeated failures — five
per hostname per hour, which is easy to burn while guessing at DNS.

### 11b — Move the ERP off ports 80/443

```bash
cd /opt/friendly-crm/deploy
docker compose version          # must be v2.24+ for the overlay's !override

docker compose -f docker-compose.prod.yml -f docker-compose.coexist.yml up -d
```

Confirm it is bound to loopback and nothing else:

```bash
ss -lptn 'sport = :8080'                  # docker-proxy on 127.0.0.1:8080
curl -s localhost:8080/api/health          # {"ok":true,...}
curl -s https://yourdomain.com -o /dev/null -w '%{http_code}\n'   # WordPress: 200
```

That last check matters. Verify WordPress still answers *before* you touch its
web server config, so if something breaks later you know which change did it.

### 11c — Proxy the subdomain to it

Find out what is serving WordPress:

```bash
ss -lptn 'sport = :443'      # look for nginx, apache2, litespeed, or docker-proxy
```

Then issue the certificate and install the vhost. **Use `--webroot`, never
`--standalone`** — standalone needs port 80, which your web server is holding,
so it fails; and freeing the port means taking WordPress down to issue a cert.

```bash
D=yournewdomain.com          # the ERP's domain, apex form, no www

# Both names on ONE certificate. Drop -d www.$D for a subdomain.
certbot certonly --webroot -w /var/www/html -d $D -d www.$D

# nginx
cp host-vhost-nginx.conf.template /etc/nginx/sites-available/$D
sed -i "s/ERP_DOMAIN/$D/g" /etc/nginx/sites-available/$D
ln -s /etc/nginx/sites-available/$D /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx

# Apache
a2enmod proxy proxy_http headers ssl rewrite
cp host-vhost-apache.conf.template /etc/apache2/sites-available/$D.conf
sed -i "s/ERP_DOMAIN/$D/g" /etc/apache2/sites-available/$D.conf
a2ensite $D && apachectl configtest && systemctl reload apache2
```

Note the double quotes on `sed` — single quotes would insert the literal
string `$D` into your config.

`nginx -t` / `apachectl configtest` before every reload. A syntax error in the
new vhost takes down WordPress too — same process, one bad config.

Then point the app at its own domain in `.env`:

```bash
PUBLIC_URL=https://yournewdomain.com
CORS_ORIGIN=https://yournewdomain.com
```

```bash
docker compose -f docker-compose.prod.yml -f docker-compose.coexist.yml up -d api
```

Both matter. `CORS_ORIGIN` is an allow-list — a mismatch and every API call
fails in the browser while `curl` still works, which reads as "the app is
broken" rather than "one env var is wrong". `PUBLIC_URL` is what the WhatsApp
gateway is told to send webhooks to; if it still says the old address, inbound
customer messages simply never arrive and nothing logs an error. If you change
the domain later, reconnect each rep's WhatsApp session so the webhook is
re-registered.

The SPA itself needs no rebuild — it was built for same-origin `/api`, so it
follows whatever hostname it is served from.

### 11d — Do NOT run enable-https.sh in this mode

It drives the containerised certbot and rewrites the container's nginx.conf,
both of which assume the stack owns port 80. In coexist mode the host owns TLS;
the ERP's own nginx only ever speaks plain HTTP on loopback, which is correct —
the encrypted hop ends at the host proxy, and the loopback hop never leaves the
machine.

Renewal is the host's existing certbot timer. It already runs for WordPress;
the new certificate joins it. Confirm with `certbot renew --dry-run`.

### 11e — If you use a control panel

CyberPanel, Plesk, CloudPanel and hPanel all manage their own web server config
and can overwrite hand-edited vhosts on update. Where the panel offers a
"reverse proxy" or "proxy pass" field for a subdomain, use that instead of the
templates here and point it at `http://127.0.0.1:8080`. The proxy headers in the
templates are the part to carry across — particularly `X-Forwarded-For`, which
the login rate limit and the audit trail both depend on.

## Step 12 — Sign-in codes by email

Platform admins sign in with a password **and** a 6-digit code emailed to them.
The account that can reach every workspace should not be one stolen password
away from an attacker.

**Set this up before you rely on the account.** With no mail configured, an
account with MFA enabled cannot sign in at all — the password is accepted and
then the code cannot be delivered, which is a 503 and a locked-out admin.

### 12a — Gmail

Gmail needs an **App Password**, not your Google password. Google stopped
accepting account passwords for SMTP in 2022.

1. Turn on **2-Step Verification** at
   [myaccount.google.com/security](https://myaccount.google.com/security).
   App Passwords do not exist without it — the page simply will not offer them.
2. Go to [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords),
   name it "Friendly ERP", and copy the 16-character password.
3. Put it in `.env` **with the spaces removed**:

```bash
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=youraccount@gmail.com
SMTP_PASS=abcdefghijklmnop
SMTP_FROM=Friendly ERP <youraccount@gmail.com>
```

Google displays the password as `abcd efgh ijkl mnop` for readability. The
spaces are not part of it, and pasting them is the most common reason
authentication fails.

`SMTP_FROM` must be the Gmail address itself or a verified alias — Gmail
rewrites or rejects anything else.

### 12b — Test it before trusting it

```bash
docker compose -f docker-compose.prod.yml -f docker-compose.coexist.yml \
  run --rm api node scripts/test-mail.mjs you@example.com
```

It verifies the credentials, sends a real message, and translates the usual SMTP
failures into what actually caused them. **Check spam as well as the inbox** — a
sign-in code in a spam folder is a locked-out admin.

### 12c — What Gmail is and is not good for

A Gmail account is fine for a handful of platform admins: the free limit is
around 500 messages a day, and sign-in codes are a few per person per week.

It is not the right sender if you later enable codes for every user across every
tenant. At that volume you want a transactional provider — Resend, Postmark,
Brevo — which the same four variables already support, because Google throttles
bulk sending from personal accounts and a throttled login code is an outage.

### 12d — Bringing a server up before mail works

```bash
MAIL_TRANSPORT=console
```

Codes are printed to the container log instead of emailed:

```bash
docker compose -f docker-compose.prod.yml logs api | grep 'Sign-in code'
```

Useful for a first login on a box whose SMTP is not sorted yet. It warns on
every send, because a deployment left in this mode is writing working
credentials into its logs — remove it as soon as real mail works.

### 12e — Turning it on or off for an account

Enrolment is per user. Platform staff are enrolled by migration 031; everyone
else is opt-in.

```sql
-- Require codes for a user
UPDATE users SET mfa_email_enabled = true WHERE email = 'someone@example.com';

-- Emergency: an admin locked out because mail broke. Fix the mail instead
-- where you can — this leaves the account on a password alone.
UPDATE users SET mfa_email_enabled = false WHERE email = 'someone@example.com';
```
