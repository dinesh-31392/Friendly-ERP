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
          type: 'object', required: ['leadId', 'unitId', 'totalAmount', 'validUntil'],
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
          const { cols, exprs, params } = collectWrites(req.body);
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
          const { rows: found } = await db.query('SELECT 1 FROM quotations WHERE id = $1', [req.params.id]);
          if (found.length === 0) return reply.code(404).send({ error: 'Quotation not found' });
          const { cols, exprs, params } = collectWrites(req.body);
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
