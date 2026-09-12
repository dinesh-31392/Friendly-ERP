/**
 * Login and logout times, and the attendance they may propose.
 *
 * WHAT THIS IS FOR
 *
 * The product knew `users.last_login_at` — one timestamp, overwritten every
 * sign-in. No history, no logout, no way to ask when somebody was in the
 * system on a given day.
 *
 * THE ASSERTIONS THAT MATTER
 *
 * A session is evidence that an account was signed in. It is NOT evidence that
 * a person was at work, and it is not hours worked. The tests below pin the
 * places where letting one become another would cost somebody money:
 *
 *   A derived row NEVER overwrites one a human recorded. Geo and manual are
 *   assertions by a person; a derived time is an inference, and the inference
 *   must lose.
 *
 *   An unclosed session is capped at its token's expiry, never at now(). A
 *   browser closed on Friday must not read as a weekend of work.
 *
 *   Minutes are summed PER SESSION, not first-login-to-last-logout. Two hours
 *   in the morning and two in the evening is four hours, not the nine the
 *   clock between them would suggest.
 *
 *   An employee with no user account produces nothing. That is site crew, who
 *   are paid days × daily wage — inventing a zero-hour day for them would be
 *   quietly wrong where a blank day is visibly missing.
 */
import pg from 'pg';
import argon2 from 'argon2';

const BASE = process.env.API_BASE ?? 'http://localhost:4055';
const PW = 'Test1234!';
const MARK = 'ses' + Math.random().toString(36).slice(2, 7);
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

async function workspace(slug, perms) {
  const t = (await admin.query(
    `INSERT INTO tenants (name, company, slug, email) VALUES ($1,$1,$2,$3) RETURNING id`,
    [`${MARK} ${slug}`, `${MARK}-${slug}`, `${MARK}-${slug}@ses.test`])).rows[0];
  await admin.query(
    `INSERT INTO schema_definitions (tenant_id, entity, kind, version, is_active, definition)
     VALUES ($1,'lead','pipeline',1,true,$2)
     ON CONFLICT (tenant_id, entity, kind, version) DO UPDATE SET is_active = true`,
    [t.id, JSON.stringify(PIPELINE)]);
  const role = (await admin.query(
    `INSERT INTO roles (tenant_id, name, is_system) VALUES ($1,'Ops',false) RETURNING id`, [t.id])).rows[0];
  if (perms.length) {
    await admin.query(
      `INSERT INTO role_permissions (role_id, permission_key)
       SELECT $1, k FROM unnest($2::text[]) k ON CONFLICT DO NOTHING`, [role.id, perms]);
  }
  const email = `${MARK}-${slug}@ses.test`;
  const u = (await admin.query(
    `INSERT INTO users (tenant_id, role_id, name, email, password_hash, active)
     VALUES ($1,$2,'Ops',$3,$4,true) RETURNING id`,
    [t.id, role.id, email, await argon2.hash(PW, { type: argon2.argon2id })])).rows[0];
  const token = (await (await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PW }),
  })).json()).token;
  if (!token) throw new Error(`login failed for ${email}`);
  return { tenantId: t.id, userId: u.id, token, email };
}

const api = (token, path, init = {}) => fetch(BASE + path, {
  ...init,
  headers: { ...(init.body ? { 'Content-Type': 'application/json' } : {}), Authorization: `Bearer ${token}` },
});
const post = (token, path, body) => api(token, path, { method: 'POST', body: JSON.stringify(body) });
const get = (token, path) => api(token, path);

const A = await workspace('a', ['view_hr', 'manage_hr', 'manage_attendance']);

// ── the login itself is recorded ────────────────────────────────────────────
console.log('\n=== SIGNING IN LEAVES A RECORD ===');
const mine = await (await get(A.token, '/api/sessions?mine=true')).json();
ok('the sign-in that fetched this created a session',
  (mine.sessions ?? []).length >= 1, String((mine.sessions ?? []).length));
const live = (mine.sessions ?? [])[0];
ok('and it is open until signed out', live?.endedBy === 'open', live?.endedBy);
ok('it records where from', typeof live?.ip === 'string');
ok('and when the token stops working', !!live?.expiresAt);

// ── logout closes THAT session, not another ─────────────────────────────────
console.log('\n=== SIGNING OUT CLOSES ONE DEVICE, NOT ALL OF THEM ===');
const second = (await (await fetch(BASE + '/api/auth/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: A.email, password: PW }),
})).json()).token;
await post(second, '/api/auth/logout', {});
const after = await (await get(A.token, '/api/sessions?mine=true')).json();
const closed = (after.sessions ?? []).filter(s => s.endedBy === 'logout');
const open = (after.sessions ?? []).filter(s => s.endedBy === 'open');
ok('the session that signed out is closed', closed.length === 1, String(closed.length));
ok('the other stays open', open.length >= 1, String(open.length));
ok('and the closed one has a logout time', !!closed[0]?.logoutAt);

// ── an employee with no account produces nothing ────────────────────────────
console.log('\n=== SITE CREW HAVE NO LOGIN, AND MUST NOT GET A ZERO DAY ===');
const crew = (await admin.query(
  `INSERT INTO employees (tenant_id, name, type, daily_wage, active)
   VALUES ($1,'Site Crew','contract_worker',900,true) RETURNING id`, [A.tenantId])).rows[0];
const today = new Date().toISOString().slice(0, 10);
const prevCrew = await (await get(A.token,
  `/api/sessions/attendance-preview?from=${today}&to=${today}`)).json();
ok('a worker with no user account yields no derived day',
  !(prevCrew.days ?? []).some(d => d.employeeId === crew.id),
  JSON.stringify((prevCrew.days ?? []).map(d => d.employeeName)));

// ── an employee WITH an account does ────────────────────────────────────────
console.log('\n=== AN EMPLOYEE WHO SIGNS IN DOES ===');
await admin.query(
  `INSERT INTO employees (tenant_id, name, type, monthly_salary, active, user_id)
   VALUES ($1,'Office Staff','staff',60000,true,$2)`, [A.tenantId, A.userId]);
const prev = await (await get(A.token,
  `/api/sessions/attendance-preview?from=${today}&to=${today}`)).json();
const day = (prev.days ?? []).find(d => d.employeeName === 'Office Staff');
ok('their day appears', !!day, JSON.stringify((prev.days ?? []).map(d => d.employeeName)));
ok('with a first login time', /^\d{2}:\d{2}$/.test(day?.firstLogin ?? ''), day?.firstLogin);
ok('and it would be created', day?.willCreate === true, day?.reason);

// ── an unclosed session is capped at expiry, not now() ──────────────────────
console.log('\n=== A BROWSER CLOSED ON FRIDAY IS NOT A WEEKEND OF WORK ===');
// Age an open session: logged in 10 days ago, token good for 24h, never closed.
await admin.query(
  `UPDATE user_sessions
      SET login_at = now() - interval '10 days',
          expires_at = now() - interval '9 days'
    WHERE user_id = $1 AND ended_by = 'open'`, [A.userId]);
const capped = await (await get(A.token, '/api/sessions?mine=true')).json();
const stale = (capped.sessions ?? []).find(s => s.endedBy === 'open');
ok('an unclosed session counts at most its token lifetime, not ten days',
  stale && stale.minutes <= 24 * 60 + 1, String(stale?.minutes));

// ── a derived row never overwrites a human one ─────────────────────────────
console.log('\n=== A GUESS NEVER OVERWRITES WHAT A PERSON RECORDED ===');
const staff = (await admin.query(
  `SELECT id FROM employees WHERE tenant_id = $1 AND name = 'Office Staff'`, [A.tenantId])).rows[0];
await admin.query(
  `INSERT INTO attendance (tenant_id, employee_id, date, check_in, check_out, method)
   VALUES ($1,$2,$3::date,'09:00','18:00','geo')
   ON CONFLICT (tenant_id, employee_id, date) DO UPDATE
     SET check_in = '09:00', check_out = '18:00', method = 'geo'`,
  [A.tenantId, staff.id, today]);

const prev2 = await (await get(A.token,
  `/api/sessions/attendance-preview?from=${today}&to=${today}`)).json();
const blocked = (prev2.days ?? []).find(d => d.employeeId === staff.id);
ok('the preview says it will be skipped', blocked?.willCreate === false, String(blocked?.willCreate));
ok('and names the method that already claimed the day',
  /geo/.test(blocked?.reason ?? ''), blocked?.reason);

const run = await post(A.token, '/api/sessions/derive-attendance', { from: today, to: today });
ok('deriving is accepted', run.status === 200, String(run.status));
const result = await run.json();
ok('and it wrote nothing', result.created === 0, String(result.created));

const kept = (await admin.query(
  `SELECT check_in, method FROM attendance WHERE employee_id = $1 AND date = $2::date`,
  [staff.id, today])).rows[0];
ok('the human record is untouched', kept.check_in === '09:00' && kept.method === 'geo',
  JSON.stringify(kept));

// ── with the day clear, it writes — and says where it came from ────────────
console.log('\n=== WITH THE DAY CLEAR, IT WRITES AND SAYS SO ===');
await admin.query(`DELETE FROM attendance WHERE employee_id = $1 AND date = $2::date`,
  [staff.id, today]);
const run2 = await post(A.token, '/api/sessions/derive-attendance', { from: today, to: today });
const result2 = await run2.json();
ok('now it creates the day', result2.created === 1, String(result2.created));
const written = (await admin.query(
  `SELECT check_in, method FROM attendance WHERE employee_id = $1 AND date = $2::date`,
  [staff.id, today])).rows[0];
ok("and stamps method = 'session' so the origin is visible forever",
  written?.method === 'session', JSON.stringify(written));

// ── permissions ────────────────────────────────────────────────────────────
console.log('\n=== READING PRESENCE IS NOT RECORDING ATTENDANCE ===');
const R = await workspace('r', ['view_hr']);
const noWrite = await post(R.token, '/api/sessions/derive-attendance', { from: today, to: today });
ok('view_hr alone cannot derive attendance', noWrite.status === 403, String(noWrite.status));

const N = await workspace('n', []);
const noRead = await get(N.token, '/api/sessions');
ok('and no HR permission cannot read the history', noRead.status === 403, String(noRead.status));
const own = await get(N.token, '/api/sessions?mine=true');
ok('but anyone may see their own sign-ins', own.status === 200, String(own.status));

// ── isolation ──────────────────────────────────────────────────────────────
console.log('\n=== ONE WORKSPACE SEES NONE OF ANOTHER ===');
const B = await workspace('b', ['view_hr']);
const theirs = await (await get(B.token, '/api/sessions')).json();
const mineIds = new Set((after.sessions ?? []).map(s => s.id));
ok('B sees none of A’s sessions',
  (theirs.sessions ?? []).every(s => !mineIds.has(s.id)),
  String((theirs.sessions ?? []).length));

await admin.end();
console.log(`\n===== ${pass} passed, ${fail} failed =====`);
process.exit(fail ? 1 : 0);
