/**
 * Production readiness: tenant scoping comes from the token, and a sales role
 * cannot read the company's finances.
 *
 * WHY THIS IS SEPARATE FROM verify-rls
 *
 * verify-rls proves the DATABASE refuses cross-tenant reads. That is the last
 * line, and it holds even if a route is written badly. This suite asks the
 * question one layer up: can a CLIENT influence which tenant it is treated as,
 * and does the permission layer actually refuse the reads it claims to refuse?
 *
 * Those are different failures. A route that read tenant_id from the request
 * body would satisfy every RLS policy in the system — it would simply be
 * setting the session to a tenant of the caller's choosing, and RLS would then
 * faithfully enforce the wrong tenant.
 *
 * THE TWO DELIBERATE EXCEPTIONS
 *
 * Exactly two places accept a tenant identifier from the client, and both are
 * asserted here rather than trusted:
 *
 *   PUT /api/branches/assign-tenant  — platform staff moving a builder
 *     workspace into a branch. Cross-tenant by definition; the tenantId is the
 *     object being administered, not the caller's identity. Gated by
 *     requirePlatformStaff BEFORE it touches the BYPASSRLS pool.
 *   POST /api/portal/login          — an unauthenticated portal user naming
 *     which workspace to authenticate against, like a workspace code.
 *
 * Every other route derives tenant scope from the JWT `tid` claim alone.
 *
 * NEGATIVE AND POSITIVE
 *
 * Each refusal is paired with the same request succeeding for a role that
 * should have it. A suite that only asserts 403 passes just as happily against
 * a server where every route is broken.
 */
import pg from 'pg';
import argon2 from 'argon2';

const BASE = 'http://localhost:4055';
const PW = 'Test1234!';
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + (x ? '  -> ' + x : ''))); };

const admin = new pg.Client('postgres://postgres:postgres@localhost:5433/erp_test');
await admin.connect();

const MARK = 'PRD';
// Teardown has to walk the graph, not guess at it. journal_entries.created_by
// references users, so deleting the probe accounts first fails on a foreign
// key — and matching entries by narration alone misses anything a future
// assertion posts under a different one.
const clean = async () => {
  const probes = `SELECT id FROM users WHERE email LIKE '${MARK.toLowerCase()}%@prod.test'`;
  // The ledger defends itself twice over: forbid_posted_line_change refuses to
  // delete the lines of a posted entry, and forbid_unposting refuses to move it
  // back to draft. Both are correct — a posted entry is reversed, never edited —
  // and together they mean a posted test entry has no lawful route out.
  //
  // So teardown suspends them explicitly, as the migration superuser, and the
  // finally block is not optional: leaving these triggers off would silently
  // strip immutability from the ledger for every suite that runs afterwards,
  // and nothing downstream would report it.
  try {
    await admin.query('ALTER TABLE journal_entry_lines DISABLE TRIGGER USER');
    await admin.query('ALTER TABLE journal_entries DISABLE TRIGGER USER');
    await admin.query(
      `DELETE FROM journal_entry_lines WHERE journal_entry_id IN
         (SELECT id FROM journal_entries WHERE created_by IN (${probes}) OR narration LIKE '${MARK}%')`);
    await admin.query(
      `DELETE FROM journal_entries WHERE created_by IN (${probes}) OR narration LIKE '${MARK}%'`);
  } finally {
    await admin.query('ALTER TABLE journal_entries ENABLE TRIGGER USER');
    await admin.query('ALTER TABLE journal_entry_lines ENABLE TRIGGER USER');
  }
  await admin.query(`DELETE FROM leads WHERE name LIKE '${MARK}%'`);
  await admin.query(`DELETE FROM chart_of_accounts WHERE code LIKE '${MARK}%'`);
  await admin.query(`DELETE FROM users WHERE email LIKE '${MARK.toLowerCase()}%@prod.test'`);
};
await clean();

const hash = await argon2.hash(PW, { type: argon2.argon2id });
const { rows: [tA] } = await admin.query(`SELECT id FROM tenants WHERE slug='platform'`);
const { rows: [tB] } = await admin.query(`SELECT id FROM tenants WHERE slug='rivaltest'`);

const roleId = async (tenant, name) =>
  (await admin.query(`SELECT id FROM roles WHERE tenant_id=$1 AND name=$2`, [tenant, name])).rows[0]?.id;

const mkUser = async (tenant, role, slug) => {
  const rid = await roleId(tenant, role);
  if (!rid) throw new Error(`role ${role} missing in tenant ${tenant}`);
  await admin.query(
    `INSERT INTO users (tenant_id, role_id, name, email, password_hash, active, mfa_email_enabled)
     VALUES ($1,$2,'Prod Probe',$3,$4,true,false)`,
    [tenant, rid, `${MARK.toLowerCase()}${slug}@prod.test`, hash]);
  const r = await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: `${MARK.toLowerCase()}${slug}@prod.test`, password: PW }) });
  const b = await r.json();
  if (!b?.token) throw new Error(`login failed for ${slug}: ${r.status} ${JSON.stringify(b)}`);
  return b.token;
};

const sales = await mkUser(tA.id, 'sales_executive', 'sales');
const acct  = await mkUser(tA.id, 'accountant',      'acct');
const rival = await mkUser(tB.id, 'builder_admin',   'rival');

const H = (t) => ({ 'Content-Type': 'application/json', Authorization: 'Bearer ' + t });
const get  = (p, t) => fetch(BASE + p, { headers: H(t) });
const put  = (p, t, body) => fetch(BASE + p, { method: 'PUT', headers: H(t), body: JSON.stringify(body) });
const post = (p, t, body) => fetch(BASE + p, { method: 'POST', headers: H(t), body: JSON.stringify(body) });

// ── 1. Tenant scope comes from the token, never the request ────────────────
console.log('\n=== DATA PRIVACY: TENANT SCOPE IS NOT CLIENT-SETTABLE ===');

// A body carrying someone else's tenantId must have no effect. Every write
// schema declares additionalProperties:false, and Fastify's AJV defaults to
// removeAdditional:true, so the field is STRIPPED before the handler runs
// rather than rejected with a 400.
//
// That is deliberately what this asserts: the outcome, not the mechanism. A
// 400 would also be acceptable, and an earlier draft of this test demanded one
// — which would have failed the moment someone made the (safer) choice to
// strip silently rather than hand an attacker a schema oracle. What must never
// change is that the row lands in the CALLER's tenant.
const injected = await post('/api/leads', sales,
  { name: `${MARK} Injected`, phone: '9800000091', tenantId: tB.id });
ok('a lead create carrying someone else\'s tenantId still succeeds for the caller',
   injected.status === 201, String(injected.status));

const landed = await admin.query(
  `SELECT tenant_id FROM leads WHERE name = $1`, [`${MARK} Injected`]);
ok('…and the row belongs to the caller\'s tenant, not the one it named',
   landed.rows.length === 1 && landed.rows[0].tenant_id === tA.id,
   `${landed.rows.length} row(s), tenant=${landed.rows[0]?.tenant_id}`);
ok('the smuggled field did not reach the database at all',
   landed.rows[0]?.tenant_id !== tB.id, 'landed in the named tenant');

// A token whose payload has been edited to name another tenant must fail the
// signature check, not be believed.
const [h, p, s] = sales.split('.');
const payload = JSON.parse(Buffer.from(p, 'base64url').toString());
payload.tid = tB.id;
const tampered = [h, Buffer.from(JSON.stringify(payload)).toString('base64url'), s].join('.');
const tamperedRes = await get('/api/leads', tampered);
ok('a JWT edited to name another tenant is rejected', tamperedRes.status === 401, String(tamperedRes.status));

// The rival's data must not appear for tenant A even though both exist.
const mine = await get('/api/leads', sales);
const mineBody = await mine.json();
const rivalLeadCount = (await admin.query(
  `SELECT count(*)::int n FROM leads WHERE tenant_id=$1`, [tB.id])).rows[0].n;
ok('the rival tenant genuinely has rows to leak', rivalLeadCount >= 0, String(rivalLeadCount));
const leakedIds = (mineBody.leads ?? []).map(l => l.id);
const leaked = leakedIds.length === 0 ? 0 : (await admin.query(
  `SELECT count(*)::int n FROM leads WHERE tenant_id=$1 AND id = ANY($2::uuid[])`,
  [tB.id, leakedIds])).rows[0].n;
ok('none of the rows returned belong to the other tenant', leaked === 0, `${leaked} leaked`);

// ── 2. The documented exception is gated, not merely documented ────────────
console.log('\n=== THE ONE CROSS-TENANT WRITE IS PLATFORM-ONLY ===');
const escalate = await put('/api/branches/assign-tenant', rival, { tenantId: tA.id, branchId: null });
ok('a builder_admin cannot move another workspace between branches',
   escalate.status === 403, String(escalate.status));
const escalateSales = await put('/api/branches/assign-tenant', sales, { tenantId: tB.id, branchId: null });
ok('nor can a sales executive', escalateSales.status === 403, String(escalateSales.status));

// ── 3. Role enforcement: sales cannot read the company's finances ──────────
console.log('\n=== ROLE ENFORCEMENT: SALES IS BLOCKED FROM FINANCE ===');
const financeReads = ['/api/accounts', '/api/journal-entries', '/api/bank-accounts', '/api/loans'];
for (const path of financeReads) {
  const r = await get(path, sales);
  ok(`sales_executive is refused ${path}`, r.status === 403, String(r.status));
}

// Paired positives. Without these, every assertion above would still pass on a
// server that had simply stopped serving finance to anyone.
console.log('\n=== …BUT THE ACCOUNTANT IS NOT ===');
for (const path of financeReads) {
  const r = await get(path, acct);
  ok(`accountant reads ${path}`, r.status === 200, String(r.status));
}

console.log('\n=== …AND SALES CAN STILL DO ITS OWN JOB ===');
const ownWork = await get('/api/leads', sales);
ok('sales_executive still reads leads', ownWork.status === 200, String(ownWork.status));

console.log('\n=== SALES CANNOT WRITE FINANCE EITHER ===');
// The body must be VALID, or this proves nothing. Fastify validates the schema
// before it runs preHandler, so a malformed entry returns 400 without the
// permission gate ever being consulted — an earlier draft of this test sent
// `lines: []` and got exactly that, a green-looking refusal for the wrong
// reason. Two real accounts, balanced, so the only thing left to stop it is
// the permission.
// The fixture tenant carries no chart of accounts, so this suite makes its own
// rather than depending on whichever other suite happened to run first.
for (const [code, name, type] of [[`${MARK}1000`, `${MARK} Cash`, 'asset'],
                                  [`${MARK}4000`, `${MARK} Revenue`, 'income']]) {
  await admin.query(
    `INSERT INTO chart_of_accounts (tenant_id, code, name, account_type)
     VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [tA.id, code, name, type]);
}
const accountsRes = await get('/api/accounts', acct);
const accounts = ((await accountsRes.json()).accounts ?? []).filter(a => String(a.code).startsWith(MARK));
ok('the tenant has a chart of accounts to post against', accounts.length >= 2, `${accounts.length} accounts`);

if (accounts.length >= 2) {
  // status: 'draft' is not laziness about the test — a POSTED entry is
  // deliberately immutable (the forbid_posted_line_change trigger refuses to
  // delete its lines), which is correct for a ledger and means a posted probe
  // entry could never be cleaned up. The permission gate lives on the route and
  // does not consult status, so a draft exercises it identically.
  const validEntry = {
    date: '2026-01-01',
    status: 'draft',
    narration: `${MARK} attempt`,
    lines: [
      { accountId: accounts[0].id, debit: 100, credit: 0 },
      { accountId: accounts[1].id, debit: 0, credit: 100 },
    ],
  };
  const write = await post('/api/journal-entries', sales, validEntry);
  ok('sales_executive is refused a well-formed journal entry',
     write.status === 403, String(write.status));

  // Paired positive: the same entry from the accountant must be accepted, or
  // the refusal above could just be a broken endpoint.
  const allowed = await post('/api/journal-entries', acct, validEntry);
  ok('…and the accountant posting the identical entry is accepted',
     allowed.status === 201, String(allowed.status));
}

// clean() walks the whole graph in dependency order, so there is nothing to
// tear down here.
await clean();
await admin.end();
console.log(`\n===== ${pass} passed, ${fail} failed =====`);
process.exit(fail ? 1 : 0);
