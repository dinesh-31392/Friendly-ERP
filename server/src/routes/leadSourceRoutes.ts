import type { FastifyInstance } from 'fastify';
import { withTenantContext, platformPool } from '../db.js';
import { requireAuth } from '../auth.js';
import {
  normaliseLead, normalisePhone, mintSourceSecret, hashSourceSecret,
  SOURCE_KEYS, SOURCE_LABELS, type SourceKey,
} from '../leadIngest.js';
import { enqueueAutoReply } from '../autoReply.js';

/**
 * Portal lead ingest (migration 055).
 *
 * 99acres, MagicBricks and Housing push leads server-to-server. They have no
 * session, no user and no workspace slug — just a URL a builder pastes into
 * their portal dashboard and a secret, if that portal supports one.
 *
 * Two halves: the workspace-facing routes that mint and revoke a source's
 * credential, and the PUBLIC ingest endpoint the portal actually calls.
 */

const UUID = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

async function gate(db: import('pg').PoolClient, perm: string): Promise<boolean> {
  const { rows: [{ allowed }] } = await db.query(`SELECT has_permission($1) AS allowed`, [perm]);
  return !!allowed;
}

const toApi = (r: Record<string, unknown>) => ({
  id: r.id,
  sourceKey: r.source_key,
  label: r.label || SOURCE_LABELS[r.source_key as SourceKey] || r.source_key,
  active: !!r.active,
  receivedCount: Number(r.received_count),
  lastSeenAt: r.last_seen_at ?? null,
  createdAt: r.created_at,
});

export async function leadSourceRoutes(app: FastifyInstance): Promise<void> {
  /** GET /api/lead-sources — configured feeds. Never returns a secret. */
  app.get('/api/lead-sources', { preHandler: requireAuth }, async (req, reply) =>
    withTenantContext(req.ctx, async (db) => {
      if (!await gate(db, 'view_leads')) {
        return reply.code(403).send({ error: 'Missing permission: view_leads' });
      }
      const { rows } = await db.query('SELECT * FROM lead_sources ORDER BY source_key');
      return { sources: rows.map(toApi), available: SOURCE_KEYS };
    }),
  );

  /**
   * POST /api/lead-sources — mint a credential for a portal.
   *
   * The token is returned EXACTLY ONCE and never again. Only its digest is
   * stored, so a database dump does not hand somebody the ability to inject
   * leads into a workspace. Re-posting for a source that already has one
   * rotates it, which is what "regenerate" means and the only safe way to
   * replace a leaked key.
   */
  app.post<{ Body: { sourceKey: string; label?: string } }>(
    '/api/lead-sources',
    {
      preHandler: requireAuth,
      schema: {
        body: {
          type: 'object', required: ['sourceKey'], additionalProperties: false,
          properties: {
            sourceKey: { type: 'string', enum: SOURCE_KEYS },
            label: { type: 'string', maxLength: 80 },
          },
        },
      },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'manage_leads')) {
          return reply.code(403).send({ error: 'Missing permission: manage_leads' });
        }
        const { token, hash } = mintSourceSecret();
        const { rows: [row] } = await db.query(
          `INSERT INTO lead_sources (tenant_id, source_key, label, secret_hash, created_by)
           VALUES (app_current_tenant(), $1, COALESCE($2,''), $3, $4)
           ON CONFLICT (tenant_id, source_key)
           DO UPDATE SET secret_hash = EXCLUDED.secret_hash,
                         label = COALESCE(NULLIF(EXCLUDED.label,''), lead_sources.label),
                         active = true
           RETURNING *`,
          [req.body.sourceKey, req.body.label ?? null, hash, req.ctx.userId]);

        reply.code(201);
        return {
          source: toApi(row),
          // Shown once. The client is told so, because a token silently lost is
          // a rotation nobody realises they need to do.
          secret: token,
          ingestUrl: `/api/public/leads/ingest/${req.body.sourceKey}`,
          note: 'Copy the secret now — it is stored only as a digest and cannot be shown again.',
        };
      }),
  );

  /** PATCH /api/lead-sources/:id — turn a feed off without losing its history. */
  app.patch<{ Params: { id: string }; Body: { active: boolean } }>(
    '/api/lead-sources/:id',
    {
      preHandler: requireAuth,
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: UUID } } },
        body: {
          type: 'object', required: ['active'], additionalProperties: false,
          properties: { active: { type: 'boolean' } },
        },
      },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'manage_leads')) {
          return reply.code(403).send({ error: 'Missing permission: manage_leads' });
        }
        const { rows } = await db.query(
          'UPDATE lead_sources SET active = $1 WHERE id = $2 RETURNING *',
          [req.body.active, req.params.id]);
        if (!rows[0]) return reply.code(404).send({ error: 'Source not found' });
        return { source: toApi(rows[0]) };
      }),
  );

  /**
   * POST /api/public/leads/ingest/:source — what the portal calls.
   *
   * Public and unauthenticated in the session sense; the credential is the
   * secret in the header. The workspace is resolved FROM that secret, which is
   * why the digest is indexed: a portal cannot tell us which tenant it is
   * posting to, and asking it to would let anyone post into any workspace.
   *
   * Answers 200 for a duplicate rather than an error. Portals retry on any
   * non-2xx, so rejecting a redelivery turns one duplicate into a retry storm.
   */
  app.post<{ Params: { source: string } }>(
    '/api/public/leads/ingest/:source',
    {
      config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
      schema: {
        params: {
          type: 'object', required: ['source'],
          properties: { source: { type: 'string', enum: SOURCE_KEYS } },
        },
      },
    },
    async (req, reply) => {
      // Accepted in a header or a query parameter: several portals cannot send
      // custom headers at all, and a query secret over TLS is what they give
      // you. Not ideal, and the reason each source has its own revocable key.
      const presented = String(
        req.headers['x-lead-source-secret']
        ?? (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '')
        ?? (req.query as Record<string, string>)?.secret
        ?? '',
      ).trim() || String((req.query as Record<string, string>)?.secret ?? '').trim();

      if (!presented) return reply.code(401).send({ error: 'Missing source secret' });

      const source = req.params.source as SourceKey;
      const digest = hashSourceSecret(presented);

      // Platform pool: there is no session, and the secret is what identifies
      // the workspace. Scoped explicitly by source_key so a credential minted
      // for the website cannot be used to post as MagicBricks.
      const { rows: [src] } = await platformPool.query(
        `SELECT id, tenant_id, source_key FROM lead_sources
          WHERE secret_hash = $1 AND source_key = $2 AND active`,
        [digest, source]);

      if (!src) {
        req.log.warn({ source, ip: req.ip }, 'lead ingest rejected — unknown or inactive secret');
        return reply.code(401).send({ error: 'Invalid source secret' });
      }

      const lead = normaliseLead(source, req.body);
      if (!lead.phone && !lead.email) {
        // A lead with no way to contact them is not a lead. 400 rather than a
        // silent drop, because a portal sending these has a mapping problem
        // its own dashboard will show.
        return reply.code(400).send({ error: 'A phone number or an email address is required' });
      }

      const normalised = normalisePhone(lead.phone);

      const result = await withTenantContext(
        { tenantId: src.tenant_id as string, userId: '', ip: req.ip },
        async (db) => {
          // Dedupe on the phone, within a window. The same buyer enquiring
          // again in three months is a NEW lead a salesperson wants; the same
          // enquiry redelivered ten minutes later is not.
          if (normalised) {
            // `phone_normalized` is a generated column holding EVERY digit, so
            // "+91 98200 11111" stores as 919820011111 and "09820011111" as
            // 09820011111 — the same buyer, two values, and a direct comparison
            // never matches. The last ten digits are the mobile number itself,
            // with country code and trunk prefix discarded, which is what makes
            // a portal retry and a web-form re-submission resolve to one lead.
            const { rows: [dup] } = await db.query(
              `SELECT id FROM leads
                WHERE right(phone_normalized, 10) = $1
                  AND created_at > now() - interval '30 days'
                ORDER BY created_at DESC LIMIT 1`,
              [normalised]);
            if (dup) {
              await db.query(
                `INSERT INTO lead_activities (tenant_id, lead_id, type, notes)
                 VALUES (app_current_tenant(), $1, 'note', $2)`,
                [dup.id, `Repeat enquiry via ${SOURCE_LABELS[source]}${lead.project ? ` for ${lead.project}` : ''}.`],
              ).catch(() => { /* the dedupe is the point; the note is a bonus */ });
              return { duplicate: true, leadId: dup.id as string };
            }
          }

          let projectId: string | null = null;
          let projectName = lead.project;
          if (lead.project) {
            const { rows: pr } = await db.query(
              `SELECT id, name FROM projects WHERE name ILIKE $1 LIMIT 1`, [lead.project]);
            if (pr[0]) { projectId = pr[0].id; projectName = pr[0].name; }
          }

          // Same capacity routing as the chatbot capture: the active rep with
          // the fewest open leads.
          const { rows: rep } = await db.query(
            `SELECT u.id,
                    (SELECT count(*) FROM leads l
                      WHERE l.assigned_to = u.id AND l.stage NOT IN ('booked','lost')) AS open
               FROM users u JOIN roles r ON r.id = u.role_id
              WHERE u.active AND r.name IN ('sales_executive','sales_manager')
              ORDER BY open ASC, u.id ASC LIMIT 1`);

          const { rows: [created] } = await db.query(
            `INSERT INTO leads
               (tenant_id, name, email, phone, source, project_id, project, budget,
                configuration, stage, priority, assigned_to, custom_fields, last_contact_at)
             VALUES (app_current_tenant(), $1, $2, $3, $4, $5, $6, $7, $8,
                     'new', 'warm', $9, $10::jsonb, now())
             RETURNING id`,
            // `project` is NOT NULL on leads — a portal enquiry that names no
            // project (a generic "send me details" from a listings page, which
            // is most of them) would otherwise fail the whole insert.
            [lead.name || 'Portal enquiry', lead.email || null, lead.phone,
             SOURCE_LABELS[source], projectId, projectName || '', lead.budget,
             lead.configuration || null, rep[0]?.id ?? null,
             JSON.stringify({ ...lead.extra, ...(lead.message ? { message: lead.message } : {}) })]);

          await db.query(
            `UPDATE lead_sources
                SET received_count = received_count + 1, last_seen_at = now()
              WHERE id = $1`, [src.id]);

          // A portal lead is somebody who enquired seconds ago and is looking
          // at three other builders' listings right now.
          await enqueueAutoReply(db, {
            leadId: created.id, trigger: 'new_lead', phone: lead.phone,
            leadName: lead.name || 'there', project: projectName,
          }).catch(() => { /* never fail the capture */ });

          return { duplicate: false, leadId: created.id as string };
        });

      if (result.duplicate) return { ok: true, duplicate: true, leadId: result.leadId };
      reply.code(201);
      return { ok: true, leadId: result.leadId };
    },
  );
}
