import type { FastifyInstance } from 'fastify';
import { withTenantContext } from '../db.js';
import { requireAuth } from '../auth.js';
import { PAGE_QUERY, readPage, keysetWhere, takePage } from '../pagination.js';

const UUID = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

const ACCOUNT_TYPES = ['asset', 'liability', 'income', 'expense', 'equity'] as const;
// The SPA's JournalSource (the DB CHECK additionally allows payroll/system).
const SOURCES = ['manual', 'vendor_bill', 'ra_bill', 'customer_payment', 'ap_payment'] as const;

// ── Chart of accounts ────────────────────────────────────────────────────────

function toApiAccount(r: Record<string, unknown>) {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    code: r.code,
    name: r.name,
    type: r.account_type,
    isSystem: r.is_system ?? false,
    active: r.is_active ?? true,
    createdAt: r.created_at,
  };
}

interface AccountBody { code?: string; name?: string; type?: string; isSystem?: boolean; active?: boolean; }

// ── Journal entries + lines ──────────────────────────────────────────────────

function toApiJournalEntry(r: Record<string, unknown>) {
  const lines = ((r.lines as unknown[]) ?? []).map((l) => {
    const line = l as Record<string, unknown>;
    return {
      id: line.id,
      accountId: line.accountId,
      debit: Number(line.debit) || 0,
      credit: Number(line.credit) || 0,
      note: line.note ?? undefined,
    };
  });
  return {
    id: r.id,
    tenantId: r.tenant_id,
    date: r.entry_date,          // to_char'd 'YYYY-MM-DD' in the SELECT
    narration: r.narration,
    reference: r.reference ?? undefined,
    sourceType: r.source_type,
    sourceId: r.source_id ?? undefined,
    projectId: (r.project_id as string) || undefined,
    status: r.status,
    lines,
    createdBy: r.created_by ?? '',
    postedBy: r.posted_by ?? undefined,
    postedAt: r.posted_at ?? undefined,
    createdAt: r.created_at,
  };
}

interface LineInput { accountId: string; debit?: number; credit?: number; note?: string; }
interface JournalBody {
  date?: string; narration?: string; reference?: string; sourceType?: string;
  sourceId?: string; projectId?: string; status?: string; lines?: LineInput[];
}

const LINE_SCHEMA = {
  type: 'object', required: ['accountId'], additionalProperties: false,
  properties: {
    accountId: { type: 'string', pattern: UUID },
    debit: { type: 'number', minimum: 0, maximum: 1e12 },
    credit: { type: 'number', minimum: 0, maximum: 1e12 },
    note: { type: 'string', maxLength: 300 },
  },
} as const;

// Entry + its lines, lines aggregated as JSON (empty array when none).
const JE_SELECT = `SELECT je.*, to_char(je.entry_date, 'YYYY-MM-DD') AS entry_date,
  COALESCE(
    (SELECT json_agg(json_build_object(
        'id', jl.id, 'accountId', jl.account_id, 'debit', jl.debit, 'credit', jl.credit, 'note', jl.note
      ) ORDER BY jl.id)
     FROM journal_entry_lines jl WHERE jl.journal_entry_id = je.id),
    '[]'::json
  ) AS lines
  FROM journal_entries je`;

const cents = (n: number) => Math.round(n * 100);

function mapWriteError(err: unknown): { error: string } | null {
  switch ((err as { code?: string })?.code) {
    case '23514': return { error: 'A journal line must have exactly one of debit or credit.' };
    case '23503': return { error: 'A referenced account does not exist.' };
    case '23505': return { error: 'An account with that code already exists.' };
    case '23502': return { error: 'A required field is missing.' };
    case '22P02': return { error: 'A field has an invalid format.' };
    default: return null;
  }
}

export async function financeRoutes(app: FastifyInstance): Promise<void> {
  // ── Chart of accounts ──────────────────────────────────────────────────────
  //
  // GATED ON view_accounts / manage_accounts, NOT view_finance.
  //
  // These are two different permissions describing two different things, and
  // the product already treats them that way: the SPA puts Billing & Payments
  // behind view_finance and Accounts & Ledger behind view_accounts, and
  // complianceRoutes has always gated on view_accounts. These four handlers
  // were the exception, checking the broader key.
  //
  // The gap was reachable. A sales_manager legitimately holds view_finance —
  // they chase receivables — and does not hold view_accounts. Until this
  // change, the UI correctly hid Accounts & Ledger from them while the API
  // handed over the whole chart of accounts and every posted journal entry to
  // anyone who asked for it directly. An RBAC boundary enforced only in the
  // client is not a boundary.
  //
  // Nothing loses access that should have it: accountant, auditor,
  // builder_admin and super_admin all hold view_accounts already, and
  // sales_manager is the only role in ROLE_PERMS with view_finance but not
  // view_accounts — which is exactly the case this closes.

  app.get('/api/accounts', { preHandler: requireAuth }, async (req, reply) =>
    withTenantContext(req.ctx, async (db) => {
      const { rows: [{ allowed }] } = await db.query(`SELECT has_permission('view_accounts') AS allowed`);
      if (!allowed) return reply.code(403).send({ error: 'Missing permission: view_accounts' });
      const { rows } = await db.query('SELECT * FROM chart_of_accounts ORDER BY code');
      return { accounts: rows.map(toApiAccount) };
    }),
  );

  app.post<{ Body: AccountBody }>(
    '/api/accounts',
    {
      preHandler: requireAuth,
      schema: {
        body: {
          type: 'object', required: ['code', 'name', 'type'], additionalProperties: false,
          properties: {
            code: { type: 'string', minLength: 1, maxLength: 20 },
            name: { type: 'string', minLength: 1, maxLength: 200 },
            type: { type: 'string', enum: ACCOUNT_TYPES as unknown as string[] },
            isSystem: { type: 'boolean' },
            active: { type: 'boolean' },
          },
        },
      },
    },
    async (req, reply) => {
      try {
        return await withTenantContext(req.ctx, async (db) => {
          const { rows: [{ allowed }] } = await db.query(`SELECT has_permission('manage_accounts') AS allowed`);
          if (!allowed) return reply.code(403).send({ error: 'Missing permission: manage_accounts' });
          const { rows } = await db.query(
            `INSERT INTO chart_of_accounts (tenant_id, code, name, account_type, is_system, is_active)
             VALUES (app_current_tenant(), $1, $2, $3, $4, $5) RETURNING *`,
            [req.body.code, req.body.name, req.body.type, req.body.isSystem ?? false, req.body.active ?? true],
          );
          reply.code(201); return { account: toApiAccount(rows[0]) };
        });
      } catch (err) {
        const mapped = mapWriteError(err);
        if (mapped) return reply.code(400).send(mapped);
        throw err;
      }
    },
  );

  app.patch<{ Params: { id: string }; Body: { name?: string; active?: boolean } }>(
    '/api/accounts/:id',
    {
      preHandler: requireAuth,
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: UUID } } },
        body: { type: 'object', minProperties: 1, additionalProperties: false, properties: { name: { type: 'string', minLength: 1, maxLength: 200 }, active: { type: 'boolean' } } },
      },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        const { rows: [{ allowed }] } = await db.query(`SELECT has_permission('manage_accounts') AS allowed`);
        if (!allowed) return reply.code(403).send({ error: 'Missing permission: manage_accounts' });
        const sets: string[] = [];
        const params: unknown[] = [];
        if (req.body.name !== undefined) { params.push(req.body.name); sets.push(`name = $${params.length}`); }
        if (req.body.active !== undefined) { params.push(req.body.active); sets.push(`is_active = $${params.length}`); }
        params.push(req.params.id);
        const { rows } = await db.query(`UPDATE chart_of_accounts SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`, params);
        if (rows.length === 0) return reply.code(404).send({ error: 'Account not found' });
        return { account: toApiAccount(rows[0]) };
      }),
  );

  // ── Journal entries ────────────────────────────────────────────────────────

  app.get<{ Querystring: { limit?: number; cursor?: string } }>(
    '/api/journal-entries',
    { preHandler: requireAuth, schema: { querystring: { type: 'object', properties: PAGE_QUERY } } },
    async (req, reply) =>
    withTenantContext(req.ctx, async (db) => {
      // The books themselves — every posting the business has made. If any
      // endpoint in this file deserves the narrower key it is this one.
      const { rows: [{ allowed }] } = await db.query(`SELECT has_permission('view_accounts') AS allowed`);
      if (!allowed) return reply.code(403).send({ error: 'Missing permission: view_accounts' });
      // The ledger never shrinks, so this is the read most certain to outgrow
      // one response. Keyed on created_at: entry_date is the accounting date
      // and can be back-dated, which would move a row between pages.
      const page = readPage(req.query);
      const ks = keysetWhere(page, 'je.created_at', 'je.id', 1);
      const { rows } = await db.query(
        `${JE_SELECT} ${ks.sql ? `WHERE ${ks.sql}` : ''}
          ORDER BY je.created_at DESC, je.id DESC
          LIMIT ${page.limit + 1}`, ks.params);
      const out = takePage(rows, page, 'created_at');
      return { entries: out.rows.map(toApiJournalEntry), nextCursor: out.nextCursor };
    }),
  );

  /**
   * POST /api/journal-entries — post a balanced entry. This is the ledger's
   * integrity gate: the DB enforces one-sidedness per line (CHECK), but NOT that
   * the entry balances, so we do here — reject unless there are ≥2 non-zero
   * lines and Σdebit === Σcredit to the paisa. Entry + lines insert in one
   * transaction (withTenantContext), so a rejected line rolls the whole thing
   * back and the ledger never stores a half-posting.
   */
  app.post<{ Body: JournalBody }>(
    '/api/journal-entries',
    {
      preHandler: requireAuth,
      schema: {
        body: {
          type: 'object', required: ['narration', 'lines'], additionalProperties: false,
          properties: {
            date: { type: 'string', maxLength: 40 },
            narration: { type: 'string', minLength: 1, maxLength: 500 },
            reference: { type: 'string', maxLength: 120 },
            sourceType: { type: 'string', enum: SOURCES as unknown as string[] },
            sourceId: { type: 'string', pattern: UUID },
            projectId: { type: 'string', maxLength: 64 },
            status: { type: 'string', enum: ['draft', 'posted'] },
            lines: { type: 'array', minItems: 2, maxItems: 100, items: LINE_SCHEMA },
          },
        },
      },
    },
    async (req, reply) => {
      // Balance gate — computed before touching the DB.
      const lines = (req.body.lines ?? []).filter(l => (l.debit ?? 0) > 0 || (l.credit ?? 0) > 0);
      if (lines.length < 2) return reply.code(400).send({ error: 'A journal entry needs at least two non-zero lines.' });
      for (const l of lines) {
        if ((l.debit ?? 0) > 0 && (l.credit ?? 0) > 0) return reply.code(400).send({ error: 'A line cannot have both a debit and a credit.' });
      }
      const dr = lines.reduce((s, l) => s + (l.debit ?? 0), 0);
      const cr = lines.reduce((s, l) => s + (l.credit ?? 0), 0);
      if (cents(dr) !== cents(cr)) {
        return reply.code(400).send({ error: `Entry does not balance: debits ${dr} ≠ credits ${cr}.` });
      }

      try {
        return await withTenantContext(req.ctx, async (db) => {
          const { rows: [{ allowed }] } = await db.query(`SELECT has_permission('manage_accounts') AS allowed`);
          if (!allowed) return reply.code(403).send({ error: 'Missing permission: manage_accounts' });

          // The line→account FK is DEFERRABLE INITIALLY DEFERRED, so a bad
          // account_id would only surface at COMMIT — AFTER this handler has
          // sent its response — leaving the client a false 201 on a rolled-back
          // write. Check existence up front (RLS-scoped) so a missing account is
          // a clean 400 here instead.
          const accountIds = [...new Set(lines.map(l => l.accountId))];
          const { rows: [{ n }] } = await db.query(
            'SELECT count(*)::int AS n FROM chart_of_accounts WHERE id = ANY($1::uuid[])', [accountIds],
          );
          if (n !== accountIds.length) return reply.code(400).send({ error: 'A referenced account does not exist.' });

          const status = req.body.status ?? 'posted';
          const { rows: [entry] } = await db.query(
            `INSERT INTO journal_entries
               (tenant_id, entry_date, narration, reference, source_type, source_id, project_id, status, created_by, posted_by, posted_at)
             VALUES (app_current_tenant(), COALESCE($1::date, CURRENT_DATE), $2, $3, $4, $5, $6, $7, app_current_user(),
                     CASE WHEN $7 = 'posted' THEN app_current_user() ELSE NULL END,
                     CASE WHEN $7 = 'posted' THEN now() ELSE NULL END)
             RETURNING id`,
            [req.body.date || null, req.body.narration, req.body.reference ?? null, req.body.sourceType ?? 'manual',
             req.body.sourceId ?? null, req.body.projectId ?? '', status],
          );
          for (const l of lines) {
            await db.query(
              `INSERT INTO journal_entry_lines (tenant_id, journal_entry_id, account_id, debit, credit, note)
               VALUES (app_current_tenant(), $1, $2, $3, $4, $5)`,
              [entry.id, l.accountId, l.debit ?? 0, l.credit ?? 0, l.note ?? null],
            );
          }
          const { rows } = await db.query(`${JE_SELECT} WHERE je.id = $1`, [entry.id]);
          reply.code(201); return { entry: toApiJournalEntry(rows[0]) };
        });
      } catch (err) {
        const mapped = mapWriteError(err);
        if (mapped) return reply.code(400).send(mapped);
        throw err;
      }
    },
  );
}
