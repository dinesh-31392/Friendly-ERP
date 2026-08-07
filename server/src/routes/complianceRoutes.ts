import type { FastifyInstance } from 'fastify';
import { withTenantContext } from '../db.js';
import { requireAuth } from '../auth.js';

/**
 * Statutory compliance filings (GST/RERA/TDS/PF-ESI). Table added in migration
 * 018. Gated on view_accounts / manage_accounts (finance domain).
 */

const UUID = '^[0-9a-fA-F-]{36}$';
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
async function gate(db: import('pg').PoolClient, perm: string): Promise<boolean> {
  const { rows: [{ allowed }] } = await db.query(`SELECT has_permission($1) AS allowed`, [perm]);
  return !!allowed;
}
const toApi = (r: Record<string, unknown>) => ({
  id: r.id, title: r.title, authority: r.authority, dueDate: r.due_date, frequency: r.frequency,
  projectId: r.project_id, amount: num(r.amount), notes: r.notes, status: r.status,
  filedAt: r.filed_at, filedBy: r.filed_by, paidAt: r.paid_at,
});

export async function complianceRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/compliance-items', { preHandler: requireAuth }, async (req, reply) =>
    withTenantContext(req.ctx, async (db) => {
      if (!await gate(db, 'view_accounts')) return reply.code(403).send({ error: 'Missing permission: view_accounts' });
      const { rows } = await db.query('SELECT * FROM compliance_items ORDER BY due_date');
      return { items: rows.map(toApi) };
    }),
  );

  app.post<{ Body: { title: string; authority?: string; dueDate: string; frequency?: string; projectId?: string; amount?: number; notes?: string } }>(
    '/api/compliance-items',
    {
      preHandler: requireAuth,
      schema: { body: { type: 'object', required: ['title', 'dueDate'], additionalProperties: false, properties: {
        title: { type: 'string', minLength: 1, maxLength: 200 }, authority: { type: 'string', maxLength: 80 }, dueDate: { type: 'string' },
        frequency: { type: 'string', enum: ['one_time', 'monthly', 'quarterly', 'annual'] }, projectId: { type: 'string', pattern: UUID }, amount: { type: 'number', minimum: 0 }, notes: { type: 'string', maxLength: 1000 },
      } } },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'manage_accounts')) return reply.code(403).send({ error: 'Missing permission: manage_accounts' });
        const b = req.body;
        const { rows } = await db.query(
          `INSERT INTO compliance_items (tenant_id, title, authority, due_date, frequency, project_id, amount, notes)
           VALUES (app_current_tenant(), $1,$2,$3,$4,$5,$6,$7) RETURNING *`,
          [b.title, b.authority || '', b.dueDate, b.frequency || 'one_time', b.projectId || null, b.amount ?? null, b.notes || null]);
        reply.code(201); return { item: toApi(rows[0]) };
      }),
  );

  /** PATCH — mark filed / paid; stamps filed_at + filer, or paid_at. */
  app.patch<{ Params: { id: string }; Body: { status: string } }>(
    '/api/compliance-items/:id',
    {
      preHandler: requireAuth,
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: UUID } } },
        body: { type: 'object', required: ['status'], additionalProperties: false, properties: { status: { type: 'string', enum: ['pending', 'filed', 'paid'] } } },
      },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'manage_accounts')) return reply.code(403).send({ error: 'Missing permission: manage_accounts' });
        const filed = req.body.status === 'filed' || req.body.status === 'paid';
        const paid = req.body.status === 'paid';
        const { rows } = await db.query(
          `UPDATE compliance_items SET status = $1,
             filed_at = CASE WHEN $2 THEN COALESCE(filed_at, now()) ELSE NULL END,
             filed_by = CASE WHEN $2 THEN COALESCE(filed_by, $3::uuid) ELSE NULL END,
             paid_at  = CASE WHEN $4 THEN now() ELSE NULL END
           WHERE id = $5 RETURNING *`,
          [req.body.status, filed, req.ctx.userId || null, paid, req.params.id]);
        if (!rows[0]) return reply.code(404).send({ error: 'Compliance item not found' });
        return { item: toApi(rows[0]) };
      }),
  );

  app.delete<{ Params: { id: string } }>(
    '/api/compliance-items/:id',
    { preHandler: requireAuth, schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: UUID } } } } },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'manage_accounts')) return reply.code(403).send({ error: 'Missing permission: manage_accounts' });
        const { rowCount } = await db.query('DELETE FROM compliance_items WHERE id = $1', [req.params.id]);
        if (!rowCount) return reply.code(404).send({ error: 'Compliance item not found' });
        reply.code(204); return null;
      }),
  );
}
