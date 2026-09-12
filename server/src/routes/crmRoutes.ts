import type { FastifyInstance } from 'fastify';
import { checkPan, normalisePan, maskPan, panHolderType } from '../pan.js';
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
  /**
   * PAN is masked by default.
   *
   * It identifies its holder to the tax department and is personal data under
   * the DPDP Act, so a list of customers should not print it in full to
   * everyone who can open the list. `canSeePan` is manage_finance — the desk
   * that files Form 26QB — rather than the lead permissions that govern the
   * rest of the record.
   *
   * The mask keeps the last four characters, which is what a person checks
   * against the document in front of them; the first six identify the holder.
   */
  const customerToApi = (r: Record<string, unknown>, canSeePan = false) => ({
    id: r.id, name: r.name, email: r.email, phone: r.phone,
    kycStatus: r.kyc_status, leadId: r.lead_id,
    pan: canSeePan ? (r.pan ?? '') : maskPan(String(r.pan ?? '')),
    panMasked: !canSeePan && !!r.pan,
    panHolderType: panHolderType(String(r.pan ?? '')),
  });

  app.get('/api/customers', { preHandler: requireAuth }, async (req, reply) =>
    withTenantContext(req.ctx, async (db) => {
      if (!await gate(db, 'view_leads')) return reply.code(403).send({ error: 'Missing permission: view_leads' });
      const canSeePan = await gate(db, 'manage_finance');
      const { rows } = await db.query('SELECT * FROM customers ORDER BY created_at DESC');
      return { customers: rows.map(r => customerToApi(r, canSeePan)) };
    }),
  );

  app.post<{ Body: { name: string; email?: string; phone?: string; leadId?: string; kycStatus?: string; pan?: string } }>(
    '/api/customers',
    {
      preHandler: requireAuth,
      schema: { body: { type: 'object', required: ['name'], additionalProperties: false, properties: {
        name: { type: 'string', minLength: 1, maxLength: 160 }, email: { type: 'string', maxLength: 160 },
        phone: { type: 'string', maxLength: 32 }, leadId: { type: 'string', pattern: UUID },
        kycStatus: { type: 'string', enum: ['pending', 'verified', 'rejected'] },
        pan: { type: 'string', maxLength: 10 },
      } } },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'manage_leads')) return reply.code(403).send({ error: 'Missing permission: manage_leads' });
        const pan = normalisePan(req.body.pan ?? '');
        const panOk = checkPan(pan);
        if (!panOk.ok) return reply.code(400).send({ error: panOk.reason });

        const { rows } = await db.query(
          `INSERT INTO customers (tenant_id, name, email, phone, lead_id, kyc_status, pan)
           VALUES (app_current_tenant(), $1, $2, $3, $4, $5, $6) RETURNING *`,
          [req.body.name, req.body.email || null, req.body.phone || '', req.body.leadId || null, req.body.kycStatus || 'pending', pan]);
        reply.code(201);
        return { customer: customerToApi(rows[0], await gate(db, 'manage_finance')) };
      }),
  );

  app.patch<{ Params: { id: string }; Body: { kycStatus?: string; pan?: string } }>(
    '/api/customers/:id',
    {
      preHandler: requireAuth,
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: UUID } } },
        body: {
          type: 'object', minProperties: 1, additionalProperties: false,
          properties: {
            kycStatus: { type: 'string', enum: ['pending', 'verified', 'rejected'] },
            pan: { type: 'string', maxLength: 10 },
          },
        },
      },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'manage_leads')) return reply.code(403).send({ error: 'Missing permission: manage_leads' });

        // Recording a PAN is a finance act, not a sales one — it exists to be
        // filed on Form 26QB. Editing the rest of the record stays with
        // manage_leads.
        if (req.body.pan !== undefined && !await gate(db, 'manage_finance')) {
          return reply.code(403).send({ error: 'Missing permission: manage_finance' });
        }

        const sets: string[] = [];
        const vals: unknown[] = [];
        if (req.body.kycStatus !== undefined) { vals.push(req.body.kycStatus); sets.push(`kyc_status = $${vals.length}`); }
        if (req.body.pan !== undefined) {
          const pan = normalisePan(req.body.pan);
          // Checked against the workspace's own GSTIN only for the SELLER; a
          // buyer's PAN has no relationship to the builder's registration.
          const panOk = checkPan(pan);
          if (!panOk.ok) return reply.code(400).send({ error: panOk.reason });
          vals.push(pan); sets.push(`pan = $${vals.length}`);
        }
        vals.push(req.params.id);

        const { rows } = await db.query(
          `UPDATE customers SET ${sets.join(', ')} WHERE id = $${vals.length} RETURNING *`, vals);
        if (!rows[0]) return reply.code(404).send({ error: 'Customer not found' });
        return { customer: customerToApi(rows[0], await gate(db, 'manage_finance')) };
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

      /**
       * The timeline is scoped to the leads the caller may READ.
       *
       * The same own-only rule as GET /api/leads, and for the same reason: the
       * lead list already hid other reps' leads from a telecaller, while this
       * route handed over the activity ON those leads — call notes, stage
       * changes, "Intro call with Sanjay". A telecaller with zero visible leads
       * was reading nine activities belonging to all of them.
       *
       * Derived from HOLDING manage_own_leads, never from lacking the broader
       * keys — the inference that once left auditors unable to audit.
       */
      const { rows: [{ own_only }] } = await db.query(
        `SELECT has_permission('manage_own_leads')
            AND NOT has_permission('manage_leads')
            AND NOT has_permission('assign_leads') AS own_only`);
      const mine = own_only ? (req.ctx.userId ?? null) : null;
      // Scoped by the LEAD's assignee, not the activity's author: a colleague's
      // note on my lead is mine to read, and my note on a lead that was
      // reassigned away from me is not.
      const OWN_LEAD = `($4::uuid IS NULL OR EXISTS (
                          SELECT 1 FROM leads l WHERE l.id = lead_activities.lead_id
                             AND l.assigned_to = $4::uuid))`;

      const { rows } = req.query.leadId
        ? await db.query(
            `SELECT * FROM lead_activities
              WHERE lead_id = $1
                AND ($2::text IS NULL OR type = $2)
                AND (type <> 'whatsapp' OR $3::uuid IS NULL OR user_id = $3)
                AND ${OWN_LEAD}
              ORDER BY created_at DESC`,
            [req.query.leadId, req.query.type ?? null, waOwner, mine])
        : await db.query(
            `SELECT * FROM lead_activities
              WHERE (type <> 'whatsapp' OR $1::uuid IS NULL OR user_id = $1)
                AND ($2::uuid IS NULL OR EXISTS (
                      SELECT 1 FROM leads l WHERE l.id = lead_activities.lead_id
                         AND l.assigned_to = $2::uuid))
              ORDER BY created_at DESC LIMIT 500`,
            [waOwner, mine]);
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

        /**
         * WHICH lead, not just whether one exists.
         *
         * The READ above scopes activities by the lead's assignee — a rep
         * holding only manage_own_leads sees notes on their own leads and no
         * others. This write checked that the lead EXISTED and stopped there,
         * so the same rep could post a note onto any lead in the workspace by
         * id: into a colleague's call history, attributed to themselves, and
         * then be unable to read it back because the read is scoped. A note
         * you can plant but not see is the shape this defect took.
         *
         * `own_only` is derived exactly as it is for the read — from HOLDING
         * manage_own_leads, never from lacking the broader keys, so an auditor
         * is not caught by it.
         *
         * A foreign lead answers 404, the same as one that does not exist:
         * a 403 here would confirm the id is real to somebody who may not
         * know that.
         */
        const { rows: [{ own_only }] } = await db.query(
          `SELECT has_permission('manage_own_leads')
              AND NOT has_permission('manage_leads')
              AND NOT has_permission('assign_leads') AS own_only`);
        const { rows: lead } = await db.query(
          `SELECT id FROM leads
            WHERE id = $1 AND ($2::uuid IS NULL OR assigned_to = $2::uuid)`,
          [req.body.leadId, own_only ? (req.ctx.userId ?? null) : null]);
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
  /**
   * POST /api/lead-activities/reassign — move a lead's timeline to another lead.
   *
   * Merging duplicates is the only caller. Without this the SPA reparented rows
   * in localStorage and then deleted the duplicate server-side, so the merged
   * lead's history was destroyed by the FK cascade while the UI claimed it had
   * been moved. Same tenant only, enforced by RLS on both ids.
   */
  app.post<{ Body: { fromLeadId: string; toLeadId: string } }>(
    '/api/lead-activities/reassign',
    {
      preHandler: requireAuth,
      schema: { body: { type: 'object', required: ['fromLeadId', 'toLeadId'], additionalProperties: false, properties: {
        fromLeadId: { type: 'string', pattern: UUID }, toLeadId: { type: 'string', pattern: UUID },
      } } },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        if (!await gate(db, 'manage_leads')) return reply.code(403).send({ error: 'Missing permission: manage_leads' });
        if (req.body.fromLeadId === req.body.toLeadId) {
          return reply.code(400).send({ error: 'A lead cannot be merged into itself' });
        }
        // Both must be visible in this tenant; RLS makes a cross-tenant id a miss.
        const { rows: seen } = await db.query(
          'SELECT id FROM leads WHERE id = ANY($1::uuid[])', [[req.body.fromLeadId, req.body.toLeadId]]);
        if (seen.length !== 2) return reply.code(404).send({ error: 'Lead not found' });
        const { rowCount } = await db.query(
          'UPDATE lead_activities SET lead_id = $1 WHERE lead_id = $2', [req.body.toLeadId, req.body.fromLeadId]);
        return { moved: rowCount ?? 0 };
      }),
  );

}
