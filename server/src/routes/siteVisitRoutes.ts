import type { FastifyInstance } from 'fastify';
import { withTenantContext } from '../db.js';
import { requireAuth } from '../auth.js';
import { emit } from '../notify.js';

/**
 * Site visits (migration 043) — the middle of the funnel.
 *
 * Gated on the LEAD permissions rather than a new key. A site visit is an
 * event in a lead's life, the people who schedule one are the people who work
 * leads, and inventing `manage_site_visits` would leave the feature
 * unreachable until a migration granted it to somebody (invariant 5: there is
 * no super-admin bypass).
 *
 * A rep with only `manage_own_leads` may schedule and close visits for leads
 * assigned to them, and sees only their own — the same scoping the lead routes
 * already apply, so a visit cannot become a side channel to a lead somebody is
 * not allowed to see.
 */

const UUID = '^[0-9a-fA-F-]{36}$';
const OUTCOMES = ['interested', 'not_interested', 'needs_followup', 'booked'];

interface Access { canWrite: boolean; ownOnly: boolean }

async function leadAccess(db: import('pg').PoolClient): Promise<Access> {
  const { rows: [p] } = await db.query(
    `SELECT has_permission('manage_leads')     AS full_access,
            has_permission('manage_own_leads') AS own_access,
            has_permission('assign_leads')     AS can_assign`);
  return {
    canWrite: p.full_access || p.own_access,
    ownOnly: !p.full_access && !p.can_assign,
  };
}

const toApi = (r: Record<string, unknown>) => ({
  id: r.id,
  leadId: r.lead_id,
  leadName: r.lead_name ?? undefined,
  projectId: r.project_id ?? undefined,
  unitId: r.unit_id ?? undefined,
  assignedTo: r.assigned_to,
  assigneeName: r.assignee_name ?? undefined,
  scheduledAt: r.scheduled_at,
  durationMinutes: r.duration_minutes,
  status: r.status,
  outcome: r.outcome ?? undefined,
  feedback: r.feedback ?? '',
  rescheduledFrom: r.rescheduled_from ?? undefined,
  completedAt: r.completed_at ?? null,
  createdAt: r.created_at,
});

const SELECT_VISIT = `
  SELECT v.*, l.name AS lead_name, u.name AS assignee_name
    FROM site_visits v
    JOIN leads l ON l.id = v.lead_id
    LEFT JOIN users u ON u.id = v.assigned_to`;

export async function siteVisitRoutes(app: FastifyInstance): Promise<void> {
  /** GET /api/site-visits — the diary. */
  app.get<{ Querystring: { from?: string; to?: string; status?: string; leadId?: string } }>(
    '/api/site-visits',
    {
      preHandler: requireAuth,
      schema: {
        querystring: {
          type: 'object',
          properties: {
            from: { type: 'string', maxLength: 40 },
            to: { type: 'string', maxLength: 40 },
            status: { type: 'string', enum: ['scheduled', 'confirmed', 'completed', 'no_show', 'cancelled'] },
            leadId: { type: 'string', pattern: UUID },
          },
        },
      },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        const { rows: [{ allowed }] } = await db.query(
          `SELECT has_permission('view_leads') AS allowed`);
        if (!allowed) return reply.code(403).send({ error: 'Missing permission: view_leads' });

        const acc = await leadAccess(db);
        const params: unknown[] = [];
        const where: string[] = ['true'];
        // A rep restricted to their own leads sees only visits assigned to
        // them — matching the lead routes, so this cannot become a way to
        // enumerate leads they are not allowed to open.
        if (acc.ownOnly) { params.push(req.ctx.userId); where.push(`v.assigned_to = $${params.length}`); }
        if (req.query.from) { params.push(req.query.from); where.push(`v.scheduled_at >= $${params.length}::timestamptz`); }
        if (req.query.to) { params.push(req.query.to); where.push(`v.scheduled_at <= $${params.length}::timestamptz`); }
        if (req.query.status) { params.push(req.query.status); where.push(`v.status = $${params.length}`); }
        if (req.query.leadId) { params.push(req.query.leadId); where.push(`v.lead_id = $${params.length}`); }

        const { rows } = await db.query(
          `${SELECT_VISIT} WHERE ${where.join(' AND ')} ORDER BY v.scheduled_at`, params);
        return { siteVisits: rows.map(toApi) };
      }),
  );

  /** GET /api/site-visits/funnel — leads scheduled, seen, missed, booked. */
  app.get<{ Querystring: { from?: string; to?: string } }>(
    '/api/site-visits/funnel',
    {
      preHandler: requireAuth,
      schema: {
        querystring: {
          type: 'object',
          properties: { from: { type: 'string', maxLength: 40 }, to: { type: 'string', maxLength: 40 } },
        },
      },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        const { rows: [{ allowed }] } = await db.query(
          `SELECT has_permission('view_leads') AS allowed`);
        if (!allowed) return reply.code(403).send({ error: 'Missing permission: view_leads' });
        const { rows: [f] } = await db.query(
          `SELECT * FROM site_visit_funnel($1::date, $2::date)`,
          [req.query.from ?? '1900-01-01', req.query.to ?? '2999-12-31']);
        return {
          funnel: {
            scheduled: Number(f.scheduled), completed: Number(f.completed),
            noShow: Number(f.no_show), booked: Number(f.booked),
          },
        };
      }),
  );

  /** POST /api/site-visits — book one, and tell whoever is taking it. */
  app.post<{ Body: {
    leadId: string; assignedTo: string; scheduledAt: string;
    projectId?: string; unitId?: string; durationMinutes?: number;
  } }>(
    '/api/site-visits',
    {
      preHandler: requireAuth,
      schema: {
        body: {
          type: 'object', required: ['leadId', 'assignedTo', 'scheduledAt'],
          additionalProperties: false,
          properties: {
            leadId: { type: 'string', pattern: UUID },
            assignedTo: { type: 'string', pattern: UUID },
            scheduledAt: { type: 'string', minLength: 4, maxLength: 40 },
            projectId: { type: 'string', pattern: UUID },
            unitId: { type: 'string', pattern: UUID },
            durationMinutes: { type: 'integer', minimum: 5, maximum: 600 },
          },
        },
      },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        const acc = await leadAccess(db);
        if (!acc.canWrite) return reply.code(403).send({ error: 'Missing permission: manage_leads' });

        // A restricted rep may only book against a lead that is theirs.
        // Checked here rather than left to RLS, because RLS scopes the tenant,
        // not the assignment.
        if (acc.ownOnly) {
          const { rows: own } = await db.query(
            `SELECT 1 FROM leads WHERE id = $1 AND assigned_to = $2`,
            [req.body.leadId, req.ctx.userId]);
          if (!own[0]) return reply.code(404).send({ error: 'Not found' });
        }

        const { rows } = await db.query(`
          INSERT INTO site_visits
            (tenant_id, lead_id, project_id, unit_id, assigned_to, scheduled_at,
             duration_minutes, created_by)
          VALUES (app_current_tenant(), $1, $2, $3, $4, $5::timestamptz,
                  COALESCE($6::int, 60), app_current_user())
          RETURNING *`,
          [req.body.leadId, req.body.projectId ?? null, req.body.unitId ?? null,
           req.body.assignedTo, req.body.scheduledAt, req.body.durationMinutes ?? null]);

        const { rows: [lead] } = await db.query(`SELECT name FROM leads WHERE id = $1`, [req.body.leadId]);

        // The rep taking the visit needs to know. Not the person who booked it,
        // who already knows — see notify.emit for why self-notification is the
        // most common complaint about systems like this.
        if (req.body.assignedTo !== req.ctx.userId) {
          await emit(db, {
            userId: req.body.assignedTo,
            kind: 'visit_scheduled',
            title: `Site visit: ${lead?.name ?? 'lead'}`,
            body: new Date(req.body.scheduledAt).toLocaleString('en-IN'),
            entityType: 'site_visit',
            entityId: String(rows[0].id),
          });
        }

        reply.code(201);
        return { siteVisit: toApi({ ...rows[0], lead_name: lead?.name }) };
      }),
  );

  /**
   * POST /api/site-visits/:id/reschedule — move it.
   *
   * Creates a NEW row pointing at the old one and cancels the original, rather
   * than editing scheduled_at. "How many visits slipped, and how often" is a
   * question a sales head asks; an overwritten timestamp cannot answer it.
   */
  app.post<{ Params: { id: string }; Body: { scheduledAt: string; assignedTo?: string } }>(
    '/api/site-visits/:id/reschedule',
    {
      preHandler: requireAuth,
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: UUID } } },
        body: {
          type: 'object', required: ['scheduledAt'], additionalProperties: false,
          properties: {
            scheduledAt: { type: 'string', minLength: 4, maxLength: 40 },
            assignedTo: { type: 'string', pattern: UUID },
          },
        },
      },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        const acc = await leadAccess(db);
        if (!acc.canWrite) return reply.code(403).send({ error: 'Missing permission: manage_leads' });

        const { rows: [old] } = await db.query(
          `SELECT * FROM site_visits WHERE id = $1 AND status IN ('scheduled','confirmed')`,
          [req.params.id]);
        if (!old) return reply.code(404).send({ error: 'Not found, or already closed' });
        if (acc.ownOnly && old.assigned_to !== req.ctx.userId) {
          return reply.code(404).send({ error: 'Not found' });
        }

        await db.query(`UPDATE site_visits SET status = 'cancelled' WHERE id = $1`, [old.id]);
        const { rows } = await db.query(`
          INSERT INTO site_visits
            (tenant_id, lead_id, project_id, unit_id, assigned_to, scheduled_at,
             duration_minutes, rescheduled_from, created_by)
          VALUES (app_current_tenant(), $1, $2, $3, $4, $5::timestamptz, $6, $7, app_current_user())
          RETURNING *`,
          [old.lead_id, old.project_id, old.unit_id,
           req.body.assignedTo ?? old.assigned_to, req.body.scheduledAt,
           old.duration_minutes, old.id]);

        reply.code(201);
        return { siteVisit: toApi(rows[0]) };
      }),
  );

  /**
   * PATCH /api/site-visits/:id — close it out.
   *
   * Completing writes a lead_activity as well, in the same transaction, so the
   * lead's timeline still reads as one story. State lives in site_visits;
   * narrative lives in lead_activities.
   */
  app.patch<{ Params: { id: string }; Body: { status: string; outcome?: string; feedback?: string } }>(
    '/api/site-visits/:id',
    {
      preHandler: requireAuth,
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: UUID } } },
        body: {
          type: 'object', required: ['status'], additionalProperties: false,
          properties: {
            status: { type: 'string', enum: ['confirmed', 'completed', 'no_show', 'cancelled'] },
            outcome: { type: 'string', enum: OUTCOMES },
            feedback: { type: 'string', maxLength: 2000 },
          },
        },
      },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        const acc = await leadAccess(db);
        if (!acc.canWrite) return reply.code(403).send({ error: 'Missing permission: manage_leads' });

        // The database enforces this too (site_visit_outcome_needs_completion),
        // but a 400 naming the field beats a 500 carrying a constraint name.
        if (req.body.status === 'completed' && !req.body.outcome) {
          return reply.code(400).send({ error: 'Completing a visit needs an outcome.' });
        }
        if (req.body.status !== 'completed' && req.body.outcome) {
          return reply.code(400).send({ error: 'An outcome only applies to a completed visit.' });
        }

        const { rows: [existing] } = await db.query(
          `SELECT * FROM site_visits WHERE id = $1 AND status IN ('scheduled','confirmed')`,
          [req.params.id]);
        if (!existing) return reply.code(404).send({ error: 'Not found, or already closed' });
        if (acc.ownOnly && existing.assigned_to !== req.ctx.userId) {
          return reply.code(404).send({ error: 'Not found' });
        }

        const { rows } = await db.query(`
          UPDATE site_visits
             SET status = $1,
                 outcome = $2,
                 feedback = COALESCE($3, feedback),
                 completed_at = CASE WHEN $1 = 'completed' THEN now() ELSE completed_at END
           WHERE id = $4
           RETURNING *`,
          [req.body.status, req.body.outcome ?? null, req.body.feedback ?? null, req.params.id]);

        if (req.body.status === 'completed') {
          await db.query(`
            INSERT INTO lead_activities (tenant_id, lead_id, user_id, type, notes, outcome)
            VALUES (app_current_tenant(), $1, app_current_user(), 'site_visit', $2, $3)`,
            [existing.lead_id,
             req.body.feedback || 'Site visit completed',
             // lead_activities has its own outcome vocabulary; only the values
             // both sides share are passed through, and the rest ride in notes.
             ['interested', 'not_interested'].includes(req.body.outcome as string)
               ? req.body.outcome : null]);
        }

        reply.code(200);
        return { siteVisit: toApi(rows[0]) };
      }),
  );
}
