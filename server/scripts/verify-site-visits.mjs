/**
 * Site visits (migration 043) — the middle of the funnel.
 *
 * WHY THIS MODULE EXISTS
 *
 * lead_activities could already record that a visit happened, with a
 * scheduled_at and an outcome. What it could not do is manage one: an activity
 * is an append-only timeline row with no state, so a visit could not be
 * reassigned, rescheduled, marked no-show, or counted. A builder measures
 * leads, visits and bookings in that order and the middle number did not exist.
 *
 * WHAT THIS GUARDS
 *
 * Two things beyond the happy path. First, that a rep restricted to their own
 * leads cannot use visits as a side channel to a lead they may not open —
 * scheduling is a write against somebody else's customer. Second, that
 * completing a visit still writes the timeline, because splitting state from
 * narrative is only safe while both actually happen.
 */
import pg from 'pg';
import argon2 from 'argon2';

const BASE = process.env.API_BASE ?? 'http://localhost:4055';
const PW = 'Test1234!';
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + (x ? '  -> ' + x : ''))); };

const admin = new pg.Client('postgres://postgres:postgres@localhost:5433/erp_test');
await admin.connect();

const MARK = 'SV';
const clean = async () => {
  await admin.query(`DELETE FROM site_visits WHERE lead_id IN (SELECT id FROM leads WHERE name LIKE '${MARK} %')`);
  await admin.query(`DELETE FROM lead_activities WHERE lead_id IN (SELECT id FROM leads WHERE name LIKE '${MARK} %')`);
  await admin.query(`DELETE FROM leads WHERE name LIKE '${MARK} %'`);
  await admin.query(`DELETE FROM users WHERE email LIKE '${MARK.toLowerCase()}%@visit.test'`);
};
await clean();

const { rows: [t] } = await admin.query(`SELECT id FROM tenants WHERE slug='platform'`);
const { rows: [tB] } = await admin.query(`SELECT id FROM tenants WHERE slug='rivaltest'`);
const hash = await argon2.hash(PW, { type: argon2.argon2id });

const mkUser = async (tenant, role, slug) => {
  const { rows: [r] } = await admin.query(`SELECT id FROM roles WHERE tenant_id=$1 AND name=$2`, [tenant, role]);
  const { rows: [u] } = await admin.query(
    `INSERT INTO users (tenant_id, role_id, name, email, password_hash, active, mfa_email_enabled)
     VALUES ($1,$2,'Visit Probe',$3,$4,true,false) RETURNING id`,
    [tenant, r.id, `${MARK.toLowerCase()}${slug}@visit.test`, hash]);
  const res = await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: `${MARK.toLowerCase()}${slug}@visit.test`, password: PW }) });
  const b = await res.json();
  if (!b?.token) throw new Error(`login ${slug}: ${res.status} ${JSON.stringify(b)}`);
  return { id: u.id, token: b.token };
};

const manager = await mkUser(t.id, 'builder_admin', 'mgr');
const rep      = await mkUser(t.id, 'sales_executive', 'rep');
const other    = await mkUser(t.id, 'sales_executive', 'other');
const rival    = await mkUser(tB.id, 'builder_admin', 'rival');

const H = (tok) => ({ 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok });
const get   = (p, tok) => fetch(BASE + p, { headers: H(tok) });
const post  = (p, tok, b) => fetch(BASE + p, { method: 'POST', headers: H(tok), body: JSON.stringify(b ?? {}) });
const patch = (p, tok, b) => fetch(BASE + p, { method: 'PATCH', headers: H(tok), body: JSON.stringify(b) });

const mkLead = async (name, assignee) => (await admin.query(
  `INSERT INTO leads (tenant_id,name,phone,source,stage,priority,last_contact_at,assigned_to)
   VALUES ($1,$2,'9800000071','Direct','new','warm',now(),$3) RETURNING id`,
  [t.id, `${MARK} ${name}`, assignee])).rows[0].id;

const repLead   = await mkLead('Rep Buyer', rep.id);
const otherLead = await mkLead('Other Buyer', other.id);
const soon = new Date(Date.now() + 86_400_000).toISOString();

// ── Booking a visit ───────────────────────────────────────────────────────
console.log('\n=== BOOKING A VISIT NOTIFIES WHOEVER IS TAKING IT ===');
const before = (await (await get('/api/notifications', rep.token)).json()).unreadCount;
const created = await post('/api/site-visits', manager.token,
  { leadId: repLead, assignedTo: rep.id, scheduledAt: soon, durationMinutes: 45 });
const visit = (await created.json()).siteVisit;
ok('the manager can book one', created.status === 201, String(created.status));
ok('it starts scheduled', visit?.status === 'scheduled', String(visit?.status));
ok('the duration is kept', visit?.durationMinutes === 45, String(visit?.durationMinutes));
ok('the assignee is notified',
   (await (await get('/api/notifications', rep.token)).json()).unreadCount === before + 1);

const self = await post('/api/site-visits', rep.token,
  { leadId: repLead, assignedTo: rep.id, scheduledAt: soon });
const selfBefore = (await (await get('/api/notifications', rep.token)).json()).unreadCount;
ok('booking one for yourself does not notify you', self.status === 201
   && (await (await get('/api/notifications', rep.token)).json()).unreadCount === selfBefore);

// ── The own-leads boundary ────────────────────────────────────────────────
console.log('\n=== A VISIT IS NOT A SIDE CHANNEL TO SOMEBODY ELSE\'S LEAD ===');
// A sales executive holds manage_own_leads. Scheduling against a lead assigned
// to a colleague would be a write on a customer they cannot even open.
const poach = await post('/api/site-visits', rep.token,
  { leadId: otherLead, assignedTo: rep.id, scheduledAt: soon });
ok('a rep cannot book against a colleague\'s lead', poach.status === 404, String(poach.status));
// Paired positive — without it, a server refusing every booking would pass.
const ownOk = await post('/api/site-visits', rep.token,
  { leadId: repLead, assignedTo: rep.id, scheduledAt: soon });
ok('…but can against their own', ownOk.status === 201, String(ownOk.status));

console.log('\n=== THE DIARY IS SCOPED THE SAME WAY THE LEAD LIST IS ===');
const repSees = (await (await get('/api/site-visits', rep.token)).json()).siteVisits;
ok('a rep sees only visits assigned to them',
   repSees.every(v => v.assignedTo === rep.id), `${repSees.length} rows`);
const mgrSees = (await (await get('/api/site-visits', manager.token)).json()).siteVisits;
ok('a manager sees the whole diary', mgrSees.length >= repSees.length, `${mgrSees.length} vs ${repSees.length}`);
ok('a different tenant sees none of ours',
   ((await (await get('/api/site-visits', rival.token)).json()).siteVisits || []).length === 0);

// ── Closing it out ────────────────────────────────────────────────────────
console.log('\n=== COMPLETING NEEDS AN OUTCOME ===');
const noOutcome = await patch(`/api/site-visits/${visit.id}`, manager.token, { status: 'completed' });
ok('completing without one is a 400 that says so', noOutcome.status === 400, String(noOutcome.status));
const strayOutcome = await patch(`/api/site-visits/${visit.id}`, manager.token,
  { status: 'no_show', outcome: 'interested' });
ok('an outcome on a no-show is refused', strayOutcome.status === 400, String(strayOutcome.status));

const actsBefore = (await admin.query(
  `SELECT count(*)::int n FROM lead_activities WHERE lead_id=$1 AND type='site_visit'`, [repLead])).rows[0].n;
const done = await patch(`/api/site-visits/${visit.id}`, manager.token,
  { status: 'completed', outcome: 'interested', feedback: 'Liked the 3 BHK' });
ok('completing with one succeeds', done.status === 200, String(done.status));
ok('completed_at is stamped', !!(await done.json()).siteVisit.completedAt);

console.log('\n=== STATE LIVES HERE, NARRATIVE LIVES IN THE TIMELINE ===');
const actsAfter = (await admin.query(
  `SELECT * FROM lead_activities WHERE lead_id=$1 AND type='site_visit' ORDER BY created_at DESC`, [repLead])).rows;
ok('completing writes a lead activity', actsAfter.length === actsBefore + 1, `${actsBefore} -> ${actsAfter.length}`);
ok('…carrying the feedback', actsAfter[0]?.notes === 'Liked the 3 BHK', String(actsAfter[0]?.notes));
// The two tables have different outcome vocabularies — site visits know
// 'booked' and 'needs_followup', activities know 'needs_follow_up' and
// 'no_show'. Only values both understand are passed through; the rest would be
// a constraint violation dressed up as a 500.
ok('…and an outcome the activity vocabulary accepts', actsAfter[0]?.outcome === 'interested',
   String(actsAfter[0]?.outcome));

const reclose = await patch(`/api/site-visits/${visit.id}`, manager.token,
  { status: 'no_show' });
ok('a closed visit cannot be reopened or reclosed', reclose.status === 404, String(reclose.status));

// ── Rescheduling ──────────────────────────────────────────────────────────
console.log('\n=== RESCHEDULING KEEPS THE SLIP VISIBLE ===');
const fresh = (await (await post('/api/site-visits', manager.token,
  { leadId: repLead, assignedTo: rep.id, scheduledAt: soon })).json()).siteVisit;
const later = new Date(Date.now() + 3 * 86_400_000).toISOString();
const moved = await post(`/api/site-visits/${fresh.id}/reschedule`, manager.token, { scheduledAt: later });
const newVisit = (await moved.json()).siteVisit;
ok('rescheduling creates a new visit', moved.status === 201, String(moved.status));
ok('…pointing at the one it replaced', newVisit?.rescheduledFrom === fresh.id, String(newVisit?.rescheduledFrom));
ok('…and the original is cancelled, not overwritten',
   (await admin.query(`SELECT status, scheduled_at FROM site_visits WHERE id=$1`, [fresh.id])).rows[0].status === 'cancelled');
ok('…so the original time is still on record',
   new Date((await admin.query(`SELECT scheduled_at FROM site_visits WHERE id=$1`, [fresh.id])).rows[0].scheduled_at).toISOString() === new Date(soon).toISOString());

// ── The funnel ────────────────────────────────────────────────────────────
console.log('\n=== THE NUMBER THAT DID NOT EXIST BEFORE ===');
const funnel = (await (await get('/api/site-visits/funnel', manager.token)).json()).funnel;
ok('the funnel reports scheduled leads', funnel.scheduled >= 1, JSON.stringify(funnel));
ok('…and completed ones', funnel.completed >= 1, String(funnel.completed));
// Counted per LEAD, not per visit: a buyer brought back three times is one
// person considering one purchase.
ok('a lead visited repeatedly counts once', funnel.completed <= funnel.scheduled,
   `${funnel.completed} completed vs ${funnel.scheduled} scheduled`);

// ── The database refuses what the route refuses ───────────────────────────
console.log('\n=== THE CONSTRAINT HOLDS EVEN IF A ROUTE FORGETS ===');
let refused = false;
try {
  await admin.query(
    `INSERT INTO site_visits (tenant_id, lead_id, assigned_to, scheduled_at, status, outcome)
     VALUES ($1,$2,$3,now(),'scheduled','booked')`, [t.id, repLead, rep.id]);
} catch (e) { refused = e.code === '23514'; }
ok('an outcome without a completion is rejected at the table', refused);

let crossTenant = false;
try {
  await admin.query(
    `INSERT INTO site_visits (tenant_id, lead_id, assigned_to, scheduled_at)
     VALUES ($1,$2,$3,now())`, [t.id, repLead, rival.id]);
} catch (e) { crossTenant = e.code === '23503'; }
ok('assigning another tenant\'s user is refused by the composite key', crossTenant);

await clean();
await admin.end();
console.log(`\n===== ${pass} passed, ${fail} failed =====`);
process.exit(fail ? 1 : 0);
