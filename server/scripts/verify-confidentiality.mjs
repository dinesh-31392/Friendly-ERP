/**
 * A PRIVACY pass, not a capability pass.
 *
 * The verification suites in this directory mostly ask "can this role do its
 * job". This one asks the opposite and only the opposite: WHAT CAN EACH ROLE
 * SEE THAT IT MUST NOT. Every assertion here is negative — the claim is that
 * data does not arrive, never that an endpoint responded.
 *
 * TWO MECHANISMS, AND WHY THEY ARE LABELLED SEPARATELY
 *
 *   [PERMISSION]  a has_permission() check. Answers "may this role touch this
 *                 endpoint at all".
 *   [ROW SCOPE]   a WHERE clause on the caller's identity. Answers "WHICH rows
 *                 of it".
 *   [RLS]         a database policy. Answers "whose workspace".
 *
 * A permission check proves NOTHING about row scoping. `view_leads` says a
 * sales executive may read leads; it says nothing about whose. Every boundary
 * below is tagged, and every ROW SCOPE boundary is additionally probed for
 * PARAMETER STEERING: can the caller widen their own scope by passing a query
 * string or a body field? That is the failure mode a permission-only audit
 * cannot see, because the permission check passes on the way in.
 *
 * WHAT THIS DELIBERATELY DOES NOT REPEAT
 *
 *   verify-rls.mjs        RLS is enabled and FORCEd on every table with a
 *                         tenant_id, enumerated dynamically — so tables added
 *                         by later migrations are already covered.
 *   verify-portal.mjs     buyer A vs buyer B, and partner vs partner, across
 *                         bookings, receipts, tickets and documents.
 *   verify-hr-scope.mjs   pay redaction for a view_hr-only reader.
 *
 * This file covers what those do not: the statutory identity that arrived with
 * migration 062, sign-in times, advances, pipeline steering, and cross-tenant
 * reads of the three tables added after verify-rls was written.
 */
import pg from 'pg';
import argon2 from 'argon2';

const BASE = process.env.API_BASE ?? 'http://localhost:4055';
const PW = 'Test1234!';
const MARK = 'cnf' + Math.random().toString(36).slice(2, 7);
let pass = 0, fail = 0;
const leaks = [];
const ok = (n, c, x = '') => {
  if (c) { pass++; console.log('  ✓ ' + n); }
  else { fail++; leaks.push(n); console.log('  ✗ ' + n + (x ? '  -> ' + x : '')); }
};

const admin = new pg.Client(process.env.DATABASE_ADMIN_URL
  ?? 'postgres://postgres:postgres@localhost:5433/erp_test');
await admin.connect();

const PIPELINE = { stages: [
  { key: 'new', id: 'new', label: 'New', core: true },
  { key: 'booked', id: 'booked', label: 'Booked', core: true },
  { key: 'lost', id: 'lost', label: 'Lost', core: true },
] };

async function workspace(tag) {
  const t = (await admin.query(
    `INSERT INTO tenants (name, company, slug, email) VALUES ($1,$1,$2,$3) RETURNING id`,
    [`${MARK}${tag}`, `${MARK}-${tag}`, `${MARK}-${tag}@cnf.test`])).rows[0];
  await admin.query(
    `INSERT INTO schema_definitions (tenant_id, entity, kind, version, is_active, definition)
     VALUES ($1,'lead','pipeline',1,true,$2)
     ON CONFLICT (tenant_id, entity, kind, version) DO UPDATE SET is_active = true`,
    [t.id, JSON.stringify(PIPELINE)]);
  return t;
}

async function member(tenantId, slug, perms) {
  const role = (await admin.query(
    `INSERT INTO roles (tenant_id, name, is_system) VALUES ($1,$2,false) RETURNING id`,
    [tenantId, slug])).rows[0];
  if (perms.length) {
    await admin.query(
      `INSERT INTO role_permissions (role_id, permission_key)
       SELECT $1, k FROM unnest($2::text[]) k ON CONFLICT DO NOTHING`, [role.id, perms]);
  }
  const email = `${MARK}-${slug}-${tenantId.slice(0, 4)}@cnf.test`;
  const u = (await admin.query(
    `INSERT INTO users (tenant_id, role_id, name, email, password_hash, active)
     VALUES ($1,$2,$3,$4,$5,true) RETURNING id`,
    [tenantId, role.id, slug, email, await argon2.hash(PW, { type: argon2.argon2id })])).rows[0];
  const token = (await (await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PW }),
  })).json()).token;
  if (!token) throw new Error(`login failed for ${email}`);
  return { userId: u.id, token };
}

const get = (t, p) => fetch(BASE + p, { headers: { Authorization: `Bearer ${t}` } });
const json = async (t, p) => { const r = await get(t, p); return { status: r.status, body: await r.json().catch(() => ({})) }; };
const send = (t, p, method, body) => fetch(BASE + p, {
  method, headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

/** Does this payload contain the secret anywhere, at any depth? */
const contains = (payload, secret) => JSON.stringify(payload ?? {}).includes(String(secret));

// ── the cast ───────────────────────────────────────────────────────────────
const A = await workspace('a');
const B = await workspace('b');

const hrManager = await member(A.id, 'hr_manager',  ['view_hr', 'manage_hr', 'manage_attendance']);
const engineer  = await member(A.id, 'site_eng',    ['view_hr', 'manage_attendance']);
const repA      = await member(A.id, 'rep_a',       ['view_leads', 'manage_own_leads', 'view_dashboard']);
const repB      = await member(A.id, 'rep_b',       ['view_leads', 'manage_own_leads', 'view_dashboard']);
const manager   = await member(A.id, 'sales_mgr',   ['view_leads', 'manage_leads', 'view_brokers']);
const outsider  = await member(B.id, 'outsider',    ['view_hr', 'manage_hr', 'view_leads', 'manage_leads']);

// A person whose identity is worth protecting.
const boss = (await admin.query(
  `INSERT INTO employees (tenant_id, name, type, monthly_salary, active,
                          uan, esic_number, pan, aadhaar_last4, bank_account, bank_ifsc, pt_monthly)
   VALUES ($1,'Well Paid Person','staff',450000,true,
           '100000000009','12345678901234567','ABCDE1234F','7788','50100999888777','HDFC0001234',200)
   RETURNING id`, [A.id])).rows[0];

// The rep is also an employee, so "their own" has something in it.
const repEmp = (await admin.query(
  `INSERT INTO employees (tenant_id, name, type, monthly_salary, active, user_id, bank_account)
   VALUES ($1,'Rep A','staff',60000,true,$2,'11112222333344') RETURNING id`,
  [A.id, repA.userId])).rows[0];

await admin.query(
  `INSERT INTO employee_advances (tenant_id, employee_id, amount, per_month, reason)
   VALUES ($1,$2,90000,10000,'Boss advance'), ($1,$3,5000,0,'Rep advance')`,
  [A.id, boss.id, repEmp.id]);

// Sign-in history for a colleague nobody should be able to read.
await admin.query(
  `INSERT INTO user_sessions (tenant_id, user_id, expires_at, ip, user_agent)
   VALUES ($1,$2, now() + interval '1 day', '203.0.113.9', 'ColleagueBrowser/1.0')`,
  [A.id, hrManager.userId]);

// One lead each, so "another rep's pipeline" is a real thing.
const leadOfB = (await admin.query(
  `INSERT INTO leads (tenant_id, name, phone, email, stage, assigned_to, budget)
   VALUES ($1,'Confidential Prospect','9990001111','prospect@cnf.test','new',$2, 99000000) RETURNING id`,
  [A.id, repB.userId])).rows[0];
await admin.query(
  `INSERT INTO leads (tenant_id, name, phone, stage, assigned_to)
   VALUES ($1,'Rep A Own Lead','9990002222','new',$2)`, [A.id, repA.userId]);

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n=== 1. SALARY [PERMISSION] ===');
const noHr = await get(repA.token, '/api/employees');
ok('a sales executive cannot list employees at all', noHr.status === 403, String(noHr.status));

const engEmps = (await json(engineer.token, '/api/employees')).body;
const engBoss = (engEmps.employees ?? []).find(e => e.name === 'Well Paid Person');
ok('a site engineer sees the roster', !!engBoss);
ok('but no salary anywhere in the payload', !contains(engEmps, 450000),
  JSON.stringify(engBoss).slice(0, 100));

console.log('\n=== 2. BANK AND STATUTORY IDENTITY [PERMISSION] ===');
// New with migration 062 and never probed. A UAN and a bank account are HOW
// somebody is paid; they belong with the salary, not with the roster.
for (const [what, secret] of [
  ['the UAN', '100000000009'],
  ['the ESIC number', '12345678901234567'],
  ['the PAN', 'ABCDE1234F'],
  ['the Aadhaar last four', '7788'],
  ['the bank account', '50100999888777'],
  ['the IFSC', 'HDFC0001234'],
]) {
  ok(`a site engineer never receives ${what}`, !contains(engEmps, secret));
}

const hrEmps = (await json(hrManager.token, '/api/employees')).body;
ok('while the HR desk does — payroll cannot be paid without it',
  contains(hrEmps, '50100999888777') && contains(hrEmps, '100000000009'));

console.log('\n=== 3. ADVANCES [PERMISSION + ROW SCOPE] ===');
const engAdv = await get(engineer.token, '/api/hr/advances');
ok('[PERMISSION] a site engineer cannot list advances', engAdv.status === 403, String(engAdv.status));
const repAdv = await get(repA.token, '/api/hr/advances');
ok('[PERMISSION] nor can a sales executive', repAdv.status === 403, String(repAdv.status));

const mine = (await json(repA.token, '/api/hr/me')).body;
ok('[ROW SCOPE] a person sees their own advance on their own record',
  contains(mine.advances ?? [], 5000));
ok('[ROW SCOPE] and NOT a colleague’s, which is on the same table',
  !contains(mine.advances ?? [], 90000), JSON.stringify(mine.advances));

console.log('\n=== 4. YOUR OWN HR RECORD ONLY [ROW SCOPE] ===');
ok('their own record arrives', mine.employee?.name === 'Rep A', mine.employee?.name);
ok('with their own bank account', contains(mine.employee, '11112222333344'));
ok('and nothing belonging to the well-paid colleague',
  !contains(mine, 450000) && !contains(mine, '50100999888777'));

// PARAMETER STEERING. /api/hr/me takes no id — the scope comes from the
// session — so the probe is that adding one changes nothing.
const steered = (await json(repA.token, `/api/hr/me?userId=${hrManager.userId}&employeeId=${boss.id}`)).body;
ok('[STEERING] passing someone else’s ids in the query string changes nothing',
  steered.employee?.name === 'Rep A' && !contains(steered, 450000),
  steered.employee?.name);

console.log('\n=== 5. COLLEAGUES’ SIGN-IN TIMES [PERMISSION + ROW SCOPE] ===');
const sess = await get(repA.token, '/api/sessions');
ok('[PERMISSION] a rep cannot read the workspace’s sign-in history', sess.status === 403, String(sess.status));

const own = await json(repA.token, '/api/sessions?mine=true');
ok('[ROW SCOPE] but may read their own with no HR key', own.status === 200, String(own.status));
ok('[ROW SCOPE] and every row returned is theirs',
  (own.body.sessions ?? []).every(s => s.userId === repA.userId),
  JSON.stringify((own.body.sessions ?? []).map(s => s.userId)));
ok('none of it is the colleague’s', !contains(own.body, 'ColleagueBrowser'));

// THE STEERING PROBE. `mine=true` skips the permission gate; if the userId
// parameter were still honoured, that combination would read any colleague's
// sessions with no HR permission at all.
const hijack = await json(repA.token, `/api/sessions?mine=true&userId=${hrManager.userId}`);
ok('[STEERING] mine=true cannot be pointed at somebody else',
  hijack.status === 200 && !contains(hijack.body, 'ColleagueBrowser')
    && (hijack.body.sessions ?? []).every(s => s.userId === repA.userId),
  JSON.stringify(hijack.body).slice(0, 120));

const byId = await get(repA.token, `/api/sessions?userId=${hrManager.userId}`);
ok('[PERMISSION] and asking for a colleague without mine=true is refused',
  byId.status === 403, String(byId.status));

console.log('\n=== 6. ANOTHER REP’S PIPELINE [ROW SCOPE] ===');
const aLeads = (await json(repA.token, '/api/leads')).body;
const names = (aLeads.leads ?? []).map(l => l.name);
ok('a rep sees their own lead', names.includes('Rep A Own Lead'), JSON.stringify(names));
ok('and NOT the other rep’s', !names.includes('Confidential Prospect'), JSON.stringify(names));
ok('nor its budget, which is the commercially sensitive part',
  !contains(aLeads, 99000000));

const direct = await get(repA.token, `/api/leads/${leadOfB.id}`);
ok('[ROW SCOPE] fetching it by id directly is refused',
  direct.status === 403 || direct.status === 404, String(direct.status));

// STEERING: the list builds its WHERE from both the own-only clause and the
// query parameter. If the parameter replaced the clause rather than adding to
// it, this would return the other rep's book.
const widened = (await json(repA.token, `/api/leads?assigned_to=${repB.userId}`)).body;
ok('[STEERING] asking for another rep by query parameter returns nothing',
  !(widened.leads ?? []).some(l => l.name === 'Confidential Prospect'),
  JSON.stringify((widened.leads ?? []).map(l => l.name)));

const edited = await send(repA.token, `/api/leads/${leadOfB.id}`, 'PATCH', { name: 'Stolen' });
ok('[ROW SCOPE] and editing it is refused',
  edited.status === 403 || edited.status === 404, String(edited.status));
const stillNamed = (await admin.query('SELECT name FROM leads WHERE id = $1', [leadOfB.id])).rows[0];
ok('the row is untouched', stillNamed.name === 'Confidential Prospect', stillNamed.name);

console.log('\n=== 7. NOTES ON ANOTHER REP’S LEAD [ROW SCOPE] ===');
// A call note is as sensitive as the lead it is about — "spoke to his wife,
// they are stretching to afford it" is the kind of thing that gets typed here.
await admin.query(
  `INSERT INTO lead_activities (tenant_id, lead_id, user_id, type, notes)
   VALUES ($1,$2,$3,'call','Budget stretched, will close at 92L')`,
  [A.id, leadOfB.id, repB.userId]);

const acts = (await json(repA.token, '/api/lead-activities')).body;
ok('a rep does not receive activity on another rep’s lead',
  !contains(acts, 'Budget stretched'), JSON.stringify(acts).slice(0, 120));

const actsById = (await json(repA.token, `/api/lead-activities?leadId=${leadOfB.id}`)).body;
ok('[STEERING] nor by naming that lead directly',
  !contains(actsById, 'Budget stretched'), JSON.stringify(actsById).slice(0, 120));

// The write side. The read is scoped by the LEAD's assignee; if the write is
// not, a rep can put words into a colleague's lead history — and would then
// be unable to read back what they wrote, which is the asymmetry that gives
// the defect away.
const intruded = await send(repA.token, '/api/lead-activities', 'POST',
  { leadId: leadOfB.id, type: 'note', notes: 'INJECTED BY ANOTHER REP' });
ok('and cannot write into it either',
  intruded.status === 403 || intruded.status === 404, String(intruded.status));
const injected = (await admin.query(
  `SELECT count(*)::int c FROM lead_activities WHERE lead_id = $1 AND notes LIKE 'INJECTED%'`,
  [leadOfB.id])).rows[0];
ok('nothing was written to the colleague’s lead history', injected.c === 0, String(injected.c));

// POSITIVE CONTROL. Everything above this line is a negative assertion, and a
// suite made only of negatives is satisfied by a product that denies
// everything to everyone. These two prove the scoping narrowed the boundary
// rather than simply closing the door.
const ownLead = (await admin.query(
  `SELECT id FROM leads WHERE tenant_id = $1 AND assigned_to = $2 LIMIT 1`,
  [A.id, repA.userId])).rows[0];
const legit = await send(repA.token, '/api/lead-activities', 'POST',
  { leadId: ownLead.id, type: 'call', notes: 'Spoke to them, viewing on Saturday' });
ok('[CONTROL] the rep can still log a call on their OWN lead',
  legit.status === 201, String(legit.status));
const readBack = (await json(repA.token, `/api/lead-activities?leadId=${ownLead.id}`)).body;
ok('[CONTROL] and read it back', contains(readBack, 'viewing on Saturday'),
  JSON.stringify(readBack).slice(0, 120));

const mgrOnAny = await send(manager.token, '/api/lead-activities', 'POST',
  { leadId: leadOfB.id, type: 'note', notes: 'Manager review' });
ok('[CONTROL] and a sales manager, who holds manage_leads, may log on any lead',
  mgrOnAny.status === 201, String(mgrOnAny.status));

console.log('\n=== 8. THE AUDIT LOG [PERMISSION] ===');
// The audit log records every action in the workspace, so it is a superset of
// most other boundaries: reading it reads everything through a side door.
const repAudit = await get(repA.token, '/api/audit-logs');
ok('a sales executive cannot read the audit log', repAudit.status === 403, String(repAudit.status));
const hrAudit = await get(hrManager.token, '/api/audit-logs');
ok('nor can the HR desk — manage_hr is not view_audit_log',
  hrAudit.status === 403, String(hrAudit.status));

console.log('\n=== 9. BROKER COMMISSIONS [PERMISSION] ===');
const repPayouts = await get(repA.token, '/api/broker-payouts');
ok('a sales executive cannot read broker payout runs', repPayouts.status === 403, String(repPayouts.status));
const repBrokers = await get(repA.token, '/api/brokers');
ok('nor the broker list', repBrokers.status === 403, String(repBrokers.status));
const mgrPayouts = await get(manager.token, '/api/broker-payouts');
ok('a sales manager holding view_brokers may — that is their desk',
  mgrPayouts.status === 200, String(mgrPayouts.status));

console.log('\n=== 10. ANOTHER WORKSPACE [RLS] ===');
// verify-rls proves the policies exist. This proves the three tables added
// AFTER it was written cannot be read across a tenant through the API.
const xEmp = (await json(outsider.token, '/api/employees')).body;
ok('a full HR manager in workspace B sees none of A’s people',
  !contains(xEmp, 'Well Paid Person') && !contains(xEmp, 450000),
  JSON.stringify((xEmp.employees ?? []).map(e => e.name)));
ok('nor A’s bank details', !contains(xEmp, '50100999888777'));

const xAdv = (await json(outsider.token, '/api/hr/advances')).body;
ok('nor A’s advances (employee_advances, added in 062)',
  !contains(xAdv, 90000), JSON.stringify(xAdv).slice(0, 120));

const xLeads = (await json(outsider.token, '/api/leads')).body;
ok('nor A’s pipeline, with manage_leads in their own workspace',
  !contains(xLeads, 'Confidential Prospect') && !contains(xLeads, 99000000));

const xLead = await get(outsider.token, `/api/leads/${leadOfB.id}`);
ok('and a known lead id from A is not readable from B',
  xLead.status === 403 || xLead.status === 404, String(xLead.status));

const xEmpById = await send(outsider.token, `/api/employees/${boss.id}`, 'PATCH', { monthlySalary: 1 });
ok('nor writable — a known employee id from A cannot be edited from B',
  xEmpById.status === 404 || xEmpById.status === 403, String(xEmpById.status));
const untouched = (await admin.query('SELECT monthly_salary FROM employees WHERE id = $1', [boss.id])).rows[0];
ok('and the salary did not move', Number(untouched.monthly_salary) === 450000,
  String(untouched.monthly_salary));

// ─────────────────────────────────────────────────────────────────────────────
await admin.query('DELETE FROM tenants WHERE id = ANY($1::uuid[])', [[A.id, B.id]]);
await admin.end();

if (leaks.length) {
  console.log('\n----- BOUNDARIES THAT LEAKED -----');
  for (const l of leaks) console.log('  · ' + l);
}
console.log(`\n===== ${pass} passed, ${fail} failed =====`);
process.exit(fail ? 1 : 0);
