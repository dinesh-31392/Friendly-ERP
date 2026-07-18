# Friendly CRM — Backend Architecture Specification (v1)

**Stack decision:** Node.js 22 + TypeScript + Fastify + `node-postgres` (pg) + PostgreSQL 15+.
Chosen because the existing frontend is React 19/TypeScript and every data access
already flows through `src/services/db.ts` — that module becomes the typed API
client with the same function signatures (`getByTenant`, `create`, `update`,
`remove`, `query`), so the UI needs no structural rewrite. Auth swaps inside
`src/services/authService.ts` from localStorage sessions to JWT.

Companion file: [`schema.sql`](./schema.sql) — runnable DDL with RLS, RBAC,
audit triggers, metadata tables, staging import, export jobs, and indexes.

---

## 1. Tenant-context middleware (the security core)

Every request runs inside a transaction that carries three session variables —
`app.current_tenant_id`, `app.current_user_id`, `app.request_ip` — set with
`set_config(..., true)` (transaction-scoped, so pooled connections can never
leak one tenant's context to the next request). RLS policies read these; if
they are unset, `app_current_tenant()` returns NULL and **every policy fails
closed to zero rows**.

```ts
// src/middleware/tenantContext.ts
import type { FastifyRequest } from 'fastify';
import { Pool, PoolClient } from 'pg';

export interface RequestCtx {
  tenantId: string;   // from the verified JWT — NEVER from a header/body/query
  userId: string;
  ip: string;
}

/** Runs `fn` inside a transaction with the tenant context applied.
 *  This is the ONLY way handlers are allowed to touch the database. */
export async function withTenantContext<T>(
  pool: Pool,
  ctx: RequestCtx,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // set_config(..., true) = transaction-local: evaporates at COMMIT/ROLLBACK,
    // immune to connection-pool reuse.
    await client.query(
      `SELECT set_config('app.current_tenant_id', $1, true),
              set_config('app.current_user_id',  $2, true),
              set_config('app.request_ip',       $3, true)`,
      [ctx.tenantId, ctx.userId, ctx.ip],
    );
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Fastify preHandler: verify JWT → attach ctx. Tenant resolution order:
//  1. JWT claim (authoritative — signed at login)
//  2. Subdomain (<slug>.friendlycrm.app) is used ONLY to brand the login page
//     and scope the login query — never to authorize an existing session.
export async function authPreHandler(req: FastifyRequest) {
  const token = (req.headers.authorization || '').replace(/^Bearer /, '');
  const claims = await verifyJwt(token);            // throws 401 on failure
  req.ctx = { tenantId: claims.tid, userId: claims.sub, ip: req.ip };
}
```

**Defense-in-depth guarantee:** even if a handler forgets a `WHERE tenant_id=`
clause entirely, RLS silently restricts every statement to the JWT's tenant.
The app role (`app_user`) has `NOBYPASSRLS`; only `app_platform` (backups,
super-admin service, separate credentials + network policy) can cross tenants.

## 2. Metadata-driven forms & pipelines (zero hardcoding)

The frontend already renders stages from a `LEAD_STAGES` array and forms from
JSX; step one of the migration replaces those constants with definitions
fetched per tenant:

```ts
// GET /api/meta/:entity  → { form, pipeline, listView } for the caller's tenant
app.get('/api/meta/:entity', { preHandler: authPreHandler }, (req) =>
  withTenantContext(pool, req.ctx, async (db) => {
    const { rows } = await db.query(
      `SELECT kind, definition
         FROM schema_definitions
        WHERE entity = $1 AND is_active
        ORDER BY version DESC`,
      [req.params.entity],           // tenant scoping happens via RLS
    );
    return Object.fromEntries(rows.map(r => [r.kind, r.definition]));
  }),
);
```

- **Renaming/adding a pipeline stage** = insert a new `schema_definitions`
  version and flip `is_active` — no deploy. The DB trigger
  (`validate_lead_stage`) rejects writes using stages that aren't in the
  active pipeline, so app and DB can never disagree.
- **Custom fields** live in `leads.custom_fields` (JSONB, GIN-indexed); the
  form definition declares them (`"key": "custom.facing"`), the renderer walks
  the definition, and the validation worker enforces `type/required/min/max`
  from the same JSON — one source of truth for UI and API validation.
- Definitions are cached in the API with an ETag keyed on
  `(tenant_id, entity, max(version))`; the SPA revalidates on navigation.

## 3. Tenant-partitioned backup job

Per-tenant logical backups (portable, restorable into a fresh tenant), written
to encrypted immutable object storage (S3 Object Lock / GCS retention policy —
WORM, so ransomware or a bad actor cannot rewrite history).

```ts
// worker/backup.ts — runs under app_platform (BYPASSRLS) on a schedule:
//   daily  : incremental (rows where updated_at >= last run)
//   monthly: full
//   yearly : full, retained under a longer Object Lock period
import { to as copyTo } from 'pg-copy-streams';

const TABLES = ['tenants','users','roles','role_permissions','leads',
                'schema_definitions','meta_config' /* …all business tables */];

export async function backupTenant(
  db: PoolClient, s3: S3Client,
  tenantId: string, mode: 'incremental' | 'full', since?: Date,
) {
  const stamp = new Date().toISOString().slice(0, 10);
  const manifest: Record<string, { rows: number; sha256: string }> = {};

  for (const table of TABLES) {
    // STRICT partitioning: every statement filters by tenant_id explicitly —
    // belt (WHERE) and braces (this worker exports one tenant per job run).
    const where = table === 'tenants' ? 'id = $1' : 'tenant_id = $1';
    const incr  = mode === 'incremental' && since ? `AND updated_at >= $2` : '';
    const sql   = format(
      'COPY (SELECT * FROM %I WHERE %s %s) TO STDOUT WITH (FORMAT csv, HEADER)',
      table, where, incr,
    );
    const stream = db.query(copyTo(sql, mode === 'incremental' ? [tenantId, since] : [tenantId]));
    const key = `backups/${tenantId}/${mode}/${stamp}/${table}.csv.gz`;
    manifest[table] = await uploadEncrypted(s3, key, stream.pipe(gzip()), {
      ServerSideEncryption: 'aws:kms',
      ObjectLockMode: 'COMPLIANCE',                    // immutable
      ObjectLockRetainUntilDate: retentionFor(mode),   // 35d / 13mo / 7y
    });
  }
  await uploadEncrypted(s3, `backups/${tenantId}/${mode}/${stamp}/MANIFEST.json`,
    JSON.stringify({ tenantId, mode, stamp, since, tables: manifest }));
}
```

Restore = replay MANIFEST → `COPY FROM` into a staging schema → verified
promote. In addition to logical backups, run standard `pgBackRest` physical
backups + WAL archiving for whole-cluster disaster recovery (RPO ≈ minutes).

## 4. Staging-to-production import pipeline

1. **Upload** → file lands in object storage; an `import_batches` row is created.
2. **Validate worker** parses the CSV, checks headers against the tenant's
   *form definition* (not hardcoded columns), coerces types, flags per-row
   errors into `import_rows_staging.errors`, and marks duplicates by
   `(tenant_id, phone_normalized)` / email — against production *and* within
   the batch.
3. **Preview** — the UI shows valid/dupe/error counts from staging (the CSV
   import UI already built in the SPA maps 1:1 to this).
4. **Promote** — a single transaction inserts valid rows into `leads`,
   stamps the batch `done`. Audit triggers record every inserted row
   automatically. Staging rows are purged after 7 days.

## 5. Async export jobs

`POST /api/exports {entity, format, date_from, date_to}` inserts an
`export_jobs` row (RLS-scoped). A worker claims jobs with
`FOR UPDATE SKIP LOCKED`, streams `COPY (SELECT … WHERE tenant_id = $1 AND
created_at BETWEEN …)` to gzip → object storage, writes a **signed, expiring
URL** into `result_url`, and notifies the requester. Nothing is generated
synchronously in a request thread; big tenants can't stall the API.

## 6. Index strategy (summary — full DDL in schema.sql)

| Rule | Why |
|---|---|
| `tenant_id` is the **leading column** of every composite index | RLS adds `tenant_id = current` to every plan; the index prunes to one tenant's slice immediately |
| Composite with the hot filter second: `(tenant_id, stage)`, `(tenant_id, assigned_to, stage)`, `(tenant_id, created_at DESC)` | Pipeline board, "my leads", recency lists become single index-range scans |
| **Partial** index for the at-risk scan: `(tenant_id, last_contact_at) WHERE stage NOT IN ('booked','lost')` | The 24h-silent query never touches closed leads |
| `GIN (custom_fields jsonb_path_ops)` | Filtering on metadata-driven custom fields stays indexed |
| `BRIN (created_at)` on `audit_logs` + monthly **range partitions** | Append-only log stays fast and cheap to retain/expire |
| No global unique constraints on business data — always `UNIQUE (tenant_id, …)` | Two tenants can both have `admin@x.com`; isolation includes constraints |

Housekeeping: `pg_partman` for audit partitions; autovacuum tuned down
(scale_factor 0.05) on `leads`; `pg_stat_statements` on from day one.

## 7. Migration path from the current build

| Today (localStorage SPA) | Production target |
|---|---|
| `services/db.ts` table helpers | Same signatures → typed `fetch` client hitting `/api/*` |
| `authService.ts` plaintext sessions | JWT (argon2id hashes; tenant claim signed at login) |
| `authService.hasPermission` string map | Seeds `permissions` + `role_permissions` tables verbatim |
| `LEAD_STAGES` / form JSX constants | First `schema_definitions` rows per tenant (same shape) |
| `integrationService.ingestLead` (dedup → score → route → welcome) | Queue consumers (BullMQ/Redis): worker-1 dedup, worker-2 score, worker-3 route — same function bodies |
| `friendly_crm_webhook_secret` simulated endpoint | Real `POST /webhooks/leads/:tenantId` with HMAC signature check |
| Portal (`friendly_crm_portal_auth`) | Separate JWT audience (`aud: portal`) — same isolation idea, real tokens |
| Trial/plan enforcement in UI | Re-enforced server-side in middleware (`plan_limits` check on create) |
| SuperAdmin panel | Served by the `app_platform` service, never through `app_user` |

**Order of execution:** schema + RLS → auth → leads/read APIs behind a feature
flag in the SPA → writes → ingestion queue → portals → backups/exports → cut
localStorage over to "offline cache" only.
