/**
 * Notifications exist on the server (migration 040).
 *
 * WHAT THIS REPLACES
 *
 * Eight toggles in localStorage, keyed per tenant, read by nothing. There was
 * no table, no route and no sender — the Settings page could promise "notify
 * me when a lead is assigned" and no code anywhere could honour it.
 *
 * THE RULES THAT MATTER
 *
 *   Addressed, not broadcast. A notification belongs to one user, and the
 *   inbox routes scope to app_current_user() rather than to a permission — so
 *   there is no grant anyone could be given that reads another person's inbox.
 *
 *   Absence means enabled. A user who has never opened Settings gets
 *   notified; defaulting to silence is how these systems end up doing nothing.
 *
 *   Same transaction. emit() takes the caller's client, so a notification
 *   about a write that then rolled back cannot exist.
 */
import pg from 'pg';
import argon2 from 'argon2';

const BASE = process.env.API_BASE ?? 'http://localhost:4055';
const PW = 'Test1234!';
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + (x ? '  -> ' + x : ''))); };

const admin = new pg.Client('postgres://postgres:postgres@localhost:5433/erp_test');
await admin.connect();

const MARK = 'NTF';
const clean = async () => {
  const probes = `SELECT id FROM users WHERE email LIKE '${MARK.toLowerCase()}%@ntf.test'`;
  await admin.query(`DELETE FROM notifications WHERE user_id IN (${probes})`);
  await admin.query(`DELETE FROM notification_prefs WHERE user_id IN (${probes})`);
  await admin.query(`DELETE FROM leads WHERE name LIKE '${MARK}%'`);
  await admin.query(`DELETE FROM users WHERE email LIKE '${MARK.toLowerCase()}%@ntf.test'`);
};
await clean();

const { rows: [tA] } = await admin.query(`SELECT id FROM tenants WHERE slug='platform'`);
const { rows: [tB] } = await admin.query(`SELECT id FROM tenants WHERE slug='rivaltest'`);
const hash = await argon2.hash(PW, { type: argon2.argon2id });

const mkUser = async (tenant, role, slug) => {
  const { rows: [r] } = await admin.query(
    `SELECT id FROM roles WHERE tenant_id=$1 AND name=$2`, [tenant, role]);
  const { rows: [u] } = await admin.query(
    `INSERT INTO users (tenant_id, role_id, name, email, password_hash, active, mfa_email_enabled)
     VALUES ($1,$2,'Ntf Probe',$3,$4,true,false) RETURNING id`,
    [tenant, r.id, `${MARK.toLowerCase()}${slug}@ntf.test`, hash]);
  const res = await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: `${MARK.toLowerCase()}${slug}@ntf.test`, password: PW }) });
  const b = await res.json();
  if (!b?.token) throw new Error(`login failed ${slug}: ${res.status} ${JSON.stringify(b)}`);
  return { id: u.id, token: b.token };
};

const manager = await mkUser(tA.id, 'builder_admin', 'mgr');
const rep      = await mkUser(tA.id, 'sales_executive', 'rep');
const rival    = await mkUser(tB.id, 'builder_admin', 'rival');

const H = (t) => ({ 'Content-Type': 'application/json', Authorization: 'Bearer ' + t });
const inbox = async (t, q = '') => {
  const r = await fetch(BASE + '/api/notifications' + q, { headers: H(t) });
  return { status: r.status, body: await r.json().catch(() => null) };
};

// ── A real event produces a real notification ──────────────────────────────
console.log('\n=== ASSIGNING A LEAD NOTIFIES THE ASSIGNEE ===');
const { rows: [lead] } = await admin.query(
  `INSERT INTO leads (tenant_id, name, phone, source, stage, priority, last_contact_at)
   VALUES ($1,$2,'9800000041','Direct','new','warm',now()) RETURNING id`,
  [tA.id, `${MARK} Handover Lead`]);

const before = (await inbox(rep.token)).body.unreadCount;
const assign = await fetch(BASE + `/api/leads/${lead.id}`, {
  method: 'PATCH', headers: H(manager.token), body: JSON.stringify({ assignedTo: rep.id }) });
ok('the reassignment itself succeeds', assign.status === 200, String(assign.status));

const after = await inbox(rep.token);
ok('the assignee has a new unread notification', after.body.unreadCount === before + 1,
   `${before} -> ${after.body.unreadCount}`);
const n = after.body.notifications[0];
ok('…of the right kind', n?.kind === 'new_lead_assigned', String(n?.kind));
ok('…naming the lead', String(n?.title).includes(`${MARK} Handover Lead`), String(n?.title));
ok('…and linking to it', n?.entityType === 'lead' && n?.entityId === lead.id);

console.log('\n=== THE PERSON DOING IT IS NOT NOTIFIED ===');
// Being told about your own action is the most common complaint about systems
// like this, and self-assignment is most reassignments.
const mgrBefore = (await inbox(manager.token)).body.unreadCount;
await fetch(BASE + `/api/leads/${lead.id}`, {
  method: 'PATCH', headers: H(manager.token), body: JSON.stringify({ assignedTo: manager.id }) });
ok('assigning a lead to yourself notifies nobody',
   (await inbox(manager.token)).body.unreadCount === mgrBefore);

// ── Addressing ─────────────────────────────────────────────────────────────
console.log('\n=== AN INBOX IS ADDRESSED, NOT BROADCAST ===');
ok('the manager does not see the rep\'s notification',
   !((await inbox(manager.token)).body.notifications || []).some(x => x.id === n.id));
ok('a different tenant sees nothing of ours',
   ((await inbox(rival.token)).body.notifications || []).length === 0);

// ── Read state ─────────────────────────────────────────────────────────────
console.log('\n=== READ STATE ===');
const mark = await fetch(BASE + `/api/notifications/${n.id}`, { method: 'PATCH', headers: H(rep.token) });
ok('the owner can mark it read', mark.status === 200, String(mark.status));
ok('the badge goes down', (await inbox(rep.token)).body.unreadCount === before);

const steal = await fetch(BASE + `/api/notifications/${n.id}`, { method: 'PATCH', headers: H(manager.token) });
// 404 rather than 403: the endpoint must not confirm an id it will not show.
ok('someone else marking it read gets 404, not 403', steal.status === 404, String(steal.status));

const firstRead = (await admin.query(`SELECT read_at FROM notifications WHERE id=$1`, [n.id])).rows[0].read_at;
await fetch(BASE + `/api/notifications/${n.id}`, { method: 'PATCH', headers: H(rep.token) });
const secondRead = (await admin.query(`SELECT read_at FROM notifications WHERE id=$1`, [n.id])).rows[0].read_at;
ok('re-marking keeps the FIRST read time', String(firstRead) === String(secondRead));

// ── Preferences ────────────────────────────────────────────────────────────
console.log('\n=== PREFERENCES ===');
ok('a user who never opened Settings has no rows', Object.keys(
   (await (await fetch(BASE + '/api/notification-prefs', { headers: H(rep.token) })).json()).prefs).length === 0);

const off = await fetch(BASE + '/api/notification-prefs/new_lead_assigned', {
  method: 'PUT', headers: H(rep.token), body: JSON.stringify({ enabled: false }) });
ok('a toggle can be turned off', off.status === 200, String(off.status));

const quiet = (await inbox(rep.token)).body.unreadCount;
await fetch(BASE + `/api/leads/${lead.id}`, {
  method: 'PATCH', headers: H(manager.token), body: JSON.stringify({ assignedTo: rep.id }) });
ok('a disabled kind is not delivered', (await inbox(rep.token)).body.unreadCount === quiet,
   `${quiet} -> ${(await inbox(rep.token)).body.unreadCount}`);

// Paired positive — without it, a server that delivered nothing would pass.
await fetch(BASE + '/api/notification-prefs/new_lead_assigned', {
  method: 'PUT', headers: H(rep.token), body: JSON.stringify({ enabled: true }) });
await fetch(BASE + `/api/leads/${lead.id}`, {
  method: 'PATCH', headers: H(manager.token), body: JSON.stringify({ assignedTo: manager.id }) });
await fetch(BASE + `/api/leads/${lead.id}`, {
  method: 'PATCH', headers: H(manager.token), body: JSON.stringify({ assignedTo: rep.id }) });
ok('re-enabling delivers again', (await inbox(rep.token)).body.unreadCount === quiet + 1,
   `${quiet} -> ${(await inbox(rep.token)).body.unreadCount}`);

console.log('\n=== READ-ALL ===');
const all = await fetch(BASE + '/api/notifications/read-all', { method: 'POST', headers: H(rep.token) });
ok('read-all succeeds', all.status === 200, String(all.status));
ok('…and the badge is zero', (await inbox(rep.token)).body.unreadCount === 0);

ok('unreadOnly=true returns nothing once all are read',
   ((await inbox(rep.token, '?unreadOnly=true')).body.notifications || []).length === 0);

// ── Isolation at the table ─────────────────────────────────────────────────
console.log('\n=== A NOTIFICATION CANNOT NAME ANOTHER TENANT\'S USER ===');
let refused = false;
try {
  await admin.query(
    `INSERT INTO notifications (tenant_id, user_id, kind, title) VALUES ($1,$2,'x','x')`,
    [tA.id, rival.id]);
} catch (e) { refused = e.code === '23503'; }
ok('the composite foreign key refuses it', refused);

await clean();
await admin.end();
console.log(`\n===== ${pass} passed, ${fail} failed =====`);
process.exit(fail ? 1 : 0);
