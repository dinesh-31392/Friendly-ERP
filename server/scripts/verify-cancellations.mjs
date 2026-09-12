/**
 * Cancellation and refund — including the case that used to be invisible.
 *
 * WHAT THIS IS FOR
 *
 * Cancelling a booking was `DELETE FROM bookings`. That is an erasure, not a
 * cancellation: by the time a booking is cancelled, money has changed hands,
 * TDS may have been remitted against the buyer's PAN, GST may have gone to the
 * government and brokerage may already be out the door. A refund cannot be
 * computed from a row that no longer exists, and a dispute cannot be answered
 * with "we deleted it".
 *
 * THE ASSERTION THAT MATTERS
 *
 * Forfeiture is a percentage of the CONSIDERATION, not of what the buyer
 * happened to have paid. An agreement forfeiting 10% against a buyer who has
 * paid 5% leaves the buyer OWING the balance — the refund is negative. Almost
 * every implementation clamps that at zero, which silently writes off money the
 * builder is owed on every early cancellation, and nobody notices because the
 * number that comes out still looks like a refund.
 *
 * That case is the reason this file exists. The rest is scaffolding around it.
 */
import pg from 'pg';
import argon2 from 'argon2';

const BASE = process.env.API_BASE ?? 'http://localhost:4055';
const PW = 'Test1234!';
const MARK = 'cx' + Math.random().toString(36).slice(2, 8);
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + (x ? '  -> ' + x : ''))); };
const near = (a, b) => Math.abs(Number(a) - Number(b)) < 0.011;

const admin = new pg.Client(process.env.DATABASE_ADMIN_URL
  ?? 'postgres://postgres:postgres@localhost:5433/erp_test');
await admin.connect();

async function workspace(slug, perms) {
  const t = (await admin.query(
    `INSERT INTO tenants (name, company, slug, email, address, phone, currency)
     VALUES ($1, $1, $2, $3, 'BKC, Mumbai 400051', '+91 22 4000 1000', 'INR') RETURNING id`,
    [`${MARK} ${slug}`, `${MARK}-${slug}`, `${MARK}-${slug}@cx.test`])).rows[0];
  const role = (await admin.query(
    `INSERT INTO roles (tenant_id, name, is_system) VALUES ($1, 'Ops', false) RETURNING id`, [t.id])).rows[0];
  if (perms.length) {
    await admin.query(
      `INSERT INTO role_permissions (role_id, permission_key)
       SELECT $1, k FROM unnest($2::text[]) k ON CONFLICT DO NOTHING`, [role.id, perms]);
  }
  const email = `${MARK}-${slug}@cx.test`;
  await admin.query(
    `INSERT INTO users (tenant_id, role_id, name, email, password_hash, active)
     VALUES ($1, $2, 'Ops User', $3, $4, true)`,
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
    `INSERT INTO projects (tenant_id, name) VALUES ($1, 'Skyline Heights') RETURNING id`, [t.id])).rows[0];
  return { tenantId: t.id, token, projectId: project.id };
}

/** A booking with a consideration and a given amount actually received. */
async function booking(w, { code, consideration, received }) {
  const unit = (await admin.query(
    `INSERT INTO units (tenant_id, project_id, unit_code, area_sqft, base_rate)
     VALUES ($1, $2, $3, 1200, 8000) RETURNING id`, [w.tenantId, w.projectId, code])).rows[0];
  const lead = (await admin.query(
    `INSERT INTO leads (tenant_id, name, email, phone) VALUES ($1, $2, $3, '+91 98200 00006') RETURNING id`,
    [w.tenantId, `Buyer ${code}`, `buyer-${code}-${MARK}@cx.test`])).rows[0];
  const b = (await admin.query(
    `INSERT INTO bookings (tenant_id, lead_id, unit_id, total_consideration, status)
     VALUES ($1, $2, $3, $4, 'active') RETURNING id`,
    [w.tenantId, lead.id, unit.id, consideration])).rows[0];
  if (received > 0) {
    const sched = (await admin.query(
      `INSERT INTO payment_schedules (tenant_id, booking_id, sequence, milestone_name, due_date, amount)
       VALUES ($1, $2, 1, 'On Booking', CURRENT_DATE, $3) RETURNING id`,
      [w.tenantId, b.id, consideration])).rows[0];
    await admin.query(
      `INSERT INTO payments (tenant_id, payment_schedule_id, amount, payment_date, mode)
       VALUES ($1, $2, $3, CURRENT_DATE, 'bank_transfer')`, [w.tenantId, sched.id, received]);
  }
  return { bookingId: b.id, unitId: unit.id, leadId: lead.id };
}

const api = (token, path, init = {}) => fetch(BASE + path, {
  ...init,
  headers: { ...(init.body ? { 'Content-Type': 'application/json' } : {}), Authorization: `Bearer ${token}` },
});
const post = (token, path, body) => api(token, path, { method: 'POST', body: JSON.stringify(body) });

const A = await workspace('a', ['view_bookings', 'manage_bookings', 'view_finance', 'manage_finance']);
const B = await workspace('b', ['view_bookings', 'manage_bookings', 'view_finance', 'manage_finance']);

console.log('\n=== A NORMAL CANCELLATION ===');
// Consideration 1,00,00,000. Received 30,00,000. Forfeit 10% = 10,00,000.
// Refund = 30,00,000 - 10,00,000 = 20,00,000.
const b1 = await booking(A, { code: 'A-101', consideration: 10000000, received: 3000000 });
const preview = await (await api(A.token, `/api/bookings/${b1.bookingId}/cancellation-preview?forfeiturePct=10`)).json();
ok('the preview reads what was RECEIVED, not what was scheduled',
   near(preview.preview.totalReceived, 3000000), String(preview.preview.totalReceived));
ok('forfeiture is a percentage of the consideration',
   near(preview.preview.forfeitureAmount, 1000000), String(preview.preview.forfeitureAmount));
ok('the refund is what is left', near(preview.preview.refundAmount, 2000000),
   String(preview.preview.refundAmount));

const res1 = await post(A.token, '/api/cancellations', {
  bookingId: b1.bookingId, forfeiturePct: 10, reasonCategory: 'buyer_finance', reason: 'Home loan declined',
});
ok('the request is created', res1.status === 201, String(res1.status));
const c1 = (await res1.json()).cancellation;
ok('and matches the preview', near(c1.refundAmount, 2000000), String(c1.refundAmount));
ok('buyerOwes is false for a positive refund', c1.buyerOwes === false);

console.log('\n=== THE BOOKING SURVIVES, AND THE UNIT IS FREED ===');
const after = (await admin.query('SELECT status FROM bookings WHERE id = $1', [b1.bookingId])).rows[0];
ok('the booking row still exists', !!after, 'row deleted');
ok('and is marked cancelled', after?.status === 'cancelled', after?.status);

// The partial unique index covers only active/completed, so the unit is free.
const rebook = await admin.query(
  `INSERT INTO bookings (tenant_id, lead_id, unit_id, total_consideration, status)
   VALUES ($1, $2, $3, 9000000, 'active') RETURNING id`,
  [A.tenantId, b1.leadId, b1.unitId]).then(() => 'ok', e => e.code);
ok('the unit can be booked again', rebook === 'ok', String(rebook));

console.log('\n=== THE NEGATIVE REFUND — THE CASE THAT USED TO BE INVISIBLE ===');
// Consideration 1,00,00,000, forfeiture 10% = 10,00,000, but the buyer paid
// only 5,00,000. The buyer OWES 5,00,000. A calculation that clamps at zero
// reports "no refund due" and writes off five lakh, quietly, every time.
const b2 = await booking(A, { code: 'A-102', consideration: 10000000, received: 500000 });
const c2 = (await (await post(A.token, '/api/cancellations', {
  bookingId: b2.bookingId, forfeiturePct: 10, reasonCategory: 'buyer_personal',
})).json()).cancellation;
ok('the refund is NEGATIVE, not clamped to zero', Number(c2.refundAmount) < 0, String(c2.refundAmount));
ok('and is the exact shortfall', near(c2.refundAmount, -500000), String(c2.refundAmount));
ok('buyerOwes is set so the client cannot miss the sign', c2.buyerOwes === true);

const stored = (await admin.query(
  'SELECT refund_amount FROM booking_cancellations WHERE id = $1', [c2.id])).rows[0];
ok('the sign survives the round trip to the database',
   Number(stored.refund_amount) < 0, String(stored.refund_amount));

const pdf2 = await api(A.token, `/api/cancellations/${c2.id}/pdf`);
const buf2 = Buffer.from(await pdf2.arrayBuffer());
const { default: zlib } = await import('node:zlib');
function extractText(b) {
  let out = ''; const raw = b.toString('latin1'); let m; const re = /stream\r?\n([\s\S]*?)endstream/g;
  while ((m = re.exec(raw)) !== null) {
    const by = Buffer.from(m[1], 'latin1');
    let c; try { c = zlib.inflateSync(by).toString('latin1'); } catch { c = by.toString('latin1'); }
    for (const t of c.matchAll(/<([0-9A-Fa-f\s]+)>|\((?:\\.|[^\\)])*\)/g)) {
      out += t[1] !== undefined
        ? Buffer.from(t[1].replace(/\s+/g, ''), 'hex').toString('latin1')
        : t[0].slice(1, -1).replace(/\\([()\\])/g, '$1');
    }
  }
  return out;
}
const squash = (v) => v.replace(/\s+/g, '');
const text2 = extractText(buf2);
const says2 = (p) => squash(text2).includes(squash(p));
ok('the statement is titled as a settlement, not a refund', says2('Cancellation and Settlement Statement'));
ok('and says the money is payable BY the purchaser', says2('payable BY the purchaser'));
ok('and explains why', says2('exceeds the amount received'));

console.log('\n=== GST IS ONLY RETURNED WHEN IT CAN BE RECOVERED ===');
// Received 30,00,000 including 5,00,000 of GST already remitted. Forfeit 10%.
// Recoverable: refund = 30L - 10L - 0 = 20L.
// Not recoverable: the builder cannot get it back from the government, so
// paying it to the buyer means paying it twice: refund = 20L - 5L = 15L.
const b3 = await booking(A, { code: 'A-103', consideration: 10000000, received: 3000000 });
const recoverable = await (await api(A.token,
  `/api/bookings/${b3.bookingId}/cancellation-preview?forfeiturePct=10&gstRemitted=500000&gstRefundable=true`)).json();
ok('a recoverable GST is returned to the buyer',
   near(recoverable.preview.refundAmount, 2000000), String(recoverable.preview.refundAmount));

const stuck = await (await api(A.token,
  `/api/bookings/${b3.bookingId}/cancellation-preview?forfeiturePct=10&gstRemitted=500000&gstRefundable=false`)).json();
ok('an unrecoverable GST is withheld, not paid twice',
   near(stuck.preview.refundAmount, 1500000), String(stuck.preview.refundAmount));

const c3 = (await (await post(A.token, '/api/cancellations', {
  bookingId: b3.bookingId, forfeiturePct: 10, gstRemitted: 500000, gstRefundable: false,
})).json()).cancellation;
const text3 = extractText(Buffer.from(await (await api(A.token, `/api/cancellations/${c3.id}/pdf`)).arrayBuffer()));
const says3 = (p) => squash(text3).includes(squash(p));
ok('the statement cites section 34(2) for the withheld GST', says3('section 34(2)'));
ok('and states that TDS is outside the computation',
   says3('does not form part of this computation'));

console.log('\n=== OTHER DEDUCTIONS COME OFF SEPARATELY ===');
const b4 = await booking(A, { code: 'A-104', consideration: 10000000, received: 3000000 });
const withBrokerage = await (await api(A.token,
  `/api/bookings/${b4.bookingId}/cancellation-preview?forfeiturePct=10&otherDeductions=200000`)).json();
ok('brokerage already disbursed is deducted',
   near(withBrokerage.preview.refundAmount, 1800000), String(withBrokerage.preview.refundAmount));

console.log('\n=== APPROVAL IS A SEPARATE HAND FROM THE REQUEST ===');
const salesOnly = await workspace('c', ['view_bookings', 'manage_bookings']);
const sb = await booking(salesOnly, { code: 'C-101', consideration: 10000000, received: 3000000 });
const salesReq = await post(salesOnly.token, '/api/cancellations', { bookingId: sb.bookingId, forfeiturePct: 10 });
ok('sales can raise a request', salesReq.status === 201, String(salesReq.status));
const sc = (await salesReq.json()).cancellation;
const salesApprove = await api(salesOnly.token, `/api/cancellations/${sc.id}`, {
  method: 'PATCH', body: JSON.stringify({ status: 'approved' }),
});
ok('but cannot approve their own refund', salesApprove.status === 403, String(salesApprove.status));

console.log('\n=== A PAYOUT NEEDS EVIDENCE, AND THE LIFECYCLE IS ONE WAY ===');
const noRef = await api(A.token, `/api/cancellations/${c1.id}`, {
  method: 'PATCH', body: JSON.stringify({ status: 'refunded' }),
});
ok('a refund cannot skip approval', noRef.status === 409, String(noRef.status));

const approve = await api(A.token, `/api/cancellations/${c1.id}`, {
  method: 'PATCH', body: JSON.stringify({ status: 'approved' }),
});
ok('finance can approve', approve.status === 200, String(approve.status));

const payNoRef = await api(A.token, `/api/cancellations/${c1.id}`, {
  method: 'PATCH', body: JSON.stringify({ status: 'refunded' }),
});
ok('a payout with no reference is refused', payNoRef.status === 400, String(payNoRef.status));

const paid = await api(A.token, `/api/cancellations/${c1.id}`, {
  method: 'PATCH', body: JSON.stringify({ status: 'refunded', refundReference: 'NEFT/2026/00417' }),
});
ok('a payout with a reference is recorded', paid.status === 200, String(paid.status));
const paidRow = (await paid.json()).cancellation;
ok('and the payout date is stamped', !!paidRow.refundedOn);
ok('with the reference kept', paidRow.refundReference === 'NEFT/2026/00417', paidRow.refundReference);

const reopen = await api(A.token, `/api/cancellations/${c1.id}`, {
  method: 'PATCH', body: JSON.stringify({ status: 'approved' }),
});
ok('a refunded cancellation cannot be reopened', reopen.status === 409, String(reopen.status));

console.log('\n=== ONE LIVE CANCELLATION PER BOOKING ===');
const dup = await post(A.token, '/api/cancellations', { bookingId: b2.bookingId, forfeiturePct: 10 });
ok('a second request against the same booking is refused',
   dup.status === 409, String(dup.status));

console.log('\n=== IT IS TENANT-SCOPED ===');
const cross = await api(B.token, `/api/cancellations/${c1.id}/pdf`);
ok('another tenant cannot read the statement', cross.status === 404, String(cross.status));
const crossList = await (await api(B.token, '/api/cancellations')).json();
ok('nor see it in a list', !(crossList.cancellations ?? []).some(c => c.id === c1.id));

for (const w of [A, B, salesOnly]) await admin.query('DELETE FROM tenants WHERE id = $1', [w.tenantId]);
await admin.end();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
