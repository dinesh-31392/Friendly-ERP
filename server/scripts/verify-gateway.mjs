/**
 * The payment gateway, and the endpoint that is most exposed in the product.
 *
 * WHAT THIS IS FOR
 *
 * A buyer paying online is the one place money enters the system from outside
 * it. The rule that shapes everything: THE CLIENT NEVER SAYS A PAYMENT
 * SUCCEEDED. A browser can be told anything, and a determined buyer can tell
 * the browser anything.
 *
 * THE FOUR THINGS WORTH ASSERTING
 *
 * 1. Signature verification uses the RAW BODY. Re-serialising the parsed JSON
 *    produces a different string — key order, whitespace — and the signature
 *    never matches. This is the failure that presents as "the gateway is
 *    misconfigured" and costs a day.
 *
 * 2. Idempotency. Razorpay retries until it gets a 2xx and will deliver the
 *    same event three times. Without a unique key, a 10 lakh instalment lands
 *    three times and somebody has to work out which two receipts are ghosts.
 *
 * 3. An unverified event NEVER moves money, enforced by a CHECK constraint as
 *    well as by the handler.
 *
 * 4. The amount comes from the milestone, never from the request. A body
 *    carrying the amount lets a buyer pay ₹1 against a ₹10 lakh instalment.
 */
import pg from 'pg';
import argon2 from 'argon2';
import { createHmac } from 'node:crypto';

const BASE = process.env.API_BASE ?? 'http://localhost:4055';
const PW = 'Test1234!';
const MARK = 'gw' + Math.random().toString(36).slice(2, 8);
const WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET
  || process.env.RAZORPAY_KEY_SECRET || '';
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + (x ? '  -> ' + x : ''))); };
const near = (a, b) => Math.abs(Number(a) - Number(b)) < 0.011;

const admin = new pg.Client(process.env.DATABASE_ADMIN_URL
  ?? 'postgres://postgres:postgres@localhost:5433/erp_test');
await admin.connect();

async function workspace(slug, perms) {
  const t = (await admin.query(
    `INSERT INTO tenants (name, company, slug, email) VALUES ($1,$1,$2,$3) RETURNING id`,
    [`${MARK} ${slug}`, `${MARK}-${slug}`, `${MARK}-${slug}@gw.test`])).rows[0];
  const role = (await admin.query(
    `INSERT INTO roles (tenant_id, name, is_system) VALUES ($1,'Finance',false) RETURNING id`, [t.id])).rows[0];
  if (perms.length) {
    await admin.query(
      `INSERT INTO role_permissions (role_id, permission_key)
       SELECT $1, k FROM unnest($2::text[]) k ON CONFLICT DO NOTHING`, [role.id, perms]);
  }
  const email = `${MARK}-${slug}@gw.test`;
  await admin.query(
    `INSERT INTO users (tenant_id, role_id, name, email, password_hash, active)
     VALUES ($1,$2,'Finance',$3,$4,true)`,
    [t.id, role.id, email, await argon2.hash(PW, { type: argon2.argon2id })]);
  const token = (await (await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PW }),
  })).json()).token;
  if (!token) throw new Error(`login failed for ${email}`);
  await admin.query(
    `INSERT INTO schema_definitions (tenant_id, entity, kind, version, is_active, definition)
     VALUES ($1,'lead','pipeline',1,true,$2)
     ON CONFLICT (tenant_id, entity, kind, version) DO UPDATE SET is_active = true`,
    [t.id, JSON.stringify({ stages: [
      { key: 'new', id: 'new', label: 'New', core: true },
      { key: 'booked', id: 'booked', label: 'Booked', core: true },
      { key: 'lost', id: 'lost', label: 'Lost', core: true },
    ] })]);
  const project = (await admin.query(
    `INSERT INTO projects (tenant_id, name) VALUES ($1,'Skyline') RETURNING id`, [t.id])).rows[0];
  return { tenantId: t.id, token, projectId: project.id };
}

/** A booking with one milestone of a chosen amount. */
async function milestone(w, amount) {
  const unit = (await admin.query(
    `INSERT INTO units (tenant_id, project_id, unit_code) VALUES ($1,$2,$3) RETURNING id`,
    [w.tenantId, w.projectId, 'U-' + Math.random().toString(36).slice(2, 7)])).rows[0];
  const lead = (await admin.query(
    `INSERT INTO leads (tenant_id, name, email, phone) VALUES ($1,'Buyer',$2,'+91 98200 00006') RETURNING id`,
    [w.tenantId, `b${Math.random().toString(36).slice(2, 8)}-${MARK}@gw.test`])).rows[0];
  const b = (await admin.query(
    `INSERT INTO bookings (tenant_id, lead_id, unit_id, total_consideration, status)
     VALUES ($1,$2,$3,$4,'active') RETURNING id`, [w.tenantId, lead.id, unit.id, amount])).rows[0];
  const s = (await admin.query(
    `INSERT INTO payment_schedules (tenant_id, booking_id, sequence, milestone_name, due_date, amount)
     VALUES ($1,$2,1,'On Booking',CURRENT_DATE,$3) RETURNING id`,
    [w.tenantId, b.id, amount])).rows[0];
  return { scheduleId: s.id, bookingId: b.id };
}

const api = (token, path, init = {}) => fetch(BASE + path, {
  ...init,
  headers: { ...(init.body ? { 'Content-Type': 'application/json' } : {}), Authorization: `Bearer ${token}` },
});

/** Post a webhook exactly as Razorpay would: signature over the RAW bytes. */
function webhook(payload, { secret = WEBHOOK_SECRET, tamper = false } = {}) {
  const raw = JSON.stringify(payload);
  const signature = createHmac('sha256', secret).update(raw).digest('hex');
  return fetch(BASE + '/api/webhooks/razorpay', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-razorpay-signature': tamper ? signature.replace(/.$/, c => (c === 'a' ? 'b' : 'a')) : signature,
      'x-razorpay-event-id': String(payload.id ?? ''),
    },
    body: raw,
  });
}

const event = (id, orderId, { type = 'payment.captured', paise = 100000, paymentId = 'pay_' + id } = {}) => ({
  id, event: type,
  payload: { payment: { entity: { id: paymentId, order_id: orderId, amount: paise, currency: 'INR' } } },
});

const A = await workspace('a', ['view_finance', 'manage_finance']);
const B = await workspace('b', ['view_finance', 'manage_finance']);

const configured = (await (await api(A.token, '/api/payments/gateway/events')).json()).configured;
console.log(`\n(gateway ${configured ? 'IS' : 'is NOT'} configured in this environment)`);

console.log('\n=== ORDER CREATION NEVER TRUSTS A CLIENT AMOUNT ===');
const m1 = await milestone(A, 1000000);
// Fastify's ajv is configured with `removeAdditional`, so a rogue `amount`
// is STRIPPED rather than rejected. Either is safe; what matters is that it
// cannot influence what gets charged. The clean proof is a milestone that is
// already settled: the server refuses it on its own arithmetic, and a client
// naming any amount at all changes nothing.
const settled = await milestone(A, 250000);
await admin.query(
  `INSERT INTO payments (tenant_id, payment_schedule_id, amount, payment_date, mode)
   VALUES ($1,$2,250000,CURRENT_DATE,'bank_transfer')`, [A.tenantId, settled.scheduleId]);

const honest = await api(A.token, '/api/payments/gateway/order', {
  method: 'POST', body: JSON.stringify({ paymentScheduleId: settled.scheduleId }),
});
ok('a fully paid milestone cannot be ordered against', honest.status === 409, String(honest.status));

const sneaky = await api(A.token, '/api/payments/gateway/order', {
  method: 'POST', body: JSON.stringify({ paymentScheduleId: settled.scheduleId, amount: 1 }),
});
ok('and naming an amount does not change that', sneaky.status === 409, String(sneaky.status));
ok('the refusal is the server\'s own arithmetic, not the client\'s',
   /already fully paid/i.test((await sneaky.json()).error ?? ''), 'unexpected message');

if (!configured) {
  const unconfigured = await api(A.token, '/api/payments/gateway/order', {
    method: 'POST', body: JSON.stringify({ paymentScheduleId: m1.scheduleId }),
  });
  ok('without keys, ordering fails clearly rather than half-working',
     unconfigured.status === 503, String(unconfigured.status));
  ok('and says which variables are missing',
     /RAZORPAY_KEY_ID/.test((await unconfigured.json()).error ?? ''));
}

console.log('\n=== THE WEBHOOK IS THE ONLY THING THAT RECORDS MONEY ===');
// An order written directly, so the webhook path is exercised without needing
// live Razorpay credentials — the signature logic is ours and is what matters.
const ORDER = 'order_' + MARK + '1';
await admin.query(
  `INSERT INTO gateway_orders (tenant_id, provider, order_ref, payment_schedule_id, amount)
   VALUES ($1,'razorpay',$2,$3,1000000)`, [A.tenantId, ORDER, m1.scheduleId]);

const unsigned = await fetch(BASE + '/api/webhooks/razorpay', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(event('evt_none', ORDER)),
});
ok('a webhook with no signature is refused', unsigned.status === 401, String(unsigned.status));

const tampered = await webhook(event('evt_tamper', ORDER), { tamper: true });
ok('a tampered signature is refused', tampered.status === 401, String(tampered.status));

const wrongSecret = await webhook(event('evt_wrong', ORDER), { secret: 'not-the-secret' });
ok('a signature from the wrong secret is refused', wrongSecret.status === 401, String(wrongSecret.status));

ok('and none of those recorded a payment',
   Number((await admin.query(
     `SELECT count(*)::int n FROM payments WHERE payment_schedule_id = $1`, [m1.scheduleId])).rows[0].n) === 0);
ok('nor left an applied event',
   Number((await admin.query(
     `SELECT count(*)::int n FROM gateway_events WHERE order_ref = $1 AND applied_at IS NOT NULL`,
     [ORDER])).rows[0].n) === 0);

console.log('\n=== A VALID EVENT LANDS EXACTLY ONCE ===');
const first = await webhook(event('evt_ok_1', ORDER, { paise: 100000000 }));
ok('a correctly signed capture is accepted', first.status === 200, String(first.status));

const payments = await admin.query(
  `SELECT amount, reference_no FROM payments WHERE payment_schedule_id = $1`, [m1.scheduleId]);
ok('a payment is recorded', payments.rowCount === 1, String(payments.rowCount));
// 100000000 paise = ₹10,00,000. Out by a factor of a hundred is the classic bug.
ok('in RUPEES, converted from paise', near(payments.rows[0]?.amount, 1000000),
   `${payments.rows[0]?.amount} (10000000000 would mean paise were stored raw)`);
ok('carrying the gateway payment reference',
   String(payments.rows[0]?.reference_no ?? '').startsWith('pay_'), payments.rows[0]?.reference_no);
ok('and the order is marked paid',
   (await admin.query(`SELECT status FROM gateway_orders WHERE order_ref=$1`, [ORDER])).rows[0].status === 'paid');

// The retry. Razorpay sends the same event until it gets a 2xx.
const replay = await webhook(event('evt_ok_1', ORDER, { paise: 100000000 }));
ok('a redelivery returns 200, so the retry loop stops', replay.status === 200, String(replay.status));
ok('and says it was a duplicate', (await replay.json()).duplicate === true);
ok('the payment is NOT recorded twice',
   Number((await admin.query(
     `SELECT count(*)::int n FROM payments WHERE payment_schedule_id = $1`, [m1.scheduleId])).rows[0].n) === 1,
   'duplicate receipt written');

console.log('\n=== THE SCHEMA REFUSES TO APPLY AN UNVERIFIED EVENT ===');
const forced = await admin.query(
  `INSERT INTO gateway_events (tenant_id, provider, event_id, signature_verified, applied_at)
   VALUES ($1,'razorpay',$2,false,now())`, [A.tenantId, 'evt_forced_' + MARK])
  .then(() => 'inserted', e => e.code);
ok('an applied event with no verified signature is rejected by the database',
   forced === '23514', String(forced));

const dupKey = await admin.query(
  `INSERT INTO gateway_events (tenant_id, provider, event_id, signature_verified)
   VALUES ($1,'razorpay','evt_ok_1',true)`, [A.tenantId])
  .then(() => 'inserted', e => e.code);
ok('and the same event id cannot be stored twice', dupKey === '23505', String(dupKey));

console.log('\n=== EVENTS FOR UNKNOWN ORDERS ARE ACKNOWLEDGED, NOT RETRIED ===');
const unknown = await webhook(event('evt_unknown', 'order_never_seen'));
ok('an unknown order gets 200 rather than an endless retry', unknown.status === 200, String(unknown.status));
ok('and is reported as ignored', (await unknown.json()).ignored === 'unknown order');

console.log('\n=== A FAILURE IS RECORDED, NOT BOOKED AS A RECEIPT ===');
const m2 = await milestone(A, 500000);
const ORDER2 = 'order_' + MARK + '2';
await admin.query(
  `INSERT INTO gateway_orders (tenant_id, provider, order_ref, payment_schedule_id, amount)
   VALUES ($1,'razorpay',$2,$3,500000)`, [A.tenantId, ORDER2, m2.scheduleId]);
const failed = await webhook(event('evt_failed', ORDER2, { type: 'payment.failed', paise: 50000000 }));
ok('a failure event is accepted', failed.status === 200, String(failed.status));
ok('the order is marked failed',
   (await admin.query(`SELECT status FROM gateway_orders WHERE order_ref=$1`, [ORDER2])).rows[0].status === 'failed');
ok('and NO payment is written',
   Number((await admin.query(
     `SELECT count(*)::int n FROM payments WHERE payment_schedule_id=$1`, [m2.scheduleId])).rows[0].n) === 0);

console.log('\n=== AN UNKNOWN EVENT TYPE IS NOT TREATED AS A PAYMENT ===');
// Razorpay sends a dozen event types. A handler that treats an unknown one as a
// capture books refunds as receipts.
const m3 = await milestone(A, 300000);
const ORDER3 = 'order_' + MARK + '3';
await admin.query(
  `INSERT INTO gateway_orders (tenant_id, provider, order_ref, payment_schedule_id, amount)
   VALUES ($1,'razorpay',$2,$3,300000)`, [A.tenantId, ORDER3, m3.scheduleId]);
const refund = await webhook(event('evt_refund', ORDER3, { type: 'refund.processed', paise: 30000000 }));
ok('a refund event is accepted', refund.status === 200, String(refund.status));
ok('but books no receipt',
   Number((await admin.query(
     `SELECT count(*)::int n FROM payments WHERE payment_schedule_id=$1`, [m3.scheduleId])).rows[0].n) === 0,
   'a refund was booked as a payment');
ok('and is still recorded for the audit trail',
   Number((await admin.query(
     `SELECT count(*)::int n FROM gateway_events WHERE event_id='evt_refund'`)).rows[0].n) === 1);

console.log('\n=== THE LEDGER OF EVENTS IS TENANT-SCOPED, AND HAS NO SECRETS ===');
const mine = (await (await api(A.token, '/api/payments/gateway/events')).json()).events;
ok('this workspace sees its own events', mine.some(e => e.eventId === 'evt_ok_1'));
const theirs = (await (await api(B.token, '/api/payments/gateway/events')).json()).events;
ok('another tenant sees none of them', !theirs.some(e => e.eventId === 'evt_ok_1'));

const body = await (await api(A.token, '/api/payments/gateway/events')).text();
ok('no key secret is ever returned',
   !/RAZORPAY_KEY_SECRET|keySecret|webhookSecret/.test(body) &&
   (!WEBHOOK_SECRET || !body.includes(WEBHOOK_SECRET)), 'a secret leaked into the response');

const noPerm = await workspace('c', []);
const denied = await api(noPerm.token, '/api/payments/gateway/events');
ok('a user without view_finance is refused', denied.status === 403, String(denied.status));

for (const w of [A, B, noPerm]) await admin.query('DELETE FROM tenants WHERE id = $1', [w.tenantId]);
await admin.end();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
