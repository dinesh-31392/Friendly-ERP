import type { FastifyInstance } from 'fastify';
import { withTenantContext } from '../db.js';
import { requireAuth } from '../auth.js';

/**
 * Payments & collections — server persistence for the payment schedule (one row
 * per installment) and receipts collected against it. Previously localStorage-
 * only; this makes collections real multi-tenant SaaS (RLS + RBAC + audit).
 *
 * The SPA's `demanded` installment status maps to the DB's `invoiced` (a demand
 * letter / invoice has been raised); we translate at the boundary so the client
 * model is unchanged.
 */

const UUID = '^[0-9a-fA-F-]{36}$';

function statusToApi(dbStatus: string): string {
  return dbStatus === 'invoiced' ? 'demanded' : dbStatus;
}
function statusToDb(apiStatus: string): string {
  return apiStatus === 'demanded' ? 'invoiced' : apiStatus;
}

function scheduleToApi(r: Record<string, unknown>) {
  return {
    id: r.id, bookingId: r.booking_id,
    number: r.sequence, milestoneName: r.milestone_name,
    percentage: Number(r.percentage), amount: Number(r.amount),
    dueDate: r.due_date, status: statusToApi(r.status as string),
    trigger: r.trigger_type === 'construction_milestone' ? 'construction_milestone' : 'time',
  };
}

interface ScheduleRow { milestoneName: string; sequence: number; percentage?: number; amount: number; dueDate?: string; trigger?: string; status?: string }

export async function paymentsRoutes(app: FastifyInstance): Promise<void> {
  /** GET /api/payment-schedules?bookingId= — the installment schedule. */
  app.get<{ Querystring: { bookingId?: string } }>(
    '/api/payment-schedules',
    { preHandler: requireAuth },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        const { rows: [{ allowed }] } = await db.query(`SELECT has_permission('view_bookings') AS allowed`);
        if (!allowed) return reply.code(403).send({ error: 'Missing permission: view_bookings' });
        const bookingId = req.query.bookingId;
        const { rows } = bookingId
          ? await db.query('SELECT * FROM payment_schedules WHERE booking_id = $1 ORDER BY sequence', [bookingId])
          : await db.query('SELECT * FROM payment_schedules ORDER BY booking_id, sequence');
        return { schedules: rows.map(scheduleToApi) };
      }),
  );

  /**
   * POST /api/payment-schedules — create the full schedule for a booking
   * (array of installments). Replaces any existing rows for the booking.
   */
  app.post<{ Body: { bookingId: string; installments: ScheduleRow[] } }>(
    '/api/payment-schedules',
    {
      preHandler: requireAuth,
      schema: {
        body: {
          type: 'object', required: ['bookingId', 'installments'], additionalProperties: false,
          properties: {
            bookingId: { type: 'string', pattern: UUID },
            installments: {
              type: 'array', minItems: 1, maxItems: 40,
              items: {
                type: 'object', required: ['milestoneName', 'sequence', 'amount'], additionalProperties: false,
                properties: {
                  milestoneName: { type: 'string', maxLength: 120 },
                  sequence: { type: 'integer', minimum: 1 },
                  percentage: { type: 'number', minimum: 0, maximum: 100 },
                  amount: { type: 'number', minimum: 0 },
                  dueDate: { type: 'string' },
                  trigger: { type: 'string', enum: ['time', 'construction_milestone'] },
                  status: { type: 'string', enum: ['pending', 'demanded', 'paid', 'overdue'] },
                },
              },
            },
          },
        },
      },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        const { rows: [{ allowed }] } = await db.query(`SELECT has_permission('manage_bookings') AS allowed`);
        if (!allowed) return reply.code(403).send({ error: 'Missing permission: manage_bookings' });

        // The booking must belong to this tenant (RLS scopes the read).
        const { rows: bk } = await db.query('SELECT id FROM bookings WHERE id = $1', [req.body.bookingId]);
        if (!bk[0]) return reply.code(404).send({ error: 'Booking not found' });

        await db.query('DELETE FROM payment_schedules WHERE booking_id = $1', [req.body.bookingId]);
        for (const i of req.body.installments) {
          await db.query(
            `INSERT INTO payment_schedules (tenant_id, booking_id, milestone_name, sequence, percentage, amount, trigger_type, due_date, status)
             VALUES (app_current_tenant(), $1, $2, $3, $4, $5, $6, $7, $8)`,
            [req.body.bookingId, i.milestoneName, i.sequence, i.percentage ?? 0, i.amount,
             i.trigger === 'construction_milestone' ? 'construction_milestone' : 'date',
             i.dueDate || null, statusToDb(i.status || 'pending')],
          );
        }
        const { rows } = await db.query('SELECT * FROM payment_schedules WHERE booking_id = $1 ORDER BY sequence', [req.body.bookingId]);
        reply.code(201); return { schedules: rows.map(scheduleToApi) };
      }),
  );

  /** PATCH /api/payment-schedules/:id — update status (e.g. raise demand). */
  app.patch<{ Params: { id: string }; Body: { status: string } }>(
    '/api/payment-schedules/:id',
    {
      preHandler: requireAuth,
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: UUID } } },
        body: { type: 'object', required: ['status'], additionalProperties: false, properties: { status: { type: 'string', enum: ['pending', 'demanded', 'paid', 'overdue'] } } },
      },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        const { rows: [{ allowed }] } = await db.query(`SELECT has_permission('manage_bookings') AS allowed`);
        if (!allowed) return reply.code(403).send({ error: 'Missing permission: manage_bookings' });
        const { rows } = await db.query('UPDATE payment_schedules SET status = $1 WHERE id = $2 RETURNING *', [statusToDb(req.body.status), req.params.id]);
        if (!rows[0]) return reply.code(404).send({ error: 'Schedule not found' });
        return { schedule: scheduleToApi(rows[0]) };
      }),
  );

  /** GET /api/payments?bookingId= — receipts (for the Statement of Account). */
  app.get<{ Querystring: { bookingId?: string } }>(
    '/api/payments',
    { preHandler: requireAuth },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        const { rows: [{ allowed }] } = await db.query(`SELECT has_permission('view_bookings') AS allowed`);
        if (!allowed) return reply.code(403).send({ error: 'Missing permission: view_bookings' });
        const bookingId = req.query.bookingId;
        const { rows } = bookingId
          ? await db.query(
              `SELECT p.* FROM payments p JOIN payment_schedules s ON s.id = p.payment_schedule_id WHERE s.booking_id = $1 ORDER BY p.payment_date`,
              [bookingId])
          : await db.query('SELECT * FROM payments ORDER BY payment_date');
        return { payments: rows.map(r => ({ id: r.id, scheduleId: r.payment_schedule_id, amount: Number(r.amount), date: r.payment_date, mode: r.mode, referenceNo: r.reference_no })) };
      }),
  );

  /**
   * POST /api/payments — collect a receipt against a schedule installment, and
   * flip that installment to paid. One transaction (withTenantContext wraps it).
   */
  app.post<{ Body: { scheduleId: string; amount: number; mode?: string; referenceNo?: string } }>(
    '/api/payments',
    {
      preHandler: requireAuth,
      schema: {
        body: {
          type: 'object', required: ['scheduleId', 'amount'], additionalProperties: false,
          properties: {
            scheduleId: { type: 'string', pattern: UUID },
            amount: { type: 'number', exclusiveMinimum: 0 },
            mode: { type: 'string', enum: ['cheque', 'bank_transfer', 'upi', 'cash', 'card'] },
            referenceNo: { type: 'string', maxLength: 64 },
          },
        },
      },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        const { rows: [{ allowed }] } = await db.query(`SELECT has_permission('manage_bookings') AS allowed`);
        if (!allowed) return reply.code(403).send({ error: 'Missing permission: manage_bookings' });

        const { rows: sch } = await db.query('SELECT id FROM payment_schedules WHERE id = $1', [req.body.scheduleId]);
        if (!sch[0]) return reply.code(404).send({ error: 'Schedule installment not found' });

        const { rows } = await db.query(
          `INSERT INTO payments (tenant_id, payment_schedule_id, amount, mode, reference_no, received_by)
           VALUES (app_current_tenant(), $1, $2, $3, $4, $5) RETURNING *`,
          [req.body.scheduleId, req.body.amount, req.body.mode || 'bank_transfer', req.body.referenceNo || null, req.ctx.userId || null],
        );
        await db.query(`UPDATE payment_schedules SET status = 'paid' WHERE id = $1`, [req.body.scheduleId]);
        const p = rows[0];
        reply.code(201); return { payment: { id: p.id, scheduleId: p.payment_schedule_id, amount: Number(p.amount), date: p.payment_date, mode: p.mode, referenceNo: p.reference_no } };
      }),
  );
}
