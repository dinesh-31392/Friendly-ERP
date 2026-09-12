/**
 * Who may see what, in HR.
 *
 * WHAT THIS IS FOR
 *
 * Every HR read was gated on view_hr and nothing finer. Three roles hold that
 * key, and one of them is site_engineer — who has it for exactly one reason:
 * to mark a crew register with manage_attendance.
 *
 * So a site engineer could read the monthly salary of every colleague, the
 * free-text reason on every leave request — which is where a medical condition
 * gets written — and every payroll run, name by name, with what each person
 * was paid.
 *
 * THE ASSERTIONS THAT MATTER
 *
 * Pay is visible to manage_hr (the desk that prepares payroll) and to
 * view_audit_log (the auditor, whose job is to read everything). To nobody
 * else, however much of the rest of HR they can see.
 *
 * The roster, attendance and leave DATES stay visible to view_hr, because a
 * person running a site needs to know who is in. It is the money and the
 * medical detail that are withheld.
 *
 * And the other half: everyone can see their OWN record — attendance, leave,
 * and processed payslips — with no HR permission at all. Six of the ten roles
 * hold no HR key, so their own data was in the product and closed to them.
 * That endpoint is scoped by the session, so there is no id to tamper with.
 */
import pg from 'pg';
import argon2 from 'argon2';

const BASE = process.env.API_BASE ?? 'http://localhost:4055';
const PW = 'Test1234!';
const MARK = 'hrs' + Math.random().toString(36).slice(2, 7);
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
  [`${MARK} co`, `${MARK}-co`, `${MARK}@hrs.test`])).rows[0];
await admin.query(
  `INSERT INTO schema_definitions (tenant_id, entity, kind, version, is_active, definition)
   VALUES ($1,'lead','pipeline',1,true,$2)
   ON CONFLICT (tenant_id, entity, kind, version) DO UPDATE SET is_active = true`,
  [tenant.id, JSON.stringify(PIPELINE)]);

/** A user in the ONE tenant, so every check is about permissions, not isolation. */
async function member(slug, perms) {
  const role = (await admin.query(
    `INSERT INTO roles (tenant_id, name, is_system) VALUES ($1,$2,false) RETURNING id`,
    [tenant.id, slug])).rows[0];
  if (perms.length) {
    await admin.query(
      `INSERT INTO role_permissions (role_id, permission_key)
       SELECT $1, k FROM unnest($2::text[]) k ON CONFLICT DO NOTHING`, [role.id, perms]);
  }
  const email = `${MARK}-${slug}@hrs.test`;
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

const get = (token, path) => fetch(BASE + path, { headers: { Authorization: `Bearer ${token}` } });

// The three shapes that matter.
const engineer = await member('site_engineer', ['view_hr', 'manage_attendance']);
const hrManager = await member('hr_manager',  ['view_hr', 'manage_hr', 'manage_attendance']);
const auditor   = await member('auditor',     ['view_hr', 'view_audit_log']);
const salesRep  = await member('sales_exec',  ['view_leads']);

// An employee whose pay is worth protecting, and one who is the sales rep.
const boss = (await admin.query(
  `INSERT INTO employees (tenant_id, name, type, monthly_salary, active)
   VALUES ($1,'Well Paid Person','staff',450000,true) RETURNING id`, [tenant.id])).rows[0];
const repEmp = (await admin.query(
  `INSERT INTO employees (tenant_id, name, type, monthly_salary, active, user_id)
   VALUES ($1,'Sales Rep','staff',60000,true,$2) RETURNING id`,
  [tenant.id, salesRep.userId])).rows[0];

const today = new Date().toISOString().slice(0, 10);
await admin.query(
  `INSERT INTO attendance (tenant_id, employee_id, date, check_in, method)
   VALUES ($1,$2,$3::date,'09:15','manual') ON CONFLICT DO NOTHING`,
  [tenant.id, repEmp.id, today]);
await admin.query(
  `INSERT INTO leave_requests (tenant_id, employee_id, type, from_date, to_date, days, reason, status)
   VALUES ($1,$2,'sick',$3::date,$3::date,1,'Chemotherapy session','approved')`,
  [tenant.id, boss.id, today]);
await admin.query(
  `INSERT INTO payroll_runs (tenant_id, month, status, items)
   VALUES ($1,$2,'processed',$3::jsonb)`,
  [tenant.id, today.slice(0, 7), JSON.stringify([
    { employeeId: boss.id, name: 'Well Paid Person', gross: 450000 },
    { employeeId: repEmp.id, name: 'Sales Rep', gross: 60000 },
  ])]);

// ── the site engineer ──────────────────────────────────────────────────────
console.log('\n=== A SITE ENGINEER MARKS ATTENDANCE, NOT PAYROLL ===');
const engEmps = await (await get(engineer.token, '/api/employees')).json();
const engBoss = (engEmps.employees ?? []).find(e => e.name === 'Well Paid Person');
ok('they can still see the roster', !!engBoss, JSON.stringify((engEmps.employees ?? []).length));
ok('but not what anyone is paid', engBoss?.monthlySalary === null, String(engBoss?.monthlySalary));
ok('and the response says so rather than implying a zero salary',
  engBoss?.payHidden === true, String(engBoss?.payHidden));

const engLeave = await (await get(engineer.token, '/api/leave-requests')).json();
const sick = (engLeave.leaveRequests ?? [])[0];
ok('they see that somebody is off sick', sick?.type === 'sick', sick?.type);
ok('and the dates, which is what a site plan needs', !!sick?.from);
ok('but not the medical reason', (sick?.reason ?? '') === '', sick?.reason);
ok('and it is flagged as withheld, not absent', sick?.reasonHidden === true);

const engPay = await (await get(engineer.token, '/api/payroll-runs')).json();
const engRun = (engPay.payrollRuns ?? [])[0];
ok('they can see a payroll run exists', !!engRun);
ok('but no name-by-name figures', (engRun?.items ?? []).length === 0,
  JSON.stringify(engRun?.items));
ok('while the headcount survives redaction', engRun?.itemCount === 2, String(engRun?.itemCount));

// ── the HR desk ────────────────────────────────────────────────────────────
console.log('\n=== THE HR DESK NEEDS THE FIGURES TO RUN PAYROLL ===');
const hrEmps = await (await get(hrManager.token, '/api/employees')).json();
const hrBoss = (hrEmps.employees ?? []).find(e => e.name === 'Well Paid Person');
ok('manage_hr sees the salary', hrBoss?.monthlySalary === 450000, String(hrBoss?.monthlySalary));
const hrPay = await (await get(hrManager.token, '/api/payroll-runs')).json();
ok('and the whole payroll, name by name',
  ((hrPay.payrollRuns ?? [])[0]?.items ?? []).length === 2,
  JSON.stringify((hrPay.payrollRuns ?? [])[0]?.items?.length));
const hrLeave = await (await get(hrManager.token, '/api/leave-requests')).json();
ok('and the leave reason, which they may need to act on',
  /Chemo/.test((hrLeave.leaveRequests ?? [])[0]?.reason ?? ''));

// Read-your-writes. Redaction that also applies to the writer's own response
// is a bug, not caution: the desk types a salary, and the row it gets back
// says the figure is hidden. A screen that refreshes from the response then
// shows a dash for the number the user just saved.
const created = await (await fetch(BASE + '/api/employees', {
  method: 'POST',
  headers: { Authorization: `Bearer ${hrManager.token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: 'Newly Hired', type: 'staff', monthlySalary: 77000 }),
})).json();
ok('creating an employee returns the salary that was just set',
  created.employee?.monthlySalary === 77000, String(created.employee?.monthlySalary));
ok('and does not flag its own write as withheld',
  created.employee?.payHidden === false, String(created.employee?.payHidden));

const raised = await (await fetch(BASE + `/api/employees/${created.employee.id}`, {
  method: 'PATCH',
  headers: { Authorization: `Bearer ${hrManager.token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ monthlySalary: 88000 }),
})).json();
ok('and a raise reads back at the new figure',
  raised.employee?.monthlySalary === 88000, String(raised.employee?.monthlySalary));

// ── the auditor ────────────────────────────────────────────────────────────
console.log('\n=== AN AUDITOR READS EVERYTHING AND CHANGES NOTHING ===');
const audEmps = await (await get(auditor.token, '/api/employees')).json();
ok('view_audit_log sees pay too — auditing a run without amounts is not auditing',
  (audEmps.employees ?? []).find(e => e.name === 'Well Paid Person')?.monthlySalary === 450000);

// ── everyone sees their own ────────────────────────────────────────────────
console.log('\n=== AND EVERYONE CAN SEE THEIR OWN, WITH NO HR KEY AT ALL ===');
const noHr = await get(salesRep.token, '/api/employees');
ok('a sales rep cannot list employees', noHr.status === 403, String(noHr.status));

const mine = await (await get(salesRep.token, '/api/hr/me')).json();
ok('but can see their own record', mine.employee?.name === 'Sales Rep', mine.employee?.name);
ok('including their own salary — the redaction is about other people',
  mine.employee?.monthlySalary === 60000, String(mine.employee?.monthlySalary));
ok('their own attendance', (mine.attendance ?? []).length === 1, String((mine.attendance ?? []).length));
ok('and their own payslip', (mine.payslips ?? []).length === 1, String((mine.payslips ?? []).length));
ok('which shows their figure', (mine.payslips ?? [])[0]?.gross === 60000,
  String((mine.payslips ?? [])[0]?.gross));
ok('and NOBODY ELSE’S — the run holds the whole company',
  !JSON.stringify(mine.payslips ?? []).includes('450000'),
  JSON.stringify(mine.payslips));

// ── a draft is not a payslip ───────────────────────────────────────────────
console.log('\n=== A DRAFT RUN IS NOT A PAYSLIP ===');
const nextMonth = '2099-01';
await admin.query(
  `INSERT INTO payroll_runs (tenant_id, month, status, items)
   VALUES ($1,$2,'draft',$3::jsonb)`,
  [tenant.id, nextMonth, JSON.stringify([{ employeeId: repEmp.id, name: 'Sales Rep', gross: 99999 }])]);
const mine2 = await (await get(salesRep.token, '/api/hr/me')).json();
ok('a draft run does not reach the employee',
  !(mine2.payslips ?? []).some(p => p.month === nextMonth),
  JSON.stringify((mine2.payslips ?? []).map(p => p.month)));

// ── a user who is not an employee ──────────────────────────────────────────
console.log('\n=== A USER WHO IS NOT AN EMPLOYEE GETS AN ANSWER, NOT AN ERROR ===');
const outsider = await member('outsider', []);
const none = await get(outsider.token, '/api/hr/me');
ok('the call succeeds', none.status === 200, String(none.status));
const noneBody = await none.json();
ok('and says plainly that no record is linked',
  noneBody.employee === null && /No employee record/.test(noneBody.note ?? ''),
  JSON.stringify(noneBody).slice(0, 90));

await admin.query('DELETE FROM tenants WHERE id = $1', [tenant.id]);
await admin.end();
console.log(`\n===== ${pass} passed, ${fail} failed =====`);
process.exit(fail ? 1 : 0);
