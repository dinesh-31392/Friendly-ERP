/**
 * Click-to-call — the last integration on the readiness review.
 *
 * WHAT THIS IS FOR
 *
 * `call_logs` was described as "already there waiting for a provider", and it
 * was — but only for a call somebody had already made and typed in afterwards.
 * It had no provider link, no in-flight state, and no notion of an inbound call.
 *
 * THE ASSERTIONS THAT MATTER
 *
 * The rep's own number never reaches the customer. That is the entire reason to
 * run calls through a provider rather than a tel: link — a rep who calls from
 * their SIM hands a stranger their personal mobile permanently, and keeps
 * getting rung after they leave the builder.
 *
 * The customer's number comes from the LEAD, never from the request. A client
 * that could name the number to dial could use the builder's telephony account
 * to ring anybody, billed to the builder.
 *
 * And a provider redelivers. Without an idempotency key the same callback
 * writes the same call twice.
 */
import pg from 'pg';
import argon2 from 'argon2';

const BASE = process.env.API_BASE ?? 'http://localhost:4055';
const PW = 'Test1234!';
const MARK = 'tel' + Math.random().toString(36).slice(2, 7);
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + (x ? '  -> ' + x : ''))); };

const admin = new pg.Client(process.env.DATABASE_ADMIN_URL
  ?? 'postgres://postgres:postgres@localhost:5433/erp_test');
await admin.connect();

async function workspace(slug, perms, { agentPhone = '+91 98200 55555' } = {}) {
  const t = (await admin.query(
    `INSERT INTO tenants (name, company, slug, email) VALUES ($1,$1,$2,$3) RETURNING id`,
    [`${MARK} ${slug}`, `${MARK}-${slug}`, `${MARK}-${slug}@tel.test`])).rows[0];
  const role = (await admin.query(
    `INSERT INTO roles (tenant_id, name, is_system) VALUES ($1,'Sales',false) RETURNING id`, [t.id])).rows[0];
  if (perms.length) {
    await admin.query(
      `INSERT INTO role_permissions (role_id, permission_key)
       SELECT $1, k FROM unnest($2::text[]) k ON CONFLICT DO NOTHING`, [role.id, perms]);
  }
  const email = `${MARK}-${slug}@tel.test`;
  await admin.query(
    `INSERT INTO users (tenant_id, role_id, name, email, password_hash, active, phone)
     VALUES ($1,$2,'Rep',$3,$4,true,$5)`,
    [t.id, role.id, email, await argon2.hash(PW, { type: argon2.argon2id }), agentPhone]);
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
  return { tenantId: t.id, token };
}

const lead = async (w, name, phone) => (await admin.query(
  `INSERT INTO leads (tenant_id, name, email, phone) VALUES ($1,$2,$3,$4) RETURNING id`,
  [w.tenantId, name, `${name.toLowerCase().replace(/\W/g,'')}-${MARK}@tel.test`, phone])).rows[0].id;

const api = (token, path, init = {}) => fetch(BASE + path, {
  ...init,
  headers: { ...(init.body ? { 'Content-Type': 'application/json' } : {}), Authorization: `Bearer ${token}` },
});
const post = (token, path, body) => api(token, path, { method: 'POST', body: body ? JSON.stringify(body) : undefined });

const callback = (secret, body) => fetch(
  BASE + `/api/webhooks/telephony?secret=${encodeURIComponent(secret)}`,
  { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

const A = await workspace('a', ['view_leads', 'manage_settings']);
const B = await workspace('b', ['view_leads', 'manage_settings']);

console.log('\n=== THE NUMBER FORMATTER REFUSES WHAT IT CANNOT DIAL ===');
// Exercised directly: a number the provider would reject must stop the call
// here, because placing one to a wrong number is worse than not placing it.
const { dialable, mapExotelStatus, isValid } = await import('../src/telephony.ts')
  .then(m => ({ dialable: m.dialable, mapExotelStatus: m.mapExotelStatus }));
ok('a ten-digit mobile gets the country code', dialable('9820011111') === '+919820011111', dialable('9820011111'));
ok('a leading zero is dropped', dialable('09820011111') === '+919820011111', dialable('09820011111'));
ok('an already-prefixed number is left alone', dialable('+91 98200 11111') === '+919820011111');
ok('a landline-length string still dials', dialable('02240001000').startsWith('+91'));
ok('nonsense returns empty rather than something arbitrary', dialable('123') === '', dialable('123'));

console.log('\n=== AN UNKNOWN PROVIDER STATUS IS NEVER "CONNECTED" ===');
// A call whose outcome we do not understand must not be recorded as a
// conversation that happened.
ok('completed maps to connected', mapExotelStatus('completed') === 'connected');
ok('no-answer stays distinct from busy',
   mapExotelStatus('no-answer') === 'no_answer' && mapExotelStatus('busy') === 'busy');
ok('an unrecognised status becomes failed, not connected',
   mapExotelStatus('something-new') === 'failed', mapExotelStatus('something-new'));

console.log('\n=== SETTINGS HAND BACK A SECRET EXACTLY ONCE ===');
const saved = await api(A.token, '/api/telephony/settings', {
  method: 'PUT',
  body: JSON.stringify({ accountSid: 'acme1', callerId: '02248889999', active: true }),
});
ok('settings are stored', saved.status === 200, String(saved.status));
const s1 = await saved.json();
ok('a callback secret comes back', typeof s1.callbackSecret === 'string' && s1.callbackSecret.length > 20);
ok('with the URL to paste into the provider', /\/api\/webhooks\/telephony\?secret=/.test(s1.callbackUrl ?? ''));
ok('the caller id is normalised to a dialable form', s1.settings.callerId === '+912248889999', s1.settings.callerId);

const stored = (await admin.query(
  'SELECT callback_secret_hash FROM telephony_settings WHERE tenant_id = $1', [A.tenantId])).rows[0];
ok('the plaintext is not in the database', stored.callback_secret_hash !== s1.callbackSecret);
ok('a SHA-256 digest is', /^[0-9a-f]{64}$/.test(stored.callback_secret_hash));

const readBack = await (await api(A.token, '/api/telephony/settings')).json();
ok('reading settings never returns the secret',
   !JSON.stringify(readBack).includes(s1.callbackSecret), 'the secret leaked');
ok('but does say one is configured', readBack.settings.callbackConfigured === true);

const badCaller = await api(A.token, '/api/telephony/settings', {
  method: 'PUT', body: JSON.stringify({ accountSid: 'acme1', callerId: 'not-a-number' }),
});
ok('an undialable caller id is refused', badCaller.status === 400, String(badCaller.status));

console.log('\n=== RECORDING IS OFF UNTIL SOMEBODY DECIDES ===');
// India requires the caller to be told. Nobody should inherit that from a
// migration default.
ok('recording defaults to off', readBack.settings.recordCalls === false);
const withRec = await (await api(A.token, '/api/telephony/settings', {
  method: 'PUT',
  body: JSON.stringify({ accountSid: 'acme1', callerId: '02248889999', active: true, recordCalls: true }),
})).json();
ok('turning it on returns the legal notice',
   /must be told the call is being recorded/i.test(withRec.recordingNotice ?? ''),
   withRec.recordingNotice ?? '(none)');

console.log('\n=== A CALL IS NOT PLACED WITHOUT THE PIECES ===');
const buyer = await lead(A, 'Ramesh', '+91 98200 12345');

const noAgent = await workspace('c', ['view_leads', 'manage_settings'], { agentPhone: '' });
await api(noAgent.token, '/api/telephony/settings', {
  method: 'PUT', body: JSON.stringify({ accountSid: 'x', callerId: '02248889999', active: true }),
});
const theirLead = await lead(noAgent, 'Someone', '+91 98200 22222');
const agentless = await post(noAgent.token, `/api/leads/${theirLead}/call`);
// The agent leg is dialled FIRST. Without their number the customer must not
// be rung instead.
ok('a rep with no number of their own cannot place a call',
   [409, 503].includes(agentless.status), String(agentless.status));

const unreachable = await lead(A, 'No Number', '');
const noNumber = await post(A.token, `/api/leads/${unreachable}/call`);
ok('a lead with no dialable number is refused',
   [409, 503].includes(noNumber.status), String(noNumber.status));

const configured = !!process.env.EXOTEL_API_KEY;
console.log(`\n(provider credentials ${configured ? 'ARE' : 'are NOT'} set in this environment)`);
if (!configured) {
  const unconfigured = await post(A.token, `/api/leads/${buyer}/call`);
  ok('without credentials, calling fails clearly rather than half-working',
     unconfigured.status === 503, String(unconfigured.status));
  ok('and names the variables', /EXOTEL_API_KEY/.test((await unconfigured.json()).error ?? ''));
}

console.log('\n=== THE CALLBACK IS THE ONLY THING THAT UPDATES A CALL ===');
// A placed call written directly, so the callback path is exercised without
// live provider credentials — the secret and idempotency logic are ours.
const CALL_SID = 'CA' + MARK + '01';
const callRow = (await admin.query(
  `INSERT INTO call_logs (tenant_id, lead_id, mode, provider, provider_call_id,
                          direction, status, caller_id, initiated_at)
   VALUES ($1,$2,'API_CLOUD','exotel',$3,'outbound','ringing','+912248889999', now())
   RETURNING id`, [A.tenantId, buyer, CALL_SID])).rows[0];

const noSecret = await fetch(BASE + '/api/webhooks/telephony', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ CallSid: CALL_SID, Status: 'completed' }),
});
ok('a callback with no secret is refused', noSecret.status === 401, String(noSecret.status));

const wrongSecret = await callback('not-the-secret', { CallSid: CALL_SID, Status: 'completed' });
ok('a wrong secret is refused', wrongSecret.status === 401, String(wrongSecret.status));

ok('and neither touched the call',
   (await admin.query('SELECT status FROM call_logs WHERE id=$1', [callRow.id])).rows[0].status === 'ringing');

// A's secret was rotated when recording was turned on, so use the current one.
const rotated = await (await api(A.token, '/api/telephony/settings', {
  method: 'PUT',
  body: JSON.stringify({ accountSid: 'acme1', callerId: '02248889999', active: true, rotateSecret: true }),
})).json();
const SECRET = rotated.callbackSecret;

const ringing = await callback(SECRET, { CallSid: CALL_SID, Status: 'in-progress' });
ok('a correctly signed callback is accepted', ringing.status === 200, String(ringing.status));
const afterAnswer = (await admin.query(
  'SELECT status, answered_at, ended_at FROM call_logs WHERE id=$1', [callRow.id])).rows[0];
ok('the call moves to in progress', afterAnswer.status === 'in_progress', afterAnswer.status);
ok('and the moment it was answered is stamped', !!afterAnswer.answered_at);
ok('but it has not ended', !afterAnswer.ended_at);

const done = await callback(SECRET, {
  CallSid: CALL_SID, Status: 'completed', ConversationDuration: '184',
  RecordingUrl: 'https://recordings.example/abc.mp3',
});
ok('the completion is accepted', done.status === 200, String(done.status));
const final = (await admin.query(
  'SELECT status, duration_seconds, recording_url, ended_at FROM call_logs WHERE id=$1',
  [callRow.id])).rows[0];
ok('the call is connected', final.status === 'connected', final.status);
ok('the duration is recorded', Number(final.duration_seconds) === 184, String(final.duration_seconds));
ok('the recording is linked', /abc\.mp3/.test(final.recording_url ?? ''), final.recording_url);
ok('and the end is stamped', !!final.ended_at);

console.log('\n=== A REDELIVERY CHANGES NOTHING ===');
// Providers retry until they get a 2xx. Without an idempotency key the same
// callback writes the same call twice.
const replay = await callback(SECRET, {
  CallSid: CALL_SID, Status: 'completed', ConversationDuration: '999',
});
ok('the redelivery returns 200, so the retry loop stops', replay.status === 200, String(replay.status));
ok('and says it was a duplicate', (await replay.json()).duplicate === true);
const unchanged = (await admin.query(
  'SELECT duration_seconds FROM call_logs WHERE id=$1', [callRow.id])).rows[0];
ok('the duration is not overwritten by the retry',
   Number(unchanged.duration_seconds) === 184, String(unchanged.duration_seconds));
ok('and only one call row exists for the provider id',
   Number((await admin.query(
     `SELECT count(*)::int n FROM call_logs WHERE provider_call_id=$1`, [CALL_SID])).rows[0].n) === 1);

const dbDup = await admin.query(
  `INSERT INTO call_logs (tenant_id, lead_id, mode, provider, provider_call_id, status)
   VALUES ($1,$2,'API_CLOUD','exotel',$3,'ringing')`, [A.tenantId, buyer, CALL_SID])
  .then(() => 'inserted', e => e.code);
ok('the schema refuses a second row for the same provider call', dbDup === '23505', String(dbDup));

console.log('\n=== A CALLBACK FOR AN UNKNOWN CALL IS ACKNOWLEDGED ===');
const orphan = await callback(SECRET, { CallSid: 'CA-never-placed', Status: 'completed' });
ok('it returns 200 rather than retrying forever', orphan.status === 200, String(orphan.status));
ok('and reports that nothing matched', (await orphan.json()).matched === false);

console.log('\n=== ONE WORKSPACE CANNOT DRIVE ANOTHER\'S CALLS ===');
const bSaved = await (await api(B.token, '/api/telephony/settings', {
  method: 'PUT', body: JSON.stringify({ accountSid: 'rival', callerId: '02233332222', active: true }),
})).json();
const crossCall = 'CA' + MARK + '-b';
await admin.query(
  `INSERT INTO call_logs (tenant_id, lead_id, mode, provider, provider_call_id, status)
   VALUES ($1,$2,'API_CLOUD','exotel',$3,'ringing')`,
  [B.tenantId, await lead(B, 'Their Buyer', '+91 98200 99999'), crossCall]);

// A's secret must not be able to update B's call.
const crossUpdate = await callback(SECRET, { CallSid: crossCall, Status: 'completed' });
ok('a callback authenticated as A cannot touch B\'s call',
   (await crossUpdate.json()).matched === false, 'it matched across tenants');
ok('and B\'s call is untouched',
   (await admin.query('SELECT status FROM call_logs WHERE provider_call_id=$1', [crossCall]))
     .rows[0].status === 'ringing');
ok('B has its own distinct secret', bSaved.callbackSecret !== SECRET);

console.log('\n=== PERMISSIONS ===');
const readOnly = await workspace('d', ['view_leads']);
const denied = await api(readOnly.token, '/api/telephony/settings', {
  method: 'PUT', body: JSON.stringify({ accountSid: 'x', callerId: '02248889999' }),
});
ok('a user without manage_settings cannot configure telephony',
   denied.status === 403, String(denied.status));
ok('but can read the settings',
   (await api(readOnly.token, '/api/telephony/settings')).status === 200);

// ── The callback host, and the two names it used to have ───────────────────
//
// The call above is written straight into call_logs so the webhook path can be
// tested without a provider — which means nothing here ever observed the
// OUTBOUND request, and so nothing noticed that its callback URL was empty in
// every real deployment.
//
// This route read PUBLIC_BASE_URL; WhatsApp read `PUBLIC_URL || PUBLIC_BASE_URL`;
// deploy/docker-compose.prod.yml sets only PUBLIC_URL. So calls connected and
// their status, duration and recording never came back, silently, because the
// route treats an empty base as "this deployment does not know its own address"
// and omits the callback rather than sending a broken one.
//
// Both spellings now resolve in env.ts. Asserted in a subprocess because the
// value is computed once at import, so each case needs its own environment.
console.log('\n=== THE CALLBACK HOST RESOLVES UNDER EITHER NAME ===');
const { execFileSync } = await import('node:child_process');
const resolveWith = (extra) => {
  const out = execFileSync(process.execPath, [
    '-e', 'import("../src/env.ts").then(m => console.log(JSON.stringify(m.env.publicBaseUrl)))',
  ], {
    cwd: new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
    encoding: 'utf8',
    env: {
      ...process.env,
      PUBLIC_URL: '', PUBLIC_BASE_URL: '',
      ...extra,
    },
  });
  return JSON.parse(out.trim());
};

ok('PUBLIC_URL alone resolves — the spelling production actually sets',
  resolveWith({ PUBLIC_URL: 'https://erp.example.com' }) === 'https://erp.example.com');
ok('PUBLIC_BASE_URL alone resolves — the spelling this route used to require',
  resolveWith({ PUBLIC_BASE_URL: 'https://erp.example.com' }) === 'https://erp.example.com');
ok('a trailing slash is trimmed, so the callback is not //api/webhooks',
  resolveWith({ PUBLIC_URL: 'https://erp.example.com/' }) === 'https://erp.example.com');
ok('neither set resolves empty, which is what suppresses the callback',
  resolveWith({}) === '');

for (const w of [A, B, noAgent, readOnly]) await admin.query('DELETE FROM tenants WHERE id = $1', [w.tenantId]);
await admin.end();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
