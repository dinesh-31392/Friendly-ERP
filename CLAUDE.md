# Friendly ERP

Multi-tenant SaaS ERP for Indian real-estate builders and contractors. React SPA
+ Fastify API + PostgreSQL, one database with row-level security rather than a
schema or database per tenant.

```
src/        the SPA (React, Tailwind, Vite → one inlined index.html)
server/     the API (Fastify, TypeScript), 68 migrations, 50 verify suites
deploy/     nginx, docker-compose, CSP generation
localdb/    embedded PostgreSQL 18 — no install, no Docker
```

## The rule that governs everything

**Tenant isolation and permissions are enforced in the DATABASE, not in the
app.** Every tenant table has an RLS policy keyed on `app_current_tenant()`, and
`has_permission()` is a SQL function. The SPA hiding a button is a convenience;
it is never the control. When you are asked whether a role can do something, the
answer is whatever the route and the policy say — check those, not the UI.

Three database roles, and the distinction matters:

| Role | RLS | Used by |
| --- | --- | --- |
| `postgres` | bypass | migrations only |
| `app_user` | **enforced** | every request handler |
| `app_platform` | bypass | login lookups, webhooks, platform jobs |

Never hand `platformPool` to a tenant-scoped handler.

## Traps that have cost real time

**A permission key lives in five places.** Adding or granting one means editing
all of them, or a newly created workspace silently lacks it while existing ones
have it:

1. a migration in `server/migrations/` — backfills workspaces that already exist
2. `server/scripts/seed.ts` — the catalog and the role map
3. `server/src/routes/tenantRoutes.ts` — self-serve signup
4. `server/scripts/seed-demo-workspace.mjs` — the demo workspace
5. `src/services/authService.ts` — the SPA's demo map

Miss one and nothing fails loudly. This has produced real bugs twice: an
accountant who could not approve a vendor bill, and a role stranded mid-workflow
with nobody able to move it. Use `/add-permission`.

**A route handler must RETURN its payload.** Calling `reply.send()` inside
`withTenantContext` sends before the transaction commits, so the client reads
its own write and sees stale data.

**A permission that is granted is not a permission that is checked.** Several
`approve_*` keys were granted to roles, read by the SPA to choose buttons, and
gated by no route at all — so the maker approved their own work and the
designated checker got a 403. Before believing a control exists:
`grep -rn "'the_key'" server/src/routes`.

**A failed fetch must not render as a result.** An empty array from a refused or
failed request has been shown as "No advances recorded" and "0 Available Units"
on workspaces that had both. Distinguish *loading*, *failed*, and *genuinely
empty* — `src/components/LoadFailed.tsx` exists for this.

**Do not build with an explicit `VITE_API_URL=/` from Git Bash.** MSYS rewrites
the lone `/` into a Windows path; the app then builds and renders but nobody can
sign in. Plain `npm run build` is correct here — `.env.local` supplies the value.

## Running it

```bash
start-friendly-erp.cmd          # database, API, web — in that order, on 5433/4000/8080
```

Or the pieces: `node localdb/start-db.mjs`, then `npx tsx src/index.ts` in
`server/`, then `node serve-full.mjs`. Dev front end is `npm run dev` (5173,
proxies `/api` to 4000). Demo logins are one per role at `<role>@acme.test` /
`Friendly@2026` — see `LOCAL-SETUP.md`.

## Verifying a change

```bash
npm test                                    # 110 SPA tests
cd server && npm run verify:<suite>         # one of 50
```

The suites need `erp_test` on 5433 and the API on 4055 with `AUTH_RATE_LIMIT_MAX`
raised — `server/README.md` has the exact environment. Getting it wrong produces
failures that look like regressions and are not.

**Two habits this codebase depends on.** They are not ceremony; both have caught
tests that were worth nothing:

- **Falsify.** Re-introduce the bug, watch the new assertion fail on the right
  line, restore. A test never seen red is a test that may not be able to go red —
  twice here, one wasn't.
- **Positive controls.** A suite of only negative assertions passes on a product
  that is broken for everyone. Pair every "must be refused" with the same action
  succeeding for whoever should be able to take it.

And prefer **read-your-writes over status codes**: a 2xx proves the request was
accepted, not that the row says what the rules require. Read it back as a
different session.

## Style

Comments explain *why*, especially where the code looks odd — a surprising line
with no reason attached invites someone to "fix" it back. Match the density
around you. Commit messages describe the defect and how it was found, not a list
of files changed.
