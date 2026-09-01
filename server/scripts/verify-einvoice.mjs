/**
 * E-invoicing — the IRN, and the scope rule people get wrong.
 *
 * WHAT THIS IS FOR
 *
 * An invoice above the turnover threshold must be registered with the Invoice
 * Registration Portal before it is issued. Without an IRN it is not a valid tax
 * invoice and the buyer cannot claim input credit against it.
 *
 * THE ASSERTIONS THAT MATTER
 *
 * Scope. E-invoicing covers B2B, SEZ, exports and deemed exports — never B2C.
 * A flat sold to an individual with no GSTIN gets no IRN however large the
 * consideration, and generating one anyway is a registration the portal
 * rejects. That refusal is asserted here rather than assumed.
 *
 * The IRN itself. It is a SHA-256 over supplier GSTIN, financial year, document
 * type and document number — and the financial year is India's, turning on
 * 1 April, so a January invoice belongs to the year that began the previous
 * April. Get the year wrong and the hash is wrong.
 *
 * Deriving it locally is the point: the portal returns an IRN, and comparing it
 * against the one this computes catches a response crossed with another
 * invoice HERE, rather than at the buyer's credit claim months later.
 *
 * And the 24-hour window, which is hard. Past it the portal will not cancel and
 * the only remedy is a credit note.
 */
import pg from 'pg';
import argon2 from 'argon2';
import { createHash } from 'node:crypto';

const BASE = process.env.API_BASE ?? 'http://localhost:4055';
const PW = 'Test1234!';
const MARK = 'ein' + Math.random().toString(36).slice(2, 7);
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + (x ? '  -> ' + x : ''))); };

const admin = new pg.Client(process.env.DATABASE_ADMIN_URL
  ?? 'postgres://postgres:postgres@localhost:5433/erp_test');
await admin.connect();

// Real, checksum-valid GSTINs. 27 = Maharashtra, 29 = Karnataka.
const SUPPLIER_GSTIN = '27AAPFU0939F1ZV';
const BUYER_MH_GSTIN = '27AACCM9910C1ZN';

// The core stages. Lead writes are validated against the ACTIVE pipeline, so a
// tenant without one cannot hold a lead at any stage.
const PIPELINE = { stages: [
  { key: 'new', id: 'new', label: 'New', color: 'bg-blue-500', core: true },
  { key: 'contacted', id: 'contacted', label: 'Contacted', color: 'bg-indigo-500', core: true },
  { key: 'qualified', id: 'qualified', label: 'Qualified', color: 'bg-violet-500', core: true },
  { key: 'site_visit', id: 'site_visit', label: 'Site Visit', color: 'bg-amber-500', core: true },
  { key: 'negotiation', id: 'negotiation', label: 'Negotiation', color: 'bg-orange-500', core: true },
  { key: 'booked', id: 'booked', label: 'Booked', color: 'bg-emerald-500', core: true },
  { key: 'lost', id: 'lost', label: 'Lost', color: 'bg-red-400', core: true },
] };

async function workspace(slug, perms, { gstin = SUPPLIER_GSTIN, state = '27' } = {}) {
  const t = (await admin.query(
    `INSERT INTO tenants (name, company, slug, email, gstin, state_code, address, city, pincode)
     VALUES ($1,$1,$2,$3,$4,$5,'1 Marine Drive','Mumbai','400020') RETURNING id`,
    [`${MARK} ${slug}`, `${MARK}-${slug}`, `${MARK}-${slug}@ein.test`, gstin, state])).rows[0];
  // A tenant with no active pipeline is not merely incomplete: lead stage
  // validation refuses every write against it, and the suites that enumerate
  // tenants (golive, cascade, merge) then fail naming a workspace they did not
  // create. Suites that mint tenants directly must seed one, exactly as
  // seed-test-fixtures does.
  await admin.query(
    `INSERT INTO schema_definitions (tenant_id, entity, kind, version, is_active, definition)
     VALUES ($1,'lead','pipeline',1,true,$2)
     ON CONFLICT (tenant_id, entity, kind, version)
     DO UPDATE SET definition = EXCLUDED.definition, is_active = true`,
    [t.id, JSON.stringify(PIPELINE)]);
  const role = (await admin.query(
    `INSERT INTO roles (tenant_id, name, is_system) VALUES ($1,'Accounts',false) RETURNING id`, [t.id])).rows[0];
  if (perms.length) {
    await admin.query(
      `INSERT INTO role_permissions (role_id, permission_key)
       SELECT $1, k FROM unnest($2::text[]) k ON CONFLICT DO NOTHING`, [role.id, perms]);
  }
  const email = `${MARK}-${slug}@ein.test`;
  await admin.query(
    `INSERT INTO users (tenant_id, role_id, name, email, password_hash, active)
     VALUES ($1,$2,'Accounts',$3,$4,true)`,
    [t.id, role.id, email, await argon2.hash(PW, { type: argon2.argon2id })]);
  const token = (await (await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PW }),
  })).json()).token;
  if (!token) throw new Error(`login failed for ${email}`);
  return { tenantId: t.id, token };
}

const invoice = async (w, { no, date, name, amount }) => (await admin.query(
  `INSERT INTO invoices (tenant_id, lead_name, project, type, amount, issue_date, due_date, status, invoice_no)
   VALUES ($1,$2,'Skyline','Demand',$3,$4::date,$4::date,'Pending',$5) RETURNING id`,
  [w.tenantId, name, amount, date, no])).rows[0].id;

const api = (token, path, init = {}) => fetch(BASE + path, {
  ...init,
  headers: { ...(init.body ? { 'Content-Type': 'application/json' } : {}), Authorization: `Bearer ${token}` },
});
const post = (token, path, body) => api(token, path, { method: 'POST', body: JSON.stringify(body) });
const get = (token, path) => api(token, path);

const A = await workspace('a', ['view_finance', 'manage_finance', 'view_leads', 'manage_leads']);
const B = await workspace('b', ['view_finance', 'manage_finance']);

// ── the financial year, which decides the hash ──────────────────────────────
console.log('\n=== INDIA\'S FINANCIAL YEAR TURNS ON 1 APRIL ===');
const irnOf = (gstin, fy, typ, no) =>
  createHash('sha256').update(`${gstin}${fy}${typ}${no}`, 'utf8').digest('hex');

const janInv = await invoice(A, { no: `INV-${MARK}J`, date: '2027-01-15', name: 'Jan Buyer', amount: 500000 });
await post(A.token, `/api/invoices/${janInv}/tax`, {
  taxableValue: 500000, gstRate: 5, placeOfSupply: '27', customerGstin: BUYER_MH_GSTIN,
});
const janPrev = await (await get(A.token, `/api/invoices/${janInv}/einvoice/preview`)).json();
ok('a January invoice belongs to the year that began the previous April',
  janPrev.financialYear === '2026-27', janPrev.financialYear);

const aprInv = await invoice(A, { no: `INV-${MARK}A`, date: '2027-04-02', name: 'Apr Buyer', amount: 500000 });
await post(A.token, `/api/invoices/${aprInv}/tax`, {
  taxableValue: 500000, gstRate: 5, placeOfSupply: '27', customerGstin: BUYER_MH_GSTIN,
});
const aprPrev = await (await get(A.token, `/api/invoices/${aprInv}/einvoice/preview`)).json();
ok('and an April one starts the next', aprPrev.financialYear === '2027-28', aprPrev.financialYear);

ok('the derived IRN is the documented hash, not an opaque id',
  janPrev.irn === irnOf(SUPPLIER_GSTIN, '2026-27', 'INV', `INV-${MARK}J`), janPrev.irn);

// ── scope: B2C is not merely optional, it is out ────────────────────────────
console.log('\n=== B2C IS OUTSIDE E-INVOICING ENTIRELY ===');
const b2c = await invoice(A, { no: `INV-${MARK}C`, date: '2026-06-10', name: 'Individual Buyer', amount: 9000000 });
await post(A.token, `/api/invoices/${b2c}/tax`, {
  taxableValue: 9000000, gstRate: 5, placeOfSupply: '27',   // no customerGstin
});
const b2cPrev = await (await get(A.token, `/api/invoices/${b2c}/einvoice/preview`)).json();
ok('a ₹90L B2C supply is still ineligible', b2cPrev.eligible === false);
ok('and the reason names B2C rather than saying "invalid"',
  (b2cPrev.reasons ?? []).some(r => /B2C/i.test(r)), JSON.stringify(b2cPrev.reasons));

const b2cTry = await post(A.token, `/api/invoices/${b2c}/einvoice`, {});
ok('preparing one is refused', b2cTry.status === 422, String(b2cTry.status));

// ── post-completion is outside the levy, so there is nothing to register ────
console.log('\n=== A COMPLETED UNIT IS NOT A SUPPLY ===');
const done = await invoice(A, { no: `INV-${MARK}D`, date: '2026-06-11', name: 'Completed Sale', amount: 7000000 });
await post(A.token, `/api/invoices/${done}/tax`, {
  taxableValue: 7000000, gstRate: 5, placeOfSupply: '27',
  customerGstin: BUYER_MH_GSTIN, postCompletion: true,
});
const donePrev = await (await get(A.token, `/api/invoices/${done}/einvoice/preview`)).json();
ok('sold after completion is ineligible', donePrev.eligible === false);
ok('and says it is outside GST, not that a field is missing',
  (donePrev.reasons ?? []).some(r => /outside GST|after completion/i.test(r)),
  JSON.stringify(donePrev.reasons));

// ── the happy path ──────────────────────────────────────────────────────────
console.log('\n=== PREPARE, REGISTER, AND THE PAYLOAD THAT GOES UP ===');
const good = await invoice(A, { no: `INV-${MARK}X`, date: '2026-06-12', name: 'Acme Realty', amount: 5250000 });
await post(A.token, `/api/invoices/${good}/tax`, {
  taxableValue: 5000000, gstRate: 5, placeOfSupply: '27', customerGstin: BUYER_MH_GSTIN, hsnSac: '9954',
});
const prep = await post(A.token, `/api/invoices/${good}/einvoice`, {});
ok('a B2B invoice prepares', prep.status === 201, String(prep.status));
const ein = (await prep.json()).einvoice;
ok('it starts prepared, not registered', ein?.status === 'prepared', ein?.status);
ok('the IRN matches the documented hash',
  ein?.irn === irnOf(SUPPLIER_GSTIN, '2026-27', 'INV', `INV-${MARK}X`), ein?.irn);

const dup = await post(A.token, `/api/invoices/${good}/einvoice`, {});
ok('preparing a second while one is live is refused', dup.status === 409, String(dup.status));

const payload = await (await get(A.token, `/api/einvoices/${ein.id}/json`)).json();
ok('the payload is INV-01 v1.1', payload?.Version === '1.1', JSON.stringify(payload?.Version));
ok('intra-state carries CGST+SGST and no IGST',
  payload?.ValDtls?.CgstVal === 125000 && payload?.ValDtls?.SgstVal === 125000 && payload?.ValDtls?.IgstVal === 0,
  JSON.stringify(payload?.ValDtls));
ok('the document date is DD/MM/YYYY, not ISO', payload?.DocDtls?.Dt === '12/06/2026', payload?.DocDtls?.Dt);
ok('our own derived block never goes to the portal', payload?._derived === undefined);

// ── the IRN is checked, not trusted ─────────────────────────────────────────
console.log('\n=== A CROSSED RESPONSE IS CAUGHT HERE ===');
const wrongIrn = await post(A.token, `/api/einvoices/${ein.id}/register`, {
  irn: irnOf(SUPPLIER_GSTIN, '2026-27', 'INV', `SOME${MARK}Z`),
  ackNo: '112410000000001', ackDate: '2026-06-12T10:00:00Z',
});
ok('an IRN for another document is refused', wrongIrn.status === 409, String(wrongIrn.status));
ok('and says it may belong to a different document',
  /different document/i.test((await wrongIrn.json()).error ?? ''));

const reg = await post(A.token, `/api/einvoices/${ein.id}/register`, {
  irn: ein.irn, ackNo: '112410000000001', ackDate: new Date().toISOString(),
});
ok('the matching IRN registers', reg.status === 200, String(reg.status));
const registered = (await reg.json()).einvoice;
ok('status becomes registered', registered?.status === 'registered');
ok('and it is cancellable inside the window', registered?.cancellable === true);

// ── the 24-hour window ──────────────────────────────────────────────────────
console.log('\n=== THE CANCELLATION WINDOW IS HARD ===');
const stale = await invoice(A, { no: `INV-${MARK}Y`, date: '2026-06-13', name: 'Old Sale', amount: 2100000 });
await post(A.token, `/api/invoices/${stale}/tax`, {
  taxableValue: 2000000, gstRate: 5, placeOfSupply: '27', customerGstin: BUYER_MH_GSTIN,
});
const stalePrep = (await (await post(A.token, `/api/invoices/${stale}/einvoice`, {})).json()).einvoice;
const staleReg = await post(A.token, `/api/einvoices/${stalePrep.id}/register`, {
  irn: stalePrep.irn, ackNo: '112410000000002', ackDate: new Date().toISOString(),
});
// Asserted rather than assumed: without this the registration could fail
// silently and the cancellation below would take the "never registered"
// branch, passing for entirely the wrong reason.
ok('the second document registers', staleReg.status === 200,
  `${staleReg.status} ${JSON.stringify(await staleReg.clone().json()).slice(0, 120)}`);
// Age it past the window the way the portal's clock would.
await admin.query(
  `UPDATE einvoices SET ack_date = now() - interval '25 hours' WHERE id = $1`, [stalePrep.id]);

const late = await post(A.token, `/api/einvoices/${stalePrep.id}/cancel`, { reason: 'Wrong amount' });
ok('cancelling after 24 hours is refused', late.status === 409, String(late.status));
ok('and points at a credit note as the remedy',
  /credit note/i.test((await late.json()).error ?? ''));

const inTime = await post(A.token, `/api/einvoices/${ein.id}/cancel`, { reason: 'Wrong buyer GSTIN' });
ok('cancelling inside the window works', inTime.status === 200, String(inTime.status));
ok('and it stays readable afterwards — the IRN is burned, not erased',
  (await inTime.json()).einvoice?.irn === ein.irn);

// ── isolation ───────────────────────────────────────────────────────────────
console.log('\n=== ANOTHER WORKSPACE SEES NONE OF IT ===');
const mine = (await (await get(A.token, '/api/einvoices')).json()).einvoices ?? [];
const theirs = (await (await get(B.token, '/api/einvoices')).json()).einvoices ?? [];
ok('A sees its own', mine.length >= 2, String(mine.length));
ok('B sees none of A\'s', theirs.every(e => !mine.some(m => m.id === e.id)), String(theirs.length));

const crossRead = await get(B.token, `/api/einvoices/${ein.id}/json`);
ok('and cannot fetch A\'s payload by id', crossRead.status === 404, String(crossRead.status));

// ── permissions ─────────────────────────────────────────────────────────────
console.log('\n=== READING IS NOT PREPARING ===');
const R = await workspace('r', ['view_finance']);
const rInv = await invoice(R, { no: `INV-${MARK}R`, date: '2026-06-14', name: 'Read Only', amount: 100000 });
const noManage = await post(R.token, `/api/invoices/${rInv}/einvoice`, {});
ok('view_finance alone cannot prepare', noManage.status === 403, String(noManage.status));

// ── the workspace profile, which is where the GSTIN comes from ──────────────
//
// Everything above depends on the workspace having a GSTIN, and until this
// route existed nothing could set one: the profile form wrote `tenants.gst`
// while the tax modules read `tenants.gstin`. So the advice "set your GSTIN
// before preparing" was advice the product could not take.
console.log('\n=== THE WORKSPACE CAN SET ITS OWN GSTIN ===');
const W = await workspace('w', ['manage_settings']);
const patch = (body) => api(W.token, '/api/workspace', {
  method: 'PATCH', body: JSON.stringify(body),
});

const badCheck = await patch({ gstin: '27AACCM9910C1ZM' });   // right shape, wrong check digit
ok('a GSTIN with a bad check digit is refused', badCheck.status === 400, String(badCheck.status));
ok('and says why', /check digit/i.test((await badCheck.json()).error ?? ''));

const disagree = await patch({ gstin: BUYER_MH_GSTIN, stateCode: '29' });
ok('a state code disagreeing with the GSTIN is refused', disagree.status === 400, String(disagree.status));

const savedOk = await patch({ gstin: BUYER_MH_GSTIN, city: 'Pune', pincode: '411001' });
ok('a valid GSTIN saves', savedOk.status === 200, String(savedOk.status));
const saved = (await savedOk.json()).workspace;
ok('and the state code is derived from its first two digits', saved?.stateCode === '27', saved?.stateCode);
ok('the legacy gst field is kept in step, not left to drift', saved?.gst === BUYER_MH_GSTIN, saved?.gst);

const badPin = await patch({ pincode: '000123' });
ok('an impossible pincode is refused', badPin.status === 400, String(badPin.status));

// The platform's fields are not the workspace's to set. A builder admin
// raising their own plan through this route is exactly what omitting them
// from the schema prevents.
const escalate = await patch({ plan: 'enterprise' });
ok('plan is not an accepted field', escalate.status === 400, String(escalate.status));
const suspendSelf = await patch({ status: 'active' });
ok('nor is status', suspendSelf.status === 400, String(suspendSelf.status));

const readerOnly = await workspace('ro', ['view_finance']);
const noPerm = await api(readerOnly.token, '/api/workspace', {
  method: 'PATCH', body: JSON.stringify({ city: 'Nagpur' }),
});
ok('manage_settings is required to edit it', noPerm.status === 403, String(noPerm.status));


console.log('\n=== PAN, WHICH 194-IA IS DEDUCTED AGAINST ===');
// TDS under 194-IA has been computed since migration 050, but Form 26QB —
// the challan the buyer actually files — needs the PAN of both parties, and
// nothing stored one. These are the columns that make the deduction filable.

// A GSTIN embeds its holder's PAN at characters 3 to 12, so a registered
// builder never types it twice — and where both are given they must agree.
const gstinPan = BUYER_MH_GSTIN.slice(2, 12);
const panMismatch = await patch({ pan: `ZZZPZ9999Z` });
ok('a PAN disagreeing with the workspace GSTIN is refused',
  panMismatch.status === 400, String(panMismatch.status));

const panShape = await patch({ pan: `NOTAPAN123` });
ok('so is one of the wrong shape', panShape.status === 400, String(panShape.status));

const panOk = await patch({ pan: gstinPan });
ok('the PAN inside the GSTIN is accepted', panOk.status === 200,
  String(panOk.status) + ' ' + JSON.stringify(await panOk.clone().json()).slice(0, 120));

// The buyer side, and the masking that keeps it off a sales screen.
const custRes = await post(A.token, `/api/customers`,
  { name: 'PAN Buyer', pan: 'AAAPL1234C' });
ok('a customer can be created with a PAN', custRes.status === 201, String(custRes.status));

const badCust = await post(A.token, `/api/customers`,
  { name: 'Bad PAN', pan: 'AAAPL12345' });
ok('a malformed buyer PAN is refused', badCust.status === 400, String(badCust.status));

// A finance user in the owning workspace sees the PAN in full.
const seenByFinance = await (await get(A.token, `/api/customers`)).json();
const panCustomer = (seenByFinance.customers ?? []).find(c => c.name === 'PAN Buyer');
ok('manage_finance sees the PAN unmasked', panCustomer?.pan === 'AAAPL1234C', panCustomer?.pan);
ok('and the holder type is reported', panCustomer?.panHolderType === 'Individual', panCustomer?.panHolderType);

// A SALES user in the SAME workspace does not. This is the assertion that
// matters: masking is about who is looking, not which tenant they belong to,
// so it has to be tested inside the tenant that owns the row.
const salesRole = (await admin.query(
  `INSERT INTO roles (tenant_id, name, is_system) VALUES ($1,'Sales',false) RETURNING id`,
  [A.tenantId])).rows[0];
await admin.query(
  `INSERT INTO role_permissions (role_id, permission_key)
   SELECT $1, k FROM unnest($2::text[]) k ON CONFLICT DO NOTHING`,
  [salesRole.id, ['view_leads']]);
const salesEmail = `${MARK}-sales@ein.test`;
await admin.query(
  `INSERT INTO users (tenant_id, role_id, name, email, password_hash, active)
   VALUES ($1,$2,'Sales',$3,$4,true)`,
  [A.tenantId, salesRole.id, salesEmail, await argon2.hash(PW, { type: argon2.argon2id })]);
const salesTok = (await (await fetch(BASE + '/api/auth/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: salesEmail, password: PW }),
})).json()).token;

const seenBySales = await (await get(salesTok, `/api/customers`)).json();
const panAsSalesSees = (seenBySales.customers ?? []).find(c => c.name === 'PAN Buyer');
ok('a sales user in the same workspace sees the buyer', !!panAsSalesSees);
ok('but the PAN is masked', panAsSalesSees?.pan === '••••••1234C'.slice(-10) || /^•+/.test(panAsSalesSees?.pan ?? ''),
  panAsSalesSees?.pan);
ok('and it says so, so nobody reads the mask as the number',
  panAsSalesSees?.panMasked === true, String(panAsSalesSees?.panMasked));

// Recording one is a finance act, not a sales one.
const salesTriesPan = await api(salesTok, `/api/customers/${panCustomer.id}`, {
  method: 'PATCH', body: JSON.stringify({ pan: 'AAAPL9999C' }),
});
ok('and a sales user cannot set one', salesTriesPan.status === 403, String(salesTriesPan.status));

// The KYC state that the schema refused until 059.
const rejected = await api(A.token, `/api/customers/${panCustomer.id}`, {
  method: 'PATCH', body: JSON.stringify({ kycStatus: 'rejected' }),
});
ok('KYC can be marked rejected, not just pending or verified',
  rejected.status === 200, String(rejected.status));

await admin.end();
console.log(`\n===== ${pass} passed, ${fail} failed =====`);
process.exit(fail ? 1 : 0);
