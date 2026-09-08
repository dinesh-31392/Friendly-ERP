/**
 * Can each role actually see their own report?
 *
 * THE QUESTION, AND WHY IT IS NOT THE ONE THE OTHER SUITES ASK
 *
 * verify-confidentiality asks what a role must NOT see. This asks the opposite
 * and it is not the same question inverted: a product where every role sees
 * NOTHING passes every negative assertion ever written. A permission audit
 * cannot tell a correctly-empty dashboard from a broken one.
 *
 * The SPA Dashboard has no server endpoint — every tile is derived client-side
 * from the same list feeds the pages use. So "what does this role's dashboard
 * show" is exactly "what do these feeds return for this role", and that is
 * checkable here.
 *
 * TWO FAILURES, AND THE SECOND IS THE ONE THAT HIDES
 *
 *   too much   a feed returns rows the role should not have. Covered
 *              thoroughly elsewhere; a few spot checks remain here because
 *              this is where the counts are compared side by side.
 *   too little a role opens their dashboard and every tile reads zero. Nothing
 *              errors, nothing leaks, and the role looks unbuilt. A telecaller
 *              whose whole job is working enquiries had no lead assigned to
 *              them in the demo workspace, so their dashboard was empty and
 *              there was no way to tell that from a broken query.
 *
 * AND THE BOUNDARY MUST BE VISIBLE, NOT MERELY PRESENT
 *
 * Every lead used to belong to one rep, so a sales executive holding
 * manage_own_leads and a sales manager holding manage_leads saw the same seven
 * rows. The scoping worked; nobody could see that it did, and a regression to
 * "everyone sees everything" would have looked identical. The counts have to
 * DIFFER for the assertion to mean anything.
 */
import pg from 'pg';
import argon2 from 'argon2';

const BASE = process.env.API_BASE ?? 'http://localhost:4055';
const PW = 'Test1234!';
const MARK = 'rdb' + Math.random().toString(36).slice(2, 7);
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + (x ? '  -> ' + x : ''))); };

const admin = new pg.Client(process.env.DATABASE_ADMIN_URL
  ?? 'postgres://postgres:postgres@localhost:5433/erp_test');
await admin.connect();

const PIPELINE = { stages: [
  { key: 'new', id: 'new', label: 'New', core: true },
  { key: 'booked', id: 'booked', label: 'Booked', core: true },
  { key: 'lost', id: 'lost', label: 'Lost', core: true },
] };

const tenant = (await admin.query(
  `INSERT INTO tenants (name, company, slug, email) VALUES ($1,$1,$2,$3) RETURNING id`,
  [`${MARK} co`, `${MARK}-co`, `${MARK}@rdb.test`])).rows[0];
await admin.query(
  `INSERT INTO schema_definitions (tenant_id, entity, kind, version, is_active, definition)
   VALUES ($1,'lead','pipeline',1,true,$2)
   ON CONFLICT (tenant_id, entity, kind, version) DO UPDATE SET is_active = true`,
  [tenant.id, JSON.stringify(PIPELINE)]);

async function member(slug, perms) {
  const role = (await admin.query(
    `INSERT INTO roles (tenant_id, name, is_system) VALUES ($1,$2,false) RETURNING id`,
    [tenant.id, slug])).rows[0];
  await admin.query(
    `INSERT INTO role_permissions (role_id, permission_key)
     SELECT $1, k FROM unnest($2::text[]) k ON CONFLICT DO NOTHING`, [role.id, perms]);
  const email = `${MARK}-${slug}@rdb.test`;
  const u = (await admin.query(
    `INSERT INTO users (tenant_id, role_id, name, email, password_hash, active)
     VALUES ($1,$2,$3,$4,$5,true) RETURNING id`,
    [tenant.id, role.id, slug, email, await argon2.hash(PW, { type: argon2.argon2id })])).rows[0];
  const token = (await (await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PW }),
  })).json()).token;
  if (!token) throw new Error(`login failed for ${email}`);
  return { userId: u.id, token, slug };
}

/** How many rows a feed returns, or 'denied'. This IS the dashboard tile. */
async function feed(who, path) {
  const r = await fetch(BASE + path, { headers: { Authorization: `Bearer ${who.token}` } });
  if (r.status === 403) return 'denied';
  if (!r.ok) return `HTTP${r.status}`;
  const body = await r.json().catch(() => ({}));
  for (const k of Object.keys(body)) if (Array.isArray(body[k])) return body[k].length;
  return null;
}

// ── the cast, with the real production grants for each role ────────────────
const salesMgr = await member('sales_manager',
  ['view_dashboard', 'view_leads', 'manage_leads', 'assign_leads', 'view_calendar', 'view_inventory']);
const salesExec = await member('sales_executive',
  ['view_dashboard', 'view_leads', 'manage_own_leads', 'view_calendar', 'view_inventory']);
const telecaller = await member('telecaller',
  ['view_dashboard', 'view_leads', 'manage_own_leads', 'view_calendar']);
const hrMgr = await member('hr_manager',
  ['view_dashboard', 'view_hr', 'manage_hr', 'manage_attendance', 'view_calendar']);
// Finance work is dated work — month-end close, GSTR-1 on the 11th, TDS on the
// 7th — and crm_tasks has always accepted a 'payment' category this role could
// not open. Granted in migration 066; asserted here so the four places that
// define role grants cannot drift back out of step.
const accountant = await member('accountant',
  ['view_dashboard', 'view_accounts', 'manage_accounts', 'view_calendar']);

const project = (await admin.query(
  `INSERT INTO projects (tenant_id, name, city, status)
   VALUES ($1,'Site A','Pune','under_construction') RETURNING id`, [tenant.id])).rows[0];

// Work SPLIT between two front-line people. One owner for everything is the
// shape that made the boundary invisible.
for (const [name, owner] of [
  ['Exec Lead One', salesExec], ['Exec Lead Two', salesExec], ['Exec Lead Three', salesExec],
  ['Caller Lead One', telecaller], ['Caller Lead Two', telecaller],
]) {
  await admin.query(
    `INSERT INTO leads (tenant_id, name, phone, stage, assigned_to)
     VALUES ($1,$2,'98200'||floor(random()*100000)::text,'new',$3)`,
    [tenant.id, name, owner.userId]);
}
for (const who of [salesExec, telecaller, hrMgr, accountant]) {
  await admin.query(
    `INSERT INTO crm_tasks (tenant_id, user_id, title, created_by)
     VALUES ($1,$2,$3,$2)`, [tenant.id, who.userId, `${who.slug} task`]);
}
await admin.query(
  `INSERT INTO employees (tenant_id, name, type, monthly_salary, project_id, active)
   VALUES ($1,'Crew Member','staff',40000,$2,true)`, [tenant.id, project.id]);

// ── every role has something on their dashboard ────────────────────────────
console.log('\n=== NO ROLE OPENS AN EMPTY DASHBOARD ===');
// The failure this catches is silent: nothing errors, every tile reads zero,
// and the role looks unbuilt rather than unpopulated.
for (const [who, path, what] of [
  [salesExec,  '/api/leads',     'their pipeline'],
  [telecaller, '/api/leads',     'their call list'],
  [salesMgr,   '/api/leads',     'the whole pipeline'],
  [salesExec,  '/api/crm-tasks', 'their task queue'],
  [telecaller, '/api/crm-tasks', 'their task queue'],
  [hrMgr,      '/api/employees', 'their roster'],
]) {
  const n = await feed(who, path);
  ok(`${who.slug} sees ${what} — ${n} row(s)`, typeof n === 'number' && n > 0, String(n));
}

// ── and the boundary between them is VISIBLE ───────────────────────────────
console.log('\n=== THE OWN-VS-ALL BOUNDARY SHOWS IN THE NUMBERS ===');
const execLeads = await feed(salesExec, '/api/leads');
const callerLeads = await feed(telecaller, '/api/leads');
const mgrLeads = await feed(salesMgr, '/api/leads');

ok('the executive sees only their own', execLeads === 3, String(execLeads));
ok('the telecaller only theirs', callerLeads === 2, String(callerLeads));
ok('the manager sees every lead in the workspace', mgrLeads === 5, String(mgrLeads));
// The assertion that would have caught the demo workspace: if one person owns
// everything, all three of these are equal and a regression to "everyone sees
// everything" is indistinguishable from correct scoping.
ok('and the three counts DIFFER, so correct scoping is distinguishable from none',
  execLeads !== mgrLeads && callerLeads !== mgrLeads && execLeads !== callerLeads,
  `${execLeads}/${callerLeads}/${mgrLeads}`);
ok('the two front-line counts add up to the manager’s — nothing is lost between them',
  execLeads + callerLeads === mgrLeads, `${execLeads}+${callerLeads} vs ${mgrLeads}`);

console.log('\n=== A TASK QUEUE IS PERSONAL ===');
const execTasks = await feed(salesExec, '/api/crm-tasks');
const callerTasks = await feed(telecaller, '/api/crm-tasks');
ok('each front-line person sees exactly their own task',
  execTasks === 1 && callerTasks === 1, `${execTasks}/${callerTasks}`);
ok('and the manager, who sees all leads, sees every task',
  await feed(salesMgr, '/api/crm-tasks') === 4,
  String(await feed(salesMgr, '/api/crm-tasks')));

// Migration 066. This assertion is the one that would have caught the gap: the
// accountant's task existed and the role could not read it back, which is a row
// nobody can open rather than an empty queue.
const acctTasks = await feed(accountant, '/api/crm-tasks');
ok('an accountant can open their own dated work — close, GST, TDS',
  acctTasks === 1, String(acctTasks));
ok('and still cannot see the sales pipeline',
  await feed(accountant, '/api/leads') === 'denied');

console.log('\n=== A ROLE IS NOT SHOWN A MODULE IT DOES NOT RUN ===');
// Refused, not empty. A zero would be a claim — "you have no employees" —
// where the truth is "this is not your module", and a dashboard that renders
// the tile anyway teaches the reader something false.
for (const [who, path, what] of [
  [salesExec,  '/api/employees',    'the HR roster'],
  [telecaller, '/api/employees',    'the HR roster'],
  [hrMgr,      '/api/leads',        'the sales pipeline'],
  [telecaller, '/api/payroll-runs', 'payroll'],
]) {
  ok(`${who.slug} is refused ${what} rather than shown an empty one`,
    await feed(who, path) === 'denied');
}

await admin.query('DELETE FROM tenants WHERE id = $1', [tenant.id]);
await admin.end();
console.log(`\n===== ${pass} passed, ${fail} failed =====`);
process.exit(fail ? 1 : 0);
