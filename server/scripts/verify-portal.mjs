/**
 * Smoke: the customer / channel-partner portal.
 *
 * The portal is the app's most exposed surface — an authenticated outsider on
 * the builder's own data — so most of this file is negative testing: buyer A
 * must never see buyer B's booking, schedule, receipts, tickets or personal
 * documents, a partner must not see buyers' data (or another partner's
 * referrals), a portal token must be useless on staff routes, and a partner
 * must not be able to credit a referral to a different broker.
 */
import pg from 'pg';
import argon2 from 'argon2';

const BASE = 'http://localhost:4055';
const PW = 'Test1234!';
const PLATFORM = 'ed3c4904-829a-4e10-ad91-e17992f400b0';
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + (x ? '  -> ' + x : ''))); };

const admin = new pg.Client('postgres://postgres:postgres@localhost:5433/erp_test');
await admin.connect();
await admin.query('UPDATE users SET password_hash=$1, active=true WHERE email=$2',
  [await argon2.hash(PW, { type: argon2.argon2id }), 'admin@erptest.local']);

const MARK = 'PRT';
async function cleanup() {
  await admin.query(`DELETE FROM portal_users WHERE email LIKE '${MARK.toLowerCase()}%@portal.test'`);
  await admin.query(`DELETE FROM service_tickets WHERE title LIKE '${MARK}%' OR customer LIKE '${MARK}%'`);
  await admin.query(`DELETE FROM documents WHERE name LIKE '%${MARK}%'`);
  await admin.query(`DELETE FROM commission_ledger WHERE broker_id IN (SELECT id FROM brokers WHERE name LIKE '${MARK}%')`);
  await admin.query(`DELETE FROM payments WHERE payment_schedule_id IN (SELECT s.id FROM payment_schedules s JOIN bookings bk ON bk.id=s.booking_id JOIN leads l ON l.id=bk.lead_id WHERE l.name LIKE '${MARK}%')`);
  await admin.query(`DELETE FROM payment_schedules WHERE booking_id IN (SELECT bk.id FROM bookings bk JOIN leads l ON l.id=bk.lead_id WHERE l.name LIKE '${MARK}%')`);
  await admin.query(`DELETE FROM bookings WHERE lead_id IN (SELECT id FROM leads WHERE name LIKE '${MARK}%')`);
  await admin.query(`DELETE FROM service_tickets WHERE lead_id IN (SELECT id::text FROM leads WHERE name LIKE '${MARK}%')`);
  await admin.query(`DELETE FROM leads WHERE name LIKE '${MARK}%' OR broker_id IN (SELECT id FROM brokers WHERE name LIKE '${MARK}%')`);
  await admin.query(`DELETE FROM brokers WHERE name LIKE '${MARK}%'`);
}
await cleanup();

// ── fixtures: two buyers, two partners ──────────────────────────────────────
const staffTok = (await (await fetch(`${BASE}/api/auth/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'admin@erptest.local', password: PW }),
})).json()).token;
if (!staffTok) { console.error('staff login failed'); process.exit(1); }
const SH = { 'Content-Type': 'application/json', Authorization: `Bearer ${staffTok}` };

const project = (await admin.query('SELECT name FROM projects WHERE tenant_id=$1 LIMIT 1', [PLATFORM])).rows[0].name;

// Buyers A and B. "Ana" / "Ana Maria" deliberately: the personal-document rule
// matches an exact ' - ' segment, so a prefix must NOT leak.
const mkLead = async (name, email) => (await admin.query(
  `INSERT INTO leads (tenant_id, name, email, phone, source, project, stage, priority, last_contact_at)
   VALUES ($1,$2,$3,'9000000000','Direct',$4,'new','warm', now()) RETURNING id, name`,
  [PLATFORM, name, email, project])).rows[0];
const leadA = await mkLead(`${MARK} Ana`, 'prtana@portal.test');
const leadB = await mkLead(`${MARK} Ana Maria`, 'prtanamaria@portal.test');

const mkBroker = async (name, email) => (await admin.query(
  `INSERT INTO brokers (tenant_id, name, phone, email, status) VALUES ($1,$2,'9111111111',$3,'active') RETURNING id, name`,
  [PLATFORM, name, email])).rows[0];
const brokerA = await mkBroker(`${MARK} Partner One`, 'prtp1@portal.test');
const brokerB = await mkBroker(`${MARK} Partner Two`, 'prtp2@portal.test');

// Personal documents, one per buyer, following "<Type> - <Full Name>".
await admin.query(
  `INSERT INTO documents (tenant_id, name, type, project, doc_date, size, status)
   VALUES ($1,$2,'Agreement',$3,CURRENT_DATE,'1 MB','final'), ($1,$4,'Agreement',$3,CURRENT_DATE,'1 MB','final'),
          ($1,$5,'Brochure',$3,CURRENT_DATE,'2 MB','final')`,
  [PLATFORM, `Agreement - ${MARK} Ana`, project, `Agreement - ${MARK} Ana Maria`, `${MARK} Project Brochure`]);

// A booking for buyer A (also the anchor for partner A's commission, whose
// booking_id is NOT NULL) and its payment schedule.
const unitId = (await admin.query('SELECT id FROM units WHERE tenant_id=$1 LIMIT 1', [PLATFORM])).rows[0]?.id ?? null;
const booking = (await admin.query(
  `INSERT INTO bookings (tenant_id, lead_id, unit_id, booking_amount, total_consideration, status)
   VALUES ($1,$2,$3,500000,7500000,'active') RETURNING id`,
  [PLATFORM, leadA.id, unitId])).rows[0];
await admin.query(
  `INSERT INTO payment_schedules (tenant_id, booking_id, milestone_name, sequence, percentage, amount, status)
   VALUES ($1,$2,'On Booking',1,10,750000,'paid'), ($1,$2,'On Agreement',2,20,1500000,'pending')`,
  [PLATFORM, booking.id]);

// Commission for partner A only.
await admin.query(
  `INSERT INTO commission_ledger (tenant_id, broker_id, booking_id, amount_earned, amount_paid, status) VALUES ($1,$2,$3,50000,0,'pending')`,
  [PLATFORM, brokerA.id, booking.id]);

// ── invites (staff route) ───────────────────────────────────────────────────
console.log('\n=== INVITES ===');
const invite = async (body) => { const r = await fetch(`${BASE}/api/portal/invites`, { method: 'POST', headers: SH, body: JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => null) }; };
const invA = await invite({ leadId: leadA.id });
const invB = await invite({ leadId: leadB.id });
const invP1 = await invite({ brokerId: brokerA.id });
const invP2 = await invite({ brokerId: brokerB.id });
ok('customer invite returns a one-time password', invA.status === 201 && !!invA.body?.tempPassword, `${invA.status} ${JSON.stringify(invA.body)?.slice(0, 120)}`);
ok('partner invite returns a one-time password', invP1.status === 201 && !!invP1.body?.tempPassword, `${invP1.status}`);
const bothIds = await invite({ leadId: leadA.id, brokerId: brokerA.id });
ok('invite rejects both leadId and brokerId (400)', bothIds.status === 400, `${bothIds.status}`);
const hashed = (await admin.query(`SELECT password_hash FROM portal_users WHERE email = $1`, ['prtana@portal.test'])).rows[0];
ok('only the argon2 hash is stored', !!hashed && hashed.password_hash.startsWith('$argon2') && !hashed.password_hash.includes(invA.body.tempPassword));

// ── logins ──────────────────────────────────────────────────────────────────
console.log('\n=== PORTAL LOGIN ===');
const plogin = async (email, password) => { const r = await fetch(`${BASE}/api/portal/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) }); return { status: r.status, body: await r.json().catch(() => null) }; };
const la = await plogin('prtana@portal.test', invA.body.tempPassword);
ok('buyer A logs in', la.status === 200 && !!la.body?.token, `${la.status}`);
ok('login carries leadId + tenant branding', !!la.body?.portalUser?.leadId && !!la.body?.tenant?.id,
  JSON.stringify(la.body?.portalUser)?.slice(0, 120));
const bad = await plogin('prtana@portal.test', 'wrong-password');
ok('wrong password → 401', bad.status === 401, `${bad.status}`);

const lb = await plogin('prtanamaria@portal.test', invB.body.tempPassword);
const lp1 = await plogin('prtp1@portal.test', invP1.body.tempPassword);
const lp2 = await plogin('prtp2@portal.test', invP2.body.tempPassword);
const TA = la.body.token, TB = lb.body.token, TP1 = lp1.body.token, TP2 = lp2.body.token;

const overview = async (tok) => { const r = await fetch(`${BASE}/api/portal/overview`, { headers: { Authorization: `Bearer ${tok}` } }); return { status: r.status, body: await r.json().catch(() => null) }; };

// ── realm separation ────────────────────────────────────────────────────────
console.log('\n=== REALM SEPARATION ===');
const staffWithPortalTok = await fetch(`${BASE}/api/leads`, { headers: { Authorization: `Bearer ${TA}` } });
ok('portal token is useless on staff routes', staffWithPortalTok.status === 403 || staffWithPortalTok.status === 401, `${staffWithPortalTok.status}`);
const portalWithStaffTok = await overview(staffTok);
ok('staff token is useless on portal routes', portalWithStaffTok.status === 403, `${portalWithStaffTok.status}`);
const noTok = await fetch(`${BASE}/api/portal/overview`);
ok('overview needs a token', noTok.status === 401, `${noTok.status}`);

// ── customer overview: own data only ────────────────────────────────────────
console.log('\n=== CUSTOMER OVERVIEW SCOPING ===');
const oa = await overview(TA);
ok('buyer A gets an overview', oa.status === 200 && oa.body?.role === 'customer', `${oa.status}`);
ok('overview names buyer A', oa.body?.lead?.id === leadA.id, String(oa.body?.lead?.id));

const docNamesA = (oa.body?.documents ?? []).map(d => d.name);
ok('buyer A sees their OWN agreement', docNamesA.includes(`Agreement - ${MARK} Ana`), docNamesA.join(' | '));
ok('buyer A does NOT see "Ana Maria"\'s agreement (prefix must not leak)',
  !docNamesA.includes(`Agreement - ${MARK} Ana Maria`), docNamesA.join(' | '));
ok('buyer A sees project-level documents', docNamesA.includes(`${MARK} Project Brochure`), docNamesA.join(' | '));

const ob = await overview(TB);
const docNamesB = (ob.body?.documents ?? []).map(d => d.name);
ok('buyer B sees their own agreement only', docNamesB.includes(`Agreement - ${MARK} Ana Maria`) && !docNamesB.includes(`Agreement - ${MARK} Ana`), docNamesB.join(' | '));
ok('customer overview exposes no partner data', !oa.body?.broker && !oa.body?.commissions && !oa.body?.referredLeads);

// ── tickets: raise + scoping ────────────────────────────────────────────────
console.log('\n=== TICKETS ===');
const raise = async (tok, body) => { const r = await fetch(`${BASE}/api/portal/tickets`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => null) }; };
const tA = await raise(TA, { title: `${MARK} Leaking tap in kitchen`, category: 'Maintenance' });
ok('buyer A raises a ticket (201)', tA.status === 201 && !!tA.body?.ticket?.id, `${tA.status} ${JSON.stringify(tA.body)?.slice(0, 120)}`);
const oa2 = await overview(TA);
ok('the raised ticket round-trips into the overview', (oa2.body?.tickets ?? []).some(t => t.id === tA.body.ticket.id));
const ob2 = await overview(TB);
ok('buyer B does NOT see buyer A\'s ticket', !(ob2.body?.tickets ?? []).some(t => t.id === tA.body.ticket.id));
const dbTicket = (await admin.query('SELECT lead_id FROM service_tickets WHERE id=$1', [tA.body.ticket.id])).rows[0];
ok('ticket is attributed to the caller\'s own lead', dbTicket?.lead_id === leadA.id, String(dbTicket?.lead_id));
const partnerTicket = await raise(TP1, { title: `${MARK} should not work` });
ok('a partner cannot raise a customer ticket (403)', partnerTicket.status === 403, `${partnerTicket.status}`);

// ── partner overview + referral attribution ─────────────────────────────────
console.log('\n=== PARTNER OVERVIEW + REFERRALS ===');
const op1 = await overview(TP1);
ok('partner gets a partner overview', op1.status === 200 && op1.body?.role === 'partner', `${op1.status}`);
ok('partner sees their own broker record', op1.body?.broker?.id === brokerA.id);
ok('partner sees their own commissions', (op1.body?.commissions ?? []).length === 1);
const op2 = await overview(TP2);
ok('partner B sees none of partner A\'s commissions', (op2.body?.commissions ?? []).length === 0);
ok('partner overview exposes no buyer data', !op1.body?.bookings && !op1.body?.documents && !op1.body?.tickets);

const submit = async (tok, body) => { const r = await fetch(`${BASE}/api/portal/leads`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => null) }; };
const sub = await submit(TP1, { name: `${MARK} Referred Buyer`, phone: '9222222222', project, budget: 7500000 });
ok('partner refers a lead (201)', sub.status === 201 && !!sub.body?.lead?.id, `${sub.status} ${JSON.stringify(sub.body)?.slice(0, 140)}`);
const attributed = (await admin.query('SELECT broker_id, stage FROM leads WHERE id=$1', [sub.body.lead.id])).rows[0];
ok('referral is attributed to the CALLER\'s broker', attributed?.broker_id === brokerA.id, String(attributed?.broker_id));
ok('referral stage is fixed server-side', attributed?.stage === 'new', String(attributed?.stage));
// A body that names another broker must not change attribution. Fastify strips
// unknown properties (additionalProperties: false + removeAdditional), so the
// request succeeds — what matters is that the injected brokerId was ignored and
// the referral is still credited to the CALLER.
const spoof = await submit(TP1, { name: `${MARK} Spoof`, phone: '9333333333', brokerId: brokerB.id });
const spoofRow = spoof.body?.lead?.id
  ? (await admin.query('SELECT broker_id FROM leads WHERE id=$1', [spoof.body.lead.id])).rows[0]
  : null;
ok('an injected brokerId in the body is ignored — credit stays with the caller',
  spoofRow?.broker_id === brokerA.id && spoofRow?.broker_id !== brokerB.id,
  `status ${spoof.status}, attributed to ${spoofRow?.broker_id}`);
const op1b = await overview(TP1);
ok('referral appears in the partner\'s own list', (op1b.body?.referredLeads ?? []).some(l => l.id === sub.body.lead.id));
const op2b = await overview(TP2);
ok('partner B does NOT see partner A\'s referral', !(op2b.body?.referredLeads ?? []).some(l => l.id === sub.body.lead.id));
const custSubmit = await submit(TA, { name: `${MARK} Nope`, phone: '9444444444' });
ok('a customer cannot submit referrals (403)', custSubmit.status === 403, `${custSubmit.status}`);

// ── revocation ──────────────────────────────────────────────────────────────
console.log('\n=== REVOCATION ===');
await admin.query(`UPDATE portal_users SET active = false WHERE email = 'prtana@portal.test'`);
const afterDeactivate = await overview(TA);
ok('deactivating the account kills the live session (401)', afterDeactivate.status === 401, `${afterDeactivate.status}`);

await cleanup();
await admin.end();
console.log(`\n===== ${pass} passed, ${fail} failed =====`);
process.exit(fail ? 1 : 0);
