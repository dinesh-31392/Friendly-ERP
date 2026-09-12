import type { FastifyInstance } from 'fastify';
import { withTenantContext } from '../db.js';
import { requireAuth } from '../auth.js';
import {
  buildGstr1, buildGstr3b, isValidGstin, splitTax, stateOfGstin,
  type GstInvoice,
} from '../gst.js';
import { contentDisposition, NOSNIFF } from '../storage.js';

/**
 * GST return preparation (migration 056).
 *
 * The review's finding was that statutory tax was tracked and not computed.
 * 194-IA came first because it attaches a duty to a transaction the ERP already
 * records; this is the other half.
 *
 * Prepared, not filed. Nothing here talks to GSTN — filing needs a digital
 * signature or an EVC against the authorised signatory's own credentials, and
 * a system that held those would be holding the ability to file a return in
 * somebody's name. The output is what the offline tool ingests, and the ARN
 * comes back the other way.
 */

const UUID = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
const PERIOD = '^[0-9]{6}$';

async function gate(db: import('pg').PoolClient, perm: string): Promise<boolean> {
  const { rows: [{ allowed }] } = await db.query(`SELECT has_permission($1) AS allowed`, [perm]);
  return !!allowed;
}

const toApiInvoice = (r: Record<string, unknown>): GstInvoice => ({
  invoiceNo: (r.invoice_no as string) || String(r.id).slice(0, 8).toUpperCase(),
  issueDate: String(r.issue_date).slice(0, 10),
  customerName: (r.lead_name as string) ?? '',
  customerGstin: (r.customer_gstin as string) || '',
  placeOfSupply: (r.place_of_supply as string) || '',
  taxableValue: Number(r.taxable_value),
  gstRate: Number(r.gst_rate),
  cgst: Number(r.cgst),
  sgst: Number(r.sgst),
  igst: Number(r.igst),
  hsnSac: (r.hsn_sac as string) || '9954',
  postCompletion: !!r.post_completion,
});

/** MMYYYY → the first and last day of that month. */
function periodRange(period: string): { from: string; to: string } {
  const mm = period.slice(0, 2);
  const yyyy = period.slice(2);
  const last = new Date(Number(yyyy), Number(mm), 0).getDate();
  return { from: `${yyyy}-${mm}-01`, to: `${yyyy}-${mm}-${String(last).padStart(2, '0')}` };
}

const toApiReturn = (r: Record<string, unknown>, withPayload = false) => ({
  id: r.id,
  form: r.form,
  period: r.period,
  status: r.status,
  taxableValue: Number(r.taxable_value),
  cgst: Number(r.cgst),
  sgst: Number(r.sgst),
  igst: Number(r.igst),
  invoiceCount: Number(r.invoice_count),
  preparedAt: r.prepared_at,
  filedAt: r.filed_at ?? null,
  arn: r.arn ?? '',
  ...(withPayload ? { payload: r.payload } : {}),
});

export async function gstRoutes(app: FastifyInstance): Promise<void> {
  /**
   * POST /api/invoices/:id/tax — record the tax on an invoice.
   *
   * The split is computed here from the supplier's state and the place of
   * supply. A client that could name CGST and IGST itself could put the money
   * in the wrong exchequer, and the schema would happily store it.
   */
  app.post<{ Params: { id: string }; Body: {
    taxableValue: number; gstRate: number; placeOfSupply: string;
    customerGstin?: string; hsnSac?: string; postCompletion?: boolean; invoiceNo?: string;
  } }>(
    '/api/invoices/:id/tax',
    {
      preHandler: requireAuth,
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: UUID } } },
        body: {
          type: 'object', required: ['taxableValue', 'gstRate', 'placeOfSupply'],
          additionalProperties: false,
          properties: {
            taxableValue: { type: 'number', minimum: 0, maximum: 1e12 },
            gstRate: { type: 'number', minimum: 0, maximum: 100 },
            placeOfSupply: { type: 'string', minLength: 2, maxLength: 2 },
            customerGstin: { type: 'string', maxLength: 15 },
            hsnSac: { type: 'string', maxLength: 8 },
            postCompletion: { type: 'boolean' },
            invoiceNo: { type: 'string', maxLength: 40 },
          },
        },
      },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'manage_finance')) {
          return reply.code(403).send({ error: 'Missing permission: manage_finance' });
        }

        const gstin = (req.body.customerGstin ?? '').trim().toUpperCase();
        if (gstin && !isValidGstin(gstin)) {
          // A typo passes a regex, lands in the B2B table, and is rejected by
          // GSTN weeks later naming an invoice nobody remembers.
          return reply.code(400).send({ error: 'That GSTIN is not valid — the check digit does not match.' });
        }

        const { rows: [t] } = await db.query(
          `SELECT gstin, state_code FROM tenants WHERE id = app_current_tenant()`);
        const supplierState = (t?.state_code as string) || stateOfGstin((t?.gstin as string) ?? '');
        if (!supplierState) {
          return reply.code(409).send({
            error: 'Set the workspace GSTIN before recording tax — the intra/inter-state split depends on it.',
          });
        }

        const post = req.body.postCompletion ?? false;
        // Outside the levy: a completed unit is immovable property, not a
        // supply of service. Forcing the rate to zero here stops a 5% figure
        // being stored against a supply that is not taxable at all.
        const rate = post ? 0 : Number(req.body.gstRate);
        const split = splitTax(Number(req.body.taxableValue), rate,
          supplierState, req.body.placeOfSupply);

        const { rows } = await db.query(
          `UPDATE invoices
              SET taxable_value = $1, gst_rate = $2, cgst = $3, sgst = $4, igst = $5,
                  place_of_supply = $6, customer_gstin = $7,
                  hsn_sac = COALESCE(NULLIF($8,''), hsn_sac),
                  post_completion = $9,
                  invoice_no = COALESCE(NULLIF($10,''), invoice_no)
            WHERE id = $11
            RETURNING *`,
          [req.body.taxableValue, rate, split.cgst, split.sgst, split.igst,
           req.body.placeOfSupply, gstin, req.body.hsnSac ?? '', post,
           req.body.invoiceNo ?? '', req.params.id]);
        if (!rows[0]) return reply.code(404).send({ error: 'Invoice not found' });

        return {
          invoice: {
            id: rows[0].id,
            invoiceNo: rows[0].invoice_no,
            taxableValue: Number(rows[0].taxable_value),
            gstRate: Number(rows[0].gst_rate),
            cgst: Number(rows[0].cgst),
            sgst: Number(rows[0].sgst),
            igst: Number(rows[0].igst),
            placeOfSupply: rows[0].place_of_supply,
            customerGstin: rows[0].customer_gstin ?? '',
            hsnSac: rows[0].hsn_sac,
            postCompletion: !!rows[0].post_completion,
            interState: split.interState,
          },
        };
      }),
  );

  /** GET /api/gst/returns — what has been prepared and what has been filed. */
  app.get('/api/gst/returns', { preHandler: requireAuth }, async (req, reply) =>
    withTenantContext(req.ctx, async (db) => {
      if (!await gate(db, 'view_finance')) {
        return reply.code(403).send({ error: 'Missing permission: view_finance' });
      }
      const { rows } = await db.query(
        'SELECT * FROM gst_returns ORDER BY period DESC, form LIMIT 200');
      return { returns: rows.map(r => toApiReturn(r)) };
    }),
  );

  /**
   * GET /api/gst/returns/preview — the return, computed but not stored.
   *
   * The month-end check. An accountant runs this on the 8th to see what the
   * 11th will look like, and to find the invoices that have no tax recorded
   * while there is still time to fix them.
   */
  app.get<{ Querystring: { form: string; period: string } }>(
    '/api/gst/returns/preview',
    {
      preHandler: requireAuth,
      schema: {
        querystring: {
          type: 'object', required: ['form', 'period'],
          properties: {
            form: { type: 'string', enum: ['GSTR1', 'GSTR3B'] },
            period: { type: 'string', pattern: PERIOD },
          },
        },
      },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'view_finance')) {
          return reply.code(403).send({ error: 'Missing permission: view_finance' });
        }
        const { rows: [t] } = await db.query(
          `SELECT gstin, state_code FROM tenants WHERE id = app_current_tenant()`);
        const { from, to } = periodRange(req.query.period);
        const { rows } = await db.query(
          `SELECT * FROM invoices WHERE issue_date BETWEEN $1::date AND $2::date
            ORDER BY issue_date, invoice_no`, [from, to]);

        const invoices = rows.map(toApiInvoice);
        // Invoices in the period with no tax recorded at all. Not an error —
        // a builder may simply not have got to them — but they are the ones
        // that make a return understate turnover, so they are named.
        const untaxed = rows
          .filter(r => Number(r.taxable_value) === 0 && !r.post_completion && Number(r.amount) > 0)
          .map(r => ({
            id: r.id,
            invoiceNo: r.invoice_no ?? null,
            leadName: r.lead_name,
            amount: Number(r.amount),
            issueDate: String(r.issue_date).slice(0, 10),
          }));

        const payload = req.query.form === 'GSTR1'
          ? buildGstr1(invoices, (t?.gstin as string) ?? '')
          : buildGstr3b(invoices, (t?.gstin as string) ?? '');

        return {
          preview: {
            form: req.query.form,
            period: req.query.period,
            from, to,
            payload,
            untaxed,
            ready: untaxed.length === 0 && !!t?.gstin,
            // Named rather than implied: without a workspace GSTIN the return
            // has no `gstin` field and GSTN rejects the upload outright.
            gstinConfigured: !!t?.gstin,
          },
        };
      }),
  );

  /**
   * POST /api/gst/returns — prepare and store one.
   *
   * The payload is frozen. An invoice corrected in March must not silently
   * change what was prepared in January; a return is a statement made on a
   * date. Re-preparing an unfiled period overwrites it, which is what
   * "recalculate" means; a FILED one cannot be overwritten at all.
   */
  app.post<{ Body: { form: string; period: string } }>(
    '/api/gst/returns',
    {
      preHandler: requireAuth,
      schema: {
        body: {
          type: 'object', required: ['form', 'period'], additionalProperties: false,
          properties: {
            form: { type: 'string', enum: ['GSTR1', 'GSTR3B'] },
            period: { type: 'string', pattern: PERIOD },
          },
        },
      },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'manage_finance')) {
          return reply.code(403).send({ error: 'Missing permission: manage_finance' });
        }

        const { rows: [existing] } = await db.query(
          `SELECT status FROM gst_returns WHERE form = $1 AND period = $2`,
          [req.body.form, req.body.period]);
        if (existing?.status === 'filed') {
          return reply.code(409).send({
            error: 'That return has been filed. Prepare an amendment against a later period instead of overwriting it.',
          });
        }

        const { rows: [t] } = await db.query(
          `SELECT gstin FROM tenants WHERE id = app_current_tenant()`);
        const { from, to } = periodRange(req.body.period);
        const { rows } = await db.query(
          `SELECT * FROM invoices WHERE issue_date BETWEEN $1::date AND $2::date
            ORDER BY issue_date, invoice_no`, [from, to]);
        const invoices = rows.map(toApiInvoice);

        const payload = req.body.form === 'GSTR1'
          ? buildGstr1(invoices, (t?.gstin as string) ?? '')
          : buildGstr3b(invoices, (t?.gstin as string) ?? '');

        const { rows: [saved] } = await db.query(
          `INSERT INTO gst_returns
             (tenant_id, form, period, taxable_value, cgst, sgst, igst, invoice_count, payload, prepared_by)
           VALUES (app_current_tenant(), $1, $2, $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT (tenant_id, form, period) DO UPDATE
             SET taxable_value = EXCLUDED.taxable_value, cgst = EXCLUDED.cgst,
                 sgst = EXCLUDED.sgst, igst = EXCLUDED.igst,
                 invoice_count = EXCLUDED.invoice_count, payload = EXCLUDED.payload,
                 prepared_at = now(), prepared_by = EXCLUDED.prepared_by
           RETURNING *`,
          [req.body.form, req.body.period,
           payload.totals.taxableValue, payload.totals.cgst, payload.totals.sgst, payload.totals.igst,
           payload.invoiceCount, JSON.stringify(payload), req.ctx.userId]);

        reply.code(201);
        return { return: toApiReturn(saved, true) };
      }),
  );

  /**
   * POST /api/gst/returns/:id/file — record that it was filed.
   *
   * The ARN is required by the schema. A return marked filed with no
   * acknowledgement number is a claim; with one it is evidence, and it is what
   * anyone checking later will ask for.
   */
  app.post<{ Params: { id: string }; Body: { arn: string } }>(
    '/api/gst/returns/:id/file',
    {
      preHandler: requireAuth,
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: UUID } } },
        body: {
          type: 'object', required: ['arn'], additionalProperties: false,
          properties: { arn: { type: 'string', minLength: 1, maxLength: 40 } },
        },
      },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'manage_finance')) {
          return reply.code(403).send({ error: 'Missing permission: manage_finance' });
        }
        const { rows } = await db.query(
          `UPDATE gst_returns
              SET status = 'filed', arn = $1, filed_at = now(), filed_by = $2
            WHERE id = $3 AND status = 'prepared'
            RETURNING *`,
          [req.body.arn.trim(), req.ctx.userId, req.params.id]);
        if (!rows[0]) return reply.code(409).send({ error: 'Not found, or already filed.' });
        return { return: toApiReturn(rows[0]) };
      }),
  );

  /**
   * GET /api/gst/returns/:id/json — the file the offline tool ingests.
   *
   * Downloaded rather than transmitted. Filing needs a digital signature or an
   * EVC against the authorised signatory's own credentials, and a system
   * holding those would hold the ability to file a return in somebody's name.
   */
  app.get<{ Params: { id: string } }>(
    '/api/gst/returns/:id/json',
    { preHandler: requireAuth, schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: UUID } } } } },
    async (req, reply) => {
      const found = await withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'view_finance')) return { forbidden: true } as const;
        const { rows: [r] } = await db.query('SELECT * FROM gst_returns WHERE id = $1', [req.params.id]);
        return r ?? null;
      });
      if (found && 'forbidden' in found) {
        return reply.code(403).send({ error: 'Missing permission: view_finance' });
      }
      if (!found) return reply.code(404).send({ error: 'Return not found' });

      const body = JSON.stringify({
        gstin: (found.payload as Record<string, unknown>)?.gstin ?? '',
        fp: found.period,
        version: 'GST3.0.4',
        hash: 'hash',
        ...(found.payload as Record<string, unknown>),
      }, null, 2);

      reply
        .header('Content-Type', 'application/json; charset=utf-8')
        .header('Content-Length', String(Buffer.byteLength(body, 'utf8')))
        .header('Content-Disposition', contentDisposition(
          `${found.form}-${found.period}.json`, false))
        .headers(NOSNIFF)
        .header('Cache-Control', 'private, no-store');
      return reply.send(body);
    },
  );
}
