import type { FastifyInstance } from 'fastify';
import { withTenantContext } from '../db.js';
import { requireAuth } from '../auth.js';
import { buildTallyXml, unbalancedVouchers, tallyGroupFor, type TallyVoucher } from '../tally.js';
import { contentDisposition, NOSNIFF } from '../storage.js';

/**
 * Ledger export.
 *
 * Every builder in India runs Tally and none of them intends to stop. Without
 * this, an accounts team re-keys the month by hand — which is where the two
 * sets of books start to disagree.
 *
 * Only POSTED entries are exported. A draft is an entry somebody has typed and
 * nobody has approved; pushing those into the accounts would put unapproved
 * postings in front of a CA under the builder's name, and they would be very
 * hard to find again once mixed in with the real ones.
 */

async function gate(db: import('pg').PoolClient, perm: string): Promise<boolean> {
  const { rows: [{ allowed }] } = await db.query(`SELECT has_permission($1) AS allowed`, [perm]);
  return !!allowed;
}

export async function exportRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GET /api/exports/tally — the period's vouchers as a Tally import file.
   *
   * Read-gated on view_accounts: this is the ledger leaving the building, and
   * whoever can read it can read this.
   */
  app.get<{ Querystring: { from: string; to: string } }>(
    '/api/exports/tally',
    {
      preHandler: requireAuth,
      schema: {
        querystring: {
          type: 'object', required: ['from', 'to'],
          properties: {
            from: { type: 'string', minLength: 8, maxLength: 40 },
            to: { type: 'string', minLength: 8, maxLength: 40 },
          },
        },
      },
    },
    async (req, reply) => {
      const data = await withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'view_accounts')) return { forbidden: true } as const;

        const { rows: [tenant] } = await db.query(
          `SELECT name, company FROM tenants WHERE id = app_current_tenant()`);

        // Only the accounts the period actually touches. Exporting the whole
        // chart would create empty ledgers in the target company for accounts
        // this workspace has never posted to.
        const { rows: accounts } = await db.query(
          `SELECT DISTINCT coa.name, coa.account_type
             FROM chart_of_accounts coa
             JOIN journal_entry_lines jl ON jl.account_id = coa.id
             JOIN journal_entries je     ON je.id = jl.journal_entry_id
            WHERE je.entry_date BETWEEN $1::date AND $2::date
              AND je.status = 'posted'
            ORDER BY coa.name`,
          [req.query.from, req.query.to]);

        const { rows: entries } = await db.query(
          `SELECT je.id, to_char(je.entry_date, 'YYYY-MM-DD') AS entry_date,
                  je.reference, je.narration,
                  COALESCE(json_agg(json_build_object(
                    'accountName', coa.name, 'debit', jl.debit, 'credit', jl.credit, 'note', jl.note
                  ) ORDER BY jl.id) FILTER (WHERE jl.id IS NOT NULL), '[]'::json) AS lines
             FROM journal_entries je
             LEFT JOIN journal_entry_lines jl ON jl.journal_entry_id = je.id
             LEFT JOIN chart_of_accounts coa  ON coa.id = jl.account_id
            WHERE je.entry_date BETWEEN $1::date AND $2::date
              AND je.status = 'posted'
            GROUP BY je.id, je.entry_date, je.reference, je.narration
            ORDER BY je.entry_date, je.id`,
          [req.query.from, req.query.to]);

        return { tenant, accounts, entries };
      });

      if (data && 'forbidden' in data) {
        return reply.code(403).send({ error: 'Missing permission: view_accounts' });
      }

      const vouchers: TallyVoucher[] = data.entries.map((e: Record<string, unknown>) => ({
        date: e.entry_date as string,
        // A voucher must be identifiable in Tally to be reconcilable against
        // this system afterwards. The reference if there is one, the id if not.
        voucherNumber: (e.reference as string) || String(e.id).slice(0, 8).toUpperCase(),
        narration: (e.narration as string) || undefined,
        lines: (e.lines as Array<{ accountName: string; debit: string; credit: string; note?: string }>)
          .map(l => ({
            accountName: l.accountName,
            debit: Number(l.debit ?? 0),
            credit: Number(l.credit ?? 0),
            note: l.note || undefined,
          })),
      }));

      // Refuse to produce a file that will half-import. Tally rejects
      // unbalanced vouchers one at a time, so the rest of the month lands and
      // it looks like it worked — much harder to notice than a failed export.
      const unbalanced = unbalancedVouchers(vouchers);
      if (unbalanced.length) {
        return reply.code(409).send({
          error: `${unbalanced.length} voucher(s) do not balance and would be rejected by Tally, leaving the rest of the period imported. Fix them before exporting.`,
          unbalanced: unbalanced.slice(0, 20),
        });
      }

      const xml = buildTallyXml({
        companyName: (data.tenant?.company as string) || (data.tenant?.name as string) || 'Company',
        accounts: data.accounts.map((a: Record<string, unknown>) => ({
          name: a.name as string,
          accountType: a.account_type as string,
        })),
        vouchers,
      });

      reply
        .header('Content-Type', 'application/xml; charset=utf-8')
        .header('Content-Length', String(Buffer.byteLength(xml, 'utf8')))
        .header('Content-Disposition', contentDisposition(
          `Tally-${req.query.from}-to-${req.query.to}.xml`, false))
        .headers(NOSNIFF)
        .header('Cache-Control', 'private, no-store');
      return reply.send(xml);
    },
  );

  /**
   * GET /api/exports/tally/preflight — what the export would contain, and what
   * would stop it.
   *
   * An accounts team runs the export on the last day of the month under time
   * pressure. Finding out then that four vouchers do not balance is worse than
   * being able to check on the 28th.
   */
  app.get<{ Querystring: { from: string; to: string } }>(
    '/api/exports/tally/preflight',
    {
      preHandler: requireAuth,
      schema: {
        querystring: {
          type: 'object', required: ['from', 'to'],
          properties: {
            from: { type: 'string', minLength: 8, maxLength: 40 },
            to: { type: 'string', minLength: 8, maxLength: 40 },
          },
        },
      },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'view_accounts')) {
          return reply.code(403).send({ error: 'Missing permission: view_accounts' });
        }
        const { rows: entries } = await db.query(
          `SELECT je.id, je.reference,
                  COALESCE(SUM(jl.debit), 0)  AS debit,
                  COALESCE(SUM(jl.credit), 0) AS credit
             FROM journal_entries je
             LEFT JOIN journal_entry_lines jl ON jl.journal_entry_id = je.id
            WHERE je.entry_date BETWEEN $1::date AND $2::date
              AND je.status = 'posted'
            GROUP BY je.id, je.reference`,
          [req.query.from, req.query.to]);

        const unbalanced = entries
          .map(e => ({
            voucherNumber: (e.reference as string) || String(e.id).slice(0, 8).toUpperCase(),
            difference: Math.round((Number(e.debit) - Number(e.credit)) * 100) / 100,
          }))
          .filter(e => Math.abs(e.difference) > 0.009);

        const { rows: accounts } = await db.query(
          `SELECT DISTINCT coa.name, coa.account_type
             FROM chart_of_accounts coa
             JOIN journal_entry_lines jl ON jl.account_id = coa.id
             JOIN journal_entries je     ON je.id = jl.journal_entry_id
            WHERE je.entry_date BETWEEN $1::date AND $2::date
              AND je.status = 'posted'
            ORDER BY coa.name`,
          [req.query.from, req.query.to]);

        return {
          preflight: {
            vouchers: entries.length,
            ledgers: accounts.length,
            unbalanced,
            ready: unbalanced.length === 0,
            // Surfaced because a ledger landing in Suspense is a mapping the
            // accounts team should see before the file reaches their CA, not
            // after.
            suspense: accounts
              .filter((a: Record<string, unknown>) => tallyGroupFor(a.account_type as string) === 'Suspense A/c')
              .map((a: Record<string, unknown>) => ({ name: a.name, accountType: a.account_type })),
          },
        };
      }),
  );
}
