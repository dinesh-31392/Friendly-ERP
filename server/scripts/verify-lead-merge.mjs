/** Merging duplicate leads must carry the timeline across, not destroy it. */
import pg from 'pg';
import argon2 from 'argon2';

const BASE = 'http://localhost:4055';
const PW = 'Test1234!';
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + (x ? '  -> ' + x : ''))); };

const admin = new pg.Client('postgres://postgres:postgres@localhost:5433/erp_test');
await admin.connect();
const MARK = 'MRG';
const clean = async () => {
  await admin.query(`DELETE FROM lead_activities WHERE lead_id IN (SELECT id FROM leads WHERE name LIKE '${MARK}%')`);
  await admin.query(`DELETE FROM leads WHERE name LIKE '${MARK}%'`);
  await admin.query(`DELETE FROM users WHERE email LIKE '${MARK.toLowerCase()}%@merge.test'`);
  await admin.query(`DELETE FROM role_permissions WHERE role_id IN (SELECT id FROM roles WHERE name LIKE '${MARK}%')`);
  await admin.query(`DELETE FROM roles WHERE name LIKE '${MARK}%'`);
};
await clean();

const { rows: [t] } = await admin.query(`SELECT id FROM tenants LIMIT 1`);
const { rows: [role] } = await admin.query(
  `INSERT INTO roles (tenant_id, name, is_system) VALUES ($1,'${MARK}_mgr',false)
   ON CONFLICT (tenant_id, name) DO UPDATE SET is_system=false RETURNING id`, [t.id]);
for (const k of ['view_leads', 'manage_leads', 'view_dashboard']) {
  await admin.query(`INSERT INTO role_permissions (role_id, permission_key) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [role.id, k]);
}
await admin.query(
  `INSERT INTO users (tenant_id, role_id, name, email, password_hash, active) VALUES ($1,$2,'Merge Mgr',$3,$4,true)`,
  [t.id, role.id, `${MARK.toLowerCase()}m@merge.test`, await argon2.hash(PW, { type: argon2.argon2id })]);

const lr = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: `${MARK.toLowerCase()}m@merge.test`, password: PW }) });
const { token } = await lr.json();
const H = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token };

const mkLead = async (n) => (await admin.query(
  `INSERT INTO leads (tenant_id, name, phone, stage) VALUES ($1,$2,'9800000020','new') RETURNING id`, [t.id, n])).rows[0].id;
const primary = await mkLead(`${MARK} Primary`);
const dupe = await mkLead(`${MARK} Duplicate`);
for (const n of ['first call', 'site visit done']) {
  await fetch(BASE + '/api/lead-activities', { method: 'POST', headers: H,
    body: JSON.stringify({ leadId: dupe, type: 'note', notes: `${MARK} ${n}` }) });
}

const before = (await admin.query(`SELECT count(*)::int n FROM lead_activities WHERE lead_id=$1`, [dupe])).rows[0].n;
ok('the duplicate has a timeline to lose', before === 2, String(before));

const r = await fetch(BASE + '/api/lead-activities/reassign', { method: 'POST', headers: H,
  body: JSON.stringify({ fromLeadId: dupe, toLeadId: primary }) });
const body = await r.json();
ok('reassign succeeds (200)', r.status === 200, `${r.status} ${JSON.stringify(body)}`);
ok('it reports what it moved', body?.moved === 2, String(body?.moved));

const onPrimary = (await admin.query(`SELECT count(*)::int n FROM lead_activities WHERE lead_id=$1`, [primary])).rows[0].n;
ok('the history is on the surviving lead', onPrimary === 2, String(onPrimary));

// Now delete the duplicate, as the merge does — the history must survive.
await fetch(BASE + `/api/leads/${dupe}`, { method: 'DELETE', headers: H });
const after = (await admin.query(`SELECT count(*)::int n FROM lead_activities WHERE lead_id=$1`, [primary])).rows[0].n;
ok('it survives deleting the duplicate', after === 2, String(after));

const self = await fetch(BASE + '/api/lead-activities/reassign', { method: 'POST', headers: H,
  body: JSON.stringify({ fromLeadId: primary, toLeadId: primary }) });
ok('a lead cannot be merged into itself (400)', self.status === 400, String(self.status));

const ghost = await fetch(BASE + '/api/lead-activities/reassign', { method: 'POST', headers: H,
  body: JSON.stringify({ fromLeadId: primary, toLeadId: '00000000-0000-0000-0000-000000000001' }) });
ok('an unknown lead is a 404, not a silent no-op', ghost.status === 404, String(ghost.status));

await clean();
await admin.end();
console.log(`\n===== ${pass} passed, ${fail} failed =====`);
process.exit(fail ? 1 : 0);
