/**
 * Role inheritance (migration 034).
 *
 * has_permission() walks a parent chain now. That is a change to the single
 * function every authorisation decision in the system runs through, so the
 * cases that matter are: it still resolves a parentless role exactly as before,
 * it grants what a parent holds, and it cannot be made to loop, span tenants,
 * or grant more than the chain actually contains.
 *
 * Talks to the database directly — this is about the SQL function, not a route.
 */
import pg from 'pg';

const c = new pg.Client({ connectionString: process.env.PROBE_DB_URL
  || 'postgres://postgres:postgres@localhost:5433/erp_test' });
await c.connect();

let pass = 0, fail = 0;
const ok = (n, cond, x = '') => { cond ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + (x ? '  -> ' + x : ''))); };

const MARK = 'RH';
const clean = async () => {
  await c.query(`DELETE FROM users WHERE email LIKE '${MARK.toLowerCase()}%@hier.test'`);
  await c.query(`DELETE FROM role_permissions WHERE role_id IN (SELECT id FROM roles WHERE name LIKE '${MARK}_%')`);
  // Children first: the parent FK is ON DELETE SET NULL, but ordering keeps the
  // intent obvious.
  await c.query(`UPDATE roles SET parent_role_id = NULL WHERE name LIKE '${MARK}_%'`);
  await c.query(`DELETE FROM roles WHERE name LIKE '${MARK}_%'`);
};
await clean();

const [tA] = (await c.query(`SELECT id FROM tenants WHERE slug='platform'`)).rows;
const [tB] = (await c.query(`SELECT id FROM tenants WHERE slug='rivaltest'`)).rows;

const mkRole = async (tenant, name, perms, parent = null) => {
  const { rows: [r] } = await c.query(
    `INSERT INTO roles (tenant_id, name, is_system, parent_role_id) VALUES ($1,$2,false,$3) RETURNING id`,
    [tenant, name, parent]);
  for (const p of perms) {
    await c.query(`INSERT INTO role_permissions (role_id, permission_key) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [r.id, p]);
  }
  return r.id;
};

// base ← middle ← top
const base   = await mkRole(tA.id, `${MARK}_base`,   ['view_dashboard', 'view_leads']);
const middle = await mkRole(tA.id, `${MARK}_middle`, ['manage_leads'], base);
const top    = await mkRole(tA.id, `${MARK}_top`,    ['manage_finance'], middle);
const orphan = await mkRole(tA.id, `${MARK}_orphan`, ['view_calendar']);

const mkUser = async (tenant, roleId, slug) => {
  const { rows: [u] } = await c.query(
    `INSERT INTO users (tenant_id, role_id, name, email, password_hash, active)
     VALUES ($1,$2,'Hier Probe',$3,'x',true) RETURNING id`,
    [tenant, roleId, `${MARK.toLowerCase()}${slug}@hier.test`]);
  return u.id;
};

const can = async (userId, tenant, key) => {
  await c.query(`SELECT set_config('app.current_tenant_id',$1,true), set_config('app.current_user_id',$2,true)`, [tenant, userId]);
  const { rows: [r] } = await c.query(`SELECT has_permission($1) AS ok`, [key]);
  return r.ok;
};

await c.query('BEGIN');

// ── Inheritance resolves up the chain ──────────────────────────────────────
console.log('\n=== INHERITANCE ===');
const uTop = await mkUser(tA.id, top, 'top');
ok('own permission',                    await can(uTop, tA.id, 'manage_finance'));
ok('parent permission (one hop)',       await can(uTop, tA.id, 'manage_leads'));
ok('grandparent permission (two hops)', await can(uTop, tA.id, 'view_leads'));
ok('a permission nobody in the chain holds is still refused',
   !(await can(uTop, tA.id, 'manage_hr')));

console.log('\n=== NO INHERITANCE DOWNWARD ===');
const uBase = await mkUser(tA.id, base, 'base');
ok('the parent does NOT gain the child\'s permissions', !(await can(uBase, tA.id, 'manage_finance')));
ok('the parent keeps its own',                          await can(uBase, tA.id, 'view_leads'));

console.log('\n=== PARENTLESS ROLES ARE UNCHANGED ===');
const uOrphan = await mkUser(tA.id, orphan, 'orphan');
ok('resolves its own grants',          await can(uOrphan, tA.id, 'view_calendar'));
ok('grants nothing it does not hold',  !(await can(uOrphan, tA.id, 'view_leads')));

console.log('\n=== INACTIVE USER ===');
await c.query(`UPDATE users SET active=false WHERE id=$1`, [uTop]);
ok('a deactivated user inherits nothing', !(await can(uTop, tA.id, 'view_leads')));
await c.query(`UPDATE users SET active=true WHERE id=$1`, [uTop]);

await c.query('COMMIT');

// ── The guards ─────────────────────────────────────────────────────────────
console.log('\n=== CYCLES ===');
const attempt = async (label, sql, params, wantFail = true) => {
  try {
    await c.query('BEGIN'); await c.query(sql, params); await c.query('ROLLBACK');
    ok(label, !wantFail, 'accepted');
  } catch (e) {
    await c.query('ROLLBACK');
    ok(label, wantFail, `refused ${e.code}`);
  }
};
await attempt('a role cannot be its own parent',        `UPDATE roles SET parent_role_id=$1 WHERE id=$1`, [base]);
await attempt('a two-role cycle is refused',            `UPDATE roles SET parent_role_id=$1 WHERE id=$2`, [top, base]);
await attempt('a three-role cycle is refused',          `UPDATE roles SET parent_role_id=$1 WHERE id=$2`, [top, base]);

console.log('\n=== CROSS-TENANT INHERITANCE ===');
const [rivalRole] = (await c.query(`SELECT id FROM roles WHERE tenant_id=$1 LIMIT 1`, [tB.id])).rows;
await attempt("a role cannot inherit from another tenant's role",
  `UPDATE roles SET parent_role_id=$1 WHERE id=$2`, [rivalRole.id, base]);

console.log('\n=== A LEGITIMATE CHANGE STILL WORKS ===');
await attempt('re-parenting within the tenant is allowed',
  `UPDATE roles SET parent_role_id=$1 WHERE id=$2`, [orphan, middle], false);

await clean();
await c.end();
console.log(`\n===== ${pass} passed, ${fail} failed =====`);
process.exit(fail ? 1 : 0);
