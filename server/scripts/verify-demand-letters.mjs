/**
 * Demand letters and interest on delay (migration 041).
 *
 * WHY THIS IS THE CAREFUL ONE
 *
 * Every other suite asserts access. This one asserts ARITHMETIC, against a
 * document a builder sends a buyer and both sides quote in a dispute. A demand
 * for the wrong number is not a bug someone files — it is a letter that has
 * already gone out.
 *
 * So the money is checked to the paisa, the outstanding is derived from the
 * PAYMENTS rather than from the milestone's status column (status is
 * application-maintained and can drift; the payments are the record), and the
 * double-demand guard is exercised rather than assumed.
 */
import pg from 'pg';
import argon2 from 'argon2';

const BASE = process.env.API_BASE ?? 'http://localhost:4055';
const PW = 'Test1234!';
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + (x ? '  -> ' + x : ''))); };

const admin = new pg.Client('postgres://postgres:postgres@localhost:5433/erp_test');
await admin.connect();

const MARK = 'DMD';
const clean = async () => {
  await admin.query(`DELETE FROM demand_letters WHERE booking_id IN (SELECT bk.id FROM bookings bk JOIN leads l ON l.id=bk.lead_id WHERE l.name LIKE '${MARK}%')`);
  await admin.query(`DELETE FROM payments WHERE payment_schedule_id IN (SELECT s.id FROM payment_schedules s JOIN bookings bk ON bk.id=s.booking_id JOIN leads l ON l.id=bk.lead_id WHERE l.name LIKE '${MARK}%')`);
  await admin.query(`DELETE FROM payment_schedules WHERE booking_id IN (SELECT bk.id FROM bookings bk JOIN leads l ON l.id=bk.lead_id WHERE l.name LIKE '${MARK}%')`);
  await admin.query(`DELETE FROM bookings WHERE lead_id IN (SELECT id FROM leads WHERE name LIKE '${MARK}%')`);
  await admin.query(`DELETE FROM leads WHERE name LIKE '${MARK}%'`);
  await admin.query(`DELETE FROM users WHERE email LIKE '${MARK.toLowerCase()}%@dmd.test'`);
};
await clean();

const { rows: [t] } = await admin.query(`SELECT id FROM tenants WHERE slug='platform'`);
const hash = await argon2.hash(PW, { type: argon2.argon2id });

const mkUser = async (role, slug) => {
  const { rows: [r] } = await admin.query(`SELECT id FROM roles WHERE tenant_id=$1 AND name=$2`, [t.id, role]);
  await admin.query(
    `INSERT INTO users (tenant_id, role_id, name, email, password_hash, active, mfa_email_enabled)
     VALUES ($1,$2,'Dmd Probe',$3,$4,true,false)`,
    [t.id, r.id, `${MARK.toLowerCase()}${slug}@dmd.test`, hash]);
  const res = await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: `${MARK.toLowerCase()}${slug}@dmd.test`, password: PW }) });
  const b = await res.json();
  if (!b?.token) throw new Error(`login ${slug}: ${res.status} ${JSON.stringify(b)}`);
  return b.token;
};
const accountant = await mkUser('accountant', 'acct');
const sales      = await mkUser('sales_executive', 'sales');

const H = (tok) => ({ 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok });
const get  = (p, tok) => fetch(BASE + p, { headers: H(tok) });
const post = (p, tok, b) => fetch(BASE + p, { method: 'POST', headers: H(tok), body: JSON.stringify(b ?? {}) });

// ── Fixture: a booking with a milestone 100 days overdue at 12% ────────────
// 500000 * 12% * 100/365 = 16438.356… → 16438.36 to the paisa.
const { rows: [lead] } = await admin.query(
  `INSERT INTO leads (tenant_id,name,phone,source,stage,priority,last_contact_at)
   VALUES ($1,$2,'9800000051','Direct','booked','hot',now()) RETURNING id`, [t.id, `${MARK} Buyer`]);
const { rows: [unit] } = await admin.query(`SELECT id FROM units WHERE tenant_id=$1 LIMIT 1`, [t.id]);
const { rows: [booking] } = await admin.query(
  `INSERT INTO bookings (tenant_id, lead_id, unit_id, booking_amount, total_consideration, status, delay_interest_pct)
   VALUES ($1,$2,$3,500000,7500000,'active',12) RETURNING id`, [t.id, lead.id, unit?.id ?? null]);
const { rows: [ms] } = await admin.query(
  `INSERT INTO payment_schedules (tenant_id, booking_id, milestone_name, sequence, percentage, amount, due_date, status)
   VALUES ($1,$2,'On Slab',1,10,500000, CURRENT_DATE - 100, 'pending') RETURNING id`, [t.id, booking.id]);

// ── The arithmetic, at the database ───────────────────────────────────────
console.log('\n=== INTEREST IS COMPUTED, NOT APPROXIMATED ===');
const calc = async (p, r, d) => Number((await admin.query(`SELECT delay_interest($1,$2,$3) AS i`, [p, r, d])).rows[0].i);
ok('500000 at 12% for 100 days = 16438.36', await calc(500000, 12, 100) === 16438.36, String(await calc(500000, 12, 100)));
ok('a zero rate charges nothing', await calc(500000, 0, 100) === 0);
ok('a milestone not yet due charges nothing', await calc(500000, 12, 0) === 0);
// Negative days would otherwise pay the buyer interest for being early.
ok('negative days are floored at zero', await calc(500000, 12, -30) === 0);

console.log('\n=== OUTSTANDING COMES FROM THE PAYMENTS, NOT THE STATUS ===');
const outstanding = async () => Number((await admin.query(`SELECT milestone_outstanding($1) AS o`, [ms.id])).rows[0].o);
ok('nothing paid yet → full amount', await outstanding() === 500000, String(await outstanding()));
await admin.query(
  `INSERT INTO payments (tenant_id, payment_schedule_id, amount, payment_date, mode)
   VALUES ($1,$2,200000,CURRENT_DATE,'bank_transfer')`, [t.id, ms.id]);
ok('a part payment reduces it', await outstanding() === 300000, String(await outstanding()));
// The status column is deliberately left saying 'pending' here: if the
// function read status instead of payments, this next line would be wrong.
await admin.query(`UPDATE payment_schedules SET status='paid' WHERE id=$1`, [ms.id]);
ok('a status of paid does NOT zero a part-paid milestone', await outstanding() === 300000,
   String(await outstanding()));
await admin.query(`UPDATE payment_schedules SET status='pending' WHERE id=$1`, [ms.id]);

// ── The worklist ──────────────────────────────────────────────────────────
console.log('\n=== THE WORKLIST SHOWS WHAT IT WOULD DEMAND ===');
const dueRes = await get('/api/demand-letters/due', accountant);
const due = (await dueRes.json()).due.find(d => d.paymentScheduleId === ms.id);
ok('the overdue milestone appears', !!due, `${dueRes.status}`);
ok('…with the outstanding, not the original amount', due?.outstanding === 300000, String(due?.outstanding));
ok('…and interest on that outstanding', due?.interest === Number(await calc(300000, 12, 100)),
   `${due?.interest} vs ${await calc(300000, 12, 100)}`);
ok('…totalled', due?.total === 300000 + due.interest, String(due?.total));

// ── Raising ───────────────────────────────────────────────────────────────
console.log('\n=== RAISING A DEMAND ===');
const raise = await post('/api/demand-letters', accountant, { paymentScheduleId: ms.id, dueInDays: 15 });
const letter = (await raise.json()).demandLetter;
ok('the accountant can raise it', raise.status === 201, String(raise.status));
ok('the amount is the server\'s, not the client\'s', letter?.principalAmount === 300000, String(letter?.principalAmount));
ok('interest is frozen onto the letter', letter?.interestAmount === due.interest, String(letter?.interestAmount));
ok('total = principal + interest', letter?.totalAmount === letter.principalAmount + letter.interestAmount);
ok('it carries a letter number', Number(letter?.letterNo) >= 1, String(letter?.letterNo));

const dup = await post('/api/demand-letters', accountant, { paymentScheduleId: ms.id });
ok('a second live demand for the same milestone is refused (409)', dup.status === 409, String(dup.status));

ok('the milestone leaves the worklist once demanded',
   !((await (await get('/api/demand-letters/due', accountant)).json()).due
     .some(d => d.paymentScheduleId === ms.id)));

console.log('\n=== A FULLY PAID MILESTONE CANNOT BE DEMANDED ===');
const { rows: [paidMs] } = await admin.query(
  `INSERT INTO payment_schedules (tenant_id, booking_id, milestone_name, sequence, percentage, amount, due_date, status)
   VALUES ($1,$2,'Settled',2,10,100000, CURRENT_DATE - 20, 'pending') RETURNING id`, [t.id, booking.id]);
await admin.query(
  `INSERT INTO payments (tenant_id, payment_schedule_id, amount, payment_date, mode)
   VALUES ($1,$2,100000,CURRENT_DATE,'bank_transfer')`, [t.id, paidMs.id]);
const paidTry = await post('/api/demand-letters', accountant, { paymentScheduleId: paidMs.id });
ok('raising against it is a 400 with a reason', paidTry.status === 400, String(paidTry.status));

// ── Permissions ───────────────────────────────────────────────────────────
console.log('\n=== WHO MAY DEMAND MONEY ===');
ok('a sales executive cannot see the worklist', (await get('/api/demand-letters/due', sales)).status === 403);
ok('…nor raise a demand', (await post('/api/demand-letters', sales, { paymentScheduleId: ms.id })).status === 403);
// Paired positive: without it, a server refusing everyone would pass the two above.
ok('the accountant can list them', (await get('/api/demand-letters', accountant)).status === 200);

console.log('\n=== A DEMAND IS SETTLED OR WITHDRAWN, NEVER EDITED ===');
const remind = await post(`/api/demand-letters/${letter.id}/remind`, accountant);
ok('a reminder is recorded', remind.status === 200 && (await remind.json()).demandLetter.reminderCount === 1);

const settle = await fetch(BASE + `/api/demand-letters/${letter.id}`, {
  method: 'PATCH', headers: H(accountant), body: JSON.stringify({ status: 'paid' }) });
ok('it can be marked paid', settle.status === 200, String(settle.status));
const again = await fetch(BASE + `/api/demand-letters/${letter.id}`, {
  method: 'PATCH', headers: H(accountant), body: JSON.stringify({ status: 'cancelled' }) });
ok('settling twice is refused', again.status === 404, String(again.status));

// Cancelling frees the milestone for a corrected letter — the reason the
// uniqueness guard is a PARTIAL index on status='issued' rather than a plain one.
console.log('\n=== A WITHDRAWN DEMAND CAN BE RE-RAISED ===');
const reRaise = await post('/api/demand-letters', accountant, { paymentScheduleId: ms.id });
ok('once the first is settled, a fresh letter may be raised', reRaise.status === 201, String(reRaise.status));
const second = (await reRaise.json()).demandLetter;
ok('…with a new number', second.letterNo !== letter.letterNo, `${letter.letterNo} vs ${second.letterNo}`);

await clean();
await admin.end();
console.log(`\n===== ${pass} passed, ${fail} failed =====`);
process.exit(fail ? 1 : 0);
