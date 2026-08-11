import type { FastifyInstance } from 'fastify';
import { withTenantContext } from '../db.js';
import { requireAuth } from '../auth.js';

/**
 * CRM tasks (migration 030) — the Calendar's follow-ups.
 *
 * These lived in localStorage, so a task a manager assigned to a rep never
 * reached the rep: it was written in the manager's browser. `crm_tasks` is
 * deliberately separate from `site_tasks` (construction work on a project) —
 * different owners, different lifecycle.
 */

const UUID = '^[0-9a-fA-F-]{36}$';

async function gate(db: import('pg').PoolClient, perm: string): Promise<boolean> {
  const { rows: [{ allowed }] } = await db.query(`SELECT has_permission($1) AS allowed`, [perm]);
  return !!allowed;
}

const toApi = (r: Record<string, unknown>) => ({
  id: r.id, tenantId: r.tenant_id, userId: r.user_id ?? '', leadId: r.lead_id ?? undefined,
  title: r.title, description: r.description ?? '',
  dueDate: r.due_date, priority: r.priority, status: r.status, category: r.category,
});

const PROPS = {
  userId: { type: 'string', pattern: UUID },
  leadId: { type: 'string', pattern: UUID },
  title: { type: 'string', minLength: 1, maxLength: 200 },
  description: { type: 'string', maxLength: 2000 },
  dueDate: { type: 'string' },
  priority: { type: 'string', enum: ['hot', 'warm', 'cold'] },
  status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
  category: { type: 'string', enum: ['follow_up', 'visit', 'payment', 'service', 'other'] },
} as const;

export async function crmTaskRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GET /api/crm-tasks — the caller's calendar.
   *
   * A sales executive sees only their own tasks. Anyone who can manage the team
   * sees everyone's, because that is the point of assigning work.
   */
  app.get('/api/crm-tasks', { preHandler: requireAuth }, async (req, reply) =>
    withTenantContext(req.ctx, async (db) => {
      if (!await gate(db, 'view_calendar')) return reply.code(403).send({ error: 'Missing permission: view_calendar' });
      const seesAll = await gate(db, 'manage_team') || await gate(db, 'manage_leads');
      const { rows } = seesAll
        ? await db.query(`SELECT * FROM crm_tasks ORDER BY due_date NULLS LAST, created_at DESC`)
        : await db.query(
            `SELECT * FROM crm_tasks WHERE user_id = app_current_user() ORDER BY due_date NULLS LAST, created_at DESC`);
      return { tasks: rows.map(toApi) };
    }),
  );

  app.post<{ Body: Record<string, unknown> }>(
    '/api/crm-tasks',
    {
      preHandler: requireAuth,
      schema: { body: { type: 'object', required: ['title'], additionalProperties: false, properties: PROPS } },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'schedule_visits') && !await gate(db, 'manage_leads')) {
          return reply.code(403).send({ error: 'Missing permission: schedule_visits' });
        }
        const b = req.body as Record<string, string | undefined>;
        // Assigning to someone else is a team action. Without that right the
        // task lands on the caller, whoever they named.
        const canAssign = await gate(db, 'manage_team') || await gate(db, 'assign_leads');
        const { rows } = await db.query(
          `INSERT INTO crm_tasks (tenant_id, user_id, lead_id, title, description, due_date, priority, status, category, created_by)
           VALUES (app_current_tenant(),
                   COALESCE($1, app_current_user()), $2, $3, COALESCE($4,''), $5,
                   COALESCE($6,'warm'), COALESCE($7,'pending'), COALESCE($8,'follow_up'), app_current_user())
           RETURNING *`,
          [canAssign ? (b.userId ?? null) : null, b.leadId ?? null, b.title, b.description ?? null,
           b.dueDate ?? null, b.priority ?? null, b.status ?? null, b.category ?? null]);
        reply.code(201); return { task: toApi(rows[0]) };
      }),
  );

  app.patch<{ Params: { id: string }; Body: Record<string, unknown> }>(
    '/api/crm-tasks/:id',
    {
      preHandler: requireAuth,
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: UUID } } },
        body: { type: 'object', minProperties: 1, additionalProperties: false, properties: PROPS },
      },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'view_calendar')) return reply.code(403).send({ error: 'Missing permission: view_calendar' });
        const seesAll = await gate(db, 'manage_team') || await gate(db, 'manage_leads');
        // 404 rather than 403 on someone else's task, so the endpoint never
        // confirms the existence of work the caller may not see.
        const { rows: found } = seesAll
          ? await db.query('SELECT 1 FROM crm_tasks WHERE id = $1', [req.params.id])
          : await db.query('SELECT 1 FROM crm_tasks WHERE id = $1 AND user_id = app_current_user()', [req.params.id]);
        if (!found[0]) return reply.code(404).send({ error: 'Task not found' });

        const COLS: Record<string, string> = {
          title: 'title', description: 'description', dueDate: 'due_date',
          priority: 'priority', status: 'status', category: 'category', leadId: 'lead_id',
          ...(seesAll ? { userId: 'user_id' } : {}),
        };
        const sets: string[] = []; const params: unknown[] = [];
        for (const [k, col] of Object.entries(COLS)) {
          const v = (req.body as Record<string, unknown>)[k];
          if (v !== undefined) { params.push(v); sets.push(`${col} = $${params.length}`); }
        }
        if (!sets.length) return reply.code(400).send({ error: 'No writable fields supplied' });
        params.push(req.params.id);
        const { rows } = await db.query(
          `UPDATE crm_tasks SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`, params);
        return { task: toApi(rows[0]) };
      }),
  );

  app.delete<{ Params: { id: string } }>(
    '/api/crm-tasks/:id',
    {
      preHandler: requireAuth,
      schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: UUID } } } },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'view_calendar')) return reply.code(403).send({ error: 'Missing permission: view_calendar' });
        const seesAll = await gate(db, 'manage_team') || await gate(db, 'manage_leads');
        const { rowCount } = seesAll
          ? await db.query('DELETE FROM crm_tasks WHERE id = $1', [req.params.id])
          : await db.query('DELETE FROM crm_tasks WHERE id = $1 AND user_id = app_current_user()', [req.params.id]);
        if (!rowCount) return reply.code(404).send({ error: 'Task not found' });
        reply.code(204); return null;
      }),
  );
}
