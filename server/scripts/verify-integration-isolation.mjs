/**
 * Two builders, each with their own integrations, on one platform.
 *
 * THE QUESTION
 *
 * Every workspace connects its own portals, its own WhatsApp number, its own
 * telephony account. Those connections are the one part of the product where
 * an OUTSIDE system reaches in WITH NO SESSION — a portal posting an enquiry,
 * a provider reporting a call, a gateway delivering a message. There is no
 * token to derive a tenant from, so in every case the SECRET IS THE IDENTITY:
 * the workspace is resolved from the credential presented.
 *
 * Which means a mistake here does not leak a field. It puts one builder's
 * enquiries, calls and conversations into another builder's CRM.
 *
 * WHAT MAKES THIS DIFFERENT FROM verify-rls AND verify-confidentiality
 *
 * Those test callers who ARE authenticated — a user of workspace B asking for
 * workspace A's rows, refused by RLS or by a WHERE clause. Nothing there
 * exercises the unauthenticated path, because there is no session to hold
 * wrong. This file only tests that path.
 *
 * Four boundaries, and the failure mode of each:
 *
 *   1. Lead ingest      A's portal key must reach A's pipeline and no other,
 *                       and must not work for a portal it was not minted for.
 *   2. Telephony        A's callback secret must attach the call to A.
 *   3. Payments         a gateway event must follow the ORDER's workspace, not
 *                       anything the payload claims.
 *   4. Credentials      neither builder may read the other's stored secrets,
 *                       and no API may hand back a secret after minting it.
 *
 * And two properties that only matter with more than one tenant, which is
 * exactly the case a single-tenant test never covers: the two workspaces must
 * be able to run THE SAME portal independently, and revoking one must leave
 * the other working.
 */
import pg from 'pg';
import argon2 from 'argon2';
import { createHash, randomBytes } from 'node:crypto';

const BASE = process.env.API_BASE ?? 'http://localhost:4055';
const PW = 'Test1234!';
const MARK = 'iso' + Math.random().toString(36).slice(2, 7);
let pass = 0, fail = 0;
const leaks = [];
const ok = (n, c, x = '') => {
  if (c) { pass++; console.log('  ✓ ' + n); }
  else { fail++; leaks.push(n); console.log('  ✗ ' + n + (x ? '  -> ' + x : '')); }
};

const admin = new pg.Client(process.env.DATABASE_ADMIN_URL
  ?? 'postgres://postgres:postgres@localhost:5433/erp_test');
await admin.connect();

const PIPELINE = { stages: [
  { key: 'new', id: 'new', label: 'New', core: true },
  { key: 'booked', id: 'booked', label: 'Booked', core: true },
  { key: 'lost', id: 'lost', label: 'Lost', core: true },
] };

/** Mirrors hashSourceSecret in src/leadIngest.ts. */
const hashSecret = (t) => createHash('sha256').update(t).digest('hex');

async function builder(tag, name) {
  const t = (await admin.query(
    `INSERT INTO tenants (name, company, slug, email) VALUES ($1,$1,$2,$3) RETURNING id`,
    [name, `${MARK}-${tag}`, `${MARK}-${tag}@iso.test`])).rows[0];
  await admin.query(
    `INSERT INTO schema_definitions (tenant_id, entity, kind, version, is_active, definition)
     VALUES ($1,'lead','pipeline',1,true,$2)
     ON CONFLICT (tenant_id, entity, kind, version) DO UPDATE SET is_active = true`,
    [t.id, JSON.stringify(PIPELINE)]);

  const role = (await admin.query(
    `INSERT INTO roles (tenant_id, name, is_system) VALUES ($1,'owner',false) RETURNING id`,
    [t.id])).rows[0];
  await admin.query(
    `INSERT INTO role_permissions (role_id, permission_key)
     SELECT $1, k FROM unnest($2::text[]) k ON CONFLICT DO NOTHING`,
    [role.id, ['view_leads', 'manage_leads', 'manage_settings', 'view_dashboard', 'manage_users']]);

  const email = `${MARK}-${tag}@iso.test`;
  const u = (await admin.query(
    `INSERT INTO users (tenant_id, role_id, name, email, password_hash, active)
     VALUES ($1,$2,$3,$4,$5,true) RETURNING id`,
    [t.id, role.id, name, email, await argon2.hash(PW, { type: argon2.argon2id })])).rows[0];
  const token = (await (await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PW }),
  })).json()).token;
  if (!token) throw new Error(`login failed for ${email}`);
  return { tenantId: t.id, userId: u.id, token, name };
}

const get = (t, p) => fetch(BASE + p, { headers: { Authorization: `Bearer ${t}` } });
const jget = async (t, p) => { const r = await get(t, p); return { status: r.status, body: await r.json().catch(() => ({})) }; };
const send = (t, p, method, body) => fetch(BASE + p, {
  method, headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const contains = (payload, secret) => JSON.stringify(payload ?? {}).includes(String(secret));

/** A portal posting an enquiry: no session, only the source secret. */
const ingest = (source, secret, lead) => fetch(`${BASE}/api/public/leads/ingest/${source}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'x-lead-source-secret': secret },
  body: JSON.stringify(lead),
});

// ── two builders on one platform ───────────────────────────────────────────
const A = await builder('acme', 'Acme Builders');
const B = await builder('rival', 'Rival Estates');

// Each connects the SAME portal, independently. This is the case that only
// exists with more than one tenant, and the one a single-tenant fixture can
// never exercise.
const secretA = randomBytes(32).toString('base64url');
const secretB = randomBytes(32).toString('base64url');
for (const [w, s] of [[A, secretA], [B, secretB]]) {
  await admin.query(
    `INSERT INTO lead_sources (tenant_id, source_key, secret_hash, active)
     VALUES ($1,'magicbricks',$2,true)`, [w.tenantId, hashSecret(s)]);
}
// A also runs its own website form — a second credential in the same
// workspace, so "wrong portal" can be tested without leaving the tenant.
const secretAWebsite = randomBytes(32).toString('base64url');
await admin.query(
  `INSERT INTO lead_sources (tenant_id, source_key, secret_hash, active)
   VALUES ($1,'website',$2,true)`, [A.tenantId, hashSecret(secretAWebsite)]);

console.log('\n=== 1. A PORTAL ENQUIRY LANDS IN THE WORKSPACE THAT OWNS THE KEY ===');
const inA = await ingest('magicbricks', secretA,
  { name: 'Acme Prospect', phone: '9820000001', message: 'Interested in 3BHK' });
ok('A’s MagicBricks key is accepted', inA.status === 200 || inA.status === 201, String(inA.status));

const inB = await ingest('magicbricks', secretB,
  { name: 'Rival Prospect', phone: '9820000002', message: 'Interested in 2BHK' });
ok('B’s MagicBricks key is accepted — the same portal, two builders',
  inB.status === 200 || inB.status === 201, String(inB.status));

const aLeads = (await jget(A.token, '/api/leads')).body.leads ?? [];
const bLeads = (await jget(B.token, '/api/leads')).body.leads ?? [];
ok('A sees its own enquiry', aLeads.some(l => l.name === 'Acme Prospect'),
  JSON.stringify(aLeads.map(l => l.name)));
ok('and NOT the rival’s', !aLeads.some(l => l.name === 'Rival Prospect'),
  JSON.stringify(aLeads.map(l => l.name)));
ok('B sees its own', bLeads.some(l => l.name === 'Rival Prospect'));
ok('and NOT Acme’s', !bLeads.some(l => l.name === 'Acme Prospect'),
  JSON.stringify(bLeads.map(l => l.name)));
ok('neither enquiry reached both workspaces',
  aLeads.length === 1 && bLeads.length === 1, `${aLeads.length}/${bLeads.length}`);

console.log('\n=== 2. A KEY IS BOUND TO ONE PORTAL AND ONE WORKSPACE ===');
// The portal names the source in the URL. If that were not checked against the
// key, a credential minted for a website form could post as MagicBricks — and
// lead-source attribution is what broker commission is paid on.
const wrongPortal = await ingest('magicbricks', secretAWebsite,
  { name: 'Mislabelled', phone: '9820000003' });
ok('A’s website key cannot post as MagicBricks', wrongPortal.status === 401, String(wrongPortal.status));

const noSecret = await fetch(`${BASE}/api/public/leads/ingest/magicbricks`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: 'Anonymous', phone: '9820000004' }),
});
ok('and no key at all is refused', noSecret.status === 401, String(noSecret.status));

const madeUp = await ingest('magicbricks', randomBytes(32).toString('base64url'),
  { name: 'Forged', phone: '9820000005' });
ok('nor an invented one', madeUp.status === 401, String(madeUp.status));

// The payload must not be able to steer the workspace. A portal that could
// name a tenant would make the secret decorative.
const steered = await fetch(`${BASE}/api/public/leads/ingest/magicbricks`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'x-lead-source-secret': secretA },
  body: JSON.stringify({ name: 'Steered', phone: '9820000006', tenantId: B.tenantId, tenant_id: B.tenantId }),
});
const bAfter = (await jget(B.token, '/api/leads')).body.leads ?? [];
ok('[STEERING] a payload naming another workspace cannot redirect the lead',
  !bAfter.some(l => l.name === 'Steered'), JSON.stringify(bAfter.map(l => l.name)));
const aAfter = (await jget(A.token, '/api/leads')).body.leads ?? [];
ok('it lands in the key’s own workspace instead',
  steered.status >= 400 || aAfter.some(l => l.name === 'Steered'),
  `${steered.status} / ${JSON.stringify(aAfter.map(l => l.name))}`);

console.log('\n=== 3. THE DATABASE FORBIDS A SHARED SECRET (064) ===');
// Both lookups resolve the tenant with the first row they match, so a
// duplicate has no defined answer — the enquiry lands wherever the scan got to
// first. Entropy made that improbable; the constraint makes it impossible.
let collided = false;
try {
  await admin.query(
    `INSERT INTO lead_sources (tenant_id, source_key, secret_hash, active)
     VALUES ($1,'housing',$2,true)`, [B.tenantId, hashSecret(secretA)]);
  collided = true;
} catch { /* the unique index did its job */ }
ok('a rival workspace cannot claim A’s active source secret', !collided,
  collided ? 'the duplicate INSERT was accepted' : '');

// A retired secret must not block the workspace that rotates it.
await admin.query(
  `INSERT INTO lead_sources (tenant_id, source_key, secret_hash, active)
   VALUES ($1,'housing',$2,false)`, [B.tenantId, hashSecret(secretA)]);
ok('but an INACTIVE row may hold any hash — rotation is not blocked', true);

console.log('\n=== 4. REVOKING ONE BUILDER DOES NOT TOUCH THE OTHER ===');
await admin.query(
  `UPDATE lead_sources SET active = false WHERE tenant_id = $1 AND source_key = 'magicbricks'`,
  [A.tenantId]);
const afterRevoke = await ingest('magicbricks', secretA, { name: 'Too Late', phone: '9820000007' });
ok('A’s revoked key stops working', afterRevoke.status === 401, String(afterRevoke.status));
const stillB = await ingest('magicbricks', secretB, { name: 'Rival Second', phone: '9820000008' });
ok('B’s key is unaffected', stillB.status === 200 || stillB.status === 201, String(stillB.status));

console.log('\n=== 5. A CALL CALLBACK ATTACHES TO THE WORKSPACE THAT OWNS THE SECRET ===');
// Same shape as lead ingest: the provider cannot name the workspace, so the
// secret is the identity. Configured through the API so the digest is minted
// the way production mints it.
const cfgA = await (await send(A.token, '/api/telephony/settings', 'PUT',
  { accountSid: 'acme-sid', callerId: '02248880001', active: true })).json();
const cfgB = await (await send(B.token, '/api/telephony/settings', 'PUT',
  { accountSid: 'rival-sid', callerId: '02248880002', active: true })).json();
ok('each builder mints its own callback secret',
  !!cfgA.callbackSecret && !!cfgB.callbackSecret && cfgA.callbackSecret !== cfgB.callbackSecret);

const { rows: [aTel] } = await admin.query(
  'SELECT callback_secret_hash FROM telephony_settings WHERE tenant_id = $1', [A.tenantId]);
const { rows: [bTel] } = await admin.query(
  'SELECT callback_secret_hash FROM telephony_settings WHERE tenant_id = $1', [B.tenantId]);
ok('and the two digests differ', aTel.callback_secret_hash !== bTel.callback_secret_hash);

const CALL_SID = `${MARK}-call-1`;
// A call belongs to a lead, so it hangs off one of A's own enquiries — which
// also means a cross-tenant update would be reaching into A's pipeline.
const { rows: [aLeadRow] } = await admin.query(
  `SELECT id FROM leads WHERE tenant_id = $1 ORDER BY created_at LIMIT 1`, [A.tenantId]);
await admin.query(
  `INSERT INTO call_logs (tenant_id, lead_id, provider, provider_call_id, direction, status)
   VALUES ($1,$2,'exotel',$3,'outbound','ringing')`, [A.tenantId, aLeadRow.id, CALL_SID]);

// B's secret, A's call. If the callback resolved the workspace from anything
// in the payload, this would update A's record under B's credential.
const crossCallback = await fetch(
  `${BASE}/api/webhooks/telephony?secret=${encodeURIComponent(cfgB.callbackSecret)}`,
  { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ CallSid: CALL_SID, Status: 'completed', RecordingUrl: 'https://evil/rec.mp3' }) });
const { rows: [callAfter] } = await admin.query(
  'SELECT status, recording_url FROM call_logs WHERE provider_call_id = $1', [CALL_SID]);
// Asserted as "did not move" rather than against a specific mapped status:
// the boundary is about WHOSE secret may change the row, not about how Exotel
// vocabulary maps onto ours, which mapExotelStatus owns and tests elsewhere.
ok('B’s callback secret cannot advance A’s call',
  callAfter.status === 'ringing',
  `${crossCallback.status} → status=${callAfter.status}`);
ok('nor attach a recording URL to it',
  !callAfter.recording_url, String(callAfter.recording_url));

const ownCallback = await fetch(
  `${BASE}/api/webhooks/telephony?secret=${encodeURIComponent(cfgA.callbackSecret)}`,
  { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ CallSid: CALL_SID, Status: 'completed', RecordingUrl: 'https://acme/rec.mp3' }) });
const { rows: [callOwn] } = await admin.query(
  'SELECT status, recording_url FROM call_logs WHERE provider_call_id = $1', [CALL_SID]);
ok('[CONTROL] A’s own secret does advance it — the boundary narrowed, not closed',
  ownCallback.status === 200 && callOwn.status !== 'ringing',
  `${ownCallback.status} → ${callOwn.status}`);
ok('[CONTROL] and its recording is attached',
  callOwn.recording_url === 'https://acme/rec.mp3', String(callOwn.recording_url));

// This control is the assertion that FOUND the defect below, and it is worth
// saying why it is a control rather than a nicety. The two negative assertions
// above passed while the product was broken: B could not advance A's call, but
// neither could A. A privacy suite made only of negatives calls that a success.
console.log('\n=== 5b. ONE BUILDER’S WEBHOOK CANNOT SILENCE ANOTHER’S (065) ===');
//
// Both webhook tables deduplicate redeliveries with ON CONFLICT DO NOTHING and
// treat "no row" as "already seen" — correct, because a provider retries until
// it gets a 2xx. But the keys were GLOBAL:
//
//   telephony_events  UNIQUE (provider, provider_call_id, event_status)
//   gateway_events    UNIQUE (provider, event_id)
//
// so the first workspace to record an id owned it for every workspace. B's
// callback above claimed ('exotel', <A's call id>, connected) under tenant B;
// A's real callback then inserted nothing, was answered 200 as a duplicate,
// and A's call log never moved. No error anywhere.
//
// It needs no attacker: provider ids are unique within an ACCOUNT and every
// builder connects their own, so two accounts issuing the same id is ordinary.
// With one it is money — a workspace can pre-claim ids and suppress another
// builder's payment confirmations.
const keyed = async (table, cols) => (await admin.query(
  `SELECT count(*)::int c FROM pg_constraint
    WHERE conrelid = $1::regclass AND contype = 'u'
      AND pg_get_constraintdef(oid) = $2`, [table, cols])).rows[0].c;

ok('telephony idempotency is scoped to the workspace',
  await keyed('telephony_events', 'UNIQUE (tenant_id, provider, provider_call_id, event_status)') === 1);
ok('and the global key that caused this is gone',
  await keyed('telephony_events', 'UNIQUE (provider, provider_call_id, event_status)') === 0);
ok('gateway idempotency is scoped to the workspace',
  await keyed('gateway_events', 'UNIQUE (tenant_id, provider, event_id)') === 1);
ok('and its global key is gone too',
  await keyed('gateway_events', 'UNIQUE (provider, event_id)') === 0);

// The behaviour, not just the constraint: two workspaces may now record the
// same provider call id independently, which is what colliding accounts do.
const SHARED_ID = `${MARK}-shared-call`;
let bothRecorded = true;
try {
  for (const w of [A, B]) {
    await admin.query(
      `INSERT INTO telephony_events (tenant_id, provider, provider_call_id, event_status, payload)
       VALUES ($1,'exotel',$2,'connected','{}'::jsonb)`, [w.tenantId, SHARED_ID]);
  }
} catch { bothRecorded = false; }
ok('two builders can receive the SAME provider call id without one losing it',
  bothRecorded);
const { rows: [shared] } = await admin.query(
  `SELECT count(*)::int c FROM telephony_events WHERE provider_call_id = $1`, [SHARED_ID]);
ok('and both events exist, one per workspace', shared.c === 2, String(shared.c));

// Still deduplicated WITHIN a workspace — the property the key exists for.
let dupeRejected = false;
try {
  await admin.query(
    `INSERT INTO telephony_events (tenant_id, provider, provider_call_id, event_status, payload)
     VALUES ($1,'exotel',$2,'connected','{}'::jsonb)`, [A.tenantId, SHARED_ID]);
} catch { dupeRejected = true; }
ok('[CONTROL] a genuine redelivery is still deduplicated inside the workspace',
  dupeRejected);

console.log('\n=== 6. NEITHER BUILDER CAN READ THE OTHER’S CREDENTIALS ===');
// A stored integration secret is the workspace's identity to a third party.
// Reading one is impersonating that builder to their own portal or provider.
const aSettings = (await jget(A.token, '/api/telephony/settings')).body;
ok('the telephony settings API never returns a secret, even its own',
  !contains(aSettings, cfgA.callbackSecret), JSON.stringify(aSettings).slice(0, 120));
ok('and certainly not the rival’s', !contains(aSettings, cfgB.callbackSecret));
ok('it says only whether one is configured', aSettings.settings?.callbackConfigured === true);

const aSources = (await jget(A.token, '/api/lead-sources')).body;
ok('the lead-source list never returns a plaintext secret',
  !contains(aSources, secretA) && !contains(aSources, secretAWebsite),
  JSON.stringify(aSources).slice(0, 120));
ok('nor the rival’s portal secret', !contains(aSources, secretB));
ok('nor any stored digest, which is enough to verify with',
  !contains(aSources, aTel.callback_secret_hash) && !contains(aSources, hashSecret(secretA)));

const bSources = (await jget(B.token, '/api/lead-sources')).body;
const bList = bSources.sources ?? bSources.leadSources ?? [];
ok('B’s source list contains only B’s own sources',
  Array.isArray(bList) && bList.every(s => !s.tenantId || s.tenantId === B.tenantId),
  JSON.stringify(bList).slice(0, 140));

console.log('\n=== 7. A GATEWAY EVENT FOLLOWS THE ORDER, NOT THE PAYLOAD ===');
// Razorpay events carry no workspace. The order reference is what ties an
// event to a builder, so a forged payload naming another tenant must change
// nothing — and an unsigned one must not be applied at all.
const forged = await fetch(`${BASE}/api/webhooks/razorpay`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'x-razorpay-event-id': `${MARK}-evt-1` },
  body: JSON.stringify({
    event: 'payment.captured',
    payload: { payment: { entity: { order_id: `${MARK}-order`, id: `${MARK}-pay`, amount: 100000 } } },
    tenant_id: A.tenantId,
  }),
});
ok('an unsigned gateway event is refused outright',
  forged.status === 401 || forged.status === 503, String(forged.status));
const { rows: evts } = await admin.query(
  'SELECT count(*)::int c FROM gateway_events WHERE event_id = $1', [`${MARK}-evt-1`]);
ok('and nothing was recorded against either workspace', evts[0].c === 0, String(evts[0].c));

console.log('\n=== 8. WHATSAPP INSTANCES ARE NAMED BY THE SERVER, NOT THE CALLER ===');
// Workspaces that have not brought their own gateway share the platform's
// Evolution instance, which has no tenant concept — instances are addressed by
// NAME. So the only thing keeping one builder off another's WhatsApp session
// is that no route accepts an instance name as input.
const { rows: [aSess] } = await admin.query(
  `INSERT INTO whatsapp_user_sessions (tenant_id, user_id, instance_name, status, webhook_token)
   VALUES ($1,$2,$3,'connected',$4) RETURNING webhook_token, instance_name`,
  [A.tenantId, A.userId, `erp-${MARK}-a`, `${MARK}-tok-a`]);

const bSeesA = (await jget(B.token, '/api/whatsapp/session')).body;
ok('B cannot see A’s WhatsApp session',
  !contains(bSeesA, aSess.instance_name) && !contains(bSeesA, aSess.webhook_token),
  JSON.stringify(bSeesA).slice(0, 140));

// The inbound webhook token is the tenant's identity for delivered messages.
const tokenCollision = await admin.query(
  `SELECT count(*)::int c FROM pg_indexes
    WHERE tablename = 'whatsapp_user_sessions' AND indexdef ILIKE '%UNIQUE%'
      AND indexdef ILIKE '%webhook_token%'`);
ok('the inbound webhook token is uniquely constrained across all workspaces',
  tokenCollision.rows[0].c > 0);

const forgedInbound = await fetch(`${BASE}/api/whatsapp/webhook/${MARK}-not-a-real-token`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ event: 'messages.upsert', data: {} }),
});
ok('an unknown webhook token delivers nowhere',
  forgedInbound.status >= 400 || forgedInbound.status === 200,
  String(forgedInbound.status));
const { rows: [stray] } = await admin.query(
  `SELECT count(*)::int c FROM lead_activities WHERE tenant_id = $1 AND type = 'whatsapp'`,
  [B.tenantId]);
ok('and wrote nothing into the other workspace', stray.c === 0, String(stray.c));

// ───────────────────────────────────────────────────────────────────────────
await admin.query('DELETE FROM tenants WHERE id = ANY($1::uuid[])', [[A.tenantId, B.tenantId]]);
await admin.end();

if (leaks.length) {
  console.log('\n----- BOUNDARIES THAT LEAKED -----');
  for (const l of leaks) console.log('  · ' + l);
}
console.log(`\n===== ${pass} passed, ${fail} failed =====`);
process.exit(fail ? 1 : 0);
