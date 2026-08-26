/**
 * Cost sheets, and the two tax rules that decide what a buyer actually pays.
 *
 * WHAT THIS IS FOR
 *
 * The product had `quotations` — base, additional charges, discount, total —
 * which is a quote, not a cost sheet. An Indian buyer is shown an itemised
 * statement before booking, takes it to their bank for a loan sanction, and
 * holds the builder to it afterwards. "98 lakh all-in" is not something a bank
 * will lend against.
 *
 * Two rules are the whole reason this needs a schema and a test rather than a
 * spreadsheet, and both are commonly got wrong:
 *
 *   GST is charged on the consideration and NEVER on stamp duty or
 *   registration — those are state levies, and tax on a tax is the error that
 *   ends up in a RERA complaint. The rate is also per-line: a flat is 5%, its
 *   maintenance deposit is 18%.
 *
 *   TDS under 194-IA is deducted BY THE BUYER from what they pay the builder.
 *   It is not an addition to the buyer's cost. Modelling it as a charge — the
 *   usual mistake — overstates the buyer's total by 1% and understates what
 *   the builder is owed. And once the consideration crosses the threshold, the
 *   deduction is on the WHOLE amount, not the excess.
 *
 * The boundary cases below are the ones a spreadsheet gets wrong: exactly at
 * the threshold, and one rupee under it.
 */
import pg from 'pg';
import argon2 from 'argon2';

const BASE = process.env.API_BASE ?? 'http://localhost:4055';
const PW = 'Test1234!';
const MARK = 'cs' + Math.random().toString(36).slice(2, 8);
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + (x ? '  -> ' + x : ''))); };
const near = (a, b) => Math.abs(Number(a) - Number(b)) < 0.011;

const admin = new pg.Client(process.env.DATABASE_ADMIN_URL
  ?? 'postgres://postgres:postgres@localhost:5433/erp_test');
await admin.connect();

async function workspace(slug, perms) {
  const t = (await admin.query(
    `INSERT INTO tenants (name, company, slug, email, address, phone, currency)
     VALUES ($1, $1, $2, $3, 'Trade Centre, BKC, Mumbai 400051', '+91 22 4000 1000', 'INR') RETURNING id`,
    [`${MARK} ${slug} Developers`, `${MARK}-${slug}`, `${MARK}-${slug}@cs.test`])).rows[0];
  const role = (await admin.query(
    `INSERT INTO roles (tenant_id, name, is_system) VALUES ($1, 'Sales', false) RETURNING id`, [t.id])).rows[0];
  if (perms.length) {
    await admin.query(
      `INSERT INTO role_permissions (role_id, permission_key)
       SELECT $1, k FROM unnest($2::text[]) k ON CONFLICT DO NOTHING`, [role.id, perms]);
  }
  const email = `${MARK}-${slug}@cs.test`;
  await admin.query(
    `INSERT INTO users (tenant_id, role_id, name, email, password_hash, active)
     VALUES ($1, $2, 'Sales User', $3, $4, true)`,
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
  const unit = (await admin.query(
    `INSERT INTO units (tenant_id, project_id, unit_code, area_sqft, base_rate)
     VALUES ($1, $2, 'A-1204', 1200, 8000) RETURNING id`, [t.id, project.id])).rows[0];
  const lead = (await admin.query(
    `INSERT INTO leads (tenant_id, name, email, phone) VALUES ($1, 'Rajesh Kumar', $2, '+91 98200 00006') RETURNING id`,
    [t.id, `buyer-${slug}@cs.test`])).rows[0];
  return { tenantId: t.id, token, unitId: unit.id, leadId: lead.id };
}

const api = (token, path, init = {}) => fetch(BASE + path, {
  ...init,
  headers: {
    ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    Authorization: `Bearer ${token}`,
  },
});
const post = (token, path, body) => api(token, path, { method: 'POST', body: JSON.stringify(body) });

const A = await workspace('a', ['view_bookings', 'manage_bookings']);
const B = await workspace('b', ['view_bookings', 'manage_bookings']);

console.log('\n=== A SHEET PRICES ITSELF FROM THE BASIS, NOT FROM THE CLIENT ===');
// 1200 sq ft at 8000 = 96,00,000 BSP. Floor rise 1200 x 150 = 1,80,000.
// PLC 2,00,000. Parking 4,00,000. Club 1,00,000. Consideration 1,04,80,000.
const res1 = await post(A.token, '/api/cost-sheets', {
  unitId: A.unitId, leadId: A.leadId, validUntil: '2026-12-31',
  lines: [
    { section: 'consideration', label: 'Basic Sale Price', basis: 'per_sqft', rate: 8000, gstPct: 5 },
    { section: 'consideration', label: 'Floor Rise (12th floor)', basis: 'per_sqft', rate: 150, gstPct: 5 },
    { section: 'consideration', label: 'Preferential Location Charges', basis: 'lump_sum', rate: 200000, gstPct: 5 },
    { section: 'consideration', label: 'Covered Car Parking', basis: 'lump_sum', rate: 400000, gstPct: 5 },
    { section: 'consideration', label: 'Club Membership', basis: 'lump_sum', rate: 100000, gstPct: 5 },
    { section: 'deposit', label: 'Maintenance Advance (24 months)', basis: 'lump_sum', rate: 120000, gstPct: 18 },
    // Statutory: percentages OF the consideration, and never GST-bearing.
    { section: 'statutory', label: 'Stamp Duty', basis: 'pct_of_consideration', rate: 6 },
    { section: 'statutory', label: 'Registration Charges', basis: 'pct_of_consideration', rate: 1 },
  ],
});
ok('draft returns 201', res1.status === 201, String(res1.status));
const s1 = (await res1.json()).costSheet;
ok('the sheet is numbered', Number(s1.sheetNo) >= 1, String(s1.sheetNo));
ok('area defaults from the unit', Number(s1.areaSqft) === 1200, String(s1.areaSqft));

const bsp = s1.lines.find(l => l.label === 'Basic Sale Price');
ok('a per_sqft line is priced from area x rate', near(bsp.amount, 9600000), String(bsp.amount));
ok('and its quantity is the area', near(bsp.quantity, 1200), String(bsp.quantity));
ok('consideration totals correctly', near(s1.totals.consideration, 10480000), String(s1.totals.consideration));

console.log('\n=== GST IS PER LINE, AND NEVER ON A STATUTORY LEVY ===');
const stamp = s1.lines.find(l => l.label === 'Stamp Duty');
ok('stamp duty is a percentage OF the consideration',
   near(stamp.amount, 10480000 * 0.06), String(stamp.amount));
ok('and it is computed after the other lines are priced', near(stamp.amount, 628800), String(stamp.amount));
ok('a statutory line carries no GST', stamp.gstAmount === 0 && stamp.gstPct === 0,
   `${stamp.gstPct}% / ${stamp.gstAmount}`);

const maint = s1.lines.find(l => l.label.startsWith('Maintenance'));
ok('a deposit keeps its own 18% rate', near(maint.gstAmount, 21600), String(maint.gstAmount));
ok('while the flat is taxed at 5%', near(bsp.gstAmount, 480000), String(bsp.gstAmount));
// 5% of 1,04,80,000 = 5,24,000 plus 18% of 1,20,000 = 21,600.
ok('total GST is the sum of the line taxes, not a rate on the gross',
   near(s1.totals.gst, 524000 + 21600), String(s1.totals.gst));

// The database itself must refuse it, not just the route.
const rejected = await admin.query(
  `INSERT INTO cost_sheet_lines (tenant_id, cost_sheet_id, sequence, section, label, amount, gst_pct, gst_amount)
   VALUES ($1, $2, 99, 'statutory', 'Sneaky', 1000, 18, 180)`,
  [A.tenantId, s1.id]).then(() => 'inserted', e => e.code);
ok('the schema itself refuses GST on a statutory line', rejected === '23514', String(rejected));

console.log('\n=== 194-IA IS A DEDUCTION, NOT A CHARGE ===');
const gross = 10480000 + 545600 + 120000 + 733600;   // consideration + GST + deposit + statutory
ok('gross is every section plus GST', near(s1.totals.gross, gross), `${s1.totals.gross} vs ${gross}`);
ok('TDS is 1% of the CONSIDERATION, not of the gross',
   near(s1.totals.tds, 104800), String(s1.totals.tds));
ok('the buyer pays the gross — TDS is not added to it',
   near(s1.totals.payableByBuyer, gross), String(s1.totals.payableByBuyer));
ok('the builder receives the gross LESS the TDS',
   near(s1.totals.netToBuilder, gross - 104800), String(s1.totals.netToBuilder));

console.log('\n=== THE THRESHOLD IS A CLIFF, AND IT IS TESTED AT THE EDGE ===');
// One rupee below: no deduction at all. Exactly at it: on the WHOLE amount,
// not on the excess. This is the pair a spreadsheet gets wrong.
const under = (await (await post(A.token, '/api/cost-sheets', {
  unitId: A.unitId,
  lines: [{ section: 'consideration', label: 'BSP', basis: 'lump_sum', rate: 4999999 }],
})).json()).costSheet;
ok('a rupee under the threshold attracts no TDS', Number(under.totals.tds) === 0, String(under.totals.tds));

const at = (await (await post(A.token, '/api/cost-sheets', {
  unitId: A.unitId,
  lines: [{ section: 'consideration', label: 'BSP', basis: 'lump_sum', rate: 5000000 }],
})).json()).costSheet;
ok('exactly at the threshold, TDS applies', Number(at.totals.tds) > 0, String(at.totals.tds));
ok('and it applies to the WHOLE consideration, not the excess',
   near(at.totals.tds, 50000), String(at.totals.tds));

// Statutory charges are outside the 194-IA consideration, so a sheet whose
// GROSS crosses 50 lakh but whose consideration does not owes nothing.
const grossOver = (await (await post(A.token, '/api/cost-sheets', {
  unitId: A.unitId,
  lines: [
    { section: 'consideration', label: 'BSP', basis: 'lump_sum', rate: 4900000, gstPct: 5 },
    { section: 'statutory', label: 'Stamp Duty', basis: 'lump_sum', rate: 300000 },
  ],
})).json()).costSheet;
ok('a gross over the threshold with consideration under it owes no TDS',
   Number(grossOver.totals.gross) > 5000000 && Number(grossOver.totals.tds) === 0,
   `gross ${grossOver.totals.gross}, tds ${grossOver.totals.tds}`);

console.log('\n=== AN ISSUED SHEET IS A RECORD ===');
const edit1 = await api(A.token, `/api/cost-sheets/${s1.id}/lines`, {
  method: 'PUT', body: JSON.stringify({ lines: [{ label: 'Revised BSP', basis: 'lump_sum', rate: 1 }] }),
});
ok('a draft can be re-priced', edit1.status === 200, String(edit1.status));

const issued = await api(A.token, `/api/cost-sheets/${s1.id}`, {
  method: 'PATCH', body: JSON.stringify({ status: 'issued' }),
});
ok('draft can be issued', issued.status === 200, String(issued.status));
ok('and is stamped with the moment it was issued', !!(await issued.json()).costSheet.issuedAt);

const edit2 = await api(A.token, `/api/cost-sheets/${s1.id}/lines`, {
  method: 'PUT', body: JSON.stringify({ lines: [{ label: 'Cheeky', basis: 'lump_sum', rate: 1 }] }),
});
ok('an issued sheet cannot be re-priced', edit2.status === 409, String(edit2.status));

const del = await api(A.token, `/api/cost-sheets/${s1.id}`, { method: 'DELETE' });
ok('and cannot be deleted', del.status === 409, String(del.status));

const backwards = await api(A.token, `/api/cost-sheets/${s1.id}`, {
  method: 'PATCH', body: JSON.stringify({ status: 'issued' }),
});
ok('an issued sheet cannot be re-issued', backwards.status === 409, String(backwards.status));

const accepted = await api(A.token, `/api/cost-sheets/${s1.id}`, {
  method: 'PATCH', body: JSON.stringify({ status: 'accepted' }),
});
ok('issued can be accepted', accepted.status === 200, String(accepted.status));

const draftDel = await api(A.token, `/api/cost-sheets/${under.id}`, { method: 'DELETE' });
ok('a draft can still be deleted', draftDel.status === 204, String(draftDel.status));

console.log('\n=== IT RENDERS AS THE DOCUMENT A BANK WILL READ ===');
// A FRESH sheet with the full line set. s1 was deliberately re-priced down to
// one line by the lifecycle assertions above, so rendering it would test the
// PDF against a sheet that has no statutory section and no TDS — and pass or
// fail for reasons that have nothing to do with the renderer.
const forPdf = (await (await post(A.token, '/api/cost-sheets', {
  unitId: A.unitId, leadId: A.leadId,
  lines: [
    { section: 'consideration', label: 'Basic Sale Price', basis: 'per_sqft', rate: 8000, gstPct: 5 },
    { section: 'consideration', label: 'Covered Car Parking', basis: 'lump_sum', rate: 400000, gstPct: 5 },
    { section: 'deposit', label: 'Maintenance Advance (24 months)', basis: 'lump_sum', rate: 120000, gstPct: 18 },
    { section: 'statutory', label: 'Stamp Duty', basis: 'pct_of_consideration', rate: 6 },
    { section: 'statutory', label: 'Registration Charges', basis: 'pct_of_consideration', rate: 1 },
  ],
})).json()).costSheet;
await api(A.token, `/api/cost-sheets/${forPdf.id}`, {
  method: 'PATCH', body: JSON.stringify({ status: 'issued' }),
});
ok('the rendered sheet is over the TDS threshold', Number(forPdf.totals.tds) > 0,
   String(forPdf.totals.tds));

const pdfRes = await api(A.token, `/api/cost-sheets/${forPdf.id}/pdf`);
ok('the PDF renders', pdfRes.status === 200, String(pdfRes.status));
const pdf = Buffer.from(await pdfRes.arrayBuffer());
ok('it is a complete PDF', pdf.subarray(0, 5).toString() === '%PDF-'
   && pdf.subarray(-1024).toString('latin1').includes('%%EOF'));

const { default: zlib } = await import('node:zlib');
function extractText(b) {
  let out = '';
  const raw = b.toString('latin1');
  let m; const re = /stream\r?\n([\s\S]*?)endstream/g;
  while ((m = re.exec(raw)) !== null) {
    const bytes = Buffer.from(m[1], 'latin1');
    let c; try { c = zlib.inflateSync(bytes).toString('latin1'); } catch { c = bytes.toString('latin1'); }
    for (const t of c.matchAll(/<([0-9A-Fa-f\s]+)>|\((?:\\.|[^\\)])*\)/g)) {
      out += t[1] !== undefined
        ? Buffer.from(t[1].replace(/\s+/g, ''), 'hex').toString('latin1')
        : t[0].slice(1, -1).replace(/\\([()\\])/g, '$1');
    }
  }
  return out;
}
const text = extractText(pdf);
// pdfkit emits each rendered LINE as its own text run, so a sentence that wraps
// arrives with no space at the wrap point. Asserting prose against the raw
// concatenation fails on the line break rather than on the content — so prose
// is matched with whitespace removed from both sides.
const squash = (v) => v.replace(/\s+/g, '');
const says = (phrase) => squash(text).includes(squash(phrase));
ok('the sections are named for the buyer', says('CONSIDERATION') && says('STATUTORY CHARGES'));
ok('the TDS deduction is explained, not just deducted', says('194-IA'));
ok('and stated as not being an additional cost', says('not an additional cost'));
// The clause must be the AFFIRMATIVE one. Both branches mention 194-IA, so a
// sheet that wrongly reported no TDS would still pass the assertion above.
ok('and the affirmative clause, not the "below the threshold" one',
   says('is deductible at source') && !says('is not deductible at source'));
ok('the GST-on-statutory rule is stated in words',
   says('do not attract GST'), 'clause missing');

console.log('\n=== IT IS PERMISSIONED AND TENANT-SCOPED ===');
const cross = await api(B.token, `/api/cost-sheets/${s1.id}`);
ok('another tenant gets 404', cross.status === 404, String(cross.status));
const crossPdf = await api(B.token, `/api/cost-sheets/${forPdf.id}/pdf`);
ok('and cannot render its PDF either', crossPdf.status === 404, String(crossPdf.status));
const crossList = await (await api(B.token, '/api/cost-sheets')).json();
ok('nor see it in a list', !(crossList.costSheets ?? []).some(c => c.id === s1.id));

const noPerm = await workspace('c', ['view_bookings']);
const denied = await post(noPerm.token, '/api/cost-sheets', { lines: [] });
ok('a read-only user cannot draft one', denied.status === 403, String(denied.status));
const allowed = await api(noPerm.token, '/api/cost-sheets');
ok('but can still read the list', allowed.status === 200, String(allowed.status));

for (const w of [A, B, noPerm]) await admin.query('DELETE FROM tenants WHERE id = $1', [w.tenantId]);
await admin.end();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
