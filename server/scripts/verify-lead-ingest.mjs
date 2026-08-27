/**
 * Portal lead ingest — 99acres, MagicBricks, Housing and the web forms.
 *
 * WHAT THIS IS FOR
 *
 * The portals push leads server-to-server. They have no session, no user and no
 * workspace slug — just a URL a builder pastes into their dashboard.
 *
 * THREE THINGS DECIDE WHETHER THIS WORKS IN PRACTICE
 *
 * Every portal names the same field differently. One sends `mobile`, another
 * `contact_number`, a third `sender_phone`, and none of them will change it.
 *
 * They all retry, so the same enquiry arrives twice within minutes. And the
 * same buyer really does enquire on two portals about the same project — which
 * is a signal a salesperson wants, not noise.
 *
 * The credential is per portal. One shared key means rotating a leaked one
 * takes every integration down at once, and makes "which portal is sending us
 * rubbish" unanswerable.
 */
import pg from 'pg';
import argon2 from 'argon2';

const BASE = process.env.API_BASE ?? 'http://localhost:4055';
const PW = 'Test1234!';
const MARK = 'li' + Math.random().toString(36).slice(2, 8);
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + (x ? '  -> ' + x : ''))); };

const admin = new pg.Client(process.env.DATABASE_ADMIN_URL
  ?? 'postgres://postgres:postgres@localhost:5433/erp_test');
await admin.connect();

async function workspace(slug, perms) {
  const t = (await admin.query(
    `INSERT INTO tenants (name, company, slug, email) VALUES ($1,$1,$2,$3) RETURNING id`,
    [`${MARK} ${slug}`, `${MARK}-${slug}`, `${MARK}-${slug}@li.test`])).rows[0];
  const role = (await admin.query(
    `INSERT INTO roles (tenant_id, name, is_system) VALUES ($1,'sales_manager',false) RETURNING id`, [t.id])).rows[0];
  if (perms.length) {
    await admin.query(
      `INSERT INTO role_permissions (role_id, permission_key)
       SELECT $1, k FROM unnest($2::text[]) k ON CONFLICT DO NOTHING`, [role.id, perms]);
  }
  const email = `${MARK}-${slug}@li.test`;
  await admin.query(
    `INSERT INTO users (tenant_id, role_id, name, email, password_hash, active)
     VALUES ($1,$2,'Sales',$3,$4,true)`,
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
  await admin.query(`INSERT INTO projects (tenant_id, name) VALUES ($1,'Skyline Heights')`, [t.id]);
  return { tenantId: t.id, token };
}

const api = (token, path, init = {}) => fetch(BASE + path, {
  ...init,
  headers: { ...(init.body ? { 'Content-Type': 'application/json' } : {}), Authorization: `Bearer ${token}` },
});

const ingest = (source, secret, body, { via = 'header' } = {}) => fetch(
  BASE + `/api/public/leads/ingest/${source}` + (via === 'query' ? `?secret=${encodeURIComponent(secret)}` : ''),
  {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(via === 'header' ? { 'x-lead-source-secret': secret } : {}),
    },
    body: JSON.stringify(body),
  });

const A = await workspace('a', ['view_leads', 'manage_leads']);
const B = await workspace('b', ['view_leads', 'manage_leads']);

console.log('\n=== A CREDENTIAL IS SHOWN ONCE AND STORED AS A DIGEST ===');
const minted = await api(A.token, '/api/lead-sources', {
  method: 'POST', body: JSON.stringify({ sourceKey: 'magicbricks' }),
});
ok('a source can be created', minted.status === 201, String(minted.status));
const mb = await minted.json();
ok('a secret comes back', typeof mb.secret === 'string' && mb.secret.length >= 32, String(mb.secret?.length));
ok('along with the URL to paste into the portal',
   mb.ingestUrl === '/api/public/leads/ingest/magicbricks', mb.ingestUrl);

const stored = (await admin.query(
  `SELECT secret_hash FROM lead_sources WHERE tenant_id=$1 AND source_key='magicbricks'`,
  [A.tenantId])).rows[0];
ok('the plaintext is NOT in the database', stored.secret_hash !== mb.secret);
ok('a SHA-256 digest is', /^[0-9a-f]{64}$/.test(stored.secret_hash), stored.secret_hash?.slice(0, 12));

const listed = await (await api(A.token, '/api/lead-sources')).json();
ok('listing never returns the secret',
   !JSON.stringify(listed).includes(mb.secret), 'the secret leaked into the list');

console.log('\n=== EACH PORTAL SPEAKS ITS OWN DIALECT ===');
// MagicBricks: client_name / contact_number.
const mbLead = await ingest('magicbricks', mb.secret, {
  client_name: 'Anita Desai', contact_number: '09820011111',
  client_email: 'anita@example.in', psmname: 'Skyline Heights',
  propertytype: '3BHK', budget: '85 Lakh', remarks: 'Wants a high floor',
});
ok('a MagicBricks payload is accepted', mbLead.status === 201, String(mbLead.status));
const mbId = (await mbLead.json()).leadId;
const mbRow = (await admin.query('SELECT * FROM leads WHERE id=$1', [mbId])).rows[0];
ok('the name is mapped from client_name', mbRow.name === 'Anita Desai', mbRow.name);
ok('the phone from contact_number', /9820011111/.test(mbRow.phone), mbRow.phone);
ok('the project is matched to a real one', mbRow.project === 'Skyline Heights', mbRow.project);
ok('and linked by id, not just by name', !!mbRow.project_id);
ok('"85 Lakh" is read as 8,500,000', Number(mbRow.budget) === 8500000, String(mbRow.budget));
ok('the source is recorded for attribution', mbRow.source === 'MagicBricks', mbRow.source);
ok('and the lead is routed to a rep', !!mbRow.assigned_to);

// 99acres: sender_name / sender_phone.
const nine = await api(A.token, '/api/lead-sources', {
  method: 'POST', body: JSON.stringify({ sourceKey: '99acres' }),
});
const nineSecret = (await nine.json()).secret;
const nineLead = await ingest('99acres', nineSecret, {
  lead: {   // 99acres wraps it
    sender_name: 'Vikram Rao', sender_phone: '+91 98200 22222',
    sender_email: 'vikram@example.in', project_name: 'Skyline Heights',
    bhk: '2BHK', expected_price: '₹ 62,00,000', query: 'Site visit this weekend?',
  },
});
ok('a wrapped 99acres payload is unwrapped', nineLead.status === 201, String(nineLead.status));
const nineRow = (await admin.query('SELECT * FROM leads WHERE id=$1',
  [(await nineLead.json()).leadId])).rows[0];
ok('the name is mapped from sender_name', nineRow.name === 'Vikram Rao', nineRow.name);
ok('a formatted rupee budget is parsed', Number(nineRow.budget) === 6200000, String(nineRow.budget));
ok('and attributed to 99acres', nineRow.source === '99acres', nineRow.source);

// Housing: user_name / user_phone, and an array envelope.
const hs = await api(A.token, '/api/lead-sources', {
  method: 'POST', body: JSON.stringify({ sourceKey: 'housing' }),
});
const hsSecret = (await hs.json()).secret;
const hsLead = await ingest('housing', hsSecret, [{
  user_name: 'Priya Menon', user_phone: '9820033333',
  user_email: 'priya@example.in', listing_name: 'Skyline Heights',
  apartment_type: '4BHK', budget: '1.2 Cr',
}]);
ok('an array-wrapped Housing payload is unwrapped', hsLead.status === 201, String(hsLead.status));
const hsRow = (await admin.query('SELECT * FROM leads WHERE id=$1',
  [(await hsLead.json()).leadId])).rows[0];
ok('the name is mapped from user_name', hsRow.name === 'Priya Menon', hsRow.name);
ok('"1.2 Cr" is read as 12,000,000', Number(hsRow.budget) === 12000000, String(hsRow.budget));

console.log('\n=== UNMAPPED FIELDS ARE KEPT, NOT DROPPED ===');
const custom = (await admin.query(
  'SELECT custom_fields FROM leads WHERE id=$1', [mbId])).rows[0].custom_fields;
ok('the enquiry message survives', /high floor/.test(JSON.stringify(custom)), JSON.stringify(custom));

console.log('\n=== A RETRY IS NOT A SECOND LEAD ===');
// Portals retry on any non-2xx, so a duplicate answered with an error becomes
// a retry storm.
const retry = await ingest('magicbricks', mb.secret, {
  client_name: 'Anita Desai', contact_number: '+91 98200 11111', psmname: 'Skyline Heights',
});
ok('the redelivery returns 200, not an error', retry.status === 200, String(retry.status));
const retryBody = await retry.json();
ok('and says it was a duplicate', retryBody.duplicate === true);
ok('resolving to the SAME lead', retryBody.leadId === mbId, `${retryBody.leadId} vs ${mbId}`);
ok('no second row was written',
   Number((await admin.query(
     `SELECT count(*)::int n FROM leads WHERE tenant_id=$1 AND phone_normalized='9820011111'`,
     [A.tenantId])).rows[0].n) === 1);

// The number arrived as 09820011111 first and +91 98200 11111 second — the
// dedupe has to see through the formatting.
ok('the match works across differently formatted numbers', retryBody.leadId === mbId);

// A cross-portal duplicate is caught too: the same buyer on 99acres.
const crossPortal = await ingest('99acres', nineSecret, {
  sender_name: 'Anita Desai', sender_phone: '9820011111',
});
ok('the same buyer via another portal is recognised',
   (await crossPortal.json()).duplicate === true);
const notes = await admin.query(
  `SELECT notes FROM lead_activities WHERE lead_id=$1 AND type='note' ORDER BY created_at DESC LIMIT 1`,
  [mbId]);
ok('and the repeat enquiry is logged against the lead',
   /repeat enquiry/i.test(notes.rows[0]?.notes ?? ''), notes.rows[0]?.notes);

console.log('\n=== THE CREDENTIAL IS THE ONLY THING THAT IDENTIFIES A WORKSPACE ===');
const noSecret = await fetch(BASE + '/api/public/leads/ingest/magicbricks', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ client_name: 'X', contact_number: '9000000001' }),
});
ok('no secret is a 401', noSecret.status === 401, String(noSecret.status));

const badSecret = await ingest('magicbricks', 'not-a-real-secret', {
  client_name: 'X', contact_number: '9000000002',
});
ok('a wrong secret is a 401', badSecret.status === 401, String(badSecret.status));

// A key minted for one portal must not work as another — otherwise the
// per-source attribution and revocation are decorative.
const wrongPortal = await ingest('99acres', mb.secret, {
  sender_name: 'X', sender_phone: '9000000003',
});
ok('a MagicBricks key cannot post as 99acres', wrongPortal.status === 401, String(wrongPortal.status));

// Cross-tenant: A's key must not reach B.
const bLeadsBefore = Number((await admin.query(
  `SELECT count(*)::int n FROM leads WHERE tenant_id=$1`, [B.tenantId])).rows[0].n);
await ingest('magicbricks', mb.secret, { client_name: 'Y', contact_number: '9000000004' });
ok('a key resolves only to its own workspace',
   Number((await admin.query(
     `SELECT count(*)::int n FROM leads WHERE tenant_id=$1`, [B.tenantId])).rows[0].n) === bLeadsBefore);

console.log('\n=== A SECRET IN THE QUERY STRING WORKS, BECAUSE SOME PORTALS CANNOT SEND HEADERS ===');
const viaQuery = await ingest('magicbricks', mb.secret,
  { client_name: 'Query Buyer', contact_number: '9000000005' }, { via: 'query' });
ok('a query-string secret is accepted', viaQuery.status === 201, String(viaQuery.status));

console.log('\n=== ROTATION AND REVOCATION ===');
const rotated = await api(A.token, '/api/lead-sources', {
  method: 'POST', body: JSON.stringify({ sourceKey: 'magicbricks' }),
});
const newSecret = (await rotated.json()).secret;
ok('re-minting produces a different secret', newSecret !== mb.secret);
const oldKey = await ingest('magicbricks', mb.secret, { client_name: 'Z', contact_number: '9000000006' });
ok('the old one stops working immediately', oldKey.status === 401, String(oldKey.status));
const newKey = await ingest('magicbricks', newSecret, { client_name: 'Z', contact_number: '9000000006' });
ok('and the new one works', newKey.status === 201, String(newKey.status));

const sourceId = listed.sources.find(s => s.sourceKey === 'magicbricks').id;
await api(A.token, `/api/lead-sources/${sourceId}`, {
  method: 'PATCH', body: JSON.stringify({ active: false }),
});
const disabled = await ingest('magicbricks', newSecret, { client_name: 'Q', contact_number: '9000000007' });
ok('a deactivated source is refused', disabled.status === 401, String(disabled.status));

console.log('\n=== OPERATIONAL VISIBILITY ===');
const after = await (await api(A.token, '/api/lead-sources')).json();
const mbSource = after.sources.find(s => s.sourceKey === 'magicbricks');
ok('the received count is tracked', Number(mbSource.receivedCount) >= 1, String(mbSource.receivedCount));
ok('and the last time it was seen',
   !!mbSource.lastSeenAt, 'no last_seen — "when did MagicBricks stop sending?" is unanswerable');

console.log('\n=== A LEAD WITH NO WAY TO CONTACT THEM IS NOT A LEAD ===');
const noContact = await ingest('housing', hsSecret, { user_name: 'Anonymous' });
ok('a payload with neither phone nor email is a 400', noContact.status === 400, String(noContact.status));

const noPerm = await workspace('c', ['view_leads']);
const denied = await api(noPerm.token, '/api/lead-sources', {
  method: 'POST', body: JSON.stringify({ sourceKey: 'website' }),
});
ok('a read-only user cannot mint a credential', denied.status === 403, String(denied.status));

for (const w of [A, B, noPerm]) await admin.query('DELETE FROM tenants WHERE id = $1', [w.tenantId]);
await admin.end();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
