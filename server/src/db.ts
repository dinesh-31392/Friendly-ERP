import { isIP } from 'node:net';
import pg from 'pg';
import { env } from './env.js';

const { Pool } = pg;

/**
 * Timeouts are the noisy-neighbour defence.
 *
 * Every tenant shares this pool, so an unbounded query is not one tenant's
 * problem — it is a connection nobody else can have. Ten of them and the API is
 * down for everybody, with no error anywhere, because the requests are not
 * failing, they are waiting.
 *
 *   statement_timeout       a query that runs longer than this is killed. Set
 *                           per-connection via the pool's `options`, so it
 *                           applies to every statement without touching a
 *                           single call site.
 *   connectionTimeoutMillis a request that cannot get a connection fails fast
 *                           instead of hanging until the client gives up.
 *   idleTimeoutMillis       release idle connections so a burst does not hold
 *                           the pool open forever afterwards.
 *
 * Tune with env vars rather than a redeploy: a reporting-heavy tenant may need
 * a longer ceiling than the interactive default.
 */
const STATEMENT_TIMEOUT_MS = Number(process.env.DB_STATEMENT_TIMEOUT_MS ?? 10_000);
const POOL_MAX = Number(process.env.DB_POOL_MAX ?? 20);

/** RLS-enforced pool — the ONLY pool request handlers may use. */
export const pool = new Pool({
  connectionString: env.databaseUrl,
  max: POOL_MAX,
  connectionTimeoutMillis: 5_000,
  idleTimeoutMillis: 30_000,
  options: `-c statement_timeout=${STATEMENT_TIMEOUT_MS}`,
});

/** BYPASSRLS pool — used exclusively for the login credential lookup
 *  (identity isn't known yet, so no tenant context exists) and platform jobs.
 *  NEVER hand this to a tenant-scoped request handler.
 *
 *  Deliberately gets a LONGER statement timeout: the outbox worker sweeps every
 *  tenant with due rows, which is legitimately slower than any single request,
 *  and killing it mid-sweep would strand queued messages. */
export const platformPool = new Pool({
  connectionString: env.databasePlatformUrl,
  max: 4,
  connectionTimeoutMillis: 5_000,
  idleTimeoutMillis: 30_000,
  options: `-c statement_timeout=${Number(process.env.DB_PLATFORM_STATEMENT_TIMEOUT_MS ?? 60_000)}`,
});

// pg-pool emits 'error' when an IDLE connection dies (Postgres restart, VPS
// reboot, OOM-kill, `docker compose restart db`, or a NAT/firewall reaping an
// idle TCP session). Pool extends EventEmitter, so an 'error' emit with NO
// listener is an uncaught exception that kills the process — with zero traffic,
// and then loops forever under `restart: unless-stopped`. These listeners are
// what make a Postgres restart survivable: pg discards the dead client and the
// next checkout reconnects.
pool.on('error', err => console.error('[db] idle client error (RLS pool):', err.message));
platformPool.on('error', err => console.error('[db] idle client error (platform pool):', err.message));

export interface RequestCtx {
  tenantId: string;
  userId: string;
  ip: string;
  /** Token id, for single-session revocation. Absent on pre-037 tokens. */
  jti?: string;
  /** JWT `iat`, whole seconds, compared against users.sessions_valid_from. */
  issuedAt?: number;
  /**
   * Which authentication realm this subject belongs to.
   *
   * Each realm keeps its subjects in a different table — staff in `users`,
   * portal customers and brokers in `portal_users` — so the realm decides which
   * revocation function is asked. Getting this wrong is not subtle: before this
   * field existed, portal ids were looked up in `users`, found nothing, and
   * every portal request started returning 401.
   *
   * Set in requireAuth for staff and requirePortalAuth for portal. Omitted only
   * by the WhatsApp outbox worker, which runs with no subject at all and is
   * therefore not checked.
   */
  realm?: 'staff' | 'portal';
}

/**
 * Thrown when the token is well-formed and correctly signed but the session
 * behind it has been ended — signed out, signed out everywhere, password
 * changed, or the account deactivated.
 *
 * A distinct type because the caller must answer 401, not 500. Signature
 * failures are already 401; this is the same answer for a different reason,
 * and the client's handling is identical: discard the token and sign in again.
 */
export class RevokedSessionError extends Error {
  constructor() {
    super('Session is no longer valid');
    this.name = 'RevokedSessionError';
  }
}

/**
 * Run `fn` inside a transaction carrying the tenant context. The three
 * settings are transaction-local (`set_config(..., true)`), so pooled
 * connections can never leak one tenant's context into the next request.
 * RLS policies read these; if unset, every policy fails closed to zero rows.
 */
export async function withTenantContext<T>(
  ctx: RequestCtx,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // The audit trigger casts app.request_ip to inet — a malformed
    // X-Forwarded-For must degrade to '' (NULL in the audit row), never
    // abort the caller's transaction.
    // The old check was a character class (/^[0-9a-fA-F:.]+$/), which happily
    // passed '999.999.999.999', '1.2.3.4.5', '...' and '::::' — none of which
    // are valid inet. The first write route would then have thrown 22P02 inside
    // the transaction and 500'd every write. net.isIP is the real validator.
    const safeIp = isIP(ctx.ip) !== 0 ? ctx.ip : '';
    // The revocation check rides along with the settings rather than costing a
    // second round-trip, and token_is_live takes its subject as arguments
    // precisely so it does not depend on the set_config calls beside it — the
    // evaluation order of a SELECT list is not guaranteed, and a version that
    // read app_current_user() could run before the settings landed.
    // Each realm looks its subject up in its own table — a staff id is a row in
    // `users`, a portal id in `portal_users` — so the realm picks the function.
    // Anything with no realm (the WhatsApp outbox worker, which runs with no
    // subject at all) is not checked; its uuid arguments are inside the branches
    // and therefore never evaluated, which matters because that worker passes an
    // empty userId and ''::uuid is a cast error.
    const { rows: [gate] } = await client.query(
      `SELECT set_config('app.current_tenant_id', $1, true),
              set_config('app.current_user_id',  $2, true),
              set_config('app.request_ip',       $3, true),
              CASE $6
                WHEN 'staff'  THEN token_is_live($1::uuid, $2::uuid, $4::uuid, $5::bigint)
                WHEN 'portal' THEN portal_token_is_live($1::uuid, $2::uuid, $4::uuid, $5::bigint)
                ELSE true
              END AS live`,
      [ctx.tenantId, ctx.userId, safeIp, ctx.jti ?? null, ctx.issuedAt ?? 0, ctx.realm ?? ''],
    );
    if (ctx.realm && gate?.live === false) throw new RevokedSessionError();
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Is the current user still active? Call this inside a withTenantContext body
 * (app_current_user() is set there). Deactivation should take effect at once,
 * but a JWT stays valid for its full 24h life, and routes that don't call
 * has_permission() (which already ANDs `active`) would otherwise keep serving a
 * just-offboarded user. Use it on those routes as a cheap revocation check.
 */
export async function isActiveUser(db: pg.PoolClient): Promise<boolean> {
  const { rows: [u] } = await db.query(
    `SELECT active FROM users WHERE id = app_current_user()`,
  );
  return !!u?.active;
}
