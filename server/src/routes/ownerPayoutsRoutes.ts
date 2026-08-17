import type { FastifyInstance } from 'fastify';
import { withTenantContext } from '../db.js';
import { requireAuth } from '../auth.js';

/**
 * Owner payouts (migration 036) — what the company owes a unit's owner.
 *
 * Separate from leasingRoutes.ts on purpose. Papering a lease and releasing
 * money to a landlord are different jobs with different blast radii, so they
 * are different permissions: a letting executive runs the lease end to end with
 * `manage_leasing` and still cannot move a rupee.
 *
 * Two rules this module exists to keep:
 *
 *   1. A payout is computed from rent actually COLLECTED (lease_receipts), not
 *      from rent invoiced. Paying an owner for money the occupant never paid is
 *      how a managing agent quietly funds a shortfall out of its own float.
 *   2. Maker ≠ checker. `manage_owner_payouts` prepares; `approve_owner_payouts`
 *      releases. The database backs this up with a CHECK that a payout cannot
 *      reach approved/paid without a named approver, so a future route that
 *      forgets the gate still cannot write an unapproved payment.
 */

const UUID = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
const DATE = '^\\d{4}-\\d{2}-\\d{2}$';

async function gate(db: import('pg').PoolClient, perm: string): Promise<boolean> {
  const { rows: [{ allowed }] } = await db.query(`SELECT has_permission($1) AS allowed`, [perm]);
  return !!allowed;
}

/**
 * A `date` column as a calendar day — see the same helper in leasingRoutes.ts.
 * node-postgres parses DATE to local midnight, which JSON-serialises to the
 * previous day east of Greenwich. A payout period is a billing boundary, so
 * shifting it by a day puts the statement in the wrong month.
 */
const day = (v: unknown): string | undefined => {
  if (v == null) return undefined;
  if (!(v instanceof Date)) return String(v);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`;
};

const toApiPayout = (r: Record<string, unknown>) => ({
  id: r.id, tenantId: r.tenant_id, leaseId: r.lease_id,
  ownerCustomerId: r.owner_customer_id ?? undefined,
  periodStart: day(r.period_start), periodEnd: day(r.period_end),
  grossCollected: Number(r.gross_collected) || 0,
  managementFeePercent: Number(r.management_fee_percent) || 0,
  managementFeeAmount: Number(r.management_fee_amount) || 0,
  otherDeductions: Number(r.other_deductions) || 0,
  netPayable: Number(r.net_payable) || 0,
  status: r.status,
  approvedBy: r.approved_by ?? undefined,
  approvedAt: r.approved_at ?? undefined,
  paidAt: r.paid_at ?? undefined,
  paymentReference: r.payment_reference ?? '',
  createdAt: r.created_at,
});

function mapWriteError(err: unknown): { code: number; error: string } | null {
  const e = err as { code?: string; constraint?: string };
  switch (e?.code) {
    case '23514':
      return { code: 400, error: 'A payout cannot be approved or paid without an approver, and amounts cannot be negative.' };
    case '23505':
      return { code: 409, error: 'A payout already exists for that lease and period.' };
    case '23503':
      return { code: 400, error: 'Referenced lease or owner does not exist in this workspace.' };
    case '22P02':
      return { code: 400, error: 'A field has an invalid format.' };
    default:
      return null;
  }
}

export async function ownerPayoutsRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { status?: string; leaseId?: string; ownerCustomerId?: string } }>(
    '/api/owner-payouts',
    {
      preHandler: requireAuth,
      schema: { querystring: { type: 'object', additionalProperties: false, properties: {
        status: { type: 'string', enum: ['pending', 'approved', 'paid', 'on_hold'] },
        leaseId: { type: 'string', pattern: UUID },
        ownerCustomerId: { type: 'string', pattern: UUID },
      } } },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'view_owner_payouts')) {
          return reply.code(403).send({ error: 'Missing permission: view_owner_payouts' });
        }
        const where: string[] = []; const params: unknown[] = [];
        if (req.query.status) { params.push(req.query.status); where.push(`status = $${params.length}`); }
        if (req.query.leaseId) { params.push(req.query.leaseId); where.push(`lease_id = $${params.length}`); }
        if (req.query.ownerCustomerId) {
          params.push(req.query.ownerCustomerId); where.push(`owner_customer_id = $${params.length}`);
        }
        const { rows } = await db.query(
          `SELECT * FROM owner_payouts
            ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
            ORDER BY period_start DESC, created_at DESC`, params);
        return { ownerPayouts: rows.map(toApiPayout) };
      }),
  );

  /**
   * POST /api/owner-payouts/generate — build the statements for every period
   * that has money against it.
   *
   * Re-running REFRESHES a payout that is still `pending`: rent often arrives
   * in two instalments, and the statement should follow the money until someone
   * approves it. Once approved or paid it is frozen — that is the ON CONFLICT
   * … WHERE status = 'pending' below, and it is the difference between an
   * audit trail and a number that changes after it was signed off.
   */
  app.post<{ Body: { through?: string; leaseId?: string } }>(
    '/api/owner-payouts/generate',
    {
      preHandler: requireAuth,
      schema: { body: { type: 'object', additionalProperties: false, properties: {
        through: { type: 'string', pattern: DATE },
        leaseId: { type: 'string', pattern: UUID },
      } } },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'manage_owner_payouts')) {
          return reply.code(403).send({ error: 'Missing permission: manage_owner_payouts' });
        }
        try {
          const { rows } = await db.query(
            `INSERT INTO owner_payouts
               (tenant_id, lease_id, owner_customer_id, period_start, period_end,
                gross_collected, management_fee_percent, management_fee_amount)
             SELECT i.tenant_id, i.lease_id, l.owner_customer_id, i.period_start, i.period_end,
                    c.amt,
                    l.management_fee_percent,
                    round(c.amt * l.management_fee_percent / 100, 2)
               FROM lease_invoices i
               JOIN lease_agreements l ON l.id = i.lease_id AND l.tenant_id = i.tenant_id
               CROSS JOIN LATERAL (
                 SELECT COALESCE(sum(r.amount), 0) AS amt
                   FROM lease_receipts r WHERE r.lease_invoice_id = i.id
               ) c
              -- No owner means the company owns the unit: there is nobody to pay.
              WHERE l.owner_customer_id IS NOT NULL
                AND c.amt > 0
                AND i.status <> 'cancelled'
                AND i.period_start <= COALESCE($1::date, CURRENT_DATE)
                AND ($2::uuid IS NULL OR l.id = $2::uuid)
             ON CONFLICT (lease_id, period_start) DO UPDATE
                SET gross_collected        = EXCLUDED.gross_collected,
                    management_fee_percent = EXCLUDED.management_fee_percent,
                    management_fee_amount  = EXCLUDED.management_fee_amount
              WHERE owner_payouts.status = 'pending'
             RETURNING *`,
            [req.body?.through ?? null, req.body?.leaseId ?? null]);
          reply.code(201);
          return { generated: rows.length, ownerPayouts: rows.map(toApiPayout) };
        } catch (err) {
          const mapped = mapWriteError(err);
          if (!mapped) throw err;
          return reply.code(mapped.code).send({ error: mapped.error });
        }
      }),
  );

  /**
   * PATCH /api/owner-payouts/:id — adjust, approve, or mark paid.
   *
   * `grossCollected` is deliberately not writable: it is what the receipts say.
   * Deductions are, because "we paid the plumber out of this month's rent" is a
   * real thing that has to land somewhere.
   */
  app.patch<{ Params: { id: string }; Body: Record<string, unknown> }>(
    '/api/owner-payouts/:id',
    {
      preHandler: requireAuth,
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: UUID } } },
        body: { type: 'object', minProperties: 1, additionalProperties: false, properties: {
          otherDeductions: { type: 'number', minimum: 0, maximum: 1e12 },
          status: { type: 'string', enum: ['pending', 'approved', 'paid', 'on_hold'] },
          paymentReference: { type: 'string', maxLength: 120 },
        } },
      },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        const body = req.body as { otherDeductions?: number; status?: string; paymentReference?: string };
        const releasing = body.status === 'approved' || body.status === 'paid';

        // Releasing money needs the checker's right; everything else needs the
        // maker's. Checked in that order so a maker attempting an approval is
        // told which permission is missing, not the one they already hold.
        if (releasing) {
          if (!await gate(db, 'approve_owner_payouts')) {
            return reply.code(403).send({ error: 'Missing permission: approve_owner_payouts' });
          }
        } else if (!await gate(db, 'manage_owner_payouts')) {
          return reply.code(403).send({ error: 'Missing permission: manage_owner_payouts' });
        }

        const { rows: [current] } = await db.query(
          `SELECT status FROM owner_payouts WHERE id = $1`, [req.params.id]);
        if (!current) return reply.code(404).send({ error: 'Owner payout not found' });

        // Paid is downstream of approved. Without this a single request holding
        // approve rights could jump a payout straight to paid, and the approval
        // step — the whole point of the separate grant — would never be recorded
        // as its own event in the audit trail.
        if (body.status === 'paid' && current.status !== 'approved') {
          return reply.code(409).send({
            error: `A payout must be approved before it can be marked paid (this one is ${current.status}).`,
          });
        }

        const sets: string[] = []; const params: unknown[] = [];
        if (body.otherDeductions !== undefined) {
          params.push(body.otherDeductions); sets.push(`other_deductions = $${params.length}`);
        }
        if (body.paymentReference !== undefined) {
          params.push(body.paymentReference); sets.push(`payment_reference = $${params.length}`);
        }
        if (body.status !== undefined) {
          params.push(body.status); sets.push(`status = $${params.length}`);
          if (body.status === 'approved') {
            sets.push(`approved_by = app_current_user()`, `approved_at = now()`);
          }
          if (body.status === 'paid') sets.push(`paid_at = now()`);
          // Sending an approved payout back to pending must also clear the
          // stamp, or the record claims an approval that no longer applies.
          if (body.status === 'pending' || body.status === 'on_hold') {
            sets.push(`approved_by = NULL`, `approved_at = NULL`);
          }
        }
        if (!sets.length) return reply.code(400).send({ error: 'No writable fields supplied' });

        params.push(req.params.id);
        try {
          const { rows } = await db.query(
            `UPDATE owner_payouts SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`, params);
          if (!rows[0]) return reply.code(404).send({ error: 'Owner payout not found' });
          return { ownerPayout: toApiPayout(rows[0]) };
        } catch (err) {
          const mapped = mapWriteError(err);
          if (!mapped) throw err;
          return reply.code(mapped.code).send({ error: mapped.error });
        }
      }),
  );

  /**
   * GET /api/owner-payouts/statement/:ownerCustomerId — one landlord's ledger.
   * What a managing agent actually sends the owner at the end of the month.
   */
  app.get<{ Params: { ownerCustomerId: string } }>(
    '/api/owner-payouts/statement/:ownerCustomerId',
    {
      preHandler: requireAuth,
      schema: { params: { type: 'object', required: ['ownerCustomerId'],
        properties: { ownerCustomerId: { type: 'string', pattern: UUID } } } },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'view_owner_payouts')) {
          return reply.code(403).send({ error: 'Missing permission: view_owner_payouts' });
        }
        const { rows } = await db.query(
          `SELECT * FROM owner_payouts WHERE owner_customer_id = $1
            ORDER BY period_start DESC`, [req.params.ownerCustomerId]);
        const totals = rows.reduce(
          (acc, r) => ({
            grossCollected: acc.grossCollected + (Number(r.gross_collected) || 0),
            managementFees: acc.managementFees + (Number(r.management_fee_amount) || 0),
            deductions: acc.deductions + (Number(r.other_deductions) || 0),
            netPayable: acc.netPayable + (Number(r.net_payable) || 0),
            paid: acc.paid + (r.status === 'paid' ? Number(r.net_payable) || 0 : 0),
          }),
          { grossCollected: 0, managementFees: 0, deductions: 0, netPayable: 0, paid: 0 },
        );
        return {
          ownerCustomerId: req.params.ownerCustomerId,
          totals: { ...totals, outstanding: totals.netPayable - totals.paid },
          ownerPayouts: rows.map(toApiPayout),
        };
      }),
  );
}
