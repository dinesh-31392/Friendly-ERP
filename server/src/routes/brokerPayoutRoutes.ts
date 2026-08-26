import type { FastifyInstance } from 'fastify';
import { withTenantContext } from '../db.js';
import { requireAuth } from '../auth.js';
import { renderLetter, pdfMoney, pdfDate } from '../pdf.js';
import { contentDisposition, NOSNIFF } from '../storage.js';

/**
 * Broker payout runs (migration 052).
 *
 * The commission ledger recorded what a broker had earned and what had been
 * paid, and stopped there. There was no run — no way to take a period's
 * approved brokerage, deduct what the law requires, produce an advice the
 * broker can reconcile against, and mark the lot paid in one auditable act.
 *
 * See the migration for the two rules this exists to get right: TDS is computed
 * on the brokerage and NOT on the GST-inclusive figure, and the 194-H threshold
 * is aggregate across the financial year, so the run that crosses it owes the
 * catch-up on everything paid earlier without deduction.
 */

const UUID = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

async function gate(db: import('pg').PoolClient, perm: string): Promise<boolean> {
  const { rows: [{ allowed }] } = await db.query(`SELECT has_permission($1) AS allowed`, [perm]);
  return !!allowed;
}

const round2 = (n: number) => Math.round((Number.isFinite(n) ? n : 0) * 100) / 100;

export interface BrokerLineInput {
  /** Brokerage earned in THIS run, before anything is added or taken off. */
  gross: number;
  /** 18% for a GST-registered broker, 0 otherwise. ADDED to the payout. */
  gstPct: number;
  /** Credited to this broker earlier in the same financial year. */
  fyPriorGross: number;
  /** Already deducted on that earlier amount — usually zero, which is exactly
   *  why the catch-up exists. */
  fyPriorTds: number;
}

/**
 * One broker's line: what is added, what is deducted, and what is paid.
 *
 * TDS is on the BROKERAGE, not the GST-inclusive figure — GST is not the
 * broker's income, and deducting on the gross overcharges them by the tax on a
 * tax on every run.
 *
 * The threshold is measured on the financial-year aggregate. Once it is
 * crossed, tax is due on the whole of that aggregate; anything already deducted
 * is credited, and the rest falls on this payment. A broker paid 18,000 with no
 * deduction who then earns 5,000 does not owe 2% of 5,000 — they owe 2% of
 * 23,000, and the builder is liable for the shortfall if it is missed.
 */
export function computeBrokerLine(i: BrokerLineInput, tdsPct: number, threshold: number): {
  gstAmount: number; tdsAmount: number; netAmount: number; thresholdCrossed: boolean;
} {
  const gross = Number(i.gross);
  const gstAmount = round2(gross * Number(i.gstPct) / 100);

  const fyAggregate = Number(i.fyPriorGross) + gross;
  const thresholdCrossed = fyAggregate >= Number(threshold);

  // Below the threshold nothing is deducted — not even on the part above it,
  // because the section works on the aggregate rather than on an excess.
  const dueOnAggregate = thresholdCrossed ? round2(fyAggregate * Number(tdsPct) / 100) : 0;
  // Never negative: a prior over-deduction is a matter for the broker's return,
  // not something to refund out of this run.
  const tdsAmount = Math.max(0, round2(dueOnAggregate - Number(i.fyPriorTds)));

  return { gstAmount, tdsAmount, netAmount: round2(gross + gstAmount - tdsAmount), thresholdCrossed };
}

const toApiLine = (r: Record<string, unknown>) => ({
  id: r.id,
  brokerId: r.broker_id,
  brokerName: r.broker_name ?? undefined,
  agencyName: r.agency_name ?? undefined,
  reraId: r.rera_id ?? undefined,
  grossAmount: Number(r.gross_amount),
  gstPct: Number(r.gst_pct),
  gstAmount: Number(r.gst_amount),
  fyPriorGross: Number(r.fy_prior_gross),
  fyPriorTds: Number(r.fy_prior_tds),
  tdsPct: Number(r.tds_pct),
  tdsAmount: Number(r.tds_amount),
  netAmount: Number(r.net_amount),
});

const toApiRun = (r: Record<string, unknown>, lines: Record<string, unknown>[] = []) => ({
  id: r.id,
  runNo: r.run_no,
  periodStart: r.period_start,
  periodEnd: r.period_end,
  fyStart: r.fy_start,
  tdsPct: Number(r.tds_pct),
  tdsThreshold: Number(r.tds_threshold),
  status: r.status,
  grossTotal: Number(r.gross_total),
  gstTotal: Number(r.gst_total),
  tdsTotal: Number(r.tds_total),
  netTotal: Number(r.net_total),
  paidOn: r.paid_on ?? null,
  paymentReference: r.payment_reference ?? '',
  approvedAt: r.approved_at ?? null,
  createdAt: r.created_at,
  lines: lines.map(toApiLine),
});

const LINES_SQL = `
  SELECT pl.*, b.name AS broker_name, b.agency_name, b.rera_id
    FROM broker_payout_lines pl
    JOIN brokers b ON b.id = pl.broker_id
   WHERE pl.run_id = $1
   ORDER BY b.name`;

export async function brokerPayoutRoutes(app: FastifyInstance): Promise<void> {
  /** GET /api/broker-payouts — the runs. */
  app.get('/api/broker-payouts', { preHandler: requireAuth }, async (req, reply) =>
    withTenantContext(req.ctx, async (db) => {
      if (!await gate(db, 'view_brokers')) {
        return reply.code(403).send({ error: 'Missing permission: view_brokers' });
      }
      const { rows } = await db.query(
        'SELECT * FROM broker_payout_runs ORDER BY created_at DESC LIMIT 200');
      return { runs: rows.map(r => toApiRun(r)) };
    }),
  );

  /** GET /api/broker-payouts/:id — a run with its lines. */
  app.get<{ Params: { id: string } }>(
    '/api/broker-payouts/:id',
    { preHandler: requireAuth, schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: UUID } } } } },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'view_brokers')) {
          return reply.code(403).send({ error: 'Missing permission: view_brokers' });
        }
        const { rows: [run] } = await db.query('SELECT * FROM broker_payout_runs WHERE id = $1', [req.params.id]);
        if (!run) return reply.code(404).send({ error: 'Payout run not found' });
        const { rows: lines } = await db.query(LINES_SQL, [run.id]);
        return { run: toApiRun(run, lines) };
      }),
  );

  /**
   * POST /api/broker-payouts — build a run for a period.
   *
   * Picks up every approved, unpaid commission whose booking falls in the
   * period and which is not already on a run, groups them by broker, and
   * computes each line. A commission can only ever be on one run — enforced by
   * a unique constraint, not by this handler, because a payout is exactly the
   * code path someone re-runs "just to be sure".
   */
  app.post<{ Body: { periodStart: string; periodEnd: string; tdsPct?: number; tdsThreshold?: number; defaultGstPct?: number } }>(
    '/api/broker-payouts',
    {
      preHandler: requireAuth,
      schema: {
        body: {
          type: 'object', required: ['periodStart', 'periodEnd'], additionalProperties: false,
          properties: {
            periodStart: { type: 'string', minLength: 8, maxLength: 40 },
            periodEnd: { type: 'string', minLength: 8, maxLength: 40 },
            tdsPct: { type: 'number', minimum: 0, maximum: 100 },
            tdsThreshold: { type: 'number', minimum: 0, maximum: 1e9 },
            // 18 for a registered broker. Per-broker rates are an edit on the
            // line; this is the starting point for the run.
            defaultGstPct: { type: 'number', minimum: 0, maximum: 100 },
          },
        },
      },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'manage_brokers')) {
          return reply.code(403).send({ error: 'Missing permission: manage_brokers' });
        }
        const tdsPct = Number(req.body.tdsPct ?? 2);
        const threshold = Number(req.body.tdsThreshold ?? 20000);
        const gstPct = Number(req.body.defaultGstPct ?? 0);

        const { rows: [run] } = await db.query(
          `INSERT INTO broker_payout_runs
             (tenant_id, run_no, period_start, period_end, fy_start, tds_pct, tds_threshold, created_by)
           VALUES (app_current_tenant(),
                   (SELECT COALESCE(MAX(run_no), 0) + 1 FROM broker_payout_runs),
                   $1::date, $2::date, indian_fy_start($2::date), $3, $4, $5)
           RETURNING *`,
          [req.body.periodStart, req.body.periodEnd, tdsPct, threshold, req.ctx.userId]);

        // Commissions earned, not yet paid, not already on a run.
        const { rows: due } = await db.query(
          `SELECT cl.id, cl.broker_id, cl.amount_earned, cl.amount_paid
             FROM commission_ledger cl
            WHERE cl.status <> 'paid'
              AND cl.created_at::date BETWEEN $1::date AND $2::date
              AND NOT EXISTS (SELECT 1 FROM broker_payout_items i WHERE i.commission_id = cl.id)
            ORDER BY cl.broker_id`,
          [req.body.periodStart, req.body.periodEnd]);

        const byBroker = new Map<string, { gross: number; ids: Array<{ id: string; amount: number }> }>();
        for (const c of due) {
          const outstanding = Number(c.amount_earned) - Number(c.amount_paid ?? 0);
          if (outstanding <= 0) continue;
          const g = byBroker.get(c.broker_id) ?? { gross: 0, ids: [] };
          g.gross += outstanding;
          g.ids.push({ id: c.id, amount: outstanding });
          byBroker.set(c.broker_id, g);
        }

        let grossTotal = 0, gstTotal = 0, tdsTotal = 0, netTotal = 0;
        for (const [brokerId, g] of byBroker) {
          // What this broker was already credited THIS financial year, on
          // earlier runs. This is the number the threshold turns on.
          const { rows: [prior] } = await db.query(
            `SELECT COALESCE(SUM(pl.gross_amount), 0) AS gross,
                    COALESCE(SUM(pl.tds_amount), 0)   AS tds
               FROM broker_payout_lines pl
               JOIN broker_payout_runs r ON r.id = pl.run_id
              WHERE pl.broker_id = $1
                AND r.fy_start = $2
                AND r.id <> $3
                AND r.status <> 'cancelled'`,
            [brokerId, run.fy_start, run.id]);

          const calc = computeBrokerLine(
            { gross: round2(g.gross), gstPct, fyPriorGross: Number(prior.gross), fyPriorTds: Number(prior.tds) },
            tdsPct, threshold);

          const { rows: [line] } = await db.query(
            `INSERT INTO broker_payout_lines
               (tenant_id, run_id, broker_id, gross_amount, gst_pct, gst_amount,
                fy_prior_gross, fy_prior_tds, tds_pct, tds_amount, net_amount)
             VALUES (app_current_tenant(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
             RETURNING id`,
            [run.id, brokerId, round2(g.gross), gstPct, calc.gstAmount,
             Number(prior.gross), Number(prior.tds),
             calc.thresholdCrossed ? tdsPct : 0, calc.tdsAmount, calc.netAmount]);

          for (const item of g.ids) {
            await db.query(
              `INSERT INTO broker_payout_items (tenant_id, line_id, commission_id, amount)
               VALUES (app_current_tenant(), $1, $2, $3)`,
              [line.id, item.id, item.amount]);
          }

          grossTotal += g.gross; gstTotal += calc.gstAmount;
          tdsTotal += calc.tdsAmount; netTotal += calc.netAmount;
        }

        const { rows: [updated] } = await db.query(
          `UPDATE broker_payout_runs
              SET gross_total = $1, gst_total = $2, tds_total = $3, net_total = $4
            WHERE id = $5 RETURNING *`,
          [round2(grossTotal), round2(gstTotal), round2(tdsTotal), round2(netTotal), run.id]);
        const { rows: lines } = await db.query(LINES_SQL, [run.id]);

        reply.code(201);
        return { run: toApiRun(updated, lines) };
      }),
  );

  /**
   * PATCH /api/broker-payouts/:id — approve, pay, or cancel.
   *
   * Marking a run paid settles its commissions in the same transaction. Doing
   * it in two calls would leave a window in which the money has gone out and
   * the ledger still shows the brokerage owing — which is how a broker gets
   * paid twice.
   */
  app.patch<{ Params: { id: string }; Body: { status: string; paymentReference?: string } }>(
    '/api/broker-payouts/:id',
    {
      preHandler: requireAuth,
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: UUID } } },
        body: {
          type: 'object', required: ['status'], additionalProperties: false,
          properties: {
            status: { type: 'string', enum: ['approved', 'paid', 'cancelled'] },
            paymentReference: { type: 'string', maxLength: 120 },
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
          draft:     ['approved', 'cancelled'],
          approved:  ['paid', 'cancelled'],
          paid:      [],
          cancelled: [],
        };
        const { rows: [run] } = await db.query('SELECT * FROM broker_payout_runs WHERE id = $1', [req.params.id]);
        if (!run) return reply.code(404).send({ error: 'Payout run not found' });
        if (!ALLOWED[run.status]?.includes(req.body.status)) {
          return reply.code(409).send({ error: `A ${run.status} run cannot become ${req.body.status}.` });
        }
        if (req.body.status === 'paid' && !req.body.paymentReference?.trim()) {
          return reply.code(400).send({ error: 'A payment reference is required when marking a run paid.' });
        }

        await db.query(
          `UPDATE broker_payout_runs
              SET status = $1,
                  approved_by = CASE WHEN $1 = 'approved' THEN $3 ELSE approved_by END,
                  approved_at = CASE WHEN $1 = 'approved' THEN now() ELSE approved_at END,
                  paid_on     = CASE WHEN $1 = 'paid' THEN CURRENT_DATE ELSE paid_on END,
                  payment_reference = COALESCE($2, payment_reference)
            WHERE id = $4`,
          [req.body.status, req.body.paymentReference ?? null, req.ctx.userId, req.params.id]);

        if (req.body.status === 'paid') {
          // Same transaction as the status change. Two calls would leave a
          // window where the money is out and the ledger still shows it owing.
          await db.query(
            `UPDATE commission_ledger cl
                SET amount_paid = cl.amount_earned, status = 'paid'
               FROM broker_payout_items i
               JOIN broker_payout_lines pl ON pl.id = i.line_id
              WHERE i.commission_id = cl.id AND pl.run_id = $1`,
            [req.params.id]);
        }

        const { rows: [after] } = await db.query('SELECT * FROM broker_payout_runs WHERE id = $1', [req.params.id]);
        const { rows: lines } = await db.query(LINES_SQL, [req.params.id]);
        return { run: toApiRun(after, lines) };
      }),
  );

  /**
   * GET /api/broker-payouts/:id/pdf — the payment advice.
   *
   * What a broker reconciles their own books against. Every line names the
   * brokerage, the GST added, and the tax deducted with its section — because
   * a broker who cannot see why they were paid less than they invoiced will
   * ring about it.
   */
  app.get<{ Params: { id: string } }>(
    '/api/broker-payouts/:id/pdf',
    { preHandler: requireAuth, schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: UUID } } } } },
    async (req, reply) => {
      const data = await withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'view_brokers')) return { forbidden: true } as const;
        const { rows: [run] } = await db.query('SELECT * FROM broker_payout_runs WHERE id = $1', [req.params.id]);
        if (!run) return null;
        const { rows: lines } = await db.query(LINES_SQL, [run.id]);
        const { rows: [t] } = await db.query(
          `SELECT name, company, address, email, phone, currency FROM tenants WHERE id = app_current_tenant()`);
        return { run, lines, tenant: t };
      });

      if (data && 'forbidden' in data) return reply.code(403).send({ error: 'Missing permission: view_brokers' });
      if (!data) return reply.code(404).send({ error: 'Payout run not found' });

      const { run, lines, tenant } = data;
      const ccy = (tenant?.currency as string) || 'INR';
      const locale = ccy === 'INR' ? 'en-IN' : 'en-US';
      const money = (n: unknown) => pdfMoney(Number(n ?? 0), ccy, locale);

      const rows: { label: string; value: string; strong?: boolean }[] = [];
      for (const l of lines) {
        rows.push({ label: `${l.broker_name}${l.agency_name ? ` (${l.agency_name})` : ''}`, value: money(l.gross_amount) });
        if (Number(l.gst_amount) > 0) rows.push({ label: `  GST @ ${Number(l.gst_pct)}%`, value: money(l.gst_amount) });
        if (Number(l.tds_amount) > 0) {
          // Named so a broker seeing a smaller cheque knows what happened.
          rows.push({ label: `  Less: TDS u/s 194-H @ ${Number(l.tds_pct)}%`, value: `(${money(l.tds_amount)})` });
          if (Number(l.fy_prior_gross) > 0) {
            rows.push({ label: `    computed on the year-to-date aggregate of ${money(Number(l.fy_prior_gross) + Number(l.gross_amount))}`, value: '' });
          }
        }
        rows.push({ label: '  Net payable', value: money(l.net_amount) });
      }
      rows.push({ label: 'Total net payable', value: money(run.net_total), strong: true });

      const pdf = await renderLetter({
        from: {
          name: (tenant?.company as string) || (tenant?.name as string) || 'Developer',
          address: (tenant?.address as string) || undefined,
          email: (tenant?.email as string) || undefined,
          phone: (tenant?.phone as string) || undefined,
        },
        title: 'Brokerage Payment Advice',
        reference: `Run No. ${run.run_no}  ·  ${pdfDate(run.period_start as string, locale)} to ${pdfDate(run.period_end as string, locale)}  ·  ${run.status}`,
        to: { name: 'Channel Partners', lines: [] },
        intro: [
          `Brokerage for the period ${pdfDate(run.period_start as string, locale)} to ${pdfDate(run.period_end as string, locale)}, set out below by channel partner.`,
        ],
        rows,
        outro: [
          `Tax has been deducted at source under section 194-H of the Income Tax Act, 1961 at ${Number(run.tds_pct)}% where the aggregate credited during the financial year commencing ${pdfDate(run.fy_start as string, locale)} equals or exceeds ${money(run.tds_threshold)}. Where the threshold was crossed during the year, the deduction shown covers the aggregate for the year to date, net of any tax already deducted.`,
          'Goods and Services Tax, where shown, is payable in addition to the brokerage and is not part of the amount on which tax is deducted at source.',
          run.paid_on
            ? `Paid on ${pdfDate(run.paid_on as string, locale)}${run.payment_reference ? ` under reference ${run.payment_reference}` : ''}.`
            : 'This advice is issued in advance of payment.',
        ],
        footer: 'Certificates of tax deducted will be issued in Form 16A in the usual course.',
      });

      reply
        .header('Content-Type', 'application/pdf')
        .header('Content-Length', String(pdf.length))
        .header('Content-Disposition', contentDisposition(`Brokerage-Advice-${run.run_no}.pdf`, true))
        .headers(NOSNIFF)
        .header('Cache-Control', 'private, no-store');
      return reply.send(pdf);
    },
  );
}
