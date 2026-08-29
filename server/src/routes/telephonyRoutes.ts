import type { FastifyInstance } from 'fastify';
import { withTenantContext, platformPool } from '../db.js';
import { requireAuth } from '../auth.js';
import {
  telephonyConfig, placeCall, mintCallbackSecret, secretMatches,
  mapExotelStatus, readCallEvent, dialable,
} from '../telephony.js';

/**
 * Click-to-call (migration 057).
 *
 * The last integration on the readiness review. `call_logs` was described as
 * "already there waiting for a provider", and it was — but only for a call
 * somebody had already made and typed in afterwards.
 *
 * The rep's number never reaches the customer. That is the whole reason to run
 * calls through a provider rather than a `tel:` link, and it is why the connect
 * call dials the agent first.
 */

const UUID = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

async function gate(db: import('pg').PoolClient, perm: string): Promise<boolean> {
  const { rows: [{ allowed }] } = await db.query(`SELECT has_permission($1) AS allowed`, [perm]);
  return !!allowed;
}

const toApiSettings = (r: Record<string, unknown> | undefined) => ({
  provider: r?.provider ?? 'exotel',
  accountSid: r?.account_sid ?? '',
  callerId: r?.caller_id ?? '',
  recordCalls: !!r?.record_calls,
  active: !!r?.active,
  // Whether a callback secret exists — never the secret, and never the digest.
  callbackConfigured: !!(r?.callback_secret_hash as string),
  updatedAt: r?.updated_at ?? null,
});

export async function telephonyRoutes(app: FastifyInstance): Promise<void> {
  /** GET /api/telephony/settings — never returns a credential. */
  app.get('/api/telephony/settings', { preHandler: requireAuth }, async (req, reply) =>
    withTenantContext(req.ctx, async (db) => {
      if (!await gate(db, 'view_leads')) {
        return reply.code(403).send({ error: 'Missing permission: view_leads' });
      }
      const { rows: [s] } = await db.query(
        'SELECT * FROM telephony_settings WHERE tenant_id = app_current_tenant()');
      return {
        settings: toApiSettings(s),
        // The API key and token are deployment-level and live in the
        // environment; this only says whether they are present.
        credentialsConfigured: !!telephonyConfig(s ?? null),
      };
    }),
  );

  /**
   * PUT /api/telephony/settings — the account, the number, and a new secret.
   *
   * The callback secret is returned exactly once. Only its digest is stored,
   * because a callback URL carrying a secret ends up in provider dashboards,
   * access logs and browser history, and one that could also be read out of the
   * database is a secret in four places instead of one.
   */
  app.put<{ Body: { accountSid: string; callerId: string; recordCalls?: boolean; active?: boolean; rotateSecret?: boolean } }>(
    '/api/telephony/settings',
    {
      preHandler: requireAuth,
      schema: {
        body: {
          type: 'object', required: ['accountSid', 'callerId'], additionalProperties: false,
          properties: {
            accountSid: { type: 'string', maxLength: 80 },
            callerId: { type: 'string', maxLength: 24 },
            recordCalls: { type: 'boolean' },
            active: { type: 'boolean' },
            rotateSecret: { type: 'boolean' },
          },
        },
      },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'manage_settings')) {
          return reply.code(403).send({ error: 'Missing permission: manage_settings' });
        }
        const caller = dialable(req.body.callerId);
        if (!caller) {
          return reply.code(400).send({ error: 'That caller id is not a dialable number.' });
        }

        const { rows: [existing] } = await db.query(
          'SELECT callback_secret_hash FROM telephony_settings WHERE tenant_id = app_current_tenant()');
        const needsSecret = req.body.rotateSecret || !existing?.callback_secret_hash;
        const minted = needsSecret ? mintCallbackSecret() : null;

        const { rows: [saved] } = await db.query(
          `INSERT INTO telephony_settings
             (tenant_id, account_sid, caller_id, record_calls, active, callback_secret_hash, updated_by)
           VALUES (app_current_tenant(), $1, $2, COALESCE($3,false), COALESCE($4,false), $5, $6)
           ON CONFLICT (tenant_id) DO UPDATE
             SET account_sid = EXCLUDED.account_sid,
                 caller_id   = EXCLUDED.caller_id,
                 record_calls = EXCLUDED.record_calls,
                 active      = EXCLUDED.active,
                 callback_secret_hash = COALESCE(NULLIF(EXCLUDED.callback_secret_hash,''),
                                                 telephony_settings.callback_secret_hash),
                 updated_by  = EXCLUDED.updated_by,
                 updated_at  = now()
           RETURNING *`,
          [req.body.accountSid, caller, req.body.recordCalls ?? null, req.body.active ?? null,
           minted?.hash ?? '', req.ctx.userId]);

        return {
          settings: toApiSettings(saved),
          ...(minted ? {
            callbackSecret: minted.token,
            callbackUrl: `/api/webhooks/telephony?secret=${encodeURIComponent(minted.token)}`,
            note: 'Copy the callback URL now — the secret is stored only as a digest and cannot be shown again.',
          } : {}),
          ...(req.body.recordCalls ? {
            recordingNotice: 'Recording is on. The caller must be told the call is being recorded — '
              + 'configure the announcement on the ExoPhone, not only here.',
          } : {}),
        };
      }),
  );

  /**
   * POST /api/leads/:id/call — place one.
   *
   * The customer's number comes from the LEAD, never from the request body. A
   * client that could name the number to dial could use the builder's telephony
   * account to ring anybody, billed to the builder.
   */
  app.post<{ Params: { id: string } }>(
    '/api/leads/:id/call',
    {
      preHandler: requireAuth,
      schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: UUID } } } },
    },
    async (req, reply) => {
      const ctx = await withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'view_leads')) return { forbidden: true } as const;
        const { rows: [lead] } = await db.query(
          'SELECT id, name, phone FROM leads WHERE id = $1', [req.params.id]);
        if (!lead) return null;
        const { rows: [agent] } = await db.query(
          'SELECT phone, name FROM users WHERE id = $1', [req.ctx.userId]);
        const { rows: [settings] } = await db.query(
          'SELECT * FROM telephony_settings WHERE tenant_id = app_current_tenant() AND active');
        return { lead, agent, settings };
      });

      if (ctx && 'forbidden' in ctx) {
        return reply.code(403).send({ error: 'Missing permission: view_leads' });
      }
      if (!ctx) return reply.code(404).send({ error: 'Lead not found' });

      const cfg = telephonyConfig(ctx.settings ?? null);
      if (!cfg) {
        return reply.code(503).send({
          error: 'Click-to-call is not configured. Set EXOTEL_API_KEY and EXOTEL_API_TOKEN, '
               + 'and add the account and caller id in telephony settings.',
        });
      }
      if (!dialable(ctx.agent?.phone ?? '')) {
        // The agent leg is dialled first. Without a number for them the call
        // cannot be placed at all, and the customer must not be rung instead.
        return reply.code(409).send({ error: 'Add your own phone number to your profile before placing a call.' });
      }
      if (!dialable(ctx.lead.phone ?? '')) {
        return reply.code(409).send({ error: 'That lead has no number that can be dialled.' });
      }

      const base = (process.env.PUBLIC_BASE_URL ?? '').replace(/\/$/, '');
      let placed;
      try {
        placed = await placeCall(cfg, {
          agentNumber: ctx.agent.phone,
          customerNumber: ctx.lead.phone,
          // Only when the deployment knows its own public address. A callback
          // URL pointing at localhost is worse than none — the provider retries
          // it for hours.
          callbackUrl: base ? `${base}/api/webhooks/telephony` : undefined,
        });
      } catch (err) {
        req.log.error({ err: String(err) }, 'click-to-call failed');
        return reply.code(502).send({ error: 'The telephony provider could not place the call.' });
      }

      const call = await withTenantContext(req.ctx, async (db) => {
        const { rows: [row] } = await db.query(
          `INSERT INTO call_logs
             (tenant_id, lead_id, user_id, mode, provider, provider_call_id, direction,
              status, caller_id, initiated_at)
           VALUES (app_current_tenant(), $1, $2, 'API_CLOUD', 'exotel', $3, 'outbound', $4, $5, now())
           RETURNING id, status, provider_call_id, initiated_at`,
          [req.params.id, req.ctx.userId, placed.providerCallId, placed.status, cfg.callerId]);
        return row;
      });

      reply.code(201);
      return {
        call: {
          id: call.id,
          status: call.status,
          providerCallId: call.provider_call_id,
          initiatedAt: call.initiated_at,
          // Said explicitly, because it is the reason this exists.
          callerId: cfg.callerId,
          note: 'Your phone will ring first. The customer sees the workspace number, never yours.',
        },
      };
    },
  );

  /**
   * POST /api/webhooks/telephony — the provider's status callbacks.
   *
   * Public and unauthenticated in the session sense; the credential is the
   * secret in the URL, which is how Exotel does it. The workspace is resolved
   * FROM that secret, so a provider never has to know which tenant it is
   * calling back about.
   *
   * Answers 200 for a redelivery. A provider retries on any non-2xx.
   */
  app.post<{ Querystring: { secret?: string } }>(
    '/api/webhooks/telephony',
    { config: { rateLimit: { max: 600, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const presented = String(
        req.query?.secret ?? req.headers['x-telephony-secret'] ?? '').trim();
      if (!presented) return reply.code(401).send({ error: 'Missing secret' });

      // Platform pool: there is no session, and the secret identifies the
      // workspace. Compared in constant time against every ACTIVE row.
      const { rows: candidates } = await platformPool.query(
        `SELECT tenant_id, callback_secret_hash FROM telephony_settings
          WHERE active AND callback_secret_hash <> ''`);
      const match = candidates.find(c => secretMatches(presented, c.callback_secret_hash as string));
      if (!match) {
        req.log.warn({ ip: req.ip }, 'telephony callback rejected — unknown secret');
        return reply.code(401).send({ error: 'Invalid secret' });
      }

      const body = (req.body ?? {}) as Record<string, unknown>;
      const evt = readCallEvent(body);
      if (!evt.providerCallId) return reply.code(400).send({ error: 'Missing call id' });
      const status = mapExotelStatus(evt.status);

      const client = await platformPool.connect();
      try {
        await client.query('BEGIN');

        // The idempotency gate: one row per call per status. ON CONFLICT DO
        // NOTHING returns none for a redelivery, with no race between a SELECT
        // and an INSERT.
        const { rows: [stored] } = await client.query(
          `INSERT INTO telephony_events
             (tenant_id, provider, provider_call_id, event_status, payload)
           VALUES ($1, 'exotel', $2, $3, $4)
           ON CONFLICT (provider, provider_call_id, event_status) DO NOTHING
           RETURNING id`,
          [match.tenant_id, evt.providerCallId, status, JSON.stringify(body)]);

        if (!stored) {
          await client.query('ROLLBACK');
          return { ok: true, duplicate: true };
        }

        const { rows: [updated] } = await client.query(
          `UPDATE call_logs
              SET status = $1,
                  duration_seconds = GREATEST(duration_seconds, $2),
                  recording_url = COALESCE(NULLIF($3,''), recording_url),
                  answered_at = CASE WHEN $1 IN ('in_progress','connected') AND answered_at IS NULL
                                     THEN now() ELSE answered_at END,
                  ended_at = CASE WHEN $1 IN ('connected','no_answer','busy','failed')
                                  THEN now() ELSE ended_at END
            WHERE tenant_id = $4 AND provider = 'exotel' AND provider_call_id = $5
            RETURNING id`,
          [status, Math.max(0, Math.round(evt.durationSeconds)), evt.recordingUrl,
           match.tenant_id, evt.providerCallId]);

        await client.query(
          `UPDATE telephony_events SET applied_at = now(), call_log_id = $1 WHERE id = $2`,
          [updated?.id ?? null, stored.id]);

        await client.query('COMMIT');
        // A callback for a call this system never placed is acknowledged, not
        // retried — the provider cannot fix it and will otherwise try forever.
        return { ok: true, matched: !!updated };
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        req.log.error({ err: String(err), callId: evt.providerCallId }, 'telephony callback failed');
        return reply.code(500).send({ error: 'Could not process the callback' });
      } finally {
        client.release();
      }
    },
  );
}
