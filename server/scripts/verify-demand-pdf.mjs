/**
 * The demand letter as a document, not a table row.
 *
 * WHAT THIS IS FOR
 *
 * The product could compute a demand letter and show it in a list, and that
 * was the end of it — there was no rendering library anywhere in the codebase,
 * so the one artefact the buyer actually receives had to be retyped into Word
 * by whoever was on collections that day. A demand letter is served on a
 * buyer, quoted back in disputes, and in India attached to RERA proceedings;
 * a number that was retyped is a number that can be wrong.
 *
 * The assertions worth making are not "did a PDF come back". They are:
 *
 *   - is it a real PDF a reader will open (header AND trailer)
 *   - do the FIGURES in it match the row, or did rendering round them
 *   - does it survive a customer name a WinAnsi font cannot draw
 *   - is it gated on view_finance and scoped by RLS like everything else
 *   - does a zero-interest letter avoid printing a charge that was not made
 */
import pg from 'pg';
import argon2 from 'argon2';

const BASE = process.env.API_BASE ?? 'http://localhost:4055';
const PW = 'Test1234!';
const MARK = 'pdf' + Math.random().toString(36).slice(2, 8);
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + (x ? '  -> ' + x : ''))); };

const admin = new pg.Client(process.env.DATABASE_ADMIN_URL
  ?? 'postgres://postgres:postgres@localhost:5433/erp_test');
await admin.connect();

/** A workspace with a booking, a schedule and a demand letter already raised —
 *  built directly, because the point here is the rendering, not the raising. */
async function workspace(slug, perms, customerName) {
  const t = (await admin.query(
    `INSERT INTO tenants (name, company, slug, email, address, phone, currency)
     VALUES ($1, $1, $2, $3, $4, '+91 22 4000 1000', 'INR') RETURNING id`,
    [`${MARK} ${slug} Developers`, `${MARK}-${slug}`, `${MARK}-${slug}@pdf.test`,
     '4th Floor, Trade Centre, Bandra Kurla Complex, Mumbai 400051'])).rows[0];
  const role = (await admin.query(
    `INSERT INTO roles (tenant_id, name, is_system) VALUES ($1, 'Finance', false) RETURNING id`,
    [t.id])).rows[0];
  if (perms.length) {
    await admin.query(
      `INSERT INTO role_permissions (role_id, permission_key)
       SELECT $1, k FROM unnest($2::text[]) k ON CONFLICT DO NOTHING`, [role.id, perms]);
  }
  const email = `${MARK}-${slug}@pdf.test`;
  await admin.query(
    `INSERT INTO users (tenant_id, role_id, name, email, password_hash, active)
     VALUES ($1, $2, 'Finance User', $3, $4, true)`,
    [t.id, role.id, email, await argon2.hash(PW, { type: argon2.argon2id })]);
  const token = (await (await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PW }),
  })).json()).token;
  if (!token) throw new Error(`login failed for ${email}`);

  // A lead insert fails a check constraint without an active pipeline, so a
  // suite that creates one would fail for a reason unrelated to what it tests.
  await admin.query(
    `INSERT INTO schema_definitions (tenant_id, entity, kind, version, is_active, definition)
     VALUES ($1,'lead','pipeline',1,true,$2)
     ON CONFLICT (tenant_id, entity, kind, version)
     DO UPDATE SET definition = EXCLUDED.definition, is_active = true`,
    [t.id, JSON.stringify({ stages: [
      { key: 'new', id: 'new', label: 'New', core: true },
      { key: 'booked', id: 'booked', label: 'Booked', core: true },
      { key: 'lost', id: 'lost', label: 'Lost', core: true },
    ] })]);

  const project = (await admin.query(
    `INSERT INTO projects (tenant_id, name) VALUES ($1, 'Skyline Heights') RETURNING id`,
    [t.id])).rows[0];
  const unit = (await admin.query(
    `INSERT INTO units (tenant_id, project_id, unit_code) VALUES ($1, $2, 'A-1204') RETURNING id`,
    [t.id, project.id])).rows[0];
  const lead = (await admin.query(
    `INSERT INTO leads (tenant_id, name, email, phone) VALUES ($1, $2, $3, '+91 98200 00006') RETURNING id`,
    [t.id, customerName, `buyer-${slug}@pdf.test`])).rows[0];
  const booking = (await admin.query(
    `INSERT INTO bookings (tenant_id, lead_id, unit_id, delay_interest_pct, status)
     VALUES ($1, $2, $3, 12, 'active') RETURNING id`,
    [t.id, lead.id, unit.id])).rows[0];
  return { tenantId: t.id, token, bookingId: booking.id, leadId: lead.id };
}

/** A letter written straight in, with the figures we will look for. */
async function letter(w, { principal, interest, pct, days, milestone }) {
  const sched = (await admin.query(
    `INSERT INTO payment_schedules (tenant_id, booking_id, sequence, milestone_name, due_date, amount)
     VALUES ($1, $2,
             (SELECT COALESCE(MAX(sequence), 0) + 1 FROM payment_schedules WHERE booking_id = $2),
             $3, CURRENT_DATE - $4::int, $5) RETURNING id`,
    [w.tenantId, w.bookingId, milestone, days, principal])).rows[0];
  const no = (await admin.query(
    `SELECT COALESCE(MAX(letter_no), 0) + 1 AS n FROM demand_letters WHERE tenant_id = $1`,
    [w.tenantId])).rows[0].n;
  return (await admin.query(
    `INSERT INTO demand_letters
       (tenant_id, booking_id, payment_schedule_id, letter_no, due_on,
        principal_amount, interest_amount, total_amount, interest_pct, days_overdue)
     VALUES ($1, $2, $3, $4, CURRENT_DATE + 15, $5, $6, $7, $8, $9) RETURNING id, letter_no`,
    [w.tenantId, w.bookingId, sched.id, no, principal, interest,
     Number(principal) + Number(interest), pct, days])).rows[0];
}

const get = (token, path) => fetch(BASE + path, { headers: { Authorization: `Bearer ${token}` } });

// A name with a curly apostrophe and Devanagari — the shape of real customer
// data, and exactly what a WinAnsi font cannot draw.
const A = await workspace('a', ['view_finance', 'manage_finance'], 'Rajesh D’Souza — राजेश');
const B = await workspace('b', ['view_finance', 'manage_finance'], 'Other Tenant Buyer');

console.log('\n=== IT IS A PDF, AND A COMPLETE ONE ===');
const l1 = await letter(A, { principal: 1234567, interest: 24691.34, pct: 12, days: 61, milestone: 'On Completion of Plinth' });
const res = await get(A.token, `/api/demand-letters/${l1.id}/pdf`);
ok('returns 200', res.status === 200, String(res.status));
ok('declares application/pdf', res.headers.get('content-type') === 'application/pdf',
   res.headers.get('content-type'));
ok('is not cached by a proxy', /no-store/.test(res.headers.get('cache-control') ?? ''),
   res.headers.get('cache-control'));
ok('nosniff is set', res.headers.get('x-content-type-options') === 'nosniff');
ok('the filename quotes the letter number',
   (res.headers.get('content-disposition') ?? '').includes(`Demand-Letter-${l1.letter_no}.pdf`),
   res.headers.get('content-disposition'));

const buf = Buffer.from(await res.arrayBuffer());
ok('starts with the PDF header', buf.subarray(0, 5).toString() === '%PDF-', buf.subarray(0, 8).toString());
// A truncated PDF opens to an error rather than nothing, so the trailer is the
// assertion that actually distinguishes a usable file from a broken one.
ok('ends with the EOF marker', buf.subarray(-1024).toString('latin1').includes('%%EOF'));
ok('carries a cross-reference table', buf.toString('latin1').includes('/Root'));
ok('Content-Length matches the body',
   Number(res.headers.get('content-length')) === buf.length,
   `${res.headers.get('content-length')} vs ${buf.length}`);
ok('is a plausible size for a one-page letter', buf.length > 1200 && buf.length < 400_000,
   String(buf.length));

console.log('\n=== THE FIGURES SURVIVE RENDERING ===');
// pdfkit compresses content streams, so the text is not greppable in the raw
// bytes. Extracting it properly is what a buyer's PDF reader does, and it is
// the only way to assert the NUMBER on the page rather than the number in the
// row that produced it.
const { default: zlib } = await import('node:zlib');
function extractText(pdf) {
  let out = '';
  const raw = pdf.toString('latin1');
  const re = /stream\r?\n([\s\S]*?)endstream/g;
  let m;
  while ((m = re.exec(raw)) !== null) {
    const bytes = Buffer.from(m[1], 'latin1');
    let content;
    try { content = zlib.inflateSync(bytes).toString('latin1'); } catch { content = bytes.toString('latin1'); }
    // pdfkit writes text as HEX strings — `[<48454c4c4f> 0] TJ` — not as the
    // `(literal)` form most examples show. An extractor that only handles
    // literals finds nothing here and reports every content assertion as a
    // pass, which is worse than not asserting at all. Both forms are read.
    for (const t of content.matchAll(/<([0-9A-Fa-f\s]+)>|\((?:\\.|[^\\)])*\)/g)) {
      out += t[1] !== undefined
        ? Buffer.from(t[1].replace(/\s+/g, ''), 'hex').toString('latin1')
        : t[0].slice(1, -1).replace(/\\([()\\])/g, '$1');
    }
  }
  return out;
}
const text = extractText(buf);
ok('text is extractable at all', text.length > 200, `${text.length} chars`);
ok('the total is printed with Indian grouping',
   text.includes('12,59,258.34'), text.slice(0, 0) || 'not found');
ok('the principal is printed', text.includes('12,34,567.00'));
ok('the interest line is printed', text.includes('24,691.34'));
ok('the currency is shown as a code, not an unrenderable symbol',
   text.includes('INR') && !text.includes('?'), 'INR present');
ok('the milestone name is on the letter', text.includes('On Completion of Plinth'));
ok('the letter number is on the letter', text.includes(String(l1.letter_no)));
ok('the unit is identified', text.includes('A-1204') && text.includes('Skyline Heights'));
ok('the interest rate is stated', text.includes('12%'));

console.log('\n=== AN UNDRAWABLE NAME DOES NOT 500 THE LETTER ===');
// Losing a character is bad. Failing to produce a document the builder is
// legally required to serve, because one buyer's name is in Devanagari, is
// worse — and that is what pdfkit does by default on a glyph WinAnsi lacks.
ok('a curly apostrophe is transliterated, not fatal', text.includes("D'Souza"),
   text.includes('Souza') ? 'name present but apostrophe differs' : 'name missing');
ok('the render still succeeded with non-Latin characters in the name', res.status === 200);

console.log('\n=== A ZERO-INTEREST LETTER DOES NOT INVENT A CHARGE ===');
const l2 = await letter(A, { principal: 500000, interest: 0, pct: 12, days: 0, milestone: 'On Booking' });
const zero = await get(A.token, `/api/demand-letters/${l2.id}/pdf`);
ok('renders', zero.status === 200, String(zero.status));
const zeroText = extractText(Buffer.from(await zero.arrayBuffer()));
ok('no interest line is printed', !/Delay interest @/.test(zeroText));
ok('but the future-interest term still is', /will be applicable/.test(zeroText));
ok('the total equals the principal', zeroText.includes('5,00,000.00'));

console.log('\n=== IT IS PERMISSIONED AND TENANT-SCOPED ===');
const cross = await get(B.token, `/api/demand-letters/${l1.id}/pdf`);
ok('another tenant gets 404', cross.status === 404, String(cross.status));
ok('and 404 rather than 403 — no existence oracle', cross.status !== 403, String(cross.status));

const noPerm = await workspace('c', [], 'No Permission Buyer');
const denied = await get(noPerm.token, `/api/demand-letters/${l1.id}/pdf`);
ok('a user without view_finance is refused', denied.status === 403, String(denied.status));

const missing = await get(A.token, '/api/demand-letters/00000000-0000-4000-8000-000000000000/pdf');
ok('an unknown id is 404, not a crash', missing.status === 404, String(missing.status));

for (const w of [A, B, noPerm]) await admin.query('DELETE FROM tenants WHERE id = $1', [w.tenantId]);
await admin.end();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
