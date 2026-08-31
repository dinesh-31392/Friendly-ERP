import type { FastifyInstance } from 'fastify';
import { withTenantContext } from '../db.js';
import { requireAuth } from '../auth.js';
import { stateOfGstin, type GstInvoice } from '../gst.js';
import {
  buildEinvoicePayload, validateForEinvoice, validateSeller, computeIrn, financialYear, canCancel,
  type DocType, type EinvoiceParty,
} from '../einvoice.js';
import { contentDisposition, NOSNIFF } from '../storage.js';

/**
 * E-invoicing — registering an invoice with the IRP (migration 058).
 *
 * Prepared here, registered elsewhere, recorded here. Same division as GST
 * returns beside it, for the same reason: registering needs credentials from a
 * GST Suvidha Provider, and a system holding those holds the ability to issue
 * tax invoices in the builder's name. So this builds the INV-01 payload,
 * derives the IRN so the portal's answer can be CHECKED rather than trusted,
 * and stores what came back.
 *
 * The one rule worth repeating at every layer: e-invoicing is B2B, SEZ, exports
 * and deemed exports. Never B2C. `einvoices.buyer_gstin` is NOT NULL because a
 * row here is by definition a supply in scope.
 */

const UUID = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

async function gate(db: import('pg').PoolClient, perm: string): Promise<boolean> {
  const { rows: [{ allowed }] } = await db.query(`SELECT has_permission($1) AS allowed`, [perm]);
  return !!allowed;
}

const toGstInvoice = (r: Record<string, unknown>): GstInvoice => ({
  invoiceNo: (r.invoice_no as string) || String(r.id).slice(0, 8).toUpperCase(),
  issueDate: String(r.issue_date).slice(0, 10),
  customerName: (r.lead_name as string) ?? '',
  customerGstin: (r.customer_gstin as string) ?? '',
  placeOfSupply: (r.place_of_supply as string) ?? '',
  taxableValue: Number(r.taxable_value ?? 0),
  gstRate: Number(r.gst_rate ?? 0),
  cgst: Number(r.cgst ?? 0),
  sgst: Number(r.sgst ?? 0),
  igst: Number(r.igst ?? 0),
  hsnSac: (r.hsn_sac as string) ?? '',
  postCompletion: !!r.post_completion,
});

const toApi = (r: Record<string, unknown>) => ({
  id: r.id,
  invoiceId: r.invoice_id,
  docType: r.doc_type,
  docNo: r.doc_no,
  issueDate: String(r.issue_date).slice(0, 10),
  financialYear: r.financial_year,
  supplierGstin: r.supplier_gstin,
  buyerGstin: r.buyer_gstin,
  taxableValue: Number(r.taxable_value ?? 0),
  totalValue: Number(r.total_value ?? 0),
  irn: r.irn ?? null,
  status: r.status,
  ackNo: r.ack_no ?? null,
  ackDate: r.ack_date ?? null,
  signedQr: r.signed_qr ?? null,
  cancelReason: r.cancel_reason ?? null,
  cancelledAt: r.cancelled_at ?? null,
  rejectReason: r.reject_reason ?? null,
  // Whether the portal would still accept a cancellation. Computed rather than
  // stored: the answer changes with the clock, and a button that has quietly
  // expired is worse than one that was never offered.
  cancellable: r.status === 'registered' && !!r.ack_date
    && canCancel(new Date(r.ack_date as string).toISOString(), new Date().toISOString()),
});

/** The seller block, from the workspace. */
function sellerFrom(t: Record<string, unknown>): EinvoiceParty {
  const gstin = ((t?.gstin as string) ?? '').toUpperCase();
  return {
    gstin,
    legalName: (t?.company as string) || (t?.name as string) || '',
    address1: (t?.address as string) || '',
    // The IRP wants a city and a pincode. A workspace that has not set them
    // gets a payload with empty strings, which the portal rejects naming the
    // field — better than this route inventing plausible ones.
    location: (t?.city as string) || '',
    pincode: Number((t?.pincode as string) || 0),
    stateCode: ((t?.state_code as string) || stateOfGstin(gstin)) as string,
  };
}

export async function einvoiceRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GET /api/einvoices — what has been prepared, registered or cancelled.
   */
  app.get('/api/einvoices', { preHandler: requireAuth }, async (req, reply) =>
    withTenantContext(req.ctx, async (db) => {
      if (!await gate(db, 'view_finance')) {
        return reply.code(403).send({ error: 'Missing permission: view_finance' });
      }
      const { rows } = await db.query(
        `SELECT * FROM einvoices ORDER BY issue_date DESC, created_at DESC LIMIT 500`);
      return { einvoices: rows.map(toApi) };
    }),
  );

  /**
   * GET /api/einvoices/eligible — invoices that could be registered but have
   * not been.
   *
   * The filtering is SQL rather than a preview call per invoice: the panel
   * needs a list, and asking the eligibility question a hundred times over HTTP
   * to build one is the wrong shape. The conditions mirror
   * `validateForEinvoice` — a buyer GSTIN (so, not B2C), a taxable value, and
   * not sold after completion.
   */
  app.get('/api/einvoices/eligible', { preHandler: requireAuth }, async (req, reply) =>
    withTenantContext(req.ctx, async (db) => {
      if (!await gate(db, 'view_finance')) {
        return reply.code(403).send({ error: 'Missing permission: view_finance' });
      }
      const { rows } = await db.query(
        `SELECT i.id, i.invoice_no, i.issue_date, i.lead_name,
                i.taxable_value, i.customer_gstin,
                (i.taxable_value + i.cgst + i.sgst + i.igst) AS total_value
           FROM invoices i
          WHERE COALESCE(i.customer_gstin, '') <> ''
            AND i.taxable_value > 0
            AND COALESCE(i.post_completion, false) = false
            AND NOT EXISTS (
              SELECT 1 FROM einvoices e
               WHERE e.invoice_id = i.id
                 AND e.status IN ('prepared', 'registered')
            )
          ORDER BY i.issue_date DESC
          LIMIT 200`);
      return {
        invoices: rows.map(r => ({
          id: r.id,
          invoiceNo: r.invoice_no,
          issueDate: String(r.issue_date).slice(0, 10),
          customerName: r.lead_name ?? '',
          customerGstin: r.customer_gstin,
          taxableValue: Number(r.taxable_value ?? 0),
          totalValue: Number(r.total_value ?? 0),
        })),
      };
    }),
  );

  /**
   * GET /api/invoices/:id/einvoice/preview — can this be registered, and what
   * would be sent?
   *
   * Read-only and side-effect free, so the reasons an invoice is not eligible
   * can be shown next to it without anyone committing to anything.
   */
  app.get<{ Params: { id: string } }>(
    '/api/invoices/:id/einvoice/preview',
    {
      preHandler: requireAuth,
      schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: UUID } } } },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'view_finance')) {
          return reply.code(403).send({ error: 'Missing permission: view_finance' });
        }
        const { rows: [inv] } = await db.query('SELECT * FROM invoices WHERE id = $1', [req.params.id]);
        if (!inv) return reply.code(404).send({ error: 'Invoice not found' });

        const { rows: [t] } = await db.query(
          `SELECT name, company, gstin, state_code, address, city, pincode, einvoicing_enabled
             FROM tenants WHERE id = app_current_tenant()`);

        const gi = toGstInvoice(inv);
        const seller = sellerFrom(t);
        const check = validateForEinvoice(gi, seller.gstin);
        const sellerCheck = validateSeller(seller);
        // Both sets, because a builder fixing one and hitting the other
        // immediately learns nothing from the first refusal.
        const reasons = [...check.reasons, ...sellerCheck.reasons];

        return {
          invoiceId: inv.id,
          enabled: !!t?.einvoicing_enabled,
          eligible: check.ok && sellerCheck.ok,
          reasons,
          irn: check.ok ? computeIrn(seller.gstin, 'INV', gi.invoiceNo, gi.issueDate) : null,
          financialYear: financialYear(gi.issueDate),
        };
      }),
  );

  /**
   * POST /api/invoices/:id/einvoice — prepare the registration.
   *
   * Builds and stores the payload and the derived IRN. Does NOT contact the
   * portal: nothing here holds GSP credentials. The row sits at 'prepared'
   * until somebody registers it and records the acknowledgement.
   */
  app.post<{ Params: { id: string }; Body: { docType?: DocType } }>(
    '/api/invoices/:id/einvoice',
    {
      preHandler: requireAuth,
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: UUID } } },
        body: {
          type: 'object', additionalProperties: false,
          properties: { docType: { type: 'string', enum: ['INV', 'CRN', 'DBN'] } },
        },
      },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'manage_finance')) {
          return reply.code(403).send({ error: 'Missing permission: manage_finance' });
        }
        const { rows: [inv] } = await db.query('SELECT * FROM invoices WHERE id = $1', [req.params.id]);
        if (!inv) return reply.code(404).send({ error: 'Invoice not found' });

        const { rows: [t] } = await db.query(
          `SELECT name, company, gstin, state_code, address, city, pincode
             FROM tenants WHERE id = app_current_tenant()`);

        const gi = toGstInvoice(inv);
        const seller = sellerFrom(t);
        const check = validateForEinvoice(gi, seller.gstin);
        const sellerCheck = validateSeller(seller);
        if (!check.ok || !sellerCheck.ok) {
          // 422 rather than 400: the request is well-formed, the document is
          // not yet registrable. Every reason names a field.
          const reasons = [...check.reasons, ...sellerCheck.reasons];
          return reply.code(422).send({ error: reasons[0], reasons });
        }

        const docType = req.body?.docType ?? 'INV';

        // The buyer block. The GSTIN is on the invoice; the rest is whatever
        // the customer record holds, left blank rather than guessed.
        const { rows: [cust] } = await db.query(
          `SELECT name FROM customers WHERE lead_id = $1 LIMIT 1`, [inv.lead_id]);
        const buyer: EinvoiceParty = {
          gstin: String(gi.customerGstin).toUpperCase(),
          legalName: (cust?.name as string) || gi.customerName || '',
          address1: '',
          location: '',
          pincode: 0,
          stateCode: gi.placeOfSupply,
        };

        const payload = buildEinvoicePayload(gi, seller, buyer, docType);
        const irn = payload._derived.irn;
        const total = payload.ValDtls.TotInvVal;

        try {
          const { rows } = await db.query(
            `INSERT INTO einvoices
               (tenant_id, invoice_id, doc_type, doc_no, issue_date, financial_year,
                supplier_gstin, buyer_gstin, taxable_value, total_value, irn,
                status, payload, created_by)
             VALUES (app_current_tenant(), $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'prepared',$11,$12)
             RETURNING *`,
            [inv.id, docType, gi.invoiceNo, gi.issueDate, payload._derived.financialYear,
             seller.gstin, buyer.gstin, gi.taxableValue, total, irn,
             JSON.stringify(payload), req.ctx.userId]);
          return reply.code(201).send({ einvoice: toApi(rows[0]) });
        } catch (e) {
          // The partial unique index. A second prepare while one is live is a
          // double-submission, and the portal would burn a second IRN for the
          // same document if it ever reached it.
          if ((e as { code?: string }).code === '23505') {
            return reply.code(409).send({
              error: 'This invoice already has a prepared or registered e-invoice. Cancel it before preparing another.',
            });
          }
          throw e;
        }
      }),
  );

  /**
   * POST /api/einvoices/:id/register — record what the portal returned.
   *
   * The IRN is checked against the one derived from the document. A mismatch
   * means the response belongs to a different invoice, and accepting it would
   * attach somebody else's registration to this one.
   */
  app.post<{ Params: { id: string }; Body: { irn: string; ackNo: string; ackDate: string; signedQr?: string } }>(
    '/api/einvoices/:id/register',
    {
      preHandler: requireAuth,
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: UUID } } },
        body: {
          type: 'object', required: ['irn', 'ackNo', 'ackDate'], additionalProperties: false,
          properties: {
            irn: { type: 'string', pattern: '^[0-9a-fA-F]{64}$' },
            ackNo: { type: 'string', minLength: 1, maxLength: 40 },
            ackDate: { type: 'string', minLength: 4, maxLength: 40 },
            signedQr: { type: 'string', maxLength: 8000 },
          },
        },
      },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'manage_finance')) {
          return reply.code(403).send({ error: 'Missing permission: manage_finance' });
        }
        const { rows: [ei] } = await db.query('SELECT * FROM einvoices WHERE id = $1', [req.params.id]);
        if (!ei) return reply.code(404).send({ error: 'E-invoice not found' });
        if (ei.status !== 'prepared') {
          return reply.code(409).send({ error: `This e-invoice is ${ei.status}, not prepared.` });
        }

        const presented = String(req.body.irn).toLowerCase();
        if (presented !== String(ei.irn).toLowerCase()) {
          return reply.code(409).send({
            error: 'That IRN does not match the one derived from this invoice — it may belong to a different document.',
          });
        }

        const ack = new Date(req.body.ackDate);
        if (Number.isNaN(ack.getTime())) {
          return reply.code(400).send({ error: 'The acknowledgement date could not be read.' });
        }

        const { rows } = await db.query(
          `UPDATE einvoices
              SET status = 'registered', ack_no = $1, ack_date = $2,
                  signed_qr = COALESCE(NULLIF($3,''), signed_qr), updated_at = now()
            WHERE id = $4 RETURNING *`,
          [req.body.ackNo, ack.toISOString(), req.body.signedQr ?? '', req.params.id]);
        return { einvoice: toApi(rows[0]) };
      }),
  );

  /**
   * POST /api/einvoices/:id/cancel — within 24 hours of acknowledgement.
   *
   * The window is the portal's and it is hard. Past it the only remedy is a
   * credit note, and this says so rather than letting a request fail there.
   */
  app.post<{ Params: { id: string }; Body: { reason: string } }>(
    '/api/einvoices/:id/cancel',
    {
      preHandler: requireAuth,
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: UUID } } },
        body: {
          type: 'object', required: ['reason'], additionalProperties: false,
          properties: { reason: { type: 'string', minLength: 1, maxLength: 200 } },
        },
      },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'manage_finance')) {
          return reply.code(403).send({ error: 'Missing permission: manage_finance' });
        }
        const { rows: [ei] } = await db.query('SELECT * FROM einvoices WHERE id = $1', [req.params.id]);
        if (!ei) return reply.code(404).send({ error: 'E-invoice not found' });

        if (ei.status === 'prepared') {
          // Never registered, so there is nothing at the portal to cancel.
          const { rows } = await db.query(
            `UPDATE einvoices SET status = 'cancelled', cancel_reason = $1,
                    cancelled_at = now(), updated_at = now()
              WHERE id = $2 RETURNING *`, [req.body.reason, req.params.id]);
          return { einvoice: toApi(rows[0]) };
        }

        if (ei.status !== 'registered') {
          return reply.code(409).send({ error: `This e-invoice is ${ei.status}.` });
        }
        if (!canCancel(new Date(ei.ack_date).toISOString(), new Date().toISOString())) {
          return reply.code(409).send({
            error: 'The 24-hour cancellation window has closed. Issue a credit note instead.',
          });
        }

        const { rows } = await db.query(
          `UPDATE einvoices SET status = 'cancelled', cancel_reason = $1,
                  cancelled_at = now(), updated_at = now()
            WHERE id = $2 RETURNING *`, [req.body.reason, req.params.id]);
        return { einvoice: toApi(rows[0]) };
      }),
  );

  /**
   * GET /api/einvoices/:id/json — the INV-01 payload, to upload to the IRP.
   */
  app.get<{ Params: { id: string } }>(
    '/api/einvoices/:id/json',
    {
      preHandler: requireAuth,
      schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: UUID } } } },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'view_finance')) {
          return reply.code(403).send({ error: 'Missing permission: view_finance' });
        }
        const { rows: [ei] } = await db.query('SELECT * FROM einvoices WHERE id = $1', [req.params.id]);
        if (!ei) return reply.code(404).send({ error: 'E-invoice not found' });

        // `_derived` is ours, not the schema's. Sending it to the portal would
        // fail validation, so it is stripped from what leaves here.
        const payload = { ...(ei.payload as Record<string, unknown>) };
        delete payload._derived;

        reply.header('Content-Type', 'application/json; charset=utf-8');
        reply.header('X-Content-Type-Options', NOSNIFF);
        // Attachment, not inline: this is a file to hand to the IRP tool, and
        // a browser rendering it as a page is never what was wanted.
        reply.header('Content-Disposition',
          contentDisposition(`einvoice-${ei.doc_no}-${ei.financial_year}.json`, false));
        return reply.send(JSON.stringify(payload, null, 2));
      }),
  );
}
