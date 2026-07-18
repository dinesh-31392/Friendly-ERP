import { isIP } from 'node:net';
import pg from 'pg';
import { env } from './env.js';

const { Pool } = pg;

/** RLS-enforced pool — the ONLY pool request handlers may use. */
export const pool = new Pool({ connectionString: env.databaseUrl, max: 10 });

/** BYPASSRLS pool — used exclusively for the login credential lookup
 *  (identity isn't known yet, so no tenant context exists) and platform jobs.
 *  NEVER hand this to a tenant-scoped request handler. */
export const platformPool = new Pool({ connectionString: env.databasePlatformUrl, max: 2 });

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
    await client.query(
      `SELECT set_config('app.current_tenant_id', $1, true),
              set_config('app.current_user_id',  $2, true),
              set_config('app.request_ip',       $3, true)`,
      [ctx.tenantId, ctx.userId, safeIp],
    );
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
