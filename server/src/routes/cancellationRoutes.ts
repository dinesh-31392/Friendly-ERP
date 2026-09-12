import type { FastifyInstance } from 'fastify';
import { withTenantContext } from '../db.js';
import { requireAuth } from '../auth.js';
import { renderLetter, pdfMoney, pdfDate } from '../pdf.js';
import { contentDisposition, NOSNIFF } from '../storage.js';

/**
 * Cancellation and refund (migration 051).
 *
 * Cancelling used to be `DELETE FROM bookings`, which is an erasure rather than
 * a cancellation: by the time a booking is cancelled, money has changed hands,
 * TDS may have been remitted against the buyer's PAN, GST may have gone to the
 * government and brokerage may already be out the door. None of that can be
 * reconstructed from a row that no longer exists.
 *
 * Raising a request is a sales act; approving one and paying it out is a
 * finance act. They are gated separately on purpose — the person who agreed the
 * refund with the buyer should not be the person who signs it off.
 */

const UUID = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

async function gate(db: import('pg').PoolClient, perm: string): Promise<boolean> {
  const { rows: [{ allowed }] } = await db.query(`SELECT has_permission($1) AS allowed`, [perm]);
  return !!allowed;
}

const round2 = (n: number) => Math.round((Number.isFinite(n) ? n : 0) * 100) / 100;

export interface RefundInput {
  consideration: number;
  totalReceived: number;
  forfeiturePct: number;
  otherDeductions: number;
  gstRemitted: number;
  gstRefundable: boolean;
}

/**
 * What the builder owes the buyer — or, when it is negative, the other way.
 *
 * Forfeiture is a percentage of the CONSIDERATION, not of what the buyer
 * happened to have paid. An agreement forfeiting 10% against a buyer who has
 * paid 5% leaves the buyer owing the balance, and clamping that to zero
 * silently writes off money the builder is owed on every early cancellation.
 * The sign is kept.
 *
 * GST already remitted is only returned when a credit note can still be issued
 * (s.34(2) CGST). Past that date the builder cannot recover it from the
 * government, and paying it to the buyer means paying it twice.
 */
export function computeRefund(i: RefundInput): {
  forfeitureAmount: number; refundAmount: number; buyerOwes: boolean;
} {
  const forfeitureAmount = round2(Number(i.consideration) * Number(i.forfeiturePct) / 100);
  const gstBack = i.gstRefundable ? Number(i.gstRemitted) : 0;
  const refundAmount = round2(
    Number(i.totalReceived) - forfeitureAmount - Number(i.otherDeductions)
    - (Number(i.gstRemitted) - gstBack),
  );
  return { forfeitureAmount, refundAmount, buyerOwes: refundAmount < 0 };
}

const toApi = (r: Record<string, unknown>) => ({
  id: r.id,
  bookingId: r.booking_id,
  requestedOn: r.requested_on,
  cancelledOn: r.cancelled_on ?? null,
  reasonCategory: r.reason_category,
  reason: r.reason ?? '',
  consideration: Number(r.consideration),
  totalReceived: Number(r.total_received),
  forfeiturePct: Number(r.forfeiture_pct),
  forfeitureAmount: Number(r.forfeiture_amount),
  otherDeductions: Number(r.other_deductions),
  gstRemitted: Number(r.gst_remitted),
  gstRefundable: !!r.gst_refundable,
  refundAmount: Number(r.refund_amount),
  /** Named rather than left for the client to infer from a sign it may clamp. */
  buyerOwes: Number(r.refund_amount) < 0,
  status: r.status,
  approvedAt: r.approved_at ?? null,
  refundedOn: r.refunded_on ?? null,
  refundReference: r.refund_reference ?? '',
  createdAt: r.created_at,
  customerName: r.customer_name ?? undefined,
  unitCode: r.unit_code ?? undefined,
  projectName: r.project_name ?? undefined,
});

const SELECT_WITH_CONTEXT = `
  SELECT c.*, l.name AS customer_name, u.unit_code, p.name AS project_name
    FROM booking_cancellations c
    JOIN bookings b       ON b.id = c.booking_id
    LEFT JOIN leads l     ON l.id = b.lead_id
    LEFT JOIN units u     ON u.id = b.unit_id
    LEFT JOIN projects p  ON p.id = u.project_id`;

export async function cancellationRoutes(app: FastifyInstance): Promise<void> {
  /** GET /api/cancellations — the refund worklist. */
  app.get<{ Querystring: { status?: string } }>(
    '/api/cancellations',
    {
      preHandler: requireAuth,
      schema: { querystring: { type: 'object', properties: { status: { type: 'string', enum: ['requested', 'approved', 'refunded', 'rejected'] } } } },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'view_bookings')) {
          return reply.code(403).send({ error: 'Missing permission: view_bookings' });
        }
        const { rows } = await db.query(
          `${SELECT_WITH_CONTEXT}
            WHERE ($1::text IS NULL OR c.status = $1)
            ORDER BY c.created_at DESC LIMIT 500`, [req.query.status ?? null]);
        return { cancellations: rows.map(toApi) };
      }),
  );

  /**
   * GET /api/bookings/:id/cancellation-preview — what a refund would be.
   *
   * The decision is made with the number visible rather than after the request
   * exists. Reads what was actually received rather than what was scheduled:
   * a schedule is what was demanded, and the whole question at cancellation is
   * how much of it was answered.
   */
  app.get<{ Params: { id: string }; Querystring: { forfeiturePct?: number; otherDeductions?: number; gstRemitted?: number; gstRefundable?: boolean } }>(
    '/api/bookings/:id/cancellation-preview',
    {
      preHandler: requireAuth,
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: UUID } } },
        querystring: {
          type: 'object',
          properties: {
            forfeiturePct: { type: 'number', minimum: 0, maximum: 100 },
            otherDeductions: { type: 'number', minimum: 0, maximum: 1e12 },
            gstRemitted: { type: 'number', minimum: 0, maximum: 1e12 },
            gstRefundable: { type: 'boolean' },
          },
        },
      },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'view_bookings')) {
          return reply.code(403).send({ error: 'Missing permission: view_bookings' });
        }
        const { rows: [b] } = await db.query(
          `SELECT b.id, b.total_consideration, booking_total_received(b.id) AS received,
                  l.name AS customer_name, u.unit_code, p.name AS project_name
             FROM bookings b
             LEFT JOIN leads l ON l.id = b.lead_id
             LEFT JOIN units u ON u.id = b.unit_id
             LEFT JOIN projects p ON p.id = u.project_id
            WHERE b.id = $1`, [req.params.id]);
        if (!b) return reply.code(404).send({ error: 'Booking not found' });

        const input: RefundInput = {
          consideration: Number(b.total_consideration ?? 0),
          totalReceived: Number(b.received ?? 0),
          forfeiturePct: Number(req.query.forfeiturePct ?? 10),
          otherDeductions: Number(req.query.otherDeductions ?? 0),
          gstRemitted: Number(req.query.gstRemitted ?? 0),
          gstRefundable: req.query.gstRefundable ?? false,
        };
        return { preview: { ...input, ...computeRefund(input),
          customerName: b.customer_name ?? undefined,
          unitCode: b.unit_code ?? undefined,
          projectName: b.project_name ?? undefined } };
      }),
  );

  /**
   * POST /api/cancellations — request one, and cancel the booking.
   *
   * The booking is marked cancelled here rather than on approval: the buyer has
   * walked, and leaving the unit locked while a refund is negotiated is how a
   * sellable flat sits idle for a month. The partial unique index covers only
   * active and completed bookings, so this frees it immediately while the row
   * stays on the record.
   */
  app.post<{ Body: {
    bookingId: string; reasonCategory?: string; reason?: string;
    forfeiturePct?: number; otherDeductions?: number;
    gstRemitted?: number; gstRefundable?: boolean;
  } }>(
    '/api/cancellations',
    {
      preHandler: requireAuth,
      schema: {
        body: {
          type: 'object', required: ['bookingId'], additionalProperties: false,
          properties: {
            bookingId: { type: 'string', pattern: UUID },
            reasonCategory: { type: 'string', enum: ['buyer_finance', 'buyer_personal', 'project_delay', 'builder_initiated', 'transfer', 'other'] },
            reason: { type: 'string', maxLength: 2000 },
            forfeiturePct: { type: 'number', minimum: 0, maximum: 100 },
            otherDeductions: { type: 'number', minimum: 0, maximum: 1e12 },
            gstRemitted: { type: 'number', minimum: 0, maximum: 1e12 },
            gstRefundable: { type: 'boolean' },
          },
        },
      },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'manage_bookings')) {
          return reply.code(403).send({ error: 'Missing permission: manage_bookings' });
        }
        const { rows: [b] } = await db.query(
          `SELECT id, status, total_consideration, booking_total_received(id) AS received
             FROM bookings WHERE id = $1`, [req.body.bookingId]);
        if (!b) return reply.code(404).send({ error: 'Booking not found' });
        if (b.status === 'cancelled') {
          return reply.code(409).send({ error: 'That booking is already cancelled.' });
        }

        const input: RefundInput = {
          consideration: Number(b.total_consideration ?? 0),
          totalReceived: Number(b.received ?? 0),
          forfeiturePct: Number(req.body.forfeiturePct ?? 10),
          otherDeductions: Number(req.body.otherDeductions ?? 0),
          gstRemitted: Number(req.body.gstRemitted ?? 0),
          gstRefundable: req.body.gstRefundable ?? false,
        };
        const calc = computeRefund(input);

        try {
          const { rows: [created] } = await db.query(
            `INSERT INTO booking_cancellations
               (tenant_id, booking_id, cancelled_on, reason_category, reason,
                consideration, total_received, forfeiture_pct, forfeiture_amount,
                other_deductions, gst_remitted, gst_refundable, refund_amount, created_by)
             VALUES (app_current_tenant(), $1, CURRENT_DATE, COALESCE($2,'other'), COALESCE($3,''),
                     $4, $5, $6, $7, $8, $9, $10, $11, $12)
             RETURNING *`,
            [req.body.bookingId, req.body.reasonCategory ?? null, req.body.reason ?? null,
             input.consideration, input.totalReceived, input.forfeiturePct, calc.forfeitureAmount,
             input.otherDeductions, input.gstRemitted, input.gstRefundable, calc.refundAmount,
             req.ctx.userId]);

          await db.query(`UPDATE bookings SET status = 'cancelled' WHERE id = $1`, [req.body.bookingId]);

          const { rows: [full] } = await db.query(`${SELECT_WITH_CONTEXT} WHERE c.id = $1`, [created.id]);
          reply.code(201);
          return { cancellation: toApi(full) };
        } catch (err) {
          if ((err as { code?: string })?.code === '23505') {
            return reply.code(409).send({ error: 'A cancellation is already open for that booking.' });
          }
          throw err;
        }
      }),
  );

  /**
   * PATCH /api/cancellations/:id — approve, pay out, or refuse.
   *
   * Approval and payout are gated on manage_finance, not manage_bookings: the
   * salesperson who agreed the refund with the buyer should not also be the one
   * who signs it off.
   */
  app.patch<{ Params: { id: string }; Body: { status: string; refundReference?: string } }>(
    '/api/cancellations/:id',
    {
      preHandler: requireAuth,
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: UUID } } },
        body: {
          type: 'object', required: ['status'], additionalProperties: false,
          properties: {
            status: { type: 'string', enum: ['approved', 'refunded', 'rejected'] },
            refundReference: { type: 'string', maxLength: 120 },
          },
        },
      },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'manage_finance')) {
          return reply.code(403).send({ error: 'Missing permission: manage_finance' });
        }
        const ALLOWED: Record<string, string[]> = {
          requested: ['approved', 'rejected'],
          approved:  ['refunded', 'rejected'],
          refunded:  [],
          rejected:  [],
        };
        const { rows: [row] } = await db.query('SELECT * FROM booking_cancellations WHERE id = $1', [req.params.id]);
        if (!row) return reply.code(404).send({ error: 'Cancellation not found' });
        if (!ALLOWED[row.status]?.includes(req.body.status)) {
          return reply.code(409).send({ error: `A ${row.status} cancellation cannot become ${req.body.status}.` });
        }
        // A payout needs evidence of the payout. Marking money as sent with no
        // reference leaves a refund nobody can trace in a bank statement.
        if (req.body.status === 'refunded' && !req.body.refundReference?.trim()) {
          return reply.code(400).send({ error: 'A refund reference is required when recording a payout.' });
        }

        const { rows: [updated] } = await db.query(
          `UPDATE booking_cancellations
              SET status = $1,
                  approved_by = CASE WHEN $1 = 'approved' THEN $3 ELSE approved_by END,
                  approved_at = CASE WHEN $1 = 'approved' THEN now() ELSE approved_at END,
                  refunded_on = CASE WHEN $1 = 'refunded' THEN CURRENT_DATE ELSE refunded_on END,
                  refund_reference = COALESCE($2, refund_reference)
            WHERE id = $4 RETURNING id`,
          [req.body.status, req.body.refundReference ?? null, req.ctx.userId, req.params.id]);

        const { rows: [full] } = await db.query(`${SELECT_WITH_CONTEXT} WHERE c.id = $1`, [updated.id]);
        return { cancellation: toApi(full) };
      }),
  );

  /**
   * GET /api/cancellations/:id/pdf — the refund statement.
   *
   * The document the buyer signs off on. Every deduction is named and reasoned,
   * because a refund the buyer does not understand is a refund they dispute.
   */
  app.get<{ Params: { id: string } }>(
    '/api/cancellations/:id/pdf',
    { preHandler: requireAuth, schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: UUID } } } } },
    async (req, reply) => {
      const data = await withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'view_finance')) return { forbidden: true } as const;
        const { rows: [row] } = await db.query(`${SELECT_WITH_CONTEXT} WHERE c.id = $1`, [req.params.id]);
        if (!row) return null;
        const { rows: [t] } = await db.query(
          `SELECT name, company, address, email, phone, currency FROM tenants WHERE id = app_current_tenant()`);
        return { row, tenant: t };
      });

      if (data && 'forbidden' in data) return reply.code(403).send({ error: 'Missing permission: view_finance' });
      if (!data) return reply.code(404).send({ error: 'Cancellation not found' });

      const { row, tenant } = data;
      const ccy = (tenant?.currency as string) || 'INR';
      const locale = ccy === 'INR' ? 'en-IN' : 'en-US';
      const money = (n: unknown) => pdfMoney(Number(n ?? 0), ccy, locale);
      const unit = [row.project_name, row.unit_code].filter(Boolean).join(' — ');
      const refund = Number(row.refund_amount);
      const gstWithheld = row.gst_refundable ? 0 : Number(row.gst_remitted);

      const rows: { label: string; value: string; strong?: boolean }[] = [
        { label: 'Total consideration', value: money(row.consideration) },
        { label: 'Amount received from the purchaser', value: money(row.total_received) },
        { label: `Less: forfeiture @ ${Number(row.forfeiture_pct)}% of the consideration`, value: `(${money(row.forfeiture_amount)})` },
      ];
      if (Number(row.other_deductions) > 0) {
        rows.push({ label: 'Less: other deductions (brokerage disbursed, administrative charges)', value: `(${money(row.other_deductions)})` });
      }
      if (gstWithheld > 0) {
        rows.push({ label: 'Less: GST already remitted and no longer recoverable', value: `(${money(gstWithheld)})` });
      }
      rows.push(refund >= 0
        ? { label: 'Net refundable to the purchaser', value: money(refund), strong: true }
        // The case a calculation that clamps at zero hides entirely.
        : { label: 'Net payable BY the purchaser to the developer', value: money(Math.abs(refund)), strong: true });

      const outro: string[] = [];
      if (refund < 0) {
        outro.push(
          'The forfeiture provided for under the agreement exceeds the amount received from the purchaser. '
          + 'The balance shown above is therefore payable BY the purchaser, and is not a refund.');
      }
      if (Number(row.gst_remitted) > 0) {
        outro.push(row.gst_refundable
          ? 'Goods and Services Tax remitted on this booking is being recovered by way of a credit note under section 34 of the CGST Act, and has accordingly been included in the refund.'
          : 'Goods and Services Tax already remitted on this booking is not recoverable by the developer, the period for issuing a credit note under section 34(2) of the CGST Act having elapsed. It has accordingly been retained.');
      }
      outro.push(
        'Any tax deducted at source by the purchaser under section 194-IA was remitted to the Income Tax Department '
        + 'against the purchaser\'s own permanent account number, and does not form part of this computation. '
        + 'Credit for it may be claimed by the purchaser in the usual manner.');
      if (row.refunded_on) {
        outro.push(`The refund was paid on ${pdfDate(row.refunded_on as string, locale)}${row.refund_reference ? ` under reference ${row.refund_reference}` : ''}.`);
      }
      if (row.reason) outro.push(`Reason recorded: ${row.reason}`);

      const pdf = await renderLetter({
        from: {
          name: (tenant?.company as string) || (tenant?.name as string) || 'Developer',
          address: (tenant?.address as string) || undefined,
          email: (tenant?.email as string) || undefined,
          phone: (tenant?.phone as string) || undefined,
        },
        title: refund >= 0 ? 'Cancellation and Refund Statement' : 'Cancellation and Settlement Statement',
        reference: `Cancelled ${pdfDate(row.cancelled_on as string, locale)}  ·  Status: ${row.status}`,
        to: { name: (row.customer_name as string) || 'Purchaser', lines: unit ? [unit] : [] },
        intro: [
          `The booking${unit ? ` in respect of ${unit}` : ''} has been cancelled with effect from ${pdfDate(row.cancelled_on as string, locale)}. The computation below sets out the amounts received, the deductions applied under the agreement, and the net position between the parties.`,
        ],
        rows,
        outro,
        footer: 'This statement is issued from the developer’s records and is subject to the terms of the '
              + 'agreement between the parties.',
      });

      reply
        .header('Content-Type', 'application/pdf')
        .header('Content-Length', String(pdf.length))
        .header('Content-Disposition', contentDisposition(`Refund-Statement-${String(row.id).slice(0, 8)}.pdf`, true))
        .headers(NOSNIFF)
        .header('Cache-Control', 'private, no-store');
      return reply.send(pdf);
    },
  );
}
