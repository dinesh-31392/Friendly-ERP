/**
 * Broker payout runs, and the 194-H rule that catches builders out.
 *
 * WHAT THIS IS FOR
 *
 * `commission_ledger` recorded what a broker had earned and what had been paid,
 * and that was the whole of it. There was no run — no way to take a period's
 * approved brokerage, deduct what the law requires, produce an advice the
 * broker can reconcile against, and mark the lot paid in one auditable act.
 * Builders were doing it in a spreadsheet and paying by NEFT from memory.
 *
 * THE THREE THINGS WORTH ASSERTING
 *
 * 1. TDS is computed on the BROKERAGE, not on the GST-inclusive figure. GST is
 *    not the broker's income; deducting on the gross overcharges them by the
 *    tax on a tax, on every run, forever.
 *
 * 2. The 194-H threshold is aggregate across the FINANCIAL YEAR, not per
 *    payment. A broker paid 18,000 in June with no deduction who earns 5,000 in
 *    September owes tax on 23,000 — not on 5,000. The earlier payments do not
 *    become exempt because nobody deducted at the time, and it is the BUILDER
 *    who is liable for the shortfall.
 *
 * 3. A commission belongs to at most one run. A payout is precisely the code
 *    path someone re-runs "just to be sure".
 */
import pg from 'pg';
import argon2 from 'argon2';

const BASE = process.env.API_BASE ?? 'http://localhost:4055';
const PW = 'Test1234!';
const MARK = 'bp' + Math.random().toString(36).slice(2, 8);
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + (x ? '  -> ' + x : ''))); };
const near = (a, b) => Math.abs(Number(a) - Number(b)) < 0.011;

const admin = new pg.Client(process.env.DATABASE_ADMIN_URL
  ?? 'postgres://postgres:postgres@localhost:5433/erp_test');
await admin.connect();

async function workspace(slug, perms) {
  const t = (await admin.query(
    `INSERT INTO tenants (name, company, slug, email, address, phone, currency)
     VALUES ($1,$1,$2,$3,'BKC, Mumbai','+91 22 4000 1000','INR') RETURNING id`,
    [`${MARK} ${slug}`, `${MARK}-${slug}`, `${MARK}-${slug}@bp.test`])).rows[0];
  const role = (await admin.query(
    `INSERT INTO roles (tenant_id, name, is_system) VALUES ($1,'Ops',false) RETURNING id`, [t.id])).rows[0];
  if (perms.length) {
    await admin.query(
      `INSERT INTO role_permissions (role_id, permission_key)
       SELECT $1, k FROM unnest($2::text[]) k ON CONFLICT DO NOTHING`, [role.id, perms]);
  }
  const email = `${MARK}-${slug}@bp.test`;
  await admin.query(
    `INSERT INTO users (tenant_id, role_id, name, email, password_hash, active)
     VALUES ($1,$2,'Ops',$3,$4,true)`,
    [t.id, role.id, email, await argon2.hash(PW, { type: argon2.argon2id })]);
  const token = (await (await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PW }),
  })).json()).token;
  if (!token) throw new Error(`login failed for ${email}`);
  return { tenantId: t.id, token };
}

/** A booking to hang commissions on — commission_ledger requires one. */
const bookingFor = async (w) => {
  if (!w._pipelineReady) {
    await admin.query(
      `INSERT INTO schema_definitions (tenant_id, entity, kind, version, is_active, definition)
       VALUES ($1,'lead','pipeline',1,true,$2)
       ON CONFLICT (tenant_id, entity, kind, version) DO UPDATE SET is_active = true`,
      [w.tenantId, JSON.stringify({ stages: [
        { key: 'new', id: 'new', label: 'New', core: true },
        { key: 'booked', id: 'booked', label: 'Booked', core: true },
        { key: 'lost', id: 'lost', label: 'Lost', core: true },
      ] })]);
    w._pipelineReady = true;
  }
  const project = (await admin.query(
    `INSERT INTO projects (tenant_id, name) VALUES ($1, 'Skyline') RETURNING id`, [w.tenantId])).rows[0];
  const unit = (await admin.query(
    `INSERT INTO units (tenant_id, project_id, unit_code) VALUES ($1,$2,$3) RETURNING id`,
    [w.tenantId, project.id, 'U-' + Math.random().toString(36).slice(2, 7)])).rows[0];
  const lead = (await admin.query(
    `INSERT INTO leads (tenant_id, name, email, phone) VALUES ($1,$2,$3,'+91 98200 00006') RETURNING id`,
    [w.tenantId, 'Buyer ' + Math.random().toString(36).slice(2, 7),
     `b${Math.random().toString(36).slice(2, 9)}-${MARK}@bp.test`])).rows[0];
  return (await admin.query(
    `INSERT INTO bookings (tenant_id, lead_id, unit_id, total_consideration, status)
     VALUES ($1,$2,$3,10000000,'active') RETURNING id`, [w.tenantId, lead.id, unit.id])).rows[0].id;
};

const broker = async (w, name) => (await admin.query(
  `INSERT INTO brokers (tenant_id, name, agency_name, phone, email, status)
   VALUES ($1,$2,$3,'+91 98200 00006',$4,'active') RETURNING id`,
  [w.tenantId, name, `${name} Realty`, `${name.toLowerCase().replace(/\W/g, '')}-${MARK}@bp.test`])).rows[0].id;

/** A commission earned on a given date — the date decides which run picks it up.
 *  'pending' is the ledger's word for earned-and-unpaid; the check constraint
 *  allows only pending / partially_paid / paid. */
const commission = async (w, brokerId, amount, onDate) => (await admin.query(
  `INSERT INTO commission_ledger (tenant_id, broker_id, booking_id, amount_earned, amount_paid, status, created_at)
   VALUES ($1,$2,$3,$4,0,'pending',$5::date) RETURNING id`,
  [w.tenantId, brokerId, await bookingFor(w), amount, onDate])).rows[0].id;

const api = (token, path, init = {}) => fetch(BASE + path, {
  ...init,
  headers: { ...(init.body ? { 'Content-Type': 'application/json' } : {}), Authorization: `Bearer ${token}` },
});
const post = (token, path, body) => api(token, path, { method: 'POST', body: JSON.stringify(body) });

const A = await workspace('a', ['view_brokers', 'manage_brokers', 'view_finance', 'manage_finance']);
const B = await workspace('b', ['view_brokers', 'manage_brokers', 'view_finance', 'manage_finance']);

console.log('\n=== TDS IS ON THE BROKERAGE, NOT ON THE GST ===');
// Brokerage 1,00,000 + 18% GST = 1,18,000. TDS at 2% must be 2,000 (on the
// brokerage), NOT 2,360 (on the GST-inclusive figure). Net = 1,16,000.
const b1 = await broker(A, 'Mehta Associates');
await commission(A, b1, 100000, '2025-06-10');
const run1 = (await (await post(A.token, '/api/broker-payouts', {
  periodStart: '2025-06-01', periodEnd: '2025-06-30', defaultGstPct: 18,
})).json()).run;
ok('the run is created and numbered', Number(run1.runNo) >= 1, String(run1.runNo));
const l1 = run1.lines[0];
ok('the brokerage is the gross', near(l1.grossAmount, 100000), String(l1.grossAmount));
ok('GST is added at 18%', near(l1.gstAmount, 18000), String(l1.gstAmount));
ok('TDS is 2% of the BROKERAGE, not of the GST-inclusive figure',
   near(l1.tdsAmount, 2000), `${l1.tdsAmount} (2360 would mean it taxed the GST)`);
ok('the net is brokerage + GST - TDS', near(l1.netAmount, 116000), String(l1.netAmount));

console.log('\n=== BELOW THE THRESHOLD, NOTHING IS DEDUCTED ===');
const b2 = await broker(A, 'Small Channel');
await commission(A, b2, 18000, '2025-06-12');
const run2 = (await (await post(A.token, '/api/broker-payouts', {
  periodStart: '2025-06-11', periodEnd: '2025-06-20',
})).json()).run;
const l2 = run2.lines.find(l => l.brokerId === b2);
ok('an 18,000 brokerage is under the 20,000 threshold', near(l2.grossAmount, 18000));
ok('and attracts no TDS at all', near(l2.tdsAmount, 0), String(l2.tdsAmount));
ok('the broker is paid in full', near(l2.netAmount, 18000), String(l2.netAmount));

console.log('\n=== CROSSING THE THRESHOLD CATCHES UP ON THE WHOLE YEAR ===');
// The same broker earns 5,000 more in September. FY aggregate is 23,000, which
// crosses 20,000 — so tax is due on 23,000 (460), and since nothing was
// deducted in June, the whole 460 falls on this payment. It is NOT 2% of 5,000.
await commission(A, b2, 5000, '2025-09-15');
const run3 = (await (await post(A.token, '/api/broker-payouts', {
  periodStart: '2025-09-01', periodEnd: '2025-09-30',
})).json()).run;
const l3 = run3.lines.find(l => l.brokerId === b2);
ok('the run sees what was credited earlier in the year',
   near(l3.fyPriorGross, 18000), String(l3.fyPriorGross));
ok('and that nothing had been deducted on it', near(l3.fyPriorTds, 0), String(l3.fyPriorTds));
ok('TDS is 2% of the YEAR aggregate, not of this payment',
   near(l3.tdsAmount, 460), `${l3.tdsAmount} (100 would mean it taxed only the 5,000)`);
ok('so the broker receives 5,000 less the catch-up',
   near(l3.netAmount, 4540), String(l3.netAmount));

console.log('\n=== AND DOES NOT DEDUCT THE SAME TAX TWICE ===');
// A third payment in the same year: aggregate 33,000, tax due 660, already
// deducted 460, so only 200 falls on this run.
await commission(A, b2, 10000, '2025-11-05');
const run4 = (await (await post(A.token, '/api/broker-payouts', {
  periodStart: '2025-11-01', periodEnd: '2025-11-30',
})).json()).run;
const l4 = run4.lines.find(l => l.brokerId === b2);
ok('prior deductions are credited', near(l4.fyPriorTds, 460), String(l4.fyPriorTds));
ok('so only the incremental tax is taken', near(l4.tdsAmount, 200), String(l4.tdsAmount));
ok('and the net reflects it', near(l4.netAmount, 9800), String(l4.netAmount));

console.log('\n=== THE FINANCIAL YEAR RESETS ON 1 APRIL ===');
// Indian FY runs 1 April to 31 March. A payment in April 2026 starts a fresh
// aggregate — the 33,000 from FY 2025-26 does not carry over.
const fyCheck = (await admin.query(
  `SELECT indian_fy_start('2026-03-31'::date) AS mar, indian_fy_start('2026-04-01'::date) AS apr`)).rows[0];
// This client has no DATE type parser, so node-pg hands back a JS Date at
// LOCAL midnight. Formatting it with toISOString would shift it a day west of
// Greenwich; format from the local parts instead.
const ymd = (d) => d instanceof Date
  ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  : String(d).slice(0, 10);
ok('31 March belongs to the previous year', ymd(fyCheck.mar) === '2025-04-01', ymd(fyCheck.mar));
ok('and 1 April starts a new one', ymd(fyCheck.apr) === '2026-04-01', ymd(fyCheck.apr));

await commission(A, b2, 5000, '2026-04-10');
const run5 = (await (await post(A.token, '/api/broker-payouts', {
  periodStart: '2026-04-01', periodEnd: '2026-04-30',
})).json()).run;
const l5 = run5.lines.find(l => l.brokerId === b2);
ok('the new year starts the aggregate again', near(l5.fyPriorGross, 0), String(l5.fyPriorGross));
ok('so a small payment is under the threshold once more', near(l5.tdsAmount, 0), String(l5.tdsAmount));

console.log('\n=== A COMMISSION IS PAID ONCE ===');
const rerun = (await (await post(A.token, '/api/broker-payouts', {
  periodStart: '2025-06-01', periodEnd: '2025-06-30', defaultGstPct: 18,
})).json()).run;
ok('re-running the same period produces an EMPTY run, not a double payment',
   rerun.lines.length === 0, `${rerun.lines.length} line(s)`);
ok('and totals nothing', near(rerun.netTotal, 0), String(rerun.netTotal));

console.log('\n=== PAYING THE RUN SETTLES THE LEDGER ===');
const skip = await api(A.token, `/api/broker-payouts/${run1.id}`, {
  method: 'PATCH', body: JSON.stringify({ status: 'paid', paymentReference: 'X' }),
});
ok('a draft cannot be paid without approval', skip.status === 409, String(skip.status));

const appr = await api(A.token, `/api/broker-payouts/${run1.id}`, {
  method: 'PATCH', body: JSON.stringify({ status: 'approved' }),
});
ok('it can be approved', appr.status === 200, String(appr.status));

const noRef = await api(A.token, `/api/broker-payouts/${run1.id}`, {
  method: 'PATCH', body: JSON.stringify({ status: 'paid' }),
});
ok('paying without a reference is refused', noRef.status === 400, String(noRef.status));

const paid = await api(A.token, `/api/broker-payouts/${run1.id}`, {
  method: 'PATCH', body: JSON.stringify({ status: 'paid', paymentReference: 'NEFT/2025/9912' }),
});
ok('and with one, it is paid', paid.status === 200, String(paid.status));

const ledger = (await admin.query(
  `SELECT status, amount_paid FROM commission_ledger WHERE broker_id = $1 AND created_at::date = '2025-06-10'`,
  [b1])).rows[0];
ok('the commission is settled in the same act',
   ledger.status === 'paid' && near(ledger.amount_paid, 100000),
   `${ledger.status} / ${ledger.amount_paid}`);

console.log('\n=== THE ADVICE EXPLAINS THE DEDUCTION ===');
const pdfRes = await api(A.token, `/api/broker-payouts/${run3.id}/pdf`);
ok('it renders', pdfRes.status === 200, String(pdfRes.status));
const buf = Buffer.from(await pdfRes.arrayBuffer());
ok('as a complete PDF', buf.subarray(0, 5).toString() === '%PDF-'
   && buf.subarray(-1024).toString('latin1').includes('%%EOF'));
const { default: zlib } = await import('node:zlib');
let text = ''; { const raw = buf.toString('latin1'); let m; const re = /stream\r?\n([\s\S]*?)endstream/g;
  while ((m = re.exec(raw)) !== null) { const by = Buffer.from(m[1], 'latin1');
    let c; try { c = zlib.inflateSync(by).toString('latin1'); } catch { c = by.toString('latin1'); }
    for (const t of c.matchAll(/<([0-9A-Fa-f\s]+)>|\((?:\\.|[^\\)])*\)/g))
      text += t[1] !== undefined ? Buffer.from(t[1].replace(/\s+/g, ''), 'hex').toString('latin1')
                                 : t[0].slice(1, -1).replace(/\\([()\\])/g, '$1'); } }
const says = (p) => text.replace(/\s+/g, '').includes(p.replace(/\s+/g, ''));
ok('the section is named', says('194-H'));
ok('the year-to-date basis is shown, so a smaller cheque is explicable',
   says('year-to-date aggregate'));
ok('and the advice states that GST is outside the TDS base',
   says('not part of the amount on which tax is deducted'));
ok('Form 16A is promised', says('Form 16A'));

console.log('\n=== PERMISSIONS AND TENANT SCOPE ===');
const readOnly = await workspace('c', ['view_brokers']);
const denied = await post(readOnly.token, '/api/broker-payouts', {
  periodStart: '2025-06-01', periodEnd: '2025-06-30',
});
ok('a read-only user cannot build a run', denied.status === 403, String(denied.status));

const salesHand = await workspace('d', ['view_brokers', 'manage_brokers']);
const noFinance = await api(salesHand.token, `/api/broker-payouts/${run1.id}`, {
  method: 'PATCH', body: JSON.stringify({ status: 'approved' }),
});
ok('building a run and approving it are different hands',
   noFinance.status === 403, String(noFinance.status));

const cross = await api(B.token, `/api/broker-payouts/${run1.id}`);
ok('another tenant gets 404', cross.status === 404, String(cross.status));
const crossList = await (await api(B.token, '/api/broker-payouts')).json();
ok('nor sees it in a list', !(crossList.runs ?? []).some(r => r.id === run1.id));

for (const w of [A, B, readOnly, salesHand]) await admin.query('DELETE FROM tenants WHERE id = $1', [w.tenantId]);
await admin.end();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
