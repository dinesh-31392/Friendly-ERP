/**
 * Retention and erasure — the rule everyone gets wrong.
 *
 * WHAT THIS IS FOR
 *
 * The product held personal data for every lead, buyer and broker in a
 * workspace and had no notion of ever letting any of it go. Under the DPDP Act,
 * 2023 a Data Principal may ask for erasure and a Data Fiduciary has to answer.
 *
 * THE ASSERTION THAT MATTERS
 *
 * Erasure is not "delete everything", and it is not "refuse because we keep
 * financial records". Both are wrong and the second is the one this codebase
 * would have defaulted to.
 *
 * A lead who never booked leaves nothing anyone is required to keep — erase it.
 * A lead who DID leaves a booking that must survive eight years under section
 * 128(5) of the Companies Act: redact the person, keep the record, and say why.
 * That fork is what these tests pin.
 */
import pg from 'pg';
import argon2 from 'argon2';

const BASE = process.env.API_BASE ?? 'http://localhost:4055';
const PW = 'Test1234!';
const MARK = 'pv' + Math.random().toString(36).slice(2, 8);
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + (x ? '  -> ' + x : ''))); };

const admin = new pg.Client(process.env.DATABASE_ADMIN_URL
  ?? 'postgres://postgres:postgres@localhost:5433/erp_test');
await admin.connect();

async function workspace(slug, perms) {
  const t = (await admin.query(
    `INSERT INTO tenants (name, company, slug, email) VALUES ($1,$1,$2,$3) RETURNING id`,
    [`${MARK} ${slug}`, `${MARK}-${slug}`, `${MARK}-${slug}@pv.test`])).rows[0];
  // No policy seeding here on purpose. A workspace must arrive with its
  // statutory floors already in place — if this helper had to install them,
  // the test would be proving its own fixture rather than the product.
  const role = (await admin.query(
    `INSERT INTO roles (tenant_id, name, is_system) VALUES ($1,'Ops',false) RETURNING id`, [t.id])).rows[0];
  if (perms.length) {
    await admin.query(
      `INSERT INTO role_permissions (role_id, permission_key)
       SELECT $1, k FROM unnest($2::text[]) k ON CONFLICT DO NOTHING`, [role.id, perms]);
  }
  const email = `${MARK}-${slug}@pv.test`;
  await admin.query(
    `INSERT INTO users (tenant_id, role_id, name, email, password_hash, active)
     VALUES ($1,$2,'Ops',$3,$4,true)`,
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

const api = (token, path, init = {}) => fetch(BASE + path, {
  ...init,
  headers: { ...(init.body ? { 'Content-Type': 'application/json' } : {}), Authorization: `Bearer ${token}` },
});
const post = (token, path, body) => api(token, path, { method: 'POST', body: body ? JSON.stringify(body) : undefined });

const A = await workspace('a', ['manage_settings', 'view_leads']);
const B = await workspace('b', ['manage_settings']);

/** A lead, optionally with a booking behind it. */
async function person(w, { name, email, phone, booked }) {
  const lead = (await admin.query(
    // phone_normalized is a GENERATED column — Postgres derives it from phone
    // and refuses an explicit value.
    `INSERT INTO leads (tenant_id, name, email, phone)
     VALUES ($1,$2,$3,$4) RETURNING id`,
    [w.tenantId, name, email, phone])).rows[0];
  await admin.query(
    `INSERT INTO lead_activities (tenant_id, lead_id, type, notes)
     VALUES ($1,$2,'note','Called, interested in a 3BHK')`, [w.tenantId, lead.id]);
  if (booked) {
    const unit = (await admin.query(
      `INSERT INTO units (tenant_id, project_id, unit_code) VALUES ($1,$2,$3) RETURNING id`,
      [w.tenantId, w.projectId, 'U-' + Math.random().toString(36).slice(2, 7)])).rows[0];
    await admin.query(
      `INSERT INTO bookings (tenant_id, lead_id, unit_id, total_consideration, status)
       VALUES ($1,$2,$3,8000000,'active')`, [w.tenantId, lead.id, unit.id]);
  }
  return lead.id;
}

console.log('\n=== STATUTORY PERIODS ARE A FLOOR, NOT A SUGGESTION ===');
const policies = (await (await api(A.token, '/api/retention-policies')).json()).policies;
ok('policies are seeded', policies.length > 0, String(policies.length));
const books = policies.find(p => p.entity === 'bookings');
ok('bookings are statutory', books?.statutory === true);
ok('and carry the section that requires it', /128\(5\)/.test(books?.legalBasis ?? ''), books?.legalBasis);
const leadsPolicy = policies.find(p => p.entity === 'leads');
ok('a lead is NOT statutory — it is held for convenience', leadsPolicy?.statutory === false);
ok('and therefore has no legal basis recorded', (leadsPolicy?.legalBasis ?? '') === '');

const shorten = await api(A.token, `/api/retention-policies/${books.id}`, {
  method: 'PATCH', body: JSON.stringify({ retainDays: 365 }),
});
ok('a statutory period cannot be shortened', shorten.status === 409, String(shorten.status));
ok('and the refusal cites the obligation', /128\(5\)/.test((await shorten.json()).legalBasis ?? ''));

const extend = await api(A.token, `/api/retention-policies/${books.id}`, {
  method: 'PATCH', body: JSON.stringify({ retainDays: 4380 }),
});
ok('but it can be extended', extend.status === 200, String(extend.status));

const forever = await api(A.token, `/api/retention-policies/${books.id}`, {
  method: 'PATCH', body: JSON.stringify({ retainDays: null }),
});
ok('and "keep indefinitely" is always allowed', forever.status === 200, String(forever.status));

const shortenLead = await api(A.token, `/api/retention-policies/${leadsPolicy.id}`, {
  method: 'PATCH', body: JSON.stringify({ retainDays: 180 }),
});
ok('a non-statutory period can be shortened freely', shortenLead.status === 200, String(shortenLead.status));

console.log('\n=== A REQUEST NAMES SOMEBODY, OR IT IS NOT A REQUEST ===');
const empty = await post(A.token, '/api/erasure-requests', { subjectName: 'Somebody' });
ok('a request with no email, phone or id is refused', empty.status === 400, String(empty.status));

console.log('\n=== A LEAD WHO NEVER BOOKED IS ERASED ===');
const coldEmail = `cold-${MARK}@pv.test`;
const coldId = await person(A, { name: 'Cold Prospect', email: coldEmail, phone: '+91 98200 11111', booked: false });
const r1 = (await (await post(A.token, '/api/erasure-requests', { subjectEmail: coldEmail })).json()).request;
ok('the request is logged', !!r1.id);
ok('and starts unverified', r1.status === 'received', r1.status);

const preview1 = (await (await api(A.token, `/api/erasure-requests/${r1.id}/preview`)).json()).preview;
ok('the preview finds them', preview1.matched === 1, String(preview1.matched));
const leadStep = preview1.steps.find(s => s.entity === 'leads');
ok('and plans to ERASE, not redact', leadStep?.action === 'erased', leadStep?.action);
ok('their activities go too', preview1.steps.some(s => s.entity === 'lead_activities' && s.action === 'erased'));
// Nothing of the PERSON is kept. The audit trail is, and legitimately so — an
// `audit_leads` trigger records every lead insert, and a trail that can be
// rewritten on request is not a trail. It is the one thing allowed to survive,
// and it has to carry its basis.
const retainedInPreview = preview1.steps.filter(s => s.action === 'retained');
ok('no personal record is retained',
   !retainedInPreview.some(s => ['leads', 'lead_activities', 'site_visits'].includes(s.entity)),
   JSON.stringify(retainedInPreview.map(s => s.entity)));
ok('only the audit trail is',
   retainedInPreview.every(s => s.entity === 'audit_logs'),
   JSON.stringify(retainedInPreview.map(s => s.entity)));
ok('and it states why it is kept',
   retainedInPreview.every(s => s.legalBasis.trim().length > 0));

console.log('\n=== NOTHING IS DESTROYED WITHOUT VERIFYING WHO IS ASKING ===');
// An erasure request is otherwise a perfect way to delete a rival's pipeline.
const early = await post(A.token, `/api/erasure-requests/${r1.id}/execute`);
ok('execution before verification is refused', early.status === 409, String(early.status));
ok('and the lead is still there',
   (await admin.query('SELECT 1 FROM leads WHERE id=$1', [coldId])).rowCount === 1);

const verified = await post(A.token, `/api/erasure-requests/${r1.id}/verify`, {
  note: 'Identity confirmed against the number on file and a photo ID.',
});
ok('verification is recorded', verified.status === 200, String(verified.status));

const done1 = await post(A.token, `/api/erasure-requests/${r1.id}/execute`);
ok('and then it runs', done1.status === 200, String(done1.status));
ok('the lead row is gone',
   (await admin.query('SELECT 1 FROM leads WHERE id=$1', [coldId])).rowCount === 0);
ok('and so are their activities',
   (await admin.query('SELECT 1 FROM lead_activities WHERE lead_id=$1', [coldId])).rowCount === 0);

console.log('\n=== A BUYER IS REDACTED, AND THEIR BOOKING SURVIVES ===');
const buyerEmail = `buyer-${MARK}@pv.test`;
const buyerId = await person(A, { name: 'Rajesh Kumar', email: buyerEmail, phone: '+91 98200 22222', booked: true });
const r2 = (await (await post(A.token, '/api/erasure-requests', { subjectEmail: buyerEmail })).json()).request;

const preview2 = (await (await api(A.token, `/api/erasure-requests/${r2.id}/preview`)).json()).preview;
const leadStep2 = preview2.steps.find(s => s.entity === 'leads');
ok('the lead is planned for REDACTION, not erasure', leadStep2?.action === 'redacted', leadStep2?.action);
const bookingStep = preview2.steps.find(s => s.entity === 'bookings');
ok('the booking is planned for RETENTION', bookingStep?.action === 'retained', bookingStep?.action);
ok('with the section that requires it', /128\(5\)/.test(bookingStep?.legalBasis ?? ''), bookingStep?.legalBasis);
ok('and the preview can be quoted back to the subject',
   preview2.retainedCount > 0 && preview2.redactedCount > 0,
   `retained ${preview2.retainedCount}, redacted ${preview2.redactedCount}`);

await post(A.token, `/api/erasure-requests/${r2.id}/verify`, { note: 'Verified by phone.' });
const done2 = await post(A.token, `/api/erasure-requests/${r2.id}/execute`);
ok('the erasure runs', done2.status === 200, String(done2.status));

const after = (await admin.query('SELECT name, email, phone FROM leads WHERE id=$1', [buyerId])).rows[0];
ok('the lead row still exists', !!after, 'row deleted — the booking would be orphaned');
ok('but the name is gone', after && !/Rajesh/.test(after.name), after?.name);
ok('and it says the data was ERASED, not merely blank',
   /erased on request/i.test(after?.name ?? ''), after?.name);
ok('the email is cleared', (after?.email ?? '') === '', after?.email);
ok('the phone is cleared', (after?.phone ?? '') === '', after?.phone);
ok('the booking is untouched',
   (await admin.query('SELECT 1 FROM bookings WHERE lead_id=$1', [buyerId])).rowCount === 1);

console.log('\n=== THE ANSWER IS EVIDENCED, RECORD BY RECORD ===');
const full = (await (await api(A.token, `/api/erasure-requests/${r2.id}`)).json()).request;
ok('every action is written down', full.actions.length > 0, String(full.actions.length));
ok('the request is marked completed', full.status === 'completed', full.status);
ok('and stamped', !!full.completedAt);
const retained = full.actions.filter(a => a.action === 'retained');
ok('everything retained carries a reason',
   retained.length > 0 && retained.every(a => a.legalBasis.trim().length > 0),
   JSON.stringify(retained.map(a => a.legalBasis)));

// The database refuses it too, not just the handler.
const noBasis = await admin.query(
  `INSERT INTO erasure_actions (tenant_id, request_id, entity, action, legal_basis)
   VALUES ($1,$2,'bookings','retained','')`, [A.tenantId, r2.id])
  .then(() => 'inserted', e => e.code);
ok('the schema refuses a retention with no basis', noBasis === '23514', String(noBasis));

const reRun = await post(A.token, `/api/erasure-requests/${r2.id}/execute`);
ok('a completed request cannot be run again', reRun.status === 409, String(reRun.status));

console.log('\n=== REFUSAL REQUIRES A REASON ===');
const r3 = (await (await post(A.token, '/api/erasure-requests', { subjectPhone: '+91 90000 00000' })).json()).request;
const noReason = await post(A.token, `/api/erasure-requests/${r3.id}/refuse`, {});
ok('a refusal with no reason is rejected', noReason.status === 400, String(noReason.status));
const refused = await post(A.token, `/api/erasure-requests/${r3.id}/refuse`, {
  reason: 'Could not establish that the requester is the data principal.',
});
ok('with one, it is recorded', refused.status === 200, String(refused.status));

const dbRefusal = await admin.query(
  `INSERT INTO erasure_requests (tenant_id, subject_email, status, refused_reason)
   VALUES ($1,'x@y.test','refused','')`, [A.tenantId]).then(() => 'inserted', e => e.code);
ok('and the schema refuses a blank one', dbRefusal === '23514', String(dbRefusal));

console.log('\n=== THE SWEEP CANNOT REACH THE BOOKS OF ACCOUNT ===');
const sweep = (await (await api(A.token, '/api/retention-sweep')).json()).expired;
ok('the sweep reports what has aged out', Array.isArray(sweep));
ok('and never offers a statutory entity',
   !sweep.some(e => ['bookings', 'invoices', 'payments', 'journal_entries'].includes(e.entity)),
   JSON.stringify(sweep.map(e => e.entity)));

console.log('\n=== IT IS PERMISSIONED AND TENANT-SCOPED ===');
const cross = await api(B.token, `/api/erasure-requests/${r2.id}`);
ok('another tenant gets 404', cross.status === 404, String(cross.status));

const noPerm = await workspace('c', ['view_leads']);
const denied = await api(noPerm.token, '/api/erasure-requests');
ok('a user without manage_settings is refused', denied.status === 403, String(denied.status));


console.log('\n=== THE CUSTOMER RECORD, AND THE PAN IN IT ===');
// `customers` was outside the erasure plan entirely, though it has always
// held a name, an email and a phone — and since migration 059 it holds the
// PAN, which identifies its holder to the tax department. The most
// identifying field in the product, sitting in the one table a Data
// Principal's request could not reach.
const panEmail = `pan-${MARK}@pv.test`;
const panLead = await person(A, { name: 'PAN Buyer', email: panEmail, phone: '+91 98200 33333', booked: false });
await admin.query(
  `INSERT INTO customers (tenant_id, name, email, phone, lead_id, pan)
   VALUES ($1,$2,$3,$4,$5,$6)`,
  [A.tenantId, 'PAN Buyer', panEmail, '+91 98200 33333', panLead, 'AAAPL1234C']);

const rPan = (await (await post(A.token, '/api/erasure-requests', { subjectEmail: panEmail })).json()).request;
const previewPan = (await (await api(A.token, `/api/erasure-requests/${rPan.id}/preview`)).json()).preview;
ok('the plan reaches the customer record',
  previewPan.steps.some(s => s.entity === 'customers' && s.action === 'erased'),
  JSON.stringify(previewPan.steps.map(s => s.entity)));
ok('and names the PAN as what goes with it',
  previewPan.steps.some(s => s.entity === 'customers' && /PAN/.test(s.detail ?? '')));

// Asserted, not assumed: without this a failed verify would leave the row in
// place and the deletion check below would fail for the wrong reason.
const vPan = await post(A.token, `/api/erasure-requests/${rPan.id}/verify`, { note: 'Identity confirmed for the PAN case.' });
ok('the request verifies', vPan.status === 200,
  `${vPan.status} ${JSON.stringify(await vPan.clone().json()).slice(0, 140)}`);
const xPan = await post(A.token, `/api/erasure-requests/${rPan.id}/execute`, {});
ok('and executes', xPan.status === 200,
  `${xPan.status} ${JSON.stringify(await xPan.clone().json()).slice(0, 140)}`);
const leftPan = Number((await admin.query(
  'SELECT count(*)::int n FROM customers WHERE lead_id = $1', [panLead])).rows[0].n);
ok('executing it actually removes the row', leftPan === 0, String(leftPan));

for (const w of [A, B, noPerm]) await admin.query('DELETE FROM tenants WHERE id = $1', [w.tenantId]);
await admin.end();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
