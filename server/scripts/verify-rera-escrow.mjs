/**
 * RERA registration and the 70% designated-account rule (migration 042).
 *
 * WHAT IS BEING PROTECTED
 *
 * A statutory obligation with the promoter's registration attached to it.
 * Seventy per cent of everything realised from allottees must sit in a
 * separate account. Under-reporting the obligation is the dangerous
 * direction — it tells a promoter they are compliant when they are not — so
 * the arithmetic is asserted exactly and the split is asserted to reconstruct
 * the receipt to the paisa.
 *
 * The suite also pins the boundary: this feature MEASURES, it does not move
 * money. If a future change starts posting journals from here, these tests
 * will not catch it, and that is worth knowing while reading them.
 */
import pg from 'pg';
import argon2 from 'argon2';

const BASE = process.env.API_BASE ?? 'http://localhost:4055';
const PW = 'Test1234!';
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + (x ? '  -> ' + x : ''))); };

const admin = new pg.Client('postgres://postgres:postgres@localhost:5433/erp_test');
await admin.connect();

const MARK = 'RERA';
const clean = async () => {
  await admin.query(`DELETE FROM escrow_allocations WHERE project_id IN (SELECT id FROM projects WHERE name LIKE '${MARK}%')`);
  await admin.query(`DELETE FROM rera_registrations WHERE project_id IN (SELECT id FROM projects WHERE name LIKE '${MARK}%')`);
  await admin.query(`DELETE FROM payments WHERE payment_schedule_id IN (SELECT s.id FROM payment_schedules s JOIN bookings bk ON bk.id=s.booking_id JOIN leads l ON l.id=bk.lead_id WHERE l.name LIKE '${MARK}%')`);
  await admin.query(`DELETE FROM payment_schedules WHERE booking_id IN (SELECT bk.id FROM bookings bk JOIN leads l ON l.id=bk.lead_id WHERE l.name LIKE '${MARK}%')`);
  await admin.query(`DELETE FROM bookings WHERE lead_id IN (SELECT id FROM leads WHERE name LIKE '${MARK}%')`);
  await admin.query(`DELETE FROM leads WHERE name LIKE '${MARK}%'`);
  await admin.query(`DELETE FROM units WHERE project_id IN (SELECT id FROM projects WHERE name LIKE '${MARK}%')`);
  await admin.query(`DELETE FROM bank_transactions WHERE bank_account_id IN (SELECT id FROM bank_accounts WHERE account_name LIKE '${MARK}%')`);
  await admin.query(`DELETE FROM bank_accounts WHERE account_name LIKE '${MARK}%'`);
  await admin.query(`DELETE FROM projects WHERE name LIKE '${MARK}%'`);
  await admin.query(`DELETE FROM users WHERE email LIKE '${MARK.toLowerCase()}%@rera.test'`);
};
await clean();

const { rows: [t] } = await admin.query(`SELECT id FROM tenants WHERE slug='platform'`);
const hash = await argon2.hash(PW, { type: argon2.argon2id });
const mkUser = async (role, slug) => {
  const { rows: [r] } = await admin.query(`SELECT id FROM roles WHERE tenant_id=$1 AND name=$2`, [t.id, role]);
  await admin.query(
    `INSERT INTO users (tenant_id, role_id, name, email, password_hash, active, mfa_email_enabled)
     VALUES ($1,$2,'Rera Probe',$3,$4,true,false)`,
    [t.id, r.id, `${MARK.toLowerCase()}${slug}@rera.test`, hash]);
  const res = await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: `${MARK.toLowerCase()}${slug}@rera.test`, password: PW }) });
  const b = await res.json();
  if (!b?.token) throw new Error(`login ${slug}: ${res.status}`);
  return b.token;
};
const accountant = await mkUser('accountant', 'acct');
const sales      = await mkUser('sales_executive', 'sales');

const H = (tok) => ({ 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok });
const get  = (p, tok) => fetch(BASE + p, { headers: H(tok) });
const post = (p, tok, b) => fetch(BASE + p, { method: 'POST', headers: H(tok), body: JSON.stringify(b ?? {}) });

// ── The split, where numeric is exact ─────────────────────────────────────
console.log('\n=== THE SPLIT RECONSTRUCTS THE RECEIPT EXACTLY ===');
// Asserted in SQL, not JavaScript. 5444444.44 + 2333333.33 is 7777777.77 in
// numeric and 7777777.769999999 in a float — checking this in JS would report
// a failure that is the test's fault, which is precisely the class of bug the
// numeric arithmetic exists to avoid.
const { rows: splits } = await admin.query(`
  SELECT amt, s.escrow, s.free, (s.escrow + s.free = amt) AS exact
    FROM (VALUES (1000000::numeric),(33333.33),(0.01),(7777777.77),(999999.99)) v(amt),
         LATERAL escrow_split(v.amt, 70) s`);
ok('every split adds back to the receipt', splits.every(r => r.exact),
   splits.filter(r => !r.exact).map(r => r.amt).join(','));
ok('70% of 1000000 is 700000', Number(splits[0].escrow) === 700000, String(splits[0].escrow));

// ── Fixture: a registered project with receipts ───────────────────────────
const { rows: [proj] } = await admin.query(
  `INSERT INTO projects (tenant_id, name, city, location, status, rera_number)
   VALUES ($1,$2,'Pune','Baner','under_construction','P52100000001') RETURNING id`, [t.id, `${MARK} Tower`]);
const { rows: [unit] } = await admin.query(
  `INSERT INTO units (tenant_id, project_id, unit_code, floor, status)
   VALUES ($1,$2,'RERA-A-101',1,'sold') RETURNING id`, [t.id, proj.id]);
const { rows: [bank] } = await admin.query(
  `INSERT INTO bank_accounts (tenant_id, account_name, bank_name, opening_balance)
   VALUES ($1,$2,'HDFC',0) RETURNING id`, [t.id, `${MARK} Designated`]);
const { rows: [lead] } = await admin.query(
  `INSERT INTO leads (tenant_id,name,phone,source,stage,priority,last_contact_at)
   VALUES ($1,$2,'9800000061','Direct','booked','hot',now()) RETURNING id`, [t.id, `${MARK} Allottee`]);
const { rows: [bk] } = await admin.query(
  `INSERT INTO bookings (tenant_id, lead_id, unit_id, booking_amount, total_consideration, status)
   VALUES ($1,$2,$3,1000000,10000000,'active') RETURNING id`, [t.id, lead.id, unit.id]);
const { rows: [ms] } = await admin.query(
  `INSERT INTO payment_schedules (tenant_id, booking_id, milestone_name, sequence, percentage, amount, due_date, status)
   VALUES ($1,$2,'On Booking',1,10,1000000, CURRENT_DATE, 'pending') RETURNING id`, [t.id, bk.id]);
await admin.query(
  `INSERT INTO payments (tenant_id, payment_schedule_id, amount, payment_date, mode)
   VALUES ($1,$2,1000000,CURRENT_DATE,'bank_transfer')`, [t.id, ms.id]);

// ── Registration ──────────────────────────────────────────────────────────
console.log('\n=== REGISTERING A PROJECT ===');
const reg = await post('/api/rera/registrations', accountant,
  { projectId: proj.id, registeredOn: '2026-01-01', designatedBankAccountId: bank.id });
ok('a project can be registered', reg.status === 201, String(reg.status));
ok('the default ring-fence is 70%', (await reg.json()).registration.escrowPct === 70);

const tooLow = await post('/api/rera/registrations', accountant, { projectId: proj.id, escrowPct: 50 });
// Below the statute is not a preference, it is non-compliance.
ok('less than 70% is refused', tooLow.status === 400, String(tooLow.status));

const stricter = await post('/api/rera/registrations', accountant, { projectId: proj.id, escrowPct: 80 });
ok('a stricter ring-fence is allowed', stricter.status === 201, String(stricter.status));
await post('/api/rera/registrations', accountant, { projectId: proj.id, escrowPct: 70 });

const listed = (await (await get('/api/rera/registrations', accountant)).json()).registrations
  .find(r => r.projectId === proj.id);
ok('the registration number comes from the project', listed?.registrationNo === 'P52100000001', String(listed?.registrationNo));
ok('…and the designated account is named', !!listed?.designatedAccountName);

// ── Allocation ────────────────────────────────────────────────────────────
console.log('\n=== ALLOCATING THE OBLIGATION ===');
const alloc = await post('/api/rera/allocate', accountant, { projectId: proj.id });
ok('the receipt is allocated', alloc.status === 200 && (await alloc.json()).allocated === 1);

const row = (await admin.query(
  `SELECT * FROM escrow_allocations WHERE project_id=$1`, [proj.id])).rows[0];
ok('70% of 1000000 is owed to the designated account', Number(row.escrow_amount) === 700000, String(row.escrow_amount));
ok('…and 300000 is free', Number(row.free_amount) === 300000, String(row.free_amount));

// The idempotence that matters: a clerk pressing the button twice must not
// double a statutory obligation.
const again = await post('/api/rera/allocate', accountant, { projectId: proj.id });
ok('running it again allocates nothing new', (await again.json()).allocated === 0);
ok('…and the obligation did not double',
   (await admin.query(`SELECT count(*)::int n FROM escrow_allocations WHERE project_id=$1`, [proj.id])).rows[0].n === 1);

// ── The position ──────────────────────────────────────────────────────────
console.log('\n=== THE POSITION AN AUDITOR ASKS FOR ===');
const pos1 = (await (await get('/api/rera/position', accountant)).json()).position.find(p => p.projectId === proj.id);
ok('collected is the receipt', pos1?.collected === 1000000, String(pos1?.collected));
ok('required is 70% of it', pos1?.required === 700000, String(pos1?.required));
// An account with nothing recorded in it shows the whole obligation short —
// the money may be there, but nothing in the system says so.
ok('an unreconciled account shows the full shortfall', pos1?.shortfall === 700000, String(pos1?.shortfall));

await admin.query(
  `INSERT INTO bank_transactions (tenant_id, bank_account_id, txn_date, description, amount, txn_type)
   VALUES ($1,$2,CURRENT_DATE,'RERA sweep',700000,'credit')`, [t.id, bank.id]);
const pos2 = (await (await get('/api/rera/position', accountant)).json()).position.find(p => p.projectId === proj.id);
ok('recording the sweep clears the shortfall', pos2?.shortfall === 0, String(pos2?.shortfall));
ok('…and the account shows the money', pos2?.inAccount === 700000, String(pos2?.inAccount));

// ── Only registered projects carry the obligation ─────────────────────────
console.log('\n=== AN UNREGISTERED PROJECT OWES NOTHING ===');
const { rows: [plain] } = await admin.query(
  `INSERT INTO projects (tenant_id, name, city, location, status)
   VALUES ($1,$2,'Pune','Wakad','under_construction') RETURNING id`, [t.id, `${MARK} Unregistered`]);
const { rows: [u2] } = await admin.query(
  `INSERT INTO units (tenant_id, project_id, unit_code, floor, status)
   VALUES ($1,$2,'RERA-B-101',1,'sold') RETURNING id`, [t.id, plain.id]);
const { rows: [bk2] } = await admin.query(
  `INSERT INTO bookings (tenant_id, lead_id, unit_id, booking_amount, total_consideration, status)
   VALUES ($1,$2,$3,500000,5000000,'active') RETURNING id`, [t.id, lead.id, u2.id]);
const { rows: [ms2] } = await admin.query(
  `INSERT INTO payment_schedules (tenant_id, booking_id, milestone_name, sequence, percentage, amount, due_date, status)
   VALUES ($1,$2,'On Booking',1,10,500000, CURRENT_DATE, 'pending') RETURNING id`, [t.id, bk2.id]);
await admin.query(
  `INSERT INTO payments (tenant_id, payment_schedule_id, amount, payment_date, mode)
   VALUES ($1,$2,500000,CURRENT_DATE,'cheque')`, [t.id, ms2.id]);

await post('/api/rera/allocate', accountant, {});
ok('its receipt is not allocated',
   (await admin.query(`SELECT count(*)::int n FROM escrow_allocations WHERE project_id=$1`, [plain.id])).rows[0].n === 0);
ok('…and it does not appear in the position',
   !((await (await get('/api/rera/position', accountant)).json()).position.some(p => p.projectId === plain.id)));

// ── Permissions ───────────────────────────────────────────────────────────
console.log('\n=== WHO SEES THE ESCROW POSITION ===');
ok('a sales executive cannot', (await get('/api/rera/position', sales)).status === 403);
ok('…nor register a project', (await post('/api/rera/registrations', sales, { projectId: proj.id })).status === 403);
ok('the accountant can', (await get('/api/rera/position', accountant)).status === 200);

// ── The boundary this feature keeps ───────────────────────────────────────
console.log('\n=== IT MEASURES; IT DOES NOT MOVE MONEY ===');
// Stated as a test so a future change that starts posting is a failing
// assertion rather than a surprise in production.
ok('allocating posts no journal entries',
   (await admin.query(`SELECT count(*)::int n FROM journal_entries WHERE narration LIKE '%escrow%'`)).rows[0].n === 0);

await clean();
await admin.end();
console.log(`\n===== ${pass} passed, ${fail} failed =====`);
process.exit(fail ? 1 : 0);
