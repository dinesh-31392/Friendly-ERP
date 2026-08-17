/**
 * Smoke: leasing, CAM billing and owner payouts (migration 036).
 *
 * The four things that would actually cost a builder money if they were wrong,
 * and which no unit test against a mock can be wrong about:
 *
 *   1. Idempotent generation. The monthly rent run fires from a scheduler. If
 *      running it twice bills twice, every occupant is double-charged the first
 *      time a retry happens.
 *   2. Escalation arithmetic. "10% every 3 months" has to land on the right
 *      period, compounding, or the ledger silently drifts for years.
 *   3. One active lease per unit — the letting equivalent of the booking lock,
 *      enforced by a partial unique index under concurrency.
 *   4. Maker ≠ checker on owner payouts, in the DATABASE and not just the route.
 *
 * Plus the usual: field parity, derived-not-asserted paid amounts, and tenant
 * isolation.
 */
import pg from 'pg';
import argon2 from 'argon2';

// CI runs the API on 4055; API_BASE lets a developer point the suite at a
// second instance instead of stopping whatever is already on that port.
const BASE = process.env.API_BASE ?? 'http://localhost:4055';
const DB = process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5433/erp_test';
const PW = 'Test1234!';
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + (x ? '  -> ' + x : ''))); };
const money = (a, b) => Math.abs(Number(a) - Number(b)) < 0.01;

const admin = new pg.Client(DB);
await admin.connect();

const MARK = 'LEASE Smoke';

/**
 * Order matters: receipts → invoices → payouts → leases → occupants, then the
 * unit/tower/project. Leases hold DEFERRABLE references to units and occupants,
 * so a unit deleted while a lease still points at it fails at COMMIT.
 */
async function cleanup() {
  // Match leases by their PARTIES, not only by lease_code: one case below
  // deliberately omits the code so the server generates it, and a code-only
  // filter leaves that lease behind to block the occupant delete.
  const leases = `SELECT id FROM lease_agreements
                   WHERE lease_code LIKE 'LS-SMOKE%'
                      OR occupant_id IN (SELECT id FROM occupants WHERE name LIKE '${MARK}%')
                      OR unit_id IN (SELECT id FROM units WHERE unit_code LIKE 'LS-%')`;
  await admin.query(`DELETE FROM lease_receipts   WHERE lease_invoice_id IN (SELECT id FROM lease_invoices WHERE lease_id IN (${leases}))`);
  await admin.query(`DELETE FROM owner_payouts    WHERE lease_id IN (${leases})`);
  await admin.query(`DELETE FROM lease_invoices   WHERE lease_id IN (${leases})`);
  await admin.query(`DELETE FROM maintenance_bills
                      WHERE lease_id IN (${leases})
                         OR unit_id IN (SELECT id FROM units WHERE unit_code LIKE 'LS-%')
                         OR notes LIKE '${MARK}%'`);
  await admin.query(`DELETE FROM lease_agreements WHERE id IN (${leases})`);
  await admin.query(`DELETE FROM occupants  WHERE name LIKE '${MARK}%'`);
  await admin.query(`DELETE FROM units      WHERE unit_code LIKE 'LS-%'`);
  await admin.query(`DELETE FROM towers     WHERE name LIKE '${MARK}%'`);
  await admin.query(`DELETE FROM customers  WHERE name LIKE '${MARK}%'`);
  await admin.query(`DELETE FROM projects   WHERE name LIKE '${MARK}%'`);
}
await cleanup();

async function login(email) {
  await admin.query('UPDATE users SET password_hash=$1, active=true, mfa_email_enabled=false WHERE email=$2',
    [await argon2.hash(PW, { type: argon2.argon2id }), email]);
  const r = await (await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PW }),
  })).json();
  return r.token;
}

const tok = await login('admin@erptest.local');
if (!tok) { console.error('login failed'); process.exit(1); }
const H = { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` };

const post  = async (p, b, h = H) => { const r = await fetch(BASE + p, { method: 'POST',  headers: h, body: JSON.stringify(b ?? {}) }); return { status: r.status, body: await r.json().catch(() => null) }; };
const patch = async (p, b, h = H) => { const r = await fetch(BASE + p, { method: 'PATCH', headers: h, body: JSON.stringify(b) });       return { status: r.status, body: await r.json().catch(() => null) }; };
const get   = async (p, h = H) => (await (await fetch(BASE + p, { headers: h })).json());

// ── Prerequisites: a project, a tower, a 1,000 sqft unit, an owner ──────────
console.log('\n=== FIXTURES ===');
const project = (await post('/api/projects', { name: `${MARK} Riverside`, city: 'Pune' })).body?.project;
const tower   = (await post('/api/towers', { projectId: project.id, name: `${MARK} Tower A`, floors: 10, unitsPerFloor: 4 })).body?.tower;
// area 1000 sqft makes every CAM figure checkable by eye: rate × 1000.
const unit    = (await post('/api/units', { towerId: tower.id, number: 'LS-1201', type: 'Apartment', configuration: '2 BHK', floorNumber: 12, area: 1000, price: 9500000 })).body?.unit;
const unit2   = (await post('/api/units', { towerId: tower.id, number: 'LS-1202', type: 'Apartment', configuration: '3 BHK', floorNumber: 12, area: 1500, price: 12500000 })).body?.unit;
const owner   = (await post('/api/customers', { name: `${MARK} Mr Landlord`, phone: '9876500001' })).body?.customer;
ok('project, tower, two units and an owner exist', !!project?.id && !!tower?.id && !!unit?.id && !!unit2?.id && !!owner?.id,
  JSON.stringify({ p: project?.id, t: tower?.id, u: unit?.id, o: owner?.id }));

// ── Occupants ───────────────────────────────────────────────────────────────
console.log('\n=== OCCUPANT ===');
const occDraft = {
  name: `${MARK} Anita Rao`, email: 'anita.rao@example.test', phone: '9876500002',
  occupantType: 'individual', kycStatus: 'verified',
};
const occRes = await post('/api/occupants', occDraft);
const occupant = occRes.body?.occupant;
ok('occupant created (201)', occRes.status === 201 && !!occupant?.id, `${occRes.status} ${JSON.stringify(occRes.body)?.slice(0, 140)}`);
const occMisses = Object.entries(occDraft)
  .filter(([k, v]) => occupant?.[k] !== v)
  .map(([k, v]) => `${k}: sent ${JSON.stringify(v)} got ${JSON.stringify(occupant?.[k])}`);
ok('every occupant field round-trips', occMisses.length === 0, occMisses.join(' | '));
ok('occupant visible immediately', ((await get('/api/occupants')).occupants || []).some(o => o.id === occupant?.id));

// ── Lease agreement ─────────────────────────────────────────────────────────
console.log('\n=== LEASE AGREEMENT ===');
const leaseDraft = {
  unitId: unit.id, occupantId: occupant.id, ownerCustomerId: owner.id,
  leaseCode: 'LS-SMOKE-001',
  startDate: '2026-01-01', endDate: '2026-12-31',
  rentAmount: 40000, depositAmount: 240000,
  escalationPercent: 10, escalationMonths: 3,
  camRatePerSqft: 3, camBilledTo: 'occupant',
  managementFeePercent: 10, noticePeriodDays: 60,
};
const leaseRes = await post('/api/leases', leaseDraft);
const lease = leaseRes.body?.lease;
ok('lease created (201)', leaseRes.status === 201 && !!lease?.id, `${leaseRes.status} ${JSON.stringify(leaseRes.body)?.slice(0, 180)}`);
const leaseMisses = Object.entries(leaseDraft).filter(([k, v]) => {
  const got = lease?.[k];
  return typeof v === 'number' ? Number(got) !== v : got !== v;
}).map(([k, v]) => `${k}: sent ${JSON.stringify(v)} got ${JSON.stringify(lease?.[k])}`);
ok('every lease field round-trips', leaseMisses.length === 0, leaseMisses.join(' | '));
ok('a new lease starts as a draft', lease?.status === 'draft', String(lease?.status));
ok('createdBy stamped', !!lease?.createdBy);

// An unsigned lease must not bill.
const earlyGen = await post(`/api/leases/${lease.id}/generate-invoices`, { through: '2026-06-30' });
ok('a draft lease cannot be invoiced (409)', earlyGen.status === 409, `${earlyGen.status} ${JSON.stringify(earlyGen.body)?.slice(0, 120)}`);

// Bad dates are refused by the database CHECK, surfaced as a 400.
const badDates = await post('/api/leases', { ...leaseDraft, leaseCode: 'LS-SMOKE-BAD', startDate: '2026-12-31', endDate: '2026-01-01' });
ok('end before start rejected (400)', badDates.status === 400, `${badDates.status}`);

// Auto-generated lease code when the caller does not supply one.
const autoCode = await post('/api/leases', {
  unitId: unit2.id, occupantId: occupant.id, startDate: '2026-03-01', endDate: '2027-02-28', rentAmount: 55000,
});
ok('lease code auto-generated when omitted', autoCode.status === 201 && /^L-\d{4}-[A-Z0-9]{6}$/.test(autoCode.body?.lease?.leaseCode || ''),
  String(autoCode.body?.lease?.leaseCode));

const activate = await patch(`/api/leases/${lease.id}`, { status: 'active' });
ok('lease activates', activate.status === 200 && activate.body?.lease?.status === 'active', `${activate.status}`);

// ── The letting lock ────────────────────────────────────────────────────────
console.log('\n=== ONE ACTIVE LEASE PER UNIT ===');
const rival = await post('/api/leases', {
  unitId: unit.id, occupantId: occupant.id, leaseCode: 'LS-SMOKE-DUP',
  startDate: '2026-06-01', endDate: '2027-05-31', rentAmount: 45000, status: 'active',
});
ok('a second ACTIVE lease on the same unit is refused (409)', rival.status === 409, `${rival.status} ${JSON.stringify(rival.body)?.slice(0, 120)}`);
const draftToo = await post('/api/leases', {
  unitId: unit.id, occupantId: occupant.id, leaseCode: 'LS-SMOKE-DRAFT2',
  startDate: '2027-01-01', endDate: '2027-12-31', rentAmount: 48000,
});
ok('a competing DRAFT is still allowed (negotiating is not letting)', draftToo.status === 201, `${draftToo.status}`);

// ── Rent generation, escalation, idempotency ────────────────────────────────
console.log('\n=== RENT GENERATION ===');
const gen1 = await post(`/api/leases/${lease.id}/generate-invoices`, { through: '2026-12-31' });
ok('generation returns 201', gen1.status === 201, `${gen1.status} ${JSON.stringify(gen1.body)?.slice(0, 160)}`);
ok('12 monthly invoices for a 12-month lease', gen1.body?.created === 12, String(gen1.body?.created));

const gen2 = await post(`/api/leases/${lease.id}/generate-invoices`, { through: '2026-12-31' });
ok('re-running creates NOTHING (idempotent)', gen2.body?.created === 0, String(gen2.body?.created));
const allInv = ((await get(`/api/lease-invoices?leaseId=${lease.id}`)).leaseInvoices || [])
  .slice().sort((a, b) => String(a.periodStart).localeCompare(String(b.periodStart)));
ok('still exactly 12 invoices after the second run', allInv.length === 12, String(allInv.length));

// Periods run on anniversaries of the start date and never past the end date.
ok('first period starts on the lease start date', String(allInv[0]?.periodStart).startsWith('2026-01-01'), String(allInv[0]?.periodStart));
ok('last period ends on the lease end date', String(allInv[11]?.periodEnd).startsWith('2026-12-31'), String(allInv[11]?.periodEnd));

// 10% every 3 months, compounding: months 1-3 @ 40000, 4-6 @ 44000,
// 7-9 @ 48400, 10-12 @ 53240.
ok('months 1-3 charge the base rent',      money(allInv[0].rentAmount, 40000) && money(allInv[2].rentAmount, 40000), `${allInv[0]?.rentAmount}/${allInv[2]?.rentAmount}`);
ok('months 4-6 escalate once (44,000)',    money(allInv[3].rentAmount, 44000), String(allInv[3]?.rentAmount));
ok('months 7-9 compound twice (48,400)',   money(allInv[6].rentAmount, 48400), String(allInv[6]?.rentAmount));
ok('months 10-12 compound thrice (53,240)', money(allInv[9].rentAmount, 53240), String(allInv[9]?.rentAmount));

// CAM billed to the occupant rides on the rent invoice: 1000 sqft × ₹3.
ok('occupant-billed CAM is on the invoice (₹3,000)', money(allInv[0].camAmount, 3000), String(allInv[0]?.camAmount));
ok('total = rent + CAM', money(allInv[0].totalAmount, 43000), String(allInv[0]?.totalAmount));
ok('no owner CAM bill was raised for an occupant-billed lease',
  ((await get(`/api/maintenance-bills?leaseId=${lease.id}`)).maintenanceBills || []).length === 0);

// A horizon shorter than the lease bills only up to it.
const shortLease = (await post('/api/leases', {
  unitId: unit2.id, occupantId: occupant.id, ownerCustomerId: owner.id, leaseCode: 'LS-SMOKE-CAM',
  startDate: '2026-01-01', endDate: '2026-12-31', rentAmount: 30000,
  camRatePerSqft: 2, camBilledTo: 'owner', managementFeePercent: 5, status: 'active',
})).body?.lease;
const camGen = await post(`/api/leases/${shortLease.id}/generate-invoices`, { through: '2026-03-31' });
ok('horizon caps generation (3 of 12 periods)', camGen.body?.created === 3, String(camGen.body?.created));
const camBills = (await get(`/api/maintenance-bills?leaseId=${shortLease.id}`)).maintenanceBills || [];
ok('owner-billed CAM becomes a maintenance bill, not an invoice line', camBills.length === 3, String(camBills.length));
ok('CAM bill amount = area × rate (1500 × ₹2 = ₹3,000)', money(camBills[0]?.amount, 3000), String(camBills[0]?.amount));
ok('CAM bill is addressed to the owner', camBills[0]?.billTo === 'owner' && camBills[0]?.ownerCustomerId === owner.id);
const camInv = ((await get(`/api/lease-invoices?leaseId=${shortLease.id}`)).leaseInvoices || [])[0];
ok('owner-billed CAM is NOT double-charged on the rent invoice', money(camInv?.camAmount, 0), String(camInv?.camAmount));

// ── Receipts: paid amounts are derived, never asserted ──────────────────────
console.log('\n=== RECEIPTS ===');
const inv1 = allInv[0];
const part = await post('/api/lease-receipts', { leaseInvoiceId: inv1.id, amount: 20000, mode: 'upi', referenceNo: 'UPI-1' });
ok('receipt accepted (201)', part.status === 201, `${part.status} ${JSON.stringify(part.body)?.slice(0, 140)}`);
ok('invoice flips to partially_paid by trigger', part.body?.leaseInvoice?.status === 'partially_paid', String(part.body?.leaseInvoice?.status));
ok('amountPaid tracks the receipt', money(part.body?.leaseInvoice?.amountPaid, 20000), String(part.body?.leaseInvoice?.amountPaid));

const rest = await post('/api/lease-receipts', { leaseInvoiceId: inv1.id, amount: 23000, mode: 'bank_transfer', referenceNo: 'NEFT-9' });
ok('settling the balance marks it paid', rest.body?.leaseInvoice?.status === 'paid', String(rest.body?.leaseInvoice?.status));
ok('amountPaid equals the total', money(rest.body?.leaseInvoice?.amountPaid, 43000), String(rest.body?.leaseInvoice?.amountPaid));

const zero = await post('/api/lease-receipts', { leaseInvoiceId: inv1.id, amount: 0 });
ok('a zero-value receipt is refused (400)', zero.status === 400, `${zero.status}`);

// ── Owner payouts ───────────────────────────────────────────────────────────
console.log('\n=== OWNER PAYOUTS ===');
const payGen = await post('/api/owner-payouts/generate', { through: '2026-12-31', leaseId: lease.id });
ok('payout generation returns 201', payGen.status === 201, `${payGen.status} ${JSON.stringify(payGen.body)?.slice(0, 160)}`);
ok('only periods with money collected produce a payout', payGen.body?.generated === 1, String(payGen.body?.generated));
const payout = payGen.body?.ownerPayouts?.[0];
ok('gross = what was COLLECTED, not what was invoiced', money(payout?.grossCollected, 43000), String(payout?.grossCollected));
ok('management fee is 10% of collections (₹4,300)', money(payout?.managementFeeAmount, 4300), String(payout?.managementFeeAmount));
ok('net payable = gross − fee (₹38,700)', money(payout?.netPayable, 38700), String(payout?.netPayable));
ok('a fresh payout is pending and unapproved', payout?.status === 'pending' && !payout?.approvedBy);

// A deduction flows through the generated column.
const deducted = await patch(`/api/owner-payouts/${payout.id}`, { otherDeductions: 2500 });
ok('deduction reduces the net (₹36,200)', money(deducted.body?.ownerPayout?.netPayable, 36200), String(deducted.body?.ownerPayout?.netPayable));

// Paid is downstream of approved.
const jump = await patch(`/api/owner-payouts/${payout.id}`, { status: 'paid' });
ok('cannot mark paid before approval (409)', jump.status === 409, `${jump.status} ${JSON.stringify(jump.body)?.slice(0, 120)}`);

// ── Maker ≠ checker ─────────────────────────────────────────────────────────
console.log('\n=== MAKER / CHECKER ===');
const acctTok = await login('acct@erptest.local');
const AH = { 'Content-Type': 'application/json', Authorization: `Bearer ${acctTok}` };
if (acctTok) {
  const acctGen = await post('/api/owner-payouts/generate', { through: '2026-12-31' }, AH);
  ok('accountant CAN prepare payouts', acctGen.status === 201, `${acctGen.status}`);
  const acctApprove = await patch(`/api/owner-payouts/${payout.id}`, { status: 'approved' }, AH);
  ok('accountant CANNOT approve one (403)', acctApprove.status === 403, `${acctApprove.status} ${JSON.stringify(acctApprove.body)?.slice(0, 120)}`);
  ok('403 names the missing permission', String(acctApprove.body?.error || '').includes('approve_owner_payouts'), String(acctApprove.body?.error));
} else {
  ok('accountant login', false, 'could not log in as acct@erptest.local');
}

const approve = await patch(`/api/owner-payouts/${payout.id}`, { status: 'approved' });
ok('admin approves', approve.status === 200 && approve.body?.ownerPayout?.status === 'approved', `${approve.status}`);
ok('approval stamps who and when', !!approve.body?.ownerPayout?.approvedBy && !!approve.body?.ownerPayout?.approvedAt);

// An approved statement must not move underneath the approver.
await post('/api/lease-receipts', { leaseInvoiceId: allInv[1].id, amount: 1000, mode: 'cash' });
const regen = await post('/api/owner-payouts/generate', { through: '2026-12-31', leaseId: lease.id });
const frozen = (await get(`/api/owner-payouts?leaseId=${lease.id}`)).ownerPayouts.find(p => p.id === payout.id);
ok('an approved payout is frozen against regeneration', money(frozen?.grossCollected, 43000), String(frozen?.grossCollected));
ok('the newly-collected period gets its own payout', regen.body?.generated >= 1, String(regen.body?.generated));

const paid = await patch(`/api/owner-payouts/${payout.id}`, { status: 'paid', paymentReference: 'NEFT-OWNER-77' });
ok('approved → paid succeeds', paid.status === 200 && paid.body?.ownerPayout?.status === 'paid', `${paid.status}`);
ok('payment reference and paidAt recorded', paid.body?.ownerPayout?.paymentReference === 'NEFT-OWNER-77' && !!paid.body?.ownerPayout?.paidAt);

// Sending it back to pending must not leave a stale approval on the record.
const reopened = await patch(`/api/owner-payouts/${payout.id}`, { status: 'pending' });
ok('reverting to pending clears the approval stamp', !reopened.body?.ownerPayout?.approvedBy, String(reopened.body?.ownerPayout?.approvedBy));

// ── Owner statement ─────────────────────────────────────────────────────────
console.log('\n=== OWNER STATEMENT ===');
const stmt = await get(`/api/owner-payouts/statement/${owner.id}`);
ok('statement returns this owner\'s payouts', Array.isArray(stmt?.ownerPayouts) && stmt.ownerPayouts.length >= 1, JSON.stringify(stmt?.totals));
ok('statement totals add up', money(stmt?.totals?.netPayable,
  stmt.ownerPayouts.reduce((s, p) => s + p.netPayable, 0)), JSON.stringify(stmt?.totals));

// ── Tenant isolation ────────────────────────────────────────────────────────
console.log('\n=== TENANT ISOLATION ===');
const rivalTok = await login('admin@rivaltest.local');
if (rivalTok) {
  const RH = { 'Content-Type': 'application/json', Authorization: `Bearer ${rivalTok}` };
  const rl = (await get('/api/leases', RH)).leases || [];
  ok('rival sees 0 of our leases', !rl.some(l => l.id === lease.id), `saw ${rl.length}`);
  const ro = (await get('/api/occupants', RH)).occupants || [];
  ok('rival sees 0 of our occupants', !ro.some(o => o.id === occupant.id));
  const ri = (await get('/api/lease-invoices', RH)).leaseInvoices || [];
  ok('rival sees 0 of our rent invoices', !ri.some(i => i.id === inv1.id));
  const rp = (await get('/api/owner-payouts', RH)).ownerPayouts || [];
  ok('rival sees 0 of our owner payouts', !rp.some(p => p.id === payout.id));
  const rm = (await get('/api/maintenance-bills', RH)).maintenanceBills || [];
  ok('rival sees 0 of our CAM bills', !rm.some(b => b.id === camBills[0]?.id));
  // A cross-tenant write must fail on the FK, not merely be invisible.
  const steal = await post('/api/leases', {
    unitId: unit.id, occupantId: occupant.id, leaseCode: 'LS-SMOKE-STEAL',
    startDate: '2026-01-01', endDate: '2026-12-31', rentAmount: 1,
  }, RH);
  ok('rival cannot write a lease against our unit', steal.status >= 400, `${steal.status}`);
} else {
  ok('rival login', false, 'could not log in as admin@rivaltest.local');
}

await cleanup();
await admin.end();
console.log(`\n===== ${pass} passed, ${fail} failed =====`);
process.exit(fail ? 1 : 0);
