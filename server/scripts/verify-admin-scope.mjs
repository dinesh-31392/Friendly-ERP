/**
 * The administrator's side of project scoping.
 *
 * WHAT THIS IS FOR
 *
 * Migration 061 made HR project-scoped, and 32 assertions prove a posted
 * manager cannot reach another site. But nothing proved the ADMIN half:
 * postings could only be created with SQL, and the screen that tells an
 * administrator what a role grants was a hardcoded table written when the
 * product had four roles.
 *
 * THE ASSERTIONS THAT MATTER
 *
 * A posting is a security control, so it is gated like one: manage_users, the
 * same key as roles. If an HR manager could post herself to another site she
 * would be granting herself access to that site's salaries, which is exactly
 * what the scoping exists to stop — and the scoping would be decorative.
 *
 * And a posting has to WORK end to end: created through the API, it must
 * narrow that person's HR the moment it exists, and widen it again when it is
 * removed. A postings screen that writes rows nothing reads is worse than no
 * screen, because it looks like the job is done.
 *
 * The permission matrix asserts against reality rather than a fixture: every
 * role the workspace actually has, every key it actually grants.
 */
import pg from 'pg';
import argon2 from 'argon2';

const BASE = process.env.API_BASE ?? 'http://localhost:4055';
const PW = 'Test1234!';
const MARK = 'adm' + Math.random().toString(36).slice(2, 7);
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
  [`${MARK} co`, `${MARK}-co`, `${MARK}@adm.test`])).rows[0];
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
  const email = `${MARK}-${slug}@adm.test`;
  const u = (await admin.query(
    `INSERT INTO users (tenant_id, role_id, name, email, password_hash, active)
     VALUES ($1,$2,$3,$4,$5,true) RETURNING id`,
    [tenant.id, role.id, slug, email, await argon2.hash(PW, { type: argon2.argon2id })])).rows[0];
  const token = (await (await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PW }),
  })).json()).token;
  if (!token) throw new Error(`login failed for ${email}`);
  return { userId: u.id, roleId: role.id, token };
}

const get = (t, p) => fetch(BASE + p, { headers: { Authorization: `Bearer ${t}` } });
const send = (t, p, method, body) => fetch(BASE + p, {
  method, headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

const skyline = (await admin.query(
  `INSERT INTO projects (tenant_id, name, city, status) VALUES ($1,'Skyline','Pune','under_construction') RETURNING id`,
  [tenant.id])).rows[0];
const riverfront = (await admin.query(
  `INSERT INTO projects (tenant_id, name, city, status) VALUES ($1,'Riverfront','Nashik','under_construction') RETURNING id`,
  [tenant.id])).rows[0];

const HR_KEYS = ['view_hr', 'manage_hr', 'manage_attendance'];
const boss    = await member('workspace_admin', [...HR_KEYS, 'manage_users', 'manage_settings']);
const hrMgr   = await member('hr_manager', HR_KEYS);
const engineer = await member('site_engineer', ['view_hr', 'manage_attendance']);

await admin.query(
  `INSERT INTO employees (tenant_id, name, type, monthly_salary, project_id, active)
   VALUES ($1,'Skyline Mason','staff',40000,$2,true), ($1,'Riverfront Mason','staff',44000,$3,true)`,
  [tenant.id, skyline.id, riverfront.id]);

// ── postings are a security control ────────────────────────────────────────
console.log('\n=== A POSTING IS GATED LIKE A ROLE, NOT LIKE A PREFERENCE ===');
const selfPost = await send(hrMgr.token, '/api/hr/postings', 'POST',
  { userId: hrMgr.userId, projectId: skyline.id });
ok('an HR manager cannot post herself — that would be granting her own access',
  selfPost.status === 403, String(selfPost.status));

const engPost = await send(engineer.token, '/api/hr/postings', 'POST',
  { userId: engineer.userId, projectId: skyline.id });
ok('nor can a site engineer', engPost.status === 403, String(engPost.status));

const readPostings = await get(hrMgr.token, '/api/hr/postings');
ok('nor even read the postings list', readPostings.status === 403, String(readPostings.status));

// ── the admin can, and it takes effect ─────────────────────────────────────
console.log('\n=== THE ADMIN POSTS SOMEBODY, AND IT NARROWS THEM AT ONCE ===');
const before = (await (await get(hrMgr.token, '/api/employees')).json()).employees ?? [];
ok('unposted, the HR manager sees both crews', before.length === 2, String(before.length));

const created = await send(boss.token, '/api/hr/postings', 'POST',
  { userId: hrMgr.userId, projectId: skyline.id, roleNote: 'HR for this site' });
ok('manage_users may post', created.status === 201, String(created.status));

const after = (await (await get(hrMgr.token, '/api/employees')).json()).employees ?? [];
ok('and she is narrowed to one site immediately — no re-login',
  after.length === 1 && after[0].name === 'Skyline Mason',
  JSON.stringify(after.map(e => e.name)));

const scoped = await (await get(hrMgr.token, '/api/hr/scope')).json();
ok('her own scope endpoint agrees',
  scoped.companyWide === false && scoped.projects?.length === 1,
  JSON.stringify(scoped).slice(0, 100));

// ── the listing an admin screen renders ────────────────────────────────────
console.log('\n=== THE LIST THE ADMIN SCREEN RENDERS ===');
const listed = await (await get(boss.token, '/api/hr/postings')).json();
const row = (listed.postings ?? []).find(p => p.userId === hrMgr.userId);
ok('the posting is listed', !!row, JSON.stringify(listed).slice(0, 100));
ok('with the project NAME, not just an id — a screen shows names',
  row?.projectName === 'Skyline', row?.projectName);
ok('and the person’s name', row?.userName === 'hr_manager', row?.userName);
ok('and the note it was made with', row?.roleNote === 'HR for this site', row?.roleNote);

// ── posting twice is not two postings ──────────────────────────────────────
const again = await send(boss.token, '/api/hr/postings', 'POST',
  { userId: hrMgr.userId, projectId: skyline.id, roleNote: 'Updated note' });
ok('posting the same pair again is accepted', again.status === 201, String(again.status));
const listed2 = await (await get(boss.token, '/api/hr/postings')).json();
ok('and does not create a duplicate',
  (listed2.postings ?? []).filter(p => p.userId === hrMgr.userId).length === 1,
  String((listed2.postings ?? []).filter(p => p.userId === hrMgr.userId).length));
ok('it updates the note instead',
  (listed2.postings ?? []).find(p => p.userId === hrMgr.userId)?.roleNote === 'Updated note');

// ── removing it widens them again ──────────────────────────────────────────
console.log('\n=== REMOVING THE POSTING RESTORES COMPANY-WIDE ===');
const removed = await send(boss.token, `/api/hr/postings/${hrMgr.userId}/${skyline.id}`, 'DELETE');
ok('the admin removes it', removed.status === 204, String(removed.status));
const restored = (await (await get(hrMgr.token, '/api/employees')).json()).employees ?? [];
ok('and she is company-wide again — no posting means no restriction',
  restored.length === 2, String(restored.length));

const gone = await send(boss.token, `/api/hr/postings/${hrMgr.userId}/${skyline.id}`, 'DELETE');
ok('removing it twice is a 404, not a silent success', gone.status === 404, String(gone.status));

// ── the permission matrix ──────────────────────────────────────────────────
console.log('\n=== THE PERMISSION SCREEN READS THE DATABASE, NOT A FIXTURE ===');
const mx = await (await get(boss.token, '/api/permission-matrix')).json();
ok('it returns the catalog', (mx.permissions ?? []).length > 40, String((mx.permissions ?? []).length));
ok('and every role in the workspace', (mx.roles ?? []).length === 3, String((mx.roles ?? []).length));

const mxHr = (mx.roles ?? []).find(r => r.name === 'hr_manager');
ok('an HR manager shows manage_hr', (mxHr?.keys ?? []).includes('manage_hr'));
ok('and NOT manage_hr_all — which is why a posting narrows her',
  !(mxHr?.keys ?? []).includes('manage_hr_all'), JSON.stringify(mxHr?.keys));

const mxEng = (mx.roles ?? []).find(r => r.name === 'site_engineer');
ok('a site engineer shows manage_attendance', (mxEng?.keys ?? []).includes('manage_attendance'));
ok('and NOT manage_hr — the separation the roster screen relies on',
  !(mxEng?.keys ?? []).includes('manage_hr'), JSON.stringify(mxEng?.keys));

ok('manage_hr_all is in the catalog, so the screen can show a column for it',
  (mx.permissions ?? []).some(p => p.key === 'manage_hr_all'));

// A grant made now must appear on the next read. This is the property the
// hardcoded table could not have: it never changed, whatever the database did.
await admin.query(
  `INSERT INTO role_permissions (role_id, permission_key) VALUES ($1,'manage_hr_all')
   ON CONFLICT DO NOTHING`, [hrMgr.roleId]);
const mx2 = await (await get(boss.token, '/api/permission-matrix')).json();
ok('a grant made a second ago is already reflected',
  ((mx2.roles ?? []).find(r => r.name === 'hr_manager')?.keys ?? []).includes('manage_hr_all'));

console.log('\n=== AND IT IS NOT PUBLIC ===');
const nosy = await get(engineer.token, '/api/permission-matrix');
ok('a site engineer cannot read the permission map',
  nosy.status === 403, String(nosy.status));

const auditor = await member('auditor', ['view_audit_log']);
const audited = await get(auditor.token, '/api/permission-matrix');
ok('but an auditor can — reading the map IS an access review',
  audited.status === 200, String(audited.status));

await admin.query('DELETE FROM tenants WHERE id = $1', [tenant.id]);
await admin.end();
console.log(`\n===== ${pass} passed, ${fail} failed =====`);
process.exit(fail ? 1 : 0);
