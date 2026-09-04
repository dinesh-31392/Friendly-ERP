/**
 * The five endpoints that had to exist before demo mode could be deleted.
 *
 * Each one backs a feature that previously lived only in localStorage, so
 * removing the browser store without these would have removed the feature:
 * invoices (Billing), CRM tasks (Calendar), notes (Leads), the audit-log
 * viewer, and tenant provisioning (onboarding a customer at all).
 *
 * Run against erp_test with the API on 4055.
 */
import pg from 'pg';
import argon2 from 'argon2';

// CI runs the API on 4055; API_BASE lets a developer point the suite at a
// second instance instead of stopping whatever is already on that port.
const BASE = process.env.API_BASE ?? 'http://localhost:4055';
const PW = 'Test1234!';
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + (x ? '  -> ' + x : ''))); };

const admin = new pg.Client('postgres://postgres:postgres@localhost:5433/erp_test');
await admin.connect();

const MARK = 'GOLV';
async function cleanup() {
  await admin.query(`DELETE FROM crm_tasks WHERE title LIKE '${MARK}%'`);
  await admin.query(`DELETE FROM invoices WHERE lead_name LIKE '${MARK}%' OR project LIKE '${MARK}%'`);
  await admin.query(`DELETE FROM lead_activities WHERE lead_id IN (SELECT id FROM leads WHERE name LIKE '${MARK}%')`);
  await admin.query(`DELETE FROM leads WHERE name LIKE '${MARK}%'`);
  await admin.query(`DELETE FROM users WHERE email LIKE '${MARK.toLowerCase()}%@golive.test'`);
  // Provisioned workspaces from a previous run.
  await admin.query(`DELETE FROM role_permissions WHERE role_id IN (SELECT id FROM roles WHERE tenant_id IN (SELECT id FROM tenants WHERE slug LIKE '${MARK.toLowerCase()}-%'))`);
  await admin.query(`DELETE FROM tenants WHERE slug LIKE '${MARK.toLowerCase()}-%'`);
  await admin.query(`DELETE FROM role_permissions WHERE role_id IN (SELECT id FROM roles WHERE name LIKE '${MARK}%')`);
  await admin.query(`DELETE FROM roles WHERE name LIKE '${MARK}%'`);
}
await cleanup();

// A finance-capable user in a normal tenant, and a platform super_admin.
const { rows: [t] } = await admin.query(`SELECT id FROM tenants WHERE slug <> 'platform' LIMIT 1`);
const tenant = t?.id ?? (await admin.query(`SELECT id FROM tenants LIMIT 1`)).rows[0].id;
const { rows: [role] } = await admin.query(
  `INSERT INTO roles (tenant_id, name, is_system) VALUES ($1,'${MARK}_finance',false)
     ON CONFLICT (tenant_id, name) DO UPDATE SET is_system=false RETURNING id`, [tenant]);
for (const k of ['view_dashboard','view_finance','manage_finance','view_invoices','manage_invoices',
                 'view_calendar','schedule_visits','view_audit_log','view_leads','manage_leads','manage_team']) {
  await admin.query(`INSERT INTO role_permissions (role_id, permission_key) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [role.id, k]);
}
const hash = await argon2.hash(PW, { type: argon2.argon2id });
await admin.query(
  `INSERT INTO users (tenant_id, role_id, name, email, password_hash, active)
   VALUES ($1,$2,'GoLive Finance',$3,$4,true)`, [tenant, role.id, `${MARK.toLowerCase()}fin@golive.test`, hash]);

const login = async (email) => {
  const r = await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PW }) });
  return (await r.json()).token;
};
const tok = await login(`${MARK.toLowerCase()}fin@golive.test`);
const H = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok };
const call = async (m, p, body) => {
  const r = await fetch(BASE + p, { method: m, headers: H, body: m === 'GET' ? undefined : JSON.stringify(body ?? {}) });
  return { status: r.status, body: await r.json().catch(() => null) };
};

// ── Invoices ───────────────────────────────────────────────────────────────
console.log('\n=== INVOICES ===');
const { rows: [lead] } = await admin.query(
  `INSERT INTO leads (tenant_id, name, phone, stage) VALUES ($1,'${MARK} Buyer','9800000010','new') RETURNING id`, [tenant]);
const mk = await call('POST', '/api/invoices', {
  leadId: lead.id, leadName: `${MARK} Buyer`, project: `${MARK} Tower`,
  type: 'Booking Token', amount: 300000, dueDate: '2026-12-31' });
ok('create invoice (201)', mk.status === 201, `${mk.status} ${JSON.stringify(mk.body).slice(0, 90)}`);
ok('amount round-trips', mk.body?.invoice?.amount === 300000, String(mk.body?.invoice?.amount));
ok('defaults to Pending', mk.body?.invoice?.status === 'Pending', mk.body?.invoice?.status);

const list = await call('GET', '/api/invoices');
ok('invoice appears in the list', list.status === 200 && list.body.invoices.some(i => i.id === mk.body.invoice.id));

const paid = await call('PATCH', `/api/invoices/${mk.body.invoice.id}`, { status: 'Paid' });
ok('mark paid', paid.status === 200 && paid.body.invoice.status === 'Paid', `${paid.status}`);

const audited = (await admin.query(
  `SELECT count(*)::int n FROM audit_logs WHERE table_name='invoices' AND record_id=$1`, [mk.body.invoice.id])).rows[0].n;
ok('invoice writes hit the audit trail', audited >= 2, `${audited} rows`);

const del = await call('DELETE', `/api/invoices/${mk.body.invoice.id}`);
ok('delete invoice (204)', del.status === 204, String(del.status));

// ── CRM tasks ──────────────────────────────────────────────────────────────
console.log('\n=== CRM TASKS ===');
const task = await call('POST', '/api/crm-tasks', {
  title: `${MARK} Call the buyer`, category: 'follow_up', priority: 'hot', dueDate: '2026-09-01T10:00:00Z' });
ok('create task (201)', task.status === 201, `${task.status} ${JSON.stringify(task.body).slice(0, 90)}`);
ok('assigned to the caller by default', !!task.body?.task?.userId);
const tlist = await call('GET', '/api/crm-tasks');
ok('task appears in the calendar', tlist.status === 200 && tlist.body.tasks.some(x => x.id === task.body.task.id));
const done = await call('PATCH', `/api/crm-tasks/${task.body.task.id}`, { status: 'completed' });
ok('complete a task', done.status === 200 && done.body.task.status === 'completed', String(done.status));
const tdel = await call('DELETE', `/api/crm-tasks/${task.body.task.id}`);
ok('delete a task (204)', tdel.status === 204, String(tdel.status));

// ── Notes (lead_activities) ────────────────────────────────────────────────
console.log('\n=== NOTES ===');
const note = await call('POST', '/api/lead-activities', { leadId: lead.id, type: 'note', notes: `${MARK} met on site` });
ok('a note is a lead activity (201)', note.status === 201, `${note.status} ${JSON.stringify(note.body).slice(0, 80)}`);
const noteRow = (await admin.query(
  `SELECT type, notes FROM lead_activities WHERE lead_id=$1 AND type='note'`, [lead.id])).rows[0];
ok('note persisted server-side', noteRow?.notes?.includes('met on site'), JSON.stringify(noteRow));

// ── Audit log viewer ───────────────────────────────────────────────────────
console.log('\n=== AUDIT LOG ===');
const al = await call('GET', '/api/audit-logs?limit=50');
ok('audit log readable with view_audit_log', al.status === 200, String(al.status));
ok('rows are shaped for the UI', Array.isArray(al.body?.auditLogs) && (al.body.auditLogs.length === 0 || 'entity' in al.body.auditLogs[0]));
ok('there is no write endpoint', (await call('POST', '/api/audit-logs', {})).status === 404);

// A role without the permission must not read it.
const { rows: [role2] } = await admin.query(
  `INSERT INTO roles (tenant_id, name, is_system) VALUES ($1,'${MARK}_norights',false)
     ON CONFLICT (tenant_id, name) DO UPDATE SET is_system=false RETURNING id`, [tenant]);
await admin.query(`INSERT INTO role_permissions (role_id, permission_key) VALUES ($1,'view_dashboard') ON CONFLICT DO NOTHING`, [role2.id]);
await admin.query(
  `INSERT INTO users (tenant_id, role_id, name, email, password_hash, active)
   VALUES ($1,$2,'GoLive NoRights',$3,$4,true)`, [tenant, role2.id, `${MARK.toLowerCase()}no@golive.test`, hash]);
const tok2 = await login(`${MARK.toLowerCase()}no@golive.test`);
const denied = await fetch(BASE + '/api/audit-logs', { headers: { Authorization: 'Bearer ' + tok2 } });
ok('audit log refused without the permission (403)', denied.status === 403, String(denied.status));
const invDenied = await fetch(BASE + '/api/invoices', { headers: { Authorization: 'Bearer ' + tok2 } });
ok('invoices refused without finance rights (403)', invDenied.status === 403, String(invDenied.status));

// ── Tenant provisioning ────────────────────────────────────────────────────
console.log('\n=== TENANT PROVISIONING ===');
const nonPlatform = await fetch(BASE + '/api/tenants', { method: 'POST', headers: H, body: JSON.stringify({
  name: 'X', slug: `${MARK.toLowerCase()}-nope`, email: 'x@x.com', adminName: 'X', adminEmail: 'x@x.com' }) });
ok('a builder user cannot provision (403)', nonPlatform.status === 403, String(nonPlatform.status));

// Platform staff.
const { rows: [plat] } = await admin.query(`SELECT id FROM tenants WHERE slug='platform'`);
if (!plat) {
  console.log('  (no platform tenant in erp_test — provisioning assertions skipped)');
} else {
  const { rows: [prole] } = await admin.query(
    `INSERT INTO roles (tenant_id, name, is_system) VALUES ($1,'super_admin',true)
     ON CONFLICT (tenant_id, name) DO UPDATE SET is_system=true RETURNING id`, [plat.id]);
  await admin.query(
    `INSERT INTO users (tenant_id, role_id, name, email, password_hash, active)
     VALUES ($1,$2,'GoLive Platform',$3,$4,true)
     ON CONFLICT (tenant_id, email) DO UPDATE SET password_hash=EXCLUDED.password_hash, active=true`,
    [plat.id, prole.id, `${MARK.toLowerCase()}plat@golive.test`, hash]);

  const ptok = await login(`${MARK.toLowerCase()}plat@golive.test`);
  const PH = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + ptok };
  const prov = await fetch(BASE + '/api/tenants', { method: 'POST', headers: PH, body: JSON.stringify({
    name: `${MARK} Builders`, slug: `${MARK.toLowerCase()}-builders`, email: 'ops@golive.test',
    adminName: 'Golive Admin', adminEmail: `${MARK.toLowerCase()}admin@golive.test` }) });
  const pb = await prov.json();
  ok('platform staff can provision (201)', prov.status === 201, `${prov.status} ${JSON.stringify(pb).slice(0, 110)}`);
  ok('a temporary password is returned once', typeof pb?.tempPassword === 'string' && pb.tempPassword.length >= 12);

  const newTenant = pb?.tenant?.id;
  // Named, not counted. This read `roleCount === 9` and started failing the
  // day hr_manager was added — a count tells you the number changed but not
  // whether the RIGHT role appeared, and a role silently MISSING from a fresh
  // workspace is the bug worth catching (migration 046 exists because four of
  // them were).
  const EXPECTED_ROLES = [
    'accountant', 'auditor', 'bd_manager', 'builder_admin', 'hr_manager',
    'land_manager', 'sales_executive', 'sales_manager', 'site_engineer', 'telecaller',
  ];
  const roleNames = (await admin.query(
    `SELECT name FROM roles WHERE tenant_id=$1 ORDER BY name`, [newTenant])).rows.map(r => r.name);
  const missing = EXPECTED_ROLES.filter(r => !roleNames.includes(r));
  const extra = roleNames.filter(r => !EXPECTED_ROLES.includes(r));
  ok('a fresh workspace has exactly the system roles',
     missing.length === 0 && extra.length === 0,
     `missing: [${missing}] unexpected: [${extra}]`);
  const grants = (await admin.query(
    `SELECT count(*)::int n FROM role_permissions rp JOIN roles r ON r.id=rp.role_id WHERE r.tenant_id=$1`, [newTenant])).rows[0].n;
  ok('roles carry their grants', grants > 50, `${grants} grants`);

  // Provisioning keeps its OWN copy of the role→permission map, so a module
  // shipped later reaches existing tenants via a migration and new ones only if
  // that copy was updated too. Migration 028 exists because those two drifted.
  // Assert the newest module (leasing, 036) actually lands on a fresh workspace,
  // rather than discovering months later that every new builder gets a 403.
  const leasingGrants = (await admin.query(
    `SELECT r.name, rp.permission_key
       FROM role_permissions rp JOIN roles r ON r.id = rp.role_id
      WHERE r.tenant_id = $1 AND rp.permission_key LIKE ANY (ARRAY['%leasing%', '%owner_payouts%'])`,
    [newTenant])).rows;
  const held = (role) => leasingGrants.filter(g => g.name === role).map(g => g.permission_key);
  ok('a fresh workspace can use the leasing module',
    held('sales_manager').includes('manage_leasing') && held('builder_admin').includes('view_leasing'),
    `sales_manager: ${held('sales_manager').join(',') || 'none'}`);
  ok('and its accountant prepares payouts without being able to release them',
    held('accountant').includes('manage_owner_payouts') && !held('accountant').includes('approve_owner_payouts'),
    `accountant: ${held('accountant').join(',') || 'none'}`);
  const pipeline = (await admin.query(
    `SELECT definition FROM schema_definitions WHERE tenant_id=$1 AND entity='lead' AND kind='pipeline' AND is_active`, [newTenant])).rows[0];
  ok('the lead pipeline is seeded (without it no lead can be created)', !!pipeline);
  const adminUser = (await admin.query(
    `SELECT must_change_password FROM users WHERE tenant_id=$1`, [newTenant])).rows[0];
  ok('the admin must change their password', adminUser?.must_change_password === true);

  // The new admin can actually sign in and create a lead — the real proof the
  // workspace is usable, not just present.
  const nlogin = await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: `${MARK.toLowerCase()}admin@golive.test`, password: pb.tempPassword }) });
  const nbody = await nlogin.json();
  ok('the provisioned admin can sign in', nlogin.status === 200 && !!nbody.token, `${nlogin.status}`);
  if (nbody.token) {
    const NH = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + nbody.token };
    const mkLead = await fetch(BASE + '/api/leads', { method: 'POST', headers: NH,
      body: JSON.stringify({ name: `${MARK} First Lead`, phone: '9800000011' }) });
    ok('the fresh workspace accepts a lead (pipeline works)', mkLead.status === 201, String(mkLead.status));
  }

  const dupe = await fetch(BASE + '/api/tenants', { method: 'POST', headers: PH, body: JSON.stringify({
    name: 'dupe', slug: `${MARK.toLowerCase()}-builders`, email: 'a@b.com', adminName: 'A', adminEmail: 'a2@b.com' }) });
  ok('a duplicate workspace code is refused (409)', dupe.status === 409, String(dupe.status));

  const reserved = await fetch(BASE + '/api/tenants', { method: 'POST', headers: PH, body: JSON.stringify({
    name: 'x', slug: 'platform', email: 'a@b.com', adminName: 'A', adminEmail: 'a3@b.com' }) });
  ok('the "platform" slug is reserved (400)', reserved.status === 400, String(reserved.status));

  await admin.query(`DELETE FROM users WHERE email LIKE '${MARK.toLowerCase()}%@golive.test'`);
}

await cleanup();
await admin.end();
console.log(`\n===== ${pass} passed, ${fail} failed =====`);
process.exit(fail ? 1 : 0);
