/**
 * One workspace, two sites, two HR managers.
 *
 * WHAT THIS IS FOR
 *
 * A builder runs several projects at once and posts an HR manager to each.
 * Until migration 061 every HR key was company-wide: `manage_hr` let a person
 * read, edit, pay and delete ANY employee in the workspace. Four site managers
 * saw four crews, four sets of salaries and four payrolls between them.
 *
 * THE ASSERTIONS THAT MATTER
 *
 * A manager posted to Skyline sees Skyline's crew and nothing else — not
 * Riverfront's roster, not their attendance, not their leave, not their
 * payroll, and not head office, who are nobody's site crew.
 *
 * And the writes, which is where scoping usually leaks: a route that filters
 * its SELECT and forgets its UPDATE hands the whole company to anyone who
 * knows an id. Every write is asserted separately.
 *
 * THE SAFETY PROPERTY
 *
 * A manager with NO posting stays company-wide. That is what makes the change
 * shippable: every existing user has no rows in user_project_assignments, so nothing
 * narrows until somebody chooses to narrow it. The opposite default would
 * lock every live workspace out of its own HR on upgrade.
 */
import pg from 'pg';
import argon2 from 'argon2';

const BASE = process.env.API_BASE ?? 'http://localhost:4055';
const PW = 'Test1234!';
const MARK = 'hrp' + Math.random().toString(36).slice(2, 7);
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
  [`${MARK} co`, `${MARK}-co`, `${MARK}@hrp.test`])).rows[0];
await admin.query(
  `INSERT INTO schema_definitions (tenant_id, entity, kind, version, is_active, definition)
   VALUES ($1,'lead','pipeline',1,true,$2)
   ON CONFLICT (tenant_id, entity, kind, version) DO UPDATE SET is_active = true`,
  [tenant.id, JSON.stringify(PIPELINE)]);

async function member(slug, perms) {
  const role = (await admin.query(
    `INSERT INTO roles (tenant_id, name, is_system) VALUES ($1,$2,false) RETURNING id`,
    [tenant.id, slug])).rows[0];
  if (perms.length) {
    await admin.query(
      `INSERT INTO role_permissions (role_id, permission_key)
       SELECT $1, k FROM unnest($2::text[]) k ON CONFLICT DO NOTHING`, [role.id, perms]);
  }
  const email = `${MARK}-${slug}@hrp.test`;
  const u = (await admin.query(
    `INSERT INTO users (tenant_id, role_id, name, email, password_hash, active)
     VALUES ($1,$2,$3,$4,$5,true) RETURNING id`,
    [tenant.id, role.id, slug, email, await argon2.hash(PW, { type: argon2.argon2id })])).rows[0];
  const token = (await (await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PW }),
  })).json()).token;
  if (!token) throw new Error(`login failed for ${email}`);
  return { userId: u.id, token };
}

const get = (t, p) => fetch(BASE + p, { headers: { Authorization: `Bearer ${t}` } });
const send = (t, p, method, body) => fetch(BASE + p, {
  method, headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

// ── two sites ──────────────────────────────────────────────────────────────
const skyline = (await admin.query(
  `INSERT INTO projects (tenant_id, name, city, status) VALUES ($1,'Skyline','Pune','under_construction') RETURNING id`,
  [tenant.id])).rows[0];
const riverfront = (await admin.query(
  `INSERT INTO projects (tenant_id, name, city, status) VALUES ($1,'Riverfront','Nashik','under_construction') RETURNING id`,
  [tenant.id])).rows[0];

const HR_KEYS = ['view_hr', 'manage_hr', 'manage_attendance'];
const skyHr   = await member('sky_hr',   HR_KEYS);
const riverHr = await member('river_hr', HR_KEYS);
const headHr  = await member('head_hr',  HR_KEYS);            // no posting → company-wide
const chief   = await member('chief_hr', [...HR_KEYS, 'manage_hr_all']);

await admin.query(
  `INSERT INTO user_project_assignments (tenant_id, user_id, project_id) VALUES ($1,$2,$3), ($1,$4,$5), ($1,$6,$3)`,
  [tenant.id, skyHr.userId, skyline.id, riverHr.userId, riverfront.id, chief.userId]);

// ── three crews ────────────────────────────────────────────────────────────
const mk = async (name, projectId, salary) => (await admin.query(
  `INSERT INTO employees (tenant_id, name, type, monthly_salary, project_id, active)
   VALUES ($1,$2,'staff',$3,$4,true) RETURNING id`,
  [tenant.id, name, salary, projectId])).rows[0];

const skyMason  = await mk('Skyline Mason',  skyline.id,    40000);
const riverMason = await mk('Riverfront Mason', riverfront.id, 44000);
const backOffice = await mk('Head Office Accountant', null,  90000);

const today = new Date().toISOString().slice(0, 10);
for (const e of [skyMason, riverMason, backOffice]) {
  await admin.query(
    `INSERT INTO attendance (tenant_id, employee_id, date, check_in, method)
     VALUES ($1,$2,$3::date,'09:00','manual') ON CONFLICT DO NOTHING`, [tenant.id, e.id, today]);
  await admin.query(
    `INSERT INTO leave_requests (tenant_id, employee_id, type, from_date, to_date, days, status)
     VALUES ($1,$2,'casual',$3::date,$3::date,1,'pending')`, [tenant.id, e.id, today]);
}

// ── the roster ─────────────────────────────────────────────────────────────
console.log('\n=== A SITE HR MANAGER SEES THEIR OWN SITE ===');
const skyEmps = (await (await get(skyHr.token, '/api/employees')).json()).employees ?? [];
const names = skyEmps.map(e => e.name);
ok('Skyline HR sees the Skyline crew', names.includes('Skyline Mason'), JSON.stringify(names));
ok('and NOT the Riverfront crew', !names.includes('Riverfront Mason'), JSON.stringify(names));
ok('and NOT head office, who are nobody’s site crew',
  !names.includes('Head Office Accountant'), JSON.stringify(names));
ok('the response says it is narrowed, so a screen can say so too',
  (await (await get(skyHr.token, '/api/employees')).json()).scopedToProjects === true);

const riverEmps = (await (await get(riverHr.token, '/api/employees')).json()).employees ?? [];
ok('Riverfront HR sees the mirror image',
  riverEmps.length === 1 && riverEmps[0].name === 'Riverfront Mason',
  JSON.stringify(riverEmps.map(e => e.name)));

console.log('\n=== A MANAGER WITH NO POSTING IS COMPANY-WIDE, NOT BLIND ===');
const headEmps = (await (await get(headHr.token, '/api/employees')).json()).employees ?? [];
ok('an unposted HR manager still sees all three', headEmps.length === 3, String(headEmps.length));
ok('and is not flagged as narrowed',
  (await (await get(headHr.token, '/api/employees')).json()).scopedToProjects === false);

const chiefEmps = (await (await get(chief.token, '/api/employees')).json()).employees ?? [];
ok('manage_hr_all beats a posting — the HR head is posted to Skyline and still sees all three',
  chiefEmps.length === 3, String(chiefEmps.length));

// ── attendance and leave ───────────────────────────────────────────────────
console.log('\n=== THE REGISTER AND THE LEAVE BOOK ARE SCOPED TOO ===');
const skyAtt = (await (await get(skyHr.token, '/api/attendance')).json()).attendance ?? [];
ok('one attendance row, not three', skyAtt.length === 1, String(skyAtt.length));
ok('and it is their own person’s',
  skyAtt[0]?.employeeId === skyMason.id, skyAtt[0]?.employeeId);

const skyLeave = (await (await get(skyHr.token, '/api/leave-requests')).json()).leaveRequests ?? [];
ok('one leave request, not three', skyLeave.length === 1, String(skyLeave.length));

// ── the writes, where scoping usually leaks ────────────────────────────────
console.log('\n=== A FILTERED SELECT WITH AN UNFILTERED UPDATE IS NOT SCOPED ===');
const raise = await send(skyHr.token, `/api/employees/${riverMason.id}`, 'PATCH', { monthlySalary: 999999 });
ok('Skyline HR cannot give a Riverfront salary a raise', raise.status === 404, String(raise.status));
const stillPaid = (await admin.query('SELECT monthly_salary FROM employees WHERE id = $1', [riverMason.id])).rows[0];
ok('and the figure in the database did not move',
  Number(stillPaid.monthly_salary) === 44000, String(stillPaid.monthly_salary));

const del = await send(skyHr.token, `/api/employees/${riverMason.id}`, 'DELETE', undefined);
ok('nor delete them', del.status === 404, String(del.status));
ok('and they are still on the payroll',
  (await admin.query('SELECT 1 FROM employees WHERE id = $1', [riverMason.id])).rowCount === 1);

const mark = await send(skyHr.token, '/api/attendance', 'POST', { employeeId: riverMason.id, checkIn: '09:00' });
ok('nor mark them present', mark.status === 404, String(mark.status));

const approve = await send(skyHr.token, `/api/leave-requests/${
  (await admin.query('SELECT id FROM leave_requests WHERE employee_id = $1', [riverMason.id])).rows[0].id
}`, 'PATCH', { status: 'approved' });
ok('nor approve their leave', approve.status === 404, String(approve.status));

const hire = await send(skyHr.token, '/api/employees', 'POST', {
  name: 'Smuggled In', type: 'staff', projectId: riverfront.id, monthlySalary: 10000 });
ok('nor hire onto their site', hire.status === 403, String(hire.status));

const hireHeadOffice = await send(skyHr.token, '/api/employees', 'POST', {
  name: 'Ghost', type: 'staff', monthlySalary: 10000 });
ok('nor into head office, which would be a record they could not then read',
  hireHeadOffice.status === 403, String(hireHeadOffice.status));

const hireOwn = await send(skyHr.token, '/api/employees', 'POST', {
  name: 'New Skyline Hand', type: 'staff', projectId: skyline.id, monthlySalary: 30000 });
ok('but CAN hire onto their own site', hireOwn.status === 201, String(hireOwn.status));

const move = await send(skyHr.token, `/api/employees/${skyMason.id}`, 'PATCH', { projectId: riverfront.id });
ok('nor transfer their own person away, which is a one-way door',
  move.status === 403, String(move.status));

// ── payroll, per project ───────────────────────────────────────────────────
console.log('\n=== EACH SITE PREPARES ITS OWN PAYROLL ===');
const month = today.slice(0, 7);

const skyRun = await (await send(skyHr.token, '/api/hr/payroll/prepare', 'POST',
  { month, projectId: skyline.id, save: true })).json();
ok('Skyline HR prepares a Skyline run', skyRun.saved === true, JSON.stringify(skyRun).slice(0, 120));
ok('covering only Skyline people',
  skyRun.items?.every(i => i.projectId === skyline.id),
  JSON.stringify(skyRun.items?.map(i => i.name)));

const riverRun = await (await send(riverHr.token, '/api/hr/payroll/prepare', 'POST',
  { month, projectId: riverfront.id, save: true })).json();
ok('Riverfront HR prepares its own, same month, no collision',
  riverRun.saved === true, JSON.stringify(riverRun).slice(0, 120));

const skySees = (await (await get(skyHr.token, '/api/payroll-runs')).json()).payrollRuns ?? [];
ok('and Skyline HR sees one run, not two', skySees.length === 1, String(skySees.length));
ok('their own', skySees[0]?.projectId === skyline.id, skySees[0]?.projectId);

const crossRun = await send(skyHr.token, '/api/hr/payroll/prepare', 'POST',
  { month, projectId: riverfront.id, save: true });
ok('Skyline HR cannot prepare Riverfront’s payroll', crossRun.status === 403, String(crossRun.status));

const companyRun = await send(skyHr.token, '/api/hr/payroll/prepare', 'POST', { month, save: true });
ok('nor the company-wide run, which would pay every site at once',
  companyRun.status === 403, String(companyRun.status));

const chiefRun = await (await send(chief.token, '/api/hr/payroll/prepare', 'POST',
  { month, save: true })).json();
ok('the HR head can, and it covers everybody',
  (chiefRun.items ?? []).length === 4, String((chiefRun.items ?? []).length));

const chiefSees = (await (await get(chief.token, '/api/payroll-runs')).json()).payrollRuns ?? [];
ok('three runs now exist for one month — two sites and the company',
  chiefSees.filter(r => r.month === month).length === 3,
  String(chiefSees.filter(r => r.month === month).length));

console.log('\n=== POSTINGS ARE NOT SELF-SERVICE ===');
const selfPost = await send(skyHr.token, '/api/hr/postings', 'POST',
  { userId: skyHr.userId, projectId: riverfront.id });
ok('a site HR manager cannot post themselves to another site',
  selfPost.status === 403, String(selfPost.status));

const scope = await (await get(skyHr.token, '/api/hr/scope')).json();
ok('and the server tells the client what it may show',
  scope.companyWide === false && scope.projects?.length === 1 && scope.projects[0].name === 'Skyline',
  JSON.stringify(scope).slice(0, 120));

await admin.query('DELETE FROM tenants WHERE id = $1', [tenant.id]);
await admin.end();
console.log(`\n===== ${pass} passed, ${fail} failed =====`);
process.exit(fail ? 1 : 0);
