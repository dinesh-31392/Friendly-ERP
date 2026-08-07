/**
 * Smoke: per-rep WhatsApp sessions through a MOCK Evolution API container.
 *
 * A real gateway needs a phone scanning a QR, so this spins up a mock that
 * implements the exact endpoints the server calls (instance/create, connect,
 * connectionState, sendText, logout, webhook/set) and records every call.
 * That lets us assert the parts that matter:
 *   • connect returns a QR and maps the instance to the LOGGED-IN user
 *   • two reps get two different instances; each send goes out via the
 *     CALLER's own instance (the per-rep routing the feature exists for)
 *   • the webhook flips status on connection.update, logs inbound messages
 *     against the matching lead in lead_activities, rejects bad tokens
 *   • outbound sends are logged to lead_activities too
 *   • secrets (Evolution API key) never appear in any client-facing response
 */
import http from 'node:http';
import pg from 'pg';
import argon2 from 'argon2';

const BASE = 'http://localhost:4055';
const MOCK_PORT = 4077;
const PW = 'Test1234!';
const PLATFORM = 'ed3c4904-829a-4e10-ad91-e17992f400b0';
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + (x ? '  -> ' + x : ''))); };

// ── mock Evolution container ────────────────────────────────────────────────
const calls = { create: [], connect: [], sendText: [], webhookSet: [], logout: [] };
const states = {};   // instanceName -> 'open' | 'connecting' | 'close'
const mock = http.createServer((req, res) => {
  const send = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (req.headers.apikey !== 'mock-evolution-key') return send(401, { message: 'invalid api key' });
  let raw = '';
  req.on('data', d => raw += d);
  req.on('end', () => {
    const body = raw ? JSON.parse(raw) : {};
    const url = req.url || '';
    if (url === '/instance/create' && req.method === 'POST') {
      if (calls.create.some(c => c.instanceName === body.instanceName)) return send(403, { response: { message: ['Instance already in use'] } });
      calls.create.push(body); states[body.instanceName] = 'connecting';
      return send(201, { instance: { instanceName: body.instanceName } });
    }
    let m;
    if ((m = url.match(/^\/instance\/connect\/(.+)$/)) && req.method === 'GET') {
      calls.connect.push(m[1]);
      return send(200, { base64: 'data:image/png;base64,TU9DS1FS', pairingCode: 'MOCK-1234' });
    }
    if ((m = url.match(/^\/instance\/connectionState\/(.+)$/)) && req.method === 'GET') {
      return send(200, { instance: { state: states[m[1]] ?? 'close' } });
    }
    if ((m = url.match(/^\/message\/sendText\/(.+)$/)) && req.method === 'POST') {
      calls.sendText.push({ instance: m[1], ...body });
      return send(201, { key: { id: 'MOCK-MSG-' + calls.sendText.length } });
    }
    if ((m = url.match(/^\/webhook\/set\/(.+)$/)) && req.method === 'POST') {
      calls.webhookSet.push({ instance: m[1], ...body }); return send(200, {});
    }
    if ((m = url.match(/^\/instance\/logout\/(.+)$/)) && req.method === 'DELETE') {
      calls.logout.push(m[1]); states[m[1]] = 'close'; return send(200, {});
    }
    return send(404, { message: 'mock: no route ' + req.method + ' ' + url });
  });
});
await new Promise(r => mock.listen(MOCK_PORT, r));

// ── fixtures ────────────────────────────────────────────────────────────────
const admin = new pg.Client('postgres://postgres:postgres@localhost:5433/erp_test');
await admin.connect();
const hash = await argon2.hash(PW, { type: argon2.argon2id });
await admin.query('UPDATE users SET password_hash=$1, active=true WHERE email = ANY($2)',
  [hash, ['admin@erptest.local', 'exec1@erptest.local', 'badmin@rival.test']]);

const MARK = 'WAE';
async function cleanup() {
  await admin.query(`DELETE FROM lead_activities WHERE lead_id IN (SELECT id FROM leads WHERE name LIKE '${MARK}%')`);
  await admin.query(`DELETE FROM leads WHERE name LIKE '${MARK}%'`);
  await admin.query(`DELETE FROM whatsapp_user_sessions WHERE tenant_id = $1`, [PLATFORM]);
  // Reset the tenant gateway config so the "unconfigured → 503" assertion is
  // reproducible on every run, not just the first.
  await admin.query(
    `UPDATE whatsapp_instances SET provider_type='click_to_chat', evolution_url='', evolution_api_key='' WHERE tenant_id = $1`, [PLATFORM]);
}
await cleanup();
const lead = (await admin.query(
  `INSERT INTO leads (tenant_id, name, phone, source, stage, priority, last_contact_at)
   VALUES ($1, '${MARK} Kavita Rao', '+91 98765-11122', 'Direct', 'new', 'warm', now()) RETURNING id`, [PLATFORM])).rows[0];

const login = async (email) => (await (await fetch(`${BASE}/api/auth/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email, password: PW }),
})).json()).token;
const adminTok = await login('admin@erptest.local');
const repTok = await login('exec1@erptest.local');
if (!adminTok || !repTok) { console.error('login failed'); process.exit(1); }
const H = (t) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${t}` });
const call = async (t, method, path, body) => {
  // Bodyless POSTs still send '{}' — the SPA client does the same, and Fastify
  // rejects an empty body when the json content-type header is present.
  const payload = method === 'GET' ? undefined : JSON.stringify(body ?? {});
  const r = await fetch(BASE + path, { method, headers: H(t), body: payload });
  return { status: r.status, body: await r.json().catch(() => null) };
};

// ── tenant gateway config ───────────────────────────────────────────────────
console.log('\n=== GATEWAY CONFIG ===');
const notConfigured = await call(adminTok, 'POST', '/api/whatsapp/connect');
ok('connect before config → 503', notConfigured.status === 503, `${notConfigured.status}`);
const save = await call(adminTok, 'PUT', '/api/whatsapp/instance',
  { provider: 'evolution', evolutionUrl: `http://localhost:${MOCK_PORT}`, evolutionApiKey: 'mock-evolution-key' });
ok('evolution provider saved + connected', save.status === 200 && save.body?.instance?.provider === 'evolution' && save.body?.instance?.status === 'connected', JSON.stringify(save.body)?.slice(0, 140));
ok('API key never returned to the client', !JSON.stringify(save.body).includes('mock-evolution-key'));
ok('client only learns hasEvolutionKey', save.body?.instance?.hasEvolutionKey === true);

// ── per-rep connect ─────────────────────────────────────────────────────────
console.log('\n=== PER-REP CONNECT ===');
const c1 = await call(adminTok, 'POST', '/api/whatsapp/connect');
ok('connect returns a QR', c1.status === 200 && (c1.body?.qrcode ?? '').includes('base64'), `${c1.status} ${JSON.stringify(c1.body)?.slice(0, 120)}`);
ok('session starts connecting', c1.body?.session?.status === 'connecting');
const inst1 = c1.body?.session?.instanceName ?? '';
ok('instance name is tenant+user scoped', /^erp-[0-9a-f]{10}-[0-9a-f]{10}$/.test(inst1), inst1);
const created1 = calls.create.find(c => c.instanceName === inst1);
ok('gateway got a per-session webhook URL with the token', !!created1 && /\/api\/whatsapp\/webhook\/[0-9a-f]{48}$/.test(created1.webhook?.url ?? ''), created1?.webhook?.url);

const c2 = await call(repTok, 'POST', '/api/whatsapp/connect');
const inst2 = c2.body?.session?.instanceName ?? '';
ok('second rep gets a DIFFERENT instance', !!inst2 && inst2 !== inst1, `${inst1} vs ${inst2}`);

// reconnect is idempotent — same instance, no duplicate create
const c1b = await call(adminTok, 'POST', '/api/whatsapp/connect');
ok('reconnect reuses the same instance', c1b.body?.session?.instanceName === inst1);
ok('no duplicate gateway instance created', calls.create.filter(c => c.instanceName === inst1).length === 1);

// ── status flip via webhook ─────────────────────────────────────────────────
console.log('\n=== WEBHOOK: CONNECTION UPDATE ===');
const token1 = (await admin.query('SELECT webhook_token FROM whatsapp_user_sessions WHERE instance_name=$1', [inst1])).rows[0].webhook_token;
const hook = async (tok, body) => { const r = await fetch(`${BASE}/api/whatsapp/webhook/${tok}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => null) }; };
const badTok = await hook('0'.repeat(48), { event: 'connection.update', data: { state: 'open' } });
ok('unknown webhook token → 401', badTok.status === 401, `${badTok.status}`);
const flip = await hook(token1, { event: 'connection.update', instance: inst1, data: { state: 'open', wuid: '919876500001@s.whatsapp.net' } });
ok('connection.update accepted', flip.status === 200);
states[inst1] = 'open';
const s1 = await call(adminTok, 'GET', '/api/whatsapp/session');
ok('session shows connected + learned phone', s1.body?.session?.status === 'connected' && s1.body?.session?.phone === '919876500001', JSON.stringify(s1.body?.session));

// ── per-rep send + outbound logging ─────────────────────────────────────────
console.log('\n=== SEND (per-rep routing + activity log) ===');
const send1 = await call(adminTok, 'POST', '/api/whatsapp/send', { to: '+91 98765-11122', body: 'Site visit this Saturday?', leadId: lead.id });
ok('send delivered via evolution', send1.status === 200 && send1.body?.delivered === true && send1.body?.provider === 'evolution', JSON.stringify(send1.body)?.slice(0, 120));
ok('dispatched through the CALLER\'s instance', calls.sendText.at(-1)?.instance === inst1, calls.sendText.at(-1)?.instance);
ok('number normalized to digits', calls.sendText.at(-1)?.number === '919876511122');
const outLog = (await admin.query(`SELECT * FROM lead_activities WHERE lead_id=$1 AND type='whatsapp'`, [lead.id])).rows;
ok('outbound logged to lead_activities', outLog.length === 1 && outLog[0].notes.includes('Site visit this Saturday?'), `${outLog.length}`);

// rep 2 has no connected session → falls back to click-to-chat, NOT rep 1's number
const send2 = await call(repTok, 'POST', '/api/whatsapp/send', { to: '+91 98765-11122', body: 'hello' });
ok('unconnected rep falls back to link (never another rep\'s session)', send2.body?.delivered === false && send2.body?.provider === 'click_to_chat' && calls.sendText.length === 1, JSON.stringify(send2.body)?.slice(0, 100));

// ── inbound webhook → lead_activities ───────────────────────────────────────
console.log('\n=== WEBHOOK: INBOUND MESSAGE ===');
const inbound = await hook(token1, { event: 'messages.upsert', instance: inst1, data: {
  key: { remoteJid: '919876511122@s.whatsapp.net', fromMe: false, id: 'IN-1' },
  pushName: 'Kavita', message: { conversation: 'Yes, Saturday 11am works for me' } } });
ok('inbound accepted', inbound.status === 200);
const acts = (await admin.query(`SELECT * FROM lead_activities WHERE lead_id=$1 AND type='whatsapp' ORDER BY created_at`, [lead.id])).rows;
ok('inbound matched the lead by phone and logged', acts.length === 2 && acts[1].notes === '[received] Yes, Saturday 11am works for me', JSON.stringify(acts.map(a => a.notes)));
ok('inbound attributed to the session\'s rep', acts[1].user_id !== null);

// a reply typed on the phone itself (fromMe) is logged too
await hook(token1, { event: 'messages.upsert', instance: inst1, data: {
  key: { remoteJid: '919876511122@s.whatsapp.net', fromMe: true, id: 'OUT-2' },
  message: { conversation: 'See you then!' } } });
const acts2 = (await admin.query(`SELECT count(*)::int n FROM lead_activities WHERE lead_id=$1`, [lead.id])).rows[0].n;
ok('phone-side reply logged (timeline complete both ways)', acts2 === 3, String(acts2));

// unknown number → acknowledged, nothing logged
const unknown = await hook(token1, { event: 'messages.upsert', data: { key: { remoteJid: '910000000000@s.whatsapp.net', fromMe: false }, message: { conversation: 'spam' } } });
ok('unknown number acked without logging', unknown.status === 200 && (await admin.query(`SELECT count(*)::int n FROM lead_activities WHERE lead_id=$1`, [lead.id])).rows[0].n === 3);

// ── chat-thread data path (?type filter + prefix contract) ──────────────────
console.log('\n=== CHAT THREAD FEED ===');
// a non-whatsapp activity must NOT leak into the thread
await call(adminTok, 'POST', '/api/lead-activities', { leadId: lead.id, type: 'note', notes: 'internal remark — not for the chat' });
const thread = await call(adminTok, 'GET', `/api/lead-activities?leadId=${lead.id}&type=whatsapp`);
const acts3 = thread.body?.activities ?? [];
ok('?type=whatsapp returns only chat entries', thread.status === 200 && acts3.length === 3 && acts3.every(a => a.type === 'whatsapp'), `${thread.status} n=${acts3.length}`);
const unfiltered = await call(adminTok, 'GET', `/api/lead-activities?leadId=${lead.id}`);
ok('unfiltered timeline still shows everything', (unfiltered.body?.activities ?? []).length === 4);
// every chat row carries the direction prefix the thread UI parses
const PREFIX = /^\[(sent via [^\]]+|sent from phone|received)\]\s/;
ok('every thread row carries a parseable direction prefix', acts3.every(a => PREFIX.test(a.notes)), JSON.stringify(acts3.map(a => a.notes.slice(0, 30))));
// 10-digit local numbers are normalized before hitting the gateway
const short = await call(adminTok, 'POST', '/api/whatsapp/send', { to: '9876511122', body: 'normalization check' });
ok('10-digit number auto-prefixed with country code', short.status === 200 && calls.sendText.at(-1)?.number === '919876511122', calls.sendText.at(-1)?.number);

// ── directory exposure + isolation + disconnect ─────────────────────────────
console.log('\n=== DIRECTORY + ISOLATION + DISCONNECT ===');
const dir = await call(adminTok, 'GET', '/api/users');
const me = (dir.body?.users ?? []).find(u => u.whatsappInstanceId === inst1);
ok('user directory exposes whatsappStatus', me?.whatsappStatus === 'connected', JSON.stringify(me ? { i: me.whatsappInstanceId, s: me.whatsappStatus } : dir.status));
const rivalTok = await login('badmin@rival.test');
if (rivalTok) {
  const rs = await call(rivalTok, 'GET', '/api/whatsapp/session');
  ok('rival tenant sees no session (RLS)', rs.body?.session?.status === 'disconnected' && rs.body?.session?.instanceName === '');
} else ok('rival login', false);
const disc = await call(adminTok, 'POST', '/api/whatsapp/disconnect');
ok('disconnect logs out on the gateway', disc.status === 200 && disc.body?.session?.status === 'disconnected' && calls.logout.includes(inst1));

await cleanup();
await admin.end();
mock.close();
console.log(`\n===== ${pass} passed, ${fail} failed =====`);
process.exit(fail ? 1 : 0);
