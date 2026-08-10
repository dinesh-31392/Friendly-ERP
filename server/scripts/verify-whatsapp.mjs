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
const calls = { create: [], connect: [], sendText: [], sendMedia: [], webhookSet: [], logout: [] };
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
    if ((m = url.match(/^\/message\/sendMedia\/(.+)$/)) && req.method === 'POST') {
      calls.sendMedia.push({ instance: m[1], ...body });
      return send(201, { key: { id: 'MOCK-MEDIA-' + calls.sendMedia.length } });
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
  await admin.query(`DELETE FROM whatsapp_outbox WHERE lead_id IN (SELECT id FROM leads WHERE name LIKE '${MARK}%')`);
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

// ── media ───────────────────────────────────────────────────────────────────
console.log('\n=== MEDIA ===');
// 1x1 png
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const mediaRes = await call(adminTok, 'POST', '/api/whatsapp/send-media', {
  to: '+91 98765-11122', leadId: lead.id, mediatype: 'image',
  mimetype: 'image/png', fileName: 'floorplan.png', caption: '2 BHK layout', base64: PNG,
});
ok('media sent via the caller\'s instance', mediaRes.status === 200 && mediaRes.body?.delivered === true,
  `${mediaRes.status} ${JSON.stringify(mediaRes.body)?.slice(0, 120)}`);
ok('gateway got mediatype + filename + base64 (no data: prefix)',
  calls.sendMedia.at(-1)?.mediatype === 'image' &&
  calls.sendMedia.at(-1)?.fileName === 'floorplan.png' &&
  !String(calls.sendMedia.at(-1)?.media ?? '').startsWith('data:'),
  JSON.stringify({ t: calls.sendMedia.at(-1)?.mediatype, f: calls.sendMedia.at(-1)?.fileName }));
ok('media dispatched through the CALLER\'s instance', calls.sendMedia.at(-1)?.instance === inst1);
const mediaLog = (await admin.query(
  `SELECT notes FROM lead_activities WHERE lead_id=$1 AND type='whatsapp' ORDER BY created_at DESC LIMIT 1`, [lead.id])).rows[0];
ok('attachment logged as a descriptor on the timeline',
  mediaLog?.notes === '[sent via my WhatsApp] 📷 floorplan.png — 2 BHK layout', mediaLog?.notes);
// Fastify enforces bodyLimit by ABORTING the stream, so on Windows the client
// often sees a connection reset instead of a status. Either way the payload was
// refused — that is what this asserts.
let tooBigOutcome;
try {
  const r = await call(adminTok, 'POST', '/api/whatsapp/send-media', {
    to: '919876511122', mediatype: 'image', mimetype: 'image/png', base64: 'x'.repeat(15 * 1024 * 1024) });
  tooBigOutcome = r.status;
} catch {
  tooBigOutcome = 'connection reset';
}
ok('oversized attachment refused',
  tooBigOutcome === 400 || tooBigOutcome === 413 || tooBigOutcome === 'connection reset', String(tooBigOutcome));

// inbound media descriptors — a caption-less photo used to be dropped entirely
console.log('\n=== INBOUND MEDIA DESCRIPTORS ===');
const beforeMedia = (await admin.query(`SELECT count(*)::int n FROM lead_activities WHERE lead_id=$1`, [lead.id])).rows[0].n;
await hook(token1, { event: 'messages.upsert', data: {
  key: { remoteJid: '919876511122@s.whatsapp.net', fromMe: false }, message: { imageMessage: {} } } });
await hook(token1, { event: 'messages.upsert', data: {
  key: { remoteJid: '919876511122@s.whatsapp.net', fromMe: false },
  message: { documentMessage: { fileName: 'aadhaar.pdf' } } } });
await hook(token1, { event: 'messages.upsert', data: {
  key: { remoteJid: '919876511122@s.whatsapp.net', fromMe: false }, message: { audioMessage: { ptt: true } } } });
const media3 = (await admin.query(
  `SELECT notes FROM lead_activities WHERE lead_id=$1 AND type='whatsapp' ORDER BY created_at DESC LIMIT 3`, [lead.id])).rows.map(r => r.notes);
ok('caption-less photo is logged, not dropped', media3.includes('[received] 📷 Photo'), JSON.stringify(media3));
ok('document logged with its filename', media3.includes('[received] 📄 aadhaar.pdf'), JSON.stringify(media3));
ok('voice note logged', media3.includes('[received] 🎙️ Voice message'), JSON.stringify(media3));
ok('all three inbound media rows persisted',
  (await admin.query(`SELECT count(*)::int n FROM lead_activities WHERE lead_id=$1`, [lead.id])).rows[0].n === beforeMedia + 3);

// ── inbox (Messages page) ───────────────────────────────────────────────────
console.log('\n=== INBOX / CONVERSATIONS ===');
const inbox = await call(adminTok, 'GET', '/api/whatsapp/conversations');
const convs = inbox.body?.conversations ?? [];
const kk = convs.find(c => c.leadId === lead.id);
ok('inbox lists the lead with WhatsApp history', inbox.status === 200 && !!kk, `${inbox.status} n=${convs.length}`);
ok('preview strips the direction prefix', !!kk && !/^\[/.test(kk.lastMessage), kk?.lastMessage);
// Compare against the DB rather than a literal — earlier sections add messages,
// and a hard-coded count would silently rot as this suite grows.
const dbCount = (await admin.query(
  `SELECT count(*)::int n FROM lead_activities WHERE lead_id=$1 AND type='whatsapp'`, [lead.id])).rows[0].n;
ok('message count matches the thread', kk?.messageCount === dbCount, `inbox ${kk?.messageCount} vs db ${dbCount}`);
// Establish the precondition rather than assuming it — earlier sections may
// leave either side speaking last.
await call(adminTok, 'POST', '/api/whatsapp/send', { to: '919876511122', body: 'we spoke last', leadId: lead.id });
const afterOurs = ((await call(adminTok, 'GET', '/api/whatsapp/conversations')).body?.conversations ?? [])
  .find(c => c.leadId === lead.id);
ok('awaitingReply false when we spoke last',
  afterOurs?.awaitingReply === false && afterOurs?.lastMessage === 'we spoke last',
  JSON.stringify({ a: afterOurs?.awaitingReply, m: afterOurs?.lastMessage }));
// a fresh inbound flips it
await hook(token1, { event: 'messages.upsert', data: {
  key: { remoteJid: '919876511122@s.whatsapp.net', fromMe: false }, message: { conversation: 'One more question' } } });
const inbox2 = (await call(adminTok, 'GET', '/api/whatsapp/conversations')).body?.conversations ?? [];
const kk2 = inbox2.find(c => c.leadId === lead.id);
ok('a customer reply flips awaitingReply + updates the preview',
  kk2?.awaitingReply === true && kk2?.lastMessage === 'One more question', JSON.stringify({ a: kk2?.awaitingReply, m: kk2?.lastMessage }));
// leads with no WhatsApp history must not appear
const emptyLead = (await admin.query(
  `INSERT INTO leads (tenant_id, name, phone, source, stage, priority, last_contact_at)
   VALUES ($1, '${MARK} Silent Lead', '919999000011', 'Direct', 'new', 'warm', now()) RETURNING id`, [PLATFORM])).rows[0];
const inbox3 = (await call(adminTok, 'GET', '/api/whatsapp/conversations')).body?.conversations ?? [];
ok('leads with no chat history are excluded', !inbox3.some(c => c.leadId === emptyLead.id));

// ── auto-reply: the safety rules are the feature ────────────────────────────
console.log('\n=== AUTO-REPLY ===');
const cfgOn = await call(adminTok, 'PUT', '/api/whatsapp/instance', {
  provider: 'evolution', autoNewLeadEnabled: true, autoInboundEnabled: true,
  autoNewLeadTemplate: 'Hi {{name}}, this is {{agent}} from {{company}}.',
  autoMinDelaySeconds: 0, autoMaxDelaySeconds: 0,   // no wait, so the test can drain
  autoDailyCap: 2, autoQuietFrom: 0, autoQuietTo: 0,
});
ok('auto-reply settings persist', cfgOn.status === 200 && cfgOn.body?.instance?.autoNewLeadEnabled === true
  && cfgOn.body?.instance?.autoDailyCap === 2, JSON.stringify(cfgOn.body?.instance)?.slice(0, 160));

// a brand-new lead from the ERP queues exactly one greeting
const newLead = await call(adminTok, 'POST', '/api/leads', { name: `${MARK} Auto One`, phone: '919876100001', source: 'Direct' });
const autoLeadId = newLead.body?.lead?.id;
ok('lead created for the auto-reply test', newLead.status === 201 && !!autoLeadId, `${newLead.status}`);
const q1 = (await admin.query(`SELECT * FROM whatsapp_outbox WHERE lead_id=$1`, [autoLeadId])).rows;
ok('new lead queues one greeting', q1.length === 1 && q1[0].trigger === 'new_lead' && q1[0].status === 'pending', `n=${q1.length}`);
// {{name}} renders the lead's FIRST word; this fixture is '${MARK} Auto One'.
ok('template renders {{name}}, {{agent}} and {{company}}',
  /^Hi WAE, this is .+ from .+.$/.test(q1[0]?.body ?? ''), q1[0]?.body);
ok('queued against a CONNECTED rep', !!q1[0]?.user_id);

// re-importing the same lead must never re-greet — the UNIQUE key is the guard
await admin.query(
  `INSERT INTO whatsapp_outbox (tenant_id, lead_id, user_id, trigger, phone, body, send_after)
   VALUES ($1,$2,$3,'new_lead','919876100001','dupe', now())
   ON CONFLICT (tenant_id, lead_id, trigger) DO NOTHING`,
  [PLATFORM, autoLeadId, q1[0].user_id]);
ok('a lead can never be auto-greeted twice',
  (await admin.query(`SELECT count(*)::int n FROM whatsapp_outbox WHERE lead_id=$1 AND trigger='new_lead'`, [autoLeadId])).rows[0].n === 1);

// draining actually sends it, through the rep's own instance
const beforeSends = calls.sendText.length;
const drain1 = await call(adminTok, 'GET', '/api/whatsapp/auto-reply/queue');
ok('queue endpoint drains and reports', drain1.status === 200 && Array.isArray(drain1.body?.queue), `${drain1.status}`);
ok('the greeting actually went out', calls.sendText.length === beforeSends + 1, `sends ${beforeSends} → ${calls.sendText.length}`);
const sentRow = (await admin.query(`SELECT status FROM whatsapp_outbox WHERE lead_id=$1`, [autoLeadId])).rows[0];
ok('outbox row marked sent', sentRow?.status === 'sent', sentRow?.status);
ok('the automated message is on the lead timeline',
  (await admin.query(`SELECT count(*)::int n FROM lead_activities WHERE lead_id=$1 AND type='whatsapp'`, [autoLeadId])).rows[0].n === 1);

// a human replying first cancels the pending automation
const lead2 = await call(adminTok, 'POST', '/api/leads', { name: `${MARK} Auto Two`, phone: '919876100002', source: 'Direct' });
const lead2Id = lead2.body?.lead?.id;
await call(adminTok, 'POST', '/api/whatsapp/send', { to: '919876100002', body: 'personal note first', leadId: lead2Id });
await call(adminTok, 'GET', '/api/whatsapp/auto-reply/queue');
const skipped = (await admin.query(`SELECT status, last_error FROM whatsapp_outbox WHERE lead_id=$1`, [lead2Id])).rows[0];
ok('a human reply cancels the queued automation', skipped?.status === 'skipped' && /human replied/.test(skipped?.last_error ?? ''),
  JSON.stringify(skipped));

// the daily cap stops runaway first-contacts
await call(adminTok, 'PUT', '/api/whatsapp/instance', { provider: 'evolution', autoDailyCap: 1 });
const lead3 = await call(adminTok, 'POST', '/api/leads', { name: `${MARK} Auto Three`, phone: '919876100003', source: 'Direct' });
const lead3Id = lead3.body?.lead?.id;
await call(adminTok, 'GET', '/api/whatsapp/auto-reply/queue');
await call(adminTok, 'GET', '/api/whatsapp/auto-reply/queue');
const capped = (await admin.query(`SELECT status, last_error FROM whatsapp_outbox WHERE lead_id=$1`, [lead3Id])).rows[0];
ok('daily cap blocks further automated first-contacts',
  capped?.status === 'skipped' && /daily cap/.test(capped?.last_error ?? ''), JSON.stringify(capped));

// quiet hours push the send out rather than firing at night
await call(adminTok, 'PUT', '/api/whatsapp/instance', { provider: 'evolution', autoQuietFrom: 0, autoQuietTo: 23, autoDailyCap: 50 });
const lead4 = await call(adminTok, 'POST', '/api/leads', { name: `${MARK} Auto Four`, phone: '919876100004', source: 'Direct' });
const q4 = (await admin.query(`SELECT send_after FROM whatsapp_outbox WHERE lead_id=$1`, [lead4.body?.lead?.id])).rows[0];
ok('quiet hours defer the send instead of firing', !!q4 && new Date(q4.send_after) > new Date(Date.now() + 60_000),
  String(q4?.send_after));

// a queued message can be cancelled by a human before it goes
const pend = (await admin.query(`SELECT id FROM whatsapp_outbox WHERE lead_id=$1 AND status='pending'`, [lead4.body?.lead?.id])).rows[0];
// via call() so it sends '{}' — a bodyless DELETE with a json content-type is
// rejected by Fastify before the route is reached.
const cancel = await call(adminTok, 'DELETE', `/api/whatsapp/auto-reply/queue/${pend?.id}`);
ok('a pending automated message can be cancelled', !!pend && cancel.status === 200, `${cancel.status} id=${pend?.id}`);

// The background worker must send WITHOUT anyone opening a page — that is the
// whole point of a queue with a time promise.
await call(adminTok, 'PUT', '/api/whatsapp/instance', {
  provider: 'evolution', autoDailyCap: 50, autoQuietFrom: 0, autoQuietTo: 0,
  autoMinDelaySeconds: 0, autoMaxDelaySeconds: 0 });
const leadW = await call(adminTok, 'POST', '/api/leads', { name: `${MARK} Auto Worker`, phone: '919876100009', source: 'Direct' });
const leadWId = leadW.body?.lead?.id;
const sendsBeforeWorker = calls.sendText.length;
let workerSent = false;
// The test server runs the worker at its configured interval; poll the DB only,
// never an endpoint, so nothing here can drain it on our behalf.
for (let i = 0; i < 20; i++) {
  const st = (await admin.query(`SELECT status FROM whatsapp_outbox WHERE lead_id=$1`, [leadWId])).rows[0]?.status;
  if (st === 'sent') { workerSent = true; break; }
  await new Promise(r => setTimeout(r, 1500));
}
ok('background worker sends with no page open',
  workerSent && calls.sendText.length > sendsBeforeWorker,
  `sent=${workerSent} sends ${sendsBeforeWorker}→${calls.sendText.length}`);

// disabled = nothing queued at all
await call(adminTok, 'PUT', '/api/whatsapp/instance', { provider: 'evolution', autoNewLeadEnabled: false });
const lead5 = await call(adminTok, 'POST', '/api/leads', { name: `${MARK} Auto Five`, phone: '919876100005', source: 'Direct' });
ok('disabled auto-reply queues nothing',
  (await admin.query(`SELECT count(*)::int n FROM whatsapp_outbox WHERE lead_id=$1`, [lead5.body?.lead?.id])).rows[0].n === 0);
await admin.query(`DELETE FROM whatsapp_outbox WHERE tenant_id=$1`, [PLATFORM]);
await call(adminTok, 'PUT', '/api/whatsapp/instance', { provider: 'evolution', autoInboundEnabled: false, autoQuietFrom: 21, autoQuietTo: 9 });

// ── chat privacy: one rep must never see another's conversations ────────────
console.log('\n=== CHAT PRIVACY (per-user isolation) ===');
// rep2 is a sales executive, so the inbox's lead-ownership filter would hide an
// unassigned lead before privacy is even reached. Assign it to them so this
// block tests the PRIVACY boundary, not lead ownership.
await admin.query(
  `UPDATE leads SET assigned_to = (SELECT id FROM users WHERE email='exec1@erptest.local') WHERE id = $1`, [lead.id]);

// rep2 links their own session and messages the SAME lead.
states[inst2] = 'open';
const tok2 = (await admin.query('SELECT webhook_token FROM whatsapp_user_sessions WHERE instance_name=$1', [inst2])).rows[0].webhook_token;
await hook(tok2, { event: 'connection.update', instance: inst2, data: { state: 'open', wuid: '919000000002@s.whatsapp.net' } });
const rep2Send = await call(repTok, 'POST', '/api/whatsapp/send', { to: '919876511122', body: 'rep2 private note to the same lead', leadId: lead.id });
ok('rep2 can message the same lead', rep2Send.status === 200 && rep2Send.body?.delivered === true, `${rep2Send.status}`);

// Default visibility is 'private' — each rep's inbox shows only their own half.
const inboxA = ((await call(adminTok, 'GET', '/api/whatsapp/conversations')).body?.conversations ?? []).find(c => c.leadId === lead.id);
const inboxB = ((await call(repTok, 'GET', '/api/whatsapp/conversations')).body?.conversations ?? []).find(c => c.leadId === lead.id);
ok('rep2 sees ONLY their own message in the shared lead', inboxB?.messageCount === 1, `rep2 count ${inboxB?.messageCount}`);
ok('rep1 does not see rep2\'s message', inboxA && inboxA.messageCount > 1 && inboxA.lastMessage !== 'rep2 private note to the same lead',
  JSON.stringify({ n: inboxA?.messageCount, last: inboxA?.lastMessage }));

// The thread feed is the same boundary — it must not be a way around the inbox.
const threadB = ((await call(repTok, 'GET', `/api/lead-activities?leadId=${lead.id}&type=whatsapp`)).body?.activities ?? []);
ok('rep2\'s thread shows only their own message', threadB.length === 1 && threadB[0].notes.includes('rep2 private note'),
  `n=${threadB.length}`);
const threadA = ((await call(adminTok, 'GET', `/api/lead-activities?leadId=${lead.id}&type=whatsapp`)).body?.activities ?? []);
ok('rep1\'s thread excludes rep2\'s message', !threadA.some(a => a.notes.includes('rep2 private note')), `n=${threadA.length}`);
// Non-WhatsApp activities stay shared workspace data.
ok('shared notes are still visible to both',
  ((await call(repTok, 'GET', `/api/lead-activities?leadId=${lead.id}`)).body?.activities ?? []).some(a => a.type === 'note'));

// Export follows the same scope — it cannot become a privacy backdoor.
const expB = await fetch(`${BASE}/api/whatsapp/storage/export?format=json`, { headers: H(repTok) });
const expBody = await expB.json();
ok('rep2\'s export contains only their own messages',
  expB.status === 200 && expBody.chats.length === 1 && expBody.chats[0].text.includes('rep2 private note'),
  `n=${expBody?.chats?.length}`);

// Switching the workspace to 'team' opens it up — deliberately, not by default.
await call(adminTok, 'PUT', '/api/whatsapp/instance', { provider: 'evolution', chatVisibility: 'team' });
const teamB = ((await call(repTok, 'GET', '/api/whatsapp/conversations')).body?.conversations ?? []).find(c => c.leadId === lead.id);
ok('team visibility lets rep2 see the whole conversation', (teamB?.messageCount ?? 0) > 1, `count ${teamB?.messageCount}`);
await call(adminTok, 'PUT', '/api/whatsapp/instance', { provider: 'evolution', chatVisibility: 'private' });
const backB = ((await call(repTok, 'GET', '/api/whatsapp/conversations')).body?.conversations ?? []).find(c => c.leadId === lead.id);
ok('switching back to private re-isolates immediately', backB?.messageCount === 1, `count ${backB?.messageCount}`);

// ── storage: summary, export shape, delete ──────────────────────────────────
console.log('\n=== DATA STORAGE ===');
const sum = await call(adminTok, 'GET', '/api/whatsapp/storage/summary');
const dbOwn = (await admin.query(
  `SELECT count(*)::int n FROM lead_activities la JOIN users u ON u.id = la.user_id
    WHERE la.type='whatsapp' AND u.email='admin@erptest.local'`)).rows[0].n;
ok('summary counts match the caller\'s own rows', sum.status === 200 && sum.body?.summary?.messages === dbOwn,
  `api ${sum.body?.summary?.messages} vs db ${dbOwn}`);
ok('summary reports visibility + manage flag', sum.body?.summary?.visibility === 'private' && sum.body?.summary?.canManage === true);

const csv = await fetch(`${BASE}/api/whatsapp/storage/export?format=csv`, { headers: H(adminTok) });
const csvText = await csv.text();
ok('CSV has a header and one row per message',
  csv.status === 200 && csvText.split('\r\n')[0].replace(/^﻿/, '') === 'date,lead,phone,direction,message' &&
  csvText.trim().split('\r\n').length === dbOwn + 1,
  `${csv.status} lines=${csvText.trim().split('\r\n').length} expected=${dbOwn + 1}`);
ok('CSV strips the [direction] prefix into its own column', !csvText.includes('[sent via'), 'prefix leaked into the text column');
ok('CSV is downloadable (attachment + filename)', /attachment; filename="whatsapp-chats-/.test(csv.headers.get('content-disposition') ?? ''));

// formula-injection guard: a message starting with '=' must be neutralised
await call(adminTok, 'POST', '/api/whatsapp/send', { to: '919876511122', body: '=cmd|calc', leadId: lead.id });
const csv2 = await (await fetch(`${BASE}/api/whatsapp/storage/export?format=csv`, { headers: H(adminTok) })).text();
ok('a formula-looking message is escaped for spreadsheets', csv2.includes(`"'=cmd|calc"`), 'no leading quote guard');

const delNothing = await fetch(`${BASE}/api/whatsapp/storage`, { method: 'DELETE', headers: H(adminTok), body: '{}' });
ok('delete refuses an unscoped wipe (400)', delNothing.status === 400, `${delNothing.status}`);

const beforeNotes = (await admin.query(`SELECT count(*)::int n FROM lead_activities WHERE lead_id=$1 AND type='note'`, [lead.id])).rows[0].n;
const del = await fetch(`${BASE}/api/whatsapp/storage`, { method: 'DELETE', headers: H(adminTok), body: JSON.stringify({ leadId: lead.id }) });
const delBody = await del.json();
ok('delete removes the caller\'s conversation', del.status === 200 && delBody.deleted > 0, `${del.status} ${JSON.stringify(delBody)}`);
ok('delete left non-WhatsApp activities untouched',
  (await admin.query(`SELECT count(*)::int n FROM lead_activities WHERE lead_id=$1 AND type='note'`, [lead.id])).rows[0].n === beforeNotes);
ok('delete did NOT touch the other rep\'s messages',
  (await admin.query(`SELECT count(*)::int n FROM lead_activities la JOIN users u ON u.id=la.user_id
     WHERE la.type='whatsapp' AND u.email='exec1@erptest.local'`)).rows[0].n === 1);

// ── directory exposure + isolation + disconnect ─────────────────────────────
console.log('\n=== DIRECTORY + ISOLATION + DISCONNECT ===');
const dir = await call(adminTok, 'GET', '/api/users');
const me = (dir.body?.users ?? []).find(u => u.whatsappInstanceId === inst1);
ok('user directory exposes whatsappStatus', me?.whatsappStatus === 'connected', JSON.stringify(me ? { i: me.whatsappInstanceId, s: me.whatsappStatus } : dir.status));
const rivalTok = await login('badmin@rival.test');
if (rivalTok) {
  const rs = await call(rivalTok, 'GET', '/api/whatsapp/session');
  ok('rival tenant sees no session (RLS)', rs.body?.session?.status === 'disconnected' && rs.body?.session?.instanceName === '');
  const ri = await call(rivalTok, 'GET', '/api/whatsapp/conversations');
  ok('rival tenant inbox excludes our conversations',
    !(ri.body?.conversations ?? []).some(c => c.leadId === lead.id), `saw ${(ri.body?.conversations ?? []).length}`);
} else ok('rival login', false);
const disc = await call(adminTok, 'POST', '/api/whatsapp/disconnect');
ok('disconnect logs out on the gateway', disc.status === 200 && disc.body?.session?.status === 'disconnected' && calls.logout.includes(inst1));

await cleanup();
await admin.end();
mock.close();
console.log(`\n===== ${pass} passed, ${fail} failed =====`);
process.exit(fail ? 1 : 0);
