import type { FastifyInstance } from 'fastify';
import { withTenantContext } from '../db.js';
import { requireAuth } from '../auth.js';

const UUID = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

const PRIORITIES = ['high', 'medium', 'low'] as const;
const STATUSES = ['open', 'in_progress', 'resolved', 'closed'] as const;

/** DB row → the SPA's `Ticket` shape. lead_id/assigned_to are stored as loose
 *  text ids; an empty lead_id surfaces as undefined (the field is optional). */
function toApiTicket(r: Record<string, unknown>) {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    title: r.title,
    leadId: (r.lead_id as string) || undefined,
    customer: r.customer ?? '',
    project: r.project ?? '',
    category: r.category ?? 'Other',
    priority: r.priority,
    status: r.status,
    assignedTo: (r.assigned_to as string) ?? '',
    createdAt: r.created_at,
  };
}

const WRITABLE: Record<string, string> = {
  title: 'title',
  leadId: 'lead_id',
  customer: 'customer',
  project: 'project',
  category: 'category',
  priority: 'priority',
  status: 'status',
  assignedTo: 'assigned_to',
};

const PROPS = {
  title: { type: 'string', minLength: 1, maxLength: 300 },
  leadId: { type: 'string', maxLength: 64 },
  customer: { type: 'string', maxLength: 200 },
  project: { type: 'string', maxLength: 200 },
  category: { type: 'string', maxLength: 60 },
  priority: { type: 'string', enum: PRIORITIES as unknown as string[] },
  status: { type: 'string', enum: STATUSES as unknown as string[] },
  assignedTo: { type: 'string', maxLength: 64 },
} as const;

interface TicketBody {
  title?: string; leadId?: string; customer?: string; project?: string;
  category?: string; priority?: string; status?: string; assignedTo?: string;
}

function mapWriteError(err: unknown): { error: string } | null {
  switch ((err as { code?: string })?.code) {
    case '23514': return { error: `Invalid value — priority must be one of ${PRIORITIES.join(', ')} and status one of ${STATUSES.join(', ')}.` };
    case '23502': return { error: 'A required field is missing.' };
    case '22P02': return { error: 'A field has an invalid format.' };
    default: return null;
  }
}

function collectWrites(body: TicketBody) {
  const cols: string[] = [];
  const exprs: string[] = [];
  const params: unknown[] = [];
  for (const [key, col] of Object.entries(WRITABLE)) {
    if (body[key as keyof TicketBody] === undefined) continue;
    params.push(body[key as keyof TicketBody]);
    cols.push(col);
    exprs.push(`$${params.length}`);
  }
  return { cols, exprs, params };
}

export async function serviceRoutes(app: FastifyInstance): Promise<void> {
  /** GET /api/tickets — RLS-scoped; view_service gates access. */
  app.get('/api/tickets', { preHandler: requireAuth }, async (req, reply) =>
    withTenantContext(req.ctx, async (db) => {
      const { rows: [{ allowed }] } = await db.query(`SELECT has_permission('view_service') AS allowed`);
      if (!allowed) return reply.code(403).send({ error: 'Missing permission: view_service' });
      const { rows } = await db.query('SELECT * FROM service_tickets ORDER BY created_at DESC');
      return { tickets: rows.map(toApiTicket) };
    }),
  );

  /** POST /api/tickets — raise a ticket. */
  app.post<{ Body: TicketBody }>(
    '/api/tickets',
    { preHandler: requireAuth, schema: { body: { type: 'object', required: ['title'], additionalProperties: false, properties: PROPS } } },
    async (req, reply) => {
      try {
        return await withTenantContext(req.ctx, async (db) => {
          const { rows: [{ allowed }] } = await db.query(`SELECT has_permission('manage_service') AS allowed`);
          if (!allowed) return reply.code(403).send({ error: 'Missing permission: manage_service' });
          const { cols, exprs, params } = collectWrites(req.body);
          const { rows } = await db.query(
            `INSERT INTO service_tickets (tenant_id${cols.length ? ', ' + cols.join(', ') : ''})
             VALUES (app_current_tenant()${exprs.length ? ', ' + exprs.join(', ') : ''}) RETURNING *`,
            params,
          );
          reply.code(201); return { ticket: toApiTicket(rows[0]) };
        });
      } catch (err) {
        const mapped = mapWriteError(err);
        if (mapped) return reply.code(400).send(mapped);
        throw err;
      }
    },
  );

  /** PATCH /api/tickets/:id — change status / reassign / edit. */
  app.patch<{ Params: { id: string }; Body: TicketBody }>(
    '/api/tickets/:id',
    {
      preHandler: requireAuth,
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: UUID } } },
        body: { type: 'object', minProperties: 1, additionalProperties: false, properties: PROPS },
      },
    },
    async (req, reply) => {
      try {
        return await withTenantContext(req.ctx, async (db) => {
          const { rows: [{ allowed }] } = await db.query(`SELECT has_permission('manage_service') AS allowed`);
          if (!allowed) return reply.code(403).send({ error: 'Missing permission: manage_service' });
          const { rows: found } = await db.query('SELECT 1 FROM service_tickets WHERE id = $1', [req.params.id]);
          if (found.length === 0) return reply.code(404).send({ error: 'Ticket not found' });
          const { cols, exprs, params } = collectWrites(req.body);
          if (cols.length === 0) return reply.code(400).send({ error: 'No writable fields supplied' });
          const sets = cols.map((c, i) => `${c} = ${exprs[i]}`);
          params.push(req.params.id);
          const { rows } = await db.query(`UPDATE service_tickets SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`, params);
          return { ticket: toApiTicket(rows[0]) };
        });
      } catch (err) {
        const mapped = mapWriteError(err);
        if (mapped) return reply.code(400).send(mapped);
        throw err;
      }
    },
  );

  /** DELETE /api/tickets/:id */
  app.delete<{ Params: { id: string } }>(
    '/api/tickets/:id',
    { preHandler: requireAuth, schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: UUID } } } } },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        const { rows: [{ allowed }] } = await db.query(`SELECT has_permission('manage_service') AS allowed`);
        if (!allowed) return reply.code(403).send({ error: 'Missing permission: manage_service' });
        const { rowCount } = await db.query('DELETE FROM service_tickets WHERE id = $1', [req.params.id]);
        if (!rowCount) return reply.code(404).send({ error: 'Ticket not found' });
        reply.code(204); return null;
      }),
  );
}
