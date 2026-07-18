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

## What's next (per the cutover plan)

1. Lead **writes** (POST/PATCH) + stage validation against `schema_definitions`
2. Ingestion queue (BullMQ): dedup → score → route → WhatsApp welcome workers
3. Remaining entities (projects, units, bookings, invoices…) — same pattern
4. Portal JWT audience + portal endpoints
5. Backup worker (`ARCHITECTURE.md` §3) and export jobs
