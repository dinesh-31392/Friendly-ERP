import type { FastifyInstance } from 'fastify';
import { withTenantContext } from '../db.js';
import { requireAuth } from '../auth.js';

/**
 * Finance backbone — bank accounts + bank-transaction reconciliation, and loans
 * + repayment schedules. Tables exist since migration 004 but had no API; this
 * finishes the 004 finance surface as real multi-tenant SaaS (RLS + RBAC).
 */

const UUID = '^[0-9a-fA-F-]{36}$';
const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));
async function gate(db: import('pg').PoolClient, perm: string): Promise<boolean> {
  const { rows: [{ allowed }] } = await db.query(`SELECT has_permission($1) AS allowed`, [perm]);
  return !!allowed;
}

export async function financeBankRoutes(app: FastifyInstance): Promise<void> {
  // ── Bank accounts ───────────────────────────────────────────────────────
  app.get('/api/bank-accounts', { preHandler: requireAuth }, async (req, reply) =>
    withTenantContext(req.ctx, async (db) => {
      if (!await gate(db, 'view_finance')) return reply.code(403).send({ error: 'Missing permission: view_finance' });
      const { rows } = await db.query('SELECT * FROM bank_accounts ORDER BY account_name');
      return { accounts: rows.map(r => ({ id: r.id, accountName: r.account_name, accountNumber: r.account_number, bankName: r.bank_name, openingBalance: num(r.opening_balance) })) };
    }),
  );

  app.post<{ Body: { accountName: string; accountNumber?: string; bankName?: string; openingBalance?: number } }>(
    '/api/bank-accounts',
    {
      preHandler: requireAuth,
      schema: { body: { type: 'object', required: ['accountName'], additionalProperties: false, properties: {
        accountName: { type: 'string', minLength: 1, maxLength: 120 }, accountNumber: { type: 'string', maxLength: 40 },
        bankName: { type: 'string', maxLength: 120 }, openingBalance: { type: 'number' },
      } } },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'manage_finance')) return reply.code(403).send({ error: 'Missing permission: manage_finance' });
        const { rows } = await db.query(
          `INSERT INTO bank_accounts (tenant_id, account_name, account_number, bank_name, opening_balance)
           VALUES (app_current_tenant(), $1, $2, $3, $4) RETURNING *`,
          [req.body.accountName, req.body.accountNumber || null, req.body.bankName || null, req.body.openingBalance ?? 0]);
        const r = rows[0];
        reply.code(201); return { account: { id: r.id, accountName: r.account_name, accountNumber: r.account_number, bankName: r.bank_name, openingBalance: num(r.opening_balance) } };
      }),
  );

  // ── Bank transactions + reconciliation ──────────────────────────────────
  const txnToApi = (r: Record<string, unknown>) => ({
    id: r.id, bankAccountId: r.bank_account_id, date: r.txn_date, description: r.description,
    amount: num(r.amount), type: r.txn_type, reconciled: r.reconciled, matchedJournalEntryId: r.matched_journal_entry_id,
  });

  app.get<{ Querystring: { bankAccountId?: string } }>('/api/bank-transactions', { preHandler: requireAuth }, async (req, reply) =>
    withTenantContext(req.ctx, async (db) => {
      if (!await gate(db, 'view_finance')) return reply.code(403).send({ error: 'Missing permission: view_finance' });
      const { rows } = req.query.bankAccountId
        ? await db.query('SELECT * FROM bank_transactions WHERE bank_account_id = $1 ORDER BY txn_date DESC', [req.query.bankAccountId])
        : await db.query('SELECT * FROM bank_transactions ORDER BY txn_date DESC');
      return { transactions: rows.map(txnToApi) };
    }),
  );

  app.post<{ Body: { bankAccountId: string; txnDate?: string; description?: string; amount: number; type: string } }>(
    '/api/bank-transactions',
    {
      preHandler: requireAuth,
      schema: { body: { type: 'object', required: ['bankAccountId', 'amount', 'type'], additionalProperties: false, properties: {
        bankAccountId: { type: 'string', pattern: UUID }, txnDate: { type: 'string' }, description: { type: 'string', maxLength: 300 },
        amount: { type: 'number', exclusiveMinimum: 0 }, type: { type: 'string', enum: ['debit', 'credit'] },
      } } },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'manage_finance')) return reply.code(403).send({ error: 'Missing permission: manage_finance' });
        const { rows: ba } = await db.query('SELECT id FROM bank_accounts WHERE id = $1', [req.body.bankAccountId]);
        if (!ba[0]) return reply.code(404).send({ error: 'Bank account not found' });
        const { rows } = await db.query(
          `INSERT INTO bank_transactions (tenant_id, bank_account_id, txn_date, description, amount, txn_type)
           VALUES (app_current_tenant(), $1, COALESCE($2, CURRENT_DATE), $3, $4, $5) RETURNING *`,
          [req.body.bankAccountId, req.body.txnDate || null, req.body.description || '', req.body.amount, req.body.type]);
        reply.code(201); return { transaction: txnToApi(rows[0]) };
      }),
  );

  app.patch<{ Params: { id: string }; Body: { reconciled: boolean; matchedJournalEntryId?: string } }>(
    '/api/bank-transactions/:id',
    {
      preHandler: requireAuth,
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: UUID } } },
        body: { type: 'object', required: ['reconciled'], additionalProperties: false, properties: { reconciled: { type: 'boolean' }, matchedJournalEntryId: { type: 'string', pattern: UUID } } },
      },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'manage_finance')) return reply.code(403).send({ error: 'Missing permission: manage_finance' });
        const { rows } = await db.query(
          `UPDATE bank_transactions SET reconciled = $1, matched_journal_entry_id = $2 WHERE id = $3 RETURNING *`,
          [req.body.reconciled, req.body.matchedJournalEntryId || null, req.params.id]);
        if (!rows[0]) return reply.code(404).send({ error: 'Transaction not found' });
        return { transaction: txnToApi(rows[0]) };
      }),
  );

  // ── Loans + repayment schedule ──────────────────────────────────────────
  const loanToApi = (r: Record<string, unknown>) => ({
    id: r.id, projectId: r.project_id, lenderName: r.lender_name, loanType: r.loan_type,
    principalAmount: num(r.principal_amount), interestRate: num(r.interest_rate), startDate: r.start_date, status: r.status,
    tenureMonths: Number(r.tenure_months ?? 0), tdsPct: num(r.tds_pct),
  });

  app.get('/api/loans', { preHandler: requireAuth }, async (req, reply) =>
    withTenantContext(req.ctx, async (db) => {
      if (!await gate(db, 'view_finance')) return reply.code(403).send({ error: 'Missing permission: view_finance' });
      const { rows } = await db.query('SELECT * FROM loans ORDER BY start_date DESC');
      return { loans: rows.map(loanToApi) };
    }),
  );

  app.post<{ Body: { lenderName: string; projectId?: string; loanType?: string; principalAmount: number; interestRate?: number; startDate?: string; tenureMonths?: number; tdsPct?: number } }>(
    '/api/loans',
    {
      preHandler: requireAuth,
      schema: { body: { type: 'object', required: ['lenderName', 'principalAmount'], additionalProperties: false, properties: {
        lenderName: { type: 'string', minLength: 1, maxLength: 160 }, projectId: { type: 'string', pattern: UUID },
        loanType: { type: 'string', enum: ['term_loan', 'overdraft', 'mortgage', 'inter_company'] },
        principalAmount: { type: 'number', exclusiveMinimum: 0 }, interestRate: { type: 'number', minimum: 0 }, startDate: { type: 'string' },
        tenureMonths: { type: 'integer', minimum: 0, maximum: 600 }, tdsPct: { type: 'number', minimum: 0, maximum: 100 },
      } } },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'manage_finance')) return reply.code(403).send({ error: 'Missing permission: manage_finance' });
        const { rows } = await db.query(
          `INSERT INTO loans (tenant_id, project_id, lender_name, loan_type, principal_amount, interest_rate, start_date, tenure_months, tds_pct)
           VALUES (app_current_tenant(), $1, $2, $3, $4, $5, COALESCE($6, CURRENT_DATE), $7, $8) RETURNING *`,
          [req.body.projectId || null, req.body.lenderName, req.body.loanType || 'term_loan', req.body.principalAmount, req.body.interestRate ?? 0, req.body.startDate || null, req.body.tenureMonths ?? 0, req.body.tdsPct ?? 0]);
        reply.code(201); return { loan: loanToApi(rows[0]) };
      }),
  );

  const repayToApi = (r: Record<string, unknown>) => ({
    id: r.id, loanId: r.loan_id, installmentNo: r.installment_no, dueDate: r.due_date,
    principalComponent: num(r.principal_component), interestComponent: num(r.interest_component), tdsDeducted: num(r.tds_deducted), status: r.status,
  });

  app.get<{ Params: { id: string } }>('/api/loans/:id/schedule', { preHandler: requireAuth, schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: UUID } } } } }, async (req, reply) =>
    withTenantContext(req.ctx, async (db) => {
      if (!await gate(db, 'view_finance')) return reply.code(403).send({ error: 'Missing permission: view_finance' });
      const { rows } = await db.query('SELECT * FROM loan_repayment_schedule WHERE loan_id = $1 ORDER BY installment_no', [req.params.id]);
      return { schedule: rows.map(repayToApi) };
    }),
  );

  app.post<{ Params: { id: string }; Body: { installments: { installmentNo: number; dueDate: string; principalComponent?: number; interestComponent?: number; tdsDeducted?: number }[] } }>(
    '/api/loans/:id/schedule',
    {
      preHandler: requireAuth,
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: UUID } } },
        body: { type: 'object', required: ['installments'], additionalProperties: false, properties: {
          installments: { type: 'array', minItems: 1, maxItems: 480, items: { type: 'object', required: ['installmentNo', 'dueDate'], additionalProperties: false, properties: {
            // Pinned to YYYY-MM-DD: an unconstrained string reached Postgres and
            // came back as a 500 DatabaseError instead of a 400 the caller can act on.
            installmentNo: { type: 'integer', minimum: 1 }, dueDate: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
            principalComponent: { type: 'number', minimum: 0 }, interestComponent: { type: 'number', minimum: 0 }, tdsDeducted: { type: 'number', minimum: 0 },
          } } },
        } },
      },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'manage_finance')) return reply.code(403).send({ error: 'Missing permission: manage_finance' });
        const { rows: ln } = await db.query('SELECT id FROM loans WHERE id = $1', [req.params.id]);
        if (!ln[0]) return reply.code(404).send({ error: 'Loan not found' });
        await db.query('DELETE FROM loan_repayment_schedule WHERE loan_id = $1', [req.params.id]);
        for (const i of req.body.installments) {
          await db.query(
            `INSERT INTO loan_repayment_schedule (tenant_id, loan_id, installment_no, due_date, principal_component, interest_component, tds_deducted)
             VALUES (app_current_tenant(), $1, $2, $3, $4, $5, $6)`,
            [req.params.id, i.installmentNo, i.dueDate, i.principalComponent ?? 0, i.interestComponent ?? 0, i.tdsDeducted ?? 0]);
        }
        const { rows } = await db.query('SELECT * FROM loan_repayment_schedule WHERE loan_id = $1 ORDER BY installment_no', [req.params.id]);
        reply.code(201); return { schedule: rows.map(repayToApi) };
      }),
  );

  app.patch<{ Params: { id: string }; Body: { status: string } }>(
    '/api/loan-repayments/:id',
    {
      preHandler: requireAuth,
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: UUID } } },
        body: { type: 'object', required: ['status'], additionalProperties: false, properties: { status: { type: 'string', enum: ['pending', 'paid', 'overdue'] } } },
      },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'manage_finance')) return reply.code(403).send({ error: 'Missing permission: manage_finance' });
        const { rows } = await db.query('UPDATE loan_repayment_schedule SET status = $1 WHERE id = $2 RETURNING *', [req.body.status, req.params.id]);
        if (!rows[0]) return reply.code(404).send({ error: 'Repayment installment not found' });
        return { installment: repayToApi(rows[0]) };
      }),
  );
}
