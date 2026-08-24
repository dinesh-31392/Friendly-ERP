import type { FastifyInstance } from 'fastify';
import { withTenantContext } from '../db.js';
import { requireAuth } from '../auth.js';

/**
 * RERA registration and the designated-account position (migration 042).
 *
 * The product's job here is to make the seventy per cent obligation VISIBLE
 * and countable. It does not sweep cash and does not post journals — see the
 * migration for why. What it gives a promoter is the number their auditor will
 * ask for, computed from the receipts they already record.
 *
 * Gated on view_finance / manage_finance. The escrow position is a financial
 * control, not a project attribute, and the people who reconcile it are the
 * people who reconcile the bank.
 */

const UUID = '^[0-9a-fA-F-]{36}$';

async function gate(db: import('pg').PoolClient, perm: string): Promise<boolean> {
  const { rows: [{ allowed }] } = await db.query(`SELECT has_permission($1) AS allowed`, [perm]);
  return !!allowed;
}

export async function reraRoutes(app: FastifyInstance): Promise<void> {
  /** GET /api/rera/registrations — registered projects and their terms. */
  app.get('/api/rera/registrations', { preHandler: requireAuth }, async (req, reply) =>
    withTenantContext(req.ctx, async (db) => {
      if (!await gate(db, 'view_finance')) {
        return reply.code(403).send({ error: 'Missing permission: view_finance' });
      }
      const { rows } = await db.query(`
        SELECT r.*, p.name AS project_name, p.rera_number, ba.account_name, ba.bank_name
          FROM rera_registrations r
          JOIN projects p          ON p.id = r.project_id
          LEFT JOIN bank_accounts ba ON ba.id = r.designated_bank_account_id
         ORDER BY p.name`);
      return {
        registrations: rows.map(r => ({
          id: r.id,
          projectId: r.project_id,
          projectName: r.project_name,
          // Read from projects, where it already lives — not copied into this table.
          registrationNo: r.rera_number ?? undefined,
          registeredOn: r.registered_on ?? null,
          validUntil: r.valid_until ?? null,
          escrowPct: Number(r.escrow_pct),
          designatedBankAccountId: r.designated_bank_account_id ?? undefined,
          designatedAccountName: r.account_name ?? undefined,
          designatedBankName: r.bank_name ?? undefined,
          status: r.status,
        })),
      };
    }),
  );

  /** POST /api/rera/registrations — register a project, or amend its terms. */
  app.post<{ Body: {
    projectId: string; registeredOn?: string; validUntil?: string;
    escrowPct?: number; designatedBankAccountId?: string;
  } }>(
    '/api/rera/registrations',
    {
      preHandler: requireAuth,
      schema: {
        body: {
          type: 'object', required: ['projectId'], additionalProperties: false,
          properties: {
            projectId: { type: 'string', pattern: UUID },
            registeredOn: { type: 'string', maxLength: 40 },
            validUntil: { type: 'string', maxLength: 40 },
            // The floor is the statute's. A stricter authority or a cautious
            // promoter may ring-fence more; nobody may ring-fence less.
            escrowPct: { type: 'number', minimum: 70, maximum: 100 },
            designatedBankAccountId: { type: 'string', pattern: UUID },
          },
        },
      },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'manage_finance')) {
          return reply.code(403).send({ error: 'Missing permission: manage_finance' });
        }
        const b = req.body;
        const { rows } = await db.query(`
          INSERT INTO rera_registrations
            (tenant_id, project_id, registered_on, valid_until, escrow_pct, designated_bank_account_id)
          VALUES (app_current_tenant(), $1, $2::date, $3::date, COALESCE($4::numeric, 70), $5)
          ON CONFLICT (project_id) DO UPDATE SET
            registered_on = COALESCE(EXCLUDED.registered_on, rera_registrations.registered_on),
            valid_until   = COALESCE(EXCLUDED.valid_until,   rera_registrations.valid_until),
            escrow_pct    = EXCLUDED.escrow_pct,
            designated_bank_account_id =
              COALESCE(EXCLUDED.designated_bank_account_id, rera_registrations.designated_bank_account_id)
          RETURNING *`,
          [b.projectId, b.registeredOn ?? null, b.validUntil ?? null,
           b.escrowPct ?? null, b.designatedBankAccountId ?? null]);
        reply.code(201);
        return { registration: { id: rows[0].id, projectId: rows[0].project_id, escrowPct: Number(rows[0].escrow_pct) } };
      }),
  );

  /**
   * POST /api/rera/allocate — record the escrow obligation for receipts.
   *
   * Idempotent by construction: one allocation per payment, enforced by a
   * unique index, and `ON CONFLICT DO NOTHING` rather than an error. Running
   * it twice must not double the obligation, and a collections clerk pressing
   * the button again is not an exceptional case worth a 409.
   *
   * Only receipts against RERA-registered projects are allocated. Everything
   * else is free cash and has no designated account to owe.
   */
  app.post<{ Body: { projectId?: string } }>(
    '/api/rera/allocate',
    {
      preHandler: requireAuth,
      schema: {
        body: {
          type: 'object', additionalProperties: false,
          properties: { projectId: { type: 'string', pattern: UUID } },
        },
      },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'manage_finance')) {
          return reply.code(403).send({ error: 'Missing permission: manage_finance' });
        }
        const { rows } = await db.query(`
          INSERT INTO escrow_allocations
            (tenant_id, payment_id, project_id, receipt_amount, escrow_amount, free_amount, escrow_pct)
          SELECT app_current_tenant(), pay.id, u.project_id, pay.amount,
                 s.escrow, s.free, r.escrow_pct
            FROM payments pay
            JOIN payment_schedules ps ON ps.id = pay.payment_schedule_id
            JOIN bookings bk          ON bk.id = ps.booking_id
            JOIN units u              ON u.id = bk.unit_id
            JOIN rera_registrations r ON r.project_id = u.project_id AND r.status = 'active'
            CROSS JOIN LATERAL escrow_split(pay.amount, r.escrow_pct) s
           WHERE ($1::uuid IS NULL OR u.project_id = $1::uuid)
          ON CONFLICT (payment_id) DO NOTHING
          RETURNING id`,
          [req.body.projectId ?? null]);
        reply.code(200);
        return { allocated: rows.length };
      }),
  );

  /**
   * GET /api/rera/position — the number the auditor asks for.
   *
   * required  seventy per cent of everything realised from allottees
   * inAccount what the designated account actually holds, from its opening
   *           balance and its own transactions
   * shortfall required − inAccount, floored at zero
   *
   * `inAccount` is the honest half and the fragile one: it is only as good as
   * the bank transactions that have been entered. A project whose designated
   * account has never been reconciled will show a shortfall equal to its whole
   * obligation, which is the correct thing to show — the money may well be
   * there, but nothing in the system says so.
   */
  app.get('/api/rera/position', { preHandler: requireAuth }, async (req, reply) =>
    withTenantContext(req.ctx, async (db) => {
      if (!await gate(db, 'view_finance')) {
        return reply.code(403).send({ error: 'Missing permission: view_finance' });
      }
      const { rows } = await db.query(`
        SELECT p.id                AS project_id,
               p.name              AS project_name,
               p.rera_number,
               r.escrow_pct,
               r.designated_bank_account_id,
               COALESCE(a.collected, 0) AS collected,
               COALESCE(a.required, 0)  AS required,
               COALESCE(b.in_account, 0) AS in_account
          FROM rera_registrations r
          JOIN projects p ON p.id = r.project_id
          LEFT JOIN LATERAL (
            SELECT sum(receipt_amount) AS collected, sum(escrow_amount) AS required
              FROM escrow_allocations ea WHERE ea.project_id = r.project_id
          ) a ON true
          LEFT JOIN LATERAL (
            SELECT ba.opening_balance
                 + COALESCE(sum(CASE WHEN bt.txn_type = 'credit' THEN bt.amount
                                     ELSE -bt.amount END), 0) AS in_account
              FROM bank_accounts ba
              LEFT JOIN bank_transactions bt ON bt.bank_account_id = ba.id
             WHERE ba.id = r.designated_bank_account_id
             GROUP BY ba.opening_balance
          ) b ON true
         ORDER BY p.name`);
      return {
        position: rows.map(r => {
          const required = Number(r.required);
          const inAccount = Number(r.in_account);
          return {
            projectId: r.project_id,
            projectName: r.project_name,
            registrationNo: r.rera_number ?? undefined,
            escrowPct: Number(r.escrow_pct),
            collected: Number(r.collected),
            required,
            inAccount,
            shortfall: Math.max(0, Number((required - inAccount).toFixed(2))),
            hasDesignatedAccount: !!r.designated_bank_account_id,
          };
        }),
      };
    }),
  );
}
