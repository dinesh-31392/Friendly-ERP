# Friendly ERP — full local stack (Postgres-backed)

This runs the **real** server-backed version on your PC — the same architecture
you'd deploy, with tenant isolation enforced by PostgreSQL — with **no Docker and
no PostgreSQL install**. The database is a genuine PostgreSQL 18 that ships as an
npm package (`embedded-postgres`) and runs from Node.

## Start it

Double-click **`Start Friendly ERP.cmd`** on your Desktop (the same file lives at
`soft/start-friendly-erp.cmd`). Three windows open — Database, API, web server —
your browser opens to the app, and you sign in. Keep the three windows open while
you use it; closing them stops it. If there is no `dist/` yet the launcher builds
one first, which takes about a minute.

- **App:** http://localhost:8080  (also http://YOUR-PC-IP:8080 from your phone on
  the same Wi-Fi — the web-server window prints the exact address)

### Sign in

The demo workspace, **Acme Builders**, has an account per role. All use the
password `Friendly@2026`:

| Email | Role | What it is for |
| --- | --- | --- |
| `admin@acme.test` | Builder admin | The owner. Sees every module. |
| `manager@acme.test` | Sales manager | Whole pipeline, reassigns leads |
| `sales@acme.test` | Sales executive | Own leads only — shows the scoping |
| `tele@acme.test` | Telecaller | Call list |
| `site@acme.test` | Site engineer | Attendance, progress, RA sign-off |
| `accounts@acme.test` | Accountant | Ledger, invoices, vendor bills |
| `hr@acme.test` | HR manager | Roster, leave, payroll |
| `land@acme.test` / `bd@acme.test` | Land / BD | Acquisition pipeline |
| `auditor@acme.test` | Auditor | Reads everything, writes nothing |

Signing in as different roles is the quickest way to see that permissions are
enforced in the database rather than by hiding buttons.

**The platform owner account** (`admin@local.test`, super admin — administers
every workspace) exists but its password is whatever was passed as
`ADMIN_PASSWORD` when `scripts/seed.ts` was first run, so it may not be what an
older copy of this file said. To set your own without touching the demo data:

```bash
cd server
ADMIN_EMAIL=admin@local.test ADMIN_PASSWORD='<choose one>' npx tsx scripts/seed.ts
```

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
- **Port 8080 is claimed twice.** `start-erp-stack.cmd` puts the WhatsApp gateway
  (Evolution API) there, and this stack puts the app there. They cannot both run.
  Use `start-friendly-erp.cmd` unless you are specifically working on WhatsApp;
  the web server takes a port as its first argument if you need to move it
  (`node serve-full.mjs 9000`).
- **Refill the demo workspace:** `node server/scripts/seed-demo-workspace.mjs`.
  It deletes and recreates the `acme` tenant, so anything you entered there is
  lost — the platform account and any other workspace are untouched.
- **Never build from Git Bash with an explicit `VITE_API_URL=/`.** MSYS rewrites
  the lone `/` into a Windows path, and the app then builds and renders but
  cannot log in, because every request resolves to a `file://` URL. Plain
  `npm run build` is safe here (`.env.local` supplies the value); if you do need
  the variable, prefix the command with `MSYS_NO_PATHCONV=1`. `vite.config.ts`
  refuses the mangled value rather than shipping it.
- **Reset everything:** stop the stack, delete `localdb/pgdata`, and run the
  first-time setup again — you'll get a clean, empty database.
- **These credentials are for local development only.** The Postgres superuser is
  `postgres/postgres` and the role passwords are simple on-purpose; do not reuse
  this setup, or these values, for anything internet-facing.
- **The database created with WIN1252 by default** (Windows locale); the setup
  recreates `friendly_crm` as UTF-8 so the schema's Unicode comments load. If you
  wipe `pgdata` and re-init, recreate the DB as UTF-8 before migrating.
