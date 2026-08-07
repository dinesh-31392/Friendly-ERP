/**
 * Smoke: the Accounts page's server surface — RA bills (with the 024 parity
 * fields and the two-stage approval trail), AP payment, banking + reconcile,
 * and loans with an amortisation schedule.
 */
import pg from 'pg';
import argon2 from 'argon2';

const BASE = 'http://localhost:4055';
const PW = 'Test1234!';
const PLATFORM = 'ed3c4904-829a-4e10-ad91-e17992f400b0';
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + (x ? '  -> ' + x : ''))); };

const admin = new pg.Client('postgres://postgres:postgres@localhost:5433/erp_test');
await admin.connect();
await admin.query('UPDATE users SET password_hash=$1, active=true WHERE email=$2',
  [await argon2.hash(PW, { type: argon2.argon2id }), 'admin@erptest.local']);
const project = (await admin.query('SELECT id FROM projects WHERE tenant_id=$1 LIMIT 1', [PLATFORM])).rows[0].id;

const MARK = 'ACCT Smoke';
async function cleanup() {
  await admin.query(`DELETE FROM payments_made WHERE contractor_ra_bill_id IN (SELECT r.id FROM contractor_ra_bills r JOIN vendors v ON v.id=r.vendor_id WHERE v.name LIKE '${MARK}%')`);
  await admin.query(`DELETE FROM contractor_ra_bills WHERE vendor_id IN (SELECT id FROM vendors WHERE name LIKE '${MARK}%')`);
  await admin.query(`DELETE FROM vendors WHERE name LIKE '${MARK}%'`);
  await admin.query(`DELETE FROM bank_transactions WHERE bank_account_id IN (SELECT id FROM bank_accounts WHERE account_name LIKE '${MARK}%')`);
  await admin.query(`DELETE FROM bank_accounts WHERE account_name LIKE '${MARK}%'`);
  await admin.query(`DELETE FROM loan_repayment_schedule WHERE loan_id IN (SELECT id FROM loans WHERE lender_name LIKE '${MARK}%')`);
  await admin.query(`DELETE FROM loans WHERE lender_name LIKE '${MARK}%'`);
}
await cleanup();

const tok = (await (await fetch(`${BASE}/api/auth/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'admin@erptest.local', password: PW }),
})).json()).token;
if (!tok) { console.error('login failed'); process.exit(1); }
const H = { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` };

const post = async (p, b) => { const r = await fetch(BASE + p, { method: 'POST', headers: H, body: JSON.stringify(b) }); return { status: r.status, body: await r.json().catch(() => null) }; };
const patch = async (p, b) => { const r = await fetch(BASE + p, { method: 'PATCH', headers: H, body: JSON.stringify(b) }); return { status: r.status, body: await r.json().catch(() => null) }; };
const get = async (p) => (await (await fetch(BASE + p, { headers: H })).json());

// ── RA bills ────────────────────────────────────────────────────────────────
console.log('\n=== RA BILLS (024 parity + approval trail) ===');
const contractor = (await post('/api/vendors', { name: `${MARK} Contractor`, vendorType: 'contractor' })).body.vendor;
ok('contractor created', !!contractor?.id);

const raRes = await post('/api/ra-bills', {
  vendorId: contractor.id, projectId: project,
  workProgressPercentage: 62, grossAmount: 1200000, retentionAmount: 60000,
  deductions: [{ label: 'TDS 2%', amount: 24000 }],
  // Claiming above the site's logged progress — the override pair is the audit trail.
  siteProgressPercentage: 55, overrideReason: 'Slab poured, DPR pending upload',
  notes: 'Tower B, 6th slab',
});
const ra = raRes.body?.raBill;
ok('RA created (201)', raRes.status === 201 && !!ra?.id, `${raRes.status}`);
ok('RA number assigned by server', ra?.raNumber >= 1, String(ra?.raNumber));
ok('net payable = gross - retention - deductions', ra?.netPayable === 1200000 - 60000 - 24000, String(ra?.netPayable));
ok('override pair persisted', ra?.siteProgressPercentage === 55 && ra?.overrideReason === 'Slab poured, DPR pending upload',
  JSON.stringify({ s: ra?.siteProgressPercentage, r: ra?.overrideReason }));
ok('notes persisted', ra?.notes === 'Tower B, 6th slab', String(ra?.notes));
ok('createdBy stamped', !!ra?.createdBy);

const listed = (await get('/api/ra-bills')).raBills || [];
ok('RA visible immediately after 201', listed.some(r => r.id === ra?.id), `listed ${listed.length}`);

const site = await patch(`/api/ra-bills/${ra.id}`, { status: 'pmc_approved' });
ok('site sign-off stamps signedOffAt', site.status === 200 && !!site.body?.raBill?.signedOffAt, JSON.stringify(site.body)?.slice(0, 120));
ok('site sign-off stamps approver', !!site.body?.raBill?.pmcApprovedBy);

const fin = await patch(`/api/ra-bills/${ra.id}`, { status: 'finance_approved' });
ok('finance approval stamps financeApprovedAt', fin.status === 200 && !!fin.body?.raBill?.financeApprovedAt);
ok('site sign-off timestamp NOT overwritten', fin.body?.raBill?.signedOffAt === site.body?.raBill?.signedOffAt);

const payRes = await post('/api/ap-payments', { vendorBillId: undefined, raBillId: ra.id, amount: ra.netPayable, mode: 'bank_transfer', referenceNo: 'UTR-ACCT-1' });
ok('AP payment recorded (201)', payRes.status === 201, `${payRes.status} ${JSON.stringify(payRes.body)?.slice(0, 120)}`);
const afterPay = ((await get('/api/ra-bills')).raBills || []).find(r => r.id === ra.id);
ok('paying the RA flips it to paid', afterPay?.status === 'paid', String(afterPay?.status));

// ── Banking ─────────────────────────────────────────────────────────────────
console.log('\n=== BANKING ===');
const bankRes = await post('/api/bank-accounts', { accountName: `${MARK} HDFC Current`, bankName: 'HDFC', accountNumber: 'XXXX4471', openingBalance: 500000 });
const bank = bankRes.body?.account;
ok('bank account created', bankRes.status === 201 && !!bank?.id, `${bankRes.status}`);
ok('bank visible immediately', ((await get('/api/bank-accounts')).accounts || []).some(a => a.id === bank?.id));

const txnRes = await post('/api/bank-transactions', { bankAccountId: bank.id, txnDate: '2026-08-01', description: 'NEFT contractor', amount: 250000, type: 'debit' });
const txn = txnRes.body?.transaction;
ok('bank txn created', txnRes.status === 201 && !!txn?.id, `${txnRes.status}`);
ok('txn starts unreconciled', txn?.reconciled === false);

const je = (await get('/api/journal-entries')).entries?.[0];
const recRes = await patch(`/api/bank-transactions/${txn.id}`, { reconciled: true, matchedJournalEntryId: je?.id });
ok('reconcile marks matched', recRes.status === 200 && recRes.body?.transaction?.reconciled === true, `${recRes.status}`);

// ── Loans ───────────────────────────────────────────────────────────────────
console.log('\n=== LOANS ===');
const loanRes = await post('/api/loans', {
  lenderName: `${MARK} HDFC Bank`, projectId: project, loanType: 'term_loan',
  principalAmount: 10000000, interestRate: 9.5, startDate: '2026-08-01',
  tenureMonths: 24, tdsPct: 10,
});
const loan = loanRes.body?.loan;
ok('loan created (201)', loanRes.status === 201 && !!loan?.id, `${loanRes.status}`);
ok('tenureMonths persisted', loan?.tenureMonths === 24, String(loan?.tenureMonths));
ok('tdsPct persisted', Number(loan?.tdsPct) === 10, String(loan?.tdsPct));

const schedRes = await post(`/api/loans/${loan.id}/schedule`, {
  installments: Array.from({ length: 3 }, (_, i) => ({
    installmentNo: i + 1, dueDate: [`2026-09-01`, `2026-10-01`, `2026-11-01`][i],
    principalComponent: 400000, interestComponent: 79166, tdsDeducted: 7916,
  })),
});
const sched = schedRes.body?.schedule || schedRes.body?.repayments || [];
ok('schedule created', (schedRes.status === 201 || schedRes.status === 200) && sched.length === 3, `${schedRes.status} n=${sched.length}`);

const first = sched[0];
const emiRes = first ? await patch(`/api/loan-repayments/${first.id}`, { status: 'paid' }) : { status: 0 };
ok('EMI marked paid', emiRes.status === 200 && emiRes.body?.installment?.status === 'paid', `${emiRes.status} ${JSON.stringify(emiRes.body)?.slice(0, 100)}`);

const reread = await get(`/api/loans/${loan.id}/schedule`);
const rows = reread.schedule || reread.repayments || [];
ok('paid status persisted', rows.find(r => r.installmentNo === 1)?.status === 'paid');

// ── tenant isolation ────────────────────────────────────────────────────────
console.log('\n=== TENANT ISOLATION ===');
await admin.query('UPDATE users SET password_hash=$1, active=true WHERE email=$2',
  [await argon2.hash(PW, { type: argon2.argon2id }), 'badmin@rival.test']);
const rivalTok = (await (await fetch(`${BASE}/api/auth/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'badmin@rival.test', password: PW }),
})).json()).token;
if (rivalTok) {
  const RH = { Authorization: `Bearer ${rivalTok}` };
  const rivalRas = (await (await fetch(`${BASE}/api/ra-bills`, { headers: RH })).json()).raBills || [];
  ok('rival sees 0 of our RA bills', !rivalRas.some(r => r.id === ra.id), `saw ${rivalRas.length}`);
  const rivalLoans = (await (await fetch(`${BASE}/api/loans`, { headers: RH })).json()).loans || [];
  ok('rival sees 0 of our loans', !rivalLoans.some(l => l.id === loan.id));
  const rivalBanks = (await (await fetch(`${BASE}/api/bank-accounts`, { headers: RH })).json()).accounts || [];
  ok('rival sees 0 of our bank accounts', !rivalBanks.some(a => a.id === bank.id));
} else {
  ok('rival login', false, 'could not log in as rival tenant');
}

await cleanup();
await admin.end();
console.log(`\n===== ${pass} passed, ${fail} failed =====`);
process.exit(fail ? 1 : 0);
