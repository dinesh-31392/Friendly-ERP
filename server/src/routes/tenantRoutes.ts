import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { platformPool } from '../db.js';
import { requireAuth, hashPassword } from '../auth.js';
import { randomBytes } from 'node:crypto';

/**
 * Tenant provisioning — the platform console.
 *
 * Onboarding a builder used to happen entirely in SuperAdmin.tsx against
 * localStorage, which meant a production deployment could not create a customer
 * at all: the workspace existed in one browser and nowhere else. This is the
 * server-side replacement.
 *
 * Everything here runs on the PLATFORM pool (BYPASSRLS) because it is
 * inherently cross-tenant — you cannot create a tenant from inside a tenant
 * context, and the caller's own tenant is the platform one. That makes the
 * staff check the only thing standing between a caller and every workspace, so
 * it is re-verified from the database on every request rather than trusted from
 * the token.
 */

const SLUG = '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$';

/** Active super_admin / tech_team of the platform tenant. Nothing else. */
async function requirePlatformStaff(req: FastifyRequest, reply: FastifyReply): Promise<boolean> {
  const { rows } = await platformPool.query(
    `SELECT t.slug, r.name AS role, u.active
       FROM users u JOIN tenants t ON t.id = u.tenant_id JOIN roles r ON r.id = u.role_id
      WHERE u.id = $1 AND u.tenant_id = $2`,
    [req.ctx.userId, req.ctx.tenantId],
  );
  const u = rows[0];
  if (!u || !u.active || u.slug !== 'platform' || !['super_admin', 'tech_team'].includes(u.role)) {
    reply.code(403).send({ error: 'Platform staff only' });
    return false;
  }
  return true;
}

const toApiTenant = (r: Record<string, unknown>) => ({
  id: r.id, name: r.name, company: r.company, slug: r.slug, plan: r.plan, status: r.status,
  country: r.country, currency: r.currency, email: r.email, phone: r.phone,
  trialEndsAt: r.trial_ends_at, branchId: r.branch_id, createdAt: r.created_at,
  userCount: r.user_count === undefined ? undefined : Number(r.user_count),
});

/**
 * The permission catalog a fresh workspace's roles get. Mirrors ROLE_PERMS in
 * scripts/seed.ts — the two must change together, and migration 028 exists
 * because they drifted once already.
 */
const ROLE_PERMS: Record<string, string[]> = {
  builder_admin: [],   // filled from the catalog below, minus the two exceptions
  sales_manager: ['view_dashboard','view_leads','manage_leads','assign_leads','add_notes','manage_team',
    'view_reports','view_inventory','view_projects','view_sales_performance','view_finance','view_messages',
    'send_messages','view_documents','view_service','manage_service','view_calendar','schedule_visits',
    'use_ai_studio','create_bookings','approve_reminders','view_campaigns','manage_campaigns','view_bookings',
    'manage_bookings','view_brokers','view_execution','create_quotations','approve_discounts','view_invoices'],
  sales_executive: ['view_dashboard','view_leads','manage_own_leads','add_notes','view_inventory',
    'view_projects','view_messages','send_messages','view_documents','view_calendar','schedule_visits',
    'use_ai_studio','create_bookings','view_bookings','create_quotations'],
  site_engineer: ['view_dashboard','view_projects','view_execution','manage_execution','view_procurement',
    'manage_procurement','view_hr','manage_attendance','view_documents','view_calendar','view_messages',
    'send_messages','signoff_ra_bills'],
  telecaller: ['view_dashboard','view_leads','manage_own_leads','add_notes','view_projects','view_calendar',
    'schedule_visits','view_messages','send_messages'],
  accountant: ['view_dashboard','view_projects','view_reports','view_accounts','manage_accounts',
    'view_finance','manage_finance','view_procurement','view_bookings','view_documents',
    'view_invoices','manage_invoices'],
  auditor: ['view_dashboard','view_leads','view_projects','view_inventory','view_bookings',
    'view_sales_performance','view_campaigns','view_calendar','view_reports','view_messages','view_documents',
    'view_finance','view_service','view_brokers','view_execution','view_procurement','view_hr','view_accounts',
    'view_audit_log','view_invoices'],
  land_manager: ['view_dashboard','view_projects','view_documents','view_land','manage_land','view_bd',
    'view_calendar','view_messages','send_messages'],
  bd_manager: ['view_dashboard','view_projects','view_reports','view_bd','manage_bd','view_land',
    'approve_land_qualify','view_documents','view_calendar','view_messages','send_messages'],
};

/**
 * The default lead pipeline. This is NOT cosmetic — validate_lead_stage()
 * rejects any lead whose stage is not in the tenant's active pipeline, so a
 * workspace provisioned without one silently refuses every lead insert.
 */
const DEFAULT_PIPELINE = {
  stages: [
    { key: 'new',        id: 'new',        label: 'New',        color: 'bg-blue-500',   core: true },
    { key: 'contacted',  id: 'contacted',  label: 'Contacted',  color: 'bg-indigo-500', core: true },
    { key: 'qualified',  id: 'qualified',  label: 'Qualified',  color: 'bg-violet-500', core: true },
    { key: 'site_visit', id: 'site_visit', label: 'Site Visit', color: 'bg-amber-500',  core: true },
    { key: 'negotiation',id: 'negotiation',label: 'Negotiation',color: 'bg-orange-500', core: true },
    { key: 'booked',     id: 'booked',     label: 'Booked',     color: 'bg-emerald-500',core: true },
    { key: 'lost',       id: 'lost',       label: 'Lost',       color: 'bg-red-400',    core: true },
  ],
};

export async function tenantRoutes(app: FastifyInstance): Promise<void> {
  /** GET /api/tenants — the platform console's workspace list. */
  app.get('/api/tenants', { preHandler: requireAuth }, async (req, reply) => {
    if (!await requirePlatformStaff(req, reply)) return;
    const { rows } = await platformPool.query(
      `SELECT t.*, (SELECT count(*) FROM users u WHERE u.tenant_id = t.id) AS user_count
         FROM tenants t ORDER BY t.created_at DESC`);
    return { tenants: rows.map(toApiTenant) };
  });

  /**
   * POST /api/tenants — provision a builder workspace and its first admin.
   *
   * One transaction: tenant, the nine system roles with their grants, the lead
   * pipeline, and the administrator. A workspace that is half-provisioned is
   * worse than none — it logs in and then refuses every write — so this either
   * lands whole or not at all.
   */
  app.post<{ Body: { name: string; company?: string; slug: string; email: string; adminName: string; adminEmail: string; plan?: string; country?: string; currency?: string; phone?: string } }>(
    '/api/tenants',
    {
      preHandler: requireAuth,
      schema: { body: { type: 'object', required: ['name', 'slug', 'email', 'adminName', 'adminEmail'], additionalProperties: false, properties: {
        name: { type: 'string', minLength: 1, maxLength: 160 },
        company: { type: 'string', maxLength: 160 },
        slug: { type: 'string', pattern: SLUG },
        email: { type: 'string', maxLength: 160 },
        adminName: { type: 'string', minLength: 1, maxLength: 160 },
        adminEmail: { type: 'string', maxLength: 160 },
        plan: { type: 'string', enum: ['trial', 'starter', 'growth', 'enterprise'] },
        country: { type: 'string', maxLength: 80 },
        currency: { type: 'string', maxLength: 8 },
        phone: { type: 'string', maxLength: 32 },
      } } },
    },
    async (req, reply) => {
      if (!await requirePlatformStaff(req, reply)) return;
      const b = req.body;
      if (b.slug === 'platform') return reply.code(400).send({ error: 'The slug "platform" is reserved' });

      // Generated, never chosen by the caller and never logged. Returned ONCE.
      const tempPassword = randomBytes(12).toString('base64url');
      const passwordHash = await hashPassword(tempPassword);

      const client = await platformPool.connect();
      try {
        await client.query('BEGIN');

        const { rows: [tenant] } = await client.query(
          `INSERT INTO tenants (name, company, slug, plan, status, country, currency, channels, email, phone, trial_ends_at)
           VALUES ($1,$2,$3,$4,'active',$5,$6,'{}',$7,$8, now() + interval '14 days')
           RETURNING *`,
          [b.name, b.company || b.name, b.slug, b.plan || 'trial',
           b.country || 'India', b.currency || 'INR', b.email, b.phone || null]);

        // Roles + grants. builder_admin gets the whole catalog bar two workflow
        // rights that belong to a sales manager.
        const { rows: allPerms } = await client.query(`SELECT key FROM permissions`);
        const catalog = allPerms.map(r => r.key as string);
        const perms: Record<string, string[]> = {
          ...ROLE_PERMS,
          builder_admin: catalog.filter(k => !['approve_reminders', 'manage_team'].includes(k)),
        };

        const roleIds: Record<string, string> = {};
        for (const [roleName, keys] of Object.entries(perms)) {
          const { rows: [role] } = await client.query(
            `INSERT INTO roles (tenant_id, name, is_system) VALUES ($1,$2,true) RETURNING id`,
            [tenant.id, roleName]);
          roleIds[roleName] = role.id;
          for (const k of keys) {
            // Skip a key the catalog does not have rather than failing the
            // whole provision on one stale entry.
            if (!catalog.includes(k)) continue;
            await client.query(
              `INSERT INTO role_permissions (role_id, permission_key) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
              [role.id, k]);
          }
        }

        // The pipeline, without which no lead can be created.
        //
        // This belongs in schema_definitions, NOT meta_config: validate_lead_stage()
        // looks for (entity='lead', kind='pipeline', is_active) there and rejects
        // any stage it cannot find. Seeding the wrong table produces a workspace
        // that provisions cleanly, logs in fine, and then refuses every single
        // lead insert with a bare 23514 — which is exactly what happened on the
        // first run of this code.
        await client.query(
          `INSERT INTO schema_definitions (tenant_id, entity, kind, version, is_active, definition)
           VALUES ($1, 'lead', 'pipeline', 1, true, $2)
           ON CONFLICT (tenant_id, entity, kind, version)
           DO UPDATE SET definition = EXCLUDED.definition, is_active = true`,
          [tenant.id, JSON.stringify(DEFAULT_PIPELINE)]);

        const { rows: [admin] } = await client.query(
          `INSERT INTO users (tenant_id, role_id, name, email, password_hash, active, must_change_password)
           VALUES ($1,$2,$3,$4,$5,true,true) RETURNING id, email`,
          [tenant.id, roleIds.builder_admin, b.adminName, b.adminEmail, passwordHash]);

        await client.query('COMMIT');
        reply.code(201);
        // The only time this password is ever readable. It is stored as an
        // argon2id hash and cannot be recovered; the admin must change it on
        // first sign-in.
        return {
          tenant: toApiTenant(tenant),
          admin: { id: admin.id, email: admin.email },
          tempPassword,
        };
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        const code = (err as { code?: string }).code;
        if (code === '23505') return reply.code(409).send({ error: 'That workspace code or admin email is already taken' });
        throw err;
      } finally {
        client.release();
      }
    },
  );

  /** PATCH /api/tenants/:id — plan, status, branch. Not identity. */
  app.patch<{ Params: { id: string }; Body: { plan?: string; status?: string; branchId?: string | null; name?: string; phone?: string } }>(
    '/api/tenants/:id',
    {
      preHandler: requireAuth,
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: '^[0-9a-fA-F-]{36}$' } } },
        body: { type: 'object', minProperties: 1, additionalProperties: false, properties: {
          plan: { type: 'string', enum: ['trial', 'starter', 'growth', 'enterprise'] },
          status: { type: 'string', enum: ['active', 'suspended', 'cancelled'] },
          branchId: { type: ['string', 'null'], pattern: '^[0-9a-fA-F-]{36}$' },
          name: { type: 'string', minLength: 1, maxLength: 160 },
          phone: { type: 'string', maxLength: 32 },
        } },
      },
    },
    async (req, reply) => {
      if (!await requirePlatformStaff(req, reply)) return;
      const map: Record<string, string> = { plan: 'plan', status: 'status', branchId: 'branch_id', name: 'name', phone: 'phone' };
      const sets: string[] = []; const params: unknown[] = [];
      for (const [k, col] of Object.entries(map)) {
        const v = (req.body as Record<string, unknown>)[k];
        if (v !== undefined) { params.push(v); sets.push(`${col} = $${params.length}`); }
      }
      params.push(req.params.id);
      const { rows } = await platformPool.query(
        `UPDATE tenants SET ${sets.join(', ')}, updated_at = now() WHERE id = $${params.length} RETURNING *`, params);
      if (!rows[0]) return reply.code(404).send({ error: 'Workspace not found' });
      return { tenant: toApiTenant(rows[0]) };
    },
  );
}
