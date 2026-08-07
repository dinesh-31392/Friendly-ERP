import type { FastifyInstance } from 'fastify';
import { withTenantContext } from '../db.js';
import { requireAuth } from '../auth.js';

/**
 * Accounts-Payable persistence: vendors, vendor bills (+ line items),
 * contractor RA bills, and AP payments. The Postgres tables exist since
 * migration 004 but had no API — AP lived only in the browser. This exposes it
 * under RLS + RBAC (view_finance / manage_finance), so the whole AP subledger
 * becomes real multi-tenant SaaS.
 */

const UUID = '^[0-9a-fA-F-]{36}$';
const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));

async function gate(db: import('pg').PoolClient, perm: string): Promise<boolean> {
  const { rows: [{ allowed }] } = await db.query(`SELECT has_permission($1) AS allowed`, [perm]);
  return !!allowed;
}

export async function financeApRoutes(app: FastifyInstance): Promise<void> {
  // ── Vendors (shared AP + procurement master) ────────────────────────────
  const vendorToApi = (r: Record<string, unknown>) => ({
    id: r.id, name: r.name, vendorType: r.vendor_type, taxId: r.tax_id, status: r.status,
    category: r.category, contactPerson: r.contact_person, phone: r.phone, email: r.email,
    address: r.address, rating: r.rating === null || r.rating === undefined ? null : Number(r.rating),
  });

  app.get('/api/vendors', { preHandler: requireAuth }, async (req, reply) =>
    withTenantContext(req.ctx, async (db) => {
      if (!await gate(db, 'view_finance') && !await gate(db, 'view_procurement')) return reply.code(403).send({ error: 'Missing permission: view_finance or view_procurement' });
      const { rows } = await db.query('SELECT * FROM vendors ORDER BY name');
      return { vendors: rows.map(vendorToApi) };
    }),
  );

  const VENDOR_PROPS = {
    name: { type: 'string', minLength: 1, maxLength: 160 },
    vendorType: { type: 'string', enum: ['supplier', 'contractor', 'service_provider'] },
    taxId: { type: 'string', maxLength: 32 },
    category: { type: 'string', maxLength: 80 },
    contactPerson: { type: 'string', maxLength: 120 },
    phone: { type: 'string', maxLength: 32 },
    email: { type: 'string', maxLength: 160 },
    address: { type: 'string', maxLength: 300 },
    rating: { type: ['integer', 'null'], minimum: 1, maximum: 5 },
    status: { type: 'string', enum: ['active', 'blacklisted', 'inactive'] },
  } as const;

  app.post<{ Body: Record<string, unknown> & { name: string } }>(
    '/api/vendors',
    {
      preHandler: requireAuth,
      schema: { body: { type: 'object', required: ['name'], additionalProperties: false, properties: VENDOR_PROPS } },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'manage_finance') && !await gate(db, 'manage_procurement')) return reply.code(403).send({ error: 'Missing permission: manage_finance or manage_procurement' });
        const b = req.body;
        const { rows } = await db.query(
          `INSERT INTO vendors (tenant_id, name, vendor_type, tax_id, category, contact_person, phone, email, address)
           VALUES (app_current_tenant(), $1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
          [b.name, b.vendorType || 'supplier', b.taxId || null, b.category || '', b.contactPerson || null, b.phone || '', b.email || null, b.address || null]);
        reply.code(201); return { vendor: vendorToApi(rows[0]) };
      }),
  );

  app.patch<{ Params: { id: string }; Body: Record<string, unknown> }>(
    '/api/vendors/:id',
    {
      preHandler: requireAuth,
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: UUID } } },
        body: { type: 'object', minProperties: 1, additionalProperties: false, properties: VENDOR_PROPS },
      },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'manage_finance') && !await gate(db, 'manage_procurement')) return reply.code(403).send({ error: 'Missing permission: manage_finance or manage_procurement' });
        const b = req.body as { rating?: number | null; status?: string; category?: string; contactPerson?: string; phone?: string; email?: string; address?: string; taxId?: string };
        // rating supports explicit null (clear the stars) — hence the sentinel.
        const ratingProvided = 'rating' in req.body;
        const { rows } = await db.query(
          `UPDATE vendors SET
             status = COALESCE($1, status), category = COALESCE($2, category),
             contact_person = COALESCE($3, contact_person), phone = COALESCE($4, phone),
             email = COALESCE($5, email), address = COALESCE($6, address), tax_id = COALESCE($7, tax_id),
             rating = CASE WHEN $8 THEN $9::smallint ELSE rating END
           WHERE id = $10 RETURNING *`,
          [b.status ?? null, b.category ?? null, b.contactPerson ?? null, b.phone ?? null, b.email ?? null,
           b.address ?? null, b.taxId ?? null, ratingProvided, b.rating ?? null, req.params.id]);
        if (!rows[0]) return reply.code(404).send({ error: 'Vendor not found' });
        return { vendor: vendorToApi(rows[0]) };
      }),
  );

  app.delete<{ Params: { id: string } }>(
    '/api/vendors/:id',
    { preHandler: requireAuth, schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: UUID } } } } },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'manage_finance') && !await gate(db, 'manage_procurement')) return reply.code(403).send({ error: 'Missing permission: manage_finance or manage_procurement' });
        // The referencing FKs are DEFERRABLE INITIALLY DEFERRED — a violation
        // would fire at COMMIT, after the 204 already went out, silently
        // rolling the delete back. Check the references up front instead.
        const { rows: [refs] } = await db.query(
          `SELECT EXISTS (SELECT 1 FROM purchase_orders WHERE vendor_id = $1) AS has_po,
                  EXISTS (SELECT 1 FROM vendor_bills WHERE vendor_id = $1) AS has_bill,
                  EXISTS (SELECT 1 FROM contractor_ra_bills WHERE vendor_id = $1) AS has_ra`,
          [req.params.id]);
        if (refs.has_po || refs.has_bill || refs.has_ra) {
          return reply.code(409).send({ error: 'This vendor has bills or purchase orders — mark them inactive instead' });
        }
        const { rowCount } = await db.query('DELETE FROM vendors WHERE id = $1', [req.params.id]);
        if (!rowCount) return reply.code(404).send({ error: 'Vendor not found' });
        reply.code(204); return null;
      }),
  );

  // ── Vendor bills (+ line items) ─────────────────────────────────────────
  function billToApi(r: Record<string, unknown>, lines: Record<string, unknown>[] = []) {
    return {
      id: r.id, vendorId: r.vendor_id, projectId: r.project_id, poId: r.purchase_order_id, billNo: r.bill_no,
      billDate: r.bill_date, dueDate: r.due_date, amount: num(r.amount), taxAmount: num(r.tax_amount),
      totalAmount: num(r.total_amount), status: r.status, approvedBy: r.approved_by,
      category: r.category, paidAt: r.paid_at, notes: r.notes,
      lineItems: lines.map(l => ({ id: l.id, description: l.description, quantity: num(l.quantity), unitRate: num(l.unit_rate), amount: num(l.amount), accountId: l.account_id })),
    };
  }

  app.get<{ Querystring: { projectId?: string } }>('/api/vendor-bills', { preHandler: requireAuth }, async (req, reply) =>
    withTenantContext(req.ctx, async (db) => {
      if (!await gate(db, 'view_finance')) return reply.code(403).send({ error: 'Missing permission: view_finance' });
      const { rows: bills } = req.query.projectId
        ? await db.query('SELECT * FROM vendor_bills WHERE project_id = $1 ORDER BY bill_date DESC', [req.query.projectId])
        : await db.query('SELECT * FROM vendor_bills ORDER BY bill_date DESC');
      const { rows: lines } = await db.query('SELECT * FROM vendor_bill_line_items');
      const byBill = new Map<string, Record<string, unknown>[]>();
      lines.forEach(l => { const k = l.vendor_bill_id as string; if (!byBill.has(k)) byBill.set(k, []); byBill.get(k)!.push(l); });
      return { bills: bills.map(b => billToApi(b, byBill.get(b.id as string) || [])) };
    }),
  );

  app.post<{ Body: { vendorId: string; projectId?: string; poId?: string; billNo?: string; billDate?: string; dueDate?: string; amount: number; taxAmount?: number; category?: string; notes?: string; lineItems?: { description: string; quantity?: number; unitRate?: number; amount: number; accountId?: string }[] } }>(
    '/api/vendor-bills',
    {
      preHandler: requireAuth,
      schema: { body: { type: 'object', required: ['vendorId', 'amount'], additionalProperties: false, properties: {
        vendorId: { type: 'string', pattern: UUID },
        projectId: { type: 'string', pattern: UUID },
        poId: { type: 'string', pattern: UUID },
        billNo: { type: 'string', maxLength: 64 },
        billDate: { type: 'string' }, dueDate: { type: 'string' },
        amount: { type: 'number', minimum: 0 },
        taxAmount: { type: 'number', minimum: 0 },
        category: { type: 'string', maxLength: 80 },
        notes: { type: 'string', maxLength: 1000 },
        lineItems: { type: 'array', maxItems: 100, items: { type: 'object', required: ['description', 'amount'], additionalProperties: false, properties: {
          description: { type: 'string', maxLength: 300 }, quantity: { type: 'number', minimum: 0 }, unitRate: { type: 'number', minimum: 0 }, amount: { type: 'number', minimum: 0 }, accountId: { type: 'string', pattern: UUID },
        } } },
      } } },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'manage_finance')) return reply.code(403).send({ error: 'Missing permission: manage_finance' });
        // Vendor must belong to this tenant (RLS scopes the read).
        const { rows: v } = await db.query('SELECT id FROM vendors WHERE id = $1', [req.body.vendorId]);
        if (!v[0]) return reply.code(404).send({ error: 'Vendor not found' });

        const tax = req.body.taxAmount ?? 0;
        const total = req.body.amount + tax;
        const { rows } = await db.query(
          `INSERT INTO vendor_bills (tenant_id, vendor_id, project_id, purchase_order_id, bill_no, bill_date, due_date, amount, tax_amount, total_amount, category, notes, status, created_by)
           VALUES (app_current_tenant(), $1, $2, $3, $4, COALESCE($5, CURRENT_DATE), $6, $7, $8, $9, $10, $11, 'submitted', $12) RETURNING *`,
          [req.body.vendorId, req.body.projectId || null, req.body.poId || null, req.body.billNo || '', req.body.billDate || null, req.body.dueDate || null, req.body.amount, tax, total, req.body.category || '', req.body.notes || null, req.ctx.userId || null]);
        const bill = rows[0];
        const lines: Record<string, unknown>[] = [];
        for (const li of req.body.lineItems || []) {
          const { rows: lr } = await db.query(
            `INSERT INTO vendor_bill_line_items (tenant_id, vendor_bill_id, description, quantity, unit_rate, amount, account_id)
             VALUES (app_current_tenant(), $1, $2, $3, $4, $5, $6) RETURNING *`,
            [bill.id, li.description, li.quantity ?? 1, li.unitRate ?? 0, li.amount, li.accountId || null]);
          lines.push(lr[0]);
        }
        reply.code(201); return { bill: billToApi(bill, lines) };
      }),
  );

  app.patch<{ Params: { id: string }; Body: { status: string } }>(
    '/api/vendor-bills/:id',
    {
      preHandler: requireAuth,
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: UUID } } },
        body: { type: 'object', required: ['status'], additionalProperties: false, properties: { status: { type: 'string', enum: ['draft', 'submitted', 'approved', 'paid', 'disputed'] } } },
      },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'manage_finance')) return reply.code(403).send({ error: 'Missing permission: manage_finance' });
        // Approving stamps the approver (maker-checker trail); settling stamps paid_at.
        const approvedBy = req.body.status === 'approved' ? req.ctx.userId : null;
        const { rows } = await db.query(
          `UPDATE vendor_bills SET status = $1, approved_by = COALESCE($2::uuid, approved_by),
             paid_at = CASE WHEN $1 = 'paid' THEN COALESCE(paid_at, now()) ELSE paid_at END
           WHERE id = $3 RETURNING *`,
          [req.body.status, approvedBy, req.params.id]);
        if (!rows[0]) return reply.code(404).send({ error: 'Bill not found' });
        return { bill: billToApi(rows[0]) };
      }),
  );

  app.delete<{ Params: { id: string } }>(
    '/api/vendor-bills/:id',
    { preHandler: requireAuth, schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: UUID } } } } },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'manage_finance')) return reply.code(403).send({ error: 'Missing permission: manage_finance' });
        // A settled bill has a payment against it — deleting would orphan cash.
        const { rows: paid } = await db.query('SELECT 1 FROM payments_made WHERE vendor_bill_id = $1 LIMIT 1', [req.params.id]);
        if (paid[0]) return reply.code(409).send({ error: 'This bill has payments recorded — it cannot be deleted' });
        const { rowCount } = await db.query('DELETE FROM vendor_bills WHERE id = $1', [req.params.id]);
        if (!rowCount) return reply.code(404).send({ error: 'Bill not found' });
        reply.code(204); return null;
      }),
  );

  // ── Contractor RA bills ─────────────────────────────────────────────────
  function raToApi(r: Record<string, unknown>) {
    return {
      id: r.id, vendorId: r.vendor_id, projectId: r.project_id, raNumber: r.ra_number,
      workProgressPercentage: num(r.work_progress_percentage), grossAmount: num(r.gross_amount),
      retentionAmount: num(r.retention_amount), deductions: r.deductions, netPayable: num(r.net_payable),
      status: r.status, pmcApprovedBy: r.pmc_approved_by, financeApprovedBy: r.finance_approved_by,
      siteProgressPercentage: r.site_progress_percentage === null || r.site_progress_percentage === undefined ? null : Number(r.site_progress_percentage),
      overrideReason: r.override_reason, notes: r.notes,
      signedOffAt: r.signed_off_at, financeApprovedAt: r.finance_approved_at,
      createdBy: r.created_by, createdAt: r.created_at,
    };
  }

  app.get('/api/ra-bills', { preHandler: requireAuth }, async (req, reply) =>
    withTenantContext(req.ctx, async (db) => {
      if (!await gate(db, 'view_finance')) return reply.code(403).send({ error: 'Missing permission: view_finance' });
      const { rows } = await db.query('SELECT * FROM contractor_ra_bills ORDER BY created_at DESC');
      return { raBills: rows.map(raToApi) };
    }),
  );

  app.post<{ Body: { vendorId: string; projectId: string; workProgressPercentage: number; grossAmount: number; retentionAmount?: number; deductions?: { label: string; amount: number }[]; siteProgressPercentage?: number | null; overrideReason?: string; notes?: string } }>(
    '/api/ra-bills',
    {
      preHandler: requireAuth,
      schema: { body: { type: 'object', required: ['vendorId', 'projectId', 'workProgressPercentage', 'grossAmount'], additionalProperties: false, properties: {
        vendorId: { type: 'string', pattern: UUID }, projectId: { type: 'string', pattern: UUID },
        workProgressPercentage: { type: 'number', minimum: 0, maximum: 100 },
        grossAmount: { type: 'number', minimum: 0 }, retentionAmount: { type: 'number', minimum: 0 },
        deductions: { type: 'array', maxItems: 20, items: { type: 'object', required: ['label', 'amount'], additionalProperties: false, properties: { label: { type: 'string', maxLength: 60 }, amount: { type: 'number', minimum: 0 } } } },
        // Billing above the site's logged progress is allowed but must carry a
        // reason — the pair is the audit trail for that override.
        siteProgressPercentage: { type: ['number', 'null'], minimum: 0, maximum: 100 },
        overrideReason: { type: 'string', maxLength: 500 },
        notes: { type: 'string', maxLength: 1000 },
      } } },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'manage_finance')) return reply.code(403).send({ error: 'Missing permission: manage_finance' });
        const { rows: v } = await db.query(`SELECT id FROM vendors WHERE id = $1 AND vendor_type = 'contractor'`, [req.body.vendorId]);
        if (!v[0]) return reply.code(404).send({ error: 'Contractor not found' });

        const retention = req.body.retentionAmount ?? 0;
        const deductions = req.body.deductions ?? [];
        const dedTotal = deductions.reduce((s, d) => s + d.amount, 0);
        const netPayable = req.body.grossAmount - retention - dedTotal;
        if (netPayable < 0) return reply.code(400).send({ error: 'Net payable cannot be negative' });

        // Sequential RA number per contractor per project.
        const { rows: seq } = await db.query(
          `SELECT COALESCE(MAX(ra_number), 0) + 1 AS n FROM contractor_ra_bills WHERE vendor_id = $1 AND project_id = $2`,
          [req.body.vendorId, req.body.projectId]);
        const { rows } = await db.query(
          `INSERT INTO contractor_ra_bills (tenant_id, vendor_id, project_id, ra_number, work_progress_percentage,
             gross_amount, retention_amount, deductions, net_payable, status,
             site_progress_percentage, override_reason, notes, created_by)
           VALUES (app_current_tenant(), $1, $2, $3, $4, $5, $6, $7::jsonb, $8, 'submitted', $9, $10, $11, $12) RETURNING *`,
          [req.body.vendorId, req.body.projectId, seq[0].n, req.body.workProgressPercentage, req.body.grossAmount,
           retention, JSON.stringify(deductions), netPayable,
           req.body.siteProgressPercentage ?? null, req.body.overrideReason || null, req.body.notes || null,
           req.ctx.userId || null]);
        reply.code(201); return { raBill: raToApi(rows[0]) };
      }),
  );

  app.patch<{ Params: { id: string }; Body: { status: string } }>(
    '/api/ra-bills/:id',
    {
      preHandler: requireAuth,
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: UUID } } },
        body: { type: 'object', required: ['status'], additionalProperties: false, properties: { status: { type: 'string', enum: ['draft', 'submitted', 'pmc_approved', 'finance_approved', 'paid'] } } },
      },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'manage_finance')) return reply.code(403).send({ error: 'Missing permission: manage_finance' });
        // Two-stage maker-checker: stamp whichever approver this transition is.
        const pmc = req.body.status === 'pmc_approved' ? req.ctx.userId : null;
        const fin = req.body.status === 'finance_approved' ? req.ctx.userId : null;
        const { rows } = await db.query(
          `UPDATE contractor_ra_bills SET status = $1,
             pmc_approved_by = COALESCE($2::uuid, pmc_approved_by),
             finance_approved_by = COALESCE($3::uuid, finance_approved_by),
             signed_off_at = CASE WHEN $2::uuid IS NULL THEN signed_off_at ELSE COALESCE(signed_off_at, now()) END,
             finance_approved_at = CASE WHEN $3::uuid IS NULL THEN finance_approved_at ELSE COALESCE(finance_approved_at, now()) END
           WHERE id = $4 RETURNING *`,
          [req.body.status, pmc, fin, req.params.id]);
        if (!rows[0]) return reply.code(404).send({ error: 'RA bill not found' });
        return { raBill: raToApi(rows[0]) };
      }),
  );

  // ── AP payments (vendor bill XOR RA bill) ───────────────────────────────
  app.get('/api/ap-payments', { preHandler: requireAuth }, async (req, reply) =>
    withTenantContext(req.ctx, async (db) => {
      if (!await gate(db, 'view_finance')) return reply.code(403).send({ error: 'Missing permission: view_finance' });
      const { rows } = await db.query('SELECT * FROM payments_made ORDER BY payment_date DESC');
      return { payments: rows.map(r => ({ id: r.id, vendorBillId: r.vendor_bill_id, raBillId: r.contractor_ra_bill_id, amount: num(r.amount), date: r.payment_date, mode: r.mode, referenceNo: r.reference_no })) };
    }),
  );

  app.post<{ Body: { vendorBillId?: string; raBillId?: string; amount: number; mode?: string; referenceNo?: string } }>(
    '/api/ap-payments',
    {
      preHandler: requireAuth,
      schema: { body: { type: 'object', required: ['amount'], additionalProperties: false, properties: {
        vendorBillId: { type: 'string', pattern: UUID }, raBillId: { type: 'string', pattern: UUID },
        amount: { type: 'number', exclusiveMinimum: 0 }, mode: { type: 'string', enum: ['cheque', 'bank_transfer', 'upi', 'cash'] }, referenceNo: { type: 'string', maxLength: 64 },
      } } },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'manage_finance')) return reply.code(403).send({ error: 'Missing permission: manage_finance' });
        // Exactly one of the two bill refs (DB enforces this too).
        if (!!req.body.vendorBillId === !!req.body.raBillId) return reply.code(400).send({ error: 'Provide exactly one of vendorBillId or raBillId' });

        const { rows } = await db.query(
          `INSERT INTO payments_made (tenant_id, vendor_bill_id, contractor_ra_bill_id, amount, mode, reference_no, paid_by)
           VALUES (app_current_tenant(), $1, $2, $3, $4, $5, $6) RETURNING *`,
          [req.body.vendorBillId || null, req.body.raBillId || null, req.body.amount, req.body.mode || 'bank_transfer', req.body.referenceNo || null, req.ctx.userId || null]);
        // Mark the settled bill as paid.
        if (req.body.vendorBillId) await db.query(`UPDATE vendor_bills SET status = 'paid' WHERE id = $1`, [req.body.vendorBillId]);
        if (req.body.raBillId) await db.query(`UPDATE contractor_ra_bills SET status = 'paid' WHERE id = $1`, [req.body.raBillId]);
        const p = rows[0];
        reply.code(201); return { payment: { id: p.id, vendorBillId: p.vendor_bill_id, raBillId: p.contractor_ra_bill_id, amount: num(p.amount), date: p.payment_date, mode: p.mode, referenceNo: p.reference_no } };
      }),
  );
}
