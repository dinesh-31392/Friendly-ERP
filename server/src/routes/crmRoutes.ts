import type { FastifyInstance } from 'fastify';
import { withTenantContext } from '../db.js';
import { requireAuth } from '../auth.js';

/**
 * CRM-adjacent persistence: customers (booked buyers + KYC), the lead-activity
 * timeline, and the broker commission ledger. Tables exist since 003 but had no
 * API — these lived only in the browser. RLS + RBAC throughout.
 */

const UUID = '^[0-9a-fA-F-]{36}$';
const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));
const ACT_TYPES = ['call', 'site_visit', 'note', 'quotation_sent', 'follow_up_scheduled', 'stage_change', 'whatsapp', 'email'];
const OUTCOMES = ['interested', 'not_interested', 'needs_follow_up', 'no_show'];

async function gate(db: import('pg').PoolClient, perm: string): Promise<boolean> {
  const { rows: [{ allowed }] } = await db.query(`SELECT has_permission($1) AS allowed`, [perm]);
  return !!allowed;
}

export async function crmRoutes(app: FastifyInstance): Promise<void> {
  // ── Customers (booked buyers + KYC) ─────────────────────────────────────
  const customerToApi = (r: Record<string, unknown>) => ({ id: r.id, name: r.name, email: r.email, phone: r.phone, kycStatus: r.kyc_status, leadId: r.lead_id });

  app.get('/api/customers', { preHandler: requireAuth }, async (req, reply) =>
    withTenantContext(req.ctx, async (db) => {
      if (!await gate(db, 'view_leads')) return reply.code(403).send({ error: 'Missing permission: view_leads' });
      const { rows } = await db.query('SELECT * FROM customers ORDER BY created_at DESC');
      return { customers: rows.map(customerToApi) };
    }),
  );

  app.post<{ Body: { name: string; email?: string; phone?: string; leadId?: string; kycStatus?: string } }>(
    '/api/customers',
    {
      preHandler: requireAuth,
      schema: { body: { type: 'object', required: ['name'], additionalProperties: false, properties: {
        name: { type: 'string', minLength: 1, maxLength: 160 }, email: { type: 'string', maxLength: 160 },
        phone: { type: 'string', maxLength: 32 }, leadId: { type: 'string', pattern: UUID }, kycStatus: { type: 'string', enum: ['pending', 'verified'] },
      } } },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'manage_leads')) return reply.code(403).send({ error: 'Missing permission: manage_leads' });
        const { rows } = await db.query(
          `INSERT INTO customers (tenant_id, name, email, phone, lead_id, kyc_status)
           VALUES (app_current_tenant(), $1, $2, $3, $4, $5) RETURNING *`,
          [req.body.name, req.body.email || null, req.body.phone || '', req.body.leadId || null, req.body.kycStatus || 'pending']);
        reply.code(201); return { customer: customerToApi(rows[0]) };
      }),
  );

  app.patch<{ Params: { id: string }; Body: { kycStatus: string } }>(
    '/api/customers/:id',
    {
      preHandler: requireAuth,
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: UUID } } },
        body: { type: 'object', required: ['kycStatus'], additionalProperties: false, properties: { kycStatus: { type: 'string', enum: ['pending', 'verified'] } } },
      },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'manage_leads')) return reply.code(403).send({ error: 'Missing permission: manage_leads' });
        const { rows } = await db.query('UPDATE customers SET kyc_status = $1 WHERE id = $2 RETURNING *', [req.body.kycStatus, req.params.id]);
        if (!rows[0]) return reply.code(404).send({ error: 'Customer not found' });
        return { customer: customerToApi(rows[0]) };
      }),
  );

  // ── Lead activity timeline ──────────────────────────────────────────────
  const actToApi = (r: Record<string, unknown>) => ({ id: r.id, leadId: r.lead_id, userId: r.user_id, type: r.type, notes: r.notes, scheduledAt: r.scheduled_at, outcome: r.outcome, createdAt: r.created_at });

  app.get<{ Querystring: { leadId?: string; type?: string } }>('/api/lead-activities', { preHandler: requireAuth }, async (req, reply) =>
    withTenantContext(req.ctx, async (db) => {
      if (!await gate(db, 'view_leads')) return reply.code(403).send({ error: 'Missing permission: view_leads' });
      // ?type= keeps the WhatsApp chat thread's 5s poll cheap — it only ever
      // wants the whatsapp slice, not the whole timeline.
      //
      // WhatsApp rows carry chat privacy (026): each rep links their OWN phone,
      // so while the workspace is 'private' a caller only ever sees the rows
      // their own session carried. This is the SAME boundary the inbox
      // enforces — the timeline must not become a way around it. Non-WhatsApp
      // activities (notes, calls, visits) stay shared workspace data.
      const { rows: [priv] } = await db.query(
        `SELECT COALESCE(
                  (SELECT chat_visibility FROM whatsapp_instances WHERE tenant_id = app_current_tenant()),
                  'private') AS visibility`);
      const waOwner = priv.visibility === 'team' ? null : (req.ctx.userId ?? null);

      const { rows } = req.query.leadId
        ? await db.query(
            `SELECT * FROM lead_activities
              WHERE lead_id = $1
                AND ($2::text IS NULL OR type = $2)
                AND (type <> 'whatsapp' OR $3::uuid IS NULL OR user_id = $3)
              ORDER BY created_at DESC`,
            [req.query.leadId, req.query.type ?? null, waOwner])
        : await db.query(
            `SELECT * FROM lead_activities
              WHERE (type <> 'whatsapp' OR $1::uuid IS NULL OR user_id = $1)
              ORDER BY created_at DESC LIMIT 500`,
            [waOwner]);
      return { activities: rows.map(actToApi) };
    }),
  );

  app.post<{ Body: { leadId: string; type: string; notes?: string; scheduledAt?: string; outcome?: string } }>(
    '/api/lead-activities',
    {
      preHandler: requireAuth,
      schema: { body: { type: 'object', required: ['leadId', 'type'], additionalProperties: false, properties: {
        leadId: { type: 'string', pattern: UUID }, type: { type: 'string', enum: ACT_TYPES },
        notes: { type: 'string', maxLength: 2000 }, scheduledAt: { type: 'string' }, outcome: { type: 'string', enum: OUTCOMES },
      } } },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        // Logging an activity is a own-lead action, so either permission suffices.
        if (!await gate(db, 'manage_leads') && !await gate(db, 'manage_own_leads')) return reply.code(403).send({ error: 'Missing permission: manage_own_leads' });
        const { rows: lead } = await db.query('SELECT id FROM leads WHERE id = $1', [req.body.leadId]);
        if (!lead[0]) return reply.code(404).send({ error: 'Lead not found' });
        const { rows } = await db.query(
          `INSERT INTO lead_activities (tenant_id, lead_id, user_id, type, notes, scheduled_at, outcome)
           VALUES (app_current_tenant(), $1, $2, $3, $4, $5, $6) RETURNING *`,
          [req.body.leadId, req.ctx.userId || null, req.body.type, req.body.notes || '', req.body.scheduledAt || null, req.body.outcome || null]);
        reply.code(201); return { activity: actToApi(rows[0]) };
      }),
  );

  // ── Broker commission ledger ────────────────────────────────────────────
  const commToApi = (r: Record<string, unknown>) => ({ id: r.id, brokerId: r.broker_id, bookingId: r.booking_id, amountEarned: num(r.amount_earned), amountPaid: num(r.amount_paid), status: r.status });

  app.get('/api/commissions', { preHandler: requireAuth }, async (req, reply) =>
    withTenantContext(req.ctx, async (db) => {
      if (!await gate(db, 'view_brokers')) return reply.code(403).send({ error: 'Missing permission: view_brokers' });
      const { rows } = await db.query('SELECT * FROM commission_ledger ORDER BY created_at DESC');
      return { commissions: rows.map(commToApi) };
    }),
  );

  app.post<{ Body: { brokerId: string; bookingId: string; amountEarned: number } }>(
    '/api/commissions',
    {
      preHandler: requireAuth,
      schema: { body: { type: 'object', required: ['brokerId', 'bookingId', 'amountEarned'], additionalProperties: false, properties: {
        brokerId: { type: 'string', pattern: UUID }, bookingId: { type: 'string', pattern: UUID }, amountEarned: { type: 'number', minimum: 0 },
      } } },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'manage_brokers')) return reply.code(403).send({ error: 'Missing permission: manage_brokers' });
        const { rows } = await db.query(
          `INSERT INTO commission_ledger (tenant_id, broker_id, booking_id, amount_earned) VALUES (app_current_tenant(), $1, $2, $3) RETURNING *`,
          [req.body.brokerId, req.body.bookingId, req.body.amountEarned]);
        reply.code(201); return { commission: commToApi(rows[0]) };
      }),
  );

  /** PATCH /api/commissions/:id — record a payout; status derives from paid vs earned. */
  app.patch<{ Params: { id: string }; Body: { amountPaid: number } }>(
    '/api/commissions/:id',
    {
      preHandler: requireAuth,
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: UUID } } },
        body: { type: 'object', required: ['amountPaid'], additionalProperties: false, properties: { amountPaid: { type: 'number', exclusiveMinimum: 0 } } },
      },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'manage_brokers')) return reply.code(403).send({ error: 'Missing permission: manage_brokers' });
        const { rows: cur } = await db.query('SELECT * FROM commission_ledger WHERE id = $1', [req.params.id]);
        if (!cur[0]) return reply.code(404).send({ error: 'Commission not found' });
        const paid = num(cur[0].amount_paid) + req.body.amountPaid;
        const earned = num(cur[0].amount_earned);
        const status = paid >= earned ? 'paid' : 'partially_paid';
        const { rows } = await db.query('UPDATE commission_ledger SET amount_paid = $1, status = $2 WHERE id = $3 RETURNING *', [Math.min(paid, earned), status, req.params.id]);
        return { commission: commToApi(rows[0]) };
      }),
  );
}
