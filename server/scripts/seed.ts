/**
 * Production bootstrap. Idempotent — safe to re-run.
 *
 * Seeds ONLY what a real deployment requires:
 *   1. the permissions catalog — a GLOBAL reference table that role_permissions
 *      has a foreign key to. This is not demo data; the platform cannot grant
 *      anything without it.
 *   2. the platform tenant + a super_admin role holding every permission
 *   3. the first platform administrator, with a password taken from the
 *      environment and never written into this file
 *
 * It creates NO demo tenant, NO demo users, and NO sample leads. It previously
 * created a 'Skyline Builders' tenant plus four users all sharing the argon2id
 * hash of 'password123' — that is gone.
 *
 *   ADMIN_EMAIL=you@company.com \
 *   ADMIN_PASSWORD="$(openssl rand -base64 24)" \
 *   npm run db:seed
 *
 * Run with no ADMIN_* vars to seed just the catalog.
 */
import 'dotenv/config';
import pg from 'pg';
import argon2 from 'argon2';

const adminUrl = process.env.DATABASE_ADMIN_URL;
if (!adminUrl) throw new Error('DATABASE_ADMIN_URL is required');
const client = new pg.Client({ connectionString: adminUrl });
await client.connect();

// ── Permissions catalog (canonical list — mirrors src/services/authService.ts)
const PERMISSIONS = [
  'view_dashboard', 'view_leads', 'manage_leads', 'manage_own_leads', 'assign_leads',
  'add_notes', 'view_inventory', 'manage_inventory', 'view_reports', 'manage_settings',
  'manage_tenant', 'manage_users', 'manage_projects', 'view_projects',
  'view_sales_performance', 'approve_bookings', 'view_campaigns', 'manage_campaigns',
  'view_finance', 'manage_finance', 'view_messages', 'send_messages', 'view_documents',
  'manage_documents', 'view_service', 'manage_service', 'view_calendar',
  'schedule_visits', 'use_ai_studio', 'create_bookings', 'view_audit_log',
  'view_bookings', 'manage_bookings', 'view_brokers', 'manage_brokers',
  'manage_team', 'approve_reminders',
];

/**
 * System role → permission map. Not seeded against any tenant here (there is no
 * demo tenant any more); kept as the canonical definition for tenant
 * provisioning to apply when a builder workspace is created.
 */
export const ROLE_PERMS: Record<string, string[]> = {
  builder_admin: PERMISSIONS.filter(p => !['approve_reminders', 'manage_team'].includes(p)),
  sales_manager: [
    'view_dashboard', 'view_leads', 'manage_leads', 'assign_leads', 'add_notes', 'manage_team',
    'view_reports', 'view_inventory', 'view_projects', 'view_sales_performance', 'view_finance',
    'view_messages', 'send_messages', 'view_documents', 'view_service', 'manage_service',
    'view_calendar', 'schedule_visits', 'use_ai_studio', 'create_bookings', 'approve_reminders',
    'view_campaigns', 'manage_campaigns', 'view_bookings', 'manage_bookings', 'view_brokers',
  ],
  sales_executive: [
    'view_dashboard', 'view_leads', 'manage_own_leads', 'add_notes', 'view_inventory',
    'view_projects', 'view_messages', 'send_messages', 'view_documents', 'view_calendar',
    'schedule_visits', 'use_ai_studio', 'create_bookings', 'view_bookings',
  ],
};

/**
 * Default lead pipeline. This is NOT cosmetic seed data — it is REQUIRED.
 *
 * `validate_lead_stage()` rejects any lead whose stage is not in the tenant's
 * active pipeline definition, so a tenant without one cannot have a single lead
 * created (every INSERT fails with 23514). Bootstrapping a deployment without
 * this row produces a CRM that looks fine and silently refuses all writes.
 *
 * Each stage carries BOTH `key` and `id` on purpose: the trigger matches on
 * `key` (`definition->'stages' @> [{"key": ...}]`) while the SPA's StageDef
 * reads `id`. Mirrors LEAD_STAGES in src/types/index.ts — keep them in step.
 */
const DEFAULT_PIPELINE = {
  stages: [
    { key: 'new',             label: 'New',             color: 'bg-blue-500',    core: true },
    { key: 'contacted',       label: 'Contacted',       color: 'bg-purple-500',  core: false },
    { key: 'qualified',       label: 'Qualified',       color: 'bg-indigo-500',  core: false },
    { key: 'visit_scheduled', label: 'Visit Scheduled', color: 'bg-amber-500',   core: false },
    { key: 'negotiation',     label: 'Negotiation',     color: 'bg-orange-500',  core: false },
    { key: 'booked',          label: 'Booked',          color: 'bg-emerald-500', core: true },
    { key: 'lost',            label: 'Lost',            color: 'bg-red-400',     core: true },
  ].map(s => ({ ...s, id: s.key })),
};

for (const key of PERMISSIONS) {
  await client.query(
    `INSERT INTO permissions (key, description) VALUES ($1, $1) ON CONFLICT DO NOTHING`,
    [key],
  );
}
console.log(`permissions catalog seeded (${PERMISSIONS.length} keys)`);

// ── Platform tenant + first administrator ───────────────────────────────────
const adminEmail = process.env.ADMIN_EMAIL;
const adminPassword = process.env.ADMIN_PASSWORD;
const adminName = process.env.ADMIN_NAME || 'Platform Administrator';

if (!adminEmail || !adminPassword) {
  console.log('');
  console.log('No administrator created. To create one, re-run with:');
  console.log('  ADMIN_EMAIL=you@company.com ADMIN_PASSWORD="$(openssl rand -base64 24)" npm run db:seed');
  await client.end();
  process.exit(0);
}
if (adminPassword.length < 12) {
  throw new Error('ADMIN_PASSWORD must be at least 12 characters');
}
if (/change[_-]?me|password123|admin123|letmein/i.test(adminPassword)) {
  throw new Error('ADMIN_PASSWORD is a well-known placeholder — choose a real secret');
}

// The platform tenant is deliberately NOT a builder workspace. Keeping the
// super admin in its own tenant is what stops a workspace user from ever
// reaching it (the SPA demo used to seed the super admin inside the demo
// builder tenant, which is exactly how the role-switcher escalation worked).
const { rows: [platform] } = await client.query(
  `INSERT INTO tenants (name, company, slug, plan, status, country, currency, email)
   VALUES ('Platform', 'Platform', 'platform', 'Enterprise', 'active', 'India', 'INR', $1)
   ON CONFLICT (slug) DO UPDATE SET updated_at = now()
   RETURNING id`,
  [adminEmail.toLowerCase()],
);

// Give EVERY tenant that lacks one an active lead pipeline. Written as a
// backfill rather than a single insert for the platform tenant so that re-running
// the bootstrap repairs any workspace that predates this (or was created by a
// path that forgot), and so it stays idempotent.
const { rowCount: pipelinesAdded } = await client.query(
  `INSERT INTO schema_definitions (tenant_id, entity, kind, version, is_active, definition)
   SELECT t.id, 'lead', 'pipeline', 1, true, $1::jsonb
     FROM tenants t
    WHERE NOT EXISTS (
      SELECT 1 FROM schema_definitions sd
       WHERE sd.tenant_id = t.id
         AND sd.entity = 'lead' AND sd.kind = 'pipeline' AND sd.is_active
    )`,
  [JSON.stringify(DEFAULT_PIPELINE)],
);
console.log(`lead pipeline ensured (${pipelinesAdded} tenant(s) provisioned)`);

const { rows: [adminRole] } = await client.query(
  `INSERT INTO roles (tenant_id, name, is_system) VALUES ($1, 'super_admin', true)
   ON CONFLICT (tenant_id, name) DO UPDATE SET is_system = true
   RETURNING id`,
  [platform.id],
);
for (const key of PERMISSIONS) {
  await client.query(
    `INSERT INTO role_permissions (role_id, permission_key) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [adminRole.id, key],
  );
}

const adminHash = await argon2.hash(adminPassword, { type: argon2.argon2id });
const { rows: [admin] } = await client.query(
  `INSERT INTO users (tenant_id, role_id, name, email, password_hash)
   VALUES ($1, $2, $3, $4, $5)
   ON CONFLICT (tenant_id, email)
   DO UPDATE SET role_id = EXCLUDED.role_id, password_hash = EXCLUDED.password_hash
   RETURNING id`,
  [platform.id, adminRole.id, adminName, adminEmail.toLowerCase(), adminHash],
);

await client.end();
console.log('');
console.log('bootstrap complete');
console.log(`  platform tenant : ${platform.id}`);
console.log(`  administrator   : ${adminEmail.toLowerCase()} (${admin.id})`);
console.log('  no demo tenant, no demo users, no sample leads were created.');
