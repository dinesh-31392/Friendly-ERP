/**
 * Tenant-isolation regression test — the guarantee a multi-tenant ERP rests on.
 *
 * Proves, against a real Postgres with all migrations applied, that:
 *   1. every table carrying a tenant_id has RLS enabled AND forced;
 *   2. no RLS table is a silent deny-all (RLS on, zero policies);
 *   3. every policy scopes to app_current_tenant() (no unscoped leak);
 *   4. functionally, the RLS-bound app_user role in tenant B cannot see, and
 *      cannot forge, tenant A's rows.
 *
 * Usage (against a DB that has migrations 001..N applied and the app_user role):
 *   DATABASE_ADMIN_URL=postgres://postgres:postgres@localhost:5433/erp_test \
 *     node scripts/verify-rls.mjs
 */
import pg from 'pg';

const url = process.env.DATABASE_ADMIN_URL || 'postgres://postgres:postgres@localhost:5433/erp_test';
const c = new pg.Client({ connectionString: url });
await c.connect();
let pass = 0, fail = 0;
const ok = (n, cond, extra = '') => { cond ? (pass++, console.log('  PASS  ' + n)) : (fail++, console.log('  FAIL  ' + n + '  ' + extra)); };

// ── 1) Structural coverage ───────────────────────────────────────────────────
const { rows: gap } = await c.query(`
  SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND c.relkind IN ('r','p') AND NOT c.relrowsecurity
    AND EXISTS (SELECT 1 FROM information_schema.columns col
                WHERE col.table_schema='public' AND col.table_name=c.relname AND col.column_name='tenant_id')`);
ok('every tenant_id table has RLS enabled', gap.length === 0, '-> missing: ' + gap.map(r => r.relname).join(', '));

const { rows: rlsTabs } = await c.query(`
  SELECT c.relname AS t, c.relforcerowsecurity AS forced,
    (SELECT count(*)::int FROM pg_policies p WHERE p.schemaname='public' AND p.tablename=c.relname) AS pols
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND c.relkind IN ('r','p') AND c.relrowsecurity`);
ok('no RLS table is a silent deny-all', rlsTabs.every(t => t.pols > 0), '-> ' + rlsTabs.filter(t => !t.pols).map(t => t.t).join(', '));
ok('every RLS table is FORCEd (owner cannot bypass)', rlsTabs.every(t => t.forced), '-> ' + rlsTabs.filter(t => !t.forced).map(t => t.t).join(', '));

const { rows: pols } = await c.query(`SELECT tablename AS t, policyname AS p, qual, with_check FROM pg_policies WHERE schemaname='public'`);
const scoped = (e) => e === null || e.includes('app_current_tenant');
// audit_logs insert policy is WITH CHECK (true) by design (SECURITY DEFINER trigger is the only writer; reads are scoped).
const unscoped = pols.filter(p => !(scoped(p.qual) && scoped(p.with_check)) && !(p.t === 'audit_logs'));
ok('every policy is tenant-scoped (audit insert excepted by design)', unscoped.length === 0,
  '-> ' + unscoped.map(p => p.t + '.' + p.p).join(', '));

// ── 2) Functional isolation ──────────────────────────────────────────────────
const mk = async (slug) => (await c.query(
  'INSERT INTO tenants(name,company,slug,email) VALUES($1,$2,$3,$4) RETURNING id',
  ['T-' + slug, 'co-' + slug, slug, slug + '@t.test'])).rows[0].id;
const A = await mk('rlsA-' + process.pid), B = await mk('rlsB-' + process.pid);

async function asTenant(tid, fn) {
  await c.query('BEGIN');
  await c.query('SET LOCAL ROLE app_user');
  await c.query("SELECT set_config('app.current_tenant_id',$1,true)", [tid]);
  try { return await fn(); } finally { await c.query('COMMIT').catch(async () => c.query('ROLLBACK')); }
}

try {
  await asTenant(A, async () => {
    await c.query("INSERT INTO vendors(tenant_id,name) VALUES($1,'Vendor-A')", [A]);
    await c.query("INSERT INTO projects(tenant_id,name) VALUES($1,'Project-A')", [A]);
    await c.query("INSERT INTO journal_entries(tenant_id,narration) VALUES($1,'JE-A')", [A]);
  });
  await asTenant(B, async () => {
    const n = async (t) => (await c.query(`SELECT count(*)::int c FROM ${t}`)).rows[0].c;
    ok('tenant B sees 0 of A vendors', await n('vendors') === 0);
    ok('tenant B sees 0 of A projects', await n('projects') === 0);
    ok('tenant B sees 0 of A journal_entries', await n('journal_entries') === 0);
    await c.query("INSERT INTO vendors(tenant_id,name) VALUES($1,'Vendor-B')", [B]);
    await c.query('SAVEPOINT sp');
    let forged = false;
    try { await c.query("INSERT INTO vendors(tenant_id,name) VALUES($1,'Forged')", [A]); }
    catch { forged = true; await c.query('ROLLBACK TO sp'); }
    ok('tenant B CANNOT forge tenant A id (RLS WITH CHECK)', forged);
  });
  await asTenant(A, async () => {
    const names = (await c.query('SELECT name FROM vendors ORDER BY name')).rows.map(r => r.name);
    ok('tenant A sees ONLY its own vendor', names.length === 1 && names[0] === 'Vendor-A', '-> ' + JSON.stringify(names));
  });
} catch (e) {
  ok('functional isolation test ran', false, e.message);
}
await c.query('RESET ROLE').catch(() => {});
await c.query('DELETE FROM tenants WHERE id IN ($1,$2)', [A, B]);
await c.end();

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
