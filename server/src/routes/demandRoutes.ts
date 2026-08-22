import type { FastifyInstance } from 'fastify';
import { withTenantContext } from '../db.js';
import { requireAuth } from '../auth.js';
import { emit } from '../notify.js';

/**
 * Demand letters (migration 041) — the collections desk.
 *
 * Raising is deliberately an ACTION someone takes, not a nightly job that
 * posts letters while nobody is looking. A demand letter is quoted in
 * disputes and starts interest running; the person accountable for sending it
 * should be the one who pressed the button. A scheduled worker can call the
 * same path later, but it should not be the only way this happens.
 *
 * Gated on manage_finance rather than a new key: whoever can post to the
 * ledger is who demands money in this product, and inventing a permission
 * nobody has been granted would mean nobody can raise a demand until a
 * migration backfills it (see invariant 5 — there is no super-admin bypass).
 */

const UUID = '^[0-9a-fA-F-]{36}$';

async function gate(db: import('pg').PoolClient, perm: string): Promise<boolean> {
  const { rows: [{ allowed }] } = await db.query(`SELECT has_permission($1) AS allowed`, [perm]);
  return !!allowed;
}

const toApi = (r: Record<string, unknown>) => ({
  id: r.id,
  bookingId: r.booking_id,
  paymentScheduleId: r.payment_schedule_id,
  letterNo: r.letter_no,
  issuedOn: r.issued_on,
  dueOn: r.due_on,
  principalAmount: Number(r.principal_amount),
  interestAmount: Number(r.interest_amount),
  totalAmount: Number(r.total_amount),
  interestPct: Number(r.interest_pct),
  daysOverdue: r.days_overdue,
  status: r.status,
  reminderCount: r.reminder_count,
  lastReminderAt: r.last_reminder_at ?? null,
  // Denormalised for the list view so collections does not need a join per row.
  milestoneName: r.milestone_name ?? undefined,
  customerName: r.customer_name ?? undefined,
});

const SELECT_WITH_CONTEXT = `
  SELECT d.*, s.milestone_name, l.name AS customer_name
    FROM demand_letters d
    JOIN payment_schedules s ON s.id = d.payment_schedule_id
    JOIN bookings b          ON b.id = d.booking_id
    LEFT JOIN leads l        ON l.id = b.lead_id`;

export async function demandRoutes(app: FastifyInstance): Promise<void> {
  /** GET /api/demand-letters — the collections worklist. */
  app.get<{ Querystring: { status?: string } }>(
    '/api/demand-letters',
    {
      preHandler: requireAuth,
      schema: { querystring: { type: 'object', properties: { status: { type: 'string', enum: ['issued', 'paid', 'cancelled'] } } } },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'view_finance')) {
          return reply.code(403).send({ error: 'Missing permission: view_finance' });
        }
        const { rows } = await db.query(
          `${SELECT_WITH_CONTEXT}
            WHERE ($1::text IS NULL OR d.status = $1)
            ORDER BY d.due_on, d.letter_no`,
          [req.query.status ?? null]);
        return { demandLetters: rows.map(toApi) };
      }),
  );

  /**
   * GET /api/demand-letters/due — milestones that COULD be demanded.
   *
   * The preview a collections person works from: overdue, still owing, and
   * not already carrying a live letter. Returns what each demand would be
   * worth if raised today, so the decision is made with the number visible
   * rather than after the letter exists.
   */
  app.get('/api/demand-letters/due', { preHandler: requireAuth }, async (req, reply) =>
    withTenantContext(req.ctx, async (db) => {
      if (!await gate(db, 'view_finance')) {
        return reply.code(403).send({ error: 'Missing permission: view_finance' });
      }
      const { rows } = await db.query(`
        SELECT s.id                        AS payment_schedule_id,
               s.booking_id,
               s.milestone_name,
               s.due_date,
               l.name                      AS customer_name,
               b.delay_interest_pct,
               (CURRENT_DATE - s.due_date) AS days_overdue,
               milestone_outstanding(s.id) AS outstanding,
               delay_interest(milestone_outstanding(s.id), b.delay_interest_pct,
                              (CURRENT_DATE - s.due_date)::int) AS interest
          FROM payment_schedules s
          JOIN bookings b   ON b.id = s.booking_id
          LEFT JOIN leads l ON l.id = b.lead_id
         WHERE s.due_date < CURRENT_DATE
           AND b.status <> 'cancelled'
           AND milestone_outstanding(s.id) > 0
           AND NOT EXISTS (
                 SELECT 1 FROM demand_letters d
                  WHERE d.payment_schedule_id = s.id AND d.status = 'issued')
         ORDER BY s.due_date`);
      return {
        due: rows.map(r => ({
          paymentScheduleId: r.payment_schedule_id,
          bookingId: r.booking_id,
          milestoneName: r.milestone_name,
          dueDate: r.due_date,
          customerName: r.customer_name ?? undefined,
          daysOverdue: Number(r.days_overdue),
          outstanding: Number(r.outstanding),
          interest: Number(r.interest),
          interestPct: Number(r.delay_interest_pct),
          total: Number(r.outstanding) + Number(r.interest),
        })),
      };
    }),
  );

  /**
   * POST /api/demand-letters — raise one against a milestone.
   *
   * Everything is recomputed server-side from the schedule and the payments.
   * The client sends only WHICH milestone: a body carrying the amount would
   * be a demand for whatever the browser believed, and the browser is often
   * looking at a page loaded before the last receipt was entered.
   */
  app.post<{ Body: { paymentScheduleId: string; dueInDays?: number } }>(
    '/api/demand-letters',
    {
      preHandler: requireAuth,
      schema: {
        body: {
          type: 'object', required: ['paymentScheduleId'], additionalProperties: false,
          properties: {
            paymentScheduleId: { type: 'string', pattern: UUID },
            // How long the buyer gets. 15 days is the common agreement term.
            dueInDays: { type: 'integer', minimum: 1, maximum: 90 },
          },
        },
      },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'manage_finance')) {
          return reply.code(403).send({ error: 'Missing permission: manage_finance' });
        }

        const { rows: [m] } = await db.query(`
          SELECT s.id, s.booking_id, s.milestone_name, s.due_date,
                 b.delay_interest_pct, b.lead_id,
                 (CURRENT_DATE - s.due_date)::int   AS days_overdue,
                 milestone_outstanding(s.id)        AS outstanding
            FROM payment_schedules s
            JOIN bookings b ON b.id = s.booking_id
           WHERE s.id = $1`, [req.body.paymentScheduleId]);
        // 404 not 403 — the milestone may simply belong to another tenant, and
        // this must not confirm that it exists.
        if (!m) return reply.code(404).send({ error: 'Not found' });

        if (Number(m.outstanding) <= 0) {
          return reply.code(400).send({ error: 'That milestone is already fully paid.' });
        }

        const days = Math.max(0, Number(m.days_overdue));
        const { rows: [calc] } = await db.query(
          `SELECT delay_interest($1, $2, $3) AS interest`,
          [m.outstanding, m.delay_interest_pct, days]);

        try {
          const { rows: [created] } = await db.query(`
            INSERT INTO demand_letters (
              tenant_id, booking_id, payment_schedule_id, letter_no, due_on,
              principal_amount, interest_amount, total_amount, interest_pct,
              days_overdue, created_by)
            VALUES (
              app_current_tenant(), $1, $2,
              -- Per-tenant sequence, computed inside this transaction. RLS
              -- scopes the MAX, so two tenants never contend for a number.
              COALESCE((SELECT max(letter_no) FROM demand_letters), 0) + 1,
              CURRENT_DATE + ($3::int || ' days')::interval,
              -- Cast explicitly. Adding two untyped parameters raises
              -- "operator is not unique: unknown + unknown", which surfaces as
              -- a 500 naming nothing useful.
              $4::numeric, $5::numeric, $4::numeric + $5::numeric,
              $6::numeric, $7::int, app_current_user())
            RETURNING *`,
            [m.booking_id, m.id, req.body.dueInDays ?? 15,
             m.outstanding, calc.interest, m.delay_interest_pct, days]);

          // Tell the people who chase money that there is something to chase.
          // Emitted on this transaction, so a letter that fails to commit
          // cannot leave a notification claiming it exists.
          await emit(db, {
            userId: req.ctx.userId,
            kind: 'payment_received',
            title: `Demand #${created.letter_no} raised — ${m.milestone_name}`,
            body: `${Number(created.total_amount).toLocaleString('en-IN')} due in ${req.body.dueInDays ?? 15} days`,
            entityType: 'demand_letter',
            entityId: String(created.id),
          });

          reply.code(201);
          return { demandLetter: toApi({ ...created, milestone_name: m.milestone_name }) };
        } catch (err) {
          // The partial unique index. Two people looking at the same worklist
          // is normal; a double demand is not.
          if ((err as { code?: string }).code === '23505') {
            return reply.code(409).send({ error: 'A demand is already outstanding for this milestone.' });
          }
          throw err;
        }
      }),
  );

  /**
   * PATCH /api/demand-letters/:id — settle or withdraw.
   *
   * There is deliberately no way to edit an amount. A demand that went out
   * wrong is cancelled and re-raised, so the record of what was demanded, and
   * when, survives — the same reasoning that makes a posted journal entry
   * immutable.
   */
  app.patch<{ Params: { id: string }; Body: { status: 'paid' | 'cancelled' } }>(
    '/api/demand-letters/:id',
    {
      preHandler: requireAuth,
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: UUID } } },
        body: {
          type: 'object', required: ['status'], additionalProperties: false,
          properties: { status: { type: 'string', enum: ['paid', 'cancelled'] } },
        },
      },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'manage_finance')) {
          return reply.code(403).send({ error: 'Missing permission: manage_finance' });
        }
        const { rows } = await db.query(
          `UPDATE demand_letters SET status = $1
            WHERE id = $2 AND status = 'issued'
            RETURNING *`, [req.body.status, req.params.id]);
        if (!rows[0]) return reply.code(404).send({ error: 'Not found, or already settled' });
        reply.code(200);
        return { demandLetter: toApi(rows[0]) };
      }),
  );

  /** POST /api/demand-letters/:id/remind — record that a reminder went out. */
  app.post<{ Params: { id: string } }>(
    '/api/demand-letters/:id/remind',
    {
      preHandler: requireAuth,
      schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: UUID } } } },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'manage_finance')) {
          return reply.code(403).send({ error: 'Missing permission: manage_finance' });
        }
        const { rows } = await db.query(
          `UPDATE demand_letters
              SET reminder_count = reminder_count + 1, last_reminder_at = now()
            WHERE id = $1 AND status = 'issued'
            RETURNING *`, [req.params.id]);
        if (!rows[0]) return reply.code(404).send({ error: 'Not found, or already settled' });
        reply.code(200);
        return { demandLetter: toApi(rows[0]) };
      }),
  );
}
