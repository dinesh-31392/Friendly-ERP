import type { FastifyInstance } from 'fastify';
import { withTenantContext } from '../db.js';
import { requireAuth } from '../auth.js';
import { renderLetter, pdfMoney, pdfDate } from '../pdf.js';
import { contentDisposition, NOSNIFF } from '../storage.js';

/**
 * Cost sheets (migration 050) — the document a buyer decides on.
 *
 * The product had `quotations`: base, additional charges, discount, total.
 * That is a quote. A cost sheet is the itemised statement an Indian buyer is
 * shown before booking, takes to their bank for a loan sanction, and holds the
 * builder to afterwards — and it has to name every component, because "₹98
 * lakh all-in" is not something a bank will lend against.
 *
 * Gated on the sales permissions rather than finance: it is the sales team that
 * prepares and issues these, and finance sees the booking that results.
 */

const UUID = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

async function gate(db: import('pg').PoolClient, perm: string): Promise<boolean> {
  const { rows: [{ allowed }] } = await db.query(`SELECT has_permission($1) AS allowed`, [perm]);
  return !!allowed;
}

interface LineInput {
  section?: 'consideration' | 'statutory' | 'deposit' | 'other';
  label: string;
  basis?: 'per_sqft' | 'lump_sum' | 'pct_of_consideration';
  rate?: number;
  quantity?: number;
  gstPct?: number;
}

const round2 = (n: number) => Math.round((Number.isFinite(n) ? n : 0) * 100) / 100;

/**
 * Turn the inputs into the figures that get stored.
 *
 * Computed server-side from the basis and the rate, never taken from the
 * client: a browser that sends both a rate and an amount can send a pair that
 * do not agree, and the sheet would then show arithmetic that does not add up
 * to a buyer holding a calculator.
 *
 * `pct_of_consideration` runs in a second pass because stamp duty is a
 * percentage OF the consideration, and the consideration is not known until
 * every per_sqft and lump_sum line has been priced.
 */
export function priceLines(lines: LineInput[], areaSqft: number): Array<{
  section: string; label: string; basis: string; rate: number; quantity: number;
  amount: number; gstPct: number; gstAmount: number;
}> {
  const priced = lines.map((l) => {
    const basis = l.basis ?? 'lump_sum';
    const rate = Number(l.rate ?? 0);
    const qty = basis === 'per_sqft' ? Number(l.quantity ?? areaSqft) : Number(l.quantity ?? 1);
    const amount = basis === 'pct_of_consideration' ? 0 : round2(rate * qty);
    return {
      section: l.section ?? 'consideration',
      label: l.label,
      basis, rate, quantity: qty, amount,
      gstPct: Number(l.gstPct ?? 0),
      gstAmount: 0,
    };
  });

  const consideration = priced
    .filter(p => p.section === 'consideration' && p.basis !== 'pct_of_consideration')
    .reduce((s, p) => s + p.amount, 0);

  for (const p of priced) {
    if (p.basis === 'pct_of_consideration') {
      p.amount = round2(consideration * p.rate / 100);
      p.quantity = 1;
    }
    // The database refuses GST on a statutory line; refuse it here too, so the
    // caller gets a sheet that is right rather than an insert that fails.
    if (p.section === 'statutory') { p.gstPct = 0; p.gstAmount = 0; continue; }
    p.gstAmount = round2(p.amount * p.gstPct / 100);
  }
  return priced;
}

const toApiLine = (r: Record<string, unknown>) => ({
  id: r.id,
  sequence: r.sequence,
  section: r.section,
  label: r.label,
  basis: r.basis,
  rate: Number(r.rate),
  quantity: Number(r.quantity),
  amount: Number(r.amount),
  gstPct: Number(r.gst_pct),
  gstAmount: Number(r.gst_amount),
});

const toApiSheet = (r: Record<string, unknown>, lines: Record<string, unknown>[] = [], totals?: Record<string, unknown>) => ({
  id: r.id,
  unitId: r.unit_id ?? null,
  leadId: r.lead_id ?? null,
  bookingId: r.booking_id ?? null,
  sheetNo: r.sheet_no,
  status: r.status,
  areaSqft: Number(r.area_sqft),
  baseRate: Number(r.base_rate),
  tdsPct: Number(r.tds_pct),
  tdsThreshold: Number(r.tds_threshold),
  validUntil: r.valid_until ?? null,
  notes: r.notes ?? '',
  createdAt: r.created_at,
  issuedAt: r.issued_at ?? null,
  unitCode: r.unit_code ?? undefined,
  projectName: r.project_name ?? undefined,
  customerName: r.customer_name ?? undefined,
  lines: lines.map(toApiLine),
  totals: totals ? {
    consideration: Number(totals.consideration),
    statutory: Number(totals.statutory),
    deposits: Number(totals.deposits),
    other: Number(totals.other),
    gst: Number(totals.gst),
    gross: Number(totals.gross),
    tds: Number(totals.tds),
    netToBuilder: Number(totals.net_to_builder),
    payableByBuyer: Number(totals.payable_by_buyer),
  } : undefined,
});

const LINE_SCHEMA = {
  type: 'object',
  required: ['label'],
  additionalProperties: false,
  properties: {
    section: { type: 'string', enum: ['consideration', 'statutory', 'deposit', 'other'] },
    label: { type: 'string', minLength: 1, maxLength: 160 },
    basis: { type: 'string', enum: ['per_sqft', 'lump_sum', 'pct_of_consideration'] },
    rate: { type: 'number', minimum: 0, maximum: 1e12 },
    quantity: { type: 'number', minimum: 0, maximum: 1e9 },
    gstPct: { type: 'number', minimum: 0, maximum: 100 },
  },
} as const;

const SELECT_SHEET = `
  SELECT c.*, u.unit_code, p.name AS project_name, l.name AS customer_name
    FROM cost_sheets c
    LEFT JOIN units u    ON u.id = c.unit_id
    LEFT JOIN projects p ON p.id = u.project_id
    LEFT JOIN leads l    ON l.id = c.lead_id`;

/** Header + lines + totals, in the one shape every consumer wants. */
async function loadSheet(db: import('pg').PoolClient, id: string) {
  const { rows: [sheet] } = await db.query(`${SELECT_SHEET} WHERE c.id = $1`, [id]);
  if (!sheet) return null;
  const { rows: lines } = await db.query(
    'SELECT * FROM cost_sheet_lines WHERE cost_sheet_id = $1 ORDER BY sequence', [id]);
  const { rows: [totals] } = await db.query('SELECT * FROM cost_sheet_totals($1)', [id]);
  return { sheet, lines, totals };
}

export async function costSheetRoutes(app: FastifyInstance): Promise<void> {
  /** GET /api/cost-sheets — the list, newest first. */
  app.get('/api/cost-sheets', { preHandler: requireAuth }, async (req, reply) =>
    withTenantContext(req.ctx, async (db) => {
      if (!await gate(db, 'view_bookings')) {
        return reply.code(403).send({ error: 'Missing permission: view_bookings' });
      }
      const { rows } = await db.query(`${SELECT_SHEET} ORDER BY c.created_at DESC LIMIT 500`);
      // Totals per row so the list can show a figure without the client
      // re-implementing the tax rules to display one.
      const out = [];
      for (const r of rows) {
        const { rows: [t] } = await db.query('SELECT * FROM cost_sheet_totals($1)', [r.id]);
        out.push(toApiSheet(r, [], t));
      }
      return { costSheets: out };
    }),
  );

  /** GET /api/cost-sheets/:id — header, lines and totals. */
  app.get<{ Params: { id: string } }>(
    '/api/cost-sheets/:id',
    { preHandler: requireAuth, schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: UUID } } } } },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'view_bookings')) {
          return reply.code(403).send({ error: 'Missing permission: view_bookings' });
        }
        const found = await loadSheet(db, req.params.id);
        if (!found) return reply.code(404).send({ error: 'Cost sheet not found' });
        return { costSheet: toApiSheet(found.sheet, found.lines, found.totals) };
      }),
  );

  /**
   * POST /api/cost-sheets — draft one.
   *
   * The sheet number is assigned inside the transaction from the tenant's own
   * sequence, never by the client: two salespeople drafting at once must not
   * both be sheet 41.
   */
  app.post<{ Body: {
    unitId?: string; leadId?: string; areaSqft?: number; baseRate?: number;
    tdsPct?: number; tdsThreshold?: number; validUntil?: string; notes?: string;
    lines?: LineInput[];
  } }>(
    '/api/cost-sheets',
    {
      preHandler: requireAuth,
      schema: {
        body: {
          type: 'object', additionalProperties: false,
          properties: {
            unitId: { type: 'string', pattern: UUID },
            leadId: { type: 'string', pattern: UUID },
            areaSqft: { type: 'number', minimum: 0, maximum: 1e7 },
            baseRate: { type: 'number', minimum: 0, maximum: 1e9 },
            tdsPct: { type: 'number', minimum: 0, maximum: 100 },
            tdsThreshold: { type: 'number', minimum: 0, maximum: 1e12 },
            validUntil: { type: 'string', maxLength: 40 },
            notes: { type: 'string', maxLength: 4000 },
            lines: { type: 'array', maxItems: 60, items: LINE_SCHEMA },
          },
        },
      },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'manage_bookings')) {
          return reply.code(403).send({ error: 'Missing permission: manage_bookings' });
        }
        const b = req.body;

        // Area defaults to the unit's own, so a sheet drafted against a unit
        // does not silently price per_sqft lines at zero.
        let area = Number(b.areaSqft ?? 0);
        let rate = Number(b.baseRate ?? 0);
        if (b.unitId && (!b.areaSqft || !b.baseRate)) {
          const { rows: [u] } = await db.query(
            'SELECT area_sqft, base_rate FROM units WHERE id = $1', [b.unitId]);
          if (u) {
            if (!b.areaSqft) area = Number(u.area_sqft ?? 0);
            if (!b.baseRate) rate = Number(u.base_rate ?? 0);
          }
        }

        const { rows: [created] } = await db.query(
          `INSERT INTO cost_sheets
             (tenant_id, unit_id, lead_id, sheet_no, area_sqft, base_rate,
              tds_pct, tds_threshold, valid_until, notes, created_by)
           VALUES (app_current_tenant(), $1, $2,
                   (SELECT COALESCE(MAX(sheet_no), 0) + 1 FROM cost_sheets),
                   $3, $4, COALESCE($5, 1.00), COALESCE($6, 5000000), $7, COALESCE($8, ''), $9)
           RETURNING *`,
          [b.unitId ?? null, b.leadId ?? null, area, rate,
           b.tdsPct ?? null, b.tdsThreshold ?? null, b.validUntil ?? null, b.notes ?? null,
           req.ctx.userId]);

        const priced = priceLines(b.lines ?? [], area);
        for (const [i, p] of priced.entries()) {
          await db.query(
            `INSERT INTO cost_sheet_lines
               (tenant_id, cost_sheet_id, sequence, section, label, basis, rate, quantity, amount, gst_pct, gst_amount)
             VALUES (app_current_tenant(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
            [created.id, i + 1, p.section, p.label, p.basis, p.rate, p.quantity, p.amount, p.gstPct, p.gstAmount]);
        }

        const found = await loadSheet(db, created.id);
        reply.code(201);
        return { costSheet: toApiSheet(found!.sheet, found!.lines, found!.totals) };
      }),
  );

  /**
   * PUT /api/cost-sheets/:id/lines — replace the lines wholesale.
   *
   * Replace rather than patch: a cost sheet is read as a whole, the lines
   * interact (stamp duty is a percentage of the others), and a per-line PATCH
   * would let a sheet exist in a state where the percentage lines were computed
   * against a consideration that has since changed.
   *
   * Refused once the sheet is issued. A sheet in a buyer's hands that quietly
   * changes underneath them is the thing this whole table exists to prevent.
   */
  app.put<{ Params: { id: string }; Body: { lines: LineInput[] } }>(
    '/api/cost-sheets/:id/lines',
    {
      preHandler: requireAuth,
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: UUID } } },
        body: {
          type: 'object', required: ['lines'], additionalProperties: false,
          properties: { lines: { type: 'array', maxItems: 60, items: LINE_SCHEMA } },
        },
      },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'manage_bookings')) {
          return reply.code(403).send({ error: 'Missing permission: manage_bookings' });
        }
        const { rows: [sheet] } = await db.query('SELECT * FROM cost_sheets WHERE id = $1', [req.params.id]);
        if (!sheet) return reply.code(404).send({ error: 'Cost sheet not found' });
        if (sheet.status !== 'draft') {
          return reply.code(409).send({ error: 'Only a draft cost sheet can be edited. Supersede it with a new sheet instead.' });
        }

        await db.query('DELETE FROM cost_sheet_lines WHERE cost_sheet_id = $1', [req.params.id]);
        const priced = priceLines(req.body.lines, Number(sheet.area_sqft));
        for (const [i, p] of priced.entries()) {
          await db.query(
            `INSERT INTO cost_sheet_lines
               (tenant_id, cost_sheet_id, sequence, section, label, basis, rate, quantity, amount, gst_pct, gst_amount)
             VALUES (app_current_tenant(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
            [req.params.id, i + 1, p.section, p.label, p.basis, p.rate, p.quantity, p.amount, p.gstPct, p.gstAmount]);
        }

        const found = await loadSheet(db, req.params.id);
        return { costSheet: toApiSheet(found!.sheet, found!.lines, found!.totals) };
      }),
  );

  /**
   * PATCH /api/cost-sheets/:id — move it along its lifecycle.
   *
   * draft → issued → accepted, with supersede and cancel as the ways out. The
   * transitions are enumerated rather than "set any status", because
   * accepted → draft would make an agreed sheet editable again.
   */
  app.patch<{ Params: { id: string }; Body: { status: string } }>(
    '/api/cost-sheets/:id',
    {
      preHandler: requireAuth,
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: UUID } } },
        body: {
          type: 'object', required: ['status'], additionalProperties: false,
          properties: { status: { type: 'string', enum: ['issued', 'accepted', 'superseded', 'cancelled'] } },
        },
      },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'manage_bookings')) {
          return reply.code(403).send({ error: 'Missing permission: manage_bookings' });
        }
        const ALLOWED: Record<string, string[]> = {
          draft:      ['issued', 'cancelled'],
          issued:     ['accepted', 'superseded', 'cancelled'],
          accepted:   ['superseded', 'cancelled'],
          superseded: [],
          cancelled:  [],
        };
        const { rows: [sheet] } = await db.query('SELECT * FROM cost_sheets WHERE id = $1', [req.params.id]);
        if (!sheet) return reply.code(404).send({ error: 'Cost sheet not found' });
        if (!ALLOWED[sheet.status]?.includes(req.body.status)) {
          return reply.code(409).send({ error: `A ${sheet.status} cost sheet cannot become ${req.body.status}.` });
        }

        const { rows: [updated] } = await db.query(
          `UPDATE cost_sheets
              SET status = $1,
                  -- Stamped once, on the transition that freezes the figures.
                  issued_at = CASE WHEN $1 = 'issued' AND issued_at IS NULL THEN now() ELSE issued_at END
            WHERE id = $2 RETURNING *`,
          [req.body.status, req.params.id]);

        const found = await loadSheet(db, updated.id);
        return { costSheet: toApiSheet(found!.sheet, found!.lines, found!.totals) };
      }),
  );

  /** DELETE /api/cost-sheets/:id — drafts only; anything issued is cancelled. */
  app.delete<{ Params: { id: string } }>(
    '/api/cost-sheets/:id',
    { preHandler: requireAuth, schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: UUID } } } } },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'manage_bookings')) {
          return reply.code(403).send({ error: 'Missing permission: manage_bookings' });
        }
        const { rows: [sheet] } = await db.query('SELECT status FROM cost_sheets WHERE id = $1', [req.params.id]);
        if (!sheet) return reply.code(404).send({ error: 'Cost sheet not found' });
        if (sheet.status !== 'draft') {
          return reply.code(409).send({ error: 'A cost sheet that has been issued is a record. Cancel it instead of deleting it.' });
        }
        await db.query('DELETE FROM cost_sheets WHERE id = $1', [req.params.id]);
        reply.code(204); return null;
      }),
  );

  /**
   * GET /api/cost-sheets/:id/pdf — the sheet as the buyer receives it.
   *
   * The whole reason the line detail exists: a bank will not lend against
   * "₹98 lakh all-in", and a buyer cannot check a total they were never shown
   * the parts of.
   */
  app.get<{ Params: { id: string } }>(
    '/api/cost-sheets/:id/pdf',
    { preHandler: requireAuth, schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: UUID } } } } },
    async (req, reply) => {
      const data = await withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'view_bookings')) return { forbidden: true } as const;
        const found = await loadSheet(db, req.params.id);
        if (!found) return null;
        const { rows: [t] } = await db.query(
          `SELECT name, company, address, email, phone, currency FROM tenants WHERE id = app_current_tenant()`);
        return { ...found, tenant: t };
      });

      if (data && 'forbidden' in data) return reply.code(403).send({ error: 'Missing permission: view_bookings' });
      if (!data) return reply.code(404).send({ error: 'Cost sheet not found' });

      const { sheet, lines, totals, tenant } = data;
      const ccy = (tenant?.currency as string) || 'INR';
      const locale = ccy === 'INR' ? 'en-IN' : 'en-US';
      const money = (n: unknown) => pdfMoney(Number(n ?? 0), ccy, locale);

      const unit = [sheet.project_name, sheet.unit_code].filter(Boolean).join(' — ');
      const rows: { label: string; value: string; strong?: boolean }[] = [];

      // Grouped by section, in the order a buyer reads them: what the flat
      // costs, what the government takes, what is held on deposit.
      const SECTIONS: [string, string][] = [
        ['consideration', 'Consideration'],
        ['statutory', 'Statutory charges'],
        ['deposit', 'Deposits'],
        ['other', 'Other'],
      ];
      for (const [key, heading] of SECTIONS) {
        const group = lines.filter((l: Record<string, unknown>) => l.section === key);
        if (!group.length) continue;
        rows.push({ label: heading.toUpperCase(), value: '' });
        for (const l of group) {
          const basis = l.basis === 'per_sqft'
            ? `  ${Number(l.quantity)} sq ft @ ${money(l.rate)}/sq ft`
            : l.basis === 'pct_of_consideration'
              ? `  ${Number(l.rate)}% of consideration`
              : '';
          rows.push({ label: `${l.label}${basis}`, value: money(l.amount) });
          if (Number(l.gst_amount) > 0) {
            rows.push({ label: `  GST @ ${Number(l.gst_pct)}%`, value: money(l.gst_amount) });
          }
        }
      }
      rows.push({ label: 'Total payable by buyer', value: money(totals.payable_by_buyer), strong: true });

      const tds = Number(totals.tds);
      if (tds > 0) {
        rows.push({ label: `Less: TDS u/s 194-IA @ ${Number(sheet.tds_pct)}% (deducted by buyer, remitted to the Income Tax Department)`, value: `(${money(tds)})` });
        rows.push({ label: 'Net remittance to the developer', value: money(totals.net_to_builder), strong: true });
      }

      const outro = [
        tds > 0
          ? `Tax at ${Number(sheet.tds_pct)}% is deductible at source under section 194-IA of the Income Tax Act, 1961, as the consideration equals or exceeds ${money(sheet.tds_threshold)}. The deduction is made by the purchaser from each payment and remitted to the Income Tax Department; it is not an additional cost, and the developer is to be paid the net amount shown above.`
          : `Tax is not deductible at source under section 194-IA, as the consideration is below ${money(sheet.tds_threshold)}.`,
        'Goods and Services Tax is charged on the consideration and on deposits at the rates shown against each line. Stamp duty and registration charges are statutory levies payable to the State Government and do not attract GST.',
        'Stamp duty, registration and other statutory charges are indicative and payable at the rates prevailing on the date of registration.',
      ];
      if (sheet.valid_until) outro.unshift(`This cost sheet is valid until ${pdfDate(sheet.valid_until as string, locale)}.`);
      if (sheet.notes) outro.push(String(sheet.notes));

      const pdf = await renderLetter({
        from: {
          name: (tenant?.company as string) || (tenant?.name as string) || 'Developer',
          address: (tenant?.address as string) || undefined,
          email: (tenant?.email as string) || undefined,
          phone: (tenant?.phone as string) || undefined,
        },
        title: 'Cost Sheet',
        reference: `Sheet No. ${sheet.sheet_no}  ·  ${sheet.issued_at ? 'Issued ' + pdfDate(sheet.issued_at as string, locale) : 'Draft'}`,
        to: { name: (sheet.customer_name as string) || 'Prospective Purchaser', lines: unit ? [unit] : [] },
        intro: [
          `The following is the itemised cost of ${unit || 'the unit'} as at the date of this sheet.`,
        ],
        rows,
        outro,
        footer: 'This cost sheet is a statement of charges and does not by itself constitute an offer, '
              + 'allotment or agreement for sale.',
      });

      reply
        .header('Content-Type', 'application/pdf')
        .header('Content-Length', String(pdf.length))
        .header('Content-Disposition', contentDisposition(`Cost-Sheet-${sheet.sheet_no}.pdf`, true))
        .headers(NOSNIFF)
        .header('Cache-Control', 'private, no-store');
      return reply.send(pdf);
    },
  );
}
