import type { FastifyInstance } from 'fastify';
import { withTenantContext } from '../db.js';
import { requireAuth } from '../auth.js';

/**
 * Post-sales service requests (003) + finance cost centers & budgets (004).
 * All three had tables but no API. RLS + RBAC throughout.
 */

const UUID = '^[0-9a-fA-F-]{36}$';
const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));
const SR_CATEGORIES = ['maintenance', 'document_request', 'payment_query', 'transfer_request', 'other'];
const SR_STATUSES = ['open', 'in_progress', 'resolved', 'closed'];

async function gate(db: import('pg').PoolClient, perm: string): Promise<boolean> {
  const { rows: [{ allowed }] } = await db.query(`SELECT has_permission($1) AS allowed`, [perm]);
  return !!allowed;
}

export async function opsRoutes(app: FastifyInstance): Promise<void> {
  // ── Service requests (post-sales) ───────────────────────────────────────
  const srToApi = (r: Record<string, unknown>) => ({ id: r.id, customerId: r.customer_id, bookingId: r.booking_id, category: r.category, description: r.description, status: r.status, assignedTo: r.assigned_to, resolvedAt: r.resolved_at, createdAt: r.created_at });

  app.get('/api/service-requests', { preHandler: requireAuth }, async (req, reply) =>
    withTenantContext(req.ctx, async (db) => {
      if (!await gate(db, 'view_service')) return reply.code(403).send({ error: 'Missing permission: view_service' });
      const { rows } = await db.query('SELECT * FROM service_requests ORDER BY created_at DESC');
      return { requests: rows.map(srToApi) };
    }),
  );

  app.post<{ Body: { customerId: string; bookingId?: string; category?: string; description?: string } }>(
    '/api/service-requests',
    {
      preHandler: requireAuth,
      schema: { body: { type: 'object', required: ['customerId'], additionalProperties: false, properties: {
        customerId: { type: 'string', pattern: UUID }, bookingId: { type: 'string', pattern: UUID },
        category: { type: 'string', enum: SR_CATEGORIES }, description: { type: 'string', maxLength: 2000 },
      } } },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'manage_service')) return reply.code(403).send({ error: 'Missing permission: manage_service' });
        const { rows: cust } = await db.query('SELECT id FROM customers WHERE id = $1', [req.body.customerId]);
        if (!cust[0]) return reply.code(404).send({ error: 'Customer not found' });
        const { rows } = await db.query(
          `INSERT INTO service_requests (tenant_id, customer_id, booking_id, category, description)
           VALUES (app_current_tenant(), $1, $2, $3, $4) RETURNING *`,
          [req.body.customerId, req.body.bookingId || null, req.body.category || 'other', req.body.description || '']);
        reply.code(201); return { request: srToApi(rows[0]) };
      }),
  );

  app.patch<{ Params: { id: string }; Body: { status?: string; assignedTo?: string } }>(
    '/api/service-requests/:id',
    {
      preHandler: requireAuth,
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: UUID } } },
        body: { type: 'object', minProperties: 1, additionalProperties: false, properties: { status: { type: 'string', enum: SR_STATUSES }, assignedTo: { type: 'string', pattern: UUID } } },
      },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'manage_service')) return reply.code(403).send({ error: 'Missing permission: manage_service' });
        // Closing/resolving stamps resolved_at; reopening clears it.
        const resolving = req.body.status === 'resolved' || req.body.status === 'closed';
        const { rows } = await db.query(
          `UPDATE service_requests SET
             status = COALESCE($1, status),
             assigned_to = COALESCE($2, assigned_to),
             resolved_at = CASE WHEN $1 IS NULL THEN resolved_at WHEN $3 THEN now() ELSE NULL END
           WHERE id = $4 RETURNING *`,
          [req.body.status || null, req.body.assignedTo || null, resolving, req.params.id]);
        if (!rows[0]) return reply.code(404).send({ error: 'Service request not found' });
        return { request: srToApi(rows[0]) };
      }),
  );

  // ── Cost centers ────────────────────────────────────────────────────────
  app.get('/api/cost-centers', { preHandler: requireAuth }, async (req, reply) =>
    withTenantContext(req.ctx, async (db) => {
      if (!await gate(db, 'view_finance')) return reply.code(403).send({ error: 'Missing permission: view_finance' });
      const { rows } = await db.query('SELECT * FROM cost_centers ORDER BY name');
      return { costCenters: rows.map(r => ({ id: r.id, projectId: r.project_id, name: r.name })) };
    }),
  );

  app.post<{ Body: { name: string; projectId?: string } }>(
    '/api/cost-centers',
    { preHandler: requireAuth, schema: { body: { type: 'object', required: ['name'], additionalProperties: false, properties: { name: { type: 'string', minLength: 1, maxLength: 120 }, projectId: { type: 'string', pattern: UUID } } } } },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'manage_finance')) return reply.code(403).send({ error: 'Missing permission: manage_finance' });
        const { rows } = await db.query('INSERT INTO cost_centers (tenant_id, project_id, name) VALUES (app_current_tenant(), $1, $2) RETURNING *', [req.body.projectId || null, req.body.name]);
        const r = rows[0];
        reply.code(201); return { costCenter: { id: r.id, projectId: r.project_id, name: r.name } };
      }),
  );

  // ── Budgets ─────────────────────────────────────────────────────────────
  const budgetToApi = (r: Record<string, unknown>) => ({ id: r.id, projectId: r.project_id, budgetCode: r.budget_code, category: r.category, fiscalYear: r.fiscal_year, allocatedAmount: num(r.allocated_amount), costCenterId: r.cost_center_id });

  app.get<{ Querystring: { projectId?: string } }>('/api/budgets', { preHandler: requireAuth }, async (req, reply) =>
    withTenantContext(req.ctx, async (db) => {
      if (!await gate(db, 'view_finance')) return reply.code(403).send({ error: 'Missing permission: view_finance' });
      const { rows } = req.query.projectId
        ? await db.query('SELECT * FROM budgets WHERE project_id = $1 ORDER BY category', [req.query.projectId])
        : await db.query('SELECT * FROM budgets ORDER BY category');
      return { budgets: rows.map(budgetToApi) };
    }),
  );

  app.post<{ Body: { projectId: string; category: string; allocatedAmount: number; budgetCode?: string; fiscalYear?: string; costCenterId?: string } }>(
    '/api/budgets',
    {
      preHandler: requireAuth,
      schema: { body: { type: 'object', required: ['projectId', 'category', 'allocatedAmount'], additionalProperties: false, properties: {
        projectId: { type: 'string', pattern: UUID }, category: { type: 'string', maxLength: 80 }, allocatedAmount: { type: 'number', minimum: 0 },
        budgetCode: { type: 'string', maxLength: 40 }, fiscalYear: { type: 'string', maxLength: 16 }, costCenterId: { type: 'string', pattern: UUID },
      } } },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'manage_finance')) return reply.code(403).send({ error: 'Missing permission: manage_finance' });
        const { rows: pr } = await db.query('SELECT id FROM projects WHERE id = $1', [req.body.projectId]);
        if (!pr[0]) return reply.code(404).send({ error: 'Project not found' });
        const { rows } = await db.query(
          `INSERT INTO budgets (tenant_id, project_id, budget_code, category, fiscal_year, allocated_amount, cost_center_id)
           VALUES (app_current_tenant(), $1, $2, $3, $4, $5, $6) RETURNING *`,
          [req.body.projectId, req.body.budgetCode || '', req.body.category, req.body.fiscalYear || '', req.body.allocatedAmount, req.body.costCenterId || null]);
        reply.code(201); return { budget: budgetToApi(rows[0]) };
      }),
  );

  /**
   * PUT /api/budgets — set the allocation for one (project, category) cell.
   * The Billing grid edits budgets that way: an amount of 0 clears the cell.
   */
  app.put<{ Body: { projectId: string; category: string; allocatedAmount: number; fiscalYear?: string } }>(
    '/api/budgets',
    {
      preHandler: requireAuth,
      schema: { body: { type: 'object', required: ['projectId', 'category', 'allocatedAmount'], additionalProperties: false, properties: {
        projectId: { type: 'string', pattern: UUID }, category: { type: 'string', maxLength: 80 },
        allocatedAmount: { type: 'number', minimum: 0 }, fiscalYear: { type: 'string', maxLength: 16 },
      } } },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'manage_finance')) return reply.code(403).send({ error: 'Missing permission: manage_finance' });
        const { rows: pr } = await db.query('SELECT id FROM projects WHERE id = $1', [req.body.projectId]);
        if (!pr[0]) return reply.code(404).send({ error: 'Project not found' });

        if (req.body.allocatedAmount <= 0) {
          await db.query('DELETE FROM budgets WHERE project_id = $1 AND category = $2', [req.body.projectId, req.body.category]);
          return { budget: null };
        }
        const { rows: existing } = await db.query('SELECT id FROM budgets WHERE project_id = $1 AND category = $2 LIMIT 1', [req.body.projectId, req.body.category]);
        const { rows } = existing[0]
          ? await db.query('UPDATE budgets SET allocated_amount = $1 WHERE id = $2 RETURNING *', [req.body.allocatedAmount, existing[0].id])
          : await db.query(
              `INSERT INTO budgets (tenant_id, project_id, category, fiscal_year, allocated_amount)
               VALUES (app_current_tenant(), $1, $2, $3, $4) RETURNING *`,
              [req.body.projectId, req.body.category, req.body.fiscalYear || '', req.body.allocatedAmount]);
        return { budget: budgetToApi(rows[0]) };
      }),
  );
}
