/**
 * GST returns, and the rule that decides which government gets paid.
 *
 * WHAT THIS IS FOR
 *
 * `tax_postings` held a tax type, a period and an amount — a note that some tax
 * existed. Nothing computed a return, and nothing could have: an invoice
 * recorded `amount` and no tax at all.
 *
 * THE ASSERTIONS THAT MATTER
 *
 * A supply is intra-state or inter-state, decided by the supplier's state
 * against the PLACE OF SUPPLY. Intra-state splits into CGST and SGST, half
 * each; inter-state is a single IGST. Getting it backwards is not a labelling
 * error — the money reaches the wrong exchequer, the recipient's input credit
 * does not reconcile, and fixing it means a credit note and a fresh invoice.
 *
 * And GSTR-1 has three outward tables, not one. Which an invoice lands in is
 * decided by whether the recipient has a GSTIN, and for those who do not, by
 * whether the supply crossed a state line for more than ₹2,50,000.
 */
import pg from 'pg';
import argon2 from 'argon2';

const BASE = process.env.API_BASE ?? 'http://localhost:4055';
const PW = 'Test1234!';
const MARK = 'gst' + Math.random().toString(36).slice(2, 7);
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + (x ? '  -> ' + x : ''))); };
const near = (a, b) => Math.abs(Number(a) - Number(b)) < 0.011;

const admin = new pg.Client(process.env.DATABASE_ADMIN_URL
  ?? 'postgres://postgres:postgres@localhost:5433/erp_test');
await admin.connect();

// Real, checksum-valid GSTINs. 27 = Maharashtra, 29 = Karnataka.
const SUPPLIER_GSTIN = '27AAPFU0939F1ZV';
const BUYER_MH_GSTIN = '27AACCM9910C1ZN';

async function workspace(slug, perms, { gstin = SUPPLIER_GSTIN, state = '27' } = {}) {
  const t = (await admin.query(
    `INSERT INTO tenants (name, company, slug, email, gstin, state_code)
     VALUES ($1,$1,$2,$3,$4,$5) RETURNING id`,
    [`${MARK} ${slug}`, `${MARK}-${slug}`, `${MARK}-${slug}@gst.test`, gstin, state])).rows[0];
  const role = (await admin.query(
    `INSERT INTO roles (tenant_id, name, is_system) VALUES ($1,'Accounts',false) RETURNING id`, [t.id])).rows[0];
  if (perms.length) {
    await admin.query(
      `INSERT INTO role_permissions (role_id, permission_key)
       SELECT $1, k FROM unnest($2::text[]) k ON CONFLICT DO NOTHING`, [role.id, perms]);
  }
  const email = `${MARK}-${slug}@gst.test`;
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

const A = await workspace('a', ['view_finance', 'manage_finance']);
const B = await workspace('b', ['view_finance', 'manage_finance']);

console.log('\n=== A GSTIN IS CHECKED, NOT JUST SHAPED ===');
const badInv = await invoice(A, { no: 'INV-BAD', date: '2026-06-05', name: 'Typo Buyer', amount: 100 });
// Right shape, wrong check digit (the real one ends N) — passes a regex, lands
// in the B2B table, and is rejected by GSTN weeks later naming an invoice
// nobody remembers raising.
const badGstin = await post(A.token, `/api/invoices/${badInv}/tax`, {
  taxableValue: 100, gstRate: 5, placeOfSupply: '27', customerGstin: '27AACCM9910C1ZM',
});
ok('a GSTIN with a bad check digit is refused', badGstin.status === 400, String(badGstin.status));
ok('and the refusal says why', /check digit/i.test((await badGstin.json()).error ?? ''));

const shapeless = await post(A.token, `/api/invoices/${badInv}/tax`, {
  taxableValue: 100, gstRate: 5, placeOfSupply: '27', customerGstin: 'NOTAGSTIN',
});
ok('so is one of the wrong shape', shapeless.status === 400, String(shapeless.status));

console.log('\n=== INTRA-STATE SPLITS IN HALF; INTER-STATE DOES NOT ===');
// Supplier is in Maharashtra (27). Place of supply 27 → CGST + SGST.
const intra = await invoice(A, { no: 'INV-001', date: '2026-06-10', name: 'Mumbai Buyer', amount: 1050000 });
const intraRes = await post(A.token, `/api/invoices/${intra}/tax`, {
  taxableValue: 1000000, gstRate: 5, placeOfSupply: '27', customerGstin: BUYER_MH_GSTIN,
});
ok('the tax is recorded', intraRes.status === 200, String(intraRes.status));
const i1 = (await intraRes.json()).invoice;
ok('CGST is half the rate', near(i1.cgst, 25000), String(i1.cgst));
ok('SGST is the other half', near(i1.sgst, 25000), String(i1.sgst));
ok('and the two are exactly equal', i1.cgst === i1.sgst, `${i1.cgst} vs ${i1.sgst}`);
ok('IGST is nil', near(i1.igst, 0), String(i1.igst));
ok('the split is reported as intra-state', i1.interState === false);

// Place of supply 29 (Karnataka) → IGST at the full rate.
const inter = await invoice(A, { no: 'INV-002', date: '2026-06-12', name: 'Bengaluru Buyer', amount: 840000 });
const i2 = (await (await post(A.token, `/api/invoices/${inter}/tax`, {
  taxableValue: 800000, gstRate: 5, placeOfSupply: '29',
})).json()).invoice;
ok('IGST carries the whole rate', near(i2.igst, 40000), String(i2.igst));
ok('with no CGST', near(i2.cgst, 0), String(i2.cgst));
ok('and no SGST', near(i2.sgst, 0), String(i2.sgst));
ok('reported as inter-state', i2.interState === true);

// The database refuses the impossible combination outright.
const bothRegimes = await admin.query(
  `UPDATE invoices SET cgst = 100, sgst = 100, igst = 100 WHERE id = $1`, [intra])
  .then(() => 'accepted', e => e.code);
ok('the schema refuses IGST alongside CGST/SGST', bothRegimes === '23514', String(bothRegimes));

const unequalHalves = await admin.query(
  `UPDATE invoices SET cgst = 100, sgst = 90, igst = 0 WHERE id = $1`, [intra])
  .then(() => 'accepted', e => e.code);
ok('and refuses unequal halves', unequalHalves === '23514', String(unequalHalves));

console.log('\n=== A COMPLETED UNIT IS OUTSIDE THE LEVY, NOT TAXED AT ZERO ===');
// Past the completion certificate the sale is immovable property. Reporting it
// as a taxable supply at 0% overstates turnover.
const done = await invoice(A, { no: 'INV-003', date: '2026-06-15', name: 'Ready Flat Buyer', amount: 5000000 });
const i3 = (await (await post(A.token, `/api/invoices/${done}/tax`, {
  taxableValue: 5000000, gstRate: 5, placeOfSupply: '27', postCompletion: true,
})).json()).invoice;
ok('the rate is forced to nil', near(i3.gstRate, 0), String(i3.gstRate));
ok('and no tax is charged', near(i3.cgst, 0) && near(i3.igst, 0));
ok('but it is flagged as post-completion, not merely untaxed', i3.postCompletion === true);

console.log('\n=== GSTR-1 PUTS EACH SUPPLY IN EXACTLY ONE TABLE ===');
// B2C, inter-state, above ₹2,50,000 → B2CL, reported invoice by invoice.
const b2clInv = await invoice(A, { no: 'INV-004', date: '2026-06-18', name: 'Big B2C', amount: 3150000 });
await post(A.token, `/api/invoices/${b2clInv}/tax`, {
  taxableValue: 3000000, gstRate: 5, placeOfSupply: '29',
});
// B2C, intra-state, small → B2CS, summarised by state and rate.
const b2csInv = await invoice(A, { no: 'INV-005', date: '2026-06-20', name: 'Small B2C', amount: 105000 });
await post(A.token, `/api/invoices/${b2csInv}/tax`, {
  taxableValue: 100000, gstRate: 5, placeOfSupply: '27',
});

const pre = (await (await api(A.token, '/api/gst/returns/preview?form=GSTR1&period=062026')).json()).preview;
ok('the preview covers the month', pre.from === '2026-06-01' && pre.to === '2026-06-30',
   `${pre.from}..${pre.to}`);
ok('the supplier GSTIN is on the return', pre.payload.gstin === SUPPLIER_GSTIN, pre.payload.gstin);

ok('a registered buyer lands in B2B',
   pre.payload.b2b.some(r => r.inum === 'INV-001' && r.ctin === BUYER_MH_GSTIN),
   JSON.stringify(pre.payload.b2b.map(r => r.inum)));
ok('and nowhere else',
   !pre.payload.b2cl.some(r => r.inum === 'INV-001'));

ok('a large inter-state B2C supply lands in B2CL',
   pre.payload.b2cl.some(r => r.inum === 'INV-004'),
   JSON.stringify(pre.payload.b2cl.map(r => r.inum)));
ok('with its invoice value, not just the taxable amount',
   near(pre.payload.b2cl.find(r => r.inum === 'INV-004')?.val, 3150000));

// The threshold is the whole reason B2CL exists — below it, an invoice is
// invisible in the return.
const b2csRow = pre.payload.b2cs.find(r => r.pos === '27' && r.rt === 5);
ok('a small B2C supply is summarised into B2CS', !!b2csRow, JSON.stringify(pre.payload.b2cs));
ok('by state and rate, with no invoice number', b2csRow && b2csRow.inum === undefined);
ok('and it is marked intra-state', b2csRow?.sply_ty === 'INTRA', b2csRow?.sply_ty);

ok('the inter-state B2C supply is NOT in B2CS',
   !pre.payload.b2cs.some(r => r.pos === '29' && r.iamt > 0 && r.txval >= 3000000),
   JSON.stringify(pre.payload.b2cs));

console.log('\n=== THE HSN SUMMARY AND THE NIL TABLE ===');
const hsn = pre.payload.hsn.find(h => h.hsn_sc === '9954' && h.rt === 5);
ok('construction is summarised under SAC 9954', !!hsn, JSON.stringify(pre.payload.hsn));
ok('counting every taxable invoice at that rate', hsn?.num === 4, String(hsn?.num));
ok('the completed unit is reported separately, not as a 5% supply',
   pre.payload.nil.count === 1, String(pre.payload.nil.count));
ok('and the reason is stated', /Schedule III/.test(pre.payload.nil.note ?? ''));
// The distinction that matters: an invoice nobody has taxed is NOT an exempt
// supply. Reporting it as one claims an exemption that was never claimed.
ok('an untouched invoice is not counted as exempt',
   !pre.payload.nil.invoiceNos?.includes?.('INV-BAD'));
ok('it is reported as unrecorded instead',
   pre.payload.unrecorded.invoiceNos.includes('INV-BAD'),
   JSON.stringify(pre.payload.unrecorded.invoiceNos));
ok('and excluded from every table',
   !pre.payload.b2b.some(r => r.inum === 'INV-BAD')
   && !pre.payload.b2cl.some(r => r.inum === 'INV-BAD'));

console.log('\n=== UNTAXED INVOICES ARE NAMED BEFORE THE DEADLINE ===');
const forgotten = await invoice(A, { no: 'INV-006', date: '2026-06-25', name: 'Forgotten', amount: 500000 });
const pre2 = (await (await api(A.token, '/api/gst/returns/preview?form=GSTR1&period=062026')).json()).preview;
ok('an invoice with no tax recorded is listed',
   pre2.untaxed.some(u => u.invoiceNo === 'INV-006'),
   JSON.stringify(pre2.untaxed.map(u => u.invoiceNo)));
ok('and the return is not reported ready', pre2.ready === false, String(pre2.ready));
await admin.query('DELETE FROM invoices WHERE id = $1', [forgotten]);

console.log('\n=== GSTR-3B SUMMARISES, AND REFUSES TO GUESS AT CREDIT ===');
const b3 = (await (await api(A.token, '/api/gst/returns/preview?form=GSTR3B&period=062026')).json()).preview;
// 10,00,000 + 8,00,000 + 30,00,000 + 1,00,000 taxable = 49,00,000.
ok('outward taxable supplies are totalled',
   near(b3.payload.sup_details.osup_det.txval, 4900000),
   String(b3.payload.sup_details.osup_det.txval));
ok('the completed unit sits in nil/exempt, not in taxable',
   near(b3.payload.sup_details.osup_nil_exmp.txval, 5000000),
   String(b3.payload.sup_details.osup_nil_exmp.txval));
ok('inter-state supplies to unregistered persons are broken out by state',
   b3.payload.inter_sup.unreg_details.some(r => r.pos === '29'),
   JSON.stringify(b3.payload.inter_sup.unreg_details));
// The one number on this form that leaves a bank account.
ok('input tax credit is NOT computed', b3.payload.itc_elg === null);
ok('and says why', /purchase records this system does not hold/.test(b3.payload.itcNote ?? ''));

console.log('\n=== A PREPARED RETURN IS FROZEN ===');
const prepared = await post(A.token, '/api/gst/returns', { form: 'GSTR1', period: '062026' });
ok('it can be prepared', prepared.status === 201, String(prepared.status));
const r1 = (await prepared.json()).return;
ok('with the period totals', near(r1.taxableValue, 4900000 + 5000000), String(r1.taxableValue));
ok('and starts unfiled', r1.status === 'prepared', r1.status);

const filedNoArn = await post(A.token, `/api/gst/returns/${r1.id}/file`, {});
ok('filing without an ARN is refused', filedNoArn.status === 400, String(filedNoArn.status));

const filed = await post(A.token, `/api/gst/returns/${r1.id}/file`, { arn: 'AA2706260001234' });
ok('with one, it is recorded as filed', filed.status === 200, String(filed.status));
ok('and stamped', !!(await filed.json()).return.filedAt);

// An invoice corrected in July must not change what was filed for June.
const reprepare = await post(A.token, '/api/gst/returns', { form: 'GSTR1', period: '062026' });
ok('a filed return cannot be overwritten', reprepare.status === 409, String(reprepare.status));
ok('and says to amend instead', /amendment/i.test((await reprepare.json()).error ?? ''));

const dbNoArn = await admin.query(
  `INSERT INTO gst_returns (tenant_id, form, period, status, arn)
   VALUES ($1,'GSTR3B','012026','filed','')`, [A.tenantId]).then(() => 'ok', e => e.code);
ok('the schema refuses a filed return with no ARN', dbNoArn === '23514', String(dbNoArn));

console.log('\n=== THE DOWNLOAD IS WHAT THE OFFLINE TOOL INGESTS ===');
const json = await api(A.token, `/api/gst/returns/${r1.id}/json`);
ok('it downloads', json.status === 200, String(json.status));
ok('as JSON', (json.headers.get('content-type') ?? '').includes('json'));
ok('as an attachment', /^attachment/.test(json.headers.get('content-disposition') ?? ''));
const doc = JSON.parse(await json.text());
ok('carrying the GSTIN', doc.gstin === SUPPLIER_GSTIN, doc.gstin);
ok('and the return period in GSTN form', doc.fp === '062026', doc.fp);
ok('with the B2B table intact', Array.isArray(doc.b2b) && doc.b2b.length > 0);

console.log('\n=== A WORKSPACE WITHOUT A GSTIN IS TOLD, NOT LEFT GUESSING ===');
const noGstin = await workspace('c', ['view_finance', 'manage_finance'], { gstin: null, state: null });
const noInv = await invoice(noGstin, { no: 'X-1', date: '2026-06-10', name: 'X', amount: 100 });
const blocked = await post(noGstin.token, `/api/invoices/${noInv}/tax`, {
  taxableValue: 100, gstRate: 5, placeOfSupply: '27',
});
ok('recording tax is refused', blocked.status === 409, String(blocked.status));
ok('because the split depends on it', /intra\/inter-state split/.test((await blocked.json()).error ?? ''));
const noPre = (await (await api(noGstin.token, '/api/gst/returns/preview?form=GSTR1&period=062026')).json()).preview;
ok('and the preview says the GSTIN is missing', noPre.gstinConfigured === false);

console.log('\n=== IT IS PERMISSIONED AND TENANT-SCOPED ===');
const cross = await api(B.token, `/api/gst/returns/${r1.id}/json`);
ok('another tenant gets 404', cross.status === 404, String(cross.status));
const crossPre = (await (await api(B.token, '/api/gst/returns/preview?form=GSTR1&period=062026')).json()).preview;
ok('and sees none of these invoices', crossPre.payload.b2b.length === 0,
   JSON.stringify(crossPre.payload.b2b.length));

const readOnly = await workspace('d', ['view_finance']);
const denied = await post(readOnly.token, '/api/gst/returns', { form: 'GSTR1', period: '062026' });
ok('a read-only user cannot prepare a return', denied.status === 403, String(denied.status));
ok('but can preview one',
   (await api(readOnly.token, '/api/gst/returns/preview?form=GSTR1&period=062026')).status === 200);

for (const w of [A, B, noGstin, readOnly]) await admin.query('DELETE FROM tenants WHERE id = $1', [w.tenantId]);
await admin.end();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
