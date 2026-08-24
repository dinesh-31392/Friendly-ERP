# Friendly ERP

A multi-tenant **ERP for Indian real estate and construction**, sold as SaaS. One
workspace per builder or brokerage, covering the whole lifecycle: land acquisition
→ project setup → inventory → lead capture → site visits → booking → collections →
construction → handover → rental management. A platform super-admin runs every
workspace from one console.

It is an **ERP with a CRM on the front**, not a CRM with reports bolted on. The
sales pipeline is one module among fourteen; behind it sit a double-entry general
ledger, procurement and stores, contractor RA bills, payroll, and a rental
portfolio with owner payouts.

**Tenant isolation is enforced by PostgreSQL, not by application code.** Every
tenant table has row-level security `ENABLE`d *and* `FORCE`d, every tenant→tenant
foreign key is composite, and 21 verification suites assert it against a real
database on every push.

---

## Status

| | |
| --- | --- |
| Migrations | 44, applying cleanly from an empty database |
| Tenant tables | 86 of 86 with RLS enabled **and** forced |
| Single-column tenant→tenant foreign keys | 0 |
| Verification suites | 21, **540 assertions**, against a real Postgres and a real HTTP server |
| API route files | 38 |
| SPA pages | 31 |

---

## Tech stack

| Layer | Tech |
| --- | --- |
| Frontend | React 19, Vite 7, TypeScript (strict), Tailwind CSS 4 |
| Packaging | `vite-plugin-singlefile` → one self-contained `dist/index.html`; installable PWA |
| Backend | Fastify (Node), `node-postgres` with raw parameterised SQL (no ORM), argon2id, HS256 JWT, helmet + rate limiting |
| Database | PostgreSQL 18 — row-level security, composite tenant foreign keys, immutable posted ledger entries, partitioned audit log |
| Local DB | `embedded-postgres` (real PostgreSQL 18, no Docker, no install) |
| Deploy | Docker Compose (Postgres + API + nginx + certbot) |

### Modules

**Sales & CRM** leads, site visits, campaigns, chatbot capture, quotations,
channel partners · **Inventory** projects, towers, units · **Bookings &
collections** payment schedules, receipts, demand letters with delay interest ·
**Finance** chart of accounts, journal entries (immutable once posted), AP,
contractor RA bills, banking, loans, budgets, approval workflows · **RERA**
registration and the 70% designated-account position · **Procurement & stores**
materials, purchase orders, stock movements, machinery · **Site execution** tasks,
progress, RFIs, change orders, inspections · **HR** employees, attendance, leave,
payroll · **Land & BD** land leads, feasibility, market reports · **Leasing**
leases, CAM billing, owner payouts · **Portal** a separate auth realm for
customers and brokers · **WhatsApp** per-rep sessions with a durable outbox ·
**Notifications** a server-side inbox with per-user preferences.

### Roles

Platform staff: `super_admin`, `tech_team`. Per workspace: `builder_admin`,
`sales_manager`, `sales_executive`, `accountant`, `auditor`, `site_engineer`,
`telecaller`, `land_manager`, `bd_manager`.

Authorization is re-derived from the database on **every request** through
`has_permission()`, which walks the role's parent chain. There is deliberately no
super-admin bypass — a role holds a permission because it was granted, which is
why new permission keys must be backfilled by migration rather than assumed.

---

## Requirements

- **Node.js 20+** and npm
- Nothing else for local development — PostgreSQL ships as an npm package and runs
  from Node. Docker is only needed for production.

---

## Running it locally

There is **no browser-only mode**. It was removed: business data written to
`localStorage` looks like it works and is gone on the next device. `BuildGuard`
refuses to render a build with no `VITE_API_URL`, so a misconfigured build fails
loudly at startup instead of quietly storing a booking in one browser.

That means the database and API come first.

```bash
# 1. PostgreSQL 18, embedded (data persists in localdb/pgdata)
cd localdb && npm install && node start-db.mjs
```

```bash
# 2. Schema, RLS roles, permission catalog, and your first admin
cd server && npm install
DATABASE_ADMIN_URL="postgres://postgres:postgres@localhost:5433/friendly_crm" \
APP_USER_PASSWORD="app_user_local_pw" APP_PLATFORM_PASSWORD="app_platform_local_pw" \
  npx tsx scripts/migrate.ts
DATABASE_ADMIN_URL="postgres://postgres:postgres@localhost:5433/friendly_crm" \
APP_USER_PASSWORD="app_user_local_pw" APP_PLATFORM_PASSWORD="app_platform_local_pw" \
ADMIN_EMAIL="admin@local.test" ADMIN_PASSWORD="choose-a-real-one" \
  npx tsx scripts/seed.ts
```

```bash
# 3. The API
cd server && npx tsx src/index.ts        # http://localhost:4000
```

```bash
# 4. The app
npm run dev                              # http://localhost:5173
```

The dev server proxies `/api` to the API on port 4000, so local development is
**same-origin exactly like production**, where nginx does the same forwarding. Set
`API_PORT` if your API runs elsewhere. `.env.local` holds `VITE_API_URL=/`.

Sign in on the **Platform** tab with the admin you seeded. Platform staff are
enrolled in email MFA by migration 031; with no SMTP configured the code is
printed to the API log (`MAIL_TRANSPORT=console`).

**[LOCAL-SETUP.md](LOCAL-SETUP.md)** has the long-form walkthrough.

---

## Verifying it

The suites talk to a real Postgres and a real HTTP server. That is deliberate:
what this codebase gets wrong is RLS policies, permission grants and transaction
boundaries, and a mocked database cannot be wrong about any of them.

```bash
cd server && node scripts/verify-rls.mjs
```

`.github/workflows/ci.yml` runs all 21 on every push, against a Postgres service
container. Every suite is listed there; every suite on disk is named there.

Two conventions worth knowing before adding one:

- **Every refusal is paired with a success.** A suite that only asserts 403 passes
  just as happily against a server where every route is broken.
- **Money is asserted in SQL, not JavaScript.** `5444444.44 + 2333333.33` is exact
  in `numeric` and `7777777.769999999` in a float, so a JS assertion reports a
  failure that is the test's own fault.

---

## Deployment

Production runs on Docker Compose — Postgres, the API, nginx, and Let's Encrypt.
The API's database role is not a superuser and cannot bypass RLS.

```bash
VITE_API_URL=/ npm run build
node deploy/gen-csp.mjs
```

**`gen-csp.mjs` is not optional and must run after every build.** The whole app is
inlined into one `index.html`, so the Content-Security-Policy pins that inline
script by its sha256 rather than allowing `'unsafe-inline'` — which, on a
single-file build, would permit exactly what the policy exists to prevent. The
hash changes with the bundle, so a stale one is a blank page. Ship the two
generated `deploy/security-headers*.conf` files alongside `dist/`.

- **[deploy/DEPLOY.md](deploy/DEPLOY.md)** — step-by-step VPS deploy and HTTPS
- **[deploy/SECURITY.md](deploy/SECURITY.md)** — the security model
- **[docs/backend/ERP-SPEC-PROMPT.md](docs/backend/ERP-SPEC-PROMPT.md)** — the full
  build specification, including a paste-ready brief and every architectural
  invariant with the bug that produced it
- `deploy/.env.production.example` — copy to `.env` and change **every** value

If you provision Postgres by hand rather than via Docker, create the database as
`ENCODING 'UTF8' TEMPLATE template0`. The migrations contain UTF-8 characters that
a `WIN1252` database cannot store, and the failure is a confusing one.

---

## Project structure

```
src/             React app (pages, components, context, services, types)
server/          Fastify API
  migrations/    44 SQL migrations, applied in order, each in its own transaction
  scripts/       migrate, seed, and 21 verify-*.mjs suites
  src/routes/    38 route modules
deploy/          Docker Compose, nginx, CSP generation, backup/restore, docs
docs/backend/    The build specification
site/            Marketing website, knowledge base, API reference
localdb/         Embedded-Postgres launcher (dev only)
public/          PWA manifest, service worker, icons
```

## Configuration notes

- `VITE_API_URL` decides API mode at build time. `/` means same-origin, which is
  what both the dev proxy and nginx serve. Without it the build is refused at
  startup by `BuildGuard`.
- `AUTH_RATE_LIMIT_MAX` defaults to 5 login attempts per address per minute.
  **Leave it alone in production** — it exists as a setting only so the
  verification suites can sign in one after another. CI raises it; nothing else
  should.
- Never commit real secrets. `.env`, `.env.*` and `server/.env` are gitignored;
  use the `.env.example` templates.

---

## License

Proprietary — all rights reserved. Not licensed for redistribution.
