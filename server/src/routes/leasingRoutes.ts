import type { FastifyInstance } from 'fastify';
import { withTenantContext } from '../db.js';
import { requireAuth } from '../auth.js';
import { PAGE_QUERY, readPage, keysetWhere, takePage } from '../pagination.js';

/**
 * Leasing: occupants, lease agreements, rent invoicing, receipts, CAM bills
 * (migration 036).
 *
 * The sales side of this ERP models a unit being bought. This is the side where
 * it is rented: a lease produces a rent invoice every month for years, which is
 * the one thing in the product that has to happen without anybody opening the
 * app. So generation is an endpoint, not a form — POST it from a cron, twice if
 * you like. Every generator here is idempotent at the DATABASE level (unique
 * keys on (lease_id, period_start) and (unit_id, period_start)), not by the
 * route remembering to check first.
 *
 * Owner payouts live in ownerPayoutsRoutes.ts: same module, but releasing money
 * to a landlord is a different permission from papering a lease.
 */

const UUID = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
const DATE = '^\\d{4}-\\d{2}-\\d{2}$';

const LEASE_STATUSES = ['draft', 'active', 'terminated', 'expired', 'renewed'] as const;
const PAY_MODES = ['cheque', 'bank_transfer', 'upi', 'cash', 'card'] as const;

async function gate(db: import('pg').PoolClient, perm: string): Promise<boolean> {
  const { rows: [{ allowed }] } = await db.query(`SELECT has_permission($1) AS allowed`, [perm]);
  return !!allowed;
}

/**
 * A `date` column, as a calendar day.
 *
 * node-postgres parses DATE into a JS Date at LOCAL midnight. JSON.stringify
 * then emits it in UTC, so east of Greenwich every date goes out a day early:
 * a period starting 2026-01-01 serialises as "2025-12-31T18:30:00.000Z" in IST.
 * On a rent period, a due date, or an escalation boundary that is not cosmetic
 * — it is the wrong month's rent and a wrong overdue flag.
 *
 * Reading the local components back out recovers the day the database stored,
 * because local midnight is exactly how it was parsed.
 */
const day = (v: unknown): string | undefined => {
  if (v == null) return undefined;
  if (!(v instanceof Date)) return String(v);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`;
};

/**
 * Constraint violations → a message the letting desk can act on.
 *
 * The two unique keys that matter are named, because "duplicate key value
 * violates unique constraint" tells a user nothing about the flat they just
 * tried to let to a second person.
 */
function mapWriteError(err: unknown): { code: number; error: string } | null {
  const e = err as { code?: string; constraint?: string; column?: string };
  switch (e?.code) {
    case '23505':
      if (e.constraint === 'lease_one_active_per_unit') {
        return { code: 409, error: 'That unit already has an active lease. Terminate or expire it first.' };
      }
      if (e.constraint === 'lease_invoices_lease_id_period_start_key') {
        return { code: 409, error: 'This lease has already been invoiced for that period.' };
      }
      if (e.constraint === 'maintenance_bills_unit_id_period_start_key') {
        return { code: 409, error: 'This unit already has a maintenance bill for that period.' };
      }
      if (e.constraint === 'lease_agreements_tenant_id_lease_code_key') {
        return { code: 409, error: 'That lease code is already in use.' };
      }
      return { code: 409, error: 'That record already exists.' };
    case '23514':
      return { code: 400, error: 'A value is out of range — check dates, percentages and the termination reason.' };
    case '23502':
      return { code: 400, error: 'A required field is missing.' };
    case '22P02':
      return { code: 400, error: 'A field has an invalid format.' };
    case '23503':
      return { code: 400, error: 'Referenced unit, occupant or owner does not exist in this workspace.' };
    default:
      return null;
  }
}

const toApiOccupant = (r: Record<string, unknown>) => ({
  id: r.id, tenantId: r.tenant_id, name: r.name,
  email: r.email ?? '', phone: r.phone ?? '',
  occupantType: r.occupant_type, companyName: r.company_name ?? '',
  kycStatus: r.kyc_status, leadId: r.lead_id ?? undefined,
  createdAt: r.created_at,
});

const toApiLease = (r: Record<string, unknown>) => ({
  id: r.id, tenantId: r.tenant_id,
  unitId: r.unit_id, occupantId: r.occupant_id,
  ownerCustomerId: r.owner_customer_id ?? undefined,
  leaseCode: r.lease_code,
  startDate: day(r.start_date), endDate: day(r.end_date),
  rentAmount: Number(r.rent_amount) || 0,
  depositAmount: Number(r.deposit_amount) || 0,
  escalationPercent: Number(r.escalation_percent) || 0,
  escalationMonths: Number(r.escalation_months) || 12,
  camRatePerSqft: Number(r.cam_rate_per_sqft) || 0,
  camBilledTo: r.cam_billed_to,
  managementFeePercent: Number(r.management_fee_percent) || 0,
  noticePeriodDays: Number(r.notice_period_days) || 0,
  status: r.status,
  terminatedOn: day(r.terminated_on),
  terminationReason: r.termination_reason ?? undefined,
  renewedFromId: r.renewed_from_id ?? undefined,
  createdBy: r.created_by ?? undefined,
  createdAt: r.created_at, updatedAt: r.updated_at,
});

const toApiLeaseInvoice = (r: Record<string, unknown>) => ({
  id: r.id, tenantId: r.tenant_id, leaseId: r.lease_id,
  periodStart: day(r.period_start), periodEnd: day(r.period_end), dueDate: day(r.due_date),
  rentAmount: Number(r.rent_amount) || 0,
  camAmount: Number(r.cam_amount) || 0,
  otherCharges: Number(r.other_charges) || 0,
  totalAmount: Number(r.total_amount) || 0,
  amountPaid: Number(r.amount_paid) || 0,
  status: r.status, createdAt: r.created_at,
});

const toApiReceipt = (r: Record<string, unknown>) => ({
  id: r.id, tenantId: r.tenant_id, leaseInvoiceId: r.lease_invoice_id,
  amount: Number(r.amount) || 0,
  paymentDate: day(r.payment_date), mode: r.mode,
  referenceNo: r.reference_no ?? '',
  receivedBy: r.received_by ?? undefined, createdAt: r.created_at,
});

const toApiMaintenanceBill = (r: Record<string, unknown>) => ({
  id: r.id, tenantId: r.tenant_id, unitId: r.unit_id,
  leaseId: r.lease_id ?? undefined, billTo: r.bill_to,
  occupantId: r.occupant_id ?? undefined,
  ownerCustomerId: r.owner_customer_id ?? undefined,
  periodStart: day(r.period_start), periodEnd: day(r.period_end),
  ratePerSqft: Number(r.rate_per_sqft) || 0,
  amount: Number(r.amount) || 0,
  dueDate: day(r.due_date),
  amountPaid: Number(r.amount_paid) || 0,
  status: r.status, notes: r.notes ?? '',
  createdBy: r.created_by ?? undefined, createdAt: r.created_at,
});

const OCCUPANT_PROPS = {
  name: { type: 'string', minLength: 1, maxLength: 160 },
  email: { type: 'string', maxLength: 160 },
  phone: { type: 'string', maxLength: 30 },
  occupantType: { type: 'string', enum: ['individual', 'company'] },
  companyName: { type: 'string', maxLength: 160 },
  kycStatus: { type: 'string', enum: ['pending', 'verified'] },
  leadId: { type: 'string', pattern: UUID },
} as const;

const LEASE_PROPS = {
  unitId: { type: 'string', pattern: UUID },
  occupantId: { type: 'string', pattern: UUID },
  ownerCustomerId: { type: 'string', pattern: UUID },
  leaseCode: { type: 'string', minLength: 1, maxLength: 40 },
  startDate: { type: 'string', pattern: DATE },
  endDate: { type: 'string', pattern: DATE },
  rentAmount: { type: 'number', minimum: 0, maximum: 1e12 },
  depositAmount: { type: 'number', minimum: 0, maximum: 1e12 },
  escalationPercent: { type: 'number', minimum: 0, maximum: 100 },
  escalationMonths: { type: 'integer', minimum: 1, maximum: 240 },
  camRatePerSqft: { type: 'number', minimum: 0, maximum: 1e6 },
  camBilledTo: { type: 'string', enum: ['occupant', 'owner'] },
  managementFeePercent: { type: 'number', minimum: 0, maximum: 100 },
  noticePeriodDays: { type: 'integer', minimum: 0, maximum: 3650 },
  status: { type: 'string', enum: LEASE_STATUSES as unknown as string[] },
  terminatedOn: { type: 'string', pattern: DATE },
  terminationReason: { type: 'string', maxLength: 500 },
  renewedFromId: { type: 'string', pattern: UUID },
} as const;

/** camelCase → column, for PATCH. Column names never come from the body. */
const LEASE_WRITABLE: Record<string, string> = {
  occupantId: 'occupant_id', ownerCustomerId: 'owner_customer_id',
  leaseCode: 'lease_code', startDate: 'start_date', endDate: 'end_date',
  rentAmount: 'rent_amount', depositAmount: 'deposit_amount',
  escalationPercent: 'escalation_percent', escalationMonths: 'escalation_months',
  camRatePerSqft: 'cam_rate_per_sqft', camBilledTo: 'cam_billed_to',
  managementFeePercent: 'management_fee_percent', noticePeriodDays: 'notice_period_days',
  status: 'status', terminatedOn: 'terminated_on', terminationReason: 'termination_reason',
  renewedFromId: 'renewed_from_id',
};

/**
 * The billing horizon: bill everything due up to and including this date.
 *
 * Defaults to the last day of the current month, so an unparameterised nightly
 * POST bills the month you are in and nothing further. Passing a date in the
 * future is legitimate (invoice a quarter ahead); it can never run past a
 * lease's own end_date, which is what actually bounds the row count.
 */
const HORIZON = `COALESCE($1::date, (date_trunc('month', CURRENT_DATE) + interval '1 month' - interval '1 day')::date)`;

/**
 * Rent invoices for every active lease (or one, when leaseId is given), for
 * every monthly period that starts on or before the horizon.
 *
 * Periods run on monthly ANNIVERSARIES of start_date — a lease signed on the
 * 15th bills the 15th, which is how the agreement reads. Postgres month
 * arithmetic clamps correctly (Jan 31 + 1 month = Feb 28), so a lease starting
 * on the 31st does not skip February.
 *
 * Escalation compounds every `escalation_months`: period n (1-based) is charged
 * rent × (1 + pct/100) ^ floor((n-1) / escalation_months).
 *
 * ON CONFLICT DO NOTHING against UNIQUE (lease_id, period_start) is what makes
 * this safe to run repeatedly — RETURNING therefore yields only what was newly
 * raised, which is exactly what the caller wants to report.
 */
async function generateRentInvoices(
  db: import('pg').PoolClient, through: string | null, leaseId: string | null,
): Promise<Record<string, unknown>[]> {
  const { rows } = await db.query(
    `INSERT INTO lease_invoices
       (tenant_id, lease_id, period_start, period_end, due_date, rent_amount, cam_amount)
     SELECT l.tenant_id,
            l.id,
            p.period_start::date,
            -- Never bill past the end of the lease itself.
            LEAST((p.period_start + interval '1 month' - interval '1 day')::date, l.end_date),
            p.period_start::date,
            round(l.rent_amount * power(1 + l.escalation_percent / 100,
                                        floor((p.n - 1)::numeric / l.escalation_months)), 2),
            -- Owner-billed CAM becomes a maintenance bill instead (see below).
            CASE WHEN l.cam_billed_to = 'occupant'
                 THEN round(u.area_sqft * l.cam_rate_per_sqft, 2)
                 ELSE 0 END
       FROM lease_agreements l
       JOIN units u ON u.id = l.unit_id AND u.tenant_id = l.tenant_id
       CROSS JOIN LATERAL generate_series(
              l.start_date::timestamp,
              LEAST(l.end_date, ${HORIZON})::timestamp,
              interval '1 month') WITH ORDINALITY AS p(period_start, n)
      WHERE l.status = 'active'
        AND ($2::uuid IS NULL OR l.id = $2::uuid)
     ON CONFLICT (lease_id, period_start) DO NOTHING
     RETURNING *`,
    [through, leaseId],
  );
  return rows;
}

/**
 * CAM bills for active leases whose maintenance is billed to the OWNER.
 * Occupant-billed CAM rides on the rent invoice above and is deliberately not
 * duplicated here.
 */
async function generateOwnerCamBills(
  db: import('pg').PoolClient, through: string | null, leaseId: string | null,
): Promise<Record<string, unknown>[]> {
  const { rows } = await db.query(
    `INSERT INTO maintenance_bills
       (tenant_id, unit_id, lease_id, bill_to, occupant_id, owner_customer_id,
        period_start, period_end, rate_per_sqft, amount, due_date, created_by)
     SELECT l.tenant_id, l.unit_id, l.id, 'owner', l.occupant_id, l.owner_customer_id,
            p.period_start::date,
            LEAST((p.period_start + interval '1 month' - interval '1 day')::date, l.end_date),
            l.cam_rate_per_sqft,
            round(u.area_sqft * l.cam_rate_per_sqft, 2),
            p.period_start::date,
            app_current_user()
       FROM lease_agreements l
       JOIN units u ON u.id = l.unit_id AND u.tenant_id = l.tenant_id
       CROSS JOIN LATERAL generate_series(
              l.start_date::timestamp,
              LEAST(l.end_date, ${HORIZON})::timestamp,
              interval '1 month') AS p(period_start)
      WHERE l.status = 'active'
        AND l.cam_billed_to = 'owner'
        AND l.cam_rate_per_sqft > 0
        AND ($2::uuid IS NULL OR l.id = $2::uuid)
     ON CONFLICT (unit_id, period_start) DO NOTHING
     RETURNING *`,
    [through, leaseId],
  );
  return rows;
}

export async function leasingRoutes(app: FastifyInstance): Promise<void> {
  // ── Occupants ──────────────────────────────────────────────────────────────

  app.get('/api/occupants', { preHandler: requireAuth }, async (req, reply) =>
    withTenantContext(req.ctx, async (db) => {
      if (!await gate(db, 'view_leasing')) {
        return reply.code(403).send({ error: 'Missing permission: view_leasing' });
      }
      const { rows } = await db.query(`SELECT * FROM occupants ORDER BY created_at DESC`);
      return { occupants: rows.map(toApiOccupant) };
    }),
  );

  app.post<{ Body: Record<string, unknown> }>(
    '/api/occupants',
    {
      preHandler: requireAuth,
      schema: { body: { type: 'object', required: ['name'], additionalProperties: false, properties: OCCUPANT_PROPS } },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'manage_leasing')) {
          return reply.code(403).send({ error: 'Missing permission: manage_leasing' });
        }
        const b = req.body as Record<string, string | undefined>;
        try {
          const { rows } = await db.query(
            `INSERT INTO occupants (tenant_id, name, email, phone, occupant_type, company_name, kyc_status, lead_id)
             VALUES (app_current_tenant(), $1, $2, COALESCE($3,''), COALESCE($4,'individual'), $5, COALESCE($6,'pending'), $7)
             RETURNING *`,
            [b.name, b.email || null, b.phone ?? null, b.occupantType ?? null,
             b.companyName || null, b.kycStatus ?? null, b.leadId ?? null]);
          reply.code(201);
          return { occupant: toApiOccupant(rows[0]) };
        } catch (err) {
          const mapped = mapWriteError(err);
          if (!mapped) throw err;
          return reply.code(mapped.code).send({ error: mapped.error });
        }
      }),
  );

  app.patch<{ Params: { id: string }; Body: Record<string, unknown> }>(
    '/api/occupants/:id',
    {
      preHandler: requireAuth,
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: UUID } } },
        body: { type: 'object', minProperties: 1, additionalProperties: false, properties: OCCUPANT_PROPS },
      },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'manage_leasing')) {
          return reply.code(403).send({ error: 'Missing permission: manage_leasing' });
        }
        const COLS: Record<string, string> = {
          name: 'name', email: 'email', phone: 'phone', occupantType: 'occupant_type',
          companyName: 'company_name', kycStatus: 'kyc_status', leadId: 'lead_id',
        };
        const sets: string[] = []; const params: unknown[] = [];
        for (const [k, col] of Object.entries(COLS)) {
          const v = (req.body as Record<string, unknown>)[k];
          if (v !== undefined) { params.push(v); sets.push(`${col} = $${params.length}`); }
        }
        if (!sets.length) return reply.code(400).send({ error: 'No writable fields supplied' });
        params.push(req.params.id);
        try {
          const { rows } = await db.query(
            `UPDATE occupants SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`, params);
          if (!rows[0]) return reply.code(404).send({ error: 'Occupant not found' });
          return { occupant: toApiOccupant(rows[0]) };
        } catch (err) {
          const mapped = mapWriteError(err);
          if (!mapped) throw err;
          return reply.code(mapped.code).send({ error: mapped.error });
        }
      }),
  );

  // ── Lease agreements ───────────────────────────────────────────────────────

  app.get<{ Querystring: { status?: string; unitId?: string; expiringInDays?: number } }>(
    '/api/leases',
    {
      preHandler: requireAuth,
      schema: { querystring: { type: 'object', additionalProperties: false, properties: {
        status: { type: 'string', enum: LEASE_STATUSES as unknown as string[] },
        unitId: { type: 'string', pattern: UUID },
        // The renewals desk's daily question, served off idx_leases_tenant_expiry.
        expiringInDays: { type: 'integer', minimum: 1, maximum: 3650 },
      } } },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'view_leasing')) {
          return reply.code(403).send({ error: 'Missing permission: view_leasing' });
        }
        const where: string[] = []; const params: unknown[] = [];
        if (req.query.status) { params.push(req.query.status); where.push(`status = $${params.length}`); }
        if (req.query.unitId) { params.push(req.query.unitId); where.push(`unit_id = $${params.length}`); }
        if (req.query.expiringInDays) {
          params.push(req.query.expiringInDays);
          where.push(`status = 'active' AND end_date <= CURRENT_DATE + ($${params.length}::int * interval '1 day')`);
        }
        const { rows} = await db.query(
          `SELECT * FROM lease_agreements
            ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
            ORDER BY start_date DESC, created_at DESC`, params);
        return { leases: rows.map(toApiLease) };
      }),
  );

  app.post<{ Body: Record<string, unknown> }>(
    '/api/leases',
    {
      preHandler: requireAuth,
      schema: { body: {
        type: 'object',
        required: ['unitId', 'occupantId', 'startDate', 'endDate', 'rentAmount'],
        additionalProperties: false, properties: LEASE_PROPS,
      } },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'manage_leasing')) {
          return reply.code(403).send({ error: 'Missing permission: manage_leasing' });
        }
        const b = req.body as Record<string, string | number | undefined>;
        try {
          const { rows } = await db.query(
            `INSERT INTO lease_agreements
               (tenant_id, unit_id, occupant_id, owner_customer_id, lease_code,
                start_date, end_date, rent_amount, deposit_amount,
                escalation_percent, escalation_months, cam_rate_per_sqft, cam_billed_to,
                management_fee_percent, notice_period_days, status, renewed_from_id, created_by)
             VALUES (app_current_tenant(), $1, $2, $3,
                     -- A human-readable code if the caller did not supply one.
                     COALESCE($4, 'L-' || to_char(CURRENT_DATE, 'YYYY') || '-' ||
                                  upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 6))),
                     $5, $6, $7, COALESCE($8, 0),
                     COALESCE($9, 0), COALESCE($10, 12), COALESCE($11, 0), COALESCE($12, 'occupant'),
                     COALESCE($13, 0), COALESCE($14, 30), COALESCE($15, 'draft'), $16, app_current_user())
             RETURNING *`,
            [b.unitId, b.occupantId, b.ownerCustomerId ?? null, b.leaseCode ?? null,
             b.startDate, b.endDate, b.rentAmount, b.depositAmount ?? null,
             b.escalationPercent ?? null, b.escalationMonths ?? null,
             b.camRatePerSqft ?? null, b.camBilledTo ?? null,
             b.managementFeePercent ?? null, b.noticePeriodDays ?? null,
             b.status ?? null, b.renewedFromId ?? null]);
          reply.code(201);
          return { lease: toApiLease(rows[0]) };
        } catch (err) {
          const mapped = mapWriteError(err);
          if (!mapped) throw err;
          return reply.code(mapped.code).send({ error: mapped.error });
        }
      }),
  );

  app.patch<{ Params: { id: string }; Body: Record<string, unknown> }>(
    '/api/leases/:id',
    {
      preHandler: requireAuth,
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: UUID } } },
        body: { type: 'object', minProperties: 1, additionalProperties: false, properties: LEASE_PROPS },
      },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'manage_leasing')) {
          return reply.code(403).send({ error: 'Missing permission: manage_leasing' });
        }
        const body = req.body as Record<string, unknown>;
        const sets: string[] = []; const params: unknown[] = [];
        for (const [k, col] of Object.entries(LEASE_WRITABLE)) {
          const v = body[k];
          if (v !== undefined) { params.push(v); sets.push(`${col} = $${params.length}`); }
        }
        // Terminating stamps the date if the caller did not, so the DB CHECK
        // that demands a reason is the only thing they have to think about.
        if (body.status === 'terminated' && body.terminatedOn === undefined) {
          sets.push(`terminated_on = COALESCE(terminated_on, CURRENT_DATE)`);
        }
        if (!sets.length) return reply.code(400).send({ error: 'No writable fields supplied' });
        params.push(req.params.id);
        try {
          const { rows } = await db.query(
            `UPDATE lease_agreements SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`, params);
          if (!rows[0]) return reply.code(404).send({ error: 'Lease not found' });
          return { lease: toApiLease(rows[0]) };
        } catch (err) {
          const mapped = mapWriteError(err);
          if (!mapped) throw err;
          return reply.code(mapped.code).send({ error: mapped.error });
        }
      }),
  );

  // ── Rent invoicing ─────────────────────────────────────────────────────────

  /**
   * POST /api/leases/:id/generate-invoices — catch one lease up to the horizon.
   * Used when a lease is signed mid-year and needs its back periods raised.
   */
  app.post<{ Params: { id: string }; Body: { through?: string } }>(
    '/api/leases/:id/generate-invoices',
    {
      preHandler: requireAuth,
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: UUID } } },
        body: { type: 'object', additionalProperties: false, properties: { through: { type: 'string', pattern: DATE } } },
      },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'manage_leasing')) {
          return reply.code(403).send({ error: 'Missing permission: manage_leasing' });
        }
        const { rows: [lease] } = await db.query(
          `SELECT id, status FROM lease_agreements WHERE id = $1`, [req.params.id]);
        if (!lease) return reply.code(404).send({ error: 'Lease not found' });
        if (lease.status !== 'active') {
          return reply.code(409).send({ error: `Only an active lease can be invoiced (this one is ${lease.status}).` });
        }
        const through = req.body?.through ?? null;
        const invoices = await generateRentInvoices(db, through, req.params.id);
        const camBills = await generateOwnerCamBills(db, through, req.params.id);
        reply.code(201);
        return {
          created: invoices.length,
          invoices: invoices.map(toApiLeaseInvoice),
          maintenanceBills: camBills.map(toApiMaintenanceBill),
        };
      }),
  );

  /**
   * POST /api/leasing/run-billing — the monthly run for the whole workspace.
   *
   * Safe to call from a scheduler at any frequency: the unique keys make a
   * second run in the same period a no-op, and the response reports only what
   * was newly raised.
   */
  app.post<{ Body: { through?: string } }>(
    '/api/leasing/run-billing',
    {
      preHandler: requireAuth,
      schema: { body: { type: 'object', additionalProperties: false, properties: { through: { type: 'string', pattern: DATE } } } },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'manage_leasing')) {
          return reply.code(403).send({ error: 'Missing permission: manage_leasing' });
        }
        const through = req.body?.through ?? null;
        const invoices = await generateRentInvoices(db, through, null);
        const camBills = await generateOwnerCamBills(db, through, null);
        return {
          rentInvoicesCreated: invoices.length,
          maintenanceBillsCreated: camBills.length,
          invoices: invoices.map(toApiLeaseInvoice),
          maintenanceBills: camBills.map(toApiMaintenanceBill),
        };
      }),
  );

  app.get<{ Querystring: { leaseId?: string; status?: string; overdue?: boolean } }>(
    '/api/lease-invoices',
    {
      preHandler: requireAuth,
      schema: { querystring: { type: 'object', additionalProperties: false, properties: {
        leaseId: { type: 'string', pattern: UUID },
        status: { type: 'string', enum: ['pending', 'partially_paid', 'paid', 'cancelled'] },
        overdue: { type: 'boolean' },
      } } },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'view_leasing')) {
          return reply.code(403).send({ error: 'Missing permission: view_leasing' });
        }
        const where: string[] = []; const params: unknown[] = [];
        if (req.query.leaseId) { params.push(req.query.leaseId); where.push(`lease_id = $${params.length}`); }
        if (req.query.status) { params.push(req.query.status); where.push(`status = $${params.length}`); }
        if (req.query.overdue) where.push(`due_date < CURRENT_DATE AND status IN ('pending', 'partially_paid')`);
        const { rows } = await db.query(
          `SELECT * FROM lease_invoices
            ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
            ORDER BY period_start DESC, created_at DESC`, params);
        return { leaseInvoices: rows.map(toApiLeaseInvoice) };
      }),
  );

  /**
   * PATCH /api/lease-invoices/:id — adjustments only.
   *
   * `amount_paid` and `status` are NOT writable here: both are derived from
   * receipts by the database trigger in 036. The one status move a human owns
   * is cancelling an invoice that should never have been raised.
   */
  app.patch<{ Params: { id: string }; Body: { otherCharges?: number; status?: string; dueDate?: string } }>(
    '/api/lease-invoices/:id',
    {
      preHandler: requireAuth,
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: UUID } } },
        body: { type: 'object', minProperties: 1, additionalProperties: false, properties: {
          otherCharges: { type: 'number', minimum: -1e12, maximum: 1e12 },
          status: { type: 'string', enum: ['pending', 'cancelled'] },
          dueDate: { type: 'string', pattern: DATE },
        } },
      },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'manage_leasing')) {
          return reply.code(403).send({ error: 'Missing permission: manage_leasing' });
        }
        const COLS: Record<string, string> = {
          otherCharges: 'other_charges', status: 'status', dueDate: 'due_date',
        };
        const sets: string[] = []; const params: unknown[] = [];
        for (const [k, col] of Object.entries(COLS)) {
          const v = (req.body as Record<string, unknown>)[k];
          if (v !== undefined) { params.push(v); sets.push(`${col} = $${params.length}`); }
        }
        if (!sets.length) return reply.code(400).send({ error: 'No writable fields supplied' });
        params.push(req.params.id);
        try {
          const { rows } = await db.query(
            `UPDATE lease_invoices SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`, params);
          if (!rows[0]) return reply.code(404).send({ error: 'Invoice not found' });
          return { leaseInvoice: toApiLeaseInvoice(rows[0]) };
        } catch (err) {
          const mapped = mapWriteError(err);
          if (!mapped) throw err;
          return reply.code(mapped.code).send({ error: mapped.error });
        }
      }),
  );

  // ── Receipts ───────────────────────────────────────────────────────────────

  app.get<{ Querystring: { leaseInvoiceId?: string; limit?: number; cursor?: string } }>(
    '/api/lease-receipts',
    {
      preHandler: requireAuth,
      schema: { querystring: { type: 'object', additionalProperties: false, properties: {
        leaseInvoiceId: { type: 'string', pattern: UUID },
        ...PAGE_QUERY,
      } } },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'view_leasing')) {
          return reply.code(403).send({ error: 'Missing permission: view_leasing' });
        }
        // Scoped by invoice, this is a handful of rows and pages would be
        // noise. Unscoped, it is every receipt the portfolio has ever taken —
        // so only that branch pages.
        if (req.query.leaseInvoiceId) {
          const { rows } = await db.query(
            `SELECT * FROM lease_receipts WHERE lease_invoice_id = $1 ORDER BY payment_date DESC`,
            [req.query.leaseInvoiceId]);
          return { leaseReceipts: rows.map(toApiReceipt), nextCursor: null };
        }
        const page = readPage(req.query);
        const ks = keysetWhere(page, 'created_at', 'id', 1);
        const { rows } = await db.query(
          `SELECT * FROM lease_receipts
            ${ks.sql ? `WHERE ${ks.sql}` : ''}
            ORDER BY created_at DESC, id DESC
            LIMIT ${page.limit + 1}`,
          ks.params);
        const out = takePage(rows, page, 'created_at');
        return { leaseReceipts: out.rows.map(toApiReceipt), nextCursor: out.nextCursor };
      }),
  );

  /**
   * POST /api/lease-receipts — money in.
   *
   * The invoice's amount_paid and status are updated by the trigger, in the
   * same transaction, so the invoice returned alongside is already correct.
   */
  app.post<{ Body: Record<string, unknown> }>(
    '/api/lease-receipts',
    {
      preHandler: requireAuth,
      schema: { body: {
        type: 'object', required: ['leaseInvoiceId', 'amount'], additionalProperties: false,
        properties: {
          leaseInvoiceId: { type: 'string', pattern: UUID },
          amount: { type: 'number', exclusiveMinimum: 0, maximum: 1e12 },
          paymentDate: { type: 'string', pattern: DATE },
          mode: { type: 'string', enum: PAY_MODES as unknown as string[] },
          referenceNo: { type: 'string', maxLength: 120 },
        },
      } },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'manage_leasing')) {
          return reply.code(403).send({ error: 'Missing permission: manage_leasing' });
        }
        const b = req.body as Record<string, string | number | undefined>;
        try {
          const { rows } = await db.query(
            `INSERT INTO lease_receipts
               (tenant_id, lease_invoice_id, amount, payment_date, mode, reference_no, received_by)
             VALUES (app_current_tenant(), $1, $2, COALESCE($3::date, CURRENT_DATE),
                     COALESCE($4, 'bank_transfer'), $5, app_current_user())
             RETURNING *`,
            [b.leaseInvoiceId, b.amount, b.paymentDate ?? null, b.mode ?? null, b.referenceNo ?? null]);
          const { rows: [invoice] } = await db.query(
            `SELECT * FROM lease_invoices WHERE id = $1`, [b.leaseInvoiceId]);
          reply.code(201);
          return {
            leaseReceipt: toApiReceipt(rows[0]),
            leaseInvoice: invoice ? toApiLeaseInvoice(invoice) : undefined,
          };
        } catch (err) {
          const mapped = mapWriteError(err);
          if (!mapped) throw err;
          return reply.code(mapped.code).send({ error: mapped.error });
        }
      }),
  );

  // ── Maintenance / CAM bills ────────────────────────────────────────────────

  app.get<{ Querystring: { unitId?: string; leaseId?: string; status?: string } }>(
    '/api/maintenance-bills',
    {
      preHandler: requireAuth,
      schema: { querystring: { type: 'object', additionalProperties: false, properties: {
        unitId: { type: 'string', pattern: UUID },
        leaseId: { type: 'string', pattern: UUID },
        status: { type: 'string', enum: ['pending', 'partially_paid', 'paid', 'waived'] },
      } } },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'view_leasing')) {
          return reply.code(403).send({ error: 'Missing permission: view_leasing' });
        }
        const where: string[] = []; const params: unknown[] = [];
        if (req.query.unitId) { params.push(req.query.unitId); where.push(`unit_id = $${params.length}`); }
        if (req.query.leaseId) { params.push(req.query.leaseId); where.push(`lease_id = $${params.length}`); }
        if (req.query.status) { params.push(req.query.status); where.push(`status = $${params.length}`); }
        const { rows } = await db.query(
          `SELECT * FROM maintenance_bills
            ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
            ORDER BY period_start DESC, created_at DESC`, params);
        return { maintenanceBills: rows.map(toApiMaintenanceBill) };
      }),
  );

  /**
   * POST /api/maintenance-bills — the manual path, for a unit with no lease to
   * generate from (vacant, or occupied by its owner).
   */
  app.post<{ Body: Record<string, unknown> }>(
    '/api/maintenance-bills',
    {
      preHandler: requireAuth,
      schema: { body: {
        type: 'object', required: ['unitId', 'periodStart', 'periodEnd', 'amount'],
        additionalProperties: false,
        properties: {
          unitId: { type: 'string', pattern: UUID },
          leaseId: { type: 'string', pattern: UUID },
          billTo: { type: 'string', enum: ['occupant', 'owner'] },
          occupantId: { type: 'string', pattern: UUID },
          ownerCustomerId: { type: 'string', pattern: UUID },
          periodStart: { type: 'string', pattern: DATE },
          periodEnd: { type: 'string', pattern: DATE },
          ratePerSqft: { type: 'number', minimum: 0, maximum: 1e6 },
          amount: { type: 'number', minimum: 0, maximum: 1e12 },
          dueDate: { type: 'string', pattern: DATE },
          notes: { type: 'string', maxLength: 500 },
        },
      } },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'manage_leasing')) {
          return reply.code(403).send({ error: 'Missing permission: manage_leasing' });
        }
        const b = req.body as Record<string, string | number | undefined>;
        try {
          const { rows } = await db.query(
            `INSERT INTO maintenance_bills
               (tenant_id, unit_id, lease_id, bill_to, occupant_id, owner_customer_id,
                period_start, period_end, rate_per_sqft, amount, due_date, notes, created_by)
             VALUES (app_current_tenant(), $1, $2, COALESCE($3,'occupant'), $4, $5,
                     $6, $7, COALESCE($8, 0), $9, COALESCE($10::date, $6::date), COALESCE($11,''), app_current_user())
             RETURNING *`,
            [b.unitId, b.leaseId ?? null, b.billTo ?? null, b.occupantId ?? null, b.ownerCustomerId ?? null,
             b.periodStart, b.periodEnd, b.ratePerSqft ?? null, b.amount, b.dueDate ?? null, b.notes ?? null]);
          reply.code(201);
          return { maintenanceBill: toApiMaintenanceBill(rows[0]) };
        } catch (err) {
          const mapped = mapWriteError(err);
          if (!mapped) throw err;
          return reply.code(mapped.code).send({ error: mapped.error });
        }
      }),
  );

  app.patch<{ Params: { id: string }; Body: Record<string, unknown> }>(
    '/api/maintenance-bills/:id',
    {
      preHandler: requireAuth,
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: UUID } } },
        body: { type: 'object', minProperties: 1, additionalProperties: false, properties: {
          amount: { type: 'number', minimum: 0, maximum: 1e12 },
          amountPaid: { type: 'number', minimum: 0, maximum: 1e12 },
          dueDate: { type: 'string', pattern: DATE },
          status: { type: 'string', enum: ['pending', 'partially_paid', 'paid', 'waived'] },
          notes: { type: 'string', maxLength: 500 },
        } },
      },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'manage_leasing')) {
          return reply.code(403).send({ error: 'Missing permission: manage_leasing' });
        }
        const COLS: Record<string, string> = {
          amount: 'amount', amountPaid: 'amount_paid', dueDate: 'due_date',
          status: 'status', notes: 'notes',
        };
        const sets: string[] = []; const params: unknown[] = [];
        for (const [k, col] of Object.entries(COLS)) {
          const v = (req.body as Record<string, unknown>)[k];
          if (v !== undefined) { params.push(v); sets.push(`${col} = $${params.length}`); }
        }
        if (!sets.length) return reply.code(400).send({ error: 'No writable fields supplied' });
        params.push(req.params.id);
        try {
          const { rows } = await db.query(
            `UPDATE maintenance_bills SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`, params);
          if (!rows[0]) return reply.code(404).send({ error: 'Maintenance bill not found' });
          return { maintenanceBill: toApiMaintenanceBill(rows[0]) };
        } catch (err) {
          const mapped = mapWriteError(err);
          if (!mapped) throw err;
          return reply.code(mapped.code).send({ error: mapped.error });
        }
      }),
  );
}
