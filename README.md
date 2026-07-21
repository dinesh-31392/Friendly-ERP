# Friendly ERP

A multi-tenant **ERP + CRM for real estate and construction** (SaaS). Builders and
brokerages get their own isolated workspace to manage leads, site visits, bookings,
site execution (tasks, RFIs, change orders, inspections), procurement (vendors,
POs, site stock, machinery), finance (receivables, vendor bills, project budgets),
teams and reporting; a platform super-admin manages every workspace.

It ships in two forms from one codebase:

- **Browser-only demo** — the whole app builds to a single `index.html` and stores
  data in the browser (`localStorage`). Zero backend, great for trying it out.
- **Server-backed** — a Fastify + **PostgreSQL** backend where tenant isolation is
  enforced in the database with **Row-Level Security**, passwords are hashed with
  argon2id, and sessions are JWTs. This is the architecture you deploy.

---

## Tech stack

| Layer | Tech |
| --- | --- |
| Frontend | React 19, Vite 7, TypeScript (strict), Tailwind CSS 4 |
| Packaging | `vite-plugin-singlefile` → one self-contained `dist/index.html`; installable PWA |
| Backend | Fastify (Node), `node-postgres`, argon2id, HS256 JWT, `@fastify/helmet` + rate-limit |
| Database | PostgreSQL with Row-Level Security (per-tenant), composite FKs, audit log |
| Local DB | `embedded-postgres` (real PostgreSQL 18, no Docker / no install) |
| Deploy | Docker Compose (Postgres + API + nginx + certbot) |

**Roles:** `super_admin`, `tech_team` (platform staff) · `builder_admin`,
`sales_manager`, `sales_executive` (per workspace). Permissions resolve through a
single `hasPermission` source.

---

## Requirements

- **Node.js 20+** and npm
- (Server-backed only) nothing else — Postgres ships as an npm package for local
  dev; Docker is only needed for production deployment.

---

## Quick start — browser-only demo

```bash
npm install
npm run build      # produces dist/index.html (a single self-contained file)
```

Then either open `dist/index.html` directly, or serve it:

```bash
node serve-local.mjs        # http://localhost:8080
```

For live-reload development instead of a build:

```bash
npm run dev                 # Vite dev server
```

A fresh install has **no accounts and no seed data** — the first screen lets you
create the platform admin. Data lives in your browser only.

---

## Full local stack (Postgres-backed)

This runs the real server-backed version on your machine — same architecture you'd
deploy, with tenant isolation enforced by PostgreSQL — **without Docker or a
Postgres install** (Postgres ships as an npm package and runs from Node).

See **[LOCAL-SETUP.md](LOCAL-SETUP.md)** for the full walkthrough. In short:

```bash
# 1. Local PostgreSQL 18 (data persists in localdb/pgdata)
cd localdb && npm install && node start-db.mjs

# 2. Schema + RLS roles, then the permissions catalog + your admin
cd ../server && npm install
DATABASE_ADMIN_URL="postgres://postgres:postgres@localhost:5433/friendly_crm" \
APP_USER_PASSWORD="app_user_local_pw" APP_PLATFORM_PASSWORD="app_platform_local_pw" \
  npx tsx scripts/migrate.ts
DATABASE_ADMIN_URL="postgres://postgres:postgres@localhost:5433/friendly_crm" \
APP_USER_PASSWORD="app_user_local_pw" APP_PLATFORM_PASSWORD="app_platform_local_pw" \
ADMIN_EMAIL="admin@local.test" ADMIN_PASSWORD="LocalAdmin-2026-secure" \
  npx tsx scripts/seed.ts

# 3. Build the app in API mode and serve it (proxies /api → backend)
cd .. && npm run build && node serve-full.mjs 8080
```

On Windows you can just double-click **`Start Friendly CRM.bat`** (created by the
local-setup steps) to bring up all three tiers.

> **Note:** the SPA authenticates and reads (auth / leads / meta) through the API.
> Some write operations still use the browser store in demo mode; the server API is
> the source of truth for identity, tenant isolation and permissions.

---

## Deployment

Production runs on Docker Compose (Postgres + API + nginx + Let's Encrypt). The API
role is **not** a superuser and cannot bypass RLS; secrets come from an `.env` you
create from the template.

- **[deploy/DEPLOY.md](deploy/DEPLOY.md)** — step-by-step VPS deploy + HTTPS
- **[deploy/SECURITY.md](deploy/SECURITY.md)** — security model & hardening
- `deploy/.env.production.example` — copy to `.env` and change **every** value

---

## Project structure

```
src/            React app (pages, components, context, services, types)
server/         Fastify API, migrations (SQL), scripts (migrate/seed), tests
deploy/         Docker Compose, nginx, backup/restore, HTTPS, deploy & security docs
site/           Marketing website + knowledge base + API reference
localdb/         Local embedded-Postgres launcher (dev only)
public/         PWA manifest, service worker, icons
scripts/        Build helpers (icon generation)
serve-local.mjs  Static server for the demo build
serve-full.mjs   Static server + /api proxy for the full local stack
```

## Configuration notes

- **API mode** is toggled by `VITE_API_URL` at build time (set it in `.env.local`,
  e.g. `VITE_API_URL=/`). Without it, the build runs in browser-only demo mode.
- Never commit real secrets. `.env`, `.env.*` and `server/.env` are gitignored;
  use the `.env.example` templates.

---

## License

Proprietary — all rights reserved. Not licensed for redistribution.
