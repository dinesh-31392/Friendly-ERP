# Friendly CRM — Security Audit Summary

Applied across a 5-step audit (secret hygiene, PII flow, pre-deploy, deep
logic, attacker's-eye). What's in place and what you must still do.

## ✅ In place

**Secrets** — No secret exists as a string literal anywhere in source. Every
credential (DB URLs, `JWT_SECRET`, role passwords) is read from environment
variables and injected via `.env` at deploy time. `.gitignore` excludes all
`.env` files; `.env.example` / `.env.production.example` carry placeholders
only. The API fails to start if a critical variable is missing.

**Auth & data isolation** — Passwords hashed with **argon2id** (never MD5/
SHA, never stored/returned/logged in plaintext). JWTs are HS256-pinned with a
24h expiry and issuer check. **PostgreSQL Row-Level Security** enforces tenant
isolation at the database layer: every query is automatically scoped to the
caller's tenant via a per-transaction session variable, so IDOR (changing an
ID in a request to read another tenant's data) is structurally impossible even
if application code has a bug. RBAC (`has_permission()`) is checked server-side
in the database, not by hiding UI. The app role runs `NOBYPASSRLS`; the
BYPASSRLS role is used only for the pre-auth login lookup.

**Transport & headers** — nginx sends `X-Content-Type-Options: nosniff`,
`X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, a locked-down
`Content-Security-Policy`, and (once SSL is on) `Strict-Transport-Security`
for one year. The API adds the same via `@fastify/helmet`.

**Rate limiting** — `@fastify/rate-limit`: 120 req/min global, **5 login
attempts per IP per minute** (brute-force defense).

**Error handling** — A global handler logs full errors server-side against a
correlation id and returns only `{error, correlationId}` — no stack traces,
SQL, tenant UUIDs, or file paths reach the client.

**CORS** — Restricted to your `PUBLIC_URL` (never `*`).

**Network** — Postgres and the API are internal-only (no published ports);
only nginx exposes 80/443. Debug logs removed; no test/backdoor endpoints.

**Audit trail** — Every INSERT/UPDATE/DELETE on business tables is captured by
a database trigger with actor, IP, and full before/after state.

## ⚠️ You must do before/at launch

1. **Rotate every secret.** The dev values in `.env.example` and any value
   ever committed to git are compromised by definition — generate fresh ones
   (`openssl rand -hex 24`) for production. If you previously committed a real
   secret, it lives in git history forever; rotate it now.
2. **Enable HTTPS** (DEPLOY.md Step 8) before handling real client data — the
   HSTS/redirect blocks are ready to uncomment.
3. **No default credentials exist — and that is deliberate.** This build ships
   with no demo tenant, no demo users, and no sample data. `seed.ts` seeds only
   the permissions catalog and creates the administrator YOU name via
   `ADMIN_EMAIL` / `ADMIN_PASSWORD` (it rejects passwords under 12 characters
   and known placeholders). The SPA's first load runs one-time setup where you
   choose the platform admin password. Nothing to "remember to change".
4. **Set up backups** (DEPLOY.md Step 9).

## Notes / scope

- **No real payment processor.** Billing and invoices are internal records;
  plan changes move no money. There is no price-tampering or webhook-signature
  surface to attack.
- **Demo mode uses localStorage.** With the API flag off, the CRM runs entirely
  in the browser (plaintext, single-device) — fine for evaluation, not for
  real client data. The backend (this package) is what provides real auth,
  hashing, and isolation; turn it on per DEPLOY.md Step 7.
- **No password-reset flow yet.** Admins reset team passwords from Settings;
  the super admin resets a builder-admin password from Platform Control. A
  self-service email reset is a Phase-2 item.
- No AI audit replaces a professional human review before a large-scale
  launch handling sensitive data.
