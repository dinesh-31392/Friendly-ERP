/**
 * The booking cascade must be atomic, and must work for the role that books.
 *
 * This exists because it did neither. The SPA booked in three calls — create,
 * lock the unit, move the lead — with no transaction across them. A failure
 * after the first left a live booking against a unit still marked `available`,
 * and the catch only raised a toast; it never undid the booking.
 *
 * Worse, PATCH /api/units requires `manage_inventory`, which sales_executive
 * does not hold. So for the role that does most of the booking, step two
 * returned 403 every single time: booking committed, unit stayed on sale,
 * salesperson told it had failed. Retrying hit the partial unique index and
 * produced a confusing 400, leaving the unit unsellable through the UI.
 *
 * Run against erp_test with the API on 4055.
 */
import pg from 'pg';
import argon2 from 'argon2';

const BASE = 'http://localhost:4055';
const PW = 'Test1234!';
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + (x ? '  -> ' + x : ''))); };

const admin = new pg.Client('postgres://postgres:postgres@localhost:5433/erp_test');
await admin.connect();

const MARK = 'BCAS';
async function cleanup() {
  await admin.query(`DELETE FROM lead_activities WHERE lead_id IN (SELECT id FROM leads WHERE name LIKE '${MARK}%')`);
  await admin.query(`DELETE FROM commission_ledger WHERE booking_id IN (SELECT bk.id FROM bookings bk JOIN leads l ON l.id=bk.lead_id WHERE l.name LIKE '${MARK}%')`);
  await admin.query(`DELETE FROM payment_schedules WHERE booking_id IN (SELECT bk.id FROM bookings bk JOIN leads l ON l.id=bk.lead_id WHERE l.name LIKE '${MARK}%')`);
  await admin.query(`DELETE FROM bookings WHERE lead_id IN (SELECT id FROM leads WHERE name LIKE '${MARK}%')`);
  await admin.query(`DELETE FROM leads WHERE name LIKE '${MARK}%'`);
  await admin.query(`DELETE FROM units WHERE unit_code LIKE '${MARK}%'`);
  await admin.query(`DELETE FROM brokers WHERE name LIKE '${MARK}%'`);
  await admin.query(`DELETE FROM users WHERE email LIKE '${MARK.toLowerCase()}%@cascade.test'`);
}
await cleanup();

const { rows: [t] } = await admin.query(`SELECT id FROM tenants LIMIT 1`);
const tenant = t.id;

// A sales_executive: holds create_bookings, NOT manage_inventory.
const { rows: [role] } = await admin.query(
  `INSERT INTO roles (tenant_id, name, is_system) VALUES ($1,'sales_executive',true)
   ON CONFLICT (tenant_id, name) DO UPDATE SET is_system=true RETURNING id`, [tenant]);
for (const k of ['view_dashboard','view_leads','manage_own_leads','add_notes','view_inventory',
                 'view_projects','view_calendar','create_bookings','view_bookings']) {
  await admin.query(`INSERT INTO role_permissions (role_id, permission_key) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [role.id, k]);
}
const perms = (await admin.query(`SELECT permission_key k FROM role_permissions WHERE role_id=$1`, [role.id])).rows.map(r => r.k);

console.log('\n=== PRECONDITION ===');
ok('sales_executive holds create_bookings', perms.includes('create_bookings'));
ok('sales_executive does NOT hold manage_inventory', !perms.includes('manage_inventory'));

const { rows: [user] } = await admin.query(
  `INSERT INTO users (tenant_id, role_id, name, email, password_hash, active)
   VALUES ($1,$2,'Cascade Exec',$3,$4,true) RETURNING id`,
  [tenant, role.id, `${MARK.toLowerCase()}exec@cascade.test`, await argon2.hash(PW, { type: argon2.argon2id })]);

const { rows: [proj] } = await admin.query(
  `INSERT INTO projects (tenant_id, name, city, status)
   VALUES ($1,'${MARK} Project','Pune','under_construction') RETURNING id`, [tenant]);
const { rows: [broker] } = await admin.query(
  `INSERT INTO brokers (tenant_id, name, phone, commission_structure)
   VALUES ($1,'${MARK} Partner','9800000099','{"type":"percentage","value":2}') RETURNING id`, [tenant]);

const mkUnit = async (code) => (await admin.query(
  `INSERT INTO units (tenant_id, project_id, unit_code, unit_type, configuration, floor, area_sqft, base_rate, floor_rise_rate, status)
   VALUES ($1,$2,$3,'apartment','2BHK',1,900,6000,0,'available') RETURNING id`, [tenant, proj.id, code])).rows[0].id;
const mkLead = async (name, brokerId = null) => (await admin.query(
  `INSERT INTO leads (tenant_id, name, phone, stage, assigned_to, broker_id)
   VALUES ($1,$2,'9800000001','new',$3,$4) RETURNING id`, [tenant, name, user.id, brokerId])).rows[0].id;

const login = await fetch(BASE + '/api/auth/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: `${MARK.toLowerCase()}exec@cascade.test`, password: PW }),
});
const { token } = await login.json();
const H = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token };

// ── 1. One call completes the whole cascade ────────────────────────────────
console.log('\n=== CASCADE ===');
const unit1 = await mkUnit(`${MARK}-101`);
const lead1 = await mkLead(`${MARK} Buyer One`);
const r1 = await fetch(BASE + '/api/bookings', { method: 'POST', headers: H,
  body: JSON.stringify({ leadId: lead1, unitId: unit1, amount: 300000, value: 5400000, paymentPlan: '30-70', stage: 'reservation' }) });
const b1 = await r1.json();
ok('a sales executive can book (201)', r1.status === 201, `${r1.status} ${JSON.stringify(b1).slice(0, 90)}`);

const unitAfter = (await admin.query(`SELECT status FROM units WHERE id=$1`, [unit1])).rows[0];
const leadAfter = (await admin.query(`SELECT stage FROM leads WHERE id=$1`, [lead1])).rows[0];
const actAfter = (await admin.query(`SELECT type, notes FROM lead_activities WHERE lead_id=$1`, [lead1])).rows;
ok('unit is locked to booked', unitAfter.status === 'booked', unitAfter.status);
ok('lead advanced to booked', leadAfter.stage === 'booked', leadAfter.stage);
ok('a stage_change activity was logged', actAfter.some(a => a.type === 'stage_change'), JSON.stringify(actAfter));
ok('the activity names the unit', actAfter.some(a => (a.notes || '').includes(`${MARK}-101`)), JSON.stringify(actAfter.map(a => a.notes)));

// ── 2. Broker commission lands in the ledger, not a browser ────────────────
console.log('\n=== COMMISSION ===');
const unit2 = await mkUnit(`${MARK}-102`);
const lead2 = await mkLead(`${MARK} Buyer Two`, broker.id);
const r2 = await fetch(BASE + '/api/bookings', { method: 'POST', headers: H,
  body: JSON.stringify({ leadId: lead2, unitId: unit2, amount: 300000, value: 5000000, paymentPlan: '30-70', stage: 'reservation' }) });
const b2 = await r2.json();
ok('booking with a referring partner (201)', r2.status === 201, `${r2.status}`);
const comm = (await admin.query(`SELECT amount_earned, broker_id FROM commission_ledger WHERE booking_id=$1`, [b2.booking?.id])).rows;
ok('commission written to commission_ledger', comm.length === 1, JSON.stringify(comm));
ok('commission is 2% of consideration (100000)', Number(comm[0]?.amount_earned) === 100000, String(comm[0]?.amount_earned));
ok('credited to the referring partner', comm[0]?.broker_id === broker.id);

// A lead with no partner must not invent one.
const unit3 = await mkUnit(`${MARK}-103`);
const lead3 = await mkLead(`${MARK} Buyer Three`);
const r3 = await fetch(BASE + '/api/bookings', { method: 'POST', headers: H,
  body: JSON.stringify({ leadId: lead3, unitId: unit3, amount: 300000, value: 5000000, paymentPlan: '30-70', stage: 'reservation' }) });
const b3 = await r3.json();
const comm3 = (await admin.query(`SELECT 1 FROM commission_ledger WHERE booking_id=$1`, [b3.booking?.id])).rows;
ok('no partner → no commission invented', comm3.length === 0);

// ── 3. Atomicity: a rejected booking leaves NOTHING behind ─────────────────
console.log('\n=== ATOMICITY ===');
const dupe = await fetch(BASE + '/api/bookings', { method: 'POST', headers: H,
  body: JSON.stringify({ leadId: lead1, unitId: unit1, amount: 1, value: 1, paymentPlan: '30-70', stage: 'reservation' }) });
ok('second booking on a live unit is refused', dupe.status === 400 || dupe.status === 409, String(dupe.status));
const bkCount = (await admin.query(`SELECT count(*)::int n FROM bookings WHERE unit_id=$1`, [unit1])).rows[0].n;
ok('still exactly one booking for that unit', bkCount === 1, String(bkCount));
const actCount = (await admin.query(`SELECT count(*)::int n FROM lead_activities WHERE lead_id=$1 AND type='stage_change'`, [lead1])).rows[0].n;
ok('the rejected attempt logged no activity (rolled back)', actCount === 1, String(actCount));

// ── 4. A sold unit is never downgraded ─────────────────────────────────────
console.log('\n=== SOLD UNITS ===');
const unit4 = await mkUnit(`${MARK}-104`);
await admin.query(`UPDATE units SET status='sold' WHERE id=$1`, [unit4]);
const lead4 = await mkLead(`${MARK} Buyer Four`);
await fetch(BASE + '/api/bookings', { method: 'POST', headers: H,
  body: JSON.stringify({ leadId: lead4, unitId: unit4, amount: 1, value: 1, paymentPlan: '30-70', stage: 'reservation' }) });
const u4 = (await admin.query(`SELECT status FROM units WHERE id=$1`, [unit4])).rows[0];
ok('a sold unit is not downgraded to booked', u4.status === 'sold', u4.status);

await cleanup();
await admin.end();
console.log(`\n===== ${pass} passed, ${fail} failed =====`);
process.exit(fail ? 1 : 0);
