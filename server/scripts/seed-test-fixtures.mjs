/**
 * The baseline the verification suites assume exists.
 *
 *   DATABASE_ADMIN_URL=... node scripts/seed-test-fixtures.mjs
 *
 * Until now that baseline was a database somebody had set up by hand months
 * ago: the suites reference admin@erptest.local and exec1@erptest.local, and
 * nothing in the repo created either. They passed locally and would have failed
 * on any fresh machine — which is precisely why they could not run in CI.
 *
 * Two tenants on purpose. Most of what these suites assert is that tenant A
 * cannot see tenant B, and you cannot test isolation with one tenant: every
 * query trivially passes.
 *
 * Idempotent — safe to re-run against an existing database.
 */
import 'dotenv/config';
import pg from 'pg';
import argon2 from 'argon2';

const url = process.env.DATABASE_ADMIN_URL;
if (!url) { console.error('DATABASE_ADMIN_URL is required'); process.exit(1); }

const c = new pg.Client({ connectionString: url });
await c.connect();

// The suites set their own passwords before signing in; this is only so the
// rows are valid before they do.
const hash = await argon2.hash('Test1234!', { type: argon2.argon2id });

const PIPELINE = { stages: [
  { key: 'new', id: 'new', label: 'New', color: 'bg-blue-500', core: true },
  { key: 'contacted', id: 'contacted', label: 'Contacted', color: 'bg-indigo-500', core: true },
  { key: 'qualified', id: 'qualified', label: 'Qualified', color: 'bg-violet-500', core: true },
  { key: 'site_visit', id: 'site_visit', label: 'Site Visit', color: 'bg-amber-500', core: true },
  { key: 'negotiation', id: 'negotiation', label: 'Negotiation', color: 'bg-orange-500', core: true },
  { key: 'booked', id: 'booked', label: 'Booked', color: 'bg-emerald-500', core: true },
  { key: 'lost', id: 'lost', label: 'Lost', color: 'bg-red-400', core: true },
]};

const { rows: allPerms } = await c.query('SELECT key FROM permissions');
const catalog = allPerms.map(r => r.key);
if (!catalog.length) {
  console.error('permissions catalog is empty — run scripts/seed.ts first');
  process.exit(1);
}

const ROLES = {
  super_admin: catalog,
  // Branch-scoped platform staff. Three keys only — its power comes from the
  // platform routes, not from tenant permissions (migration 044). Needed here
  // so verify-role-logins can sign in as the second platform role and check
  // that support access is NOT customer-data access.
  tech_team: ['view_dashboard', 'view_platform', 'manage_branch'],
  builder_admin: catalog.filter(k => !['approve_reminders', 'manage_team'].includes(k)),
  sales_executive: ['view_dashboard','view_leads','manage_own_leads','add_notes','view_inventory',
    'view_projects','view_messages','send_messages','view_documents','view_calendar',
    'schedule_visits','use_ai_studio','create_bookings','view_bookings','create_quotations'],
  // Leasing keys mirror ROLE_PERMS in seed.ts: the accountant PREPARES an owner
  // payout but has no approve_owner_payouts — verify-leasing asserts that the
  // maker cannot be the checker, which needs a role that really lacks it.
  accountant: ['view_dashboard','view_projects','view_reports','view_accounts','manage_accounts',
    'view_finance','manage_finance','view_procurement','view_bookings','view_documents',
    'view_invoices','manage_invoices',
    'view_leasing','view_owner_payouts','manage_owner_payouts'],
  auditor: ['view_dashboard','view_leads','view_projects','view_inventory','view_bookings',
    'view_reports','view_finance','view_accounts','view_audit_log','view_execution',
    'view_procurement','view_hr','view_invoices',
    'view_leasing','view_owner_payouts'],
};

async function tenant(slug, name) {
  const { rows: [t] } = await c.query(
    `INSERT INTO tenants (name, company, slug, plan, status, country, currency, channels, email)
     VALUES ($2,$2,$1,'growth','active','India','INR','{}',$3)
     ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`, [slug, name, `ops@${slug}.local`]);

  const roleId = {};
  for (const [role, keys] of Object.entries(ROLES)) {
    const { rows: [r] } = await c.query(
      `INSERT INTO roles (tenant_id, name, is_system) VALUES ($1,$2,true)
       ON CONFLICT (tenant_id, name) DO UPDATE SET is_system = true RETURNING id`, [t.id, role]);
    roleId[role] = r.id;
    for (const k of keys) {
      if (!catalog.includes(k)) continue;
      await c.query(
        `INSERT INTO role_permissions (role_id, permission_key) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
        [r.id, k]);
    }
  }

  // Without an active pipeline every lead insert fails a check constraint, so a
  // suite that creates leads would fail for a reason unrelated to what it tests.
  await c.query(
    `INSERT INTO schema_definitions (tenant_id, entity, kind, version, is_active, definition)
     VALUES ($1,'lead','pipeline',1,true,$2)
     ON CONFLICT (tenant_id, entity, kind, version)
     DO UPDATE SET definition = EXCLUDED.definition, is_active = true`,
    [t.id, JSON.stringify(PIPELINE)]);

  return { id: t.id, roleId };
}

async function user(t, email, role, name) {
  // One tenant per fixture address, enforced here rather than assumed.
  //
  // The upsert below is keyed on (tenant_id, email), so it is idempotent within
  // a workspace but NOT across one being renamed. When this seeder's rival
  // tenant slug changed from 'rival' to 'rivaltest', a long-lived test database
  // kept both — two badmin@rival.test rows in two different tenants.
  //
  // The login route resolves an email without a tenant slug and refuses when it
  // is ambiguous, which is correct behaviour and deliberately reports the same
  // "Invalid email or password" as a wrong password. So the three isolation
  // suites failed at "could not log in as rival tenant" with no hint that the
  // cause was a stale row from an earlier schema.
  //
  // Deleting the strays makes a long-lived database self-heal instead of
  // rotting silently. Safe here because this script seeds a TEST database and
  // owns every address it writes.
  await c.query('DELETE FROM users WHERE email = $1 AND tenant_id <> $2', [email, t.id]);

  // mfa_email_enabled = false: these accounts sign in programmatically, and a
  // second factor would make every suite measure the challenge flow instead of
  // what it is actually testing.
  await c.query(
    `INSERT INTO users (tenant_id, role_id, name, email, password_hash, active, mfa_email_enabled)
     VALUES ($1,$2,$3,$4,$5,true,false)
     ON CONFLICT (tenant_id, email)
     DO UPDATE SET role_id = EXCLUDED.role_id, active = true, mfa_email_enabled = false`,
    [t.id, t.roleId[role], name, email, hash]);
}

const platform = await tenant('platform', 'Platform');
await user(platform, 'admin@erptest.local',  'super_admin',     'Test Platform Admin');
await user(platform, 'tech@erptest.local',   'tech_team',       'Test Branch Team');
await user(platform, 'exec1@erptest.local',  'sales_executive', 'Test Executive One');
await user(platform, 'exec2@erptest.local',  'sales_executive', 'Test Executive Two');
await user(platform, 'acct@erptest.local',   'accountant',      'Test Accountant');
await user(platform, 'aud@erptest.local',    'auditor',         'Test Auditor');

// The other side of every isolation assertion.
const rival = await tenant('rivaltest', 'Rival Builders');
await user(rival, 'admin@rivaltest.local', 'builder_admin', 'Rival Admin');
// The isolation suites (accounts, land/BD, whatsapp) sign in as this address to
// prove one workspace cannot read another's rows. It was never seeded — it had
// simply been created by hand in a long-lived test database, so those three
// suites passed locally and would fail on any fresh one, CI included.
await user(rival, 'badmin@rival.test', 'builder_admin', 'Rival Builder Admin');

const { rows: [n] } = await c.query('SELECT count(*)::int c FROM users WHERE email LIKE $1', ['%test.local']);
console.log(`fixtures ready — 2 tenants, ${n.c} users, pipelines seeded`);
await c.end();
