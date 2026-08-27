import type { FastifyInstance } from 'fastify';
import { withTenantContext } from '../db.js';
import { requireAuth } from '../auth.js';
import { planErasure, executeErasure, findExpired } from '../erasure.js';

/**
 * Retention and erasure (migration 054).
 *
 * The workspace side of the Digital Personal Data Protection Act, 2023: how
 * long things are kept, and what happens when someone asks for their data to be
 * removed.
 *
 * Gated on manage_settings rather than a new permission. Answering a legal
 * request is an act of the person who administers the workspace, and inventing
 * a key nobody has been granted would make the feature unreachable until a
 * migration backfilled it (invariant 5 — there is no super-admin bypass).
 */

const UUID = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

async function gate(db: import('pg').PoolClient, perm: string): Promise<boolean> {
  const { rows: [{ allowed }] } = await db.query(`SELECT has_permission($1) AS allowed`, [perm]);
  return !!allowed;
}

const toApiPolicy = (r: Record<string, unknown>) => ({
  id: r.id,
  entity: r.entity,
  retainDays: r.retain_days === null ? null : Number(r.retain_days),
  legalBasis: r.legal_basis ?? '',
  statutory: !!r.statutory,
  updatedAt: r.updated_at,
});

const toApiAction = (r: Record<string, unknown>) => ({
  id: r.id,
  entity: r.entity,
  recordId: r.record_id ?? null,
  recordCount: Number(r.record_count),
  action: r.action,
  legalBasis: r.legal_basis ?? '',
  detail: r.detail ?? '',
  performedAt: r.performed_at,
});

const toApiRequest = (r: Record<string, unknown>, actions: Record<string, unknown>[] = []) => ({
  id: r.id,
  subjectType: r.subject_type,
  subjectId: r.subject_id ?? null,
  subjectEmail: r.subject_email ?? '',
  subjectPhone: r.subject_phone ?? '',
  subjectName: r.subject_name ?? '',
  receivedOn: r.received_on,
  channel: r.channel,
  status: r.status,
  verifiedAt: r.verified_at ?? null,
  verificationNote: r.verification_note ?? '',
  completedAt: r.completed_at ?? null,
  refusedReason: r.refused_reason ?? '',
  createdAt: r.created_at,
  actions: actions.map(toApiAction),
});

export async function privacyRoutes(app: FastifyInstance): Promise<void> {
  /** GET /api/retention-policies — how long this workspace keeps things. */
  app.get('/api/retention-policies', { preHandler: requireAuth }, async (req, reply) =>
    withTenantContext(req.ctx, async (db) => {
      if (!await gate(db, 'manage_settings')) {
        return reply.code(403).send({ error: 'Missing permission: manage_settings' });
      }
      const { rows } = await db.query(
        'SELECT * FROM retention_policies ORDER BY statutory DESC, entity');
      return { policies: rows.map(toApiPolicy) };
    }),
  );

  /**
   * PATCH /api/retention-policies/:id — change a period.
   *
   * A statutory period may be EXTENDED but never shortened. The floor is set by
   * law and a workspace does not get to lower it; a builder who wants to keep
   * ledgers for twelve years instead of eight is welcome to.
   */
  app.patch<{ Params: { id: string }; Body: { retainDays: number | null } }>(
    '/api/retention-policies/:id',
    {
      preHandler: requireAuth,
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: UUID } } },
        body: {
          type: 'object', required: ['retainDays'], additionalProperties: false,
          properties: { retainDays: { type: ['integer', 'null'], minimum: 0, maximum: 36500 } },
        },
      },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'manage_settings')) {
          return reply.code(403).send({ error: 'Missing permission: manage_settings' });
        }
        const { rows: [policy] } = await db.query(
          'SELECT * FROM retention_policies WHERE id = $1', [req.params.id]);
        if (!policy) return reply.code(404).send({ error: 'Policy not found' });

        const next = req.body.retainDays;
        if (policy.statutory) {
          // null means "keep indefinitely", which is always at least as long as
          // the floor and therefore always allowed.
          if (next !== null && Number(next) < Number(policy.retain_days)) {
            return reply.code(409).send({
              error: `${policy.entity} is retained under a statutory obligation and cannot be kept for less than ${policy.retain_days} days.`,
              legalBasis: policy.legal_basis,
            });
          }
        }

        const { rows: [updated] } = await db.query(
          `UPDATE retention_policies SET retain_days = $1, updated_by = $2, updated_at = now()
            WHERE id = $3 RETURNING *`,
          [next, req.ctx.userId, req.params.id]);
        return { policy: toApiPolicy(updated) };
      }),
  );

  /** GET /api/retention-sweep — what has aged out, without deleting it. */
  app.get('/api/retention-sweep', { preHandler: requireAuth }, async (req, reply) =>
    withTenantContext(req.ctx, async (db) => {
      if (!await gate(db, 'manage_settings')) {
        return reply.code(403).send({ error: 'Missing permission: manage_settings' });
      }
      return { expired: await findExpired(db) };
    }),
  );

  /** GET /api/erasure-requests */
  app.get('/api/erasure-requests', { preHandler: requireAuth }, async (req, reply) =>
    withTenantContext(req.ctx, async (db) => {
      if (!await gate(db, 'manage_settings')) {
        return reply.code(403).send({ error: 'Missing permission: manage_settings' });
      }
      const { rows } = await db.query(
        'SELECT * FROM erasure_requests ORDER BY created_at DESC LIMIT 500');
      return { requests: rows.map(r => toApiRequest(r)) };
    }),
  );

  /** GET /api/erasure-requests/:id — with what was actually done. */
  app.get<{ Params: { id: string } }>(
    '/api/erasure-requests/:id',
    { preHandler: requireAuth, schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: UUID } } } } },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'manage_settings')) {
          return reply.code(403).send({ error: 'Missing permission: manage_settings' });
        }
        const { rows: [r] } = await db.query('SELECT * FROM erasure_requests WHERE id = $1', [req.params.id]);
        if (!r) return reply.code(404).send({ error: 'Request not found' });
        const { rows: actions } = await db.query(
          'SELECT * FROM erasure_actions WHERE request_id = $1 ORDER BY performed_at, entity', [r.id]);
        return { request: toApiRequest(r, actions) };
      }),
  );

  /** POST /api/erasure-requests — log one. */
  app.post<{ Body: {
    subjectType?: string; subjectEmail?: string; subjectPhone?: string;
    subjectName?: string; subjectId?: string; channel?: string;
  } }>(
    '/api/erasure-requests',
    {
      preHandler: requireAuth,
      schema: {
        body: {
          type: 'object', additionalProperties: false,
          properties: {
            subjectType: { type: 'string', enum: ['lead', 'portal_user', 'broker', 'employee'] },
            subjectEmail: { type: 'string', maxLength: 320 },
            subjectPhone: { type: 'string', maxLength: 40 },
            subjectName: { type: 'string', maxLength: 200 },
            subjectId: { type: 'string', pattern: UUID },
            channel: { type: 'string', maxLength: 40 },
          },
        },
      },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'manage_settings')) {
          return reply.code(403).send({ error: 'Missing permission: manage_settings' });
        }
        const b = req.body;
        if (!b.subjectEmail?.trim() && !b.subjectPhone?.trim() && !b.subjectId) {
          // Without one of these there is nobody to erase, and a request that
          // resolves to nothing would sit in the queue looking actionable.
          return reply.code(400).send({ error: 'An email, a phone number or a lead id is required to identify the subject.' });
        }
        const { rows: [created] } = await db.query(
          `INSERT INTO erasure_requests
             (tenant_id, subject_type, subject_id, subject_email, subject_phone, subject_name, channel, created_by)
           VALUES (app_current_tenant(), COALESCE($1,'lead'), $2, COALESCE($3,''), COALESCE($4,''),
                   COALESCE($5,''), COALESCE($6,'email'), $7)
           RETURNING *`,
          [b.subjectType ?? null, b.subjectId ?? null, b.subjectEmail ?? null,
           b.subjectPhone ?? null, b.subjectName ?? null, b.channel ?? null, req.ctx.userId]);
        reply.code(201);
        return { request: toApiRequest(created) };
      }),
  );

  /**
   * POST /api/erasure-requests/:id/verify — establish who is asking.
   *
   * Nothing is destroyed against an unverified identity, and the database
   * refuses a completion without one. An erasure request is otherwise a
   * perfect way to delete a rival's pipeline.
   */
  app.post<{ Params: { id: string }; Body: { note: string } }>(
    '/api/erasure-requests/:id/verify',
    {
      preHandler: requireAuth,
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: UUID } } },
        body: {
          type: 'object', required: ['note'], additionalProperties: false,
          properties: { note: { type: 'string', minLength: 1, maxLength: 2000 } },
        },
      },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'manage_settings')) {
          return reply.code(403).send({ error: 'Missing permission: manage_settings' });
        }
        const { rows } = await db.query(
          `UPDATE erasure_requests
              SET status = 'verified', verified_at = now(), verified_by = $1, verification_note = $2
            WHERE id = $3 AND status = 'received' RETURNING *`,
          [req.ctx.userId, req.body.note, req.params.id]);
        if (!rows[0]) return reply.code(409).send({ error: 'Not found, or already verified.' });
        return { request: toApiRequest(rows[0]) };
      }),
  );

  /**
   * GET /api/erasure-requests/:id/preview — what WOULD happen.
   *
   * Read-only, and available before verification, because the person answering
   * the request has to be able to tell the subject what will be removed and
   * what will be kept before they do any of it. The reply to a Data Principal
   * is written from this.
   */
  app.get<{ Params: { id: string } }>(
    '/api/erasure-requests/:id/preview',
    { preHandler: requireAuth, schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: UUID } } } } },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'manage_settings')) {
          return reply.code(403).send({ error: 'Missing permission: manage_settings' });
        }
        const { rows: [r] } = await db.query('SELECT * FROM erasure_requests WHERE id = $1', [req.params.id]);
        if (!r) return reply.code(404).send({ error: 'Request not found' });
        const plan = await planErasure(db, {
          leadId: r.subject_id as string | null,
          email: (r.subject_email as string) || '',
          phone: (r.subject_phone as string) || '',
        });
        return {
          preview: {
            matched: plan.leadIds.length,
            steps: plan.steps,
            erasedCount: plan.steps.filter(s => s.action === 'erased').reduce((n, s) => n + s.recordCount, 0),
            redactedCount: plan.steps.filter(s => s.action === 'redacted').reduce((n, s) => n + s.recordCount, 0),
            retainedCount: plan.steps.filter(s => s.action === 'retained').reduce((n, s) => n + s.recordCount, 0),
          },
        };
      }),
  );

  /**
   * POST /api/erasure-requests/:id/execute — carry it out.
   *
   * The plan is recomputed here rather than taken from the preview: minutes or
   * days may have passed, and acting on a stale plan would either miss data
   * added since or try to delete rows that have already gone.
   */
  app.post<{ Params: { id: string } }>(
    '/api/erasure-requests/:id/execute',
    { preHandler: requireAuth, schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: UUID } } } } },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'manage_settings')) {
          return reply.code(403).send({ error: 'Missing permission: manage_settings' });
        }
        const { rows: [r] } = await db.query('SELECT * FROM erasure_requests WHERE id = $1', [req.params.id]);
        if (!r) return reply.code(404).send({ error: 'Request not found' });
        if (r.status !== 'verified') {
          return reply.code(409).send({
            error: r.status === 'completed'
              ? 'That request has already been carried out.'
              : 'The subject\'s identity must be verified before anything is erased.',
          });
        }

        const plan = await planErasure(db, {
          leadId: r.subject_id as string | null,
          email: (r.subject_email as string) || '',
          phone: (r.subject_phone as string) || '',
        });

        // The actions are written BEFORE the data goes. Recording afterwards
        // would mean a failure halfway leaves data destroyed and no account of
        // it — and the whole transaction rolls back together anyway.
        for (const s of plan.steps) {
          await db.query(
            `INSERT INTO erasure_actions
               (tenant_id, request_id, entity, record_id, record_count, action, legal_basis, detail)
             VALUES (app_current_tenant(), $1, $2, $3, $4, $5, $6, $7)`,
            [r.id, s.entity, s.recordId ?? null, s.recordCount, s.action, s.legalBasis, s.detail]);
        }

        await executeErasure(db, plan);

        await db.query(
          `UPDATE erasure_requests SET status = 'completed', completed_at = now() WHERE id = $1`,
          [r.id]);

        const { rows: [after] } = await db.query('SELECT * FROM erasure_requests WHERE id = $1', [r.id]);
        const { rows: actions } = await db.query(
          'SELECT * FROM erasure_actions WHERE request_id = $1 ORDER BY performed_at, entity', [r.id]);
        return { request: toApiRequest(after, actions) };
      }),
  );

  /** POST /api/erasure-requests/:id/refuse — with the reason the Act requires. */
  app.post<{ Params: { id: string }; Body: { reason: string } }>(
    '/api/erasure-requests/:id/refuse',
    {
      preHandler: requireAuth,
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: UUID } } },
        body: {
          type: 'object', required: ['reason'], additionalProperties: false,
          properties: { reason: { type: 'string', minLength: 1, maxLength: 2000 } },
        },
      },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'manage_settings')) {
          return reply.code(403).send({ error: 'Missing permission: manage_settings' });
        }
        const { rows } = await db.query(
          `UPDATE erasure_requests SET status = 'refused', refused_reason = $1
            WHERE id = $2 AND status <> 'completed' RETURNING *`,
          [req.body.reason, req.params.id]);
        if (!rows[0]) return reply.code(409).send({ error: 'Not found, or already carried out.' });
        return { request: toApiRequest(rows[0]) };
      }),
  );
}
