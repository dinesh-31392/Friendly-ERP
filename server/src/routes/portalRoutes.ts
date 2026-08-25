import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { randomBytes, randomUUID } from 'node:crypto';
import { withTenantContext, platformPool, type RequestCtx } from '../db.js';
import { requireAuth, hashPassword, verifyPassword, signToken, verifyToken } from '../auth.js';
import { enqueueAutoReply } from '../autoReply.js';
import { env } from '../env.js';

/**
 * Customer / channel-partner portal — a SEPARATE auth realm from staff.
 *
 *  • Staff invite a buyer (lead) or partner (broker); the server generates a
 *    temp password, stores only its argon2 hash, and returns it exactly once.
 *  • POST /api/portal/login issues a JWT whose `rol` is 'portal_customer' /
 *    'portal_partner'. Portal routes accept ONLY those; staff routes reject
 *    them fail-closed (a portal id is not in `users`, so every has_permission
 *    gate returns false).
 *  • Every portal read is scoped twice: RLS pins the tenant, and each query
 *    pins the caller's own lead_id / broker_id — a buyer can only ever see
 *    their own booking, schedule and receipts.
 */

const UUID = '^[0-9a-fA-F-]{36}$';
const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));

// Constant-shape login: always spend one argon2 verify, even for unknown emails.
const DUMMY_HASH_PROMISE = hashPassword(randomUUID());

/** Readable 8-char temp password (no confusable characters). */
function tempPassword(): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const bytes = randomBytes(8);
  let out = '';
  for (let i = 0; i < 8; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

interface PortalCtx {
  portalUserId: string; tenantId: string; role: string; ip: string;
  /** Token identity, so a single portal session can be signed out. */
  jti?: string;
  /** JWT iat, compared against portal_users.sessions_valid_from. */
  issuedAt?: number;
}

/**
 * PortalCtx → RequestCtx.
 *
 * One function rather than the object literal that used to be repeated at each
 * call site, because `realm` is what makes the session revocable and a call
 * site that forgets it is not an error anyone would notice — the request simply
 * keeps working after the customer signs out.
 */
function portalCtx(ctx: PortalCtx): RequestCtx {
  return {
    tenantId: ctx.tenantId,
    userId: ctx.portalUserId,
    ip: ctx.ip,
    jti: ctx.jti,
    issuedAt: ctx.issuedAt,
    realm: 'portal',
  };
}

function requirePortalAuth(req: FastifyRequest, reply: FastifyReply): PortalCtx | null {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  try {
    const claims = verifyToken(token);
    if (!claims.rol?.startsWith('portal_')) {
      reply.code(403).send({ error: 'Portal accounts only' });
      return null;
    }
    return { portalUserId: claims.sub, tenantId: claims.tid, role: claims.rol, ip: req.ip,
             jti: claims.jti, issuedAt: claims.iat };
  } catch {
    reply.code(401).send({ error: 'Invalid or missing portal token' });
    return null;
  }
}

export async function portalRoutes(app: FastifyInstance): Promise<void> {
  /**
   * POST /api/portal/invites — STAFF route. Invite the buyer of a lead or a
   * channel partner. Upserts the portal account and returns the temp password
   * exactly once (only its hash is stored).
   */
  app.post<{ Body: { leadId?: string; brokerId?: string; email?: string } }>(
    '/api/portal/invites',
    {
      preHandler: requireAuth,
      schema: { body: { type: 'object', additionalProperties: false, properties: {
        leadId: { type: 'string', pattern: UUID }, brokerId: { type: 'string', pattern: UUID }, email: { type: 'string', maxLength: 160 },
      } } },
    },
    async (req, reply) =>
      withTenantContext(req.ctx, async (db) => {
        if (!!req.body.leadId === !!req.body.brokerId) return reply.code(400).send({ error: 'Provide exactly one of leadId or brokerId' });
        const perm = req.body.leadId ? 'manage_leads' : 'manage_brokers';
        const { rows: [{ allowed }] } = await db.query(`SELECT has_permission($1) AS allowed`, [perm]);
        if (!allowed) return reply.code(403).send({ error: `Missing permission: ${perm}` });

        let role: string, linkCol: string, linkId: string, name: string, email: string;
        if (req.body.leadId) {
          const { rows } = await db.query('SELECT id, name, email FROM leads WHERE id = $1', [req.body.leadId]);
          if (!rows[0]) return reply.code(404).send({ error: 'Lead not found' });
          role = 'customer'; linkCol = 'lead_id'; linkId = rows[0].id; name = rows[0].name;
          email = req.body.email || rows[0].email;
        } else {
          const { rows } = await db.query('SELECT id, name, email FROM brokers WHERE id = $1', [req.body.brokerId]);
          if (!rows[0]) return reply.code(404).send({ error: 'Broker not found' });
          role = 'partner'; linkCol = 'broker_id'; linkId = rows[0].id; name = rows[0].name;
          email = req.body.email || rows[0].email;
        }
        if (!email) return reply.code(400).send({ error: 'No email on record — pass one explicitly' });

        const password = tempPassword();
        const hash = await hashPassword(password);
        const { rows } = await db.query(
          `INSERT INTO portal_users (tenant_id, role, email, password_hash, name, ${linkCol})
           VALUES (app_current_tenant(), $1, $2, $3, $4, $5)
           ON CONFLICT (tenant_id, ${linkCol}) WHERE ${linkCol} IS NOT NULL
           DO UPDATE SET email = EXCLUDED.email, password_hash = EXCLUDED.password_hash, active = true
           RETURNING (xmax = 0) AS is_new`,
          [role, email, hash, name, linkId]);
        reply.code(201); return { email, tempPassword: password, isNew: rows[0].is_new };
      }),
  );

  /** POST /api/portal/login — public, tightly rate-limited. */
  app.post<{ Body: { email: string; password: string; tenantSlug?: string } }>(
    '/api/portal/login',
    {
      // Same cap and same reasoning as the staff login — see env.authRateLimitMax.
      // Production leaves it at 5; only the suites raise it, because portal
      // sign-in is the other place an attacker gets to guess a password.
      config: { rateLimit: { max: env.authRateLimitMax, timeWindow: '1 minute' } },
      schema: { body: { type: 'object', required: ['email', 'password'], additionalProperties: false, properties: {
        email: { type: 'string', maxLength: 160 }, password: { type: 'string', maxLength: 200 }, tenantSlug: { type: 'string', maxLength: 80 },
      } } },
    },
    async (req, reply) => {
      const { rows } = await platformPool.query(
        `SELECT pu.*, t.name AS tenant_name, t.slug, t.status AS tenant_status,
                t.currency, t.primary_color, t.logo_url
           FROM portal_users pu JOIN tenants t ON t.id = pu.tenant_id
          WHERE pu.email = $1 AND ($2::text IS NULL OR t.slug = $2)
          LIMIT 2`,
        [req.body.email.toLowerCase(), req.body.tenantSlug ?? null]);
      const u = rows[0];
      const passwordOk = await verifyPassword(u?.password_hash ?? await DUMMY_HASH_PROMISE, req.body.password);
      // Constant-shape failure for every miss (unknown / ambiguous / bad password
      // / deactivated / suspended workspace) — no account enumeration.
      if (!u || rows.length > 1 || !passwordOk || !u.active || u.tenant_status === 'suspended') {
        return reply.code(401).send({ error: 'Invalid email or password' });
      }
      await platformPool.query('UPDATE portal_users SET last_login_at = now() WHERE id = $1', [u.id]);
      const token = signToken({ sub: u.id, tid: u.tenant_id, rol: `portal_${u.role}` });
      // The client has no local portal_users/tenants table in API mode, so the
      // login response carries everything the portal shell renders: the linked
      // lead/broker id (which half of the dashboard to show) and tenant branding.
      return {
        token,
        portalUser: { id: u.id, name: u.name, email: u.email, role: u.role, leadId: u.lead_id, brokerId: u.broker_id },
        tenant: { id: u.tenant_id, name: u.tenant_name, slug: u.slug, currency: u.currency, primaryColor: u.primary_color, logo: u.logo_url },
      };
    },
  );

  /**
   * POST /api/portal/logout — end this portal session.
   *
   * The staff twin of this is /api/auth/logout; see migration 037 for why
   * dropping the token client-side is not a sign-out. It matters at least as
   * much here: a customer checking their payment schedule is often doing it on
   * a borrowed or shared phone.
   */
  app.post('/api/portal/logout', async (req, reply) => {
    const ctx = requirePortalAuth(req, reply);
    if (!ctx) return;
    return withTenantContext(portalCtx(ctx), async (db) => {
      if (!ctx.jti) {
        reply.code(409);
        return { error: 'This session predates revocation support — sign out everywhere instead.' };
      }
      await db.query(
        `INSERT INTO revoked_portal_tokens (jti, tenant_id, portal_user_id, expires_at, reason)
         VALUES ($1, app_current_tenant(), $2, to_timestamp($3), 'logout')
         ON CONFLICT (jti) DO NOTHING`,
        [ctx.jti, ctx.portalUserId, (ctx.issuedAt ?? 0) + 24 * 60 * 60]);
      // Opportunistic pruning, as on the staff side: once a token's own expiry
      // has passed the row is dead weight, and doing it here means there is no
      // scheduled job to forget to deploy.
      await db.query(`DELETE FROM revoked_portal_tokens WHERE expires_at < now()`);
      reply.code(200);
      return { ok: true, scope: 'this-session' };
    });
  });

  /** POST /api/portal/logout-all — end every session for this portal account. */
  app.post('/api/portal/logout-all', async (req, reply) => {
    const ctx = requirePortalAuth(req, reply);
    if (!ctx) return;
    return withTenantContext(portalCtx(ctx), async (db) => {
      // Start of the next second — a JWT iat counts whole seconds, so a
      // watermark of "now" would leave a token issued during this same second
      // alive. See /api/auth/logout-all for the full reasoning.
      await db.query(
        `UPDATE portal_users
            SET sessions_valid_from = date_trunc('second', now()) + interval '1 second'
          WHERE id = $1`, [ctx.portalUserId]);
      reply.code(200);
      return { ok: true, scope: 'all-sessions' };
    });
  });

  /** GET /api/portal/overview — the caller's own data, and nothing else. */
  app.get('/api/portal/overview', async (req, reply) => {
    const ctx = requirePortalAuth(req, reply);
    if (!ctx) return;
    return withTenantContext(portalCtx(ctx), async (db) => {
      // Revocation guard: the account must still exist and be active.
      const { rows: pu } = await db.query('SELECT * FROM portal_users WHERE id = $1 AND active', [ctx.portalUserId]);
      if (!pu[0]) return reply.code(401).send({ error: 'Portal account is no longer active' });
      const me = pu[0];

      if (me.role === 'customer') {
        const { rows: lead } = await db.query('SELECT id, name, project, stage FROM leads WHERE id = $1', [me.lead_id]);
        const { rows: bookings } = await db.query('SELECT * FROM bookings WHERE lead_id = $1', [me.lead_id]);
        const bookingIds = bookings.map(b => b.id);
        const { rows: schedules } = bookingIds.length
          ? await db.query('SELECT * FROM payment_schedules WHERE booking_id = ANY($1::uuid[]) ORDER BY booking_id, sequence', [bookingIds])
          : { rows: [] as Record<string, unknown>[] };
        const scheduleIds = schedules.map(s => s.id);
        const { rows: receipts } = scheduleIds.length
          ? await db.query('SELECT * FROM payments WHERE payment_schedule_id = ANY($1::uuid[]) ORDER BY payment_date', [scheduleIds])
          : { rows: [] as Record<string, unknown>[] };

        // Unit + tower detail for the buyer's OWN bookings only. Pulling the
        // whole inventory would let a buyer enumerate the builder's stock.
        const unitIds = bookings.map(b => b.unit_id).filter(Boolean);
        const { rows: units } = unitIds.length
          ? await db.query('SELECT * FROM units WHERE id = ANY($1::uuid[])', [unitIds])
          : { rows: [] as Record<string, unknown>[] };
        const towerIds = [...new Set(units.map(u => u.tower_id).filter(Boolean))];
        const { rows: towers } = towerIds.length
          ? await db.query('SELECT id, name, project_id FROM towers WHERE id = ANY($1::uuid[])', [towerIds])
          : { rows: [] as Record<string, unknown>[] };

        // Tickets: identity-safe via lead_id only. The demo store also matched
        // on customer NAME for legacy rows; that is deliberately not replicated
        // here — two buyers can share a name, and this is the security boundary.
        const { rows: tickets } = await db.query(
          'SELECT * FROM service_tickets WHERE lead_id = $1 ORDER BY created_at DESC', [me.lead_id]);

        // Documents: the buyer's own personal papers plus project-level ones.
        // Personal docs follow "<Type> - <Full Name>"; the match is on an EXACT
        // ' - ' segment, never a substring, so "Ana" cannot see "Ana Maria"'s
        // agreement. Enforced here, server-side, not just in the UI.
        const PERSONAL_DOC_TYPES = ['Agreement', 'Quotation', 'Payment Plan'];
        const ownName = String(lead[0]?.name ?? '').trim().toLowerCase();
        const ownProject = lead[0]?.project ?? null;
        const { rows: allDocs } = ownProject
          ? await db.query('SELECT * FROM documents WHERE project = $1 OR name ILIKE $2', [ownProject, `%${ownName}%`])
          : { rows: [] as Record<string, unknown>[] };
        const documents = allDocs.filter(d => {
          const name = String(d.name ?? '');
          const isMine = !!ownName && name.toLowerCase().split(' - ').some(seg => seg.trim() === ownName);
          const isProjectLevel = d.project === ownProject && !PERSONAL_DOC_TYPES.includes(String(d.type));
          return isMine || isProjectLevel;
        });

        return {
          role: 'customer',
          profile: { name: me.name, email: me.email },
          lead: lead[0] ?? null,
          bookings: bookings.map(b => ({ id: b.id, unitId: b.unit_id, bookingAmount: num(b.booking_amount), totalConsideration: num(b.total_consideration), status: b.status, stage: b.stage, paymentPlan: b.payment_plan })),
          schedule: schedules.map(s => ({ id: s.id, bookingId: s.booking_id, milestoneName: s.milestone_name, sequence: s.sequence, amount: num(s.amount), dueDate: s.due_date, status: s.status === 'invoiced' ? 'demanded' : s.status })),
          receipts: receipts.map(p => ({ id: p.id, scheduleId: p.payment_schedule_id, amount: num(p.amount), date: p.payment_date, mode: p.mode })),
          units: units.map(u => ({ id: u.id, towerId: u.tower_id, projectId: u.project_id, unitCode: u.unit_code, configuration: u.configuration, floor: u.floor, areaSqft: num(u.area_sqft), status: u.status })),
          towers: towers.map(t => ({ id: t.id, name: t.name, projectId: t.project_id })),
          tickets: tickets.map(t => ({ id: t.id, title: t.title, category: t.category, priority: t.priority, status: t.status, project: t.project, createdAt: t.created_at })),
          documents: documents.map(d => ({ id: d.id, name: d.name, type: d.type, project: d.project, docDate: d.doc_date, size: d.size, status: d.status, url: d.url })),
        };
      }

      // Partner: their broker record + commission ledger + the leads they
      // referred. Attribution is by broker_id, never by source NAME.
      const { rows: broker } = await db.query(
        `SELECT b.id, b.name, b.phone, b.email, b.agency_name, b.commission_structure,
                (SELECT count(*) FROM leads l WHERE l.broker_id = b.id)             AS leads_referred,
                (SELECT count(*) FROM commission_ledger cl WHERE cl.broker_id = b.id) AS bookings_closed
           FROM brokers b WHERE b.id = $1`, [me.broker_id]);

      // A commission line is only meaningful next to what earned it. Returning
      // the amount alone left the statement reading "· · Booking value · %",
      // and the page crashed outright trying to format the missing value.
      //
      // LEFT JOINs throughout: a commission whose booking or unit was later
      // removed still owes the partner money, and must still appear.
      const { rows: commissions } = await db.query(
        `SELECT cl.id, cl.booking_id, cl.amount_earned, cl.amount_paid, cl.status, cl.created_at,
                l.name AS lead_name,
                COALESCE(p.name, l.project) AS project,
                bk.total_consideration
           FROM commission_ledger cl
           LEFT JOIN bookings bk ON bk.id = cl.booking_id
           LEFT JOIN leads l     ON l.id  = bk.lead_id
           LEFT JOIN units u     ON u.id  = bk.unit_id
           LEFT JOIN projects p  ON p.id  = u.project_id
          WHERE cl.broker_id = $1
          ORDER BY cl.created_at DESC`, [me.broker_id]);
      const { rows: referred } = await db.query(
        'SELECT id, name, phone, project, stage, budget, created_at FROM leads WHERE broker_id = $1 ORDER BY created_at DESC', [me.broker_id]);
      // A channel partner sells these, so the catalogue is legitimately theirs
      // to see — marketing fields only, no financials.
      const { rows: projects } = await db.query('SELECT id, name, location FROM projects ORDER BY name');

      const b = broker[0];
      // commission_structure is {type, value}; only a percentage deal has a
      // rate to quote. A flat or slab arrangement has none, and inventing one
      // would misstate what the partner is owed.
      const structure = (b?.commission_structure ?? {}) as { type?: string; value?: number };
      const headlineRate = structure.type === 'percentage' ? num(structure.value) : null;

      return {
        role: 'partner',
        profile: { name: me.name, email: me.email },
        broker: b ? {
          id: b.id, name: b.name, phone: b.phone, email: b.email,
          agencyName: b.agency_name,
          commissionRate: headlineRate,
          leadsReferred: Number(b.leads_referred),
          bookingsClosed: Number(b.bookings_closed),
        } : null,
        commissions: commissions.map(c => {
          const value = num(c.total_consideration);
          const earned = num(c.amount_earned);
          return {
            id: c.id, bookingId: c.booking_id,
            amountEarned: earned, amountPaid: num(c.amount_paid), status: c.status,
            leadName: c.lead_name ?? null,
            project: c.project ?? null,
            bookingValue: value,
            // The rate this line was actually settled at, derived from the two
            // amounts rather than read off the broker record — a historic line
            // keeps the rate it was earned under even if the deal changes.
            rate: value > 0 ? Math.round((earned / value) * 10000) / 100 : null,
          };
        }),
        referredLeads: referred.map(l => ({ id: l.id, name: l.name, phone: l.phone, project: l.project, stage: l.stage, budget: num(l.budget), createdAt: l.created_at })),
        projects: projects.map(p => ({ id: p.id, name: p.name, location: p.location })),
      };
    });
  });

  /**
   * POST /api/portal/tickets — a buyer raises a support request.
   *
   * Writes `service_tickets`, which is what the portal's own request list and
   * the staff Service board both read, so a raised request round-trips and is
   * visible to staff. (The older /api/portal/service-requests route targets the
   * separate post-sales `service_requests` module and is left untouched.)
   * lead_id, customer and project are taken from the caller's account, never
   * from the body.
   */
  app.post<{ Body: { title: string; category?: string } }>(
    '/api/portal/tickets',
    {
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
      schema: { body: { type: 'object', required: ['title'], additionalProperties: false, properties: {
        title: { type: 'string', minLength: 1, maxLength: 300 },
        category: { type: 'string', maxLength: 60 },
      } } },
    },
    async (req, reply) => {
      const ctx = requirePortalAuth(req, reply);
      if (!ctx) return;
      return withTenantContext(portalCtx(ctx), async (db) => {
        const { rows: pu } = await db.query(`SELECT * FROM portal_users WHERE id = $1 AND active AND role = 'customer'`, [ctx.portalUserId]);
        if (!pu[0]) return reply.code(403).send({ error: 'Customer portal accounts only' });
        const { rows: lead } = await db.query('SELECT id, name, project FROM leads WHERE id = $1', [pu[0].lead_id]);
        if (!lead[0]) return reply.code(404).send({ error: 'No customer record found for this account' });

        const { rows } = await db.query(
          `INSERT INTO service_tickets (tenant_id, title, lead_id, customer, project, category, priority, status)
           VALUES (app_current_tenant(), $1, $2, $3, $4, $5, 'medium', 'open') RETURNING *`,
          [req.body.title, lead[0].id, lead[0].name, lead[0].project || '', req.body.category || 'Request']);
        const t = rows[0];
        reply.code(201);
        return { ticket: { id: t.id, title: t.title, category: t.category, priority: t.priority, status: t.status, project: t.project, createdAt: t.created_at } };
      });
    },
  );

  /**
   * POST /api/portal/leads — a channel partner refers a lead.
   *
   * Insert-only, and the attribution is taken from the CALLER'S OWN portal
   * account, never from the request body: a partner cannot credit a referral to
   * (or steal one from) another broker. Stage and priority are fixed server-side
   * so the portal cannot inject a lead further down the funnel than it belongs.
   */
  app.post<{ Body: { name: string; phone: string; email?: string; project?: string; budget?: number } }>(
    '/api/portal/leads',
    {
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
      schema: { body: { type: 'object', required: ['name', 'phone'], additionalProperties: false, properties: {
        name: { type: 'string', minLength: 1, maxLength: 120 },
        phone: { type: 'string', minLength: 3, maxLength: 32 },
        email: { type: 'string', maxLength: 160 },
        project: { type: 'string', maxLength: 160 },
        budget: { type: 'number', minimum: 0, maximum: 1e12 },
      } } },
    },
    async (req, reply) => {
      const ctx = requirePortalAuth(req, reply);
      if (!ctx) return;
      return withTenantContext(portalCtx(ctx), async (db) => {
        const { rows: pu } = await db.query(`SELECT * FROM portal_users WHERE id = $1 AND active AND role = 'partner'`, [ctx.portalUserId]);
        if (!pu[0]) return reply.code(403).send({ error: 'Partner portal accounts only' });
        const { rows: br } = await db.query('SELECT id, name FROM brokers WHERE id = $1', [pu[0].broker_id]);
        if (!br[0]) return reply.code(403).send({ error: 'This partner account is not linked to a broker' });

        // Only accept a project name that actually belongs to this tenant.
        let project = '';
        if (req.body.project) {
          const { rows: pj } = await db.query('SELECT name FROM projects WHERE name = $1', [req.body.project]);
          project = pj[0]?.name ?? '';
        }

        const { rows } = await db.query(
          `INSERT INTO leads (tenant_id, name, phone, email, source, broker_id, project, budget, stage, priority, last_contact_at)
           VALUES (app_current_tenant(), $1, $2, $3, $4, $5, $6, $7, 'new', 'warm', now())
           RETURNING id, name, phone, project, stage, budget, created_at`,
          [req.body.name, req.body.phone, req.body.email || null, br[0].name, br[0].id, project, req.body.budget ?? 0]);
        const l = rows[0];
        await enqueueAutoReply(db, {
          leadId: l.id, trigger: 'new_lead', phone: l.phone,
          leadName: l.name, project: l.project,
        }).catch(() => { /* never fail the referral */ });
        reply.code(201);
        return { lead: { id: l.id, name: l.name, phone: l.phone, project: l.project, stage: l.stage, budget: Number(l.budget ?? 0), createdAt: l.created_at } };
      });
    },
  );

  /** POST /api/portal/service-requests — a buyer raises a ticket. */
  app.post<{ Body: { category?: string; description: string } }>(
    '/api/portal/service-requests',
    {
      schema: { body: { type: 'object', required: ['description'], additionalProperties: false, properties: {
        category: { type: 'string', enum: ['maintenance', 'document_request', 'payment_query', 'transfer_request', 'other'] },
        description: { type: 'string', minLength: 1, maxLength: 2000 },
      } } },
    },
    async (req, reply) => {
      const ctx = requirePortalAuth(req, reply);
      if (!ctx) return;
      return withTenantContext(portalCtx(ctx), async (db) => {
        const { rows: pu } = await db.query(`SELECT * FROM portal_users WHERE id = $1 AND active AND role = 'customer'`, [ctx.portalUserId]);
        if (!pu[0]) return reply.code(403).send({ error: 'Customer portal accounts only' });
        // Find-or-create the customers row for this buyer's lead.
        let { rows: cust } = await db.query('SELECT id FROM customers WHERE lead_id = $1', [pu[0].lead_id]);
        if (!cust[0]) {
          const { rows: lead } = await db.query('SELECT name, phone, email FROM leads WHERE id = $1', [pu[0].lead_id]);
          const created = await db.query(
            'INSERT INTO customers (tenant_id, name, phone, email, lead_id) VALUES (app_current_tenant(), $1, $2, $3, $4) RETURNING id',
            [lead[0]?.name ?? pu[0].name, lead[0]?.phone ?? '', lead[0]?.email ?? pu[0].email, pu[0].lead_id]);
          cust = created.rows;
        }
        const { rows } = await db.query(
          `INSERT INTO service_requests (tenant_id, customer_id, category, description) VALUES (app_current_tenant(), $1, $2, $3) RETURNING *`,
          [cust[0].id, req.body.category || 'other', req.body.description]);
        const r = rows[0];
        reply.code(201); return { request: { id: r.id, category: r.category, description: r.description, status: r.status, createdAt: r.created_at } };
      });
    },
  );
}
