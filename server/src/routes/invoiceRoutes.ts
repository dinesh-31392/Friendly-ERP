import type { FastifyInstance } from 'fastify';
import { withTenantContext } from '../db.js';
import { requireAuth } from '../auth.js';
import { PAGE_QUERY, readPage, keysetWhere, takePage } from '../pagination.js';

/**
 * Invoices (migration 030) and the tenant audit trail.
 *
 * Billing raised invoices into localStorage: a booking's token invoice existed
 * on one salesperson's laptop and finance never saw it. These are the endpoints
 * that were missing, not a new feature.
 *
 * The audit read lives here because it is the same audience — the people who
 * need the money trail are the people who need the change trail.
 */

const UUID = '^[0-9a-fA-F-]{36}$';

async function gate(db: import('pg').PoolClient, perm: string): Promise<boolean> {
  const { rows: [{ allowed }] } = await db.query(`SELECT has_permission($1) AS allowed`, [perm]);
  return !!allowed;
}

const toApiInvoice = (r: Record<string, unknown>) => ({
  id: r.id, tenantId: r.tenant_id, leadId: r.lead_id ?? '', bookingId: r.booking_id ?? undefined,
  leadName: r.lead_name, project: r.project, type: r.type,
  amount: Number(r.amount) || 0,
  date: r.issue_date, dueDate: r.due_date, status: r.status,
});

const PROPS = {
  leadId: { type: 'string', pattern: UUID },
  bookingId: { type: 'string', pattern: UUID },
  leadName: { type: 'string', maxLength: 160 },
  project: { type: 'string', maxLength: 160 },
  type: { type: 'string', maxLength: 60 },
  amount: { type: 'number', minimum: 0 },
  date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}' },
  dueDate: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}' },
  status: { type: 'string', enum: ['Paid', 'Pending', 'Generated', 'Overdue'] },
} as const;

export async function invoiceRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { limit?: number; cursor?: string } }>(
    '/api/invoices',
    { preHandler: requireAuth, schema: { querystring: { type: 'object', properties: PAGE_QUERY } } },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'view_invoices') && !await gate(db, 'view_finance')) {
          return reply.code(403).send({ error: 'Missing permission: view_invoices' });
        }
        // Ordered by created_at, not issue_date: the keyset needs a column that
        // never moves, and an invoice's issue date can be corrected after the
        // fact — which would slide a row across a page boundary and either
        // duplicate it or skip it.
        const page = readPage(req.query);
        const ks = keysetWhere(page, 'created_at', 'id', 1);
        const { rows } = await db.query(
          `SELECT * FROM invoices
            ${ks.sql ? `WHERE ${ks.sql}` : ''}
            ORDER BY created_at DESC, id DESC
            LIMIT ${page.limit + 1}`,
          ks.params);
        const out = takePage(rows, page, 'created_at');
        return { invoices: out.rows.map(toApiInvoice), nextCursor: out.nextCursor };
      }),
  );

  app.post<{ Body: Record<string, unknown> }>(
    '/api/invoices',
    {
      preHandler: requireAuth,
      schema: { body: { type: 'object', required: ['amount'], additionalProperties: false, properties: PROPS } },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'manage_invoices') && !await gate(db, 'manage_finance')) {
          return reply.code(403).send({ error: 'Missing permission: manage_invoices' });
        }
        const b = req.body as Record<string, string | number | undefined>;
        const { rows } = await db.query(
          `INSERT INTO invoices (tenant_id, lead_id, booking_id, lead_name, project, type, amount, issue_date, due_date, status, created_by)
           VALUES (app_current_tenant(), $1,$2,$3,$4,$5,$6, COALESCE($7::date, CURRENT_DATE), $8, COALESCE($9,'Pending'), app_current_user())
           RETURNING *`,
          [b.leadId ?? null, b.bookingId ?? null, b.leadName ?? '', b.project ?? '',
           b.type ?? 'Booking Token', b.amount ?? 0, b.date ?? null, b.dueDate ?? null, b.status ?? null]);
        reply.code(201); return { invoice: toApiInvoice(rows[0]) };
      }),
  );

  app.patch<{ Params: { id: string }; Body: Record<string, unknown> }>(
    '/api/invoices/:id',
    {
      preHandler: requireAuth,
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: UUID } } },
        body: { type: 'object', minProperties: 1, additionalProperties: false, properties: PROPS },
      },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'manage_invoices') && !await gate(db, 'manage_finance')) {
          return reply.code(403).send({ error: 'Missing permission: manage_invoices' });
        }
        // Column names come from this fixed map, never from the request body.
        const COLS: Record<string, string> = {
          leadName: 'lead_name', project: 'project', type: 'type', amount: 'amount',
          date: 'issue_date', dueDate: 'due_date', status: 'status', leadId: 'lead_id', bookingId: 'booking_id',
        };
        const sets: string[] = []; const params: unknown[] = [];
        for (const [k, col] of Object.entries(COLS)) {
          const v = (req.body as Record<string, unknown>)[k];
          if (v !== undefined) { params.push(v); sets.push(`${col} = $${params.length}`); }
        }
        if (!sets.length) return reply.code(400).send({ error: 'No writable fields supplied' });
        params.push(req.params.id);
        const { rows } = await db.query(
          `UPDATE invoices SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`, params);
        if (!rows[0]) return reply.code(404).send({ error: 'Invoice not found' });
        return { invoice: toApiInvoice(rows[0]) };
      }),
  );

  app.delete<{ Params: { id: string } }>(
    '/api/invoices/:id',
    {
      preHandler: requireAuth,
      schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: UUID } } } },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'manage_invoices') && !await gate(db, 'manage_finance')) {
          return reply.code(403).send({ error: 'Missing permission: manage_invoices' });
        }
        const { rowCount } = await db.query(`DELETE FROM invoices WHERE id = $1`, [req.params.id]);
        if (!rowCount) return reply.code(404).send({ error: 'Invoice not found' });
        reply.code(204); return null;
      }),
  );

  /**
   * GET /api/audit-logs — the tenant's own change history.
   *
   * The table is append-only and written by database triggers, so this is
   * read-only by construction; there is deliberately no write endpoint. RLS
   * scopes it to the caller's tenant, and `view_audit_log` gates it on top,
   * because "who changed this price" is not something every role should see.
   */
  app.get<{ Querystring: { limit?: number; entity?: string } }>(
    '/api/audit-logs',
    {
      preHandler: requireAuth,
      schema: { querystring: { type: 'object', additionalProperties: false, properties: {
        limit: { type: 'integer', minimum: 1, maximum: 500 },
        entity: { type: 'string', maxLength: 60 },
      } } },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'view_audit_log')) return reply.code(403).send({ error: 'Missing permission: view_audit_log' });
        const limit = req.query.limit ?? 200;
        const { rows } = req.query.entity
          ? await db.query(
              `SELECT * FROM audit_logs WHERE table_name = $1 ORDER BY created_at DESC LIMIT $2`,
              [req.query.entity, limit])
          : await db.query(`SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT $1`, [limit]);
        return {
          auditLogs: rows.map(r => ({
            id: r.id, tenantId: r.tenant_id, userId: r.actor_id,
            action: r.action, entity: r.table_name, entityId: r.record_id,
            previousState: r.previous_state ?? null, newState: r.new_state ?? null,
            ip: r.ip_address,
            createdAt: r.created_at,
          })),
        };
      }),
  );
}
