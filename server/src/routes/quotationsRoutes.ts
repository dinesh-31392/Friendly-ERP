import type { FastifyInstance } from 'fastify';
import { withTenantContext } from '../db.js';
import { requireAuth } from '../auth.js';

const UUID = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

const STATUSES = ['draft', 'pending_approval', 'sent', 'accepted', 'rejected', 'expired'] as const;

/**
 * DB row → the SPA's `Quotation` shape. Renames: base_amount↔baseAmount,
 * additional_charges↔charges, discount_amount↔discountAmount,
 * discount_approved_by↔discountApprovedBy, total_amount↔totalAmount,
 * valid_until↔validUntil, created_by↔createdBy. `valid_until` is a DATE — we
 * pull it as a 'YYYY-MM-DD' string (val_str) so it round-trips without a
 * timezone shift.
 */
function toApiQuotation(r: Record<string, unknown>) {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    leadId: r.lead_id,
    unitId: r.unit_id,
    baseAmount: Number(r.base_amount) || 0,
    charges: (r.additional_charges as { label: string; amount: number }[] | null) ?? [],
    discountAmount: Number(r.discount_amount) || 0,
    discountApprovedBy: (r.discount_approved_by as string | null) ?? undefined,
    totalAmount: Number(r.total_amount) || 0,
    validUntil: (r.val_str as string) ?? '',
    status: r.status,
    createdBy: (r.created_by as string | null) ?? '',
    createdAt: r.created_at,
  };
}

// scalar camelCase → column. charges is handled specially (jsonb); lead_id/
// unit_id are create-only; created_by/tenant_id are DB-owned.
const WRITABLE: Record<string, string> = {
  baseAmount: 'base_amount',
  discountAmount: 'discount_amount',
  discountApprovedBy: 'discount_approved_by',
  totalAmount: 'total_amount',
  validUntil: 'valid_until',
  status: 'status',
};

const PROPS = {
  baseAmount: { type: 'number', minimum: 0, maximum: 1e12 },
  charges: { type: 'array', maxItems: 60, items: { type: 'object', required: ['label', 'amount'], additionalProperties: false, properties: { label: { type: 'string', maxLength: 120 }, amount: { type: 'number', minimum: 0, maximum: 1e12 } } } },
  discountAmount: { type: 'number', minimum: 0, maximum: 1e12 },
  discountApprovedBy: { type: 'string', pattern: UUID },
  totalAmount: { type: 'number', minimum: 0, maximum: 1e12 },
  validUntil: { type: 'string', maxLength: 40 },
  status: { type: 'string', enum: STATUSES as unknown as string[] },
} as const;

interface QuotationBody {
  leadId?: string; unitId?: string; baseAmount?: number;
  charges?: { label: string; amount: number }[]; discountAmount?: number;
  discountApprovedBy?: string; totalAmount?: number; validUntil?: string; status?: string;
}

const SELECT = `SELECT q.*, to_char(q.valid_until, 'YYYY-MM-DD') AS val_str FROM quotations q`;

function mapWriteError(err: unknown): { error: string } | null {
  switch ((err as { code?: string })?.code) {
    case '23514': return { error: `Invalid value — status must be one of: ${STATUSES.join(', ')} (and total_amount must be ≥ 0).` };
    case '23503': return { error: 'The referenced lead or unit does not exist.' };
    case '23502': return { error: 'A required field is missing.' };
    case '22P02': case '22007': return { error: 'A field has an invalid value.' };
    default: return null;
  }
}

/** Scalar writes + the jsonb charges column. */
function collectWrites(body: QuotationBody) {
  const cols: string[] = [];
  const exprs: string[] = [];
  const params: unknown[] = [];
  const add = (col: string, value: unknown, cast = '') => {
    params.push(value);
    cols.push(col);
    exprs.push(`$${params.length}${cast}`);
  };
  for (const [key, col] of Object.entries(WRITABLE)) {
    if (body[key as keyof QuotationBody] === undefined) continue;
    add(col, body[key as keyof QuotationBody]);
  }
  if (body.charges !== undefined) add('additional_charges', JSON.stringify(body.charges), '::jsonb');
  return { cols, exprs, params };
}

/**
 * Who is allowed to approve a discount, and on which quotation.
 *
 * THE HOLE THIS CLOSES
 *
 * The routing decision lived entirely in the browser. Bookings.tsx computed
 *
 *   const parked = discountNeedsApproval && !canApproveDiscount;
 *   discountApprovedBy: ... canApproveDiscount ? actor.id : undefined,
 *   status: parked ? 'pending_approval' : 'draft',
 *
 * and POSTed the result, while this route gated only on create_quotations and
 * took discount_approved_by and status as ordinary writable columns. So the
 * control was advisory: a sales executive holding create_quotations but NOT
 * approve_discounts could send {discountApprovedBy: <self>, status: 'draft'} and
 * self-approve any discount. Verified against the running API — a ₹9,00,000
 * discount, nine times the default threshold, went live with the rep recorded
 * as its own approver.
 *
 * THE RULE
 *
 * discount_approved_by is never accepted from the caller; it is derived. Above
 * the tenant's threshold the quotation parks in pending_approval unless the
 * caller holds approve_discounts, in which case they are stamped as the
 * approver. Below the threshold no approval is involved and the column stays
 * null, so a stamp always means a real decision by someone entitled to make it.
 *
 * The threshold mirrors the SPA's DEFAULTS.discount so an unconfigured
 * workspace behaves the same on both sides; approval_workflows overrides it
 * per tenant, under the '_approval' spelling the CHECK constraint requires.
 */
const DISCOUNT_DEFAULT = 100_000;

async function discountRuling(db: import('pg').PoolClient, discountAmount: unknown) {
  const amount = Number(discountAmount ?? 0);
  if (!(amount > 0)) return { parks: false, stamp: false };
  const { rows: [rule] } = await db.query(
    `SELECT threshold_amount FROM approval_workflows WHERE action_type = 'discount_approval' LIMIT 1`);
  const threshold = rule?.threshold_amount === null || rule?.threshold_amount === undefined
    ? DISCOUNT_DEFAULT : Number(rule.threshold_amount);
  if (amount < threshold) return { parks: false, stamp: false };
  const { rows: [{ allowed }] } = await db.query(`SELECT has_permission('approve_discounts') AS allowed`);
  return allowed ? { parks: false, stamp: true } : { parks: true, stamp: false };
}

export async function quotationsRoutes(app: FastifyInstance): Promise<void> {
  /** GET /api/quotations — RLS-scoped; view_bookings gates (quotes live on the
   *  bookings page). */
  app.get('/api/quotations', { preHandler: requireAuth }, async (req, reply) =>
    withTenantContext(req.ctx, async (db) => {
      const { rows: [{ allowed }] } = await db.query(`SELECT has_permission('view_bookings') AS allowed`);
      if (!allowed) return reply.code(403).send({ error: 'Missing permission: view_bookings' });
      const { rows } = await db.query(`${SELECT} ORDER BY q.created_at DESC`);
      return { quotations: rows.map(toApiQuotation) };
    }),
  );

  /** POST /api/quotations — create. created_by is the current user. */
  app.post<{ Body: QuotationBody }>(
    '/api/quotations',
    {
      preHandler: requireAuth,
      schema: {
        body: {
          // base_amount is NOT NULL with no default, so omitting it passed
          // validation and then failed the INSERT — surfacing as the generic
          // "A required field is missing." with no field named. The SPA always
          // sends it, so this breaks no working caller; it turns a dead end into
          // a message that says which field.
          type: 'object', required: ['leadId', 'unitId', 'baseAmount', 'totalAmount', 'validUntil'],
          additionalProperties: false,
          properties: { leadId: { type: 'string', pattern: UUID }, unitId: { type: 'string', pattern: UUID }, ...PROPS },
        },
      },
    },
    async (req, reply) => {
      try {
        return await withTenantContext(req.ctx, async (db) => {
          const { rows: [{ allowed }] } = await db.query(`SELECT has_permission('create_quotations') AS allowed`);
          if (!allowed) return reply.code(403).send({ error: 'Missing permission: create_quotations' });
          // The server decides the discount routing; the caller's own view of it
          // is discarded, including any discountApprovedBy they tried to supply.
          const ruling = await discountRuling(db, req.body.discountAmount);
          const { cols, exprs, params } = collectWrites({
            ...req.body,
            discountApprovedBy: undefined,
            status: ruling.parks ? 'pending_approval' : req.body.status,
          });
          if (ruling.stamp) { cols.push('discount_approved_by'); exprs.push('app_current_user()'); }
          params.push(req.body.leadId, req.body.unitId);
          const leadPh = `$${params.length - 1}`;
          const unitPh = `$${params.length}`;
          const { rows } = await db.query(
            `WITH ins AS (
               INSERT INTO quotations (tenant_id, lead_id, unit_id, created_by${cols.length ? ', ' + cols.join(', ') : ''})
               VALUES (app_current_tenant(), ${leadPh}, ${unitPh}, app_current_user()${exprs.length ? ', ' + exprs.join(', ') : ''})
               RETURNING *
             )
             ${SELECT.replace('FROM quotations q', 'FROM ins q')}`,
            params,
          );
          reply.code(201); return { quotation: toApiQuotation(rows[0]) };
        });
      } catch (err) {
        const mapped = mapWriteError(err);
        if (mapped) return reply.code(400).send(mapped);
        throw err;
      }
    },
  );

  /** PATCH /api/quotations/:id — advance status / record discount approval. */
  app.patch<{ Params: { id: string }; Body: QuotationBody }>(
    '/api/quotations/:id',
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
          const { rows: [{ allowed }] } = await db.query(`SELECT has_permission('create_quotations') AS allowed`);
          if (!allowed) return reply.code(403).send({ error: 'Missing permission: create_quotations' });
          const { rows: found } = await db.query(
            'SELECT status, discount_amount FROM quotations WHERE id = $1', [req.params.id]);
          if (found.length === 0) return reply.code(404).send({ error: 'Quotation not found' });

          // Releasing a parked quotation IS the approval — the one moment the
          // discount takes effect — so it needs the key regardless of which
          // status it is being moved to.
          const releasing = found[0].status === 'pending_approval'
            && req.body.status !== undefined && req.body.status !== 'pending_approval';
          if (releasing) {
            const { rows: [{ allowed: mayApprove }] } = await db.query(
              `SELECT has_permission('approve_discounts') AS allowed`);
            if (!mayApprove) return reply.code(403).send({ error: 'Missing permission: approve_discounts' });
          }
          // Only re-rule when the discount ITSELF moves. Re-running it on every
          // edit would re-park a quotation a manager had already approved
          // because a rep corrected an unrelated field.
          const ruling = req.body.discountAmount !== undefined
            ? await discountRuling(db, req.body.discountAmount)
            : { parks: false, stamp: false };
          const { cols, exprs, params } = collectWrites({
            ...req.body,
            discountApprovedBy: undefined,
            status: ruling.parks ? 'pending_approval' : req.body.status,
          });
          // Raising a discount past the threshold voids the approval it had:
          // what was signed off is no longer what the quotation says.
          if (ruling.parks) { cols.push('discount_approved_by'); exprs.push('NULL'); }
          if (ruling.stamp) { cols.push('discount_approved_by'); exprs.push('app_current_user()'); }
          if (cols.length === 0) return reply.code(400).send({ error: 'No writable fields supplied' });
          const sets = cols.map((c, i) => `${c} = ${exprs[i]}`);
          params.push(req.params.id);
          const { rows } = await db.query(
            `WITH upd AS (
               UPDATE quotations SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *
             )
             ${SELECT.replace('FROM quotations q', 'FROM upd q')}`,
            params,
          );
          return { quotation: toApiQuotation(rows[0]) };
        });
      } catch (err) {
        const mapped = mapWriteError(err);
        if (mapped) return reply.code(400).send(mapped);
        throw err;
      }
    },
  );
}
