import type { PoolClient } from 'pg';
import { env } from './env.js';

/**
 * Each builder's own credentials for their own third-party accounts.
 *
 * WHY THIS EXISTS
 *
 * `razorpay.ts` says credentials live in the environment, and gives a good
 * reason: the key secret signs money movement, so a workspace admin should not
 * be able to read it out of a settings page and a database dump should not
 * contain it.
 *
 * But one set of environment credentials means ONE Razorpay account for the
 * whole platform — every builder's buyers paying into the operator's merchant
 * account. That is not a multi-tenant product; it makes the operator a money
 * handler for their customers, which in India is payment-aggregator territory
 * the operator has almost certainly not licensed for.
 *
 * `tenant_keys` (migration 001) was built for exactly this and never wired to
 * anything. It resolves the tension rather than ignoring it:
 *
 *   ENCRYPTED AT REST   pgp_sym_encrypt with a key held only in the API's
 *                       environment. A stolen dump, backup or replica decrypts
 *                       to nothing — which is the "not in the database"
 *                       property, kept.
 *   WRITE-ONLY          nothing here returns a stored secret. An admin may
 *                       replace a key and may see THAT one is set; no route
 *                       reads one back — which is the "not out of a settings
 *                       page" property, kept.
 *
 * THE KEY IS A BIND PARAMETER, NOT A SESSION SETTING
 *
 * 001 sketched `current_setting('app.kms_key')`. That would put the master key
 * in session state for the life of the connection, where any other statement
 * on that pooled connection — including one built by a future bug — could read
 * it straight back out with a plain SELECT. Passing it per statement keeps it
 * out of the session entirely.
 *
 * RLS DOES THE SCOPING
 *
 * tenant_keys has FORCE RLS on tenant_id, so every call here is already
 * confined to the caller's workspace by the database. Nothing in this file
 * takes a tenant id, which is the point: there is no parameter to get wrong.
 */

/** Thrown when the deployment has no KMS_KEY, so nothing can be stored. */
export class NoKmsKeyError extends Error {
  constructor() {
    super('This deployment cannot store per-workspace credentials: KMS_KEY is not set.');
    this.name = 'NoKmsKeyError';
  }
}

export const kmsConfigured = (): boolean => !!env.kmsKey;

/**
 * Store one credential, replacing any previous value.
 *
 * An empty string DELETES the row rather than storing an empty secret — the
 * two are different states and "" would otherwise read back as "configured",
 * which is the shape that makes an integration fail at the moment of use
 * instead of at the moment of configuration.
 */
export async function putTenantKey(
  db: PoolClient, service: string, keyName: string, value: string, userId?: string | null,
): Promise<void> {
  if (!env.kmsKey) throw new NoKmsKeyError();
  const v = value.trim();
  if (!v) {
    await db.query(
      'DELETE FROM tenant_keys WHERE service = $1 AND key_name = $2', [service, keyName]);
    return;
  }
  await db.query(
    `INSERT INTO tenant_keys (tenant_id, service, key_name, value_enc, updated_by, updated_at)
     VALUES (app_current_tenant(), $1, $2, pgp_sym_encrypt($3, $4), $5, now())
     ON CONFLICT (tenant_id, service, key_name) DO UPDATE
       SET value_enc = EXCLUDED.value_enc,
           updated_by = EXCLUDED.updated_by,
           updated_at = now()`,
    [service, keyName, v, env.kmsKey, userId ?? null]);
}

/**
 * Read every credential for one service, decrypted.
 *
 * SERVER-SIDE ONLY. Nothing that reaches a client may call this — the whole
 * design rests on a stored secret never travelling back out. Callers are the
 * gateway config resolver and nothing else.
 *
 * A row that fails to decrypt is SKIPPED rather than thrown: that is what a
 * rotated KMS_KEY looks like, and one stranded credential must not take down
 * every request that touches the table. The caller sees the service as
 * unconfigured, which is true and recoverable — the admin re-enters it.
 */
export async function getTenantKeys(
  db: PoolClient, service: string,
): Promise<Record<string, string>> {
  if (!env.kmsKey) return {};
  const { rows } = await db.query(
    `SELECT key_name,
            CASE WHEN pgp_sym_decrypt(value_enc, $2) IS NULL THEN NULL
                 ELSE pgp_sym_decrypt(value_enc, $2) END AS value
       FROM tenant_keys WHERE service = $1`,
    [service, env.kmsKey],
  ).catch(() => ({ rows: [] as Array<Record<string, unknown>> }));

  const out: Record<string, string> = {};
  for (const r of rows) {
    const v = r.value as string | null;
    if (v) out[r.key_name as string] = v;
  }
  return out;
}

/**
 * Which credentials exist, WITHOUT decrypting or returning any of them.
 *
 * This is what a settings screen is allowed to know. It answers "is the
 * gateway connected" — the only question the UI actually needs — and cannot
 * be made to answer anything more by changing a parameter.
 */
export async function tenantKeyNames(db: PoolClient, service: string): Promise<string[]> {
  const { rows } = await db.query(
    'SELECT key_name FROM tenant_keys WHERE service = $1 ORDER BY key_name', [service]);
  return rows.map(r => r.key_name as string);
}

/** Disconnect a service entirely. */
export async function clearTenantKeys(db: PoolClient, service: string): Promise<number> {
  const { rowCount } = await db.query('DELETE FROM tenant_keys WHERE service = $1', [service]);
  return rowCount ?? 0;
}
