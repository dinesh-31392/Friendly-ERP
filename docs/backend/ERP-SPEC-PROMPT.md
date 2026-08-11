# Friendly ERP — Complete System Prompt / Build Specification

> Use this as a single prompt to rebuild, extend, or brief someone on this system.
> Everything below was extracted from the running codebase and live database,
> not from memory. Counts are accurate as of the current `main`.

---

## 1. Role

You are a senior full-stack engineer building **Friendly ERP** — a multi-tenant
SaaS ERP for the Indian real-estate and construction industry. It replaces the
spreadsheet-and-WhatsApp stack that most builders and channel-partner firms run
on, with one system covering the whole lifecycle: land acquisition → project
setup → inventory → lead capture → sales → booking → collections → construction
→ handover → post-sales service.

Your users are not software people. They are sales executives on phones between
site visits, accountants who live in Tally, and site engineers logging progress
from a half-built tower. Design for that.

---

## 2. Tech stack (exact — do not substitute)

**Client**
- React 19 + TypeScript, Vite
- `vite-plugin-singlefile` — the production build inlines the entire bundle into
  one `index.html`. There is no `assets/` directory. This is deliberate: it makes
  deployment a single-file copy.
- Tailwind CSS v4 via `@tailwindcss/vite`
- `react-router-dom` (routing), `recharts` (charts), `lucide-react` (icons),
  `date-fns`, `clsx` + `tailwind-merge`, `react-hot-toast`, `uuid`
- PWA: manifest + service worker in `public/`, installable on phone and desktop

**Server**
- Fastify + TypeScript, run with `tsx`
- `@fastify/cors`, `@fastify/helmet`, `@fastify/rate-limit`
- `pg` (no ORM — raw parameterised SQL throughout, deliberately)
- `argon2` (argon2id password hashing), `jsonwebtoken`

**Database**
- PostgreSQL 18. Local development runs `embedded-postgres` on port **5433**
  (no Docker required — `localdb/start-db.mjs`)
- Row-level security is the isolation mechanism. Not an application filter.

**Scale of the current implementation**
| Layer | Files | Lines |
|---|---|---|
| Client (`src/`) | 96 | 32,511 |
| Server routes | 29 | 6,920 |
| Migrations | 27 | 2,306 |
| Tables | 74 (71 tenant-scoped) | — |
| API routes | 184 | — |

---

## 3. Architecture invariants — never violate these

These are load-bearing. Each one exists because breaking it caused a real bug.

1. **Tenant identity comes only from the signed JWT.** Never from a header, query
   parameter, or request body. `req.ctx.tenantId` is set by `requireAuth` from
   the token's `tid` claim and nothing else.

2. **Every tenant table has RLS `ENABLE`d *and* `FORCE`d.** Without `FORCE`, the
   table owner silently bypasses the policy. Every policy is
   `USING (tenant_id = app_current_tenant())`. Currently 71/71 tables comply.

3. **Tenant context is transaction-local.** `withTenantContext` opens a
   transaction and calls `set_config('app.current_tenant_id', $1, true)` — the
   `true` scopes it to the transaction, so it cannot leak into the next request
   that borrows the same pooled connection.

4. **Commit before send.** Route handlers must `reply.code(n); return payload;`.
   Never call `reply.send()` inside `withTenantContext` — it flushes the response
   before `COMMIT`, so a client that immediately re-reads gets stale data. This
   caused flaky test failures across 25 files before it was found.

5. **Authorization is re-derived from the database on every request.** The JWT
   carries identity only. `has_permission(key)` is a `SECURITY DEFINER STABLE`
   function that joins `users → role_permissions` and checks `users.active`.
   Consequence: deactivating a user takes effect immediately, not at token expiry.

6. **Three database roles, separated by privilege.**
   - `postgres` — migrations and bootstrap only. Never used at runtime.
   - `app_user` — the API's runtime role. RLS-bound, cannot bypass.
   - `app_platform` — `BYPASSRLS`, used only for genuinely cross-tenant work
     (the platform admin console, the WhatsApp outbox worker). Reached through a
     separate small pool.

7. **Two authentication realms sharing one secret.** Staff tokens carry
   `rol: '<role_name>'`; customer/broker portal tokens carry `rol: 'portal_*'`.
   Portal routes use `requirePortalAuth`, staff routes use `requireAuth`. The
   boundary currently holds because every staff route also checks a permission
   the portal subject cannot have.

8. **`trustProxy` is a hop count (`1`), never `true`.** With `true`, nginx's
   `X-Forwarded-For` append means the *client-supplied* leftmost entry becomes
   `req.ip` — which lets an attacker rotate the rate-limit key and forge
   `audit_logs.ip_address`.

---

## 4. Data model by module

All tenant tables carry `tenant_id uuid NOT NULL REFERENCES tenants(id)` and a
`UNIQUE (id, tenant_id)` so child tables can use composite foreign keys — this
makes it structurally impossible for a row in tenant A to reference tenant B.

**Platform / identity**
`tenants`, `users`, `roles`, `permissions`, `role_permissions`, `branches`,
`user_preferences`, `user_project_assignments`, `tenant_keys`, `audit_logs`
(partitioned, append-only), `_migrations`

**Sales & CRM**
`leads`, `lead_activities`, `customers`, `call_logs`, `campaigns`, `templates`,
`chatbot_configs`, `quotations`, `service_tickets`, `service_requests`

**Inventory & pricing**
`projects`, `towers`, `units`, `documents`, `schema_definitions`, `meta_config`

**Bookings & collections**
`bookings`, `payment_schedules`, `payments`, `commission_ledger`, `brokers`,
`portal_users`

**Finance & accounting**
`chart_of_accounts`, `journal_entries`, `journal_entry_lines`, `tax_postings`,
`bank_accounts`, `bank_transactions`, `loans`, `loan_repayment_schedule`,
`vendors`, `vendor_bills`, `vendor_bill_line_items`, `contractor_ra_bills`,
`payments_made`, `cost_centers`, `budgets`, `budget_revisions`,
`approval_workflows`

**HR**
`employees`, `attendance`, `leave_requests`, `payroll_runs`

**Procurement & stores**
`materials`, `purchase_orders`, `stock_txns`, `machines`

**Site execution**
`site_tasks`, `progress_updates`, `rfis`, `change_orders`, `inspections`

**Land & business development**
`land_leads`, `feasibility_records`, `land_documents`, `bd_leads`,
`market_reports`, `compliance_items`

**WhatsApp**
`whatsapp_instances`, `whatsapp_user_sessions`, `whatsapp_outbox`

**Data movement**
`import_batches`, `import_rows_staging`, `export_jobs`

### Business rules enforced in the database, not the application

- **No double-booking.** `bookings_one_live_per_unit` — a partial unique index on
  `unit_id WHERE status IN ('active','completed')`. Two concurrent bookings for
  one unit: the second gets `23505`, which the route maps to a 400.
- **Journal entries must balance.** Triggers `je_balanced_entries` and
  `je_balanced_lines` reject unbalanced postings.
- **Posted ledger lines are immutable.** `je_lines_immutable` and `je_no_unpost`
  make posted accounting history append-only.
- **Audit trail cannot be bypassed.** `audit_row_change()` triggers on every
  sensitive table write into an append-only, tenant-scoped `audit_logs`.

---

## 5. Security model

**Authentication.** argon2id hashing. JWT signed HS256 with the algorithm pinned
at verification (`algorithms: ['HS256']`) and issuer checked — never let the
token choose how it is verified. 24-hour expiry. `JWT_SECRET` is validated at
boot: minimum 32 characters, and any value matching `/change[_-]?me/i` throws, so
a copy-pasted example config cannot start the server.

**Authorization.** 37+ granular permission keys (`view_leads`, `manage_finance`,
`approve_bookings`, `manage_own_leads`, …) attached to roles per tenant. Route
handlers gate with one of four idioms — all resolve to `has_permission()`:
- `has_permission('key')` inline
- a local `gate(db, 'key')` helper
- `requirePlatformStaff(req, reply)` for platform-only routes
- `leadAccess(db)` returning `{ canWrite, canAssign, ownOnly }` for lead scoping

**Row scoping beyond tenant.** `manage_own_leads` restricts a rep to leads
assigned to them. Misses return **404, not 403**, so the endpoint never confirms
the existence of a record the caller may not see.

**Transport.** Helmet security headers, CORS allow-list from `CORS_ORIGIN`
(comma-separated), rate limiting (120/min global, tighter on auth), and an error
handler that logs internals against a correlation ID and returns only
`{ error: 'Internal server error', correlationId }` — never DB text.

---

## 6. API conventions

- Base path `/api`. JSON in, JSON out.
- Every route declares a Fastify JSON schema with `additionalProperties: false`.
  This is what makes dynamic `UPDATE` construction safe — column names come from
  a fixed allow-list, values are always parameterised.
- UUID params validated by pattern before reaching SQL.
- Responses are wrapped by entity name: `{ lead: {...} }`, `{ leads: [...] }`.
- Client-facing fields are camelCase; database columns are snake_case. Each route
  file owns its `toApiX()` mapper.
- Status codes: 201 on create, 400 on validation/constraint violation, 401
  unauthenticated, 403 missing permission, 404 not found *or* not visible, 409
  on uniqueness conflict, 429 rate-limited.

---

## 7. Client architecture

**Dual mode.** The SPA runs against either the real API or a browser-only demo:

```ts
isApiEnabled()  // true when VITE_API_URL was set at build time
                // (empty string = same origin, the production value)
isDemoMode()    // the localStorage-only single-browser demo
```

Every write goes through a dispatcher in `src/services/*Writes.ts`:

```ts
export async function createBooking(input) {
  if (isApiEnabled()) return apiCreateBooking(input);
  return create('bookings', input);   // localStorage fallback
}
```

**Build the production bundle in API mode or you ship the demo:**
```bash
VITE_API_URL=/ npm run build
```
On Windows, Git Bash mangles a bare `/` argument — put `VITE_API_URL=/` in
`.env.local` instead and run `npm run build`.

**Pages (30):** Dashboard, Leads, Inventory, Projects, Bookings, Billing,
Accounts, Brokers, Campaigns, AIStudio, Calendar, Documents, Reports,
SalesPerformance, Service, HR, Procurement, Execution, Land, BD, Messages
(WhatsApp), Settings, SuperAdmin, Login, AccessDenied, Microsite,
ChatbotPortal, ChatbotWidget, PortalLogin, PortalDashboard.

---

## 8. Integrations

**WhatsApp — per-user sessions via self-hosted Evolution API v2.3.7.**
Each sales rep links their *own* number by scanning a QR inside the ERP; there
is no shared business number and no Meta Cloud API dependency. Messages send
from the rep's own WhatsApp.
- `whatsapp_user_sessions` holds per-user instance state.
- Chat privacy defaults to `private`: a rep sees only conversations their own
  session carried. `chat_visibility = 'team'` opens it up. One `chatScope()`
  helper gates every read, export and delete.
- Inbound webhooks land in `lead_activities`, so the chat *is* the lead timeline.
- **Auto-reply runs through a durable outbox** (`whatsapp_outbox`), never inline:
  randomised `send_after` (default 20–60s), quiet hours, per-sender daily cap,
  and `UNIQUE (tenant_id, lead_id, trigger)` so a re-imported lead is never
  greeted twice. A background worker drains it every 30s.
- Risk model: replying to an inbound message is low risk; greeting a *new lead*
  is an outbound first contact to someone who never messaged you — that is the
  pattern that gets numbers blocked, so it ships disabled.

**Chatbot.** Embeddable widget capturing and qualifying leads on the builder's
own website, configured per tenant, served from a public unauthenticated route.

**Customer & broker portal.** Separate auth realm. Customers see their bookings,
payment schedule and tickets; brokers submit leads and track commissions.

---

## 9. Deployment

Docker Compose on a single VPS: nginx (serves the SPA, proxies `/api`), the API
container, Postgres, a one-shot `migrate` container holding the superuser
credential (so the long-running API never sees it), a `seed` bootstrap, and a
daily encrypted `pg_dump` with 14-day retention. HTTPS via certbot —
**required**, because the WhatsApp QR scan needs camera access and browsers only
grant that on a secure origin. WhatsApp is an optional overlay compose file, so
the base stack works without it.

---

## 10. Known gaps — current state, be honest about these

1. **CRITICAL — the booking cascade leaks into `localStorage`.** In API mode a
   booking sends the booking, unit lock and lead stage to the server, then writes
   the token invoice, broker commission and lead activity via `create()` from
   `services/db` — a localStorage write. Finance never sees the invoice. 65
   unguarded write sites across 19 tables remain.
2. **CRITICAL — the booking cascade has no transaction.** Three sequential HTTP
   calls with no compensation; a failure mid-way leaves a live booking against a
   unit still marked `available`.
3. **HIGH — permission keys are never migrated into existing tenants.** New keys
   (`view_hr`, `manage_hr`, `view_procurement`, `view_execution`, `view_land`,
   `manage_attendance`) are granted only by `seed.ts` at tenant creation; no
   migration backfills them. A tenant provisioned before those modules shipped
   gets a permanent 403 on all of them — including its super_admin, because
   `has_permission()` has no super-admin bypass.
4. **HIGH — no `statement_timeout` and one shared 10-connection pool.** One
   tenant's slow report can starve every other tenant.
5. **HIGH — 20 tenant tables lack an index leading on `tenant_id`.**
6. **MEDIUM — no token revocation.** 24h JWT, no `jti`, no deny-list.
7. **MEDIUM — `requireAuth` accepts portal tokens.** Safe today only because
   every staff route also checks a permission.
8. **MEDIUM — `app_user` holds write privileges on `_migrations`.**

---

## 11. Coding conventions

- **Comments explain *why*, never *what*.** If a line looks wrong but is right,
  the comment says what broke without it. No comment restates the code.
- Raw parameterised SQL. No ORM, no query builder.
- Every module cutover follows the same order: migration → route (RLS + RBAC +
  schema) → `apiClient` function → `*Writes` dispatcher → wire the page →
  verify (HTTP end-to-end *and* a demo-mode browser pass) → `npx vite build`.
- Verification scripts live in `server/scripts/verify-*.mjs`. Six suites,
  196 assertions: rls 9, writes 15, portal 35, accounts 28, landbd 28,
  whatsapp 82. They run against a real Postgres, not mocks.
- Demo mode must stay byte-identical after any API-mode change.
