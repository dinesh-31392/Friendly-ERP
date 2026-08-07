import type { FastifyInstance } from 'fastify';
import { withTenantContext } from '../db.js';
import { requireAuth } from '../auth.js';

const UUID = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

const STATUSES = ['active', 'inactive'] as const;

/**
 * DB row → the SPA's `Broker` shape. Renames: agency_name↔firm, rera_id↔reraId.
 * The DB stores a commission_structure jsonb ({type,value}); the SPA carries a
 * flat percentage `commissionRate`, so we read/write `.value`.
 *   leadsReferred / bookingsClosed are NOT stored — they are DERIVED live from
 * the attribution link (leads.broker_id, added in migration 011) and its
 * bookings, so the counters can never drift from reality.
 */
function toApiBroker(r: Record<string, unknown>) {
  const cs = (r.commission_structure as { value?: number } | null) ?? {};
  return {
    id: r.id,
    tenantId: r.tenant_id,
    name: r.name,
    firm: r.agency_name ?? '',
    phone: r.phone ?? '',
    email: r.email ?? '',
    reraId: r.rera_id ?? '',
    commissionRate: Number(cs.value) || 0,
    leadsReferred: Number(r.leads_referred) || 0,
    bookingsClosed: Number(r.bookings_closed) || 0,
    status: r.status,
    createdAt: r.created_at,
  };
}

// scalar camelCase → column. commissionRate is folded into the
// commission_structure jsonb; the counters are derived, never written.
const WRITABLE: Record<string, string> = {
  name: 'name',
  firm: 'agency_name',
  phone: 'phone',
  email: 'email',
  reraId: 'rera_id',
  status: 'status',
};

const PROPS = {
  name: { type: 'string', minLength: 1, maxLength: 200 },
  firm: { type: 'string', maxLength: 200 },
  phone: { type: 'string', maxLength: 32 },
  email: { type: 'string', maxLength: 254 },
  reraId: { type: 'string', maxLength: 64 },
  commissionRate: { type: 'number', minimum: 0, maximum: 100 },
  status: { type: 'string', enum: STATUSES as unknown as string[] },
} as const;

interface BrokerBody {
  name?: string; firm?: string; phone?: string; email?: string;
  reraId?: string; commissionRate?: number; status?: string;
}

// Counters derived from the attribution link; computed, never stored.
const SELECT = `SELECT b.*,
  (SELECT count(*)::int FROM leads l WHERE l.broker_id = b.id) AS leads_referred,
  (SELECT count(*)::int FROM bookings bk JOIN leads l2 ON l2.id = bk.lead_id
     WHERE l2.broker_id = b.id) AS bookings_closed
  FROM brokers b`;

function mapWriteError(err: unknown): { error: string } | null {
  switch ((err as { code?: string })?.code) {
    case '23514': return { error: `Invalid status — must be one of: ${STATUSES.join(', ')}.` };
    case '23502': return { error: 'A required field is missing.' };
    case '22P02': return { error: 'A field has an invalid format.' };
    case '23505': return { error: 'A broker with these values already exists.' };
    default: return null;
  }
}

/** Scalar writes + the commission_structure jsonb built from commissionRate. */
function collectWrites(body: BrokerBody) {
  const cols: string[] = [];
  const exprs: string[] = [];
  const params: unknown[] = [];
  const add = (col: string, value: unknown, cast = '') => {
    params.push(value);
    cols.push(col);
    exprs.push(`$${params.length}${cast}`);
  };
  for (const [key, col] of Object.entries(WRITABLE)) {
    if (body[key as keyof BrokerBody] === undefined) continue;
    add(col, body[key as keyof BrokerBody]);
  }
  if (body.commissionRate !== undefined) {
    add('commission_structure', JSON.stringify({ type: 'percentage', value: body.commissionRate }), '::jsonb');
  }
  return { cols, exprs, params };
}

export async function brokersRoutes(app: FastifyInstance): Promise<void> {
  /** GET /api/brokers — RLS-scoped; view_brokers gates access. */
  app.get('/api/brokers', { preHandler: requireAuth }, async (req, reply) =>
    withTenantContext(req.ctx, async (db) => {
      const { rows: [{ allowed }] } = await db.query(`SELECT has_permission('view_brokers') AS allowed`);
      if (!allowed) return reply.code(403).send({ error: 'Missing permission: view_brokers' });
      const { rows } = await db.query(`${SELECT} ORDER BY bookings_closed DESC, b.created_at DESC`);
      return { brokers: rows.map(toApiBroker) };
    }),
  );

  /** POST /api/brokers — onboard a channel partner. */
  app.post<{ Body: BrokerBody }>(
    '/api/brokers',
    { preHandler: requireAuth, schema: { body: { type: 'object', required: ['name'], additionalProperties: false, properties: PROPS } } },
    async (req, reply) => {
      try {
        return await withTenantContext(req.ctx, async (db) => {
          const { rows: [{ allowed }] } = await db.query(`SELECT has_permission('manage_brokers') AS allowed`);
          if (!allowed) return reply.code(403).send({ error: 'Missing permission: manage_brokers' });
          const { cols, exprs, params } = collectWrites(req.body);
          const { rows } = await db.query(
            `WITH ins AS (
               INSERT INTO brokers (tenant_id${cols.length ? ', ' + cols.join(', ') : ''})
               VALUES (app_current_tenant()${exprs.length ? ', ' + exprs.join(', ') : ''})
               RETURNING *
             )
             ${SELECT.replace('FROM brokers b', 'FROM ins b')}`,
            params,
          );
          reply.code(201); return { broker: toApiBroker(rows[0]) };
        });
      } catch (err) {
        const mapped = mapWriteError(err);
        if (mapped) return reply.code(400).send(mapped);
        throw err;
      }
    },
  );

  /** PATCH /api/brokers/:id — edit / activate-deactivate. */
  app.patch<{ Params: { id: string }; Body: BrokerBody }>(
    '/api/brokers/:id',
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
          const { rows: [{ allowed }] } = await db.query(`SELECT has_permission('manage_brokers') AS allowed`);
          if (!allowed) return reply.code(403).send({ error: 'Missing permission: manage_brokers' });
          const { rows: found } = await db.query('SELECT 1 FROM brokers WHERE id = $1', [req.params.id]);
          if (found.length === 0) return reply.code(404).send({ error: 'Broker not found' });
          const { cols, exprs, params } = collectWrites(req.body);
          if (cols.length === 0) return reply.code(400).send({ error: 'No writable fields supplied' });
          const sets = cols.map((c, i) => `${c} = ${exprs[i]}`);
          params.push(req.params.id);
          const { rows } = await db.query(
            `WITH upd AS (
               UPDATE brokers SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *
             )
             ${SELECT.replace('FROM brokers b', 'FROM upd b')}`,
            params,
          );
          return { broker: toApiBroker(rows[0]) };
        });
      } catch (err) {
        const mapped = mapWriteError(err);
        if (mapped) return reply.code(400).send(mapped);
        throw err;
      }
    },
  );

  /** DELETE /api/brokers/:id — leads.broker_id SET NULL via the FK (011). */
  app.delete<{ Params: { id: string } }>(
    '/api/brokers/:id',
    { preHandler: requireAuth, schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: UUID } } } } },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        const { rows: [{ allowed }] } = await db.query(`SELECT has_permission('manage_brokers') AS allowed`);
        if (!allowed) return reply.code(403).send({ error: 'Missing permission: manage_brokers' });
        const { rowCount } = await db.query('DELETE FROM brokers WHERE id = $1', [req.params.id]);
        if (!rowCount) return reply.code(404).send({ error: 'Broker not found' });
        reply.code(204); return null;
      }),
  );
}
