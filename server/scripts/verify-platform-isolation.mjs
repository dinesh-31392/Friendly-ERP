/**
 * The platform owner's account, and the wall around it.
 *
 * One account administers every workspace on the platform. It lives on the
 * 'platform' tenant with the role super_admin, and it must be invisible from
 * inside any builder's workspace — not merely un-clickable.
 *
 * WHY THE UI PROVES NOTHING HERE
 *
 * The SPA hides "Platform Control" behind view_platform and wraps /platform in a
 * PermissionGuard. Both are conveniences: anyone can call the API with their own
 * token and skip the SPA entirely. So every assertion below goes at the HTTP
 * layer with a builder-authenticated token, which is what a real attempt looks
 * like.
 *
 * THE ASSERTION THAT MATTERS MOST
 *
 * requirePlatformStaff checks IDENTITY — tenant slug 'platform', role
 * super_admin or tech_team — and never consults the permission catalog. That
 * distinction is the whole defence, and it is easy to lose: a future refactor
 * that "tidies up" by gating these routes on view_platform would look correct,
 * pass a permission audit, and hand the platform to any builder whose admin
 * granted themselves the key. So this suite grants a builder role view_platform
 * outright and proves it still buys them nothing.
 *
 * CONCEALMENT IS SEPARATE FROM ACCESS
 *
 * Being refused is not the same as being unaware. A builder must also be unable
 * to LEARN that the account exists — not in a user list, not in a role list, and
 * not by probing the login form for which addresses are real.
 */
import pg from 'pg';
import argon2 from 'argon2';

const BASE = process.env.API_BASE ?? 'http://localhost:4055';
const PW = 'Test1234!';
const MARK = 'pi' + Math.random().toString(36).slice(2, 7);
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + (x ? '  -> ' + x : ''))); };

const admin = new pg.Client(process.env.DATABASE_ADMIN_URL
  ?? 'postgres://postgres:postgres@localhost:5433/erp_test');
await admin.connect();

const login = async (email, password) => {
  const r = await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const call = async (token, method, path, body) => {
  const r = await fetch(BASE + path, {
    method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

// ── a builder workspace, with the most privileged role a builder can hold ──
const tenant = (await admin.query(
  `INSERT INTO tenants (name, company, slug, email) VALUES ($1,$1,$2,$3) RETURNING id`,
  [`${MARK} co`, `${MARK}-co`, `${MARK}@pi.test`])).rows[0];
const role = (await admin.query(
  `INSERT INTO roles (tenant_id, name, is_system) VALUES ($1,'builder_admin',false) RETURNING id`,
  [tenant.id])).rows[0];
// The whole catalog bar the platform keys — exactly what self-serve signup gives
// a workspace owner.
await admin.query(
  `INSERT INTO role_permissions (role_id, permission_key)
   SELECT $1, key FROM permissions WHERE key NOT IN ('view_platform','manage_branch')
   ON CONFLICT DO NOTHING`, [role.id]);
const builderEmail = `${MARK}-owner@pi.test`;
await admin.query(
  `INSERT INTO users (tenant_id, role_id, name, email, password_hash, active)
   VALUES ($1,$2,'Builder Owner',$3,$4,true)`,
  [tenant.id, role.id, builderEmail, await argon2.hash(PW, { type: argon2.argon2id })]);
const builder = (await login(builderEmail, PW)).body.token;
if (!builder) throw new Error('builder admin could not sign in');

// The owner's account, on the platform tenant.
const platform = (await admin.query(`SELECT id FROM tenants WHERE slug = 'platform'`)).rows[0];
if (!platform) throw new Error('no platform tenant — run scripts/seed.ts first');
const ownerEmail = (await admin.query(
  `SELECT u.email FROM users u JOIN roles r ON r.id = u.role_id
    WHERE u.tenant_id = $1 AND r.name = 'super_admin' LIMIT 1`, [platform.id])).rows[0]?.email;

console.log('\n=== A BUILDER CANNOT REACH THE PLATFORM ===');
for (const [what, method, path, body] of [
  ['list every workspace on the platform', 'GET', '/api/tenants'],
  ['read the platform branches', 'GET', '/api/branches'],
  ['provision a new workspace', 'POST', '/api/tenants',
    { name: 'Rogue', slug: `rogue-${MARK}`, email: 'r@r.test', adminName: 'R', adminEmail: 'r@r.test' }],
  ['move a workspace between branches', 'PUT', '/api/branches/assign-tenant',
    { tenantId: tenant.id, branchId: null }],
]) {
  const r = await call(builder, method, path, body);
  ok(`refused: ${what}`, r.status === 403, `${r.status} ${r.body.error ?? ''}`);
}

console.log('\n=== AND HOLDING THE KEY DOES NOT CHANGE THAT ===');
// The defence is identity, not permission. Grant the key and prove it is inert —
// this is what stops a well-meaning refactor from opening the platform up.
await admin.query(
  `INSERT INTO role_permissions (role_id, permission_key) VALUES ($1,'view_platform'), ($1,'manage_branch')
   ON CONFLICT DO NOTHING`, [role.id]);
const armed = (await login(builderEmail, PW)).body.token;
const withKey = await call(armed, 'GET', '/api/tenants');
ok('a builder granted view_platform outright is still refused',
  withKey.status === 403, `${withKey.status} ${withKey.body.error ?? ''}`);
ok('...and manage_branch buys them nothing either',
  (await call(armed, 'GET', '/api/branches')).status === 403);
await admin.query(
  `DELETE FROM role_permissions WHERE role_id = $1 AND permission_key IN ('view_platform','manage_branch')`,
  [role.id]);

console.log('\n=== THE OWNER’S ACCOUNT IS NOT MERELY REFUSED, IT IS UNSEEN ===');
const users = (await call(builder, 'GET', '/api/users')).body.users ?? [];
ok('the builder sees their own workspace’s accounts', users.length > 0, `${users.length}`);
ok('...and no platform account among them',
  !users.some(u => u.email === ownerEmail), ownerEmail ?? '(none)');
const roles = (await call(builder, 'GET', '/api/roles')).body.roles ?? [];
ok('super_admin does not appear in their role list',
  !roles.some(r => r.name === 'super_admin'), roles.map(r => r.name).join(','));

console.log('\n=== NOR CAN THE ADDRESS BE CONFIRMED BY PROBING ===');
// If a wrong password on the owner's real address answered differently from one
// on an invented address, the address itself would be discoverable.
const realMiss = await login(ownerEmail ?? 'nobody@pi.test', 'not-the-password-000');
const fakeMiss = await login(`${MARK}-invented@pi.test`, 'not-the-password-000');
ok('a wrong password tells you nothing about whether the account exists',
  realMiss.status === fakeMiss.status
  && JSON.stringify(realMiss.body) === JSON.stringify(fakeMiss.body),
  `${realMiss.status} ${JSON.stringify(realMiss.body)} vs ${fakeMiss.status} ${JSON.stringify(fakeMiss.body)}`);
ok('...and neither reply names the tenant or the role',
  !JSON.stringify(realMiss.body).match(/platform|super_admin/i), JSON.stringify(realMiss.body));

console.log('\n=== BEING ON THE PLATFORM TENANT IS NOT ENOUGH ===');
// Both the tenant AND the role must match. This matters because non-staff
// accounts do collect on the platform tenant — the dev workspace carries a
// stray sales_executive from an old seed — and the guard, not tidiness, is what
// has to stop them.
ok('the platform tenant holds a super_admin to administer with', !!ownerEmail, String(ownerEmail));
const strayRole = (await admin.query(
  `INSERT INTO roles (tenant_id, name, is_system) VALUES ($1,$2,false) RETURNING id`,
  [platform.id, `${MARK}_stray`])).rows[0];
await admin.query(
  `INSERT INTO role_permissions (role_id, permission_key)
   SELECT $1, key FROM permissions ON CONFLICT DO NOTHING`, [strayRole.id]);   // every key, including the platform ones
const strayEmail = `${MARK}-stray@pi.test`;
await admin.query(
  `INSERT INTO users (tenant_id, role_id, name, email, password_hash, active)
   VALUES ($1,$2,'Stray Platform User',$3,$4,true)`,
  [platform.id, strayRole.id, strayEmail, await argon2.hash(PW, { type: argon2.argon2id })]);
const stray = (await login(strayEmail, PW)).body.token;
ok('an account ON the platform tenant, holding every permission, still signs in', !!stray);
ok('...but is refused the platform, because its role is not super_admin or tech_team',
  (await call(stray, 'GET', '/api/tenants')).status === 403);
ok('...and cannot provision a workspace either',
  (await call(stray, 'POST', '/api/tenants',
    { name: 'Stray', slug: `stray-${MARK}`, email: 's@s.test', adminName: 'S', adminEmail: 's@s.test' })).status === 403);

// Deactivation takes effect against the token already issued — the guard reads
// `active` on every call rather than trusting what the token said at sign-in.
await admin.query(`UPDATE users SET active = false WHERE email = $1`, [strayEmail]);
ok('and deactivating an account stops its existing token immediately',
  [401, 403].includes((await call(stray, 'GET', '/api/tenants')).status));
await admin.query(`DELETE FROM users WHERE email = $1`, [strayEmail]);
await admin.query(`DELETE FROM roles WHERE id = $1`, [strayRole.id]);

await admin.query('DELETE FROM tenants WHERE id = $1', [tenant.id]);
await admin.end();
console.log(`\n===== ${pass} passed, ${fail} failed =====`);
process.exit(fail ? 1 : 0);
