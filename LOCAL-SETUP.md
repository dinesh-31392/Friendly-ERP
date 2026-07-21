# Friendly ERP — full local stack (Postgres-backed)

This runs the **real** server-backed version on your PC — the same architecture
you'd deploy, with tenant isolation enforced by PostgreSQL — with **no Docker and
no PostgreSQL install**. The database is a genuine PostgreSQL 18 that ships as an
npm package (`embedded-postgres`) and runs from Node.

## Start it

Double-click **`Start Friendly CRM.bat`** on your Desktop. Three windows open
(Database, API, and the web server), your browser opens to the app, and you sign
in. Keep the three windows open while you use it; close them to stop.

- **App:** http://localhost:8080  (also http://YOUR-PC-IP:8080 on your Wi-Fi)
- **Sign in:** `admin@local.test` / `LocalAdmin-2026-secure`
  (you'll be prompted to set your own password if you ever issue a temp one)

## What's running

| Tier | Port | What it is |
| --- | --- | --- |
| PostgreSQL 18 | 5433 | Real Postgres, data in `localdb/pgdata` (persists) |
| Fastify API | 4000 | The backend; enforces RLS + RBAC in the database |
| Web server | 8080 | Serves the app and proxies `/api` → 4000 (like nginx) |

Because the data lives in Postgres (not the browser), it's **shared** — sign in
from any browser or device on your network and you see the same data. Tenant
isolation, permissions, argon2id passwords, and the audit log are all enforced
server-side.

## First-time setup (already done, for reference)

```bash
# 1. install the embedded Postgres binaries (once)
cd localdb && npm install embedded-postgres

# 2. start Postgres (creates the DB the first time)
node start-db.mjs

# 3. schema + roles (RLS app_user / app_platform)
cd ../server
DATABASE_ADMIN_URL="postgres://postgres:postgres@localhost:5433/friendly_crm" \
APP_USER_PASSWORD="app_user_local_pw" APP_PLATFORM_PASSWORD="app_platform_local_pw" \
npx tsx scripts/migrate.ts

# 4. permissions catalog + your admin
DATABASE_ADMIN_URL="postgres://postgres:postgres@localhost:5433/friendly_crm" \
APP_USER_PASSWORD="app_user_local_pw" APP_PLATFORM_PASSWORD="app_platform_local_pw" \
ADMIN_EMAIL="admin@local.test" ADMIN_PASSWORD="LocalAdmin-2026-secure" \
npx tsx scripts/seed.ts

# 5. build the app in API mode  (soft/.env.local holds VITE_API_URL=/)
cd .. && npm run build
```

## Notes

- **API mode is set by `soft/.env.local`** (`VITE_API_URL=/`). That's what makes
  the built app talk to the backend instead of using browser storage. It's
  gitignored, so it won't ship in the repo. Delete it and rebuild to get the
  standalone browser-only demo build back.
- **Reset everything:** stop the stack, delete `localdb/pgdata`, and run the
  first-time setup again — you'll get a clean, empty database.
- **These credentials are for local development only.** The Postgres superuser is
  `postgres/postgres` and the role passwords are simple on-purpose; do not reuse
  this setup, or these values, for anything internet-facing.
- **The database created with WIN1252 by default** (Windows locale); the setup
  recreates `friendly_crm` as UTF-8 so the schema's Unicode comments load. If you
  wipe `pgdata` and re-init, recreate the DB as UTF-8 before migrating.
