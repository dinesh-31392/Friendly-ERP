# Friendly CRM — API Server (Phase 1: auth + leads read + metadata)

Fastify + TypeScript + PostgreSQL with Row-Level Security. Implements the
architecture in [`../docs/backend/ARCHITECTURE.md`](../docs/backend/ARCHITECTURE.md).

## Quick start

```bash
cd server
cp .env.example .env          # dev defaults work out of the box
npm install
npm run db:up                 # PostgreSQL 16 in Docker (port 5433)
npm run db:migrate            # creates roles + applies migrations/*.sql
npm run db:seed               # demo tenant, users (password123), leads
npm run dev                   # API on http://localhost:4000
```

Smoke test:

```bash
curl http://localhost:4000/api/health
curl -X POST http://localhost:4000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"rahul@skylinebuilders.com","password":"password123"}'
# → { token, user, tenant }  — then:
curl http://localhost:4000/api/leads -H "Authorization: Bearer <token>"
curl http://localhost:4000/api/meta/lead -H "Authorization: Bearer <token>"
```

## Point the SPA at the API (feature flag)

In the browser console of the running SPA:

```js
localStorage.setItem('friendly_crm_api_url', 'http://localhost:4000'); location.reload();
```

Login and the Leads page now go through the backend (JWT + RLS). Remove the
key to return to pure-localStorage demo mode — zero behavior change when off.

```js
localStorage.removeItem('friendly_crm_api_url'); location.reload();
```

## Security model (recap)

- The API connects as `app_user` (`NOBYPASSRLS`). Every handler runs inside
  `withTenantContext()` — a transaction that sets `app.current_tenant_id`
  from the **verified JWT**. RLS policies do the isolation; a handler that
  forgets a WHERE clause still cannot cross tenants.
- The login route alone uses `app_platform` (BYPASSRLS) for the credential
  lookup, since identity isn't known pre-auth. It reads one user row and
  returns a constant-shape error for all failure modes (no enumeration).
- Passwords: argon2id. Permissions: checked **in the database** per request
  via `has_permission()` — the DB is the single source of RBAC truth.
- Every INSERT/UPDATE/DELETE on business tables is captured by the audit
  trigger with actor, IP, and full before/after state.

## Running the verification suites locally

The `verify:*` scripts are integration tests: they drive a **running API over
HTTP** against a **separate database**. They do not start either for you, and
they fail with `ECONNREFUSED` rather than a message saying so, which is easy to
misread as a broken build.

The recipe below mirrors the `verify` job in `.github/workflows/ci.yml` — keep
the two in step.

```bash
# 1. Postgres on 5433 (leave it running)
node localdb/start-db.mjs

# 2. Point everything at the TEST database, not your dev one.
#    The suites hardcode erp_test and expect the API on 4055.
export DATABASE_ADMIN_URL="postgres://postgres:postgres@localhost:5433/erp_test"
export DATABASE_URL="postgres://app_user:<dev-pw>@localhost:5433/erp_test"
export DATABASE_PLATFORM_URL="postgres://app_platform:<dev-pw>@localhost:5433/erp_test"
export JWT_SECRET="ci-only-secret-not-used-anywhere-real-0123456789ab"
export PORT=4055
export PUBLIC_URL="http://localhost:4055"   # WhatsApp connect refuses without it
export MAIL_TRANSPORT=console               # verify:mfa reads codes from the log
export AUTH_RATE_LIMIT_MAX=200              # 5 would throttle suite 2 onward
export EVOLUTION_API_URL="" EVOLUTION_API_KEY=""
export RAZORPAY_KEY_ID=rzp_test_ci_only
export RAZORPAY_KEY_SECRET=ci-only-not-a-real-secret-0123456789
export RAZORPAY_WEBHOOK_SECRET=ci-only-webhook-secret-0123456789

# 3. Schema, catalog, fixtures
npx tsx scripts/migrate.ts
ADMIN_EMAIL=ci@erptest.local ADMIN_PASSWORD=ci-bootstrap-password-not-reused \
  npx tsx scripts/seed.ts
node scripts/seed-test-fixtures.mjs

# 4. API on 4055, then the suites
npx tsx src/index.ts &
npm run verify:rls          # or any other verify:* script
```

Two traps worth knowing about, both of which have cost real time:

- **`AUTH_RATE_LIMIT_MAX`** defaults to 5. Every suite signs in, so without
  raising it here everything past the first fails on throttling rather than on
  what it tests.
- **A long-lived `erp_test` rots.** Fixture addresses are upserted per
  `(tenant_id, email)`, so a renamed fixture tenant used to leave the same admin
  in two workspaces. The login route resolves an email without a tenant slug and
  refuses when it is ambiguous — reporting the same "Invalid email or password"
  it gives a wrong password, by design — so three isolation suites failed with no
  hint at the cause. `seed-test-fixtures.mjs` now deletes strays, so re-running
  it repairs the database.

## What's next (per the cutover plan)

1. Lead **writes** (POST/PATCH) + stage validation against `schema_definitions`
2. Ingestion queue (BullMQ): dedup → score → route → WhatsApp welcome workers
3. Remaining entities (projects, units, bookings, invoices…) — same pattern
4. Portal JWT audience + portal endpoints
5. Backup worker (`ARCHITECTURE.md` §3) and export jobs
