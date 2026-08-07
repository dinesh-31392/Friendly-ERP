import type { FastifyInstance } from 'fastify';
import { withTenantContext } from '../db.js';
import { requireAuth } from '../auth.js';

const UUID = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

const STAGES = ['reservation', 'token', 'agreement', 'payment', 'completed'] as const;

/**
 * DB row → the SPA's `Booking` shape. The two diverge on names and on a couple
 * of derived/omitted fields:
 *   - amount ↔ booking_amount (the token), value ↔ total_consideration;
 *   - `projectId` is not stored on bookings — it is derived by joining the
 *     unit (see the LEFT JOIN in the SELECT);
 *   - the DB also carries a legal `status` (active/cancelled/…) which the SPA
 *     Booking doesn't model — the SPA cancels by DELETE, so live rows are always
 *     `active` here and `status` is intentionally not surfaced.
 *
 * NOTE — scope: this route owns the bookings row + (via the SPA) the unit/lead
 * couplings through the already-server-backed units/leads APIs. The financial
 * satellites a booking spawns (payment schedule, token invoice, broker
 * commission) still live in the localStorage store until their own modules are
 * cut over; the SPA writes those there in both modes.
 */
function toApiBooking(r: Record<string, unknown>) {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    projectId: r.project_id ?? undefined,
    leadId: r.lead_id,
    unitId: r.unit_id,
    amount: Number(r.booking_amount) || 0,
    value: Number(r.total_consideration) || 0,
    paymentPlan: r.payment_plan ?? '',
    stage: r.stage,
    cancelRequested: r.cancel_requested ?? false,
    createdAt: r.booked_at,
  };
}

// camelCase → column. lead_id/unit_id are create-only; tenant_id/created_by/
// booked_at are owned by the DB and never accepted from the client.
const WRITABLE: Record<string, string> = {
  amount: 'booking_amount',
  value: 'total_consideration',
  paymentPlan: 'payment_plan',
  stage: 'stage',
  cancelRequested: 'cancel_requested',
};

const SCALAR_PROPS = {
  amount: { type: 'number', minimum: 0, maximum: 1e12 },
  value: { type: 'number', minimum: 0, maximum: 1e12 },
  paymentPlan: { type: 'string', maxLength: 60 },
  stage: { type: 'string', enum: STAGES as unknown as string[] },
  cancelRequested: { type: 'boolean' },
} as const;

interface BookingBody {
  leadId?: string; unitId?: string; amount?: number; value?: number;
  paymentPlan?: string; stage?: string; cancelRequested?: boolean;
}

// projectId is the unit's project — derived, never stored on the booking.
const SELECT = `SELECT b.*, u.project_id AS project_id
  FROM bookings b LEFT JOIN units u ON u.id = b.unit_id`;

/** Constraint violations these routes can provoke → 4xx client errors. */
function mapWriteError(err: unknown): { error: string } | null {
  switch ((err as { code?: string })?.code) {
    case '23505': return { error: 'That unit already has an active booking.' };
    case '23503': return { error: 'The referenced lead or unit does not exist.' };
    case '23514': return { error: `Invalid stage — must be one of: ${STAGES.join(', ')}.` };
    case '23502': return { error: 'A required field is missing.' };
    case '22P02': return { error: 'A field has an invalid format.' };
    default: return null;
  }
}

/** Writable columns/placeholders/params shared by INSERT and UPDATE. */
function collectWrites(body: BookingBody) {
  const cols: string[] = [];
  const exprs: string[] = [];
  const params: unknown[] = [];
  for (const [key, col] of Object.entries(WRITABLE)) {
    if (body[key as keyof BookingBody] === undefined) continue;
    params.push(body[key as keyof BookingBody]);
    cols.push(col);
    exprs.push(`$${params.length}`);
  }
  return { cols, exprs, params };
}

export async function bookingsRoutes(app: FastifyInstance): Promise<void> {
  /** GET /api/bookings — RLS-scoped; view_bookings gates access. */
  app.get('/api/bookings', { preHandler: requireAuth }, async (req, reply) =>
    withTenantContext(req.ctx, async (db) => {
      const { rows: [{ allowed }] } = await db.query(`SELECT has_permission('view_bookings') AS allowed`);
      if (!allowed) return reply.code(403).send({ error: 'Missing permission: view_bookings' });
      const { rows } = await db.query(`${SELECT} ORDER BY b.booked_at DESC`);
      return { bookings: rows.map(toApiBooking) };
    }),
  );

  /** POST /api/bookings — create. The partial unique index on units (active/
   *  completed) is the real double-booking guard: a second active booking for
   *  the same unit fails with 23505 → 400. */
  app.post<{ Body: BookingBody }>(
    '/api/bookings',
    {
      preHandler: requireAuth,
      schema: {
        body: {
          type: 'object', required: ['leadId', 'unitId'], additionalProperties: false,
          properties: {
            leadId: { type: 'string', pattern: UUID },
            unitId: { type: 'string', pattern: UUID },
            ...SCALAR_PROPS,
          },
        },
      },
    },
    async (req, reply) => {
      try {
        return await withTenantContext(req.ctx, async (db) => {
          const { rows: [{ allowed }] } = await db.query(
            `SELECT (has_permission('create_bookings') OR has_permission('manage_bookings')) AS allowed`,
          );
          if (!allowed) return reply.code(403).send({ error: 'Missing permission: create_bookings' });

          const { cols, exprs, params } = collectWrites(req.body);
          // lead_id, unit_id, created_by are appended after the writable scalars.
          params.push(req.body.leadId, req.body.unitId);
          const leadPh = `$${params.length - 1}`;
          const unitPh = `$${params.length}`;
          const { rows } = await db.query(
            `WITH ins AS (
               INSERT INTO bookings (tenant_id, lead_id, unit_id, created_by${cols.length ? ', ' + cols.join(', ') : ''})
               VALUES (app_current_tenant(), ${leadPh}, ${unitPh}, app_current_user()${exprs.length ? ', ' + exprs.join(', ') : ''})
               RETURNING *
             )
             ${SELECT.replace('FROM bookings b', 'FROM ins b')}`,
            params,
          );
          reply.code(201); return { booking: toApiBooking(rows[0]) };
        });
      } catch (err) {
        const mapped = mapWriteError(err);
        if (mapped) return reply.code(400).send(mapped);
        throw err;
      }
    },
  );

  /** PATCH /api/bookings/:id — advance the sales stage, or set/clear a cancel
   *  request. (The unit → sold/available side-effect is applied by the SPA
   *  through the units API.) */
  app.patch<{ Params: { id: string }; Body: BookingBody }>(
    '/api/bookings/:id',
    {
      preHandler: requireAuth,
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: UUID } } },
        body: { type: 'object', minProperties: 1, additionalProperties: false, properties: SCALAR_PROPS },
      },
    },
    async (req, reply) => {
      try {
        return await withTenantContext(req.ctx, async (db) => {
          const { rows: [{ allowed }] } = await db.query(`SELECT has_permission('manage_bookings') AS allowed`);
          if (!allowed) return reply.code(403).send({ error: 'Missing permission: manage_bookings' });
          const { rows: found } = await db.query('SELECT 1 FROM bookings WHERE id = $1', [req.params.id]);
          if (found.length === 0) return reply.code(404).send({ error: 'Booking not found' });

          const { cols, exprs, params } = collectWrites(req.body);
          if (cols.length === 0) return reply.code(400).send({ error: 'No writable fields supplied' });
          const sets = cols.map((c, i) => `${c} = ${exprs[i]}`);
          params.push(req.params.id);
          const { rows } = await db.query(
            `WITH upd AS (
               UPDATE bookings SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *
             )
             ${SELECT.replace('FROM bookings b', 'FROM upd b')}`,
            params,
          );
          return { booking: toApiBooking(rows[0]) };
        });
      } catch (err) {
        const mapped = mapWriteError(err);
        if (mapped) return reply.code(400).send(mapped);
        throw err;
      }
    },
  );

  /** DELETE /api/bookings/:id — cancel (SPA semantics are a hard delete, which
   *  frees the unit for rebooking via the partial unique index). */
  app.delete<{ Params: { id: string } }>(
    '/api/bookings/:id',
    { preHandler: requireAuth, schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: UUID } } } } },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        const { rows: [{ allowed }] } = await db.query(`SELECT has_permission('manage_bookings') AS allowed`);
        if (!allowed) return reply.code(403).send({ error: 'Missing permission: manage_bookings' });
        const { rowCount } = await db.query('DELETE FROM bookings WHERE id = $1', [req.params.id]);
        if (!rowCount) return reply.code(404).send({ error: 'Booking not found' });
        reply.code(204); return null;
      }),
  );
}
