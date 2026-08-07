import type { FastifyInstance } from 'fastify';
import { withTenantContext } from '../db.js';
import { requireAuth } from '../auth.js';

/**
 * Site execution: tasks & milestones, progress updates, RFIs, change orders,
 * inspections. Tables added in migration 017. RLS + RBAC
 * (view_execution / manage_execution / approve_change_orders).
 */

const UUID = '^[0-9a-fA-F-]{36}$';
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
async function gate(db: import('pg').PoolClient, perm: string): Promise<boolean> {
  const { rows: [{ allowed }] } = await db.query(`SELECT has_permission($1) AS allowed`, [perm]);
  return !!allowed;
}
async function projectInTenant(db: import('pg').PoolClient, projectId: string): Promise<boolean> {
  const { rows } = await db.query('SELECT id FROM projects WHERE id = $1', [projectId]);
  return !!rows[0];
}

export async function executionRoutes(app: FastifyInstance): Promise<void> {
  // ── Site tasks & milestones ─────────────────────────────────────────────
  const taskToApi = (r: Record<string, unknown>) => ({ id: r.id, projectId: r.project_id, title: r.title, description: r.description, isMilestone: r.is_milestone, startDate: r.start_date, dueDate: r.due_date, completedAt: r.completed_at, status: r.status, progress: r.progress, assignedTo: r.assigned_to, dependsOn: r.depends_on });

  app.get<{ Querystring: { projectId?: string } }>('/api/site-tasks', { preHandler: requireAuth }, async (req, reply) =>
    withTenantContext(req.ctx, async (db) => {
      if (!await gate(db, 'view_execution')) return reply.code(403).send({ error: 'Missing permission: view_execution' });
      const { rows } = req.query.projectId
        ? await db.query('SELECT * FROM site_tasks WHERE project_id = $1 ORDER BY due_date', [req.query.projectId])
        : await db.query('SELECT * FROM site_tasks ORDER BY due_date');
      return { siteTasks: rows.map(taskToApi) };
    }),
  );

  app.post<{ Body: { projectId: string; title: string; description?: string; isMilestone?: boolean; startDate?: string; dueDate?: string; assignedTo?: string; dependsOn?: string[] } }>(
    '/api/site-tasks',
    {
      preHandler: requireAuth,
      schema: { body: { type: 'object', required: ['projectId', 'title'], additionalProperties: false, properties: {
        projectId: { type: 'string', pattern: UUID }, title: { type: 'string', minLength: 1, maxLength: 200 }, description: { type: 'string', maxLength: 2000 },
        isMilestone: { type: 'boolean' }, startDate: { type: 'string' }, dueDate: { type: 'string' }, assignedTo: { type: 'string', pattern: UUID },
        dependsOn: { type: 'array', items: { type: 'string', pattern: UUID }, maxItems: 50 },
      } } },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'manage_execution')) return reply.code(403).send({ error: 'Missing permission: manage_execution' });
        if (!await projectInTenant(db, req.body.projectId)) return reply.code(404).send({ error: 'Project not found' });
        const b = req.body;
        const { rows } = await db.query(
          `INSERT INTO site_tasks (tenant_id, project_id, title, description, is_milestone, start_date, due_date, assigned_to, depends_on)
           VALUES (app_current_tenant(), $1,$2,$3,$4,$5, COALESCE($6, CURRENT_DATE), $7, $8::jsonb) RETURNING *`,
          [b.projectId, b.title, b.description || null, b.isMilestone ?? false, b.startDate || null, b.dueDate || null, b.assignedTo || null, JSON.stringify(b.dependsOn || [])]);
        reply.code(201); return { siteTask: taskToApi(rows[0]) };
      }),
  );

  app.patch<{ Params: { id: string }; Body: { status?: string; progress?: number } }>(
    '/api/site-tasks/:id',
    {
      preHandler: requireAuth,
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: UUID } } },
        body: { type: 'object', minProperties: 1, additionalProperties: false, properties: { status: { type: 'string', enum: ['not_started', 'in_progress', 'blocked', 'done'] }, progress: { type: 'integer', minimum: 0, maximum: 100 } } },
      },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'manage_execution')) return reply.code(403).send({ error: 'Missing permission: manage_execution' });
        // Done (or 100%) stamps completed_at; anything else clears it.
        const done = req.body.status === 'done' || req.body.progress === 100;
        const { rows } = await db.query(
          `UPDATE site_tasks SET
             status = COALESCE($1, CASE WHEN $2 >= 100 THEN 'done' ELSE status END),
             progress = CASE WHEN $3 = 'done' THEN 100 ELSE COALESCE($2, progress) END,
             completed_at = CASE WHEN $4 THEN now() ELSE NULL END
           WHERE id = $5 RETURNING *`,
          [req.body.status || null, req.body.progress ?? null, req.body.status || null, done, req.params.id]);
        if (!rows[0]) return reply.code(404).send({ error: 'Site task not found' });
        return { siteTask: taskToApi(rows[0]) };
      }),
  );

  app.delete<{ Params: { id: string } }>(
    '/api/site-tasks/:id',
    { preHandler: requireAuth, schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: UUID } } } } },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'manage_execution')) return reply.code(403).send({ error: 'Missing permission: manage_execution' });
        // Unlink dependents first so no task points at a ghost prerequisite
        // (mirrors the SPA's delete behavior).
        await db.query(`UPDATE site_tasks SET depends_on = depends_on - $1::text WHERE depends_on ? $1`, [req.params.id]);
        const { rowCount } = await db.query('DELETE FROM site_tasks WHERE id = $1', [req.params.id]);
        if (!rowCount) return reply.code(404).send({ error: 'Site task not found' });
        reply.code(204); return null;
      }),
  );

  // ── Progress updates ────────────────────────────────────────────────────
  app.get<{ Querystring: { projectId?: string } }>('/api/progress-updates', { preHandler: requireAuth }, async (req, reply) =>
    withTenantContext(req.ctx, async (db) => {
      if (!await gate(db, 'view_execution')) return reply.code(403).send({ error: 'Missing permission: view_execution' });
      const { rows } = req.query.projectId
        ? await db.query('SELECT * FROM progress_updates WHERE project_id = $1 ORDER BY date DESC', [req.query.projectId])
        : await db.query('SELECT * FROM progress_updates ORDER BY date DESC LIMIT 500');
      return { progressUpdates: rows.map(r => ({ id: r.id, projectId: r.project_id, userId: r.user_id, date: r.date, summary: r.summary, workforce: r.workforce, photos: r.photos })) };
    }),
  );

  app.post<{ Body: { projectId: string; summary?: string; workforce?: number; photos?: string[]; date?: string } }>(
    '/api/progress-updates',
    {
      preHandler: requireAuth,
      schema: { body: { type: 'object', required: ['projectId'], additionalProperties: false, properties: {
        projectId: { type: 'string', pattern: UUID }, summary: { type: 'string', maxLength: 2000 }, workforce: { type: 'integer', minimum: 0 }, photos: { type: 'array', items: { type: 'string' }, maxItems: 20 }, date: { type: 'string' },
      } } },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'manage_execution')) return reply.code(403).send({ error: 'Missing permission: manage_execution' });
        if (!await projectInTenant(db, req.body.projectId)) return reply.code(404).send({ error: 'Project not found' });
        const b = req.body;
        const { rows } = await db.query(
          `INSERT INTO progress_updates (tenant_id, project_id, user_id, date, summary, workforce, photos)
           VALUES (app_current_tenant(), $1, $2, COALESCE($3, CURRENT_DATE), $4, $5, $6::jsonb) RETURNING *`,
          [b.projectId, req.ctx.userId || null, b.date || null, b.summary || '', b.workforce ?? null, JSON.stringify(b.photos || [])]);
        const r = rows[0];
        reply.code(201); return { progressUpdate: { id: r.id, projectId: r.project_id, userId: r.user_id, date: r.date, summary: r.summary, workforce: r.workforce, photos: r.photos } };
      }),
  );

  app.delete<{ Params: { id: string } }>(
    '/api/progress-updates/:id',
    { preHandler: requireAuth, schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: UUID } } } } },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'manage_execution')) return reply.code(403).send({ error: 'Missing permission: manage_execution' });
        const { rowCount } = await db.query('DELETE FROM progress_updates WHERE id = $1', [req.params.id]);
        if (!rowCount) return reply.code(404).send({ error: 'Progress update not found' });
        reply.code(204); return null;
      }),
  );

  // ── RFIs ────────────────────────────────────────────────────────────────
  const rfiToApi = (r: Record<string, unknown>) => ({ id: r.id, projectId: r.project_id, number: r.number, subject: r.subject, question: r.question, raisedBy: r.raised_by, assignedTo: r.assigned_to, status: r.status, answer: r.answer, answeredAt: r.answered_at, dueDate: r.due_date });

  app.get<{ Querystring: { projectId?: string } }>('/api/rfis', { preHandler: requireAuth }, async (req, reply) =>
    withTenantContext(req.ctx, async (db) => {
      if (!await gate(db, 'view_execution')) return reply.code(403).send({ error: 'Missing permission: view_execution' });
      const { rows } = req.query.projectId
        ? await db.query('SELECT * FROM rfis WHERE project_id = $1 ORDER BY number DESC', [req.query.projectId])
        : await db.query('SELECT * FROM rfis ORDER BY created_at DESC');
      return { rfis: rows.map(rfiToApi) };
    }),
  );

  app.post<{ Body: { projectId: string; subject: string; question?: string; assignedTo?: string; dueDate?: string } }>(
    '/api/rfis',
    {
      preHandler: requireAuth,
      schema: { body: { type: 'object', required: ['projectId', 'subject'], additionalProperties: false, properties: {
        projectId: { type: 'string', pattern: UUID }, subject: { type: 'string', minLength: 1, maxLength: 200 }, question: { type: 'string', maxLength: 4000 }, assignedTo: { type: 'string', pattern: UUID }, dueDate: { type: 'string' },
      } } },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'manage_execution')) return reply.code(403).send({ error: 'Missing permission: manage_execution' });
        if (!await projectInTenant(db, req.body.projectId)) return reply.code(404).send({ error: 'Project not found' });
        const { rows: seq } = await db.query('SELECT COALESCE(MAX(number),0)+1 AS n FROM rfis WHERE project_id = $1', [req.body.projectId]);
        const { rows } = await db.query(
          `INSERT INTO rfis (tenant_id, project_id, number, subject, question, raised_by, assigned_to, due_date)
           VALUES (app_current_tenant(), $1, $2, $3, $4, $5, $6, $7) RETURNING *`,
          [req.body.projectId, seq[0].n, req.body.subject, req.body.question || '', req.ctx.userId || null, req.body.assignedTo || null, req.body.dueDate || null]);
        reply.code(201); return { rfi: rfiToApi(rows[0]) };
      }),
  );

  app.patch<{ Params: { id: string }; Body: { status?: string; answer?: string } }>(
    '/api/rfis/:id',
    {
      preHandler: requireAuth,
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: UUID } } },
        body: { type: 'object', minProperties: 1, additionalProperties: false, properties: { status: { type: 'string', enum: ['open', 'answered', 'closed'] }, answer: { type: 'string', maxLength: 4000 } } },
      },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'manage_execution')) return reply.code(403).send({ error: 'Missing permission: manage_execution' });
        const answering = req.body.answer !== undefined && req.body.answer !== '';
        const newStatus = req.body.status || (answering ? 'answered' : null);
        const { rows } = await db.query(
          `UPDATE rfis SET
             status = COALESCE($1, status),
             answer = COALESCE($2, answer),
             answered_at = CASE WHEN $3 THEN now() ELSE answered_at END
           WHERE id = $4 RETURNING *`,
          [newStatus, req.body.answer ?? null, answering, req.params.id]);
        if (!rows[0]) return reply.code(404).send({ error: 'RFI not found' });
        return { rfi: rfiToApi(rows[0]) };
      }),
  );

  // ── Change orders ───────────────────────────────────────────────────────
  const coToApi = (r: Record<string, unknown>) => ({ id: r.id, projectId: r.project_id, number: r.number, title: r.title, reason: r.reason, costImpact: num(r.cost_impact), timeImpactDays: r.time_impact_days, status: r.status, requestedBy: r.requested_by, decidedBy: r.decided_by, decidedAt: r.decided_at });

  app.get<{ Querystring: { projectId?: string } }>('/api/change-orders', { preHandler: requireAuth }, async (req, reply) =>
    withTenantContext(req.ctx, async (db) => {
      if (!await gate(db, 'view_execution')) return reply.code(403).send({ error: 'Missing permission: view_execution' });
      const { rows } = req.query.projectId
        ? await db.query('SELECT * FROM change_orders WHERE project_id = $1 ORDER BY number DESC', [req.query.projectId])
        : await db.query('SELECT * FROM change_orders ORDER BY created_at DESC');
      return { changeOrders: rows.map(coToApi) };
    }),
  );

  app.post<{ Body: { projectId: string; title: string; reason?: string; costImpact?: number; timeImpactDays?: number } }>(
    '/api/change-orders',
    {
      preHandler: requireAuth,
      schema: { body: { type: 'object', required: ['projectId', 'title'], additionalProperties: false, properties: {
        projectId: { type: 'string', pattern: UUID }, title: { type: 'string', minLength: 1, maxLength: 200 }, reason: { type: 'string', maxLength: 2000 }, costImpact: { type: 'number' }, timeImpactDays: { type: 'integer' },
      } } },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'manage_execution')) return reply.code(403).send({ error: 'Missing permission: manage_execution' });
        if (!await projectInTenant(db, req.body.projectId)) return reply.code(404).send({ error: 'Project not found' });
        const { rows: seq } = await db.query('SELECT COALESCE(MAX(number),0)+1 AS n FROM change_orders WHERE project_id = $1', [req.body.projectId]);
        const { rows } = await db.query(
          `INSERT INTO change_orders (tenant_id, project_id, number, title, reason, cost_impact, time_impact_days, requested_by)
           VALUES (app_current_tenant(), $1, $2, $3, $4, $5, $6, $7) RETURNING *`,
          [req.body.projectId, seq[0].n, req.body.title, req.body.reason || '', req.body.costImpact ?? 0, req.body.timeImpactDays ?? 0, req.ctx.userId || null]);
        reply.code(201); return { changeOrder: coToApi(rows[0]) };
      }),
  );

  app.patch<{ Params: { id: string }; Body: { status: string } }>(
    '/api/change-orders/:id',
    {
      preHandler: requireAuth,
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: UUID } } },
        body: { type: 'object', required: ['status'], additionalProperties: false, properties: { status: { type: 'string', enum: ['approved', 'rejected'] } } },
      },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        // Approving/rejecting a change order is the checker step.
        if (!await gate(db, 'approve_change_orders')) return reply.code(403).send({ error: 'Missing permission: approve_change_orders' });
        const { rows } = await db.query(
          `UPDATE change_orders SET status = $1, decided_by = $2::uuid, decided_at = now() WHERE id = $3 AND status = 'pending_approval' RETURNING *`,
          [req.body.status, req.ctx.userId || null, req.params.id]);
        if (!rows[0]) return reply.code(404).send({ error: 'Pending change order not found' });
        return { changeOrder: coToApi(rows[0]) };
      }),
  );

  // ── Inspections ─────────────────────────────────────────────────────────
  const inspToApi = (r: Record<string, unknown>) => ({ id: r.id, projectId: r.project_id, type: r.type, title: r.title, date: r.date, inspectorId: r.inspector_id, status: r.status, items: r.items, notes: r.notes });

  app.get<{ Querystring: { projectId?: string } }>('/api/inspections', { preHandler: requireAuth }, async (req, reply) =>
    withTenantContext(req.ctx, async (db) => {
      if (!await gate(db, 'view_execution')) return reply.code(403).send({ error: 'Missing permission: view_execution' });
      const { rows } = req.query.projectId
        ? await db.query('SELECT * FROM inspections WHERE project_id = $1 ORDER BY date DESC', [req.query.projectId])
        : await db.query('SELECT * FROM inspections ORDER BY date DESC');
      return { inspections: rows.map(inspToApi) };
    }),
  );

  app.post<{ Body: { projectId: string; type?: string; title: string; date?: string; items?: unknown[]; notes?: string } }>(
    '/api/inspections',
    {
      preHandler: requireAuth,
      schema: { body: { type: 'object', required: ['projectId', 'title'], additionalProperties: false, properties: {
        projectId: { type: 'string', pattern: UUID }, type: { type: 'string', enum: ['quality', 'safety'] }, title: { type: 'string', minLength: 1, maxLength: 200 }, date: { type: 'string' }, items: { type: 'array', maxItems: 200 }, notes: { type: 'string', maxLength: 2000 },
      } } },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'manage_execution')) return reply.code(403).send({ error: 'Missing permission: manage_execution' });
        if (!await projectInTenant(db, req.body.projectId)) return reply.code(404).send({ error: 'Project not found' });
        const b = req.body;
        const { rows } = await db.query(
          `INSERT INTO inspections (tenant_id, project_id, type, title, date, inspector_id, items, notes)
           VALUES (app_current_tenant(), $1, $2, $3, COALESCE($4, CURRENT_DATE), $5, $6::jsonb, $7) RETURNING *`,
          [b.projectId, b.type || 'quality', b.title, b.date || null, req.ctx.userId || null, JSON.stringify(b.items || []), b.notes || null]);
        reply.code(201); return { inspection: inspToApi(rows[0]) };
      }),
  );

  app.patch<{ Params: { id: string }; Body: { status?: string; items?: unknown[]; notes?: string } }>(
    '/api/inspections/:id',
    {
      preHandler: requireAuth,
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: UUID } } },
        body: { type: 'object', minProperties: 1, additionalProperties: false, properties: { status: { type: 'string', enum: ['scheduled', 'passed', 'failed'] }, items: { type: 'array', maxItems: 200 }, notes: { type: 'string', maxLength: 2000 } } },
      },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'manage_execution')) return reply.code(403).send({ error: 'Missing permission: manage_execution' });
        const { rows } = await db.query(
          `UPDATE inspections SET status = COALESCE($1, status), items = COALESCE($2::jsonb, items), notes = COALESCE($3, notes) WHERE id = $4 RETURNING *`,
          [req.body.status || null, req.body.items ? JSON.stringify(req.body.items) : null, req.body.notes ?? null, req.params.id]);
        if (!rows[0]) return reply.code(404).send({ error: 'Inspection not found' });
        return { inspection: inspToApi(rows[0]) };
      }),
  );

  app.delete<{ Params: { id: string } }>(
    '/api/inspections/:id',
    { preHandler: requireAuth, schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: UUID } } } } },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'manage_execution')) return reply.code(403).send({ error: 'Missing permission: manage_execution' });
        const { rowCount } = await db.query('DELETE FROM inspections WHERE id = $1', [req.params.id]);
        if (!rowCount) return reply.code(404).send({ error: 'Inspection not found' });
        reply.code(204); return null;
      }),
  );
}
